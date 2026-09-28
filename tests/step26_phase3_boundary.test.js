// tests/step26_phase3_boundary.test.js
//
// Phase 3 — Boundary Hardening Tests:
// 1. Zod Proposal Structural Validation at LLM Boundary
// 2. Strict Separation: Zod Schema vs Business Guardrails
// 3. Separate Outcome Logging: schema_validation_failure vs guardrail_rejection
// 4. Deterministic Fallbacks & Escalation (Passing Guardrails)
// 5. Gemini Fuzz Testing via fast-check (Pure Mocked LLM, Zero API calls)
// 6. Razorpay Webhook Raw-Body Verification, Idempotency & Rollback
// 7. Re-serialized Payload with Modified Whitespace Fails Raw Verification
// 8. Unknown Webhook Events Handled Without Recovery Effects
// 9. Sandbox Isolation Guarantees

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { describe, it, before, after, beforeEach } from 'node:test';
import fc from 'fast-check';

import { app } from '../server.js';
import { supabase } from '../src/config/supabase.js';
import {
  validateProposalStructure,
  generateDeterministicFallback,
  GeminiProposalSchema,
} from '../src/recovery/proposalValidator.js';
import {
  evaluateGuardrails,
  validateGuardrails,
  applyGuardrails,
} from '../src/recovery/guardrails.js';
import {
  proposeSmartRecoveryAction,
  setMockLLMHandler,
  resetMockLLMHandler,
  getLLMMode,
} from '../src/recovery/smartAgent.js';
import { executeSmartPolicy } from '../src/recovery/smartPolicy.js';
import {
  verifyRazorpaySignature,
  KNOWN_WEBHOOK_EVENTS,
  setWebhookEffectHandler,
  resetWebhookEffectHandler,
} from '../src/api/razorpayWebhook.js';
import { maxAttemptsPerCycle } from '../src/config/recoveryPolicy.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Constants & Webhook Helpers
// ─────────────────────────────────────────────────────────────────────────────

const TEST_SECRET = 'whsec_phase3_boundary_secret_12345';

function buildSignedWebhook(payload, secret = TEST_SECRET) {
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return { payload, rawBody, signature };
}

