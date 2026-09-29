// src/evaluation/benchmarkEvaluator.js
//
// Phase 6: Benchmark Evaluation Evidence Engine.
//
// Responsibilities:
//   - Executes the benchmark across frozen evaluation seeds 11–40.
//   - Measures per-seed metrics for all four headline arms:
//       1. Recovery Rate (% mandates recovered)
//       2. Recovered ₹ (SUM across all recovered mandates within each seed)
//       3. Attempts Used (SUM across all mandates in the seed)
//       4. Days to Recovery (CONDITIONAL ON RECOVERY only; no imputation/capping)
//       5. Smart Guardrail Overrides (rejected Smart proposals; strictly 0 for non-Smart)
//       6. Net Value: recovered ₹ − (attempts × assumedRetryFee)
//   - Computes paired per-seed differences for the 4 required pairwise comparisons:
//       * Fixed vs Control (Fixed − Control)
//       * Salary-Aware vs Control (Salary-Aware − Control)
//       * Smart vs Control (Smart − Control)
//       * Smart vs Salary-Aware (Smart − Salary-Aware)
//   - Applies the universal 95% Confidence Interval method:
//       mean difference ± t-critical(df=29, 95%) × standard error
//   - Computes Break-Even Fee for each non-control arm:
//       (meanRecoveredINR[arm] - meanRecoveredINR[control]) / (meanAttempts[arm] - meanAttempts[control])
//   - Verifies evaluation immutability and byte-identical reproducibility.
//
// EVIDENCE & REGULATORY STATUS:
// All values and formulas are ASSUMED benchmark evaluation parameters aligning
// with ASSUMPTIONS.md §7, §12, and §13.

import {
  FOUR_HEADLINE_ARMS,
  BENCHMARK_ARMS,
  EVALUATION_SEEDS,
  assumedRetryFee,
  assertEvaluationIntegrity,
  captureConfigSnapshot,
} from '../config/benchmarkConfig.js';

import { runPairedBenchmark } from '../recovery/benchmarkRunner.js';

/**
 * Student's t critical value for df = 29 at two-tailed 95% confidence (alpha = 0.05).
 * Exact standard statistical value: t_{0.025, 29} = 2.045229638...
 */
export const T_CRITICAL_DF29_95 = 2.045229638;

/**
 * Rounds a number to a fixed number of decimal places (default 4).
 * Handles finite number checking.
 *
 * @param {number|null|undefined} val
 * @param {number} [decimals=4]
 * @returns {number|null}
 */
