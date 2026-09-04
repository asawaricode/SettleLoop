import { supabase } from '../config/supabase.js';
import { getClockState, advanceClock } from '../simulation/simulatedClock.js';
import { processDueMandates } from './recoveryEngine.js';

/**
 * Runs the deterministic Control + Baseline recovery runner.
 *
 * Rules:
 * 1. Read simulation run and verify.
 * 2. Get current_day from simulated clock.
 * 3. Find pending Control/Baseline mandates where next_action_day <= current_day.
 * 4. Process due mandates via respective policy (Control or Baseline).
 *    - SMART MANDATES ARE NEVER TOUCHED.
 * 5. Re-read persisted state.
 * 6. Find earliest future next_action_day among pending Control/Baseline mandates (<= max_days).
 * 7. If none or current_day >= max_days -> terminate.
 * 8. Jump clock directly to that earliest day via advanceClock(runId, jumpDays).
 * 9. Repeat until termination.
 *
 * @param {object} params
 * @param {string} params.runId - simulation_runs.id
 * @returns {Promise<{
 *   runId: string,
 *   processedCount: number,
 *   daysEvaluated: number[],
 *   terminatedReason: string,
 *   finalDay: number
 * }>}
 */
export async function runControlBaselineRecovery({ runId }) {
  if (!runId || typeof runId !== 'string' || runId.trim() === '') {
    throw new Error('recoveryRunner: runId must be a non-empty string');
  }

  // 1. Fetch simulation run
  const { data: run, error: rErr } = await supabase
    .from('simulation_runs')
    .select('id, random_seed, current_day, max_days, status')
    .eq('id', runId)
    .single();

  if (rErr || !run) {
    throw new Error(`recoveryRunner: simulation run ${runId} not found: ${rErr?.message}`);
  }

  let totalProcessed = 0;
  const daysEvaluated = [];
  let terminatedReason = '';

  while (true) {
    // 2. Read persisted clock state
    const clock = await getClockState(runId);
    const { currentDay, maxDays } = clock;

    if (!daysEvaluated.includes(currentDay)) {
      daysEvaluated.push(currentDay);
    }

    // 3. Discover and process due Control/Baseline mandates via Recovery Engine
    const dayResult = await processDueMandates({
      runId,
      currentDay,
      seed: run.random_seed,
      allowedArms: ['control', 'baseline'],
    });

    totalProcessed += dayResult.processedCount;

    // 5. Check termination conditions:
    // Condition B: current_day has reached max_days and all due work for today is done
    if (currentDay >= maxDays) {
      terminatedReason = 'reached_max_days';
      break;
    }

    // Condition A: Find next future Control/Baseline action within remaining window (currentDay < next_action_day <= maxDays)
    const { data: futureMandates, error: futureErr } = await supabase
      .from('mandates')
      .select('next_action_day')
      .eq('run_id', runId)
      .in('experiment_arm', ['control', 'baseline'])
      .eq('status', 'pending')
      .eq('next_action', 'retry')
      .gt('next_action_day', currentDay)
      .lte('next_action_day', maxDays)
      .order('next_action_day', { ascending: true })
      .limit(1);

    if (futureErr) {
      throw new Error(`recoveryRunner failed to fetch future mandates: ${futureErr.message}`);
    }

    if (!futureMandates || futureMandates.length === 0) {
      // No more processable Control/Baseline mandates within remaining simulation window
      terminatedReason = 'no_future_actions_within_window';
      break;
    }

    // 6. Advance simulated clock directly to earliest future due day
    const nextDueDay = futureMandates[0].next_action_day;
    const daysToAdvance = nextDueDay - currentDay;

    if (daysToAdvance <= 0) {
      // Defensive guard against infinite loop
      terminatedReason = 'zero_advance_guard';
      break;
    }

    await advanceClock(runId, daysToAdvance);
  }

  const finalClock = await getClockState(runId);

  return {
    runId,
    processedCount: totalProcessed,
    daysEvaluated,
    terminatedReason,
    finalDay: finalClock.currentDay,
  };
}