async function postWebhook(baseUrl, rawBody, headers) {
  const res = await fetch(`${baseUrl}/api/v1/webhooks/razorpay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(rawBody.length),
      ...headers,
    },
    body: rawBody,
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 26 — Phase 3: Boundary Hardening', () => {
  let server;
  let baseUrl;
  let savedWebhookSecret;
  const createdWebhookEventIds = new Set();

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    savedWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = TEST_SECRET;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    process.env.RAZORPAY_WEBHOOK_SECRET = savedWebhookSecret;

    // Clean up created webhook events in DB
    for (const eventId of createdWebhookEventIds) {
      try {
        await supabase.from('webhook_events').delete().eq('event_id', eventId);
      } catch (_) {}
    }
    resetMockLLMHandler();
    resetWebhookEffectHandler();
  });

  beforeEach(() => {
    resetMockLLMHandler();
    resetWebhookEffectHandler();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 1: Gemini Proposal Structural Validation (Zod boundary)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('1. Zod Structural Validation at LLM Boundary', () => {
    it('valid proposal structure passes Zod parsing', () => {
      const valid = {
        action: 'retry',
        retryDelayDays: 2,
        timeSlot: '14:00',
        channel: 'auto_debit',
        confidence: 0.85,
        reasoning: 'Customer history shows balance after day 2',
      };
      const res = validateProposalStructure(valid);
      assert.equal(res.success, true);
      assert.equal(res.data.action, 'retry');
      assert.equal(res.data.retryDelayDays, 2);
    });

    it('valid proposal string JSON passes parsing', () => {
      const jsonStr = JSON.stringify({
        action: 'stand_down',
        confidence: 0.9,
        reasoning: 'Hard decline',
      });
      const res = validateProposalStructure(jsonStr);
      assert.equal(res.success, true);
      assert.equal(res.data.action, 'stand_down');
    });

    it('missing required field (action) fails structure with schema_validation_failure', () => {
      const invalid = {
        retryDelayDays: 2,
        timeSlot: '14:00',
      };
      const res = validateProposalStructure(invalid);
      assert.equal(res.success, false);
      assert.equal(res.category, 'schema_validation_failure');
      assert.ok(res.errors.some((e) => e.includes('action')));
    });

    it('invalid enum value for action fails with schema_validation_failure', () => {
      const invalid = { action: 'immediate_charge', retryDelayDays: 1 };
      const res = validateProposalStructure(invalid);
      assert.equal(res.success, false);
      assert.equal(res.category, 'schema_validation_failure');
    });

    it('wrong types fail structure validation', () => {
      const res1 = validateProposalStructure({ action: 'retry', retryDelayDays: 'tomorrow' });
      assert.equal(res1.success, false);
      assert.equal(res1.category, 'schema_validation_failure');

      const res2 = validateProposalStructure({ action: 'retry', confidence: 'high' });
      assert.equal(res2.success, false);
      assert.equal(res2.category, 'schema_validation_failure');
    });

    it('extra unknown fields fail structure validation (strict mode prevents unvetted properties)', () => {
      const withExtra = {
        action: 'retry',
        retryDelayDays: 2,
        extraFlag: true,
        injectedScript: '<script>alert(1)</script>',
      };
      const res = validateProposalStructure(withExtra);
      assert.equal(res.success, false);
      assert.equal(res.category, 'schema_validation_failure');
      assert.ok(res.errors.some((e) => e.includes('unrecognized_keys') || e.includes('extraFlag')));
    });

    it('negative values fail structure constraints', () => {
      const res1 = validateProposalStructure({ action: 'retry', retryDelayDays: -3 });
      assert.equal(res1.success, false);
      assert.equal(res1.category, 'schema_validation_failure');

      const res2 = validateProposalStructure({ action: 'retry', confidence: -0.1 });
      assert.equal(res2.success, false);
      assert.equal(res2.category, 'schema_validation_failure');
    });

    it('non-object and malformed inputs never throw and return schema_validation_failure', () => {
      assert.doesNotThrow(() => validateProposalStructure(null));
      assert.doesNotThrow(() => validateProposalStructure(undefined));
      assert.doesNotThrow(() => validateProposalStructure([]));
      assert.doesNotThrow(() => validateProposalStructure('not json'));
      assert.doesNotThrow(() => validateProposalStructure(12345));

      assert.equal(validateProposalStructure(null).success, false);
      assert.equal(validateProposalStructure('not json').category, 'schema_validation_failure');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 2: Strict Separation of Zod Boundary vs Domain Guardrails
  // ═══════════════════════════════════════════════════════════════════════════

  describe('2. Zod Boundary vs Domain Guardrails Separation', () => {
    it('peak hour proposal PASSES Zod structure but FAILS domain guardrails', () => {
      // 11:00 IST is peak hours (10:00 - 13:00)
      const proposal = {
        action: 'retry',
        retryDelayDays: 1,
        timeSlot: '11:00',
        confidence: 0.85,
      };

      // 1. Zod structure check: passes because structure is valid
      const zodRes = validateProposalStructure(proposal);
      assert.equal(zodRes.success, true, 'Peak hour is a domain policy, NOT a Zod structural rule');

      // 2. Domain guardrail check: fails because 11:00 is peak
      const guardrailRes = evaluateGuardrails(proposal, {
        mandate: { status: 'pending', contact_consent: true },
        failure: { category: 'soft', retryEligible: true },
        attemptsUsed: 1,
      });
      assert.equal(guardrailRes.allowed, false);
      assert.equal(guardrailRes.finalAction, 'stand_down');
      assert.ok(guardrailRes.reasons.some((r) => r.includes('Peak-hour dispatch rejected')));
    });

    it('5th attempt proposal PASSES Zod structure but FAILS domain guardrails', () => {
      const proposal = {
        action: 'retry',
        retryDelayDays: 1,
        timeSlot: '14:00',
        confidence: 0.85,
      };

      // Zod accepts shape
      const zodRes = validateProposalStructure(proposal);
      assert.equal(zodRes.success, true);

      // Guardrail rejects 5th attempt (attemptsUsed = 4)
      const guardrailRes = evaluateGuardrails(proposal, {
        mandate: { status: 'pending', contact_consent: true },
        failure: { category: 'soft', retryEligible: true },
        attemptsUsed: 4,
      });
      assert.equal(guardrailRes.allowed, false);
      assert.equal(guardrailRes.finalAction, 'stand_down');
      assert.ok(guardrailRes.reasons.some((r) => r.includes('Maximum recovery attempts')));
    });

    it('past dispatchTime PASSES Zod structure but FAILS domain guardrails', () => {
      const proposal = {
        action: 'retry',
        retryDelayDays: 1,
        dispatchTime: '2020-01-01T14:00:00+05:30',
        confidence: 0.85,
      };

      const zodRes = validateProposalStructure(proposal);
      assert.equal(zodRes.success, true);

      const guardrailRes = evaluateGuardrails(proposal, {
        mandate: { status: 'pending', contact_consent: true },
        failure: { category: 'soft', retryEligible: true },
        attemptsUsed: 1,
        currentTime: '2026-01-01T10:00:00+05:30',
      });
      assert.equal(guardrailRes.allowed, false);
      assert.ok(guardrailRes.reasons.some((r) => r.includes('Past dispatch time rejected')));
    });

    it('insufficient pre-debit notice gap PASSES Zod structure but FAILS domain guardrails', () => {
      const proposal = {
        action: 'retry',
        retryDelayDays: 1,
        dispatchTime: '2026-05-10T14:00:00+05:30',
        confidence: 0.85,
      };

      const zodRes = validateProposalStructure(proposal);
      assert.equal(zodRes.success, true);

      // Notice was sent only 2 hours before dispatch (must be >= 24h)
      const guardrailRes = evaluateGuardrails(proposal, {
        mandate: { status: 'pending', contact_consent: true },
        failure: { category: 'soft', retryEligible: true },
        attemptsUsed: 1,
        preDebitNoticeTime: '2026-05-10T12:00:00+05:30',
      });
      assert.equal(guardrailRes.allowed, false);
      assert.ok(guardrailRes.reasons.some((r) => r.includes('Pre-debit notice gap violation')));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 3: Deterministic Fallbacks & Separate Outcome Logging
  // ═══════════════════════════════════════════════════════════════════════════

  describe('3. Deterministic Fallbacks & Separate Outcome Logging', () => {
    it('deterministic fallback schedules non-peak slot (14:00) with >=24h notice gap and passes guardrails', () => {
      const fallback = generateDeterministicFallback({
        attemptsUsed: 1,
        category: 'soft',
        retryEligible: true,
        failureCategory: 'schema_validation_failure',
      });

      assert.equal(fallback.action, 'retry');
      assert.equal(fallback.retryDelayDays, 2);
      assert.equal(fallback.timeSlot, '14:00');
      assert.equal(fallback.source, 'fallback');
      assert.equal(fallback.failureCategory, 'schema_validation_failure');

      // Crucial: Fallback must itself pass domain guardrails!
      const guardrailRes = evaluateGuardrails(fallback, {
        mandate: { status: 'pending', contact_consent: true },
        failure: { category: 'soft', retryEligible: true },
        attemptsUsed: 1,
      });
      assert.equal(guardrailRes.allowed, true);
      assert.equal(guardrailRes.finalAction, 'retry');
    });

    it('deterministic fallback escalates to stand_down when attempt cap reached', () => {
      const fallback = generateDeterministicFallback({
        attemptsUsed: 4,
        category: 'soft',
        retryEligible: true,
        failureCategory: 'schema_validation_failure',
      });

      assert.equal(fallback.action, 'stand_down');
      assert.ok(fallback.reasoning.includes('attempt ceiling'));

      const guardrailRes = evaluateGuardrails(fallback, {
        mandate: { status: 'pending', contact_consent: true },
        failure: { category: 'soft', retryEligible: true },
        attemptsUsed: 4,
      });
      assert.equal(guardrailRes.allowed, true);
      assert.equal(guardrailRes.finalAction, 'stand_down');
    });

    it('deterministic fallback escalates on hard decline', () => {
      const fallback = generateDeterministicFallback({
        attemptsUsed: 1,
        category: 'hard',
        retryEligible: false,
        failureCategory: 'schema_validation_failure',
      });

      assert.equal(fallback.action, 'stand_down');
    });

    it('smartAgent falls back deterministically when mock LLM returns malformed data without throwing', async () => {
      // Mock LLM returning malformed string
      setMockLLMHandler(() => 'MALFORMED_NON_JSON_RESPONSE{{{');

      const mandate = {
        id: 'test-man-phase3',
        mandate_id: 'MAN-P3-001',
        amount: 2500,
        status: 'pending',
        attempts_used: 1,
        income_day_of_month: 5,
        balance_volatility: 0.2,
      };
      const failure = {
        code: 'INSUFFICIENT_FUNDS',
        category: 'soft',
        retryEligible: true,
      };

      const result = await proposeSmartRecoveryAction({
        mandate,
        failure,
        attemptsUsed: 1,
      });

      assert.ok(result);
      assert.equal(result.source, 'fallback');
      assert.equal(result.action, 'retry');
      assert.equal(result.timeSlot, '14:00');
      assert.equal(result.retryDelayDays, 2);
      assert.equal(result.failureCategory, 'schema_validation_failure');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 4: Gemini Fuzz Testing (Mocked LLM via fast-check)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('4. Gemini Fuzz Testing (Mocked LLM, Zero API calls)', () => {
    it('verifies mock LLM mode is active and no real Gemini calls are made', () => {
      assert.equal(getLLMMode(), 'mock');
    });

    it('fuzz testing: all malformed variations produce valid action or fallback without throwing', async () => {
      const malformedPayloads = [
        // 1. Wrong types
        { action: 12345, retryDelayDays: 'two' },
        { action: 'retry', confidence: 'very_confident' },
        { action: 'retry', delayDays: [1, 2, 3] },
        // 2. Missing fields
        {},
        { retryDelayDays: 2 },
        { reasoning: 'Just trying' },
        // 3. Extra fields
        { action: 'retry', retryDelayDays: 2, unexpectedField: true, sql: 'SELECT * FROM mandates' },
        // 4. Negative values
        { action: 'retry', retryDelayDays: -1, confidence: -0.5 },
        // 5. Invalid dates
        { action: 'retry', retryDelayDays: 1, dispatchTime: 'invalid-date-string' },
        // 6. Peak slots
        { action: 'retry', retryDelayDays: 1, timeSlot: '11:30' },
        { action: 'retry', retryDelayDays: 1, timeSlot: '18:00' },
        // 7. Past dates
        { action: 'retry', retryDelayDays: 1, dispatchTime: '2021-01-01T12:00:00Z' },
        // 8. 5th attempt scenario
        { action: 'retry', retryDelayDays: 2, timeSlot: '14:00' },
        // 9. Injection strings
        { action: 'DROP TABLE mandates;--', reasoning: '<script>alert("xss")</script>' },
        // 10. Prototype pollution attempts
        JSON.parse('{"action":"retry","__proto__":{"polluted":true}}'),
        JSON.parse('{"action":"retry","constructor":{"prototype":{"polluted":true}}}'),
        // 11. Arbitrary unexpected objects
        null,
        [],
        'PLAIN_TEXT_RESPONSE',
        { deep: { nested: { object: 1 } } },
        { action: 'retry', discountPercent: 9999 },
      ];

      for (const payload of malformedPayloads) {
        setMockLLMHandler(() => (typeof payload === 'string' ? payload : JSON.stringify(payload)));

        const mandate = {
          id: 'fuzz-man-1',
          mandate_id: 'MAN-FUZZ-01',
          status: 'pending',
          amount: 1500,
          attempts_used: payload?.action === 'retry' && malformedPayloads.indexOf(payload) === 7 ? 4 : 1,
          income_day_of_month: 10,
          balance_volatility: 0.3,
          contact_consent: true,
        };

        const failure = {
          code: 'GENERIC_DECLINE',
          category: 'soft',
          retryEligible: true,
        };

        // Must never throw unhandled exception
        let proposed;
        try {
          proposed = await proposeSmartRecoveryAction({
            mandate,
            failure,
            attemptsUsed: mandate.attempts_used,
          });
        } catch (err) {
          assert.fail(`proposeSmartRecoveryAction threw unhandled exception: ${err.message}`);
        }

        // Run through normal guardrail evaluation
        const guardrailRes = evaluateGuardrails(proposed, {
          mandate,
          failure,
          attemptsUsed: mandate.attempts_used,
        });

        // Must produce either a guardrail-approved action or fallback escalation
        assert.ok(['retry', 'stand_down', 'human_review'].includes(guardrailRes.finalAction));
        assert.ok(guardrailRes.reasons !== undefined);
      }
    });

    it('property-based fuzzing with fast-check over random JSON values', async () => {
      await fc.assert(
        fc.asyncProperty(fc.jsonValue(), async (randomVal) => {
          setMockLLMHandler(() => JSON.stringify(randomVal));

          const mandate = {
            id: 'fc-mandate',
            mandate_id: 'MAN-FC-01',
            status: 'pending',
            amount: 2000,
            attempts_used: 1,
            income_day_of_month: 15,
            balance_volatility: 0.1,
            contact_consent: true,
          };
          const failure = {
            code: 'INSUFFICIENT_FUNDS',
            category: 'soft',
            retryEligible: true,
          };

          let proposed;
          try {
            proposed = await proposeSmartRecoveryAction({
              mandate,
              failure,
              attemptsUsed: 1,
            });
          } catch (err) {
            assert.fail(`proposeSmartRecoveryAction threw unhandled exception: ${err.message}`);
          }

          // Must return structured object, never null/undefined
          assert.ok(proposed && typeof proposed === 'object');
          assert.ok(['retry', 'stand_down', 'human_review'].includes(proposed.action));

          // Guardrail evaluation must never throw
          const evaluated = evaluateGuardrails(proposed, { mandate, failure, attemptsUsed: 1 });
          assert.ok(['retry', 'stand_down', 'human_review'].includes(evaluated.finalAction));
        }),
        { numRuns: 50 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 5: Razorpay Webhook Hardening & Verification
  // ═══════════════════════════════════════════════════════════════════════════

  describe('5. Razorpay Webhook Boundary Hardening', () => {
    it('valid signed webhook is accepted, verified, and stored', async () => {
      const eventId = `evt_p3_harden_valid_${Date.now()}`;
      createdWebhookEventIds.add(eventId);

      const payload = {
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: 'pay_p3_001',
              amount: 150000,
              status: 'failed',
            },
          },
        },
      };

      const { rawBody, signature } = buildSignedWebhook(payload);

      const res = await postWebhook(baseUrl, rawBody, {
        'x-razorpay-signature': signature,
        'x-razorpay-event-id': eventId,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.received, true);
      assert.equal(res.body.duplicate, false);
      assert.equal(res.body.event_id, eventId);
      assert.equal(res.body.event_type, 'payment.failed');
      assert.ok(res.body.webhook_event_id);

      // Verify row exists in webhook_events
      const { data: rows } = await supabase
        .from('webhook_events')
        .select('*')
        .eq('event_id', eventId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].signature_verified, true);
    });

    it('invalid signature produces 401 and ZERO database side effects', async () => {
      const eventId = `evt_p3_harden_badsig_${Date.now()}`;
      createdWebhookEventIds.add(eventId);

      const payload = { event: 'payment.failed' };
      const { rawBody } = buildSignedWebhook(payload);

      const badSig = crypto
        .createHmac('sha256', 'completely_wrong_secret')
        .update(rawBody)
        .digest('hex');

      const res = await postWebhook(baseUrl, rawBody, {
        'x-razorpay-signature': badSig,
        'x-razorpay-event-id': eventId,
      });

      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'Signature verification failed');

      // Verify ZERO rows in webhook_events
      const { data: rows } = await supabase
        .from('webhook_events')
        .select('id')
        .eq('event_id', eventId);
      assert.equal(rows.length, 0, 'No DB row must be created on invalid signature');
    });

    it('duplicate delivery is a no-op returning 200 with duplicate: true', async () => {
      const eventId = `evt_p3_harden_dedup_${Date.now()}`;
      createdWebhookEventIds.add(eventId);

      const payload = { event: 'payment.failed', test: 'dedup' };
      const { rawBody, signature } = buildSignedWebhook(payload);
      const headers = {
        'x-razorpay-signature': signature,
        'x-razorpay-event-id': eventId,
      };

      // 1. First delivery
      const res1 = await postWebhook(baseUrl, rawBody, headers);
      assert.equal(res1.status, 200);
      assert.equal(res1.body.duplicate, false);

      // 2. Same event ID replay
      const res2 = await postWebhook(baseUrl, rawBody, headers);
      assert.equal(res2.status, 200);
      assert.equal(res2.body.duplicate, true);

      // 3. DB has exactly one row
      const { data: rows } = await supabase
        .from('webhook_events')
        .select('id')
        .eq('event_id', eventId);
      assert.equal(rows.length, 1);
    });

    it('re-serialized payload with different whitespace MUST fail raw-body signature verification', async () => {
      const eventId = `evt_p3_harden_ws_${Date.now()}`;
      createdWebhookEventIds.add(eventId);

      // Payload A: compact serialization (which the client supposedly signed)
      const compactBody = Buffer.from('{"event":"payment.failed","amount":100}', 'utf8');
      const validSigForCompact = crypto
        .createHmac('sha256', TEST_SECRET)
        .update(compactBody)
        .digest('hex');

      // Payload B: same semantic JSON but different whitespace
      const formattedBody = Buffer.from('{\n  "event": "payment.failed",\n  "amount": 100\n}', 'utf8');

      // Sending formattedBody with validSigForCompact must FAIL because raw bytes differ
      const res = await postWebhook(baseUrl, formattedBody, {
        'x-razorpay-signature': validSigForCompact,
        'x-razorpay-event-id': eventId,
      });

      assert.equal(res.status, 401, 'Re-serialized payload with whitespace difference must fail signature verification');
      assert.equal(res.body.error, 'Signature verification failed');

      // Verify no DB changes
      const { data: rows } = await supabase
        .from('webhook_events')
        .select('id')
        .eq('event_id', eventId);
      assert.equal(rows.length, 0);
    });

    it('unknown event type returns 200/no-op with ignored: true and creates zero recovery effects', async () => {
      const eventId = `evt_p3_harden_unknown_${Date.now()}`;
      createdWebhookEventIds.add(eventId);

      const payload = {
        event: 'custom.unsupported.notification',
        data: { foo: 'bar' },
      };
      const { rawBody, signature } = buildSignedWebhook(payload);

      const res = await postWebhook(baseUrl, rawBody, {
        'x-razorpay-signature': signature,
        'x-razorpay-event-id': eventId,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.received, true);
      assert.equal(res.body.ignored, true);
      assert.equal(res.body.event_type, 'custom.unsupported.notification');
      assert.ok(res.body.message.includes('zero recovery side effects'));
    });

    it('failed processing transaction rollback: no partial effect remains', async () => {
      const eventId = `evt_p3_harden_rollback_${Date.now()}`;
      createdWebhookEventIds.add(eventId);

      // Register an effect handler that fails mid-flight
      setWebhookEffectHandler(async () => {
        throw new Error('Simulated atomic effect processing failure');
      });

      const payload = {
        event: 'payment.failed',
        payload: { payment: { entity: { id: 'pay_fail_tx' } } },
      };
      const { rawBody, signature } = buildSignedWebhook(payload);

      const res = await postWebhook(baseUrl, rawBody, {
        'x-razorpay-signature': signature,
        'x-razorpay-event-id': eventId,
      });

      // Must return 500 indicating rollback
      assert.equal(res.status, 500);
      assert.ok(res.body.error.includes('transaction rolled back'));

      // Check DB: webhook_events record must have been rolled back / cleaned up!
      const { data: rows } = await supabase
        .from('webhook_events')
        .select('id')
        .eq('event_id', eventId);
      assert.equal(rows.length, 0, 'Rolled back event must have zero rows in webhook_events');
    });

    it('sandbox isolation: webhook processing NEVER writes to mandates, attempts, or simulation_runs', async () => {
      const eventId = `evt_p3_isolation_${Date.now()}`;
      createdWebhookEventIds.add(eventId);

      // Create test run and mandate
      const { data: testRun } = await supabase
        .from('simulation_runs')
        .insert({ random_seed: 88888, max_days: 10, current_day: 1, status: 'running' })
        .select()
        .single();

      const { data: testMandate } = await supabase
        .from('mandates')
        .insert({
          run_id: testRun.id,
          mandate_id: `ISO-MAN-${Date.now()}`,
          amount: 2500,
          income_day_of_month: 10,
          balance_volatility: 0.2,
          contact_consent: true,
          experiment_arm: 'smart',
          status: 'pending',
          first_due_day: 1,
          next_action: 'retry',
          next_action_day: 2,
          attempts_used: 1,
          created_day: 0,
        })
        .select()
        .single();

      // Snapshot before webhook
      const [beforeRun, beforeMandate, beforeAttempts] = await Promise.all([
        supabase.from('simulation_runs').select('*').eq('id', testRun.id).single(),
        supabase.from('mandates').select('*').eq('id', testMandate.id).single(),
        supabase.from('attempts').select('*').eq('mandate_id', testMandate.id),
      ]);

      const payload = {
        event: 'payment.failed',
        payload: { payment: { entity: { id: 'pay_isolated_1' } } },
      };
      const { rawBody, signature } = buildSignedWebhook(payload);

      await postWebhook(baseUrl, rawBody, {
        'x-razorpay-signature': signature,
        'x-razorpay-event-id': eventId,
      });

      // Snapshot after webhook
      const [afterRun, afterMandate, afterAttempts] = await Promise.all([
        supabase.from('simulation_runs').select('*').eq('id', testRun.id).single(),
        supabase.from('mandates').select('*').eq('id', testMandate.id).single(),
        supabase.from('attempts').select('*').eq('mandate_id', testMandate.id),
      ]);

      assert.deepEqual(afterRun.data, beforeRun.data, 'Webhook must not modify simulation_runs');
      assert.deepEqual(afterMandate.data, beforeMandate.data, 'Webhook must not modify mandates');
      assert.equal(afterAttempts.data.length, beforeAttempts.data.length, 'Webhook must not create attempts');

      // Cleanup test records
      try {
        await supabase.from('mandates').delete().eq('id', testMandate.id);
        await supabase.from('simulation_runs').delete().eq('id', testRun.id);
      } catch (_) {}
    });
  });
});
