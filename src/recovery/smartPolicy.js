// src/recovery/smartPolicy.js
//
// Step 18: Smart Recovery Policy — executes Smart-arm mandate recovery.
//
// Responsibilities:
//   - Routes due Smart mandates through the full Smart decision pipeline.
//   - Handles 3 distinct mandate situations:
//       A. Initial decision (no prior completed attempt/failure)
//       B. Scheduled retry now due (execute one attempt)
//       C. Pending human approval — skip (do not touch)
//   - After a failed attempt, runs:
//       classifyFailure() → proposeSmartRecoveryAction() → validateGuardrails()
//       → persists the final guardrail-approved action.
//   - Hard / unknown failures and retryEligible=false are stood down deterministically.
//   - Maximum 4 attempts enforced via existing set_mandate_action('exhausted') path
//     (same as baseline — never executes attempt 5).
//   - Human review routes to requestHumanApproval(); never set_mandate_action('human_review').
//   - Retry scheduling uses set_mandate_action('retry', retryDay).
//   - All payment execution uses the existing execute_attempt → simulatePayment → complete_attempt pipeline.
//
// Explicitly does NOT:
//   - Execute payments directly or bypass the RPC pipeline.
//   - Read or write mandate/attempt state other than via existing RPCs.
//   - Expose GEMINI_API_KEY.
//   - Duplicate guardrails, approval, or classifier logic.
//   - Modify Control or Baseline policy behavior.

import { supabase } from '../config/supabase.js';
import { simulatePayment } from '../simulators/paymentSimulator.js';
import { logAudit } from '../utils/auditLogger.js';
import { assertTransition } from '../stateMachine/mandateStateMachine.js';
import { classifyFailure } from './failureClassifier.js';
import { proposeSmartRecoveryAction } from './smartAgent.js';
import { validateGuardrails } from './guardrails.js';
import { requestHumanApproval } from './humanApproval.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SMART_ATTEMPTS = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Internal Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches the latest completed (non-pending) attempt for a mandate.
 * Returns null if no completed attempt exists.
 *
 * @param {string} mandateId - mandates.id UUID
 * @returns {Promise<object|null>}
 */
async function getLatestCompletedAttempt(mandateId) {
  const { data, error } = await supabase
    .from('attempts')
    .select('id, attempt_number, outcome, decline_code, decline_category, retry_eligible, executed_day')
    .eq('mandate_id', mandateId)
    .neq('outcome', 'pending')
    .order('attempt_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return null;
  return data;
}

/**
 * Executes a single payment attempt through the standard pipeline:
 *   execute_attempt() → simulatePayment() → complete_attempt()
 *
 * Returns: { attempt, simResult, updatedMandate }
 */
async function executePaymentAttempt({ runId, mandate, currentDay, seed, channel = 'auto_debit' }) {
  const estimatedAttempt = (mandate.attempts_used || 0) + 1;
  const idempotencyKey = `recovery-run:${runId}:mandate:${mandate.id}:attempt:${estimatedAttempt}`;

  // 1. execute_attempt RPC
  const { data: attemptId, error: execErr } = await supabase.rpc('execute_attempt', {
    p_run_id: runId,
    p_mandate_id: mandate.id,
    p_day: currentDay,
    p_channel: channel,
    p_idempotency_key: idempotencyKey,
  });

  if (execErr) {
    throw new Error(`smartPolicy execute_attempt failed: ${execErr.message}`);
  }

  // 2. Fetch authoritative attempt details
  const { data: attempt, error: attErr } = await supabase
    .from('attempts')
    .select('id, attempt_number, outcome')
    .eq('id', attemptId)
    .single();

  if (attErr || !attempt) {
    throw new Error(`smartPolicy failed to read attempt ${attemptId}: ${attErr?.message}`);
  }

  // Idempotency guard: if already completed, return current mandate state
  if (attempt.outcome !== 'pending') {
    const { data: existingMandate } = await supabase
      .from('mandates')
      .select('*')
      .eq('id', mandate.id)
      .single();
    return { attempt, simResult: null, updatedMandate: existingMandate };
  }

  // 3. Run payment simulator (NEVER pass currentDay or experiment_arm)
  const simResult = simulatePayment({
    seed,
    mandateId: mandate.id,
    attemptNumber: attempt.attempt_number,
    amount: mandate.amount,
    balanceVolatility: mandate.balance_volatility,
    incomeDayOfMonth: mandate.income_day_of_month,
  });

  // 4. complete_attempt RPC
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
    throw new Error(`smartPolicy complete_attempt failed: ${compErr.message}`);
  }

  // 5. Audit: payment attempt completed
  await logAudit({
    runId,
    mandateId: mandate.id,
    attemptId: attempt.id,
    day: currentDay,
    actor: 'smart_policy',
    decisionType: 'payment_attempt_completed',
    input: { attemptNumber: attempt.attempt_number, amount: mandate.amount },
    output: {
      outcome: simResult.outcome,
      declineCode: simResult.declineCode,
      declineCategory: simResult.declineCategory,
      retryEligible: simResult.retryEligible,
    },
    reasoning: `Smart payment attempt ${attempt.attempt_number} completed with outcome: ${simResult.outcome}.`,
  });

  // 6. Re-read fresh mandate state after RPC
  const { data: updatedMandate, error: mErr } = await supabase
    .from('mandates')
    .select('*')
    .eq('id', mandate.id)
    .single();

  if (mErr || !updatedMandate) {
    throw new Error(`smartPolicy failed to re-read mandate: ${mErr?.message}`);
  }

  return { attempt, simResult, updatedMandate };
}

