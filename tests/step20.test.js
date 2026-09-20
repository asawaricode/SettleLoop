// tests/step20.test.js
//
// Phase 3 — A3 + A5: Automated isolation tests for Razorpay webhook and
// manual order endpoints.
//
// Design rules:
//   - ZERO dependency on real Razorpay network delivery.
//   - Webhook tests construct and sign their own payloads using a deterministic
//     test-only secret injected per-suite.
//   - The Razorpay Orders API call in the manual-order endpoint is MOCKED for
//     all automated tests. Explicitly identified as MOCKED in assertions.
//   - Simulation tables (mandates, attempts, simulation_runs) are captured
//     BEFORE and AFTER and verified byte-for-byte equal.
//   - webhook_events and audit_logs are ALLOWED to change.
//
// Automated Orders API test: MOCKED
//   We patch global.fetch to intercept the call to
//   https://api.razorpay.com/v1/orders and return a fabricated response.
//   We never claim this proves a live Razorpay order was created.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { describe, it, before, after } from 'node:test';
import { supabase } from '../src/config/supabase.js';
import { app } from '../server.js';
import { verifyRazorpaySignature } from '../src/api/razorpayWebhook.js';
import { ORDER_DISCLOSURE } from '../src/api/razorpayOrder.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test-only webhook secret (never used in production)
// ─────────────────────────────────────────────────────────────────────────────

