// src/recovery/benchmarkRunner.js
//
// Phase 5: Paired Benchmark Simulation Runner.
//
// Responsibilities:
//   - Executes the four headline benchmark arms against identical seeded populations:
//       1. Control / Holdout
//       2. Fixed Schedule
//       3. Salary-Aware Rule
//       4. Smart
//   - Strictly enforces the benchmark seed split:
//       * Tuning seeds: 1–10
//       * Evaluation seeds: 11–40
//   - Verifies evaluation immutability: evaluation execution NEVER mutates tuning
//     parameters, prompts, thresholds, or policy configurations.
//   - Enforces Arm Isolation:
//       * No arm receives hidden simulator traits.
//       * All arms share the identical causal simulator noise stream under paired comparison.
//       * Control performs zero recovery retries.
//       * Failed recovery cycle exhausts rather than auto-cancelling the mandate.
//       * Phase 2 guardrails remain strictly enforced across all arms.
//
// EVIDENCE & REGULATORY STATUS:
// All values are ASSUMED project parameters for the SettleLoop synthetic
// recovery benchmark, aligning with ASSUMPTIONS.md §7.

import {
  BENCHMARK_ARMS,
  FOUR_HEADLINE_ARMS,
  SEED_SPLIT,
  captureConfigSnapshot,
  assertEvaluationIntegrity,
} from '../config/benchmarkConfig.js';

import {
  simulatePayment,
  noise,
  deriveHiddenTraits,
} from '../simulators/paymentSimulator.js';

import { buildObservation } from '../simulators/observation.js';
import { decideControlAction } from './controlPolicy.js';
import { decideFixedScheduleAction } from './baselinePolicy.js';
import { decideSalaryAwareAction } from './salaryAwarePolicy.js';
import { proposeSmartRecoveryAction } from './smartAgent.js';
import { validateGuardrails } from './guardrails.js';
import { MAX_ATTEMPTS, MAX_DELAY_DAYS } from '../config/recoveryPolicy.js';

/**
 * Generates a deterministic public starting mandate population for a given seed.
 * Does NOT attach hidden simulator traits to the public mandate object.
 *
 * @param {object} params
 * @param {number} params.seed - Simulation run seed
 * @param {number} [params.count=10] - Number of mandates in the population
 * @returns {Array<object>} Public mandate population
 */
export function generateBenchmarkPopulation({ seed, count = 10 }) {
  const population = [];

  for (let i = 0; i < count; i++) {
    const mandateId = `M-BENCH-${seed}-${String(i + 1).padStart(3, '0')}`;
    const amountNoise = noise(seed, mandateId, 0, 'static', 'amount');
    const amount = Math.floor(amountNoise * 4000) + 500; // 500 to 4500

    const bankIndex = Math.floor(noise(seed, mandateId, 0, 'static', 'trait_bank_id') * 4) + 1;
    const bankId = `BANK_0${bankIndex}`;

    // Exposed noisy payday hint (Phase 4 Observation property)
    const hintNoise = noise(seed, mandateId, 0, 'static', 'payday_hint');
    const hasHint = hintNoise > 0.15; // 85% of mandates have a payday hint
    const noisyPaydayHint = hasHint ? Math.floor(hintNoise * 28) + 1 : null;

    population.push(
      Object.freeze({
        mandateId,
        amount,
        bankId,
        firstDueDay: 1,
        noisyPaydayHint,
        contactConsent: true,
        status: 'pending',
        attemptsUsed: 0,
      })
    );
  }

  return Object.freeze(population);
}

/**
 * Simulates a single mandate through an experiment arm's lifecycle.
 *
 * @param {object} params
 * @param {string} params.arm - One of FOUR_HEADLINE_ARMS
 * @param {object} params.mandate - Public starting mandate record
 * @param {number} params.seed - Simulation run seed
 * @param {number} [params.maxDays=14] - Simulation horizon in days
 * @param {string} [params.llmMode='mock'] - LLM execution mode for Smart arm
 * @returns {Promise<{
 *   mandateId: string,
 *   arm: string,
 *   finalStatus: 'recovered' | 'exhausted' | 'stood_down',
 *   attemptsCount: number,
 *   recoveryDay: number | null,
 *   attempts: Array<object>,
 *   hiddenTraitsAccessed: boolean
 * }>}
 */