export function round(val, decimals = 4) {
  if (val === null || val === undefined || !Number.isFinite(val)) return null;
  const factor = Math.pow(10, decimals);
  const rounded = Math.round(val * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Calculates mean, sample standard deviation, standard error, and 95% CI
 * for an array of paired per-seed differences.
 *
 * Formula:
 *   mean diff = (1/N) * sum(d_i)
 *   sample variance = (1/(N-1)) * sum((d_i - mean)^2)
 *   standard error = sqrt(sample variance / N)
 *   margin of error = t_critical(df=N-1, 95%) * standard error
 *   95% CI = [mean - margin of error, mean + margin of error]
 *
 * @param {Array<number>} diffArray - Array of paired differences
 * @param {number} [tCritical=T_CRITICAL_DF29_95]
 * @returns {{
 *   mean: number,
 *   stdDev: number,
 *   standardError: number,
 *   df: number,
 *   tCritical: number,
 *   marginOfError: number,
 *   ci95: [number, number]
 * }}
 */
export function computePairedCI(diffArray, tCritical = T_CRITICAL_DF29_95) {
  const n = diffArray.length;
  if (n === 0) {
    return null;
  }
  if (n === 1) {
    return {
      mean: round(diffArray[0], 4),
      stdDev: 0,
      standardError: 0,
      df: 0,
      tCritical: round(tCritical, 6),
      marginOfError: 0,
      ci95: [round(diffArray[0], 4), round(diffArray[0], 4)],
    };
  }

  const mean = diffArray.reduce((acc, v) => acc + v, 0) / n;
  const variance = diffArray.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  const standardError = stdDev / Math.sqrt(n);
  const marginOfError = tCritical * standardError;

  return {
    mean: round(mean, 4),
    stdDev: round(stdDev, 4),
    standardError: round(standardError, 4),
    df: n - 1,
    tCritical: round(tCritical, 6),
    marginOfError: round(marginOfError, 4),
    ci95: [round(mean - marginOfError, 4), round(mean + marginOfError, 4)],
  };
}

/**
 * Computes the break-even fee for a non-control arm against the Control arm.
 *
 * Break-even condition:
 *   Mean Net Value(Arm) = Mean Net Value(Control)
 *   Mean Recovered INR(Arm) - Mean Attempts(Arm) * Fee = Mean Recovered INR(Control) - Mean Attempts(Control) * Fee
 *
 * Solving for Fee:
 *   Fee * (Mean Attempts(Arm) - Mean Attempts(Control)) = Mean Recovered INR(Arm) - Mean Recovered INR(Control)
 *   Break-even Fee = (Mean Recovered INR(Arm) - Mean Recovered INR(Control)) / (Mean Attempts(Arm) - Mean Attempts(Control))
 *
 * @param {number} meanRecoveredArm - Mean recovered ₹ for the arm
 * @param {number} meanRecoveredControl - Mean recovered ₹ for Control
 * @param {number} meanAttemptsArm - Mean attempts for the arm
 * @param {number} meanAttemptsControl - Mean attempts for Control
 * @returns {{
 *   formula: string,
 *   breakEvenFeeINR: number
 * }}
 */
export function computeBreakEvenFee(
  meanRecoveredArm,
  meanRecoveredControl,
  meanAttemptsArm,
  meanAttemptsControl
) {
  const deltaRecovered = meanRecoveredArm - meanRecoveredControl;
  const deltaAttempts = meanAttemptsArm - meanAttemptsControl;

  const formula = '(meanRecoveredINR[arm] - meanRecoveredINR[control]) / (meanAttempts[arm] - meanAttempts[control])';

  if (deltaAttempts === 0) {
    return {
      formula,
      breakEvenFeeINR: 0,
      deltaRecovered: round(deltaRecovered, 2),
      deltaAttempts: 0,
    };
  }

  const fee = deltaRecovered / deltaAttempts;
  return {
    formula,
    breakEvenFeeINR: round(fee, 2),
    deltaRecovered: round(deltaRecovered, 2),
    deltaAttempts: round(deltaAttempts, 4),
  };
}

/**
 * Runs the comprehensive Phase 6 evaluation across evaluation seeds 11–40.
 *
 * @param {object} [options]
 * @param {Array<number>} [options.seeds=EVALUATION_SEEDS] - Evaluation seeds (default 11–40)
 * @param {number} [options.count=10] - Mandates per seed
 * @param {number} [options.maxDays=14] - Simulation horizon
 * @param {'mock'|'replay'|'live'} [options.llmMode='mock'] - Smart LLM execution mode
 * @param {number} [options.retryFee=assumedRetryFee] - Assumed fee per retry attempt (₹)
 *
 * @returns {Promise<{
 *   metadata: {
 *     evaluationSeeds: Array<number>,
 *     seedCount: number,
 *     mandatesPerSeed: number,
 *     totalMandatesEvaluated: number,
 *     llmMode: string,
 *     assumedRetryFeeINR: number,
 *     tCriticalDf29: number
 *   },
 *   armMetrics: Record<string, {
 *     meanRecoveryRate: number,
 *     meanRecoveredINR: number,
 *     meanAttempts: number,
 *     meanDaysToRecoveryConditional: number,
 *     totalGuardrailOverrides: number,
 *     meanNetValueINR: number,
 *     rawSeedAverages: object
 *   }>,
 *   pairwiseComparisons: Record<string, Record<string, {
 *     meanDiff: number,
 *     stdDev: number,
 *     standardError: number,
 *     df: number,
 *     marginOfError: number,
 *     ci95: [number, number]
 *   }>>,
 *   netValueAnalysis: {
 *     assumedFeeINR: number,
 *     armsNetValue: Record<string, number>,
 *     breakEvenFeesINR: Record<string, {
 *       formula: string,
 *       breakEvenFeeINR: number,
 *       deltaRecoveredINR: number,
 *       deltaAttempts: number
 *     }>
 *   },
 *   seedLevelData: Array<object>
 * }>}
 */
export async function evaluateBenchmark({
  seeds = EVALUATION_SEEDS,
  count = 10,
  maxDays = 14,
  llmMode = 'mock',
  retryFee = assumedRetryFee,
  includeTimestamp = false,
  simulatorConfig = null,
} = {}) {
  // 1. Validate that all provided seeds are evaluation seeds
  for (const seed of seeds) {
    if (seed < 11 || seed > 40) {
      throw new Error(`EVALUATION INTEGRITY ERROR: Seed ${seed} is not in frozen evaluation range 11–40`);
    }
  }

  // 2. Capture anti-mutation snapshot
  const initialSnapshot = captureConfigSnapshot();

  const seedLevelData = [];

  // 3. Execute all 4 arms for each evaluation seed
  for (const seed of seeds) {
    const benchResult = await runPairedBenchmark({
      seed,
      count,
      maxDays,
      llmMode,
      simulatorConfig,
    });

    // Extract per-seed metrics for each arm
    const perSeedArmData = {};

    for (const arm of FOUR_HEADLINE_ARMS) {
      const armMandates = benchResult.resultsByArm[arm];
      const recoveredMandates = armMandates.filter((m) => m.finalStatus === 'recovered');

      // 1. Recovery rate (% mandates recovered)
      const recoveryRate = recoveredMandates.length / armMandates.length;

      // 2. Recovered ₹ (SUM across all mandates within each seed)
      const recoveredINR = recoveredMandates.reduce((sum, m) => sum + (m.amount || 0), 0);

      // 3. Attempts used (SUM of attempts across all mandates in the seed)
      const attemptsUsed = armMandates.reduce((sum, m) => sum + m.attemptsCount, 0);

      // 4. Days to recovery (CONDITIONAL ON RECOVERY: only mandates that recovered)
      //    Explicitly conditional on recovery; do not impute or include unrecovered mandates.
      const recoveryDayList = recoveredMandates
        .filter((m) => m.recoveryDay !== null)
        .map((m) => m.daysToRecovery !== null ? m.daysToRecovery : (m.recoveryDay - 1));

      const daysToRecovery =
        recoveryDayList.length > 0
          ? recoveryDayList.reduce((acc, d) => acc + d, 0) / recoveryDayList.length
          : null;

      // 5. Smart guardrail overrides
      const guardrailOverrides = armMandates.reduce((sum, m) => sum + (m.guardrailOverrides || 0), 0);

      // Invariant check: non-Smart arms must never produce guardrail rejections
      if (arm !== BENCHMARK_ARMS.SMART && guardrailOverrides > 0) {
        throw new Error(`CRITICAL CODE DEFECT: Non-Smart arm "${arm}" produced ${guardrailOverrides} guardrail overrides on seed ${seed}`);
      }

      // 6. Net value: recovered ₹ − (attempts × assumedRetryFee)
      const netValue = recoveredINR - attemptsUsed * retryFee;

      perSeedArmData[arm] = {
        recoveryRate,
        recoveredINR,
        attemptsUsed,
        daysToRecovery,
        guardrailOverrides,
        netValue,
      };
    }

    seedLevelData.push({
      seed,
      arms: perSeedArmData,
    });

    // Check configuration immutability
    assertEvaluationIntegrity(seed, initialSnapshot);
  }

  // 4. Compute Arm-level Summaries across all evaluation seeds
  const armMetrics = {};
  const N = seedLevelData.length;

  for (const arm of FOUR_HEADLINE_ARMS) {
    const recoveryRates = seedLevelData.map((s) => s.arms[arm].recoveryRate);
    const recoveredINRs = seedLevelData.map((s) => s.arms[arm].recoveredINR);
    const attemptsList = seedLevelData.map((s) => s.arms[arm].attemptsUsed);
    const netValues = seedLevelData.map((s) => s.arms[arm].netValue);
    const overridesList = seedLevelData.map((s) => s.arms[arm].guardrailOverrides);

    // Days to recovery conditional on recovery across seeds
    const daysList = seedLevelData
      .map((s) => s.arms[arm].daysToRecovery)
      .filter((d) => d !== null);

    const meanRecoveryRate = recoveryRates.reduce((a, b) => a + b, 0) / N;
    const meanRecoveredINR = recoveredINRs.reduce((a, b) => a + b, 0) / N;
    const meanAttempts = attemptsList.reduce((a, b) => a + b, 0) / N;
    const meanNetValue = netValues.reduce((a, b) => a + b, 0) / N;
    const totalGuardrailOverrides = overridesList.reduce((a, b) => a + b, 0);

    const meanDaysToRecoveryConditional =
      daysList.length > 0 ? daysList.reduce((a, b) => a + b, 0) / daysList.length : 0;

    armMetrics[arm] = {
      meanRecoveryRate: round(meanRecoveryRate, 4),
      meanRecoveredINR: round(meanRecoveredINR, 2),
      meanAttempts: round(meanAttempts, 4), // Total attempts per seed across all mandates (e.g. 10 mandates)
      meanAttemptsPerMandate: round(meanAttempts / count, 4), // Per-mandate mean attempts (1 initial + retries)
      meanRecoveryRetries: round(Math.max(0, meanAttempts - count), 4), // Total recovery retries per seed (0 for Control)
      meanDaysToRecoveryConditional: round(meanDaysToRecoveryConditional, 4),
      totalGuardrailOverrides,
      meanNetValueINR: round(meanNetValue, 2),
      rawSeries: {
        recoveryRates,
        recoveredINRs,
        attemptsList,
        daysList,
        netValues,
      },
    };
  }

  // 5. Compute the 4 Required Pairwise Comparisons
  //    - Fixed vs Control (Fixed − Control)
  //    - Salary-Aware vs Control (Salary-Aware − Control)
  //    - Smart vs Control (Smart − Control)
  //    - Smart vs Salary-Aware (Smart − Salary-Aware)
  const comparisonPairs = [
    { key: 'fixed_vs_control', armA: BENCHMARK_ARMS.FIXED_SCHEDULE, armB: BENCHMARK_ARMS.CONTROL, label: 'Fixed vs Control' },
    { key: 'salary_aware_vs_control', armA: BENCHMARK_ARMS.SALARY_AWARE, armB: BENCHMARK_ARMS.CONTROL, label: 'Salary-Aware vs Control' },
    { key: 'smart_vs_control', armA: BENCHMARK_ARMS.SMART, armB: BENCHMARK_ARMS.CONTROL, label: 'Smart vs Control' },
    { key: 'smart_vs_salary_aware', armA: BENCHMARK_ARMS.SMART, armB: BENCHMARK_ARMS.SALARY_AWARE, label: 'Smart vs Salary-Aware' },
  ];

  const pairwiseComparisons = {};

  for (const { key, armA, armB, label } of comparisonPairs) {
    const diffsRecoveryRate = seedLevelData.map(
      (s) => s.arms[armA].recoveryRate - s.arms[armB].recoveryRate
    );
    const diffsRecoveredINR = seedLevelData.map(
      (s) => s.arms[armA].recoveredINR - s.arms[armB].recoveredINR
    );
    const diffsAttempts = seedLevelData.map(
      (s) => s.arms[armA].attemptsUsed - s.arms[armB].attemptsUsed
    );
    const diffsNetValue = seedLevelData.map(
      (s) => s.arms[armA].netValue - s.arms[armB].netValue
    );

    // Days to recovery conditional on recovery: per-seed paired diff where both seeds had recoveries
    const validDaysDiffs = seedLevelData
      .filter((s) => s.arms[armA].daysToRecovery !== null && s.arms[armB].daysToRecovery !== null)
      .map((s) => s.arms[armA].daysToRecovery - s.arms[armB].daysToRecovery);

    // Guardrail overrides diff
    const diffsGuardrailOverrides = seedLevelData.map(
      (s) => s.arms[armA].guardrailOverrides - s.arms[armB].guardrailOverrides
    );

    pairwiseComparisons[key] = {
      label,
      armA,
      armB,
      recoveryRate: computePairedCI(diffsRecoveryRate),
      recoveredINR: computePairedCI(diffsRecoveredINR),
      attemptsUsed: computePairedCI(diffsAttempts),
      daysToRecoveryConditional: validDaysDiffs.length >= 2 ? computePairedCI(validDaysDiffs) : null,
      guardrailOverrides: computePairedCI(diffsGuardrailOverrides),
      netValue: computePairedCI(diffsNetValue),
    };
  }

  // 6. Net Value & Break-Even Fee Analysis
  const controlRecoveredINR = armMetrics[BENCHMARK_ARMS.CONTROL].meanRecoveredINR;
  const controlAttempts = armMetrics[BENCHMARK_ARMS.CONTROL].meanAttempts;

  const breakEvenFeesINR = {};
  const nonControlArms = [
    BENCHMARK_ARMS.FIXED_SCHEDULE,
    BENCHMARK_ARMS.SALARY_AWARE,
    BENCHMARK_ARMS.SMART,
  ];

  for (const arm of nonControlArms) {
    breakEvenFeesINR[arm] = computeBreakEvenFee(
      armMetrics[arm].meanRecoveredINR,
      controlRecoveredINR,
      armMetrics[arm].meanAttempts,
      controlAttempts
    );
  }

  const armsNetValue = {};
  for (const arm of FOUR_HEADLINE_ARMS) {
    armsNetValue[arm] = armMetrics[arm].meanNetValueINR;
  }

  return {
    metadata: {
      evaluationSeeds: [...seeds],
      seedCount: seeds.length,
      mandatesPerSeed: count,
      totalMandatesEvaluated: seeds.length * count,
      llmMode,
      assumedRetryFeeINR: retryFee,
      tCriticalDf29: T_CRITICAL_DF29_95,
      ...(includeTimestamp ? { evaluatedAt: new Date().toISOString() } : {}),
    },
    armMetrics,
    pairwiseComparisons,
    netValueAnalysis: {
      assumedFeeINR: retryFee,
      armsNetValue,
      breakEvenFeesINR,
    },
    seedLevelData,
  };
}