/**
 * Persists stand_down via set_mandate_action and writes audit log.
 */
async function standDown({ runId, mandate, currentDay, attempt, reasoning }) {
  assertTransition(mandate.status, 'stood_down');

  const { error: sdErr } = await supabase.rpc('set_mandate_action', {
    p_run_id: runId,
    p_mandate_id: mandate.id,
    p_action: 'stand_down',
    p_action_day: null,
    p_reason: 'smart_policy_stand_down',
  });

  if (sdErr) {
    throw new Error(`smartPolicy set_mandate_action(stand_down) failed: ${sdErr.message}`);
  }

  await logAudit({
    runId,
    mandateId: mandate.id,
    attemptId: attempt?.id ?? null,
    day: currentDay,
    actor: 'smart_policy',
    decisionType: 'stand_down',
    input: { attemptsUsed: mandate.attempts_used },
    output: { action: 'stand_down', status: 'stood_down' },
    reasoning: reasoning || 'Smart policy: stood down mandate.',
  });

  const { data: finalMandate } = await supabase
    .from('mandates')
    .select('*')
    .eq('id', mandate.id)
    .single();

  return finalMandate;
}

/**
 * Persists exhaustion via set_mandate_action('exhausted') and writes audit log.
 * Mirrors the Baseline pattern exactly.
 */
async function exhaustMandate({ runId, mandate, currentDay, attempt }) {
  assertTransition(mandate.status, 'exhausted');

  const { error: exErr } = await supabase.rpc('set_mandate_action', {
    p_run_id: runId,
    p_mandate_id: mandate.id,
    p_action: 'exhausted',
    p_action_day: null,
    p_reason: 'smart_max_attempts_reached',
  });

  if (exErr) {
    throw new Error(`smartPolicy set_mandate_action(exhausted) failed: ${exErr.message}`);
  }

  await logAudit({
    runId,
    mandateId: mandate.id,
    attemptId: attempt?.id ?? null,
    day: currentDay,
    actor: 'smart_policy',
    decisionType: 'exhaustion',
    input: { attemptsUsed: mandate.attempts_used },
    output: { action: 'exhausted', status: 'exhausted' },
    reasoning: 'Smart policy: reached maximum 4 attempts without recovery; mandate exhausted.',
  });

  const { data: finalMandate } = await supabase
    .from('mandates')
    .select('*')
    .eq('id', mandate.id)
    .single();

  return finalMandate;
}

