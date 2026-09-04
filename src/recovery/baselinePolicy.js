import { supabase } from '../config/supabase.js';
import { simulatePayment } from '../simulators/paymentSimulator.js';
import { logAudit } from '../utils/auditLogger.js';
import { assertTransition } from '../stateMachine/mandateStateMachine.js';

/**
 * Retry delay relative to the execution day of the failed attempt:
 * Attempt 2 -> failure day + 1 (delay: 1)
 * Attempt 3 -> failure day + 2 (delay: 2)
 * Attempt 4 -> failure day + 3 (delay: 3)
 */
export const RETRY_DELAY_BY_NEXT_ATTEMPT = Object.freeze({
  2: 1,
  3: 2,
  4: 3,
});

export const MAX_BASELINE_ATTEMPTS = 4;

/**
 * Executes a recovery attempt for a Baseline arm mandate.
 *
 * Rules:
 * 1. Execute attempt via execute_attempt RPC.
 * 2. Get authoritative attempt_number from attempts table.
 * 3. Simulate payment via paymentSimulator (WITHOUT currentDay).
 * 4. Complete attempt via complete_attempt RPC.
 * 5. Re-read mandate.
 * 6. If success -> recovered (owned by complete_attempt).
 * 7. If failure:
 *    a. If retryEligible === false -> stand_down immediately via set_mandate_action.
 *    b. If retryEligible === true and attempts_used < 4 -> schedule retry: failure day + delay.
 *    c. If retryEligible === true and attempts_used == 4 -> exhausted (never attempt 5th retry).
 *
 * @param {object} params
 * @param {string} params.runId
 * @param {object} params.mandate
 * @param {number} params.currentDay
 * @param {number} params.seed
 * @returns {Promise<object>} Updated mandate record
 */
