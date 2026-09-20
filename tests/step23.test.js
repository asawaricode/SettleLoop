// tests/step23.test.js
//
// Phase 7 — Final Integration Tests
//
// Test coverage:
// 1. Razorpay webhook:
//    - valid HMAC signature → accepted and stored
//    - tampered signature → rejected
//    - duplicate x-razorpay-event-id → 200/idempotent, no duplicate processing
//
// 2. Approval concurrency:
//    - two concurrent resolutions of the same pending approval
//    - exactly one succeeds
//    - exactly one mandate action is executed
//    - no double attempt / double transition
//
// 3. Manual Razorpay order:
//    - eligible Smart + RETRY mandate → order creation allowed
//    - Control/Baseline mandate → blocked
//    - non-RETRY mandate → blocked
//    - attempts_used >= 4 → blocked
//    - synthetic simulation data remains unchanged
//
// 4. Isolation:
//    - snapshot mandates, attempts, simulation_runs and computed metrics
//    - perform real webhook + manual Test Mode order
//    - verify all four are byte-for-byte unchanged

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { describe, it, before, after } from 'node:test';
import { supabase } from '../src/config/supabase.js';
import { app } from '../server.js';
import { ORDER_DISCLOSURE } from '../src/api/razorpayOrder.js';
import { requestHumanApproval } from '../src/recovery/humanApproval.js';
import { getSimulationMetrics } from '../src/evaluation/metrics.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Constants
// ─────────────────────────────────────────────────────────────────────────────

