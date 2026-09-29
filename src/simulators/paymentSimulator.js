// src/simulators/paymentSimulator.js
//
// Phase 4: Causal Payment Simulator.
//
// Replaces the non-causal hash-only thresholding with an explicit causal outcome
// model driven by latent customer balance dynamics, bank availability, and decline taxonomy.
//
// CAUSAL OUTCOME TAXONOMY:
// Every simulated payment attempt produces an outcome from explicit causes:
//   1. 'hard_decline'            - Permanent account/mandate revocation (unrecoverable)
//   2. 'unknown_decline'         - Gateway timeout or unmapped error (non-retryable)
//   3. 'transient_bank_failure'  - Core banking infrastructure temporarily degraded (soft)
//   4. 'insufficient_funds'      - Available balance on simulation day < mandate amount (soft)
//   5. 'successful_recovery'     - Bank available + available balance >= amount (success)
//
// DETERMINISTIC SHARED SEEDED NOISE:
// Uses noise(seed, mandate, day, slot, purpose) so all arms receive identical
// simulated luck under paired comparisons.

import { noise } from './noise.js';
import { deriveHiddenTraits } from './hiddenTraits.js';
import { buildObservation } from './observation.js';
import { SIMULATOR_CONFIG } from '../config/simulatorConfig.js';

export { noise, deriveHiddenTraits, buildObservation, SIMULATOR_CONFIG };

/**
 * Validates inputs for payment simulation.
 */
function validateSimulatorInputs({ seed, mandateId, attemptNumber, amount }) {
  if (seed === undefined || seed === null || !Number.isFinite(Number(seed))) {
    throw new Error('paymentSimulator: seed must be a finite number');
  }
  if (!mandateId || typeof mandateId !== 'string' || mandateId.trim() === '') {
    throw new Error('paymentSimulator: mandateId must be a non-empty string');
  }
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error('paymentSimulator: attemptNumber must be a positive integer');
  }
  if (!Number.isFinite(amount) || amount < 100 || amount > 50000) {
    throw new Error(`paymentSimulator: amount must be a finite number in [100, 50000], got ${amount}`);
  }
}

/**
 * Simulates a payment attempt using the Causal Outcome Model.
 *
 * @param {object} params
 * @param {number} params.seed                  - Simulation run random_seed (uint32)
 * @param {object} [params.mandate]             - Mandate record (optional if flat params passed)
 * @param {string} [params.mandateId]           - Mandate identifier
 * @param {number} params.attemptNumber         - 1-based attempt counter (positive integer)
 * @param {number} [params.amount]              - Mandate amount in INR
 * @param {number} [params.currentDay=1]        - Virtual simulation clock day
 * @param {string|number} [params.slot='default'] - Execution slot (e.g. '14:00', 'morning')
 * @param {number} [params.balanceVolatility]   - Hidden volatility trait (if passing raw record)
 * @param {number} [params.incomeDayOfMonth]    - Hidden salary day trait (if passing raw record)
 *
 * @returns {{
 *   outcome: 'success' | 'failure',
 *   declineCode: string | null,
 *   declineCategory: 'soft' | 'hard' | 'unknown' | null,
 *   retryEligible: boolean | null,
 *   cause: 'successful_recovery' | 'transient_bank_failure' | 'insufficient_funds' | 'hard_decline' | 'unknown_decline',
 *   availableBalance?: number
 * }}
 */
export function simulatePayment(params = {}, configOverride = null) {
  const config = configOverride || params.config || params.simulatorConfig || SIMULATOR_CONFIG;
  const mandateObj = params.mandate ?? {};
  const mandateId = params.mandateId ?? mandateObj.mandate_id ?? mandateObj.id;
  const attemptNumber = Number(params.attemptNumber ?? 1);
  const amount = Number(params.amount ?? mandateObj.amount ?? 1000);
  const seed = Number(params.seed);
  const currentDay = Number(params.currentDay ?? params.day ?? 1);
  const slot = params.slot ?? 'default';

  // 1. Validate required inputs
  validateSimulatorInputs({ seed, mandateId, attemptNumber, amount });

  // 2. Derive hidden traits (latent parameters: salaryDay, balanceDynamics, bankReliability)
  const inputForTraits = params.mandate ?? {
    mandate_id: mandateId,
    amount,
    balance_volatility: params.balanceVolatility,
    income_day_of_month: params.incomeDayOfMonth,
    salaryDay: params.salaryDay,
    bankReliability: params.bankReliability,
    bank_id: params.bankId,
  };

  const traits = deriveHiddenTraits(seed, inputForTraits, config);

  // ── CAUSAL EVALUATION ─────────────────────────────────────────────────────

  // Step A: Other Decline Taxonomy (Hard / Unknown Decline)
  // Evaluates independent permanent failure causes (e.g. account closed, mandate cancelled)
  const otherNoise = noise(seed, traits.mandateId, currentDay, slot, 'other_decline');
  if (otherNoise < config.OTHER_DECLINES.HARD_DECLINE_RATE) {
    return {
      outcome: 'failure',
      declineCode: config.OTHER_DECLINES.HARD_DECLINE_CODE,
      declineCategory: 'hard',
      retryEligible: false,
      cause: 'hard_decline',
    };
  }

  if (
    otherNoise <
    config.OTHER_DECLINES.HARD_DECLINE_RATE +
      config.OTHER_DECLINES.UNKNOWN_DECLINE_RATE
  ) {
    return {
      outcome: 'failure',
      declineCode: config.OTHER_DECLINES.UNKNOWN_DECLINE_CODE,
      declineCategory: 'unknown',
      retryEligible: false,
      cause: 'unknown_decline',
    };
  }

  // Step B: Transient Bank Availability
  // Evaluates whether the banking channel or NPCI/issuer switch is experiencing a transient outage
  const bankNoise = noise(seed, traits.mandateId, currentDay, slot, 'bank_uptime');
  if (bankNoise > traits.bankReliability) {
    return {
      outcome: 'failure',
      declineCode: config.BANK.DOWN_DECLINE_CODE,
      declineCategory: 'soft',
      retryEligible: true,
      cause: 'transient_bank_failure',
    };
  }

  // Step C: Causal Customer Balance Dynamics
  // Models salary credit jumps, day-to-day spending drift, and volatility noise shocks
  const daysSinceSalary = (currentDay - traits.salaryDay + 28) % 28;
  const salaryJump = traits.amount * traits.balanceDynamics.salaryMultiplier;
  const spent = daysSinceSalary * (traits.amount * traits.balanceDynamics.dailySpendFraction);
  const baselineBuffer = traits.amount * traits.balanceDynamics.baselineBufferFraction;

  const shockNoise = noise(seed, traits.mandateId, currentDay, slot, 'balance_shock');
  const shock =
    (shockNoise - 0.5) *
    2 *
    (traits.balanceDynamics.volatility *
      traits.balanceDynamics.volatilityNoiseScale *
      salaryJump);

  const availableBalance = Math.max(0, salaryJump - spent + baselineBuffer + shock);

  if (availableBalance < traits.amount) {
    return {
      outcome: 'failure',
      declineCode: config.BALANCE.INSUFFICIENT_FUNDS_CODE,
      declineCategory: 'soft',
      retryEligible: true,
      cause: 'insufficient_funds',
      availableBalance,
    };
  }

  // Step D: Successful Debit / Recovery
  // Bank is operational, mandate is in good standing, and customer has sufficient balance
  return {
    outcome: 'success',
    declineCode: null,
    declineCategory: null,
    retryEligible: null,
    cause: 'successful_recovery',
    availableBalance,
  };
}
