import { supabase } from "../config/supabase.js";

// ─────────────────────────────────────────────────────────────────────────────
// Seeded PRNG — mulberry32
// Returns a factory that creates a stateful PRNG from a 32-bit integer seed.
// Same seed → identical sequence. No external dependency needed.
// ─────────────────────────────────────────────────────────────────────────────
function mulberry32(seed) {
  let s = seed >>> 0; // coerce to uint32
  return function next() {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; // [0, 1)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers that consume from the PRNG
// ─────────────────────────────────────────────────────────────────────────────

/** Integer in [min, max] inclusive */
function randInt(rand, min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}

/** Float in [min, max) rounded to `decimals` places */
function randFloat(rand, min, max, decimals = 2) {
  return parseFloat((rand() * (max - min) + min).toFixed(decimals));
}

// ─────────────────────────────────────────────────────────────────────────────
// Experiment-arm assignment
//
// Arms: control | baseline | smart
// Strategy: round-robin over the sorted arm list so that for any mandateCount
// the distribution is as balanced as possible.
// Arm characteristics are assigned INDEPENDENTLY of mandate characteristics.
// ─────────────────────────────────────────────────────────────────────────────
const EXPERIMENT_ARMS = ["control", "baseline", "smart"];

function assignArm(index) {
  return EXPERIMENT_ARMS[index % EXPERIMENT_ARMS.length];
}

// ─────────────────────────────────────────────────────────────────────────────
// Default configuration
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULTS = {
  seed: 42,
  mandateCount: 30,
  maxDays: 10,
};

// ─────────────────────────────────────────────────────────────────────────────
// Main generator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates one simulation run and `mandateCount` synthetic mandates,
 * inserts them into Supabase, and returns their IDs.
 *
 * @param {object} [config]
 * @param {number} [config.seed=42]          - Deterministic PRNG seed (uint32).
 * @param {number} [config.mandateCount=30]  - Number of mandates to generate.
 * @param {number} [config.maxDays=10]       - Maximum simulation days.
 *
 * @returns {Promise<{ simulationRunId: string, mandateIds: string[] }>}
 */
export async function generateSyntheticData(config = {}) {
  // ── 1. Resolve and validate config ────────────────────────────────────────
  const seed =
    config.seed !== undefined ? config.seed : DEFAULTS.seed;
  const mandateCount =
    config.mandateCount !== undefined
      ? config.mandateCount
      : DEFAULTS.mandateCount;
  const maxDays =
    config.maxDays !== undefined
      ? config.maxDays
      : DEFAULTS.maxDays;

  if (!Number.isInteger(mandateCount) || mandateCount < 1) {
    throw new Error(
      `mandateCount must be a positive integer, got: ${mandateCount}`
    );
  }

  if (!Number.isInteger(maxDays) || maxDays < 1) {
    throw new Error(
      `maxDays must be a positive integer, got: ${maxDays}`
    );
  }

  const seedInt = Math.abs(Math.round(Number(seed))) >>> 0;

  // ── 2. Create the simulation run ───────────────────────────────────────────
  const { data: runData, error: runError } = await supabase
    .from("simulation_runs")
    .insert({
      random_seed: seedInt,
      current_day: 0,
      max_days: maxDays,
      status: "running",
    })
    .select("id")
    .single();

  if (runError) {
    throw new Error(
      `Failed to create simulation run: ${runError.message}`
    );
  }

  const simulationRunId = runData.id;

  // ── 3. Generate mandate records ────────────────────────────────────────────
  // Initialise one PRNG for mandate characteristics.
  // The experiment arm is assigned deterministically by index (round-robin),
  // completely independent of the PRNG used for characteristics.
  const rand = mulberry32(seedInt);

  const mandateRows = [];

  for (let i = 0; i < mandateCount; i++) {
    // --- Synthetic payment/customer characteristics (deterministic) ----------

    // Amount: realistic INR recurring mandate range ₹100 – ₹50 000
    const amount = randFloat(rand, 100, 50000, 2);

    // Income day of month: 1–28 (avoids month-length edge cases)
    const income_day_of_month = randInt(rand, 1, 28);

    // Balance volatility: 0.00 – 1.00 (higher = more variable simulated balance)
    const balance_volatility = randFloat(rand, 0, 1, 4);

    // Contact consent: coin-flip, ~50 % true
    const contact_consent = rand() >= 0.5;

    // first_due_day: day 1–5 so payment falls early in the 10-day window,
    // giving the recovery engine room to act before max_days is reached.
    const first_due_day = randInt(rand, 1, 5);

    // --- Experiment arm (index-based, independent of PRNG) ------------------
    const experiment_arm = assignArm(i);

    // --- Static initial state ------------------------------------------------
    // mandate_id: human-readable business identifier, NOT NULL in schema.
    // Zero-padded so lexicographic sort matches numeric sort up to 9999 mandates.
    const mandate_id = `M-${String(i + 1).padStart(4, "0")}`;

    mandateRows.push({
      run_id: simulationRunId,
      mandate_id,
      amount,
      income_day_of_month,
      balance_volatility,
      contact_consent,
      experiment_arm,
      status: "pending",
      terminal_reason: null,
      attempts_used: 0,
      first_due_day,
      next_action: "retry",          // CHECK constraint: retry | human_review | stand_down | none
      next_action_day: first_due_day, // equals first_due_day on creation
      last_attempt_day: null,
      created_day: 0,
    });
  }

  // ── 4. Batch insert mandates ───────────────────────────────────────────────
  const { data: mandateData, error: mandateError } = await supabase
    .from("mandates")
    .insert(mandateRows)
    .select("id");

  if (mandateError) {
    throw new Error(
      `Failed to insert mandates: ${mandateError.message}`
    );
  }

  const mandateIds = mandateData.map((row) => row.id);

  // ── 5. Return IDs ──────────────────────────────────────────────────────────
  return { simulationRunId, mandateIds };
}