const TEST_WEBHOOK_SECRET = 'test-wh-secret-phase7-step23-xyz';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a Razorpay-shaped payment.failed event payload and sign it. */
function buildSignedWebhookPayload(overrides = {}, secret = TEST_WEBHOOK_SECRET) {
  const payload = {
    entity:     'event',
    account_id: 'acc_test_phase7',
    event:      'payment.failed',
    contains:   ['payment'],
    payload: {
      payment: {
        entity: {
          id:                `pay_test_phase7_${Date.now()}`,
          entity:            'payment',
          amount:            150000,
          currency:          'INR',
          status:            'failed',
          error_code:        'BAD_REQUEST_ERROR',
          error_description: 'Payment failed (Phase 7 test)',
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
    ...overrides,
  };

  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  return { payload, rawBody, signature };
}

/** POST rawBody (Buffer) with explicit headers to the test server webhook endpoint. */
async function postWebhook(baseUrl, rawBody, headers) {
  const res = await fetch(`${baseUrl}/api/v1/webhooks/razorpay`, {
    method: 'POST',
    headers: {
      'Content-Type':   'application/json',
      'Content-Length': String(rawBody.length),
      ...headers,
    },
    body: rawBody,
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

/** POST JSON body to the test server. */
async function postJson(baseUrl, path, body, extraHeaders = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 23 — Phase 7: Final Integration Tests', () => {
  let server;
  let baseUrl;

  let savedWebhookSecret;
  let savedKeyId;
  let savedKeySecret;

  const createdRunIds = new Set();
  const createdWebhookEventIds = new Set();

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    savedWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

    savedKeyId     = process.env.RAZORPAY_KEY_ID;
    savedKeySecret = process.env.RAZORPAY_KEY_SECRET;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));

    // Restore env
    process.env.RAZORPAY_WEBHOOK_SECRET = savedWebhookSecret;
    process.env.RAZORPAY_KEY_ID         = savedKeyId;
    process.env.RAZORPAY_KEY_SECRET     = savedKeySecret;

    // Cleanup created test records
    for (const eventId of createdWebhookEventIds) {
      try {
        await supabase.from('webhook_events').delete().eq('event_id', eventId);
      } catch (_) {}
    }

    for (const runId of createdRunIds) {
      try {
        await supabase.from('audit_logs').delete().eq('run_id', runId);
        await supabase.from('approval_requests').delete().eq('run_id', runId);
        await supabase.from('attempts').delete().eq('run_id', runId);
        await supabase.from('mandates').delete().eq('run_id', runId);
        await supabase.from('simulation_runs').delete().eq('id', runId);
      } catch (_) {}
    }
  });

  /** Helper: create a simulation run + mandate for tests */
  async function createTestMandate({
    experimentArm = 'smart',
    nextAction = 'retry',
    attemptsUsed = 1,
    amount = 1500,
    status = 'pending',
    nextActionDay = 1,
  } = {}) {
    const { data: run, error: runErr } = await supabase
      .from('simulation_runs')
      .insert({ random_seed: 70007, max_days: 10, current_day: 1, status: 'running' })
      .select()
      .single();
    if (runErr) throw new Error('createTestMandate run failed: ' + runErr.message);
    createdRunIds.add(run.id);

    const { data: mandate, error: mErr } = await supabase
      .from('mandates')
      .insert({
        run_id:              run.id,
        mandate_id:          `P7-MAN-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        amount,
        income_day_of_month: 15,
        balance_volatility:  0.25,
        contact_consent:     true,
        experiment_arm:      experimentArm,
        status,
        first_due_day:       1,
        next_action:         nextAction,
        next_action_day:     nextActionDay,
        attempts_used:       attemptsUsed,
        created_day:         0,
      })
      .select()
      .single();
    if (mErr) throw new Error('createTestMandate mandate failed: ' + mErr.message);

    return { run, mandate };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Razorpay webhook
  //    - valid HMAC signature → accepted and stored
  //    - tampered signature → rejected
  //    - duplicate x-razorpay-event-id → 200/idempotent, no duplicate processing
  // ═══════════════════════════════════════════════════════════════════════════

  describe('1. Razorpay Webhook', () => {
    it('valid HMAC signature → accepted and stored', async () => {
      const eventId = `evt_p7_valid_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      createdWebhookEventIds.add(eventId);

      const { payload, rawBody, signature } = buildSignedWebhookPayload();

      const res = await postWebhook(baseUrl, rawBody, {
        'x-razorpay-signature': signature,
        'x-razorpay-event-id':  eventId,
      });

      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.received, true);
      assert.equal(res.body.duplicate, false);
      assert.equal(res.body.event_id, eventId);
      assert.equal(res.body.event_type, 'payment.failed');
      assert.ok(res.body.webhook_event_id, 'Must return webhook_event_id');

      // Verify stored in PostgreSQL webhook_events table
      const { data: rows, error: qErr } = await supabase
        .from('webhook_events')
        .select('*')
        .eq('event_id', eventId);

      assert.ifError(qErr);
      assert.equal(rows.length, 1, 'Exactly one webhook_events row must be created');
      assert.equal(rows[0].event_type, 'payment.failed');
      assert.equal(rows[0].signature_verified, true);
      assert.deepEqual(rows[0].payload, payload);
    });

    it('tampered signature → rejected', async () => {
      const eventId = `evt_p7_tampered_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      createdWebhookEventIds.add(eventId);

      const { rawBody } = buildSignedWebhookPayload();
      // Generate tampered/invalid signature
      const tamperedSignature = crypto
        .createHmac('sha256', 'wrong_secret_tampered')
        .update(rawBody)
        .digest('hex');

      const res = await postWebhook(baseUrl, rawBody, {
        'x-razorpay-signature': tamperedSignature,
        'x-razorpay-event-id':  eventId,
      });

      assert.equal(res.status, 401, `Expected 401, got ${res.status}`);
      assert.equal(res.body.error, 'Signature verification failed');

      // Verify NOT stored in webhook_events
      const { data: rows } = await supabase
        .from('webhook_events')
        .select('id')
        .eq('event_id', eventId);

      assert.equal(rows.length, 0, 'Tampered event must not be stored in webhook_events');
    });

    it('duplicate x-razorpay-event-id → 200/idempotent, no duplicate processing', async () => {
      const eventId = `evt_p7_dedup_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      createdWebhookEventIds.add(eventId);

      const { rawBody, signature } = buildSignedWebhookPayload();
      const headers = {
        'x-razorpay-signature': signature,
        'x-razorpay-event-id':  eventId,
      };

      // 1. First delivery: accepted and stored
      const res1 = await postWebhook(baseUrl, rawBody, headers);
      assert.equal(res1.status, 200);
      assert.equal(res1.body.received, true);
      assert.equal(res1.body.duplicate, false);

      // 2. Second delivery with same x-razorpay-event-id: idempotent 200
      const res2 = await postWebhook(baseUrl, rawBody, headers);
      assert.equal(res2.status, 200, 'Duplicate delivery must return 200');
      assert.equal(res2.body.received, true);
      assert.equal(res2.body.duplicate, true, 'Duplicate flag must be true');

      // 3. Verify exactly one row exists in webhook_events (no duplicate row)
      const { data: rows } = await supabase
        .from('webhook_events')
        .select('*')
        .eq('event_id', eventId);

      assert.equal(rows.length, 1, 'Duplicate delivery must not create a duplicate row');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. Approval concurrency
  //    - two concurrent resolutions of the same pending approval
  //    - exactly one succeeds
  //    - exactly one mandate action is executed
  //    - no double attempt / double transition
  // ═══════════════════════════════════════════════════════════════════════════

  describe('2. Approval Concurrency', () => {
    it('two concurrent resolutions of the same pending approval: exactly one succeeds, exactly one mandate action is executed, no double attempt / double transition', async () => {
      const { run, mandate } = await createTestMandate({
        experimentArm: 'smart',
        status:        'pending',
        nextAction:    'none',
        attemptsUsed:  0,
      });

      // Request human approval → mandate moves to 'pending_human_approval'
      const { approvalId } = await requestHumanApproval({
        runId: run.id,
        mandate,
        currentDay: 1,
        proposal: { action: 'retry', delayDays: 2, confidence: 0.85 },
      });

      // Verify initial state
      const { data: initialMandate } = await supabase
        .from('mandates')
        .select('status, attempts_used')
        .eq('id', mandate.id)
        .single();
      assert.equal(initialMandate.status, 'pending_human_approval');
      assert.equal(initialMandate.attempts_used, 0);

      const { data: initialApproval } = await supabase
        .from('approval_requests')
        .select('status')
        .eq('id', approvalId)
        .single();
      assert.equal(initialApproval.status, 'pending');

      // Count attempts before resolution
      const { count: beforeAttemptCount } = await supabase
        .from('attempts')
        .select('*', { count: 'exact', head: true })
        .eq('mandate_id', mandate.id);
      assert.equal(beforeAttemptCount, 0);

      // Dispatch TWO concurrent resolution requests for the same approval
      const [res1, res2] = await Promise.all([
        postJson(baseUrl, `/api/approvals/${approvalId}/resolve`, {
          decision:       'approved',
          decidedBy:      'operator_alpha',
          decidedDay:     1,
          decisionReason: 'Alpha concurrent approval',
        }),
        postJson(baseUrl, `/api/approvals/${approvalId}/resolve`, {
          decision:       'rejected',
          decidedBy:      'operator_beta',
          decidedDay:     1,
          decisionReason: 'Beta concurrent rejection',
        }),
      ]);

      const statuses = [res1.status, res2.status];

      // Invariant: Exactly one succeeds
      const successCount = statuses.filter((s) => s === 200).length;
      const failureCount = statuses.filter((s) => s !== 200).length;

      assert.equal(successCount, 1, `Exactly one concurrent resolution must succeed (200), got: ${statuses.join(', ')}`);
      assert.equal(failureCount, 1, `The conflicting concurrent resolution must fail, got: ${statuses.join(', ')}`);

      const winningRes = res1.status === 200 ? res1.body : res2.body;
      const winningDecision = winningRes.decision; // 'approved' or 'rejected'

      // Invariant: Exactly one mandate action is executed
      const { data: freshApproval } = await supabase
        .from('approval_requests')
        .select('*')
        .eq('id', approvalId)
        .single();

      assert.notEqual(freshApproval.status, 'pending', 'Approval request must not remain pending');
      assert.equal(freshApproval.status, winningDecision, `Approval status must match winning decision (${winningDecision})`);

      const { data: freshMandate } = await supabase
        .from('mandates')
        .select('*')
        .eq('id', mandate.id)
        .single();

      if (winningDecision === 'approved') {
        assert.equal(freshMandate.status, 'pending', 'Approved mandate must return to pending');
        assert.equal(freshMandate.next_action, 'retry', 'Approved mandate next_action must be retry');
        assert.ok(freshMandate.next_action_day >= 1, 'Approved mandate must have future next_action_day');
      } else {
        assert.equal(freshMandate.status, 'stood_down', 'Rejected mandate must transition to stood_down');
        assert.equal(freshMandate.next_action, 'none', 'Rejected mandate next_action must be none');
        assert.equal(freshMandate.next_action_day, null, 'Rejected mandate next_action_day must be null');
      }

      // Invariant: No double attempt
      const { count: afterAttemptCount } = await supabase
        .from('attempts')
        .select('*', { count: 'exact', head: true })
        .eq('mandate_id', mandate.id);

      assert.equal(afterAttemptCount, 0, 'Approval resolution must NEVER execute or create payment attempts');

      // Invariant: No double transition (audit_logs records exactly one resolution)
      const { data: resolutionLogs } = await supabase
        .from('audit_logs')
        .select('*')
        .eq('mandate_id', mandate.id)
        .in('decision_type', ['approval_approved', 'approval_rejected']);

      assert.equal(resolutionLogs.length, 1, 'Exactly one resolution audit log must exist (no double transition)');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Manual Razorpay order
  //    - eligible Smart + RETRY mandate → order creation allowed
  //    - Control/Baseline mandate → blocked
  //    - non-RETRY mandate → blocked
  //    - attempts_used >= 4 → blocked
  //    - synthetic simulation data remains unchanged
  // ═══════════════════════════════════════════════════════════════════════════

  describe('3. Manual Razorpay Order', () => {
    it('eligible Smart + RETRY mandate → order creation allowed', async () => {
      const { run, mandate } = await createTestMandate({
        experimentArm: 'smart',
        nextAction:    'retry',
        attemptsUsed:  1,
        amount:        2500,
        status:        'pending',
      });

      const mockOrderId = `order_p7_mock_${Date.now()}`;
      const originalFetch = global.fetch;
      global.fetch = async (url, opts) => {
        if (typeof url === 'string' && url.includes('api.razorpay.com/v1/orders')) {
          return {
            ok:     true,
            status: 200,
            json:   async () => ({
              id:         mockOrderId,
              entity:     'order',
              amount:     250000,
              currency:   'INR',
              status:     'created',
              created_at: Math.floor(Date.now() / 1000),
            }),
          };
        }
        return originalFetch(url, opts);
      };

      process.env.RAZORPAY_KEY_ID     = 'rzp_test_p7_key';
      process.env.RAZORPAY_KEY_SECRET = 'rzp_test_p7_secret';

      try {
        const res = await postJson(baseUrl, '/api/v1/razorpay/orders', {
          mandateId: mandate.id,
          currency:  'INR',
        });

        assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.disclosure, ORDER_DISCLOSURE);
        assert.ok(res.body.razorpay_order);
        assert.equal(res.body.razorpay_order.id, mockOrderId);
        assert.equal(res.body.mandate.id, mandate.id);
        assert.equal(res.body.mandate.experiment_arm, 'smart');
      } finally {
        global.fetch = originalFetch;
        process.env.RAZORPAY_KEY_ID     = savedKeyId;
        process.env.RAZORPAY_KEY_SECRET = savedKeySecret;
      }
    });

    it('Control/Baseline mandate → blocked', async () => {
      // Control mandate
      const { mandate: ctrlMandate } = await createTestMandate({
        experimentArm: 'control',
        nextAction:    'retry',
        attemptsUsed:  0,
      });

      const resCtrl = await postJson(baseUrl, '/api/v1/razorpay/orders', {
        mandateId: ctrlMandate.id,
        currency:  'INR',
      });
      assert.equal(resCtrl.status, 422, 'Control mandate must be blocked with 422');
      assert.ok(
        resCtrl.body.error.toLowerCase().includes('smart'),
        `Error must mention smart arm requirement, got: ${resCtrl.body.error}`
      );
      assert.equal(resCtrl.body.disclosure, ORDER_DISCLOSURE);

      // Baseline mandate
      const { mandate: baseMandate } = await createTestMandate({
        experimentArm: 'baseline',
        nextAction:    'retry',
        attemptsUsed:  1,
      });

      const resBase = await postJson(baseUrl, '/api/v1/razorpay/orders', {
        mandateId: baseMandate.id,
        currency:  'INR',
      });
      assert.equal(resBase.status, 422, 'Baseline mandate must be blocked with 422');
      assert.ok(
        resBase.body.error.toLowerCase().includes('smart'),
        `Error must mention smart arm requirement, got: ${resBase.body.error}`
      );
      assert.equal(resBase.body.disclosure, ORDER_DISCLOSURE);
    });

    it('non-RETRY mandate → blocked', async () => {
      // Mandate with next_action = stand_down
      const { mandate: sdMandate } = await createTestMandate({
        experimentArm: 'smart',
        nextAction:    'stand_down',
        status:        'stood_down',
        attemptsUsed:  1,
      });

      const resSd = await postJson(baseUrl, '/api/v1/razorpay/orders', {
        mandateId: sdMandate.id,
        currency:  'INR',
      });
      assert.equal(resSd.status, 422, 'Mandate with next_action=stand_down must be blocked with 422');
      assert.ok(
        resSd.body.error.includes('retry') || resSd.body.error.includes('next_action'),
        `Error must mention retry requirement, got: ${resSd.body.error}`
      );
      assert.equal(resSd.body.disclosure, ORDER_DISCLOSURE);

      // Mandate with next_action = none
      const { mandate: noneMandate } = await createTestMandate({
        experimentArm: 'smart',
        nextAction:    'none',
        status:        'recovered',
        attemptsUsed:  1,
      });

      const resNone = await postJson(baseUrl, '/api/v1/razorpay/orders', {
        mandateId: noneMandate.id,
        currency:  'INR',
      });
      assert.equal(resNone.status, 422, 'Mandate with next_action=none must be blocked with 422');
      assert.ok(
        resNone.body.error.includes('retry') || resNone.body.error.includes('next_action'),
        `Error must mention retry requirement, got: ${resNone.body.error}`
      );
      assert.equal(resNone.body.disclosure, ORDER_DISCLOSURE);
    });

    it('attempts_used >= 4 → blocked', async () => {
      const { mandate } = await createTestMandate({
        experimentArm: 'smart',
        nextAction:    'retry',
        attemptsUsed:  4,
      });

      const res = await postJson(baseUrl, '/api/v1/razorpay/orders', {
        mandateId: mandate.id,
        currency:  'INR',
      });

      assert.equal(res.status, 422, 'Mandate with attempts_used >= 4 must be blocked with 422');
      assert.ok(
        res.body.error.includes('4') || res.body.error.toLowerCase().includes('maximum'),
        `Error must mention 4 attempts limit, got: ${res.body.error}`
      );
      assert.equal(res.body.disclosure, ORDER_DISCLOSURE);
    });

    it('synthetic simulation data remains unchanged after order operations', async () => {
      const { run, mandate } = await createTestMandate({
        experimentArm: 'smart',
        nextAction:    'retry',
        attemptsUsed:  2,
        amount:        1800,
        status:        'pending',
      });

      const beforeMandate = (await supabase.from('mandates').select('*').eq('id', mandate.id).single()).data;
      const beforeRun = (await supabase.from('simulation_runs').select('*').eq('id', run.id).single()).data;
      const { count: beforeAttempts } = await supabase.from('attempts').select('*', { count: 'exact', head: true }).eq('mandate_id', mandate.id);

      const mockOrderId = `order_p7_unchanged_${Date.now()}`;
      const originalFetch = global.fetch;
      global.fetch = async (url, opts) => {
        if (typeof url === 'string' && url.includes('api.razorpay.com/v1/orders')) {
          return {
            ok:     true,
            status: 200,
            json:   async () => ({
              id:         mockOrderId,
              entity:     'order',
              amount:     180000,
              currency:   'INR',
              status:     'created',
              created_at: Math.floor(Date.now() / 1000),
            }),
          };
        }
        return originalFetch(url, opts);
      };

      process.env.RAZORPAY_KEY_ID     = 'rzp_test_p7_key';
      process.env.RAZORPAY_KEY_SECRET = 'rzp_test_p7_secret';

      try {
        await postJson(baseUrl, '/api/v1/razorpay/orders', {
          mandateId: mandate.id,
          currency:  'INR',
        });
      } finally {
        global.fetch = originalFetch;
        process.env.RAZORPAY_KEY_ID     = savedKeyId;
        process.env.RAZORPAY_KEY_SECRET = savedKeySecret;
      }

      // Assert mandates table row unchanged
      const afterMandate = (await supabase.from('mandates').select('*').eq('id', mandate.id).single()).data;
      assert.deepEqual(afterMandate, beforeMandate, 'Synthetic mandate data must remain completely unchanged');

      // Assert attempts table has 0 rows for this mandate
      const { count: afterAttempts } = await supabase.from('attempts').select('*', { count: 'exact', head: true }).eq('mandate_id', mandate.id);
      assert.equal(afterAttempts, beforeAttempts);
      assert.equal(afterAttempts, 0, 'No attempts row may be created by manual order');

      // Assert simulation_runs table row unchanged
      const afterRun = (await supabase.from('simulation_runs').select('*').eq('id', run.id).single()).data;
      assert.deepEqual(afterRun, beforeRun, 'simulation_runs must remain completely unchanged');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. Isolation
  //    - snapshot mandates, attempts, simulation_runs and computed metrics
  //    - perform real webhook + manual Test Mode order
  //    - verify all four are byte-for-byte unchanged
  // ═══════════════════════════════════════════════════════════════════════════

  describe('4. Isolation', () => {
    it('snapshot mandates, attempts, simulation_runs and computed metrics → perform real webhook + manual Test Mode order → verify all four are byte-for-byte unchanged', async () => {
      // 1. Setup a representative simulation run with mandates across arms and an attempt record
      const { data: run, error: rErr } = await supabase
        .from('simulation_runs')
        .insert({ random_seed: 94001, max_days: 10, current_day: 2, status: 'running' })
        .select()
        .single();
      if (rErr) throw new Error('Isolation run setup failed: ' + rErr.message);
      createdRunIds.add(run.id);

      // Smart mandate (eligible for manual order)
      const { data: smartMandate } = await supabase
        .from('mandates')
        .insert({
          run_id:              run.id,
          mandate_id:          `ISO-SM-${Date.now()}`,
          amount:              2000,
          income_day_of_month: 10,
          balance_volatility:  0.2,
          contact_consent:     true,
          experiment_arm:      'smart',
          status:              'pending',
          first_due_day:       1,
          next_action:         'retry',
          next_action_day:     3,
          attempts_used:       1,
          created_day:         0,
        })
        .select()
        .single();

      // Control mandate
      const { data: ctrlMandate } = await supabase
        .from('mandates')
        .insert({
          run_id:              run.id,
          mandate_id:          `ISO-CTRL-${Date.now()}`,
          amount:              1000,
          income_day_of_month: 5,
          balance_volatility:  0.4,
          contact_consent:     false,
          experiment_arm:      'control',
          status:              'stood_down',
          first_due_day:       1,
          next_action:         'none',
          next_action_day:     null,
          attempts_used:       1,
          created_day:         0,
        })
        .select()
        .single();

      // Baseline mandate
      const { data: baseMandate } = await supabase
        .from('mandates')
        .insert({
          run_id:              run.id,
          mandate_id:          `ISO-BASE-${Date.now()}`,
          amount:              3000,
          income_day_of_month: 20,
          balance_volatility:  0.1,
          contact_consent:     true,
          experiment_arm:      'baseline',
          status:              'pending',
          first_due_day:       1,
          next_action:         'retry',
          next_action_day:     4,
          attempts_used:       1,
          created_day:         0,
        })
        .select()
        .single();

      // Insert real attempt records for realistic simulation metrics
      const { error: aErr } = await supabase.from('attempts').insert([
        {
          run_id:           run.id,
          mandate_id:       smartMandate.id,
          attempt_number:   1,
          scheduled_day:    1,
          executed_day:     1,
          outcome:          'failure',
          decline_code:     'insufficient_funds',
          decline_category: 'soft',
          retry_eligible:   true,
          channel:          'auto_debit',
          idempotency_key:  `idemp-p7-${Date.now()}-sm`,
        },
        {
          run_id:           run.id,
          mandate_id:       ctrlMandate.id,
          attempt_number:   1,
          scheduled_day:    1,
          executed_day:     1,
          outcome:          'failure',
          decline_code:     'account_closed',
          decline_category: 'hard',
          retry_eligible:   false,
          channel:          'auto_debit',
          idempotency_key:  `idemp-p7-${Date.now()}-ctrl`,
        },
        {
          run_id:           run.id,
          mandate_id:       baseMandate.id,
          attempt_number:   1,
          scheduled_day:    1,
          executed_day:     1,
          outcome:          'failure',
          decline_code:     'insufficient_funds',
          decline_category: 'soft',
          retry_eligible:   true,
          channel:          'auto_debit',
          idempotency_key:  `idemp-p7-${Date.now()}-base`,
        },
      ]);
      if (aErr) throw new Error('Isolation attempts setup failed: ' + aErr.message);

      // 2. Snapshot mandates, attempts, simulation_runs and computed metrics BEFORE operations
      const [mandatesSnapBefore, attemptsSnapBefore, runsSnapBefore] = await Promise.all([
        supabase.from('mandates').select('*').eq('run_id', run.id).order('id'),
        supabase.from('attempts').select('*').eq('run_id', run.id).order('id'),
        supabase.from('simulation_runs').select('*').eq('id', run.id),
      ]);
      const metricsSnapBefore = await getSimulationMetrics({ runId: run.id });

      const mandatesBeforeStr = JSON.stringify(mandatesSnapBefore.data);
      const attemptsBeforeStr = JSON.stringify(attemptsSnapBefore.data);
      const runsBeforeStr     = JSON.stringify(runsSnapBefore.data);
      const metricsBeforeStr  = JSON.stringify(metricsSnapBefore);

      // 3. Perform real webhook
      const webhookEventId = `evt_p7_isolation_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      createdWebhookEventIds.add(webhookEventId);

      const { rawBody, signature } = buildSignedWebhookPayload();
      const webhookRes = await postWebhook(baseUrl, rawBody, {
        'x-razorpay-signature': signature,
        'x-razorpay-event-id':  webhookEventId,
      });
      assert.equal(webhookRes.status, 200, 'Webhook delivery must succeed');
      assert.equal(webhookRes.body.received, true);

      // 4. Perform manual Test Mode order
      const mockOrderId = `order_p7_isolation_${Date.now()}`;
      const originalFetch = global.fetch;
      global.fetch = async (url, opts) => {
        if (typeof url === 'string' && url.includes('api.razorpay.com/v1/orders')) {
          return {
            ok:     true,
            status: 200,
            json:   async () => ({
              id:         mockOrderId,
              entity:     'order',
              amount:     200000,
              currency:   'INR',
              status:     'created',
              created_at: Math.floor(Date.now() / 1000),
            }),
          };
        }
        return originalFetch(url, opts);
      };

      process.env.RAZORPAY_KEY_ID     = 'rzp_test_iso_key';
      process.env.RAZORPAY_KEY_SECRET = 'rzp_test_iso_secret';

      try {
        const orderRes = await postJson(baseUrl, '/api/v1/razorpay/orders', {
          mandateId: smartMandate.id,
          currency:  'INR',
        });
        assert.equal(orderRes.status, 201, 'Manual order creation must succeed');
      } finally {
        global.fetch = originalFetch;
        process.env.RAZORPAY_KEY_ID     = savedKeyId;
        process.env.RAZORPAY_KEY_SECRET = savedKeySecret;
      }

      // 5. Snapshot all four AFTER operations
      const [mandatesSnapAfter, attemptsSnapAfter, runsSnapAfter] = await Promise.all([
        supabase.from('mandates').select('*').eq('run_id', run.id).order('id'),
        supabase.from('attempts').select('*').eq('run_id', run.id).order('id'),
        supabase.from('simulation_runs').select('*').eq('id', run.id),
      ]);
      const metricsSnapAfter = await getSimulationMetrics({ runId: run.id });

      const mandatesAfterStr = JSON.stringify(mandatesSnapAfter.data);
      const attemptsAfterStr = JSON.stringify(attemptsSnapAfter.data);
      const runsAfterStr     = JSON.stringify(runsSnapAfter.data);
      const metricsAfterStr  = JSON.stringify(metricsSnapAfter);

      // 6. Verify all four are byte-for-byte unchanged
      assert.equal(
        mandatesAfterStr,
        mandatesBeforeStr,
        'mandates table must be byte-for-byte unchanged after real webhook + manual order'
      );
      assert.equal(
        attemptsAfterStr,
        attemptsBeforeStr,
        'attempts table must be byte-for-byte unchanged after real webhook + manual order'
      );
      assert.equal(
        runsAfterStr,
        runsBeforeStr,
        'simulation_runs table must be byte-for-byte unchanged after real webhook + manual order'
      );
      assert.equal(
        metricsAfterStr,
        metricsBeforeStr,
        'computed metrics must be byte-for-byte unchanged after real webhook + manual order'
      );
    });
  });
});