export async function executeBaselinePolicy({ runId, mandate, currentDay, seed }) {
  if (!runId) throw new Error('baselinePolicy: runId is required');
  if (!mandate || !mandate.id) throw new Error('baselinePolicy: mandate with id is required');
  if (currentDay === undefined || currentDay === null) throw new Error('baselinePolicy: currentDay is required');
  if (seed === undefined || seed === null) throw new Error('baselinePolicy: seed is required');

  if (mandate.experiment_arm !== 'baseline') {
    throw new Error(`baselinePolicy: expected baseline arm, got ${mandate.experiment_arm}`);
  }

  // Pre-call estimate for idempotency key
  const estimatedAttempt = (mandate.attempts_used || 0) + 1;
  const idempotencyKey = `recovery-run:${runId}:mandate:${mandate.id}:attempt:${estimatedAttempt}`;

  // Step 1: Execute attempt
  const { data: attemptId, error: execErr } = await supabase.rpc('execute_attempt', {
    p_run_id: runId,
    p_mandate_id: mandate.id,
    p_day: currentDay,
    p_channel: 'auto_debit',
    p_idempotency_key: idempotencyKey,
  });

  if (execErr) {
    throw new Error(`baselinePolicy execute_attempt failed: ${execErr.message}`);
  }

  // Step 2: Fetch authoritative attempt details
  const { data: attempt, error: attErr } = await supabase
    .from('attempts')
    .select('id, attempt_number, outcome')
    .eq('id', attemptId)
    .single();

  if (attErr || !attempt) {
    throw new Error(`baselinePolicy failed to read attempt ${attemptId}: ${attErr?.message}`);
  }

  // Check if attempt was already completed (idempotency guard)
  if (attempt.outcome !== 'pending') {
    const { data: existingMandate } = await supabase
      .from('mandates')
      .select('*')
      .eq('id', mandate.id)
      .single();
    return existingMandate;
  }

  // Step 3: Run payment simulator (NEVER pass currentDay or experiment_arm)
  const simResult = simulatePayment({
    seed,
    mandateId: mandate.id,
    attemptNumber: attempt.attempt_number,
    amount: mandate.amount,
    balanceVolatility: mandate.balance_volatility,
    incomeDayOfMonth: mandate.income_day_of_month,
  });

  // Step 4: Complete attempt
  if (simResult.outcome === 'success') {
    assertTransition(mandate.status, 'recovered');
  }

  const { error: compErr } = await supabase.rpc('complete_attempt', {
    p_attempt_id: attempt.id,
    p_outcome: simResult.outcome,
    p_decline_code: simResult.declineCode,
    p_decline_category: simResult.declineCategory,
    p_retry_eligible: simResult.retryEligible,
  });

  if (compErr) {
    throw new Error(`baselinePolicy complete_attempt failed: ${compErr.message}`);
  }

  // Step 5: Log payment attempt result
  await logAudit({
    runId,
    mandateId: mandate.id,
    attemptId: attempt.id,
    day: currentDay,
    actor: 'baseline_policy',
    decisionType: 'payment_attempt_completed',
    input: {
      attemptNumber: attempt.attempt_number,
      amount: mandate.amount,
    },
    output: {
      outcome: simResult.outcome,
      declineCode: simResult.declineCode,
      declineCategory: simResult.declineCategory,
      retryEligible: simResult.retryEligible,
    },
    reasoning: `Baseline payment attempt ${attempt.attempt_number} completed with outcome: ${simResult.outcome}.`,
  });

  // Step 6: Re-read authoritative mandate state
  const { data: updatedMandate, error: mErr } = await supabase
    .from('mandates')
    .select('*')
    .eq('id', mandate.id)
    .single();

  if (mErr || !updatedMandate) {
    throw new Error(`baselinePolicy failed to re-read mandate: ${mErr?.message}`);
  }

  // Step 7: Handle outcome
  if (simResult.outcome === 'success') {
    // complete_attempt() already recovered the mandate
    await logAudit({
      runId,
      mandateId: mandate.id,
      attemptId: attempt.id,
      day: currentDay,
      actor: 'baseline_policy',
      decisionType: 'mandate_recovered',
      input: { attemptNumber: attempt.attempt_number },
      output: { status: updatedMandate.status, terminalReason: updatedMandate.terminal_reason },
      reasoning: 'Baseline payment succeeded; mandate recovered.',
    });
    return updatedMandate;
  }

  // Step 8: Failure handling
  // Case A: Non-retryable failure (retryEligible is false)
  if (simResult.retryEligible === false) {
    assertTransition(updatedMandate.status, 'stood_down');

    const { error: sdErr } = await supabase.rpc('set_mandate_action', {
      p_run_id: runId,
      p_mandate_id: mandate.id,
      p_action: 'stand_down',
      p_action_day: null,
      p_reason: 'baseline_non_retryable_failure',
    });

    if (sdErr) {
      throw new Error(`baselinePolicy set_mandate_action(stand_down) failed: ${sdErr.message}`);
    }

    await logAudit({
      runId,
      mandateId: mandate.id,
      attemptId: attempt.id,
      day: currentDay,
      actor: 'baseline_policy',
      decisionType: 'stand_down',
      input: {
        attemptNumber: attempt.attempt_number,
        declineCategory: simResult.declineCategory,
        retryEligible: false,
      },
      output: { action: 'stand_down', status: 'stood_down' },
      reasoning: 'Baseline failure is not retry eligible; stood down.',
    });

    const { data: finalMandate } = await supabase
      .from('mandates')
      .select('*')
      .eq('id', mandate.id)
      .single();
    return finalMandate;
  }

  // Case B: Retryable failure with attempts remaining (< 4)
  if (updatedMandate.attempts_used < MAX_BASELINE_ATTEMPTS) {
    const nextAttemptNumber = updatedMandate.attempts_used + 1;
    const delay = RETRY_DELAY_BY_NEXT_ATTEMPT[nextAttemptNumber];
    if (delay === undefined) {
      throw new Error(`baselinePolicy: unexpected nextAttemptNumber ${nextAttemptNumber}`);
    }

    const nextActionDay = currentDay + delay;

    const { error: retryErr } = await supabase.rpc('set_mandate_action', {
      p_run_id: runId,
      p_mandate_id: mandate.id,
      p_action: 'retry',
      p_action_day: nextActionDay,
      p_reason: `baseline_retry_${nextAttemptNumber}`,
    });

    if (retryErr) {
      throw new Error(`baselinePolicy set_mandate_action(retry) failed: ${retryErr.message}`);
    }

    await logAudit({
      runId,
      mandateId: mandate.id,
      attemptId: attempt.id,
      day: currentDay,
      actor: 'baseline_policy',
      decisionType: 'retry_scheduled',
      input: {
        attemptsUsed: updatedMandate.attempts_used,
        nextAttemptNumber,
        delay,
        failureDay: currentDay,
      },
      output: { action: 'retry', nextActionDay },
      reasoning: `Baseline scheduled attempt ${nextAttemptNumber} on day ${nextActionDay} (delay ${delay} after day ${currentDay}).`,
    });

    const { data: finalMandate } = await supabase
      .from('mandates')
      .select('*')
      .eq('id', mandate.id)
      .single();
    return finalMandate;
  }

  // Case C: 4th attempt failed (attempts_used === 4) -> Exhausted (never attempt 5th retry)
  assertTransition(updatedMandate.status, 'exhausted');

  const { error: exErr } = await supabase.rpc('set_mandate_action', {
    p_run_id: runId,
    p_mandate_id: mandate.id,
    p_action: 'exhausted',
    p_action_day: null,
    p_reason: 'baseline_max_attempts_reached',
  });

  if (exErr) {
    throw new Error(`baselinePolicy set_mandate_action(exhausted) failed: ${exErr.message}`);
  }

  await logAudit({
    runId,
    mandateId: mandate.id,
    attemptId: attempt.id,
    day: currentDay,
    actor: 'baseline_policy',
    decisionType: 'exhaustion',
    input: { attemptsUsed: updatedMandate.attempts_used },
    output: { action: 'exhausted', status: 'exhausted' },
    reasoning: 'Baseline reached maximum 4 attempts without recovery; mandate exhausted.',
  });

  const { data: finalMandate } = await supabase
    .from('mandates')
    .select('*')
    .eq('id', mandate.id)
    .single();
  return finalMandate;
}
