// src/simulators/hiddenTraits.js
//
// Phase 4: Hidden Mandate Traits.
//
// Manages the latent, hidden simulation parameters for simulated mandates:
//   - amount (known to payment system, but modeled as core trait)
//   - salaryDay (hidden from all strategy arms)
//   - balanceDynamics (hidden from all strategy arms)
//   - bankReliability (hidden from all strategy arms)
//
// These traits drive the causal outcome simulator and MUST NOT be exposed
// to any strategy arm (Control, Baseline, Smart) or included in Observations.

import { noise } from './noise.js';
import { SIMULATOR_CONFIG } from '../config/simulatorConfig.js';

/**
 * Derives the hidden, unobservable traits for a mandate from the simulation seed.
 *
 * @param {number} seed - Simulation run seed
 * @param {object|string} mandate - Mandate object or mandate identifier
 * @returns {Readonly<{
 *   mandateId: string,
 *   amount: number,
 *   salaryDay: number,
 *   balanceDynamics: Readonly<{
 *     salaryMultiplier: number,
 *     dailySpendFraction: number,
 *     baselineBufferFraction: number,
 *     volatilityNoiseScale: number,
 *     volatility: number
 *   }>,
 *   bankReliability: number,
 *   bankId: string
 * }>}
 */
export function deriveHiddenTraits(seed, mandate, configOverride = null) {
  if (!mandate) {
    throw new Error('deriveHiddenTraits: mandate is required');
  }

  const config = configOverride || mandate?.config || mandate?.simulatorConfig || SIMULATOR_CONFIG;
  const mandateObj = typeof mandate === 'object' && mandate !== null ? mandate : {};
  const mandateId = mandateObj.mandate_id || mandateObj.id || String(mandate);
  const amount = Number(mandateObj.amount) || 1000;

  // 1. Salary Day (Hidden): integer in [1, 28]
  // If explicitly provided (e.g. from existing DB synthetic record or canary test), respect it;
  // otherwise derive deterministically from seed and mandateId.
  let salaryDay;
  if (mandateObj.salaryDay !== undefined) {
    salaryDay = Number(mandateObj.salaryDay);
  } else if (mandateObj.income_day_of_month !== undefined) {
    salaryDay = Number(mandateObj.income_day_of_month);
  } else {
    const rawVal = noise(seed, mandateId, 0, 'static', 'trait_salary_day');
    salaryDay = Math.floor(rawVal * 28) + 1; // 1 to 28
  }

  // 2. Balance Dynamics (Hidden): volatility, drift, buffer
  const volatility = mandateObj.balance_volatility !== undefined
    ? Number(mandateObj.balance_volatility)
    : noise(seed, mandateId, 0, 'static', 'trait_volatility');

  const balanceDynamics = Object.freeze({
    salaryMultiplier: config.BALANCE.SALARY_MULTIPLIER,
    dailySpendFraction: config.BALANCE.DAILY_SPEND_FRACTION,
    baselineBufferFraction: config.BALANCE.BASELINE_BUFFER_FRACTION,
    volatilityNoiseScale: config.BALANCE.VOLATILITY_NOISE_SCALE,
    volatility: Math.max(0, Math.min(1, volatility)),
  });

  // 3. Bank Reliability (Hidden): uptime probability in [MIN, MAX]
  let bankReliability;
  if (mandateObj.bankReliability !== undefined) {
    bankReliability = Number(mandateObj.bankReliability);
  } else {
    const bankUptimeNoise = noise(seed, mandateId, 0, 'static', 'trait_bank_uptime');
    const range = config.BANK.MAX_UPTIME_PROBABILITY - config.BANK.MIN_UPTIME_PROBABILITY;
    bankReliability = config.BANK.MIN_UPTIME_PROBABILITY + (bankUptimeNoise * range);
  }

  // 4. Bank Identifier: visible category or bank name
  const bankIndex = Math.floor(noise(seed, mandateId, 0, 'static', 'trait_bank_id') * 4) + 1;
  const bankId = mandateObj.bank_id || mandateObj.bankId || `BANK_0${bankIndex}`;

  return Object.freeze({
    mandateId,
    amount,
    salaryDay,
    balanceDynamics,
    bankReliability,
    bankId,
  });
}
