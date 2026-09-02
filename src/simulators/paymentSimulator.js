// src/simulators/paymentSimulator.js
//
// Pure, deterministic Payment Simulator.
//
// Responsibilities:
//   - Receive simulation inputs.
//   - Return a deterministic payment result.
//
// Explicitly does NOT:
//   - Import or touch Supabase.
//   - Read or write the database.
//   - Call any RPC.
//   - Use Math.random() or any non-deterministic source.
//   - Accept or inspect experiment_arm.
//   - Use currentDay to influence the payment outcome.
//   - Enforce the 4-attempt system limit (that belongs to the RPC layer).

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic decline codes
// Clearly labelled as simulation-only identifiers.
// ─────────────────────────────────────────────────────────────────────────────
const SOFT_CODES    = ["SIM_SOFT_001", "SIM_SOFT_002"];
const HARD_CODES    = ["SIM_HARD_001", "SIM_HARD_002"];
const UNKNOWN_CODES = ["SIM_UNKNOWN_001"];

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic hash
//
// djb2-inspired string hasher that produces a stable uint32.
// Runs entirely in JavaScript integer arithmetic — no external package needed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Accumulate one character code into a running djb2 hash.
 * Uses Math.imul for safe 32-bit integer multiplication.
 *
 * @param {number} h  - running hash (uint32)
 * @param {number} c  - character code
 * @returns {number}  - updated hash (uint32)
 */
function djb2Step(h, c) {
  // hash = hash * 31 + charCode  (classic polynomial rolling hash)
  return (Math.imul(h, 31) + c) >>> 0;
}

/**
 * Hash a string into a uint32 using djb2.
 *
 * @param {string} str
 * @param {number} [seed=5381] - initial hash value
 * @returns {number} uint32
 */
function hashString(str, seed = 5381) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = djb2Step(h, str.charCodeAt(i));
  }
  return h;
}

/**
 * Derive a stable uint32 from all simulation inputs that should affect the
 * payment outcome.
 *
 * Inputs incorporated:
 *   seed              — simulation-level randomness anchor
 *   mandateId         — mandates.id UUID (unique per mandate row)
 *   attemptNumber     — which attempt this is (must materially vary the result)
 *   amount            — payment amount (float, 100–50000)
 *   balanceVolatility — account balance variability (float, 0.0000–1.0000)
 *   incomeDayOfMonth  — integer 1–28
 *
 * Inputs deliberately excluded:
 *   experiment_arm  — must not influence payment outcome
 *   currentDay      — must not influence payment outcome
 *
 * @returns {number} uint32
 */
function deriveHash(seed, mandateId, attemptNumber, amount, balanceVolatility, incomeDayOfMonth) {
  // Build a canonical key string from all relevant inputs.
  // String concatenation with fixed delimiters prevents collisions between
  // adjacent numeric fields (e.g., seed=1,attempt=23 vs seed=12,attempt=3).
  const key = [
    String(seed >>> 0),
    mandateId,
    String(attemptNumber),
    amount.toFixed(2),
    balanceVolatility.toFixed(4),
    String(incomeDayOfMonth),
  ].join("|");

  return hashString(key);
}

// ─────────────────────────────────────────────────────────────────────────────
// Outcome distribution
//
// The uint32 hash is mapped onto the [0, 1) interval (h / 2^32) and bucketed.
//
// Target: ~35-40 % first-attempt failure rate across a large diverse dataset.
//
// Bucket thresholds (cumulative probability):
//
//   [0.00, 0.60)  → success            (60 %)
//   [0.60, 0.75)  → soft failure       (15 %)
//   [0.75, 0.88)  → hard failure       (13 %)
//   [0.88, 1.00)  → unknown failure    (12 %)
//
// Total failure ≈ 40 %, which is within the 30–50 % target.
//
// Per-attempt variation:
//   The attempt number is incorporated into the key, so the uint32 (and thus
//   bucket) changes per attempt. A mandate that fails on attempt 1 may succeed
//   on attempt 2, 3, etc.
//
// Higher balanceVolatility (0–1) nudges the effective threshold slightly
// downward, making unstable accounts a bit more prone to soft failures.
// The nudge is bounded so it never overrides hard/unknown outcomes.
// ─────────────────────────────────────────────────────────────────────────────

const P_SUCCESS      = 0.60;   // [0, 0.60)
const P_SOFT_END     = 0.75;   // [0.60, 0.75)
const P_HARD_END     = 0.88;   // [0.75, 0.88)
// unknown:                        [0.88, 1.00)

// balanceVolatility can shift the success threshold down by at most 0.08
// (i.e., a mandate with volatility=1.0 has a success probability of 0.52).
const VOLATILITY_WEIGHT = 0.08;

