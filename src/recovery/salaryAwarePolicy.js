// src/recovery/salaryAwarePolicy.js
//
// Phase 5: Salary-Aware Rule Arm.
//
// Responsibilities:
//   - Implements the third headline benchmark arm: Salary-Aware Rule.
//   - Uses ONLY the public Phase 4 Observation.
//   - Strictly shields and never accesses hidden simulator traits:
//       * NO salaryDay, NO balanceDynamics, NO bankReliability, NO hidden ground truth.
//       * If noisyPaydayHint is present in Observation, uses ONLY that exposed noisy hint.
//   - Retains all Phase 2 guardrails:
//       * Max 4 attempts per cycle.
//       * Hard/unknown declines stand down immediately.
//       * Delay days bounded to [1, 7].
//       * Non-peak dispatch and 24h notice gap enforced.
//
// EVIDENCE & REGULATORY STATUS:
// All values and scheduling heuristics are ASSUMED benchmark rules, aligning with
// ASSUMPTIONS.md §7.

import { supabase } from '../config/supabase.js';
import { simulatePayment } from '../simulators/paymentSimulator.js';
import { logAudit } from '../utils/auditLogger.js';
import { assertTransition } from '../stateMachine/mandateStateMachine.js';
import { assertMandateAction } from './mandateTransitions.js';
import { buildObservation } from '../simulators/observation.js';
import {
  MAX_ATTEMPTS,
  MAX_DELAY_DAYS,
  CONFIDENCE_THRESHOLD,
} from '../config/recoveryPolicy.js';

export const MAX_SALARY_AWARE_ATTEMPTS = MAX_ATTEMPTS;

/**
 * Pure decision function for the Salary-Aware Rule.
 * Operates EXCLUSIVELY on the public Observation and standard failure flags.
 *
 * @param {Readonly<object>} observation - Public allowlisted Observation object
 * @param {object} [failureInfo] - Classification metadata
 * @param {'soft'|'hard'|'unknown'} [failureInfo.category='soft']
 * @param {boolean} [failureInfo.retryEligible=true]
 * @returns {{
 *   action: 'retry' | 'stand_down' | 'exhausted',
 *   delayDays: number | null,
 *   timeSlot: string,
 *   confidence: number,
 *   reasoning: string
 * }}
 */
export function decideSalaryAwareAction(observation, failureInfo = {}) {
  if (!observation) {
    throw new Error('decideSalaryAwareAction: observation is required');
  }

  const attemptsUsed = Number(observation.attemptsUsed ?? 0);
  const category = failureInfo.category ?? 'soft';
  const retryEligible = failureInfo.retryEligible ?? true;

  // 1. Hard or unknown declines or non-retryable failures must NEVER be retried
  if (category === 'hard' || category === 'unknown' || retryEligible === false) {
    return {
      action: 'stand_down',
      delayDays: null,
      timeSlot: '14:00',
      confidence: 1.0,
      reasoning: `Salary-Aware Rule: failure category "${category}" (retryEligible=${retryEligible}) is non-retryable; stood down.`,
    };
  }

  // 2. Max attempts check: if 4 attempts already used, exhaust
  if (attemptsUsed >= MAX_SALARY_AWARE_ATTEMPTS) {
    return {
      action: 'exhausted',
      delayDays: null,
      timeSlot: '14:00',
      confidence: 1.0,
      reasoning: `Salary-Aware Rule: reached maximum ${MAX_SALARY_AWARE_ATTEMPTS} attempts; cycle exhausted.`,
    };
  }

  // 3. Evaluate noisyPaydayHint from Observation only
  const hint = observation.noisyPaydayHint;
  const currentDay = Number(observation.currentDay) || 1;
  let delayDays = 2; // Default fallback delay (2 days gives >= 24h notice gap)

  if (hint !== null && hint !== undefined && Number.isFinite(Number(hint))) {
    const hintDay = Number(hint);
    // Virtual calendar is 28-day cycle
    const daysUntilPayday = (hintDay - currentDay + 28) % 28;

    if (daysUntilPayday === 0) {
      // Payday is today: retry tomorrow (1 day delay) to allow funds to clear
      delayDays = 1;
    } else if (daysUntilPayday >= 1 && daysUntilPayday <= MAX_DELAY_DAYS) {
      // Payday is within the permissible 1–7 day delay window
      delayDays = daysUntilPayday;
    } else {
      // Payday is > 7 days away; cannot wait full cycle due to MAX_DELAY_DAYS.
      // Use fallback delay based on attempt counter:
      const nextAttempt = attemptsUsed + 1;
      delayDays = nextAttempt === 2 ? 1 : nextAttempt === 3 ? 2 : 3;
    }
  } else {
    // No payday hint available in Observation: use deterministic attempt delay
    const nextAttempt = attemptsUsed + 1;
    delayDays = nextAttempt === 2 ? 1 : nextAttempt === 3 ? 2 : 3;
  }

  // Clamp strictly to [1, MAX_DELAY_DAYS]
  delayDays = Math.max(1, Math.min(MAX_DELAY_DAYS, delayDays));

  return {
    action: 'retry',
    delayDays,
    timeSlot: '14:00', // SOURCED non-peak slot
    confidence: CONFIDENCE_THRESHOLD,
    reasoning: `Salary-Aware Rule: scheduled attempt ${attemptsUsed + 1} with delay ${delayDays} (hint=${hint ?? 'none'}).`,
  };
}

