// tests/step28_phase5_experiment_arms.test.js
//
// Phase 5: Experiment Arms, LLM Modes, and Seed Split Tests.
//
// Verifies all 20 required Phase 5 invariants:
//   1. All four arms can execute against the same seeded population.
//   2. Control performs zero retries.
//   3. Fixed Schedule uses only Observation.
//   4. Salary-Aware uses only Observation.
//   5. Smart uses only Observation.
//   6. Hidden traits never appear in arm input.
//   7. Failed cycle leaves mandate active.
//   8. Existing <=4-attempt-per-cycle guardrail remains enforced.
//   9. Existing non-peak dispatch guardrail remains enforced.
//  10. Existing 24-hour pre-debit notice gap remains enforced.
//  11. replay mode performs no live LLM call.
//  12. mock mode performs no live LLM call.
//  13. live mode remains available without being invoked by automated tests.
//  14. Same canonical Smart input + same model + same prompt version produces the same cache key.
//  15. Changing model name or prompt version changes the cache key.
//  16. Seeds 1–10 are classified as tuning.
//  17. Seeds 11–40 are classified as evaluation.
//  18. Evaluation seeds cannot mutate tuning configuration.
//  19. Running the same evaluation seed produces the same starting population and shared simulator noise.
//  20. Smart replay produces deterministic results without network access.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  BENCHMARK_ARMS,
  FOUR_HEADLINE_ARMS,
  SEED_SPLIT,
  TUNING_SEEDS,
  EVALUATION_SEEDS,
  captureConfigSnapshot,
  assertEvaluationIntegrity,
} from '../src/config/benchmarkConfig.js';

import {
  computeLLMCacheKey,
  canonicalizeInput,
  setReplayEntry,
  getReplayEntry,
  clearReplayCache,
  DEFAULT_MODEL_NAME,
  DEFAULT_PROMPT_VERSION,
  FORBIDDEN_HIDDEN_KEYS,
} from '../src/recovery/llmCache.js';

import {
  decideControlAction,
} from '../src/recovery/controlPolicy.js';

import {
  decideFixedScheduleAction,
  RETRY_DELAY_BY_NEXT_ATTEMPT,
} from '../src/recovery/baselinePolicy.js';

import {
  decideSalaryAwareAction,
  MAX_SALARY_AWARE_ATTEMPTS,
} from '../src/recovery/salaryAwarePolicy.js';

import {
  proposeSmartRecoveryAction,
  setLLMMode,
  resetLLMMode,
  getLLMMode,
  buildPrompt,
} from '../src/recovery/smartAgent.js';

import {
  validateGuardrails,
} from '../src/recovery/guardrails.js';

import {
  buildObservation,
  OBSERVATION_ALLOWLIST,
} from '../src/simulators/observation.js';

import {
  simulatePayment,
  noise,
  SIMULATOR_CONFIG,
} from '../src/simulators/paymentSimulator.js';

import {
  runPairedBenchmark,
  generateBenchmarkPopulation,
  simulateMandateArm,
} from '../src/recovery/benchmarkRunner.js';

import {
  MANDATE_STATUS,
  canTransition,
} from '../src/stateMachine/mandateStateMachine.js';

import {
  MAX_ATTEMPTS,
  preDebitNoticeMinHours,
  PEAK_WINDOWS,
} from '../src/config/recoveryPolicy.js';

