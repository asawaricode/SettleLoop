// tests/step14.test.js
//
// Unit tests for Step 14: Guardrails (validateGuardrails).
//
// All tests are pure, isolated, and deterministic. No database or external calls.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateGuardrails,
  evaluateGuardrails,
  applyGuardrails,
  MAX_GUARDRAIL_ATTEMPTS,
  MAX_DELAY_DAYS,
  CONFIDENCE_THRESHOLD,
  GUARDRAIL_ACTIONS,
  SUPPORTED_CHANNELS,
} from '../src/recovery/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Fixture Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createValidContext(overrides = {}) {
  const { mandate: mandateOverrides, failure: failureOverrides, ...restOverrides } = overrides;
  return {
    mandate: {
      id: 'm-12345',
      status: 'pending',
      attempts_used: 1,
      contact_consent: true,
      amount: 2500,
      ...mandateOverrides,
    },
    failure: {
      category: 'soft',
      retryEligible: true,
      declineCode: 'SIM_SOFT_001',
      ...failureOverrides,
    },
    ...restOverrides,
  };
}

function createValidRetryProposal(overrides = {}) {
  return {
    action: 'retry',
    delayDays: 2,
    channel: 'auto_debit',
    discountPercent: 0,
    confidence: 0.85,
    reasoning: 'Soft decline, retry in 2 days via auto_debit.',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 14 Test Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 14 — Guardrails', () => {
  // 1. valid retry → allowed
  it('1. valid retry → allowed', () => {
    const proposal = createValidRetryProposal();
    const context = createValidContext();

    const result = validateGuardrails({ proposal, context });

    assert.equal(result.allowed, true);
    assert.equal(result.action, 'retry');
    assert.deepEqual(result.reasons, []);
  });

  // 2. valid stand_down → allowed
  it('2. valid stand_down → allowed', () => {
    const proposal = {
      action: 'stand_down',
      reasoning: 'Stand down requested.',
      confidence: 0.9,
    };
    const context = createValidContext();

    const result = validateGuardrails({ proposal, context });

    assert.equal(result.allowed, true);
    assert.equal(result.action, 'stand_down');
    assert.deepEqual(result.reasons, []);
  });

  // 3. valid human_review → allowed
  it('3. valid human_review → allowed', () => {
    const proposal = {
      action: 'human_review',
      reasoning: 'Complex edge case needs manual operator.',
    };
    const context = createValidContext();

    const result = validateGuardrails({ proposal, context });

    assert.equal(result.allowed, true);
    assert.equal(result.action, 'human_review');
    assert.deepEqual(result.reasons, []);
  });

  // 4. retry blocked at attempts_used >= 4
  it('4. retry blocked at attempts_used >= 4', () => {
    const proposal = createValidRetryProposal();
    const context = createValidContext({ mandate: { attempts_used: 4 } });

    const result = validateGuardrails({ proposal, context });

    assert.equal(result.allowed, false);
    assert.equal(result.action, 'stand_down');
    assert.ok(result.reasons.some((r) => r.includes('Maximum recovery attempts')));
  });

  // 5. retry blocked for hard failure
  it('5. retry blocked for hard failure', () => {
    const proposal = createValidRetryProposal();
    const context = createValidContext({
      failure: { category: 'hard', retryEligible: false },
    });

    const result = validateGuardrails({ proposal, context });

    assert.equal(result.allowed, false);
    assert.equal(result.action, 'stand_down');
    assert.ok(result.reasons.some((r) => r.includes("category must be 'soft'")));
  });

  // 6. retry blocked for unknown failure
  it('6. retry blocked for unknown failure', () => {
    const proposal = createValidRetryProposal();
    const context = createValidContext({
      failure: { category: 'unknown', retryEligible: false },
    });

    const result = validateGuardrails({ proposal, context });

    assert.equal(result.allowed, false);
    assert.equal(result.action, 'stand_down');
    assert.ok(result.reasons.some((r) => r.includes("category must be 'soft'")));
  });

  // 7. retry blocked when retryEligible === false
  it('7. retry blocked when retryEligible === false', () => {
    const proposal = createValidRetryProposal();
    const context = createValidContext({
      failure: { category: 'soft', retryEligible: false },
    });

    const result = validateGuardrails({ proposal, context });

    assert.equal(result.allowed, false);
    assert.equal(result.action, 'stand_down');
    assert.ok(result.reasons.some((r) => r.includes('retryEligible === false')));
  });

  // 8. retry with confidence < 0.70 → human_review
  it('8. retry with confidence < 0.70 → human_review', () => {
    const proposal = createValidRetryProposal({ confidence: 0.65 });
    const context = createValidContext();

    const result = validateGuardrails({ proposal, context });

    assert.equal(result.allowed, false);
    assert.equal(result.action, 'human_review');
    assert.ok(result.reasons.some((r) => r.includes('below conservative threshold')));
  });

  // 9. attempts_used >= 4 + confidence < 0.70 simultaneously → stand_down, NOT human_review
  it('9. attempts_used >= 4 + confidence < 0.70 simultaneously → stand_down, NOT human_review', () => {
    const proposal = createValidRetryProposal({ confidence: 0.5 });
    const context = createValidContext({ mandate: { attempts_used: 4 } });

    const result = validateGuardrails({ proposal, context });

    assert.equal(result.allowed, false);
    assert.equal(result.action, 'stand_down');
    // Both reasons must be present
    assert.ok(result.reasons.some((r) => r.includes('Maximum recovery attempts')));
    assert.ok(result.reasons.some((r) => r.includes('below conservative threshold')));
  });

  // 10. negative delay rejected
  it('10. negative delay rejected', () => {
    const proposal = createValidRetryProposal({ delayDays: -1 });
    const context = createValidContext();

    const result = validateGuardrails({ proposal, context });

    assert.equal(result.allowed, false);
    assert.equal(result.action, 'stand_down');
    assert.ok(result.reasons.some((r) => r.includes('Invalid delayDays')));
  });

  // 11. non-integer delay rejected
  it('11. non-integer delay rejected', () => {
    const proposal = createValidRetryProposal({ delayDays: 2.5 });
    const context = createValidContext();

    const result = validateGuardrails({ proposal, context });

    assert.equal(result.allowed, false);
    assert.equal(result.action, 'stand_down');
    assert.ok(result.reasons.some((r) => r.includes('Invalid delayDays')));
  });

  // 12. delay > 7 rejected
  it('12. delay > 7 rejected', () => {
    const proposal = createValidRetryProposal({ delayDays: 8 });
    const context = createValidContext();

    const result = validateGuardrails({ proposal, context });

    assert.equal(result.allowed, false);
    assert.equal(result.action, 'stand_down');
    assert.ok(result.reasons.some((r) => r.includes('Invalid delayDays')));
  });

  // 13. valid delay accepted
  it('13. valid delay accepted', () => {
    for (const delay of [0, 1, 3, 7]) {
      const proposal = createValidRetryProposal({ delayDays: delay });
      const context = createValidContext();
      const result = validateGuardrails({ proposal, context });
      assert.equal(result.allowed, true, `delay ${delay} should be allowed`);
      assert.equal(result.action, 'retry');
    }
  });

  // 14. invalid channel rejected
  it('14. invalid channel rejected', () => {
    for (const invalidChannel of ['whatsapp', 'sms', '', null, undefined]) {
      const proposal = createValidRetryProposal({ channel: invalidChannel });
      const context = createValidContext();
      const result = validateGuardrails({ proposal, context });
      assert.equal(result.allowed, false, `channel ${invalidChannel} should be rejected`);
      assert.equal(result.action, 'stand_down');
      assert.ok(result.reasons.some((r) => r.includes('channel')));
    }
  });

  // 15. payment_link without contact consent → human_review
  it('15. payment_link without contact consent → human_review', () => {
    const proposal = createValidRetryProposal({ channel: 'payment_link' });
    const context = createValidContext({ mandate: { contact_consent: false } });

    const result = validateGuardrails({ proposal, context });

    assert.equal(result.allowed, false);
    assert.equal(result.action, 'human_review');
    assert.ok(result.reasons.some((r) => r.includes('contact consent is false')));
  });

  // 16. auto_debit without contact consent remains allowed when all other rules pass
  it('16. auto_debit without contact consent remains allowed when all other rules pass', () => {
    const proposal = createValidRetryProposal({ channel: 'auto_debit' });
    const context = createValidContext({ mandate: { contact_consent: false } });

    const result = validateGuardrails({ proposal, context });

    assert.equal(result.allowed, true);
    assert.equal(result.action, 'retry');
    assert.deepEqual(result.reasons, []);
  });

  // 17. invalid discount rejected
  it('17. invalid discount rejected', () => {
    for (const invalidDiscount of [-5, 105, '10%', NaN, null]) {
      const proposal = createValidRetryProposal({ discountPercent: invalidDiscount });
      const context = createValidContext();
      const result = validateGuardrails({ proposal, context });
      assert.equal(result.allowed, false, `discount ${invalidDiscount} should be rejected`);
      assert.equal(result.action, 'stand_down');
      assert.ok(result.reasons.some((r) => r.includes('Invalid discountPercent')));
    }
  });

  // 18. discount 0 accepted
  it('18. discount 0 accepted', () => {
    const proposal = createValidRetryProposal({ discountPercent: 0 });
    const context = createValidContext();

    const result = validateGuardrails({ proposal, context });

    assert.equal(result.allowed, true);
    assert.equal(result.action, 'retry');
  });

  // 19. discount 100 accepted
  it('19. discount 100 accepted', () => {
    const proposal = createValidRetryProposal({ discountPercent: 100 });
    const context = createValidContext();

    const result = validateGuardrails({ proposal, context });

    assert.equal(result.allowed, true);
    assert.equal(result.action, 'retry');
  });

  // 20. invalid confidence rejected
  it('20. invalid confidence rejected', () => {
    for (const invalidConf of [-0.1, 1.1, '0.8', NaN, undefined]) {
      const proposal = createValidRetryProposal({ confidence: invalidConf });
      const context = createValidContext();
      const result = validateGuardrails({ proposal, context });
      assert.equal(result.allowed, false, `confidence ${invalidConf} should be rejected`);
      assert.equal(result.action, 'stand_down');
      assert.ok(result.reasons.some((r) => r.includes('confidence')));
    }
  });

  // 21. confidence 0 accepted as valid input but retry becomes human_review
  it('21. confidence 0 accepted as valid input but retry becomes human_review', () => {
    const proposal = createValidRetryProposal({ confidence: 0 });
    const context = createValidContext();

    const result = validateGuardrails({ proposal, context });

    assert.equal(result.allowed, false);
    assert.equal(result.action, 'human_review');
    assert.ok(result.reasons.some((r) => r.includes('below conservative threshold')));
  });

  // 22. confidence 1 accepted
  it('22. confidence 1 accepted', () => {
    const proposal = createValidRetryProposal({ confidence: 1 });
    const context = createValidContext();

    const result = validateGuardrails({ proposal, context });

    assert.equal(result.allowed, true);
    assert.equal(result.action, 'retry');
    assert.deepEqual(result.reasons, []);
  });

  // 23. invalid action → stand_down
  it('23. invalid action → stand_down', () => {
    for (const invalidAction of ['escalate', 'terminate', '', 'retry_now', null, undefined]) {
      const proposal = createValidRetryProposal({ action: invalidAction });
      const context = createValidContext();
      const result = validateGuardrails({ proposal, context });
      assert.equal(result.allowed, false);
      assert.equal(result.action, 'stand_down');
      assert.ok(result.reasons.some((r) => r.includes('Invalid or unsupported action')));
    }
  });

  // 24. terminal mandate state rejected
  it('24. terminal mandate state rejected', () => {
    for (const terminalStatus of ['recovered', 'stood_down', 'exhausted']) {
      const proposal = createValidRetryProposal();
      const context = createValidContext({ mandate: { status: terminalStatus } });
      const result = validateGuardrails({ proposal, context });
      assert.equal(result.allowed, false, `status ${terminalStatus} should be rejected`);
      assert.equal(result.action, 'stand_down');
      assert.ok(result.reasons.some((r) => r.includes("status must be 'pending'")));
    }
  });

  // 25. pending_human_approval rejected
  it('25. pending_human_approval rejected', () => {
    const proposal = createValidRetryProposal();
    const context = createValidContext({ mandate: { status: 'pending_human_approval' } });

    const result = validateGuardrails({ proposal, context });

    assert.equal(result.allowed, false);
    assert.equal(result.action, 'stand_down');
    assert.ok(result.reasons.some((r) => r.includes("status must be 'pending'")));
  });

  // 26. reasons[] contains all triggered rules
  it('26. reasons[] contains all triggered rules', () => {
    const proposal = createValidRetryProposal({
      delayDays: 10, // timing violation
      channel: 'invalid_channel', // channel violation
      discountPercent: -20, // discount violation
      confidence: 0.3, // uncertainty violation
    });
    const context = createValidContext({
      mandate: {
        status: 'recovered', // mandate state violation
        attempts_used: 4, // max attempts violation
      },
      failure: {
        category: 'hard', // category violation
        retryEligible: false, // eligibility violation
      },
    });

    const result = validateGuardrails({ proposal, context });

    assert.equal(result.allowed, false);
    assert.equal(result.action, 'stand_down');
    // Check that every distinct rule triggered is present in reasons
    assert.ok(result.reasons.length >= 7, `Expected at least 7 reasons, got ${result.reasons.length}`);
    assert.ok(result.reasons.some((r) => r.includes('status must be')));
    assert.ok(result.reasons.some((r) => r.includes('Maximum recovery attempts')));
    assert.ok(result.reasons.some((r) => r.includes("category must be 'soft'")));
    assert.ok(result.reasons.some((r) => r.includes('retryEligible === false')));
    assert.ok(result.reasons.some((r) => r.includes('Invalid delayDays')));
    assert.ok(result.reasons.some((r) => r.includes('channel')));
    assert.ok(result.reasons.some((r) => r.includes('discountPercent')));
    assert.ok(result.reasons.some((r) => r.includes('below conservative threshold')));
  });

  // 27. precedence is deterministic when multiple rules conflict
  it('27. precedence is deterministic when multiple rules conflict', () => {
    // Scenario A: Structural + Consent + Uncertainty -> Structural wins (stand_down)
    const resultA = validateGuardrails({
      proposal: createValidRetryProposal({
        channel: 'payment_link',
        confidence: 0.5, // uncertainty rule
      }),
      context: createValidContext({
        mandate: {
          attempts_used: 4, // structural rule
          contact_consent: false, // consent rule
        },
      }),
    });
    assert.equal(resultA.allowed, false);
    assert.equal(resultA.action, 'stand_down');

    // Scenario B: Consent + Uncertainty -> Consent / Uncertainty both resolve to human_review
    const resultB = validateGuardrails({
      proposal: createValidRetryProposal({
        channel: 'payment_link',
        confidence: 0.5, // uncertainty rule
      }),
      context: createValidContext({
        mandate: {
          attempts_used: 1, // no structural violation
          contact_consent: false, // consent rule
        },
      }),
    });
    assert.equal(resultB.allowed, false);
    assert.equal(resultB.action, 'human_review');

    // Scenario C: Uncertainty only -> human_review
    const resultC = validateGuardrails({
      proposal: createValidRetryProposal({ confidence: 0.5 }),
      context: createValidContext(),
    });
    assert.equal(resultC.allowed, false);
    assert.equal(resultC.action, 'human_review');
  });

  // 28. same inputs always produce the same output (purity & determinism)
  it('28. same inputs always produce the same output', () => {
    const proposal = createValidRetryProposal();
    const context = createValidContext();

    const run1 = validateGuardrails({ proposal, context });
    const run2 = validateGuardrails({ proposal, context });
    const run3 = validateGuardrails({ proposal, context });

    assert.deepEqual(run1, run2);
    assert.deepEqual(run2, run3);
  });

  // 29. no DB/RPC/API side effects and input immutability
  it('29. no DB/RPC/API side effects and input immutability', () => {
    const proposal = Object.freeze(createValidRetryProposal({ delayDays: 3 }));
    const context = Object.freeze({
      mandate: Object.freeze({
        id: 'm-immutable',
        status: 'pending',
        attempts_used: 2,
        contact_consent: true,
      }),
      failure: Object.freeze({
        category: 'soft',
        retryEligible: true,
      }),
    });

    // Validates that frozen objects do not throw mutation errors
    const result = validateGuardrails(proposal, context);

    assert.equal(result.allowed, true);
    assert.equal(result.action, 'retry');

    // Also test alias exports
    assert.equal(typeof evaluateGuardrails, 'function');
    assert.equal(typeof applyGuardrails, 'function');
    assert.deepEqual(evaluateGuardrails(proposal, context), result);
    assert.deepEqual(applyGuardrails(proposal, context), result);

    // Exported constants sanity
    assert.equal(MAX_GUARDRAIL_ATTEMPTS, 4);
    assert.equal(MAX_DELAY_DAYS, 7);
    assert.equal(CONFIDENCE_THRESHOLD, 0.7);
    assert.ok(GUARDRAIL_ACTIONS.includes('human_review'));
    assert.ok(SUPPORTED_CHANNELS.includes('auto_debit'));
  });
});
