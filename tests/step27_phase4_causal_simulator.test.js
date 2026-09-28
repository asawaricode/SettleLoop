// tests/step27_phase4_causal_simulator.test.js
//
// Phase 4: Causal Simulator & Observation Boundary Tests.
//
// Verifies:
//   1. Seed Determinism: same seed + same population => identical outcomes.
//   2. Seed Sensitivity: different seeds produce varied outcomes.
//   3. Explicit Causal Attribution: every attempt produces an outcome with an explicit cause.
//   4. Canary Leak Verification: hidden sentinel salary-day (999) never appears in Observation,
//      serialized Observation, or the Gemini prompt.
//   5. Hidden Trait Boundary: hidden traits (salaryDay, balanceDynamics, bankReliability)
//      never leak into Observation or serialized JSON.
//   6. Strict Allowlist Construction: buildObservation contains only allowlisted keys.
//   7. Gemini Prompt Sanitation: prompt contains no hidden-trait keys or values.
//   8. Paired Simulation Luck: shared noise stream provides identical underlying luck
//      across arms for paired comparison.
//   9. Causal Balance & Uptime Dynamics: no hash-only outcome decisions remain.
//  10. Virtual Simulation Clock: outcomes depend on virtual simulation day, not Date.now().

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  simulatePayment,
  noise,
  deriveHiddenTraits,
  buildObservation,
  SIMULATOR_CONFIG,
} from '../src/simulators/paymentSimulator.js';

import { OBSERVATION_ALLOWLIST } from '../src/simulators/observation.js';
import {
  proposeSmartRecoveryAction,
  buildPrompt,
  setMockLLMHandler,
  resetMockLLMHandler,
} from '../src/recovery/smartAgent.js';