/**
 * Schedules a future retry via set_mandate_action('retry', nextActionDay).
 */
async function scheduleRetry({ runId, mandate, currentDay, attempt, retryDay, reasoning }) {
  const { error: retryErr } = await supabase.rpc('set_mandate_action', {
    p_run_id: runId,
    p_mandate_id: mandate.id,
    p_action: 'retry',
    p_action_day: retryDay,
    p_reason: 'smart_retry_scheduled',
  });

  if (retryErr) {
    throw new Error(`smartPolicy set_mandate_action(retry) failed: ${retryErr.message}`);
  }

  await logAudit({
    runId,
    mandateId: mandate.id,
    attemptId: attempt?.id ?? null,
    day: currentDay,
    actor: 'smart_policy',
    decisionType: 'retry_scheduled',
    input: { attemptsUsed: mandate.attempts_used, currentDay },
    output: { action: 'retry', nextActionDay: retryDay },
    reasoning: reasoning || `Smart policy: scheduled retry on day ${retryDay}.`,
  });

  const { data: finalMandate } = await supabase
    .from('mandates')
    .select('*')
    .eq('id', mandate.id)
    .single();

  return finalMandate;
}

// ─────────────────────────────────────────────────────────────────────────────
// Smart Decision Engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the Smart AI decision pipeline for an initial decision or post-failure decision.
 *
 * For initial (no prior failure): uses a default "soft / retryEligible=true" context
 * to get the AI's first proposal. Does NOT call classifyFailure.
 *
 * For post-failure: classifies the latest failure, then calls the AI.
 *
 * In both cases the proposal is passed through validateGuardrails() before any action is taken.
 *
 * @param {object} params
 * @param {string} params.runId
 * @param {object} params.mandate - Fresh mandate from DB
 * @param {number} params.currentDay
 * @param {number} params.seed
 * @param {object|null} params.latestFailure - Latest completed failed attempt (or null)
 * @param {object} params.run - simulation_runs row
 * @returns {Promise<object>} Final mandate state
 */