export async function simulateMandateArm({
  arm,
  mandate,
  seed,
  maxDays = 14,
  llmMode = 'mock',
}) {
  let currentDay = mandate.firstDueDay || 1;
  let attemptsUsed = 0;
  let finalStatus = 'pending';
  let recoveryDay = null;
  const attempts = [];
  const attemptHistory = [];
  let nextAction = 'retry';
  let nextActionDay = currentDay;

  while (currentDay <= maxDays && nextAction === 'retry' && attemptsUsed < MAX_ATTEMPTS) {
    if (nextActionDay > currentDay) {
      currentDay = nextActionDay;
      if (currentDay > maxDays) break;
    }

    const attemptNumber = attemptsUsed + 1;

    // Simulate payment using causal outcome simulator and shared seeded noise
    const simResult = simulatePayment({
      seed,
      mandateId: mandate.mandateId,
      attemptNumber,
      amount: mandate.amount,
      currentDay,
      slot: '14:00', // Non-peak slot
    });

    attemptsUsed++;

    const attemptRecord = {
      attemptNumber,
      day: currentDay,
      outcome: simResult.outcome,
      declineCode: simResult.declineCode,
      declineCategory: simResult.declineCategory,
      retryEligible: simResult.retryEligible,
      cause: simResult.cause,
    };
    attempts.push(attemptRecord);
    attemptHistory.push(attemptRecord);

    if (simResult.outcome === 'success') {
      finalStatus = 'recovered';
      recoveryDay = currentDay;
      nextAction = 'none';
      break;
    }

    // Attempt failed: Build strictly allowlisted public Observation
    const observation = buildObservation({
      mandate: {
        mandate_id: mandate.mandateId,
        amount: mandate.amount,
        bank_id: mandate.bankId,
        attempts_used: attemptsUsed,
        status: 'pending',
        noisyPaydayHint: mandate.noisyPaydayHint,
      },
      currentDay,
      attemptHistory,
    });

    // Enforce hidden trait shield: verify observation contains NO hidden traits
    if ('salaryDay' in observation || 'balanceDynamics' in observation || 'bankReliability' in observation) {
      throw new Error(`CRITICAL ARM ISOLATION FAILURE: Hidden traits leaked into Observation for arm ${arm}`);
    }

    // Policy Decision based on Arm
    let decision;

    switch (arm) {
      case BENCHMARK_ARMS.CONTROL: {
        // Control performs ZERO recovery retries
        decision = decideControlAction(observation, {
          category: simResult.declineCategory,
          retryEligible: simResult.retryEligible,
        });
        break;
      }

      case BENCHMARK_ARMS.FIXED_SCHEDULE: {
        decision = decideFixedScheduleAction(observation, {
          category: simResult.declineCategory,
          retryEligible: simResult.retryEligible,
        });
        break;
      }

      case BENCHMARK_ARMS.SALARY_AWARE: {
        decision = decideSalaryAwareAction(observation, {
          category: simResult.declineCategory,
          retryEligible: simResult.retryEligible,
        });
        break;
      }

      case BENCHMARK_ARMS.SMART: {
        const smartProposal = await proposeSmartRecoveryAction({
          observation,
          category: simResult.declineCategory || 'soft',
          retryEligible: simResult.retryEligible ?? true,
          declineCode: simResult.declineCode,
          benchmark: true,
          deterministic: true,
        });

        // Evaluate guardrails on Smart AI proposal
        const guardrailResult = validateGuardrails({
          proposal: smartProposal,
          mandate: {
            id: mandate.mandateId,
            status: 'pending',
            attempts_used: attemptsUsed,
            contact_consent: true,
          },
          failure: {
            category: simResult.declineCategory || 'soft',
            retryEligible: simResult.retryEligible ?? true,
          },
          currentDay,
        });

        decision = {
          action: guardrailResult.action,
          delayDays: smartProposal.retryDelayDays ?? smartProposal.delayDays ?? 2,
          reasoning: smartProposal.reasoning,
        };
        break;
      }

      default:
        throw new Error(`simulateMandateArm: unsupported arm "${arm}"`);
    }

    // State transitions based on decision
    if (decision.action === 'stand_down') {
      finalStatus = 'stood_down';
      nextAction = 'none';
      break;
    }

    if (decision.action === 'exhausted' || attemptsUsed >= MAX_ATTEMPTS) {
      finalStatus = 'exhausted';
      nextAction = 'none';
      break;
    }

    if (decision.action === 'retry') {
      const delay = Math.max(1, Math.min(MAX_DELAY_DAYS, Number(decision.delayDays) || 1));
      nextActionDay = currentDay + delay;
      nextAction = 'retry';
    }
  }

  if (finalStatus === 'pending') {
    finalStatus = attemptsUsed >= MAX_ATTEMPTS ? 'exhausted' : 'stood_down';
  }

  return {
    mandateId: mandate.mandateId,
    arm,
    finalStatus,
    attemptsCount: attemptsUsed,
    recoveryDay,
    attempts,
    hiddenTraitsAccessed: false,
  };
}

