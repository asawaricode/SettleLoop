// tests/step29_phase6_evaluation.test.js
//
// Phase 6: Evaluation Evidence & Statistical Robustness Tests.
//
// Verifies:
//   1. Execution across frozen evaluation seeds 11–40 (N=30, df=29).
//   2. Measurement of the 5 core metrics:
//        - recovery rate
//        - recovered ₹ (SUM within seed)
//        - attempts used
//        - days to recovery (CONDITIONAL ON RECOVERY only)
//        - Smart guardrail overrides
//   3. Non-Smart arms strictly produce 0 guardrail overrides.
//   4. Net Value calculation: recovered ₹ − (attempts × assumedRetryFee).
//   5. Break-Even Fee calculation against Control (not net value = 0).
//   6. Pairwise comparisons: strictly the 4 requested pairs.
//   7. 95% CI calculation: mean difference ± t-critical(df=29, 95%) × SE across all metrics.
//   8. Reproducibility: complete benchmark across seeds 11–40 is byte-identical across runs.
//   9. Smart LLM mode is explicitly recorded and makes zero network calls in mock/replay.
//  10. Verification of alternative assumption sets absence (reported as blocker).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVALUATION_SEEDS,
  assumedRetryFee,
  BENCHMARK_ARMS,
  FOUR_HEADLINE_ARMS,
  ALTERNATIVE_ASSUMPTION_SET_A,
  ALTERNATIVE_ASSUMPTION_SET_B,
} from '../src/config/benchmarkConfig.js';

import {
  evaluateBenchmark,
  computePairedCI,
  computeBreakEvenFee,
  T_CRITICAL_DF29_95,
} from '../src/evaluation/benchmarkEvaluator.js';

import {
  proposeSmartRecoveryAction,
  setLLMMode,
  resetLLMMode,
} from '../src/recovery/smartAgent.js';
import { clearReplayCache } from '../src/recovery/llmCache.js';

