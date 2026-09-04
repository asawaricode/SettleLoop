import { supabase } from '../config/supabase.js';
import { simulatePayment } from '../simulators/paymentSimulator.js';
import { logAudit } from '../utils/auditLogger.js';
import { assertTransition } from '../stateMachine/mandateStateMachine.js';

/**
 * Executes a recovery attempt for a Control arm mandate.
 *
 * Rules:
 * 1. Execute attempt via execute_attempt RPC.
 * 2. Get authoritative attempt_number from attempts table.
 * 3. Simulate payment via paymentSimulator (WITHOUT currentDay).
 * 4. Complete attempt via complete_attempt RPC.
 * 5. Re-read mandate.
 * 6. If success -> recovered (owned by complete_attempt).
 * 7. If failure -> stand_down immediately via set_mandate_action (never retries).
 *
 * @param {object} params
 * @param {string} params.runId
 * @param {object} params.mandate
 * @param {number} params.currentDay
 * @param {number} params.seed
 * @returns {Promise<object>} Updated mandate record
 */
export async function executeControlPolicy({ runId, mandate, currentDay, seed }) {
  if (!runId) throw new Error('controlPolicy: runId is required');
  if (!mandate || !mandate.id) throw new Error('controlPolicy: mandate with id is required');
  if (currentDay === undefined || currentDay === null) throw new Error('controlPolicy: currentDay is required');
  if (seed === undefined || seed === null) throw new Error('controlPolicy: seed is required');

  if (mandate.experiment_arm !== 'control') {
    throw new Error(`controlPolicy: expected control arm, got ${mandate.experiment_arm}`);
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
    throw new Error(`controlPolicy execute_attempt failed: ${execErr.message}`);
  }

  // Step 2: Fetch authoritative attempt details
  const { data: attempt, error: attErr } = await supabase
    .from('attempts')
    .select('id, attempt_number, outcome')
    .eq('id', attemptId)
    .single();

  if (attErr || !attempt) {
    throw new Error(`controlPolicy failed to read attempt ${attemptId}: ${attErr?.message}`);
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
    throw new Error(`controlPolicy complete_attempt failed: ${compErr.message}`);
  }

  // Step 5: Log payment attempt result
  await logAudit({
    runId,
    mandateId: mandate.id,
    attemptId: attempt.id,
    day: currentDay,
    actor: 'control_policy',
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
    reasoning: `Control payment attempt ${attempt.attempt_number} completed with outcome: ${simResult.outcome}.`,
  });

  // Step 6: Re-read authoritative mandate state
  const { data: updatedMandate, error: mErr } = await supabase
    .from('mandates')
    .select('*')
    .eq('id', mandate.id)
    .single();

  if (mErr || !updatedMandate) {
    throw new Error(`controlPolicy failed to re-read mandate: ${mErr?.message}`);
  }

  // Step 7: Handle policy decision based on outcome
  if (simResult.outcome === 'success') {
    // complete_attempt() already recovered the mandate
    await logAudit({
      runId,
      mandateId: mandate.id,
      attemptId: attempt.id,
      day: currentDay,
      actor: 'control_policy',
      decisionType: 'mandate_recovered',
      input: { attemptNumber: attempt.attempt_number },
      output: { status: updatedMandate.status, terminalReason: updatedMandate.terminal_reason },
      reasoning: 'Control payment succeeded; mandate recovered.',
    });
    return updatedMandate;
  }

  // Step 8: Control failure handling -> Stand down immediately (no retries ever)
  assertTransition(updatedMandate.status, 'stood_down');

  const { error: sdErr } = await supabase.rpc('set_mandate_action', {
    p_run_id: runId,
    p_mandate_id: mandate.id,
    p_action: 'stand_down',
    p_action_day: null,
    p_reason: 'control_policy_failure',
  });

  if (sdErr) {
    throw new Error(`controlPolicy set_mandate_action(stand_down) failed: ${sdErr.message}`);
  }

  await logAudit({
    runId,
    mandateId: mandate.id,
    attemptId: attempt.id,
    day: currentDay,
    actor: 'control_policy',
    decisionType: 'stand_down',
    input: {
      attemptNumber: attempt.attempt_number,
      declineCategory: simResult.declineCategory,
      retryEligible: simResult.retryEligible,
    },
    output: { action: 'stand_down', status: 'stood_down' },
    reasoning: 'Control arm never retries on failure; stood down immediately.',
  });

  // Final re-read
  const { data: finalMandate } = await supabase
    .from('mandates')
    .select('*')
    .eq('id', mandate.id)
    .single();

  return finalMandate;
}