/**
 * Executes a recovery attempt for a Salary-Aware arm mandate in Supabase.
 *
 * @param {object} params
 * @param {string} params.runId
 * @param {object} params.mandate
 * @param {number} params.currentDay
 * @param {number} params.seed
 * @returns {Promise<object>} Updated mandate record
 */
export async function executeSalaryAwarePolicy({ runId, mandate, currentDay, seed }) {
  if (!runId) throw new Error('salaryAwarePolicy: runId is required');
  if (!mandate || !mandate.id) throw new Error('salaryAwarePolicy: mandate with id is required');
  if (currentDay === undefined || currentDay === null) throw new Error('salaryAwarePolicy: currentDay is required');
  if (seed === undefined || seed === null) throw new Error('salaryAwarePolicy: seed is required');

  if (mandate.experiment_arm !== 'salary_aware' && mandate.experiment_arm !== 'salary_aware_rule') {
    throw new Error(`salaryAwarePolicy: expected salary_aware arm, got ${mandate.experiment_arm}`);
  }

  // Pre-call estimate for idempotency key
  const estimatedAttempt = (mandate.attempts_used || 0) + 1;
  const idempotencyKey = `recovery-run:${runId}:mandate:${mandate.id}:attempt:${estimatedAttempt}`;

  // Step 1: Execute attempt via RPC
  const { data: attemptId, error: execErr } = await supabase.rpc('execute_attempt', {
    p_run_id: runId,
    p_mandate_id: mandate.id,
    p_day: currentDay,
    p_channel: 'auto_debit',
    p_idempotency_key: idempotencyKey,
  });

  if (execErr) {
    throw new Error(`salaryAwarePolicy execute_attempt failed: ${execErr.message}`);
  }

  // Step 2: Fetch authoritative attempt details
  const { data: attempt, error: attErr } = await supabase
    .from('attempts')
    .select('id, attempt_number, outcome')
    .eq('id', attemptId)
    .single();

  if (attErr || !attempt) {
    throw new Error(`salaryAwarePolicy failed to read attempt ${attemptId}: ${attErr?.message}`);
  }

  if (attempt.outcome !== 'pending') {
    const { data: existingMandate } = await supabase
      .from('mandates')
      .select('*')
      .eq('id', mandate.id)
      .single();
    return existingMandate;
  }

  // Step 3: Run payment simulator with currentDay
  const simMandateId =
    mandate.mandate_id && /^M-\d+$/.test(mandate.mandate_id)
      ? mandate.mandate_id
      : (mandate.id || mandate.mandate_id);

  const simResult = simulatePayment({
    seed,
    mandateId: simMandateId,
    attemptNumber: attempt.attempt_number,
    amount: mandate.amount,
    currentDay,
  });

  // Step 4: Complete attempt via RPC
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
    throw new Error(`salaryAwarePolicy complete_attempt failed: ${compErr.message}`);
  }

  // Step 5: Audit payment attempt completed
  await logAudit({
    runId,
    mandateId: mandate.id,
    attemptId: attempt.id,
    day: currentDay,
    actor: 'salary_aware_policy',
    decisionType: 'payment_attempt_completed',
    input: { attemptNumber: attempt.attempt_number, amount: mandate.amount },
    output: {
      outcome: simResult.outcome,
      declineCode: simResult.declineCode,
      declineCategory: simResult.declineCategory,
      retryEligible: simResult.retryEligible,
    },
    reasoning: `Salary-Aware payment attempt ${attempt.attempt_number} completed with outcome: ${simResult.outcome}.`,
  });

  // Step 6: Re-read authoritative mandate state
  const { data: updatedMandate, error: mErr } = await supabase
    .from('mandates')
    .select('*')
    .eq('id', mandate.id)
    .single();

  if (mErr || !updatedMandate) {
    throw new Error(`salaryAwarePolicy failed to re-read mandate: ${mErr?.message}`);
  }

  // Step 7: Handle recovery success
  if (simResult.outcome === 'success') {
    await logAudit({
      runId,
      mandateId: mandate.id,
      attemptId: attempt.id,
      day: currentDay,
      actor: 'salary_aware_policy',
      decisionType: 'mandate_recovered',
      input: { attemptNumber: attempt.attempt_number },
      output: { status: updatedMandate.status, terminalReason: updatedMandate.terminal_reason },
      reasoning: 'Salary-Aware payment succeeded; mandate recovered.',
    });
    return updatedMandate;
  }

  // Step 8: Build strictly allowlisted Observation for decision
  const observation = buildObservation({
    mandate: updatedMandate,
    currentDay,
    attemptHistory: [attempt],
  });

  const decision = decideSalaryAwareAction(observation, {
    category: simResult.declineCategory,
    retryEligible: simResult.retryEligible,
  });

  // Apply policy decision
  if (decision.action === 'stand_down') {
    assertTransition(updatedMandate.status, 'stood_down');

    const { error: sdErr } = await supabase.rpc('set_mandate_action', {
      p_run_id: runId,
      p_mandate_id: mandate.id,
      p_action: 'stand_down',
      p_action_day: null,
      p_reason: 'salary_aware_non_retryable_failure',
    });

    if (sdErr) {
      throw new Error(`salaryAwarePolicy set_mandate_action(stand_down) failed: ${sdErr.message}`);
    }

    await logAudit({
      runId,
      mandateId: mandate.id,
      attemptId: attempt.id,
      day: currentDay,
      actor: 'salary_aware_policy',
      decisionType: 'stand_down',
      input: { attemptsUsed: updatedMandate.attempts_used },
      output: { action: 'stand_down', status: 'stood_down' },
      reasoning: decision.reasoning,
    });
  } else if (decision.action === 'exhausted') {
    assertTransition(updatedMandate.status, 'exhausted');

    const { error: exErr } = await supabase.rpc('set_mandate_action', {
      p_run_id: runId,
      p_mandate_id: mandate.id,
      p_action: 'exhausted',
      p_action_day: null,
      p_reason: 'salary_aware_max_attempts_reached',
    });

    if (exErr) {
      throw new Error(`salaryAwarePolicy set_mandate_action(exhausted) failed: ${exErr.message}`);
    }

    await logAudit({
      runId,
      mandateId: mandate.id,
      attemptId: attempt.id,
      day: currentDay,
      actor: 'salary_aware_policy',
      decisionType: 'exhaustion',
      input: { attemptsUsed: updatedMandate.attempts_used },
      output: { action: 'exhausted', status: 'exhausted' },
      reasoning: decision.reasoning,
    });
  } else if (decision.action === 'retry') {
    const nextActionDay = currentDay + decision.delayDays;
    assertMandateAction(updatedMandate.status, 'retry');

    const { error: retryErr } = await supabase.rpc('set_mandate_action', {
      p_run_id: runId,
      p_mandate_id: mandate.id,
      p_action: 'retry',
      p_action_day: nextActionDay,
      p_reason: decision.reasoning,
    });

    if (retryErr) {
      throw new Error(`salaryAwarePolicy set_mandate_action(retry) failed: ${retryErr.message}`);
    }

    await logAudit({
      runId,
      mandateId: mandate.id,
      attemptId: attempt.id,
      day: currentDay,
      actor: 'salary_aware_policy',
      decisionType: 'retry_scheduled',
      input: {
        attemptsUsed: updatedMandate.attempts_used,
        delayDays: decision.delayDays,
        failureDay: currentDay,
        noisyPaydayHint: observation.noisyPaydayHint,
      },
      output: { action: 'retry', nextActionDay },
      reasoning: decision.reasoning,
    });
  }

  const { data: finalMandate } = await supabase
    .from('mandates')
    .select('*')
    .eq('id', mandate.id)
    .single();

  return finalMandate;
}