/**
 * Runs a complete paired 4-arm benchmark run for a given seed.
 *
 * @param {object} params
 * @param {number} params.seed - Simulation run seed (Tuning: 1–10, Evaluation: 11–40)
 * @param {number} [params.count=10] - Number of mandates per arm
 * @param {number} [params.maxDays=14] - Simulation horizon in days
 * @param {string} [params.llmMode='mock'] - LLM execution mode ('mock' | 'replay' | 'live')
 * @returns {Promise<{
 *   seed: number,
 *   seedType: 'tuning' | 'evaluation' | 'unclassified',
 *   arms: Record<string, {
 *     mandateCount: number,
 *     recoveredCount: number,
 *     recoveryRate: number,
 *     totalAttempts: number,
 *     attemptsPerMandate: number,
 *     averageTimeToRecovery: number
 *   }>,
 *   populationSize: number,
 *   resultsByArm: Record<string, Array<object>>
 * }>}
 */
export async function runPairedBenchmark({
  seed,
  count = 10,
  maxDays = 14,
  llmMode = 'mock',
}) {
  if (seed === undefined || seed === null || !Number.isFinite(Number(seed))) {
    throw new Error('runPairedBenchmark: seed must be a finite number');
  }

  const numericSeed = Number(seed);
  const seedType = SEED_SPLIT.classify(numericSeed);

  // Anti-mutation snapshot if evaluation seed
  const initialConfigSnapshot = captureConfigSnapshot();

  // 1. Generate identical starting population for all 4 arms
  const population = generateBenchmarkPopulation({ seed: numericSeed, count });

  const resultsByArm = {};
  const armsMetrics = {};

  // 2. Execute each of the four headline arms against the identical population
  for (const arm of FOUR_HEADLINE_ARMS) {
    const armResults = [];

    for (const mandate of population) {
      const mandateResult = await simulateMandateArm({
        arm,
        mandate,
        seed: numericSeed,
        maxDays,
        llmMode,
      });
      armResults.push(mandateResult);
    }

    resultsByArm[arm] = armResults;

    const recoveredCount = armResults.filter((r) => r.finalStatus === 'recovered').length;
    const totalAttempts = armResults.reduce((sum, r) => sum + r.attemptsCount, 0);
    const recoveryDays = armResults.filter((r) => r.recoveryDay !== null).map((r) => r.recoveryDay - 1);
    const avgTimeToRecovery =
      recoveryDays.length > 0
        ? Number((recoveryDays.reduce((a, b) => a + b, 0) / recoveryDays.length).toFixed(4))
        : 0;

    armsMetrics[arm] = {
      mandateCount: armResults.length,
      recoveredCount,
      recoveryRate: Number((recoveredCount / armResults.length).toFixed(4)),
      totalAttempts,
      attemptsPerMandate: Number((totalAttempts / armResults.length).toFixed(4)),
      averageTimeToRecovery: avgTimeToRecovery,
    };
  }

  // 3. Evaluation seed integrity check: ensure no configuration mutated
  if (seedType === 'evaluation') {
    assertEvaluationIntegrity(numericSeed, initialConfigSnapshot);
  }

  return {
    seed: numericSeed,
    seedType,
    arms: armsMetrics,
    populationSize: population.length,
    resultsByArm,
  };
}
