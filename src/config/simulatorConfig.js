// src/config/simulatorConfig.js
//
// Phase 4: Causal Simulator Configuration.
//
// Centralizes all parameters, formulas, and probabilities for the synthetic
// causal payment recovery benchmark.
//
// REGULATORY & EVIDENCE STATUS:
// All values in this configuration are ASSUMED project parameters for the SettleLoop
// synthetic benchmark, aligning with ASSUMPTIONS.md §7.
// No real-world percentages or bank decline rates are claimed.

export const SIMULATOR_CONFIG = Object.freeze({
  // ── Bank Reliability Parameters ──────────────────────────────────────────
  // ASSUMED: synthetic bank availability rate for transient failure modeling.
  // Real-world bank decline rates vary widely by bank and product.
  BANK: Object.freeze({
    DEFAULT_UPTIME_PROBABILITY: 0.95,      // ASSUMED — 95% default bank uptime
    MIN_UPTIME_PROBABILITY: 0.90,          // ASSUMED — lower bound for unreliable banks
    MAX_UPTIME_PROBABILITY: 0.98,          // ASSUMED — upper bound for reliable banks
    DOWN_DECLINE_CODE: 'SIM_SOFT_002',     // Maps to soft decline (transient failure)
    DOWN_DECLINE_NAME: 'BANK_UNAVAILABLE',
  }),

  // ── Customer Balance & Salary Dynamics ────────────────────────────────────
  // ASSUMED: synthetic balance trajectory around salary credits.
  // Models salary day balance jumps and daily spending drift.
  BALANCE: Object.freeze({
    // Salary credit multiplier relative to mandate amount
    SALARY_MULTIPLIER: 3.0,                // ASSUMED — salary jump is 3x mandate amount
    // Daily spending drift rate as a fraction of mandate amount
    DAILY_SPEND_FRACTION: 0.10,            // ASSUMED — 10% of mandate amount spent daily
    // Baseline reserve buffer as a fraction of mandate amount
    BASELINE_BUFFER_FRACTION: 0.20,        // ASSUMED — 20% baseline reserve
    // Volatility shock scaling factor
    VOLATILITY_NOISE_SCALE: 0.25,          // ASSUMED — shock variability scale
    // Decline code when availableBalance < mandate.amount
    INSUFFICIENT_FUNDS_CODE: 'SIM_SOFT_001', // Maps to soft decline
    INSUFFICIENT_FUNDS_NAME: 'INSUFFICIENT_FUNDS',
  }),

  // ── Other Decline Taxonomy ───────────────────────────────────────────────
  // ASSUMED: non-balance, non-bank failure taxonomy (hard / unknown).
  OTHER_DECLINES: Object.freeze({
    // Probability of an unrecoverable hard decline (account closed, revoked)
    HARD_DECLINE_RATE: 0.04,               // ASSUMED — 4% hard decline probability
    HARD_DECLINE_CODE: 'SIM_HARD_001',
    HARD_DECLINE_NAME: 'ACCOUNT_CLOSED',

    // Probability of an ambiguous / unknown decline
    UNKNOWN_DECLINE_RATE: 0.02,            // ASSUMED — 2% unknown decline probability
    UNKNOWN_DECLINE_CODE: 'SIM_UNKNOWN_001',
    UNKNOWN_DECLINE_NAME: 'UNKNOWN_GATEWAY_ERROR',
  }),

  // ── Canary Sentinel Trait ────────────────────────────────────────────────
  // Sentinel values used in canary tests to detect leaks of hidden traits.
  CANARY: Object.freeze({
    SENTINEL_SALARY_DAY: 999,              // Unique sentinel value for canary verification
    SENTINEL_TRAIT_KEY: '__canary_hidden_trait__',
  }),
});