async function runSmartDecision({ runId, mandate, currentDay, seed, latestFailure, run }) {
  if (!latestFailure) {
    throw new Error('smartPolicy: runSmartDecision requires a completed failure attempt');
  }

  // ── Classify failure (only on a real completed failure) ───────────────────
  const classification = classifyFailure({
    outcome: latestFailure.outcome,
    declineCode: latestFailure.decline_code,
    declineCategory: latestFailure.decline_category,
    retryEligible: latestFailure.retry_eligible,
  });

  // ── Hard safety rule (pre-guardrail): non-retryable → stand_down immediately ──
  if (!classification.retryEligible || classification.category === 'hard' || classification.category === 'unknown') {
    await logAudit({
      runId,
      mandateId: mandate.id,
      attemptId: latestFailure.id,
      day: currentDay,
      actor: 'smart_policy',
      decisionType: 'non_retryable_failure',
      input: { category: classification.category, retryEligible: classification.retryEligible },
      output: { action: 'stand_down' },
      reasoning: `Smart policy: non-retryable failure (${classification.category}); stood down.`,
    });

    return await standDown({
      runId,
      mandate,
      currentDay,
      attempt: latestFailure,
      reasoning: `Smart policy: non-retryable failure (${classification.category}); stood down.`,
    });
  }

  // ── Check exhaustion: if attempts_used >= 4, exhaust ─────────────────────
  if (mandate.attempts_used >= MAX_SMART_ATTEMPTS) {
    return await exhaustMandate({ runId, mandate, currentDay, attempt: latestFailure });
  }

  // ── Call Smart Agent ──────────────────────────────────────────────────────
  let aiProposal;
  try {
    aiProposal = await proposeSmartRecoveryAction({
      mandateId: mandate.id,
      attemptsUsed: mandate.attempts_used,
      maxAttempts: MAX_SMART_ATTEMPTS,
      amount: mandate.amount,
      balanceVolatility: mandate.balance_volatility,
      category: classification.category,
      retryEligible: classification.retryEligible,
      declineCode: classification.declineCode,
    });
  } catch (aiErr) {
    // AI call failed unexpectedly — fall back to stand_down as safest option
    await logAudit({
      runId,
      mandateId: mandate.id,
      attemptId: latestFailure?.id ?? null,
      day: currentDay,
      actor: 'smart_policy',
      decisionType: 'ai_error_fallback',
      input: { error: 'smartAgent threw an unexpected error' },
      output: { action: 'stand_down' },
      reasoning: 'Smart AI threw an error; falling back to stand_down.',
    });

    return await standDown({
      runId,
      mandate,
      currentDay,
      attempt: latestFailure || null,
      reasoning: 'Smart AI threw an unexpected error; falling back to stand_down.',
    });
  }

  // ── Audit: AI proposal ────────────────────────────────────────────────────
  await logAudit({
    runId,
    mandateId: mandate.id,
    attemptId: latestFailure?.id ?? null,
    day: currentDay,
    actor: 'smart_agent',
    decisionType: 'ai_proposal',
    input: { category: classification.category, retryEligible: classification.retryEligible, attemptsUsed: mandate.attempts_used },
    output: { action: aiProposal.action, retryDelayDays: aiProposal.retryDelayDays, source: aiProposal.source },
    reasoning: aiProposal.reasoning || '',
  });

  // ── Apply Guardrails ──────────────────────────────────────────────────────
  // Build the proposal shape that validateGuardrails expects.
  // Guardrails checks: proposal.delayDays ?? proposal.retryDelayDays
  // So we pass both names to be safe.
  const guardrailProposal = {
    action: aiProposal.action,
    delayDays: aiProposal.retryDelayDays,
    retryDelayDays: aiProposal.retryDelayDays,
    channel: 'auto_debit',          // Smart always uses auto_debit in this simulation
    discountPercent: 0,
    confidence: 0.8,                // SmartAgent fallback has no confidence field; provide default
    reasoning: aiProposal.reasoning || '',
  };

  const guardrailContext = {
    mandate: {
      status: mandate.status,
      attempts_used: mandate.attempts_used,
      contact_consent: mandate.contact_consent,
    },
    failure: {
      category: classification.category,
      retryEligible: classification.retryEligible,
    },
    retryEligible: classification.retryEligible,
    category: classification.category,
  };

  const guardrailResult = validateGuardrails(guardrailProposal, guardrailContext);

  // ── Audit: Guardrails result ──────────────────────────────────────────────
  await logAudit({
    runId,
    mandateId: mandate.id,
    attemptId: latestFailure?.id ?? null,
    day: currentDay,
    actor: 'guardrails',
    decisionType: 'guardrail_decision',
    input: { proposedAction: aiProposal.action, reasons: guardrailResult.reasons },
    output: { allowed: guardrailResult.allowed, finalAction: guardrailResult.action },
    reasoning: guardrailResult.reasons.join('; ') || 'Guardrails applied.',
  });

  // ── Execute final guardrail-approved action ───────────────────────────────
  const finalAction = guardrailResult.action;

  if (finalAction === 'stand_down') {
    return await standDown({
      runId,
      mandate,
      currentDay,
      attempt: latestFailure || null,
      reasoning: `Smart guardrail: stand_down. Reasons: ${guardrailResult.reasons.join('; ')}`,
    });
  }

  if (finalAction === 'human_review') {
    // Route to human approval — NEVER call set_mandate_action('human_review')
    // Guard against duplicate pending approval
    const { data: existingApprovals } = await supabase
      .from('approval_requests')
      .select('id')
      .eq('mandate_id', mandate.id)
      .eq('status', 'pending')
      .limit(1);

    if (existingApprovals && existingApprovals.length > 0) {
      // Already has a pending approval — do not create duplicate
      const { data: freshMandate } = await supabase
        .from('mandates')
        .select('*')
        .eq('id', mandate.id)
        .single();
      return freshMandate;
    }

    const delayDays = guardrailProposal.retryDelayDays ?? 2;
    const proposalForApproval = {
      action: 'retry',
      retryDelayDays: delayDays,
      delayDays,
      channel: guardrailProposal.channel,
      discountPercent: guardrailProposal.discountPercent,
      confidence: guardrailProposal.confidence,
      reasoning: aiProposal.reasoning || 'Smart policy: routed to human review.',
    };

    // expiry is bounded by maxDays
    const rawExpiry = currentDay + 2;
    const effectiveMaxDays = run.max_days;
    const expiresDay = Math.min(rawExpiry, effectiveMaxDays);

    await requestHumanApproval({
      runId,
      mandate,
      currentDay,
      proposal: proposalForApproval,
      expiresDay,
      maxDays: effectiveMaxDays,
    });

    const { data: freshMandate } = await supabase
      .from('mandates')
      .select('*')
      .eq('id', mandate.id)
      .single();

    return freshMandate;
  }

  // finalAction === 'retry'
  const delayDays = guardrailProposal.retryDelayDays ?? 2;
  const retryDay = currentDay + delayDays;

  if (delayDays <= 0 || retryDay <= currentDay) {
    // Same-day or zero-delay retry: if today is already the scheduled day,
    // do NOT re-execute (the caller already executed or will execute on the next pass).
    // Schedule for tomorrow at minimum to avoid infinite loops.
    const safeRetryDay = currentDay + 1;
    return await scheduleRetry({
      runId,
      mandate,
      currentDay,
      attempt: latestFailure || null,
      retryDay: safeRetryDay,
      reasoning: `Smart policy: retry scheduled on day ${safeRetryDay} (adjusted from delay=${delayDays}).`,
    });
  }

  return await scheduleRetry({
    runId,
    mandate,
    currentDay,
    attempt: latestFailure || null,
    retryDay,
    reasoning: `Smart policy: retry scheduled on day ${retryDay} (delay: ${delayDays} days after day ${currentDay}).`,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executes the Smart recovery policy for a single due mandate.
 *
 * Handles:
 *   - Initial due mandate: executes the initial payment attempt first.
 *     If successful -> mandate recovered.
 *     If failed -> classifies real failure, calls Smart AI agent, validates guardrails, and persists decision.
 *   - Scheduled retry now due: verifies guards (max attempts, non-retryable), then executes attempt.
 *   - pending_human_approval: skipped silently (handled by human approval flow).
 *
 * @param {object} params
 * @param {string} params.runId - simulation_runs.id
 * @param {object} params.mandate - Fresh mandate record from database
 * @param {number} params.currentDay - Current simulation day
 * @param {number} params.seed - Simulation random seed
 * @param {object} params.run - simulation_runs row (includes max_days)
 * @returns {Promise<object>} Final mandate record
 */
export async function executeSmartPolicy({ runId, mandate, currentDay, seed, run }) {
  if (!runId || typeof runId !== 'string' || runId.trim() === '') {
    throw new Error('smartPolicy: runId must be a non-empty string');
  }
  if (!mandate || !mandate.id) {
    throw new Error('smartPolicy: mandate with id is required');
  }
  if (currentDay === undefined || currentDay === null || typeof currentDay !== 'number') {
    throw new Error('smartPolicy: currentDay must be a number');
  }
  if (seed === undefined || seed === null) {
    throw new Error('smartPolicy: seed is required');
  }
  if (!run || !run.max_days) {
    throw new Error('smartPolicy: run with max_days is required');
  }

  if (mandate.experiment_arm !== 'smart') {
    throw new Error(`smartPolicy: expected smart arm, got ${mandate.experiment_arm}`);
  }

  // ── Situation C: pending_human_approval — skip ────────────────────────────
  if (mandate.status === 'pending_human_approval') {
    // Leave to human approval flow; do nothing
    return mandate;
  }

  // ── Eligibility check (caller should have ensured this) ──────────────────
  if (mandate.status !== 'pending') {
    throw new Error(`smartPolicy: mandate ${mandate.id} is not pending (status: ${mandate.status})`);
  }
  if (mandate.next_action !== 'retry') {
    throw new Error(`smartPolicy: mandate ${mandate.id} next_action is not retry (${mandate.next_action})`);
  }
  if (mandate.next_action_day > currentDay) {
    throw new Error(`smartPolicy: mandate ${mandate.id} is not due yet (next_action_day: ${mandate.next_action_day}, currentDay: ${currentDay})`);
  }

  // ── Prior completed attempt check (if this is a scheduled retry) ─────────
  const latestFailure = await getLatestCompletedAttempt(mandate.id);

  if (latestFailure) {
    // 1. Maximum attempts guard: never execute attempt 5
    if (mandate.attempts_used >= MAX_SMART_ATTEMPTS) {
      return await exhaustMandate({ runId, mandate, currentDay, attempt: latestFailure });
    }

    // 2. Non-retryable safety guard: never retry hard or unknown failures
    const classification = classifyFailure({
      outcome: latestFailure.outcome,
      declineCode: latestFailure.decline_code,
      declineCategory: latestFailure.decline_category,
      retryEligible: latestFailure.retry_eligible,
    });

    if (!classification.retryEligible || classification.category === 'hard' || classification.category === 'unknown') {
      return await standDown({
        runId,
        mandate,
        currentDay,
        attempt: latestFailure,
        reasoning: `Smart policy: prior failure was non-retryable (${classification.category}); stood down without executing.`,
      });
    }
  }

  // ── Execute payment attempt (initial attempt or due scheduled retry) ───────
  // If payment succeeds -> recovered (no AI decision needed).
  // If payment fails -> executeAttemptAndDecide calls runSmartDecision with actual failure.
  return await executeAttemptAndDecide({ runId, mandate, currentDay, seed, run });
}

/**
 * Executes exactly one payment attempt and then runs post-failure Smart decision if needed.
 */
async function executeAttemptAndDecide({ runId, mandate, currentDay, seed, run }) {
  const { attempt, simResult, updatedMandate } = await executePaymentAttempt({
    runId,
    mandate,
    currentDay,
    seed,
    channel: 'auto_debit',
  });

  // If idempotency guard returned early (attempt was already completed)
  if (!simResult) {
    return updatedMandate;
  }

  // ── Success: complete_attempt() already moved mandate to recovered ────────
  if (simResult.outcome === 'success') {
    await logAudit({
      runId,
      mandateId: mandate.id,
      attemptId: attempt.id,
      day: currentDay,
      actor: 'smart_policy',
      decisionType: 'mandate_recovered',
      input: { attemptNumber: attempt.attempt_number },
      output: { status: updatedMandate.status },
      reasoning: 'Smart payment succeeded; mandate recovered.',
    });
    return updatedMandate;
  }

  // ── Failure: re-read fresh mandate, then run Smart post-failure decision ──
  // Re-read to get authoritative attempts_used after complete_attempt()
  const { data: freshMandate, error: fErr } = await supabase
    .from('mandates')
    .select('*')
    .eq('id', mandate.id)
    .single();

  if (fErr || !freshMandate) {
    throw new Error(`smartPolicy failed to re-read mandate after failure: ${fErr?.message}`);
  }

  // If mandate is already terminal (e.g., complete_attempt() exhausted it), stop
  const TERMINAL = new Set(['recovered', 'stood_down', 'exhausted']);
  if (TERMINAL.has(freshMandate.status)) {
    return freshMandate;
  }

  // Fetch the fresh latest completed attempt (just completed)
  const latestFailure = await getLatestCompletedAttempt(mandate.id);

  return await runSmartDecision({
    runId,
    mandate: freshMandate,
    currentDay,
    seed,
    latestFailure,
    run,
  });
}
