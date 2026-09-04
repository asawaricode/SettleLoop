import { supabase } from '../config/supabase.js';
import { executeControlPolicy } from './controlPolicy.js';
import { executeBaselinePolicy } from './baselinePolicy.js';

/**
 * Routes a single due mandate to its assigned recovery policy.
 *
 * Before dispatch, verifies the mandate is eligible:
 * - status === 'pending'
 * - next_action === 'retry'
 * - next_action_day <= currentDay
 * - experiment_arm is supported ('control' or 'baseline')
 *
 * Rejects 'smart' defensively as it is not yet implemented.
 *
 * @param {object} params
 * @param {string} params.runId - simulation_runs.id
 * @param {object} params.mandate - Mandate record from database
 * @param {number} params.currentDay - Current simulation day
 * @param {number} params.seed - Random seed from simulation run
 * @returns {Promise<object>} Updated mandate record
 */
export async function processMandate({ runId, mandate, currentDay, seed }) {
  if (!runId || typeof runId !== 'string' || runId.trim() === '') {
    throw new Error('recoveryEngine: runId must be a non-empty string');
  }
  if (!mandate || !mandate.id) {
    throw new Error('recoveryEngine: mandate with id is required');
  }
  if (currentDay === undefined || currentDay === null || typeof currentDay !== 'number') {
    throw new Error('recoveryEngine: currentDay must be a number');
  }
  if (seed === undefined || seed === null) {
    throw new Error('recoveryEngine: seed is required');
  }

  // Eligibility checks
  if (mandate.status !== 'pending') {
    throw new Error(`recoveryEngine: mandate ${mandate.id} is not pending (status: ${mandate.status})`);
  }
  if (mandate.next_action !== 'retry') {
    throw new Error(`recoveryEngine: mandate ${mandate.id} next_action is not retry (${mandate.next_action})`);
  }
  if (mandate.next_action_day > currentDay) {
    throw new Error(`recoveryEngine: mandate ${mandate.id} is not due yet (next_action_day: ${mandate.next_action_day}, currentDay: ${currentDay})`);
  }

  // Dispatch based on experiment_arm
  switch (mandate.experiment_arm) {
    case 'control':
      return await executeControlPolicy({ runId, mandate, currentDay, seed });

    case 'baseline':
      return await executeBaselinePolicy({ runId, mandate, currentDay, seed });

    case 'smart':
      throw new Error('Smart policy is not yet enabled in Recovery Engine');

    default:
      throw new Error(`recoveryEngine: unsupported experiment_arm "${mandate.experiment_arm}"`);
  }
}

/**
 * Discovers and processes all due mandates for the specified day and allowed experiment arms.
 *
 * Matches the exact Step 10 discovery query and freshness re-check:
 * - Query filters: run_id, in(allowedArms), status = 'pending', next_action = 'retry', next_action_day <= currentDay
 * - Ordering: next_action_day ASC, mandate_id ASC
 * - Re-reads fresh state before acting
 * - Skips mandates that are no longer eligible
 *
 * @param {object} params
 * @param {string} params.runId - simulation_runs.id
 * @param {number} params.currentDay - Current simulation day
 * @param {number} params.seed - Random seed from simulation run
 * @param {string[]} [params.allowedArms=['control', 'baseline']] - Allowed experiment arms
 * @returns {Promise<{
 *   day: number,
 *   processedCount: number,
 *   results: Array<{
 *     mandateId: string,
 *     arm: string,
 *     status: string
 *   }>
 * }>}
 */
export async function processDueMandates({
  runId,
  currentDay,
  seed,
  allowedArms = ['control', 'baseline'],
}) {
  if (!runId || typeof runId !== 'string' || runId.trim() === '') {
    throw new Error('recoveryEngine: runId must be a non-empty string');
  }
  if (currentDay === undefined || currentDay === null || typeof currentDay !== 'number') {
    throw new Error('recoveryEngine: currentDay must be a number');
  }
  if (seed === undefined || seed === null) {
    throw new Error('recoveryEngine: seed is required');
  }
  if (!Array.isArray(allowedArms) || allowedArms.length === 0) {
    return {
      day: currentDay,
      processedCount: 0,
      results: [],
    };
  }

  // Exact Step 10 discovery query (preserves source-of-truth filters, columns, and deterministic ordering)
  const { data: dueMandates, error: dueErr } = await supabase
    .from('mandates')
    .select('*')
    .eq('run_id', runId)
    .in('experiment_arm', allowedArms)
    .eq('status', 'pending')
    .eq('next_action', 'retry')
    .lte('next_action_day', currentDay)
    .order('next_action_day', { ascending: true })
    .order('mandate_id', { ascending: true });

  if (dueErr) {
    throw new Error(`recoveryEngine failed to fetch due mandates: ${dueErr.message}`);
  }

  const results = [];
  let processedCount = 0;

  for (const mandate of dueMandates || []) {
    // Exact Step 10 re-read fresh state before acting (defensive against concurrency/stale state)
    const { data: freshMandate, error: fErr } = await supabase
      .from('mandates')
      .select('*')
      .eq('id', mandate.id)
      .single();

    if (fErr || !freshMandate) continue;

    // Ensure it is still non-terminal, due, and in allowedArms
    if (
      freshMandate.status !== 'pending' ||
      freshMandate.next_action !== 'retry' ||
      freshMandate.next_action_day > currentDay ||
      !allowedArms.includes(freshMandate.experiment_arm)
    ) {
      continue;
    }

    const updatedMandate = await processMandate({
      runId,
      mandate: freshMandate,
      currentDay,
      seed,
    });

    processedCount++;
    results.push({
      mandateId: mandate.mandate_id,
      arm: mandate.experiment_arm,
      status: updatedMandate?.status || 'unknown',
    });
  }

  return {
    day: currentDay,
    processedCount,
    results,
  };
}