// ─────────────────────────────────────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate all simulator inputs and throw clearly if anything is wrong.
 * Ranges mirror the actual values produced by syntheticDataGenerator.js.
 */
function validateInputs({ seed, mandateId, attemptNumber, amount, balanceVolatility, incomeDayOfMonth }) {
  if (seed === undefined || seed === null || !Number.isFinite(Number(seed))) {
    throw new Error("paymentSimulator: seed must be a finite number");
  }
  if (!mandateId || typeof mandateId !== "string" || mandateId.trim() === "") {
    throw new Error("paymentSimulator: mandateId must be a non-empty string (mandates.id UUID)");
  }
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error("paymentSimulator: attemptNumber must be a positive integer");
  }
  if (!Number.isFinite(amount) || amount < 100 || amount > 50000) {
    throw new Error(`paymentSimulator: amount must be a finite number in [100, 50000], got ${amount}`);
  }
  if (!Number.isFinite(balanceVolatility) || balanceVolatility < 0 || balanceVolatility > 1) {
    throw new Error(`paymentSimulator: balanceVolatility must be in [0, 1], got ${balanceVolatility}`);
  }
  if (!Number.isInteger(incomeDayOfMonth) || incomeDayOfMonth < 1 || incomeDayOfMonth > 28) {
    throw new Error(`paymentSimulator: incomeDayOfMonth must be an integer in [1, 28], got ${incomeDayOfMonth}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simulate the payment result for one attempt on one mandate.
 *
 * This is a pure function:
 *   - No Supabase imports or calls.
 *   - No Math.random().
 *   - No experiment_arm dependency.
 *   - No currentDay dependency.
 *   - Same inputs always return the same output.
 *
 * @param {object} params
 * @param {number} params.seed              - Run's random_seed (uint32).
 * @param {string} params.mandateId         - mandates.id UUID (NOT mandate_id display field).
 * @param {number} params.attemptNumber     - 1-based attempt counter (positive integer).
 * @param {number} params.amount            - Payment amount in INR, float in [100, 50000].
 * @param {number} params.balanceVolatility - Account balance variability, float in [0, 1].
 * @param {number} params.incomeDayOfMonth  - Customer's income day, integer in [1, 28].
 *
 * @returns {{
 *   outcome:         'success' | 'failure',
 *   declineCode:     string | null,
 *   declineCategory: 'soft' | 'hard' | 'unknown' | null,
 *   retryEligible:   boolean | null
 * }}
 */
export function simulatePayment({
  seed,
  mandateId,
  attemptNumber,
  amount,
  balanceVolatility,
  incomeDayOfMonth,
}) {
  // 1. Validate inputs
  validateInputs({ seed, mandateId, attemptNumber, amount, balanceVolatility, incomeDayOfMonth });

  // 2. Derive a stable uint32 from all relevant inputs
  const h = deriveHash(
    seed,
    mandateId,
    attemptNumber,
    amount,
    balanceVolatility,
    incomeDayOfMonth
  );

  // 3. Map to [0, 1)
  const p = h / 4294967296;

  // 4. Apply balanceVolatility nudge to the success threshold.
  //    Higher volatility → slightly lower success probability.
  //    Nudge is bounded: it only affects the success/soft boundary,
  //    not hard or unknown thresholds.
  const successThreshold = P_SUCCESS - balanceVolatility * VOLATILITY_WEIGHT;

  // 5. Pick outcome bucket
  if (p < successThreshold) {
    // ── SUCCESS ───────────────────────────────────────────────────────────
    return {
      outcome: "success",
      declineCode: null,
      declineCategory: null,
      retryEligible: null,
    };
  }

  if (p < P_SOFT_END) {
    // ── SOFT FAILURE ──────────────────────────────────────────────────────
    // Use secondary hash bits to pick among the soft codes.
    const codeIndex = h % SOFT_CODES.length;
    return {
      outcome: "failure",
      declineCode: SOFT_CODES[codeIndex],
      declineCategory: "soft",
      retryEligible: true,
    };
  }

  if (p < P_HARD_END) {
    // ── HARD FAILURE ──────────────────────────────────────────────────────
    const codeIndex = h % HARD_CODES.length;
    return {
      outcome: "failure",
      declineCode: HARD_CODES[codeIndex],
      declineCategory: "hard",
      retryEligible: false,
    };
  }

  // ── UNKNOWN FAILURE ───────────────────────────────────────────────────────
  // Treated conservatively: retryEligible = false.
  const codeIndex = h % UNKNOWN_CODES.length;
  return {
    outcome: "failure",
    declineCode: UNKNOWN_CODES[codeIndex],
    declineCategory: "unknown",
    retryEligible: false,
  };
}
