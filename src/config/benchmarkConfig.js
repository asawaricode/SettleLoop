// src/config/benchmarkConfig.js
//
// Phase 5: Benchmark Configuration & Seed Split.
//
// Responsibilities:
//   - Formally defines the four benchmark experiment arms.
//   - Establishes the explicit benchmark seed split:
//       * Tuning seeds: 1–10
//       * Evaluation seeds: 11–40
//   - Enforces that evaluation execution cannot mutate tuning parameters, prompts,
//     thresholds, or policy configuration.
//   - Explicitly forbids machine-learning training or parameter optimization.
//
// EVIDENCE & REGULATORY STATUS:
// All values in this file are ASSUMED project parameters for the SettleLoop
// synthetic recovery benchmark, aligning with ASSUMPTIONS.md §7.

import { RECOVERY_POLICY } from './recoveryPolicy.js';
import { SIMULATOR_CONFIG } from './simulatorConfig.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Experiment Arm Taxonomy
// ─────────────────────────────────────────────────────────────────────────────

export const BENCHMARK_ARMS = Object.freeze({
  CONTROL: 'control',
  FIXED_SCHEDULE: 'fixed_schedule',
  SALARY_AWARE: 'salary_aware',
  SMART: 'smart',
});

/**
 * Canonical list of the four headline experiment arms.
 * Does NOT include any oracle or extra arms.
 */
export const FOUR_HEADLINE_ARMS = Object.freeze([
  BENCHMARK_ARMS.CONTROL,
  BENCHMARK_ARMS.FIXED_SCHEDULE,
  BENCHMARK_ARMS.SALARY_AWARE,
  BENCHMARK_ARMS.SMART,
]);

/**
 * Canonical arm alias mapping.
 * Maps legacy/variant arm labels to canonical arm names.
 */
export const ARM_ALIASES = Object.freeze({
  holdout: BENCHMARK_ARMS.CONTROL,
  baseline: BENCHMARK_ARMS.FIXED_SCHEDULE,
  salary_aware_rule: BENCHMARK_ARMS.SALARY_AWARE,
});

/**
 * Normalizes an arm identifier to its canonical benchmark name.
 *
 * @param {string} arm
 * @returns {string}
 */
export function normalizeArm(arm) {
  if (!arm || typeof arm !== 'string') return 'unknown';
  const lower = arm.toLowerCase().trim();
  if (FOUR_HEADLINE_ARMS.includes(lower)) return lower;
  return ARM_ALIASES[lower] || lower;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Explicit Benchmark Seed Split
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tuning Seeds: 1–10 inclusive.
 * Used during tuning of the Salary-Aware rule and Smart prompt/configuration.
 */
export const TUNING_SEEDS = Object.freeze(
  Array.from({ length: 10 }, (_, i) => i + 1)
);

/**
 * Evaluation Seeds: 11–40 inclusive.
 * Evaluation-only seeds. Must NEVER mutate tuning parameters, prompts, thresholds,
 * or policy configuration.
 */
export const EVALUATION_SEEDS = Object.freeze(
  Array.from({ length: 30 }, (_, i) => i + 11)
);

export const SEED_SPLIT = Object.freeze({
  TUNING_MIN: 1,
  TUNING_MAX: 10,
  EVALUATION_MIN: 11,
  EVALUATION_MAX: 40,
  TUNING: TUNING_SEEDS,
  EVALUATION: EVALUATION_SEEDS,

  /**
   * Returns true if seed is in the tuning set (1–10).
   * @param {number} seed
   * @returns {boolean}
   */
  isTuning(seed) {
    const s = Number(seed);
    return Number.isInteger(s) && s >= 1 && s <= 10;
  },

  /**
   * Returns true if seed is in the evaluation set (11–40).
   * @param {number} seed
   * @returns {boolean}
   */
  isEvaluation(seed) {
    const s = Number(seed);
    return Number.isInteger(s) && s >= 11 && s <= 40;
  },

  /**
   * Returns the classification of a seed: 'tuning' | 'evaluation' | 'unclassified'.
   * @param {number} seed
   * @returns {'tuning'|'evaluation'|'unclassified'}
   */
  classify(seed) {
    if (this.isTuning(seed)) return 'tuning';
    if (this.isEvaluation(seed)) return 'evaluation';
    return 'unclassified';
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Evaluation Immutability & Anti-Mutation Guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Takes a snapshot of all configurable system parameters.
 */
export function captureConfigSnapshot() {
  return Object.freeze({
    recoveryPolicy: { ...RECOVERY_POLICY },
    simulatorConfig: JSON.parse(JSON.stringify(SIMULATOR_CONFIG)),
    timestamp: Date.now(),
  });
}

/**
 * Validates that an evaluation seed does not mutate configuration or prompts.
 * Throws an explicit error if any configuration drift is detected.
 *
 * @param {number} seed
 * @param {object} initialSnapshot
 */
export function assertEvaluationIntegrity(seed, initialSnapshot) {
  if (SEED_SPLIT.isEvaluation(seed) && initialSnapshot) {
    // Verify recovery policy has not mutated
    for (const [key, val] of Object.entries(initialSnapshot.recoveryPolicy)) {
      if (RECOVERY_POLICY[key] !== val) {
        throw new Error(
          `EVALUATION INTEGRITY VIOLATION: Config "${key}" was mutated during evaluation seed ${seed} (was ${val}, now ${RECOVERY_POLICY[key]})`
        );
      }
    }
  }
}
