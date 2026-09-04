// tests/step13.test.js
//
// Unit tests for Step 13: Smart AI Decision Layer (proposeSmartRecoveryAction).
//
// All tests are OFFLINE — they mock the network boundary using a module-level
// fetch override so that the Gemini API is never called during the test run.
//
// Test structure:
//   1. Input validation
//   2. AI success path (mocked good JSON response)
//   3. AI failure / timeout path (falls back to heuristic)
//   4. Safety guardrails applied to AI proposals
//   5. Fallback heuristic correctness
//   6. GEMINI_API_KEY security (key must not appear in output)

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum valid input set for a soft failure with 1 attempt used. */
function validInput(overrides = {}) {
  return {
    mandateId: 'a1b2c3d4-0000-0000-0000-000000000001',
    attemptsUsed: 1,
    maxAttempts: 4,
    amount: 1500,
    balanceVolatility: 0.3,
    category: 'soft',
    retryEligible: true,
    declineCode: 'SIM_SOFT_001',
    ...overrides,
  };
}

/**
 * Build a minimal mock fetch that returns a Gemini-shaped response containing
 * the supplied JSON payload as the candidate text.
 *
 * @param {object} payload  - The JSON the "AI" should propose
 * @param {number} [status=200]
 */
function makeMockFetch(payload, status = 200) {
  return async (_url, _opts) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [{ text: JSON.stringify(payload) }],
          },
        },
      ],
    }),
  });
}

/** Mock fetch that simulates a network timeout by throwing AbortError. */
function makeTimeoutFetch() {
  return async (_url, { signal } = {}) => {
    // Simulate signal already aborted (as AbortController fires)
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    throw err;
  };
}