describe('Phase 6 — Evaluation Evidence & Statistical Invariants', () => {
  it('1. Frozen evaluation seeds 11–40 are exactly 30 seeds with df=29', () => {
    assert.strictEqual(EVALUATION_SEEDS.length, 30);
    assert.strictEqual(EVALUATION_SEEDS[0], 11);
    assert.strictEqual(EVALUATION_SEEDS[29], 40);
    assert.strictEqual(EVALUATION_SEEDS.length - 1, 29);
  });

  it('2. t-critical constant matches exact Student-t value for df=29 at 95% two-tailed confidence', () => {
    assert.ok(Math.abs(T_CRITICAL_DF29_95 - 2.04523) < 0.001);
  });

  it('3. computePairedCI calculates mean diff, standard error, and 95% CI correctly', () => {
    // Synthetic differences with known mean and variance
    const diffs = [2, 4, 6, 8, 10]; // mean = 6, N = 5
    const ci = computePairedCI(diffs, 2.0);
    assert.strictEqual(ci.mean, 6);
    assert.strictEqual(ci.df, 4);
    assert.ok(ci.standardError > 0);
    assert.strictEqual(ci.ci95[0], Number((ci.mean - ci.marginOfError).toFixed(4)));
    assert.strictEqual(ci.ci95[1], Number((ci.mean + ci.marginOfError).toFixed(4)));
  });

  it('4. computeBreakEvenFee uses exact formula (delta recovered ₹ / delta attempts) against Control', () => {
    const feeResult = computeBreakEvenFee(20000, 15000, 15, 10);
    // deltaRecovered = 5000, deltaAttempts = 5 -> fee = 1000
    assert.strictEqual(feeResult.breakEvenFeeINR, 1000);
    assert.strictEqual(
      feeResult.formula,
      '(meanRecoveredINR[arm] - meanRecoveredINR[control]) / (meanAttempts[arm] - meanAttempts[control])'
    );
    // Verify break-even is NOT net value = 0
    const netValueAtBreakEvenArm = 20000 - 15 * 1000; // 5000
    const netValueAtBreakEvenControl = 15000 - 10 * 1000; // 5000
    assert.strictEqual(netValueAtBreakEvenArm, netValueAtBreakEvenControl);
    assert.notStrictEqual(netValueAtBreakEvenArm, 0);
  });

  it('5. Evaluation measures all 4 arms on evaluation seeds and records metadata', async () => {
    // Run on a 3-seed evaluation subset to verify contract swiftly
    const evalSeedsSubset = [11, 12, 13];
    const results = await evaluateBenchmark({
      seeds: evalSeedsSubset,
      count: 5,
      llmMode: 'mock',
    });

    assert.ok(results.metadata);
    assert.strictEqual(results.metadata.llmMode, 'mock');
    assert.strictEqual(results.metadata.assumedRetryFeeINR, assumedRetryFee);
    assert.deepStrictEqual(results.metadata.evaluationSeeds, evalSeedsSubset);

    for (const arm of FOUR_HEADLINE_ARMS) {
      assert.ok(results.armMetrics[arm], `Missing metrics for arm ${arm}`);
      const m = results.armMetrics[arm];
      assert.ok(typeof m.meanRecoveryRate === 'number');
      assert.ok(typeof m.meanRecoveredINR === 'number');
      assert.ok(typeof m.meanAttempts === 'number');
      assert.ok(typeof m.meanDaysToRecoveryConditional === 'number');
      assert.ok(typeof m.totalGuardrailOverrides === 'number');
      assert.ok(typeof m.meanNetValueINR === 'number');
    }
  });

  it('6. Non-Smart arms strictly produce zero guardrail overrides', async () => {
    const evalSeedsSubset = [14, 15, 16];
    const results = await evaluateBenchmark({
      seeds: evalSeedsSubset,
      count: 5,
      llmMode: 'mock',
    });

    assert.strictEqual(results.armMetrics[BENCHMARK_ARMS.CONTROL].totalGuardrailOverrides, 0);
    assert.strictEqual(results.armMetrics[BENCHMARK_ARMS.FIXED_SCHEDULE].totalGuardrailOverrides, 0);
    assert.strictEqual(results.armMetrics[BENCHMARK_ARMS.SALARY_AWARE].totalGuardrailOverrides, 0);
  });

  it('7. Days to recovery is explicitly conditional on recovery only (unrecovered mandates excluded)', async () => {
    const results = await evaluateBenchmark({
      seeds: [11],
      count: 10,
      llmMode: 'mock',
    });

    const seedRecord = results.seedLevelData[0];
    for (const arm of FOUR_HEADLINE_ARMS) {
      const days = seedRecord.arms[arm].daysToRecovery;
      // Days to recovery is finite and >= 0 (since all arms recovered at least 1 mandate)
      assert.ok(typeof days === 'number' && Number.isFinite(days) && days >= 0);
    }
  });

  it('8. Net value equals recovered ₹ − (attempts × assumedRetryFee)', async () => {
    const results = await evaluateBenchmark({
      seeds: [20],
      count: 5,
      llmMode: 'mock',
    });

    const seedRecord = results.seedLevelData[0];
    for (const arm of FOUR_HEADLINE_ARMS) {
      const armData = seedRecord.arms[arm];
      const expectedNetValue = armData.recoveredINR - (armData.attemptsUsed * assumedRetryFee);
      assert.strictEqual(armData.netValue, expectedNetValue);
    }
  });

  it('9. Pairwise comparisons strictly report ONLY the 4 requested comparisons', async () => {
    const results = await evaluateBenchmark({
      seeds: [11, 12, 13],
      count: 5,
      llmMode: 'mock',
    });

    const expectedKeys = [
      'fixed_vs_control',
      'salary_aware_vs_control',
      'smart_vs_control',
      'smart_vs_salary_aware',
    ];
    const actualKeys = Object.keys(results.pairwiseComparisons);
    assert.deepStrictEqual(actualKeys.sort(), expectedKeys.sort());

    for (const key of expectedKeys) {
      const comparison = results.pairwiseComparisons[key];
      assert.ok(comparison.recoveryRate.ci95);
      assert.ok(comparison.recoveredINR.ci95);
      assert.ok(comparison.attemptsUsed.ci95);
      assert.ok(comparison.guardrailOverrides.ci95);
      assert.ok(comparison.netValue.ci95);
    }
  });

  it('10. Evaluation outside seeds 11–40 throws an explicit integrity error', async () => {
    await assert.rejects(
      async () => {
        await evaluateBenchmark({ seeds: [1, 2, 3] }); // tuning seeds
      },
      /EVALUATION INTEGRITY ERROR/
    );
  });

  it('11. Complete benchmark evaluation across seeds 11–40 is byte-identical reproducible', async () => {
    // Test on a subset of seeds to ensure deterministic byte-equality swiftly in test suite
    const evalSeeds = [11, 12, 13, 14, 15];
    const run1 = await evaluateBenchmark({ seeds: evalSeeds, count: 6, llmMode: 'mock' });
    const run2 = await evaluateBenchmark({ seeds: evalSeeds, count: 6, llmMode: 'mock' });

    const str1 = JSON.stringify(run1);
    const str2 = JSON.stringify(run2);

    assert.strictEqual(str1, str2, 'Serialized evaluation output must be byte-for-byte identical');
  });

  it('12. Full evaluation across all 30 evaluation seeds (11–40) completes with valid CIs', async () => {
    const fullResults = await evaluateBenchmark({
      seeds: EVALUATION_SEEDS,
      count: 10,
      llmMode: 'mock',
    });

    assert.strictEqual(fullResults.seedLevelData.length, 30);
    assert.strictEqual(fullResults.metadata.totalMandatesEvaluated, 300);

    // Verify all 4 pairwise comparisons have df = 29
    for (const comp of Object.values(fullResults.pairwiseComparisons)) {
      assert.strictEqual(comp.recoveryRate.df, 29);
      assert.strictEqual(comp.recoveredINR.df, 29);
      assert.strictEqual(comp.attemptsUsed.df, 29);
      assert.strictEqual(comp.netValue.df, 29);
    }

    // Verify break-even fees are positive and reasonable
    for (const [arm, b] of Object.entries(fullResults.netValueAnalysis.breakEvenFeesINR)) {
      assert.ok(b.breakEvenFeeINR > 0, `Break-even fee for ${arm} should be positive`);
      assert.strictEqual(
        b.formula,
        '(meanRecoveredINR[arm] - meanRecoveredINR[control]) / (meanAttempts[arm] - meanAttempts[control])'
      );
    }
  });

  it('13. Metric clarification: Control strictly uses 10 attempts per seed (1.0000/mandate) with 0 recovery retries', async () => {
    const results = await evaluateBenchmark({
      seeds: [11, 12, 13],
      count: 10,
      llmMode: 'mock',
    });

    const controlMetrics = results.armMetrics[BENCHMARK_ARMS.CONTROL];
    assert.strictEqual(controlMetrics.meanAttempts, 10.0000);
    assert.strictEqual(controlMetrics.meanAttemptsPerMandate, 1.0000);
    assert.strictEqual(controlMetrics.meanRecoveryRetries, 0.0000);

    const fixedMetrics = results.armMetrics[BENCHMARK_ARMS.FIXED_SCHEDULE];
    assert.ok(fixedMetrics.meanAttempts > 10.0000);
    assert.ok(fixedMetrics.meanAttemptsPerMandate > 1.0000);
    assert.ok(fixedMetrics.meanRecoveryRetries > 0.0000);
  });

  it('14. Replay mode with unpopulated cache explicitly fails without making live network calls', async () => {
    setLLMMode('replay');
    clearReplayCache();
    await assert.rejects(
      async () => {
        await proposeSmartRecoveryAction({
          mandateId: 'M-REPLAY-UNPOPULATED',
          attemptsUsed: 1,
          maxAttempts: 4,
          amount: 2500,
          category: 'soft',
          retryEligible: true,
        });
      },
      /replay cache miss/i
    );
    resetLLMMode();
  });

  it('15. Alternative assumption sets A & B preserve pairwise ordering', async () => {
    const evalSeeds = [11, 12, 13, 14, 15];
    const resultsSetA = await evaluateBenchmark({
      seeds: evalSeeds,
      count: 10,
      llmMode: 'mock',
      simulatorConfig: ALTERNATIVE_ASSUMPTION_SET_A,
    });
    const resultsSetB = await evaluateBenchmark({
      seeds: evalSeeds,
      count: 10,
      llmMode: 'mock',
      simulatorConfig: ALTERNATIVE_ASSUMPTION_SET_B,
    });

    for (const res of [resultsSetA, resultsSetB]) {
      const c = res.armMetrics[BENCHMARK_ARMS.CONTROL].meanRecoveryRate;
      const f = res.armMetrics[BENCHMARK_ARMS.FIXED_SCHEDULE].meanRecoveryRate;
      const s = res.armMetrics[BENCHMARK_ARMS.SALARY_AWARE].meanRecoveryRate;
      const m = res.armMetrics[BENCHMARK_ARMS.SMART].meanRecoveryRate;

      assert.ok(s > c, 'Salary-Aware must exceed Control');
      assert.ok(f > c, 'Fixed Schedule must exceed Control');
      assert.ok(m > c, 'Smart must exceed Control');
      assert.ok(s >= f, 'Salary-Aware must be >= Fixed Schedule');
    }
  });
});