const TEST_WEBHOOK_SECRET = 'test-wh-secret-phase3-step20-xyz';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a Razorpay-shaped payment.failed event payload and sign it. */
function buildSignedWebhookPayload(overrides = {}, secret = TEST_WEBHOOK_SECRET) {
  const payload = {
    entity:     'event',
    account_id: 'acc_test_phase3',
    event:      'payment.failed',
    contains:   ['payment'],
    payload: {
      payment: {
        entity: {
          id:                'pay_test_phase3',
          entity:            'payment',
          amount:            150000,
          currency:          'INR',
          status:            'failed',
          error_code:        'BAD_REQUEST_ERROR',
          error_description: 'Payment failed (test)',
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
    ...overrides,
  };

  // Serialize exactly once — the same bytes will be signed and sent.
  const rawBody  = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  return { payload, rawBody, signature };
}

/** POST rawBody (Buffer) with explicit headers to the test server. */
async function postWebhook(baseUrl, rawBody, headers) {
  const res = await fetch(`${baseUrl}/api/v1/webhooks/razorpay`, {
    method:  'POST',
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
  const bodyStr = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body:    bodyStr,
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

/** Snapshot simulation tables for before/after isolation comparison. */
async function snapshotSimTables({ runIds = [], mandateIds = [] }) {
  const [runs, mandates, attempts] = await Promise.all([
    runIds.length
      ? supabase.from('simulation_runs').select('*').in('id', runIds)
      : Promise.resolve({ data: [] }),
    mandateIds.length
      ? supabase.from('mandates').select('*').in('id', mandateIds)
      : Promise.resolve({ data: [] }),
    mandateIds.length
      ? supabase.from('attempts').select('*').in('mandate_id', mandateIds)
      : Promise.resolve({ data: [] }),
  ]);
  return {
    runs:     (runs.data     || []).map(r => JSON.stringify(r)).sort().join('\n'),
    mandates: (mandates.data || []).map(m => JSON.stringify(m)).sort().join('\n'),
    attempts: (attempts.data || []).map(a => JSON.stringify(a)).sort().join('\n'),
  };
}

/** Create a minimal simulation_run + smart mandate for test isolation. */
async function createSmartTestMandate({ nextAction = 'retry', attemptsUsed = 1, status = 'pending' } = {}) {
  const { data: run, error: runErr } = await supabase
    .from('simulation_runs')
    .insert({ random_seed: 77777, max_days: 30, current_day: 1, status: 'running' })
    .select().single();
  if (runErr) throw new Error('createSmartTestMandate run failed: ' + runErr.message);

  const { data: mandate, error: mErr } = await supabase
    .from('mandates')
    .insert({
      run_id:              run.id,
      mandate_id:          `PHASE3-SM-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      amount:              1500,
      income_day_of_month: 15,
      balance_volatility:  0.3,
      contact_consent:     true,
      experiment_arm:      'smart',
      status,
      first_due_day:       1,
      next_action:         nextAction,
      next_action_day:     1,
      attempts_used:       attemptsUsed,
      created_day:         0,
    })
    .select().single();
  if (mErr) throw new Error('createSmartTestMandate mandate failed: ' + mErr.message);

  return { run, mandate };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 20 — Phase 3: Razorpay Real Integration', () => {
  let server;
  let baseUrl;

  // Saved env state so we can restore after tests
  let savedWebhookSecret;
  let savedKeyId;
  let savedKeySecret;

  before(async () => {
    // Start ephemeral server (port 0 = random free port)
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    // Inject test-only secret so webhook route uses it
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
  });

  // ── 1-7: verifyRazorpaySignature unit tests ────────────────────────────────

  it('1. Valid signature: verifyRazorpaySignature returns true', () => {
    const body   = Buffer.from('{"event":"payment.failed"}', 'utf8');
    const secret = 'unit-test-secret';
    const sig    = crypto.createHmac('sha256', secret).update(body).digest('hex');
    assert.equal(verifyRazorpaySignature(body, sig, secret), true);
  });

  it('2. Invalid signature: verifyRazorpaySignature returns false', () => {
    const body = Buffer.from('{"event":"payment.failed"}', 'utf8');
    assert.equal(verifyRazorpaySignature(body, 'deadbeef'.repeat(8), 'secret'), false);
  });

  it('3. Tampered raw body: verifyRazorpaySignature returns false', () => {
    const originalBody = Buffer.from('{"event":"payment.failed"}', 'utf8');
    const tamperedBody = Buffer.from('{"event":"payment.captured"}', 'utf8');
    const secret       = 'tamper-test';
    const sig          = crypto.createHmac('sha256', secret).update(originalBody).digest('hex');
    assert.equal(verifyRazorpaySignature(tamperedBody, sig, secret), false);
  });

  it('4. Timing-safe comparison: does not throw for any input', () => {
    const body = Buffer.from('test-body', 'utf8');
    // Should not throw for any combination of lengths or formats
    assert.doesNotThrow(() => verifyRazorpaySignature(body, 'short', 'secret'));
    assert.doesNotThrow(() => verifyRazorpaySignature(body, 'a'.repeat(200), 'secret'));
    assert.doesNotThrow(() => verifyRazorpaySignature(body, 'a'.repeat(64), 'secret'));
  });

  it('5. Unequal signature length: returns false without throwing', () => {
    const body = Buffer.from('test', 'utf8');
    assert.equal(verifyRazorpaySignature(body, 'tooshort', 'secret'), false);
    assert.equal(verifyRazorpaySignature(body, 'a'.repeat(128), 'secret'), false);
  });

  it('6. Missing/empty signature: returns false', () => {
    const body = Buffer.from('test', 'utf8');
    assert.equal(verifyRazorpaySignature(body, '',        'secret'), false);
    assert.equal(verifyRazorpaySignature(body, null,      'secret'), false);
    assert.equal(verifyRazorpaySignature(body, undefined, 'secret'), false);
  });

  it('7. Missing/empty secret: returns false', () => {
    const body = Buffer.from('test', 'utf8');
    assert.equal(verifyRazorpaySignature(body, 'anysig', ''),        false);
    assert.equal(verifyRazorpaySignature(body, 'anysig', null),      false);
    assert.equal(verifyRazorpaySignature(body, 'anysig', undefined), false);
  });

  // ── 8-12: Webhook HTTP endpoint ───────────────────────────────────────────

  it('8. Missing X-Razorpay-Signature → 400', async () => {
    const { rawBody } = buildSignedWebhookPayload();
    const res = await postWebhook(baseUrl, rawBody, {
      'x-razorpay-event-id': 'evt_p3_no_sig',
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error, 'Error message must be present');
  });

  it('9. Missing x-razorpay-event-id → 400', async () => {
    const { rawBody, signature } = buildSignedWebhookPayload();
    const res = await postWebhook(baseUrl, rawBody, {
      'x-razorpay-signature': signature,
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error, 'Error message must be present');
  });

  it('10. Invalid signature → 401', async () => {
    const { rawBody } = buildSignedWebhookPayload();
    const res = await postWebhook(baseUrl, rawBody, {
      'x-razorpay-signature': 'a'.repeat(64),
      'x-razorpay-event-id':  `evt_p3_badsig_${Date.now()}`,
    });
    assert.equal(res.status, 401);
  });

  it('11. Valid signature + event ID → 200 + stored in webhook_events', async () => {
    const eventId = `evt_p3_valid_${Date.now()}`;
    const { rawBody, signature } = buildSignedWebhookPayload();

    const res = await postWebhook(baseUrl, rawBody, {
      'x-razorpay-signature': signature,
      'x-razorpay-event-id':  eventId,
    });

    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.received, true);
    assert.equal(res.body.duplicate, false);
    assert.equal(res.body.event_id, eventId);
    assert.equal(res.body.event_type, 'payment.failed');

    // Confirm stored in DB
    const { data: rows } = await supabase
      .from('webhook_events')
      .select('*')
      .eq('event_id', eventId);
    assert.equal(rows.length, 1, 'Exactly one webhook_events row must be created');
    assert.equal(rows[0].event_type, 'payment.failed');
    assert.equal(rows[0].signature_verified, true);
  });

  it('12. Duplicate event ID → 200 + idempotent (no second row created)', async () => {
    const eventId = `evt_p3_dedup_${Date.now()}`;
    const { rawBody, signature } = buildSignedWebhookPayload();
    const headers = {
      'x-razorpay-signature': signature,
      'x-razorpay-event-id':  eventId,
    };

    const res1 = await postWebhook(baseUrl, rawBody, headers);
    assert.equal(res1.status, 200);
    assert.equal(res1.body.duplicate, false);

    // Second delivery — same event_id
    const res2 = await postWebhook(baseUrl, rawBody, headers);
    assert.equal(res2.status, 200, 'Duplicate must return 200 not 4xx/5xx');
    assert.equal(res2.body.duplicate, true, 'Duplicate flag must be true');

    // DB: still exactly one row
    const { data: rows } = await supabase
      .from('webhook_events')
      .select('*')
      .eq('event_id', eventId);
    assert.equal(rows.length, 1, 'Duplicate delivery must not create a second webhook_events row');
  });

  // ── 13-14: Isolation — webhook must not mutate simulation tables ──────────

  it('13. Webhook does not mutate mandates, attempts, or simulation_runs', async () => {
    const { run, mandate } = await createSmartTestMandate();
    const before = await snapshotSimTables({ runIds: [run.id], mandateIds: [mandate.id] });

    // Deliver a valid webhook
    const eventId = `evt_p3_isolate_${Date.now()}`;
    const { rawBody, signature } = buildSignedWebhookPayload();
    await postWebhook(baseUrl, rawBody, {
      'x-razorpay-signature': signature,
      'x-razorpay-event-id':  eventId,
    });

    const after = await snapshotSimTables({ runIds: [run.id], mandateIds: [mandate.id] });

    assert.equal(before.runs,     after.runs,     'Webhook must not modify simulation_runs');
    assert.equal(before.mandates, after.mandates,  'Webhook must not modify mandates');
    assert.equal(before.attempts, after.attempts,  'Webhook must not create or modify attempts');
  });

  it('14. Webhook does not affect experiment metrics', async () => {
    const { run, mandate } = await createSmartTestMandate();

    const { getSimulationMetrics } = await import('../src/evaluation/metrics.js');
    const metricsBefore = await getSimulationMetrics({ runId: run.id });

    // Deliver webhook
    const eventId = `evt_p3_metrics_${Date.now()}`;
    const { rawBody, signature } = buildSignedWebhookPayload();
    await postWebhook(baseUrl, rawBody, {
      'x-razorpay-signature': signature,
      'x-razorpay-event-id':  eventId,
    });

    const metricsAfter = await getSimulationMetrics({ runId: run.id });

    assert.deepEqual(
      JSON.parse(JSON.stringify(metricsBefore)),
      JSON.parse(JSON.stringify(metricsAfter)),
      'Webhook delivery must not change experiment metrics'
    );
  });

  // ── 15-18: Manual Order validation ────────────────────────────────────────

  it('15. Manual order rejects non-Smart mandate (experiment_arm = control)', async () => {
    const { data: run, error: runErr } = await supabase
      .from('simulation_runs')
      .insert({ random_seed: 11111, max_days: 30, current_day: 0, status: 'running' })
      .select().single();
    if (runErr) throw new Error('create control run failed: ' + runErr.message);

    const { data: controlMandate, error: mErr } = await supabase
      .from('mandates')
      .insert({
        run_id: run.id, mandate_id: `P3-CTRL-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, amount: 1000,
        income_day_of_month: 15, balance_volatility: 0.3, contact_consent: true,
        experiment_arm: 'control', status: 'pending', first_due_day: 0,
        next_action: 'retry', next_action_day: 0, attempts_used: 0, created_day: 0,
      })
      .select().single();
    if (mErr) throw new Error('create control mandate failed: ' + mErr.message);

    const res = await postJson(baseUrl, '/api/v1/razorpay/orders', {
      mandateId: controlMandate.id,
      currency:  'INR',
    });

    assert.equal(res.status, 422, `Expected 422, got ${res.status}`);
    assert.ok(res.body.error.toLowerCase().includes('smart'),
      'Error must mention smart arm requirement');
    assert.equal(res.body.disclosure, ORDER_DISCLOSURE,
      'Disclosure must always be present');
  });

  it('16. Manual order rejects non-RETRY decision (next_action = stand_down)', async () => {
    const { mandate } = await createSmartTestMandate({
      nextAction: 'stand_down',
      status:     'stood_down',
    });
    const res = await postJson(baseUrl, '/api/v1/razorpay/orders', {
      mandateId: mandate.id,
      currency:  'INR',
    });
    assert.equal(res.status, 422);
    assert.ok(
      res.body.error.includes('retry') || res.body.error.includes('next_action'),
      'Error must mention retry requirement'
    );
    assert.equal(res.body.disclosure, ORDER_DISCLOSURE);
  });

  it('17. Manual order respects 4-attempt guardrail (attempts_used = 4 → 422)', async () => {
    const { mandate } = await createSmartTestMandate({ attemptsUsed: 4, nextAction: 'retry' });
    const res = await postJson(baseUrl, '/api/v1/razorpay/orders', {
      mandateId: mandate.id,
      currency:  'INR',
    });
    assert.equal(res.status, 422);
    assert.ok(
      res.body.error.includes('4') || res.body.error.toLowerCase().includes('maximum'),
      'Error must mention attempt limit'
    );
    assert.equal(res.body.disclosure, ORDER_DISCLOSURE);
  });

  it('18. Manual order for non-existent mandate → 404', async () => {
    const res = await postJson(baseUrl, '/api/v1/razorpay/orders', {
      mandateId: '00000000-0000-0000-0000-000000000000',
      currency:  'INR',
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.disclosure, ORDER_DISCLOSURE);
  });

  // ── 19-20: Manual Order — MOCKED Orders API path ──────────────────────────
  //
  // ⚠️  AUTOMATED ORDERS API TEST: MOCKED
  //    The Razorpay Orders API call is intercepted by patching global.fetch.
  //    No real HTTP call to api.razorpay.com is made.
  //    We never fabricate a real Razorpay order_id.
  //    This test proves: preflight passed, response shape correct, no attempts
  //    row created, mandate and simulation_run are unchanged.

  it('19. [MOCKED] Manual order creates no attempts row; records order in audit_logs', async () => {
    // NOTE: MOCKED Razorpay Orders API — no real HTTP call.
    const { run, mandate } = await createSmartTestMandate({ attemptsUsed: 1 });

    const { getSimulationMetrics } = await import('../src/evaluation/metrics.js');
    const metricsBefore = await getSimulationMetrics({ runId: run.id });

    const mockOrderId = `order_MOCKED_${Date.now()}`;
    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.includes('api.razorpay.com/v1/orders')) {
        // MOCKED response
        return {
          ok:     true,
          status: 200,
          json:   async () => ({
            id:         mockOrderId,
            entity:     'order',
            amount:     150000,
            currency:   'INR',
            status:     'created',
            created_at: Math.floor(Date.now() / 1000),
          }),
        };
      }
      return originalFetch(url, opts);
    };

    process.env.RAZORPAY_KEY_ID     = 'rzp_test_mocked_key_id';
    process.env.RAZORPAY_KEY_SECRET = 'mocked_key_secret_not_real';

    const beforeAttempts = (await supabase
      .from('attempts').select('id').eq('mandate_id', mandate.id)).data || [];
    const beforeMandate = (await supabase
      .from('mandates').select('*').eq('id', mandate.id).single()).data;
    const beforeRun = (await supabase
      .from('simulation_runs').select('*').eq('id', run.id).single()).data;

    const res = await postJson(baseUrl, '/api/v1/razorpay/orders', {
      mandateId: mandate.id,
      currency:  'INR',
    });

    global.fetch = originalFetch;
    process.env.RAZORPAY_KEY_ID     = savedKeyId;
    process.env.RAZORPAY_KEY_SECRET = savedKeySecret;

    assert.equal(res.status, 201, `[MOCKED] Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.disclosure, ORDER_DISCLOSURE, '[MOCKED] Disclosure must be present');
    assert.ok(res.body.razorpay_order, '[MOCKED] razorpay_order must be in response');
    assert.equal(res.body.razorpay_order.id, mockOrderId, '[MOCKED] Order ID must match mock');

    // No new attempts row
    const afterAttempts = (await supabase
      .from('attempts').select('id').eq('mandate_id', mandate.id)).data || [];
    assert.equal(
      beforeAttempts.map(a => a.id).sort().join(','),
      afterAttempts.map(a => a.id).sort().join(','),
      '[MOCKED] Manual order must NOT create an attempts row'
    );

    // Mandate state unchanged
    const afterMandate = (await supabase
      .from('mandates').select('*').eq('id', mandate.id).single()).data;
    assert.deepEqual(
      beforeMandate,
      afterMandate,
      '[MOCKED] Manual order must NOT modify mandate state'
    );

    // Simulation run unchanged
    const afterRun = (await supabase
      .from('simulation_runs').select('*').eq('id', run.id).single()).data;
    assert.deepEqual(
      beforeRun,
      afterRun,
      '[MOCKED] Manual order must NOT modify simulation_runs'
    );

    // Experiment metrics unchanged
    const metricsAfter = await getSimulationMetrics({ runId: run.id });
    assert.deepEqual(
      JSON.parse(JSON.stringify(metricsBefore)),
      JSON.parse(JSON.stringify(metricsAfter)),
      '[MOCKED] Manual order must NOT modify experiment metrics'
    );

    // Order artifact and metadata stored in audit_logs
    const { data: auditRows } = await supabase
      .from('audit_logs')
      .select('*')
      .eq('mandate_id', mandate.id)
      .eq('decision_type', 'razorpay_order_created');
    assert.equal(
      auditRows.length, 1,
      '[MOCKED] Order artifact must be stored in audit_logs'
    );
    assert.equal(auditRows[0].metadata?.razorpay_order_id, mockOrderId,
      '[MOCKED] audit_logs.metadata must store the real/mocked order_id');
    assert.equal(auditRows[0].metadata?.amount_paise, 150000,
      '[MOCKED] audit_logs.metadata must store amount_paise');
    assert.equal(auditRows[0].metadata?.currency, 'INR',
      '[MOCKED] audit_logs.metadata must store currency');
    assert.equal(auditRows[0].actor, 'operator_manual',
      '[MOCKED] audit_logs actor must be operator_manual');

    // webhook_events must NOT store outbound manual order
    const { data: webhookRows } = await supabase
      .from('webhook_events')
      .select('*')
      .eq('event_id', `razorpay-order:${mockOrderId}`);
    assert.equal(
      webhookRows.length, 0,
      'webhook_events must not receive outbound manual order entries'
    );
  });

  it('20. [MOCKED] Manual order does not modify simulation_runs', async () => {
    // NOTE: MOCKED Razorpay Orders API — no real HTTP call.
    const { run, mandate } = await createSmartTestMandate({ attemptsUsed: 2 });

    const beforeRun = (await supabase
      .from('simulation_runs').select('*').eq('id', run.id).single()).data;

    const mockOrderId = `order_MOCKED2_${Date.now()}`;
    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.includes('api.razorpay.com/v1/orders')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            id: mockOrderId, entity: 'order', amount: 150000,
            currency: 'INR', status: 'created',
            created_at: Math.floor(Date.now() / 1000),
          }),
        };
      }
      return originalFetch(url, opts);
    };

    process.env.RAZORPAY_KEY_ID     = 'rzp_test_mocked_key_id2';
    process.env.RAZORPAY_KEY_SECRET = 'mocked_key_secret2_not_real';

    await postJson(baseUrl, '/api/v1/razorpay/orders', {
      mandateId: mandate.id,
      currency:  'INR',
    });

    global.fetch = originalFetch;
    process.env.RAZORPAY_KEY_ID     = savedKeyId;
    process.env.RAZORPAY_KEY_SECRET = savedKeySecret;

    const afterRun = (await supabase
      .from('simulation_runs').select('*').eq('id', run.id).single()).data;

    assert.deepEqual(
      beforeRun,
      afterRun,
      '[MOCKED] Manual order must NOT modify simulation_runs'
    );
  });

  // ── 21-22: Security invariants ────────────────────────────────────────────

  it('21. Webhook response never exposes RAZORPAY_WEBHOOK_SECRET', async () => {
    const { rawBody, signature } = buildSignedWebhookPayload();
    const eventId = `evt_p3_seccheck_${Date.now()}`;
    const res = await postWebhook(baseUrl, rawBody, {
      'x-razorpay-signature': signature,
      'x-razorpay-event-id':  eventId,
    });
    const responseStr = JSON.stringify(res.body);
    assert.ok(
      !responseStr.includes(TEST_WEBHOOK_SECRET),
      'Webhook response must not contain the webhook secret value'
    );
    assert.ok(
      !responseStr.includes('RAZORPAY_WEBHOOK_SECRET'),
      'Webhook response must not reference env variable name'
    );
  });

  it('22. [MOCKED] Order response never exposes RAZORPAY_KEY_SECRET', async () => {
    // NOTE: MOCKED Razorpay Orders API.
    const { mandate } = await createSmartTestMandate({ attemptsUsed: 0 });

    const testSecret = 'secret_must_never_appear_in_response_zzz';
    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.includes('api.razorpay.com/v1/orders')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            id: `order_sectest_${Date.now()}`, entity: 'order',
            amount: 150000, currency: 'INR', status: 'created',
            created_at: Math.floor(Date.now() / 1000),
          }),
        };
      }
      return originalFetch(url, opts);
    };

    process.env.RAZORPAY_KEY_ID     = 'rzp_test_seccheck';
    process.env.RAZORPAY_KEY_SECRET = testSecret;

    const res = await postJson(baseUrl, '/api/v1/razorpay/orders', {
      mandateId: mandate.id,
      currency:  'INR',
    });

    global.fetch = originalFetch;
    process.env.RAZORPAY_KEY_ID     = savedKeyId;
    process.env.RAZORPAY_KEY_SECRET = savedKeySecret;

    const responseStr = JSON.stringify(res.body);
    assert.ok(
      !responseStr.includes(testSecret),
      'API secret must not appear in order response'
    );
  });
});