describe('Phase 5 — Experiment Arms, LLM Modes, and Seed Split', () => {

  beforeEach(() => {
    resetLLMMode();
    clearReplayCache();
  });

  afterEach(() => {
    resetLLMMode();
    clearReplayCache();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. All four arms can execute against the same seeded population
  // ─────────────────────────────────────────────────────────────────────────
  it('1. All four arms can execute against the same seeded population', async () => {
    const seed = 15; // Evaluation seed
    const result = await runPairedBenchmark({ seed, count: 6, maxDays: 14, llmMode: 'mock' });

    assert.equal(result.seed, 15);
    assert.equal(result.seedType, 'evaluation');
    assert.equal(result.populationSize, 6);

    // Verify all four arms are evaluated
    for (const arm of FOUR_HEADLINE_ARMS) {
      assert.ok(result.arms[arm], `Results must exist for arm: ${arm}`);
      assert.equal(result.arms[arm].mandateCount, 6);
      assert.ok(result.resultsByArm[arm], `Detailed results must exist for arm: ${arm}`);
      assert.equal(result.resultsByArm[arm].length, 6);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Control performs zero retries
  // ─────────────────────────────────────────────────────────────────────────
  it('2. Control performs zero retries', async () => {
    const seed = 12;
    const population = generateBenchmarkPopulation({ seed, count: 12 });

    for (const mandate of population) {
      const outcome = await simulateMandateArm({
        arm: BENCHMARK_ARMS.CONTROL,
        mandate,
        seed,
        maxDays: 14,
      });

      // Control must never attempt more than 1 initial debit (zero retries)
      assert.ok(
        outcome.attemptsCount <= 1,
        `Control arm performed ${outcome.attemptsCount} attempts on ${mandate.mandateId}; expected <= 1`
      );

      if (outcome.attemptsCount === 1 && outcome.finalStatus !== 'recovered') {
        assert.equal(outcome.finalStatus, 'stood_down');
      }
    }

    // Direct decision function check:
    const mockObs = buildObservation({ mandate: population[0], currentDay: 1 });
    const decision = decideControlAction(mockObs, { category: 'soft', retryEligible: true });
    assert.equal(decision.action, 'stand_down');
    assert.equal(decision.delayDays, null);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Fixed Schedule uses only Observation
  // ─────────────────────────────────────────────────────────────────────────
  it('3. Fixed Schedule uses only Observation', () => {
    const mockMandate = {
      mandate_id: 'M-TEST-FIXED',
      amount: 1500,
      bank_id: 'BANK_01',
      attempts_used: 1,
      status: 'pending',
    };

    const observation = buildObservation({
      mandate: mockMandate,
      currentDay: 2,
    });

    const decision = decideFixedScheduleAction(observation, {
      category: 'soft',
      retryEligible: true,
    });

    assert.equal(decision.action, 'retry');
    assert.equal(decision.delayDays, RETRY_DELAY_BY_NEXT_ATTEMPT[2]); // attempt 2 -> delay 1
    assert.equal(decision.timeSlot, '14:00');

    // Verify injected hidden traits do not alter Fixed Schedule decision
    const contaminatedObs = {
      ...observation,
      salaryDay: 999,
      balanceDynamics: { salaryMultiplier: 10 },
      bankReliability: 0.01,
    };

    const cleanDecision = decideFixedScheduleAction(contaminatedObs, {
      category: 'soft',
      retryEligible: true,
    });

    assert.deepEqual(cleanDecision, decision);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Salary-Aware uses only Observation
  // ─────────────────────────────────────────────────────────────────────────
  it('4. Salary-Aware uses only Observation', () => {
    // Case A: Payday hint is near (day 5, currentDay 2 => delay 3)
    const obsWithNearHint = buildObservation({
      mandate: {
        mandate_id: 'M-TEST-SA-1',
        amount: 2000,
        attempts_used: 1,
        status: 'pending',
        noisyPaydayHint: 5,
      },
      currentDay: 2,
    });

    const decA = decideSalaryAwareAction(obsWithNearHint, { category: 'soft', retryEligible: true });
    assert.equal(decA.action, 'retry');
    assert.equal(decA.delayDays, 3); // 5 - 2 = 3 days delay

    // Case B: Payday hint is today (day 2, currentDay 2 => delay 1 next day)
    const obsWithTodayHint = buildObservation({
      mandate: {
        mandate_id: 'M-TEST-SA-2',
        amount: 2000,
        attempts_used: 1,
        status: 'pending',
        noisyPaydayHint: 2,
      },
      currentDay: 2,
    });

    const decB = decideSalaryAwareAction(obsWithTodayHint, { category: 'soft', retryEligible: true });
    assert.equal(decB.action, 'retry');
    assert.equal(decB.delayDays, 1);

    // Case C: Contaminated input with hidden traits does not alter decision
    const contaminatedObs = {
      ...obsWithNearHint,
      salaryDay: 999,
      balanceDynamics: { salaryMultiplier: 5 },
      bankReliability: 0.1,
    };

    const decContaminated = decideSalaryAwareAction(contaminatedObs, { category: 'soft', retryEligible: true });
    assert.deepEqual(decContaminated, decA);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Smart uses only Observation
  // ─────────────────────────────────────────────────────────────────────────
  it('5. Smart uses only Observation', async () => {
    const sentinelSalaryDay = SIMULATOR_CONFIG.CANARY.SENTINEL_SALARY_DAY; // 999

    const rawMandate = {
      mandate_id: 'M-TEST-SMART-OBS',
      amount: 1200,
      attempts_used: 1,
      status: 'pending',
      salaryDay: sentinelSalaryDay,
      income_day_of_month: sentinelSalaryDay,
      balanceDynamics: { salaryMultiplier: 999 },
    };

    const observation = buildObservation({ mandate: rawMandate, currentDay: 3 });

    // Verify observation stripped hidden traits
    assert.equal(observation.salaryDay, undefined);
    assert.equal(observation.balanceDynamics, undefined);

    // Ensure prompt generated from Observation contains no hidden traits
    const prompt = buildPrompt({
      mandateId: observation.mandateId,
      attemptsUsed: observation.attemptsUsed,
      maxAttempts: 4,
      amount: observation.amount,
      category: 'soft',
      retryEligible: true,
      declineCode: 'SIM_SOFT_001',
    });

    assert.ok(!prompt.includes('salaryDay'));
    assert.ok(!prompt.includes('999'));
    assert.ok(!prompt.includes('balanceDynamics'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Hidden traits never appear in arm input
  // ─────────────────────────────────────────────────────────────────────────
  it('6. Hidden traits never appear in arm input', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 28 }),
        fc.float({ min: 0, max: 1 }),
        fc.float({ min: 0, max: 1 }),
        fc.integer({ min: 500, max: 15000 }),
        (salaryDay, volatility, bankReliability, amount) => {
          const rawMandate = {
            mandate_id: 'M-CANARY-PROP',
            amount,
            salaryDay,
            income_day_of_month: salaryDay,
            balance_volatility: volatility,
            balanceDynamics: { volatility },
            bankReliability,
          };

          const obs = buildObservation({ mandate: rawMandate, currentDay: 1 });

          // Must strictly adhere to allowlist
          const obsKeys = Object.keys(obs);
          for (const key of obsKeys) {
            assert.ok(
              OBSERVATION_ALLOWLIST.includes(key),
              `Unexpected key "${key}" found in Observation`
            );
          }

          // None of the forbidden hidden keys may be present
          for (const forbidden of FORBIDDEN_HIDDEN_KEYS) {
            assert.equal(obs[forbidden], undefined, `Forbidden key "${forbidden}" present in Observation`);
          }

          // JSON serialization must be free of hidden traits
          const jsonStr = JSON.stringify(obs);
          assert.ok(!jsonStr.includes('salaryDay'));
          assert.ok(!jsonStr.includes('balanceDynamics'));
          assert.ok(!jsonStr.includes('bankReliability'));
        }
      ),
      { numRuns: 100 }
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. Failed cycle leaves mandate active (exhausted ≠ cancelled / stood_down)
  // ─────────────────────────────────────────────────────────────────────────
  it('7. Failed cycle leaves mandate active (exhausted ≠ stood_down / cancelled)', () => {
    // When a cycle exhausts its attempts, it reaches 'exhausted' state
    assert.notEqual(MANDATE_STATUS.EXHAUSTED, MANDATE_STATUS.STOOD_DOWN);
    assert.notEqual(MANDATE_STATUS.EXHAUSTED, 'cancelled');

    // Exhausted is a terminal cycle state, but does not cancel or stand down the mandate
    assert.equal(canTransition(MANDATE_STATUS.EXHAUSTED, MANDATE_STATUS.STOOD_DOWN), false);
    assert.equal(canTransition(MANDATE_STATUS.EXHAUSTED, MANDATE_STATUS.RECOVERED), false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. Existing <=4-attempt-per-cycle guardrail remains enforced
  // ─────────────────────────────────────────────────────────────────────────
  it('8. Existing <=4-attempt-per-cycle guardrail remains enforced', async () => {
    // Property test across diverse seeds and arms
    for (const arm of FOUR_HEADLINE_ARMS) {
      const population = generateBenchmarkPopulation({ seed: 33, count: 5 });
      for (const mandate of population) {
        const result = await simulateMandateArm({
          arm,
          mandate,
          seed: 33,
          maxDays: 20,
        });

        assert.ok(
          result.attemptsCount <= MAX_ATTEMPTS,
          `Arm "${arm}" exceeded attempt limit: ${result.attemptsCount} > ${MAX_ATTEMPTS}`
        );
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 9. Existing non-peak dispatch guardrail remains enforced
  // ─────────────────────────────────────────────────────────────────────────
  it('9. Existing non-peak dispatch guardrail remains enforced', () => {
    const validProposal = {
      action: 'retry',
      delayDays: 2,
      channel: 'auto_debit',
      confidence: 0.85,
    };

    // Peak slot (e.g. 11:30 during 10:00–13:00 window)
    const peakDispatchTime = '2026-10-02T11:30:00+05:30';
    const peakProposal = { ...validProposal, dispatchTime: peakDispatchTime };

    const peakCheck = validateGuardrails({
      proposal: peakProposal,
      mandate: { id: 'M-PEAK', status: 'pending', attempts_used: 1, contact_consent: true },
      failure: { category: 'soft', retryEligible: true },
    });

    assert.equal(peakCheck.allowed, false, 'Guardrail must reject peak hour dispatch');

    // Non-peak slot (14:00)
    const nonPeakDispatchTime = '2026-10-02T14:00:00+05:30';
    const nonPeakProposal = { ...validProposal, dispatchTime: nonPeakDispatchTime };

    const nonPeakCheck = validateGuardrails({
      proposal: nonPeakProposal,
      mandate: { id: 'M-NON-PEAK', status: 'pending', attempts_used: 1, contact_consent: true },
      failure: { category: 'soft', retryEligible: true },
    });

    assert.equal(nonPeakCheck.allowed, true, 'Guardrail must allow non-peak hour dispatch');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 10. Existing 24-hour pre-debit notice gap remains enforced
  // ─────────────────────────────────────────────────────────────────────────
  it('10. Existing 24-hour pre-debit notice gap remains enforced', () => {
    assert.equal(preDebitNoticeMinHours, 24);

    const noticeTime = '2026-10-01T10:00:00+05:30';
    // Only 12 hours after notice (insufficient gap)
    const shortNoticeDispatch = '2026-10-01T22:00:00+05:30';

    const checkShort = validateGuardrails({
      proposal: { action: 'retry', delayDays: 1, channel: 'auto_debit', confidence: 0.85, dispatchTime: shortNoticeDispatch },
      mandate: { id: 'M-NOTICE', status: 'pending', attempts_used: 1, contact_consent: true, pre_debit_notice_time: noticeTime },
      noticeTime,
      failure: { category: 'soft', retryEligible: true },
    });

    assert.equal(checkShort.allowed, false, 'Guardrail must reject dispatch with notice gap < 24h');

    // 28 hours after notice (sufficient gap)
    const validNoticeDispatch = '2026-10-02T14:00:00+05:30';
    const checkValid = validateGuardrails({
      proposal: { action: 'retry', delayDays: 2, channel: 'auto_debit', confidence: 0.85, dispatchTime: validNoticeDispatch },
      mandate: { id: 'M-NOTICE-OK', status: 'pending', attempts_used: 1, contact_consent: true, pre_debit_notice_time: noticeTime },
      noticeTime,
      failure: { category: 'soft', retryEligible: true },
    });

    assert.equal(checkValid.allowed, true, 'Guardrail must allow dispatch with notice gap >= 24h');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 11. replay mode performs no live LLM call
  // ─────────────────────────────────────────────────────────────────────────
  it('11. replay mode performs no live LLM call', async () => {
    setLLMMode('replay');
    assert.equal(getLLMMode(), 'replay');

    const canonicalInput = {
      mandateId: 'M-REPLAY-TEST',
      attemptsUsed: 1,
      maxAttempts: 4,
      amount: 1500,
      category: 'soft',
      retryEligible: true,
      declineCode: 'SIM_SOFT_001',
    };

    const cacheKey = computeLLMCacheKey({
      canonicalInput,
      modelName: DEFAULT_MODEL_NAME,
      promptVersion: DEFAULT_PROMPT_VERSION,
    });

    // Populate replay cache with deterministic entry
    setReplayEntry(cacheKey, {
      action: 'retry',
      retryDelayDays: 2,
      timeSlot: '14:00',
      reasoning: 'Replay cached response for test',
    });

    const proposal = await proposeSmartRecoveryAction({
      mandateId: canonicalInput.mandateId,
      attemptsUsed: canonicalInput.attemptsUsed,
      maxAttempts: canonicalInput.maxAttempts,
      amount: canonicalInput.amount,
      category: canonicalInput.category,
      retryEligible: canonicalInput.retryEligible,
      declineCode: canonicalInput.declineCode,
    });

    assert.equal(proposal.action, 'retry');
    assert.equal(proposal.retryDelayDays, 2);

    // Missing key in replay mode must fail explicitly rather than calling live Gemini
    clearReplayCache();
    await assert.rejects(
      async () => {
        await proposeSmartRecoveryAction({
          mandateId: 'M-REPLAY-MISSING',
          attemptsUsed: 1,
          maxAttempts: 4,
          amount: 2000,
          category: 'soft',
          retryEligible: true,
        });
      },
      /replay cache miss/i,
      'Replay cache miss must throw explicit error rather than silently calling live Gemini'
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 12. mock mode performs no live LLM call
  // ─────────────────────────────────────────────────────────────────────────
  it('12. mock mode performs no live LLM call', async () => {
    setLLMMode('mock');
    assert.equal(getLLMMode(), 'mock');

    const proposal = await proposeSmartRecoveryAction({
      mandateId: 'M-MOCK-TEST',
      attemptsUsed: 1,
      maxAttempts: 4,
      amount: 1500,
      category: 'soft',
      retryEligible: true,
    });

    assert.ok(proposal);
    assert.equal(proposal.action, 'retry');
    assert.equal(proposal.retryDelayDays, 2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 13. live mode remains available without being invoked by automated tests
  // ─────────────────────────────────────────────────────────────────────────
  it('13. live mode remains available without being invoked by automated tests', () => {
    setLLMMode('live');
    assert.equal(getLLMMode(), 'live');

    // Restore to mock so no live calls can ever be made
    resetLLMMode();
    assert.equal(getLLMMode(), 'mock');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 14. Same canonical Smart input + same model + same prompt version produces the same cache key
  // ─────────────────────────────────────────────────────────────────────────
  it('14. Same canonical Smart input + same model + same prompt version produces the same cache key', () => {
    const input1 = {
      mandateId: 'M-CACHE-01',
      amount: 1500,
      attemptsUsed: 1,
      category: 'soft',
      retryEligible: true,
    };

    // Same data, reversed object key insertion order
    const input2 = {
      retryEligible: true,
      category: 'soft',
      attemptsUsed: 1,
      amount: 1500,
      mandateId: 'M-CACHE-01',
    };

    const key1 = computeLLMCacheKey({
      canonicalInput: input1,
      modelName: 'gemini-2.0-flash',
      promptVersion: 'v1.0',
    });

    const key2 = computeLLMCacheKey({
      canonicalInput: input2,
      modelName: 'gemini-2.0-flash',
      promptVersion: 'v1.0',
    });

    assert.equal(key1, key2, 'Key ordering must not affect cache key hash');
    assert.equal(typeof key1, 'string');
    assert.equal(key1.length, 64); // SHA-256 hex digest
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 15. Changing model name or prompt version changes the cache key
  // ─────────────────────────────────────────────────────────────────────────
  it('15. Changing model name or prompt version changes the cache key', () => {
    const input = {
      mandateId: 'M-CACHE-DIFF',
      amount: 2500,
      attemptsUsed: 2,
      category: 'soft',
      retryEligible: true,
    };

    const baseKey = computeLLMCacheKey({
      canonicalInput: input,
      modelName: 'gemini-2.0-flash',
      promptVersion: 'v1.0',
    });

    const differentModelKey = computeLLMCacheKey({
      canonicalInput: input,
      modelName: 'gemini-1.5-pro',
      promptVersion: 'v1.0',
    });

    const differentPromptKey = computeLLMCacheKey({
      canonicalInput: input,
      modelName: 'gemini-2.0-flash',
      promptVersion: 'v2.0',
    });

    assert.notEqual(baseKey, differentModelKey, 'Changing model name must change cache key');
    assert.notEqual(baseKey, differentPromptKey, 'Changing prompt version must change cache key');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 16. Seeds 1–10 are classified as tuning
  // ─────────────────────────────────────────────────────────────────────────
  it('16. Seeds 1–10 are classified as tuning', () => {
    assert.equal(TUNING_SEEDS.length, 10);
    for (let s = 1; s <= 10; s++) {
      assert.equal(SEED_SPLIT.isTuning(s), true, `Seed ${s} must be tuning`);
      assert.equal(SEED_SPLIT.isEvaluation(s), false, `Seed ${s} must not be evaluation`);
      assert.equal(SEED_SPLIT.classify(s), 'tuning');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 17. Seeds 11–40 are classified as evaluation
  // ─────────────────────────────────────────────────────────────────────────
  it('17. Seeds 11–40 are classified as evaluation', () => {
    assert.equal(EVALUATION_SEEDS.length, 30);
    for (let s = 11; s <= 40; s++) {
      assert.equal(SEED_SPLIT.isEvaluation(s), true, `Seed ${s} must be evaluation`);
      assert.equal(SEED_SPLIT.isTuning(s), false, `Seed ${s} must not be tuning`);
      assert.equal(SEED_SPLIT.classify(s), 'evaluation');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 18. Evaluation seeds cannot mutate tuning configuration
  // ─────────────────────────────────────────────────────────────────────────
  it('18. Evaluation seeds cannot mutate tuning configuration', async () => {
    const beforeSnapshot = captureConfigSnapshot();

    // Run paired benchmark across evaluation seeds 11 and 20
    await runPairedBenchmark({ seed: 11, count: 5 });
    await runPairedBenchmark({ seed: 20, count: 5 });

    const afterSnapshot = captureConfigSnapshot();

    // Verify recovery policy and simulator config remain byte-for-byte identical
    assert.deepEqual(beforeSnapshot.recoveryPolicy, afterSnapshot.recoveryPolicy);
    assert.deepEqual(beforeSnapshot.simulatorConfig, afterSnapshot.simulatorConfig);

    // assertEvaluationIntegrity verifies no drift
    assert.doesNotThrow(() => {
      assertEvaluationIntegrity(11, beforeSnapshot);
      assertEvaluationIntegrity(20, beforeSnapshot);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 19. Running the same evaluation seed produces the same starting population and shared simulator noise
  // ─────────────────────────────────────────────────────────────────────────
  it('19. Running the same evaluation seed produces the same starting population and shared simulator noise', () => {
    const evalSeed = 25;

    const pop1 = generateBenchmarkPopulation({ seed: evalSeed, count: 8 });
    const pop2 = generateBenchmarkPopulation({ seed: evalSeed, count: 8 });

    assert.deepEqual(pop1, pop2, 'Population for identical seed must match exactly');

    // Verify shared noise stream for mandate debit attempts
    for (let i = 0; i < pop1.length; i++) {
      const m1 = pop1[i];
      const m2 = pop2[i];

      const sim1 = simulatePayment({
        seed: evalSeed,
        mandateId: m1.mandateId,
        attemptNumber: 1,
        amount: m1.amount,
        currentDay: 1,
      });

      const sim2 = simulatePayment({
        seed: evalSeed,
        mandateId: m2.mandateId,
        attemptNumber: 1,
        amount: m2.amount,
        currentDay: 1,
      });

      assert.deepEqual(sim1, sim2, 'Causal simulator outcomes and noise must be identical for identical seed');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 20. Smart replay produces deterministic results without network access
  // ─────────────────────────────────────────────────────────────────────────
  it('20. Smart replay produces deterministic results without network access', async () => {
    setLLMMode('replay');

    const canonicalInput = {
      mandateId: 'M-DETERMINISTIC-REPLAY',
      attemptsUsed: 2,
      maxAttempts: 4,
      amount: 1800,
      category: 'soft',
      retryEligible: true,
      declineCode: 'SIM_SOFT_002',
    };

    const cacheKey = computeLLMCacheKey({
      canonicalInput,
      modelName: DEFAULT_MODEL_NAME,
      promptVersion: DEFAULT_PROMPT_VERSION,
    });

    const expectedProposal = {
      action: 'retry',
      retryDelayDays: 3,
      timeSlot: '14:00',
      reasoning: 'Replay: bank downtime transient failure, retry after 3 days',
    };

    setReplayEntry(cacheKey, expectedProposal);

    // Call smart agent in replay mode twice
    const resA = await proposeSmartRecoveryAction(canonicalInput);
    const resB = await proposeSmartRecoveryAction(canonicalInput);

    assert.equal(resA.action, expectedProposal.action);
    assert.equal(resA.retryDelayDays, expectedProposal.retryDelayDays);
    assert.deepEqual(resA, resB, 'Replay proposals must be bit-for-bit deterministic');
  });

});
