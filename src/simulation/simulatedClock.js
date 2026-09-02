// src/simulation/simulatedClock.js
//
// Simulated Clock — manages virtual simulation time for a single run.
//
// Responsibilities:
//   - Read the persisted current simulation day.
//   - Advance the persisted simulation day (with CAS concurrency guard).
//   - Never allow current_day to exceed max_days.
//   - Report whether the simulation has reached max_days.
//
// Explicitly does NOT:
//   - Query or modify mandates, attempts, approval_requests, or audit_logs.
//   - Use setTimeout, setInterval, cron, or any real-time mechanism.
//   - Contain recovery, payment, classification, or AI logic.
//   - Silently create simulation runs.
//   - Change simulation_runs.status.

import { supabase } from "../config/supabase.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum number of CAS retry attempts before giving up. */
const CAS_MAX_RETRIES = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate that a run ID is a non-empty string.
 * @param {*} runId
 */
function validateRunId(runId) {
  if (!runId || typeof runId !== "string" || runId.trim() === "") {
    throw new Error("simulatedClock: runId must be a non-empty string");
  }
}

/**
 * Fetch the simulation_runs row for the given ID.
 * Throws a clear error if the run does not exist or the DB call fails.
 *
 * @param {string} runId
 * @returns {Promise<{ id: string, currentDay: number, maxDays: number, status: string }>}
 */
async function fetchRun(runId) {
  const { data, error } = await supabase
    .from("simulation_runs")
    .select("id, current_day, max_days, status")
    .eq("id", runId)
    .single();

  if (error) {
    // PostgREST returns PGRST116 when no row matches .single()
    if (error.code === "PGRST116") {
      throw new Error(`simulatedClock: simulation run not found — id=${runId}`);
    }
    throw new Error(`simulatedClock: failed to read simulation run — ${error.message}`);
  }

  // Defensive integrity checks on persisted values
  const currentDay = data.current_day;
  const maxDays    = data.max_days;

  if (!Number.isInteger(currentDay) || currentDay < 0) {
    throw new Error(
      `simulatedClock: invalid persisted current_day=${currentDay} for run ${runId}`
    );
  }
  if (!Number.isInteger(maxDays) || maxDays < 0) {
    throw new Error(
      `simulatedClock: invalid persisted max_days=${maxDays} for run ${runId}`
    );
  }
  if (currentDay > maxDays) {
    throw new Error(
      `simulatedClock: data integrity violation — current_day(${currentDay}) > max_days(${maxDays}) for run ${runId}`
    );
  }

  return { id: data.id, currentDay, maxDays, status: data.status };
}

/**
 * Build a standardised clock-state object.
 *
 * @param {string} runId
 * @param {number} currentDay
 * @param {number} maxDays
 * @returns {{ runId: string, currentDay: number, maxDays: number, hasReachedMaxDays: boolean }}
 */
function buildClockState(runId, currentDay, maxDays) {
  return {
    runId,
    currentDay,
    maxDays,
    hasReachedMaxDays: currentDay >= maxDays,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the current state of the simulated clock for a given run.
 *
 * The returned values reflect the persisted database state.
 *
 * @param {string} runId - simulation_runs.id
 * @returns {Promise<{ runId: string, currentDay: number, maxDays: number, hasReachedMaxDays: boolean }>}
 */
export async function getClockState(runId) {
  validateRunId(runId);
  const run = await fetchRun(runId);
  return buildClockState(runId, run.currentDay, run.maxDays);
}

/**
 * Advance the simulation clock by `days` virtual days.
 *
 * Uses an optimistic compare-and-swap (CAS) update so that concurrent callers
 * cannot silently overwrite each other's advances:
 *
 *   UPDATE simulation_runs
 *   SET    current_day = newDay
 *   WHERE  id          = runId
 *   AND    current_day = <value read at start of this attempt>
 *
 * If the guarded update affects zero rows (another caller changed current_day
 * in the meantime) the function re-reads the latest state and retries, up to
 * CAS_MAX_RETRIES times.  After that it throws a concurrency error.
 *
 * current_day is always clamped to max_days; it is never allowed to exceed it.
 *
 * If current_day is already equal to max_days the function returns the
 * unchanged clock state without throwing.
 *
 * @param {string} runId - simulation_runs.id
 * @param {number} [days=1] - number of virtual days to advance (positive integer)
 * @returns {Promise<{ runId: string, currentDay: number, maxDays: number, hasReachedMaxDays: boolean }>}
 */
export async function advanceClock(runId, days = 1) {
  validateRunId(runId);

  // ── Validate `days` ────────────────────────────────────────────────────────
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(
      `simulatedClock: days must be a positive integer, got ${days}`
    );
  }

  // ── CAS retry loop ─────────────────────────────────────────────────────────
  let attempt = 0;

  while (attempt < CAS_MAX_RETRIES) {
    attempt++;

    // 1. Read the current persisted state.
    const run = await fetchRun(runId);
    const { currentDay, maxDays } = run;

    // 2. If already at max_days, nothing more to do — return current state.
    if (currentDay >= maxDays) {
      return buildClockState(runId, currentDay, maxDays);
    }

    // 3. Calculate the new day, clamped to max_days.
    const newDay = Math.min(currentDay + days, maxDays);

    // 4. Guarded update — the WHERE clause includes:
    //      id          = runId          (selects the right row)
    //      current_day = currentDay     (CAS guard — rejects stale writes)
    //
    //    .select("id") causes PostgREST to return the updated rows;
    //    if data is an empty array the update matched nothing (CAS missed).
    const { data: updated, error: updateError } = await supabase
      .from("simulation_runs")
      .update({ current_day: newDay })
      .eq("id", runId)
      .eq("current_day", currentDay)   // ← mandatory CAS guard
      .select("id, current_day, max_days");

    if (updateError) {
      throw new Error(
        `simulatedClock: failed to advance clock — ${updateError.message}`
      );
    }

    // 5. Check whether the update actually affected a row.
    if (updated && updated.length > 0) {
      // CAS succeeded — return the newly persisted state.
      const row = updated[0];
      return buildClockState(runId, row.current_day, row.max_days);
    }

    // 6. Zero rows updated → concurrent modification detected.
    //    Loop will re-read and retry (up to CAS_MAX_RETRIES).
  }

  // All retries exhausted.
  throw new Error(
    `simulatedClock: concurrency conflict — could not advance clock for run ${runId} after ${CAS_MAX_RETRIES} attempts. ` +
    "Another process is modifying current_day concurrently."
  );
}

/**
 * Check whether the simulation has reached its maximum day.
 *
 * Always reads from the database to reflect the persisted state.
 *
 * @param {string} runId - simulation_runs.id
 * @returns {Promise<boolean>}
 */
export async function hasReachedMaxDays(runId) {
  validateRunId(runId);
  const run = await fetchRun(runId);
  return run.currentDay >= run.maxDays;
}