/** Mock fetch that throws a generic network error. */
function makeNetworkErrorFetch() {
  return async () => {
    throw new Error('fetch failed: ECONNREFUSED');
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Module import (done once; fetch is injected per-test via global override)
// ─────────────────────────────────────────────────────────────────────────────

let proposeSmartRecoveryAction;
let VALID_ACTIONS;

before(async () => {
  // Set required env vars before importing so the module can initialize
  process.env.GEMINI_API_KEY = 'TEST_KEY_REDACTED';

  const mod = await import('../src/recovery/smartAgent.js');
  proposeSmartRecoveryAction = mod.proposeSmartRecoveryAction;
  VALID_ACTIONS = mod.VALID_ACTIONS;
});

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 13 — proposeSmartRecoveryAction', () => {
  // Store original fetch so we can restore it after each test
  let _originalFetch;
  beforeEach(() => { _originalFetch = global.fetch; });
  afterEach(() => { global.fetch = _originalFetch; });

  // ─── 1. Exported contract ─────────────────────────────────────────────────

  it('1. exports VALID_ACTIONS frozen array with retry, stand_down, human_review', () => {
    assert.deepEqual([...VALID_ACTIONS].sort(), ['human_review', 'retry', 'stand_down']);
    assert.equal(Object.isFrozen(VALID_ACTIONS), true);
  });

  // ─── 2. Input validation ──────────────────────────────────────────────────

  it('2a. throws when mandateId is missing', async () => {
    await assert.rejects(
      () => proposeSmartRecoveryAction(validInput({ mandateId: '' })),
      /mandateId must be a non-empty string/
    );
  });

  it('2b. throws when attemptsUsed is negative', async () => {
    await assert.rejects(
      () => proposeSmartRecoveryAction(validInput({ attemptsUsed: -1 })),
      /attemptsUsed must be a non-negative integer/
    );
  });

  it('2c. throws when amount is out of range', async () => {
    await assert.rejects(
      () => proposeSmartRecoveryAction(validInput({ amount: 50 })),
      /amount must be a finite number in \[100, 50000\]/
    );
  });

  it('2d. throws when balanceVolatility is out of range', async () => {
    await assert.rejects(
      () => proposeSmartRecoveryAction(validInput({ balanceVolatility: 1.5 })),
      /balanceVolatility must be in \[0, 1\]/
    );
  });

  it('2e. throws when category is invalid', async () => {
    await assert.rejects(
      () => proposeSmartRecoveryAction(validInput({ category: 'medium' })),
      /category must be 'soft', 'hard', or 'unknown'/
    );
  });

  it('2f. throws when retryEligible is not a boolean', async () => {
    await assert.rejects(
      () => proposeSmartRecoveryAction(validInput({ retryEligible: 'yes' })),
      /retryEligible must be a boolean/
    );
  });

  // ─── 3. AI success path ───────────────────────────────────────────────────

  it('3a. returns AI proposal when Gemini returns valid retry JSON', async () => {
    global.fetch = makeMockFetch({ action: 'retry', retryDelayDays: 3, reasoning: 'Soft failure, try again in 3 days.' });

    const result = await proposeSmartRecoveryAction(validInput());

    assert.equal(result.action, 'retry');
    assert.equal(result.retryDelayDays, 3);
    assert.equal(result.source, 'ai');
    assert.equal(result.guardrailApplied, false);
    assert.ok(typeof result.reasoning === 'string');
  });

  it('3b. returns AI stand_down when Gemini proposes stand_down for soft failure', async () => {
    global.fetch = makeMockFetch({ action: 'stand_down', retryDelayDays: null, reasoning: 'Customer requested stop.' });

    const result = await proposeSmartRecoveryAction(validInput());

    assert.equal(result.action, 'stand_down');
    assert.equal(result.retryDelayDays, null);
    assert.equal(result.source, 'ai');
    assert.equal(result.guardrailApplied, false);
  });

  it('3c. caps reasoning at 200 characters', async () => {
    const longReasoning = 'x'.repeat(300);
    global.fetch = makeMockFetch({ action: 'retry', retryDelayDays: 2, reasoning: longReasoning });

    const result = await proposeSmartRecoveryAction(validInput());
    assert.ok(result.reasoning.length <= 200, `reasoning too long: ${result.reasoning.length}`);
  });

  // ─── 4. Fallback path ─────────────────────────────────────────────────────

  it('4a. falls back to heuristic on network timeout (AbortError)', async () => {
    global.fetch = makeTimeoutFetch();

    const result = await proposeSmartRecoveryAction(validInput({ category: 'soft', retryEligible: true, attemptsUsed: 1 }));

    assert.equal(result.source, 'fallback');
    assert.equal(result.action, 'retry');
    assert.equal(result.retryDelayDays, 2);
  });

  it('4b. falls back to heuristic on generic network error', async () => {
    global.fetch = makeNetworkErrorFetch();

    const result = await proposeSmartRecoveryAction(validInput({ category: 'soft', retryEligible: true, attemptsUsed: 1 }));

    assert.equal(result.source, 'fallback');
    assert.equal(result.action, 'retry');
  });

  it('4c. falls back when Gemini returns HTTP 500', async () => {
    global.fetch = makeMockFetch({}, 500);

    const result = await proposeSmartRecoveryAction(validInput());
    assert.equal(result.source, 'fallback');
  });

  it('4d. falls back when Gemini response is not JSON', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Sorry, I cannot help.' }] } }],
      }),
    });

    const result = await proposeSmartRecoveryAction(validInput());
    assert.equal(result.source, 'fallback');
  });

  it('4e. fallback stand_down when attempts exhausted', async () => {
    global.fetch = makeNetworkErrorFetch();

    // attemptsUsed >= maxAttempts → stand_down
    const result = await proposeSmartRecoveryAction(validInput({ attemptsUsed: 4, maxAttempts: 4 }));

    assert.equal(result.source, 'fallback');
    assert.equal(result.action, 'stand_down');
    assert.equal(result.retryDelayDays, null);
  });

  // ─── 5. Safety guardrails ─────────────────────────────────────────────────

  it('5a. guardrail rejects AI retry for hard failure → stand_down', async () => {
    // AI incorrectly proposes retry for a hard failure
    global.fetch = makeMockFetch({ action: 'retry', retryDelayDays: 2, reasoning: 'Worth a try.' });

    const result = await proposeSmartRecoveryAction(validInput({
      category: 'hard',
      retryEligible: false,
    }));

    assert.equal(result.action, 'stand_down');
    assert.equal(result.retryDelayDays, null);
    assert.equal(result.guardrailApplied, true);
  });

  it('5b. guardrail rejects AI retry for unknown failure → stand_down', async () => {
    global.fetch = makeMockFetch({ action: 'retry', retryDelayDays: 1, reasoning: 'Maybe retry.' });

    const result = await proposeSmartRecoveryAction(validInput({
      category: 'unknown',
      retryEligible: false,
    }));

    assert.equal(result.action, 'stand_down');
    assert.equal(result.guardrailApplied, true);
  });

  it('5c. guardrail rejects unknown action → stand_down', async () => {
    global.fetch = makeMockFetch({ action: 'delete_mandate', retryDelayDays: null, reasoning: 'Clean up.' });

    const result = await proposeSmartRecoveryAction(validInput());

    assert.equal(result.action, 'stand_down');
    assert.equal(result.guardrailApplied, true);
  });

  it('5d. guardrail coerces out-of-range retryDelayDays to safe default (2)', async () => {
    // AI proposes retry with 99-day delay (exceeds MAX_RETRY_DELAY_DAYS)
    global.fetch = makeMockFetch({ action: 'retry', retryDelayDays: 99, reasoning: 'Long wait.' });

    const result = await proposeSmartRecoveryAction(validInput({ category: 'soft', retryEligible: true }));

    assert.equal(result.action, 'retry');
    assert.ok(result.retryDelayDays >= 1 && result.retryDelayDays <= 7,
      `retryDelayDays out of safe range: ${result.retryDelayDays}`);
  });

  it('5e. guardrail sets retryDelayDays to null when action is stand_down', async () => {
    global.fetch = makeMockFetch({ action: 'stand_down', retryDelayDays: 3, reasoning: 'Should not retry.' });

    const result = await proposeSmartRecoveryAction(validInput());

    assert.equal(result.action, 'stand_down');
    assert.equal(result.retryDelayDays, null);
  });

  // ─── 6. Return shape ──────────────────────────────────────────────────────

  it('6a. result always has action, retryDelayDays, reasoning, source, guardrailApplied', async () => {
    global.fetch = makeMockFetch({ action: 'retry', retryDelayDays: 2, reasoning: 'OK.' });

    const result = await proposeSmartRecoveryAction(validInput());

    assert.ok('action' in result, 'missing: action');
    assert.ok('retryDelayDays' in result, 'missing: retryDelayDays');
    assert.ok('reasoning' in result, 'missing: reasoning');
    assert.ok('source' in result, 'missing: source');
    assert.ok('guardrailApplied' in result, 'missing: guardrailApplied');
  });

  it('6b. source is one of "ai" | "fallback"', async () => {
    global.fetch = makeMockFetch({ action: 'retry', retryDelayDays: 1, reasoning: 'Good.' });

    const result = await proposeSmartRecoveryAction(validInput());

    assert.ok(['ai', 'fallback'].includes(result.source), `unexpected source: ${result.source}`);
  });

  // ─── 7. Security: key must not leak ───────────────────────────────────────

  it('7a. API key does not appear in the returned proposal object', async () => {
    global.fetch = makeMockFetch({ action: 'retry', retryDelayDays: 2, reasoning: 'OK.' });

    const result = await proposeSmartRecoveryAction(validInput());
    const serialized = JSON.stringify(result);

    const key = process.env.GEMINI_API_KEY || '';
    assert.ok(!serialized.includes(key), 'GEMINI_API_KEY leaked into result object');
  });

  it('7b. API key does not appear in fallback result object', async () => {
    global.fetch = makeNetworkErrorFetch();

    const result = await proposeSmartRecoveryAction(validInput());
    const serialized = JSON.stringify(result);

    const key = process.env.GEMINI_API_KEY || '';
    assert.ok(!serialized.includes(key), 'GEMINI_API_KEY leaked into fallback result');
  });
});