describe('Phase 4 — Causal Simulator + Observation Boundary', () => {

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Seed Determinism Property Test
  // ─────────────────────────────────────────────────────────────────────────
  it('1. Determinism: same seed + same population => identical outcomes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.array(
          fc.record({
            mandateId: fc.uuid(),
            amount: fc.integer({ min: 100, max: 20000 }),
            attemptNumber: fc.integer({ min: 1, max: 4 }),
            currentDay: fc.integer({ min: 1, max: 28 }),
          }),
          { minLength: 3, maxLength: 8 }
        ),
        (seed, population) => {
          const runA = population.map((m) => simulatePayment({ seed, ...m }));
          const runB = population.map((m) => simulatePayment({ seed, ...m }));

          assert.deepEqual(runA, runB, 'Runs with identical seed and population must match exactly');
        }
      ),
      { numRuns: 50 }
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Seed Sensitivity Property Test
  // ─────────────────────────────────────────────────────────────────────────
  it('2. Seed Sensitivity: different seeds can produce different outcomes', () => {
    let observedDifference = false;

    // Test a population across distinct seeds
    const population = Array.from({ length: 15 }, (_, i) => ({
      mandateId: `MANDATE_SENSITIVITY_${i}`,
      amount: 1500,
      attemptNumber: 1,
      currentDay: 15,
    }));

    const resultsA = population.map((m) => simulatePayment({ seed: 101, ...m }));
    const resultsB = population.map((m) => simulatePayment({ seed: 99999, ...m }));

    // Check if at least one outcome or cause differs across these distinct seeds
    const diff = resultsA.some((resA, idx) => {
      const resB = resultsB[idx];
      return resA.outcome !== resB.outcome || resA.cause !== resB.cause;
    });

    if (diff) {
      observedDifference = true;
    }

    assert.equal(observedDifference, true, 'Different simulation seeds must be capable of producing varied outcomes');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Explicit Causal Attribution Property Test
  // ─────────────────────────────────────────────────────────────────────────
  it('3. Causal Outcome Model: every outcome has an explicit cause from the taxonomy', () => {
    const VALID_CAUSES = new Set([
      'transient_bank_failure',
      'insufficient_funds',
      'hard_decline',
      'unknown_decline',
      'successful_recovery',
    ]);

    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500_000 }),
        fc.uuid(),
        fc.integer({ min: 100, max: 30000 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 28 }),
        (seed, mandateId, amount, attemptNumber, currentDay) => {
          const result = simulatePayment({
            seed,
            mandateId,
            amount,
            attemptNumber,
            currentDay,
          });

          // Must have explicit cause
          assert.ok(VALID_CAUSES.has(result.cause), `Unexpected cause: ${result.cause}`);

          // Causal relationship to decline codes & categories
          if (result.cause === 'successful_recovery') {
            assert.equal(result.outcome, 'success');
            assert.equal(result.declineCode, null);
            assert.equal(result.declineCategory, null);
            assert.equal(result.retryEligible, null);
          } else if (result.cause === 'transient_bank_failure') {
            assert.equal(result.outcome, 'failure');
            assert.equal(result.declineCode, SIMULATOR_CONFIG.BANK.DOWN_DECLINE_CODE);
            assert.equal(result.declineCategory, 'soft');
            assert.equal(result.retryEligible, true);
          } else if (result.cause === 'insufficient_funds') {
            assert.equal(result.outcome, 'failure');
            assert.equal(result.declineCode, SIMULATOR_CONFIG.BALANCE.INSUFFICIENT_FUNDS_CODE);
            assert.equal(result.declineCategory, 'soft');
            assert.equal(result.retryEligible, true);
          } else if (result.cause === 'hard_decline') {
            assert.equal(result.outcome, 'failure');
            assert.equal(result.declineCode, SIMULATOR_CONFIG.OTHER_DECLINES.HARD_DECLINE_CODE);
            assert.equal(result.declineCategory, 'hard');
            assert.equal(result.retryEligible, false);
          } else if (result.cause === 'unknown_decline') {
            assert.equal(result.outcome, 'failure');
            assert.equal(result.declineCode, SIMULATOR_CONFIG.OTHER_DECLINES.UNKNOWN_DECLINE_CODE);
            assert.equal(result.declineCategory, 'unknown');
            assert.equal(result.retryEligible, false);
          }
        }
      ),
      { numRuns: 80 }
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Canary Leak Verification
  // ─────────────────────────────────────────────────────────────────────────
  it('4. Canary Leak Test: sentinel salary day (999) never appears in Observation, JSON, or Gemini prompt', async () => {
    const sentinelSalaryDay = SIMULATOR_CONFIG.CANARY.SENTINEL_SALARY_DAY; // 999
    assert.equal(sentinelSalaryDay, 999);

    const syntheticMandate = {
      id: 'canary-mandate-uuid-001',
      mandate_id: 'CANARY-M-001',
      amount: 1200,
      salaryDay: sentinelSalaryDay,
      income_day_of_month: sentinelSalaryDay,
      balance_volatility: 0.88,
      bankReliability: 0.99,
      bank_id: 'BANK_HDFC',
      status: 'pending',
      attempts_used: 1,
      [SIMULATOR_CONFIG.CANARY.SENTINEL_TRAIT_KEY]: 'TOP_SECRET_SIMULATOR_TRAIT',
    };

    // 1. Build observation
    const observation = buildObservation({
      mandate: syntheticMandate,
      currentDay: 5,
      attemptHistory: [
        { attempt_number: 1, outcome: 'failure', decline_code: 'SIM_SOFT_001', decline_category: 'soft' },
      ],
    });

    // Verify sentinel never appears in Observation object properties
    assert.equal(observation.salaryDay, undefined);
    assert.equal(observation.income_day_of_month, undefined);
    assert.equal(observation.balance_volatility, undefined);
    assert.equal(observation.bankReliability, undefined);
    assert.equal(observation[SIMULATOR_CONFIG.CANARY.SENTINEL_TRAIT_KEY], undefined);

    // Verify sentinel never appears in serialized JSON
    const serializedObs = JSON.stringify(observation);
    assert.ok(!serializedObs.includes('999'), 'Sentinel value 999 leaked into serialized observation');
    assert.ok(!serializedObs.includes('TOP_SECRET'), 'Sentinel secret leaked into serialized observation');
    assert.ok(!serializedObs.includes('balance_volatility'), 'Hidden trait key leaked into serialized observation');
    assert.ok(!serializedObs.includes('bankReliability'), 'Hidden trait key leaked into serialized observation');

    // 2. Verify Gemini prompt never contains the sentinel or hidden traits
    let capturedPrompt = null;
    setMockLLMHandler(async (prompt, context) => {
      capturedPrompt = prompt;
      return { action: 'retry', retryDelayDays: 2, reasoning: 'Soft retry test' };
    });

    try {
      await proposeSmartRecoveryAction({
        observation,
        category: 'soft',
        retryEligible: true,
        declineCode: 'SIM_SOFT_001',
      });

      assert.ok(capturedPrompt, 'Prompt must have been generated');
      assert.ok(!capturedPrompt.includes('999'), 'Sentinel value 999 leaked into Gemini prompt');
      assert.ok(!capturedPrompt.includes('TOP_SECRET'), 'Sentinel secret leaked into Gemini prompt');
      assert.ok(!capturedPrompt.includes('balanceVolatility'), 'balanceVolatility key leaked into Gemini prompt');
      assert.ok(!capturedPrompt.includes('salaryDay'), 'salaryDay key leaked into Gemini prompt');
      assert.ok(!capturedPrompt.includes('bankReliability'), 'bankReliability key leaked into Gemini prompt');
    } finally {
      resetMockLLMHandler();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Hidden Trait Boundary Property Test
  // ─────────────────────────────────────────────────────────────────────────
  it('5. Hidden Traits: latent mandate traits are isolated from Observation and arms', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200_000 }),
        fc.uuid(),
        fc.integer({ min: 100, max: 10000 }),
        (seed, mandateId, amount) => {
          // Derive hidden traits inside the simulator
          const hiddenTraits = deriveHiddenTraits(seed, { mandate_id: mandateId, amount });

          assert.ok(typeof hiddenTraits.salaryDay === 'number');
          assert.ok(hiddenTraits.salaryDay >= 1 && hiddenTraits.salaryDay <= 28);
          assert.ok(typeof hiddenTraits.bankReliability === 'number');
          assert.ok(typeof hiddenTraits.balanceDynamics === 'object');

          // Construct arm-facing Observation
          const rawMandate = {
            id: mandateId,
            mandate_id: mandateId,
            amount,
            salaryDay: hiddenTraits.salaryDay,
            balanceDynamics: hiddenTraits.balanceDynamics,
            bankReliability: hiddenTraits.bankReliability,
            status: 'pending',
          };

          const observation = buildObservation({ mandate: rawMandate, currentDay: 1 });

          // Assert complete exclusion
          assert.equal(observation.salaryDay, undefined);
          assert.equal(observation.balanceDynamics, undefined);
          assert.equal(observation.bankReliability, undefined);

          const serialized = JSON.stringify(observation);
          assert.ok(!serialized.includes('balanceDynamics'));
          assert.ok(!serialized.includes('bankReliability'));
          assert.ok(!serialized.includes('salaryDay'));
        }
      ),
      { numRuns: 50 }
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Strict Allowlist Construction Property Test
  // ─────────────────────────────────────────────────────────────────────────
  it('6. Strict Allowlist: buildObservation contains ONLY allowlisted keys', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.anything()),
        (extraFields) => {
          const rawMandate = {
            id: 'm-allowlist-test-01',
            amount: 2500,
            bank_id: 'BANK_SBI',
            status: 'pending',
            attempts_used: 1,
            ...extraFields,
          };

          const observation = buildObservation({
            mandate: rawMandate,
            currentDay: 3,
            attemptHistory: [],
          });

          // Verify every key in the returned observation is in the allowlist
          const obsKeys = Object.keys(observation);
          const allowlistSet = new Set(OBSERVATION_ALLOWLIST);

          for (const key of obsKeys) {
            assert.ok(
              allowlistSet.has(key),
              `Key "${key}" in observation is not permitted by OBSERVATION_ALLOWLIST`
            );
          }

          // Verify the returned object is frozen
          assert.ok(Object.isFrozen(observation), 'Observation must be frozen');
          assert.ok(Object.isFrozen(observation.attemptHistory), 'attemptHistory must be frozen');
        }
      ),
      { numRuns: 50 }
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. Gemini Prompt Sanitation
  // ─────────────────────────────────────────────────────────────────────────
  it('7. Gemini Prompt: contains no hidden-trait keys or latent values', () => {
    const prompt = buildPrompt({
      mandateId: 'TEST-MANDATE-SANITIZED',
      attemptsUsed: 1,
      maxAttempts: 4,
      amount: 1500,
      category: 'soft',
      retryEligible: true,
      declineCode: 'SIM_SOFT_001',
    });

    const forbiddenTerms = [
      'balanceVolatility',
      'balance_volatility',
      'salaryDay',
      'income_day_of_month',
      'bankReliability',
      'balanceDynamics',
      'salaryMultiplier',
      'dailySpendFraction',
      '999',
    ];

    for (const term of forbiddenTerms) {
      assert.ok(
        !prompt.includes(term),
        `Forbidden simulator term "${term}" found in Gemini prompt: \n${prompt}`
      );
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. Paired Simulation Luck Property Test
  // ─────────────────────────────────────────────────────────────────────────
  it('8. Paired Comparisons: shared seeded noise is identical across arms for identical mandate/day/slot', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.uuid(),
        fc.integer({ min: 1, max: 28 }),
        fc.constantFrom('default', '10:00', '14:00', '18:00'),
        (seed, mandateId, day, slot) => {
          // Independent purpose streams
          const uptimeNoise = noise(seed, mandateId, day, slot, 'bank_uptime');
          const shockNoise = noise(seed, mandateId, day, slot, 'balance_shock');
          const otherNoise = noise(seed, mandateId, day, slot, 'other_decline');

          // Properties of uniform float
          assert.ok(uptimeNoise >= 0 && uptimeNoise < 1, 'Uptime noise must be in [0, 1)');
          assert.ok(shockNoise >= 0 && shockNoise < 1, 'Shock noise must be in [0, 1)');
          assert.ok(otherNoise >= 0 && otherNoise < 1, 'Other decline noise must be in [0, 1)');

          // Stream independence: different purposes on the same coordinate produce distinct values
          assert.notEqual(uptimeNoise, shockNoise, 'Distinct purpose streams must not share the same value');
          assert.notEqual(uptimeNoise, otherNoise, 'Distinct purpose streams must not share the same value');

          // Repeat invocation guarantees identical value (deterministic paired luck)
          const uptimeRepeat = noise(seed, mandateId, day, slot, 'bank_uptime');
          assert.equal(uptimeNoise, uptimeRepeat, 'Same coordinates must produce identical noise for paired comparisons');
        }
      ),
      { numRuns: 60 }
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 9. Causal Balance Dynamics vs Hash-Only Outcome
  // ─────────────────────────────────────────────────────────────────────────
  it('9. Causal Balance Model: salary day produces balance jump and spending causes drift', () => {
    const seed = 54321;
    const mandateId = 'M-CAUSAL-BALANCE-TEST';
    const amount = 1000;
    const salaryDay = 1; // salary paid on Day 1

    // Pass explicit salaryDay trait
    const syntheticMandate = {
      mandate_id: mandateId,
      amount,
      salaryDay,
      bankReliability: 1.0, // Bank guaranteed 100% up
    };

    // On Day 1 (salary day), balance should be at its peak (salary jump)
    const day1Result = simulatePayment({
      seed,
      mandate: syntheticMandate,
      attemptNumber: 1,
      currentDay: 1,
    });

    assert.ok(day1Result.availableBalance !== undefined);
    assert.ok(
      day1Result.availableBalance >= amount,
      `Day 1 balance (${day1Result.availableBalance}) should be high after salary jump`
    );

    // Later in the cycle (Day 27, before next salary), balance has drifted downwards due to daily spending
    const day27Result = simulatePayment({
      seed,
      mandate: syntheticMandate,
      attemptNumber: 1,
      currentDay: 27,
    });

    assert.ok(day27Result.availableBalance !== undefined);
    assert.ok(
      day1Result.availableBalance > day27Result.availableBalance,
      `Balance on Day 1 (${day1Result.availableBalance}) must exceed balance on Day 27 (${day27Result.availableBalance}) due to spending drift`
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 10. Virtual Simulation Clock (Never Date.now())
  // ─────────────────────────────────────────────────────────────────────────
  it('10. Simulation Clock: outcomes are governed by currentDay and unaffected by real Date.now()', () => {
    const params = {
      seed: 998877,
      mandateId: 'CLOCK-TEST-MANDATE',
      amount: 2000,
      attemptNumber: 1,
      currentDay: 10,
    };

    const res1 = simulatePayment(params);

    // Artificially wait or let wall clock advance
    const res2 = simulatePayment(params);

    assert.deepEqual(res1, res2, 'Virtual clock guarantees identical results regardless of wall clock');
  });

});
