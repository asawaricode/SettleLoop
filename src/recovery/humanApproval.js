// src/recovery/humanApproval.js
//
// Step 15: Human Approval Workflow for the Razorpay Payment Recovery System.
//
// Responsibilities:
//   - Manage human approval lifecycle for Smart mandates routed to human review.
//   - requestHumanApproval: validates mandate state, formats proposed_action with absolute day,
//     enforces the 2-day expiry policy (bounded by simulation max_days), calls create_approval_request(),
//     and writes an audit log.
//   - approveHumanApproval: enforces explicit decidedBy, calls resolve_approval('approved'),
//     writes an audit log, and returns fresh mandate state (pending with retry).
//   - rejectHumanApproval: enforces explicit decidedBy, calls resolve_approval('rejected'),
//     writes an audit log, and returns fresh mandate state (stood_down with none).
//   - expireHumanApprovals: pre-queries due pending approvals for per-record audit logging,
//     calls expire_approval_requests(), and handles count mismatches gracefully with a warning.
//
// Explicitly does NOT:
//   - Execute payments or call execute_attempt() / complete_attempt().
//   - Create payment attempts.
//   - Bypass Guardrails or max-attempt rules.
//   - Update mandates or approval_requests state directly from JS (RPCs are authoritative).

import { supabase } from '../config/supabase.js';
import { logAudit } from '../utils/auditLogger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_APPROVAL_WINDOW_DAYS = 2;

// ─────────────────────────────────────────────────────────────────────────────
// 1. requestHumanApproval
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a human approval request for a mandate requiring review.
 *
 * @param {object} params
 * @param {string} params.runId - simulation_runs.id (required)
 * @param {object} params.mandate - Fresh mandate record from DB (required, status must be 'pending')
 * @param {number} params.currentDay - Current simulation day (required, integer >= 0)
 * @param {object} params.proposal - Smart recovery proposal (required)
 * @param {number} [params.expiresDay] - Explicit expiration day; defaults to currentDay + 2
 * @param {number} [params.maxDays] - Simulation max_days; fetched from DB if not provided
 *
 * @returns {Promise<{
 *   approvalId: string,
 *   expiresDay: number,
 *   proposedAction: object
 * }>}
 */
export async function requestHumanApproval({
  runId,
  mandate,
  currentDay,
  proposal,
  expiresDay,
  maxDays,
}) {
  if (!runId || typeof runId !== 'string' || runId.trim() === '') {
    throw new Error('requestHumanApproval: runId must be a non-empty string');
  }
  if (!mandate || !mandate.id) {
    throw new Error('requestHumanApproval: mandate with id is required');
  }
  if (currentDay === undefined || currentDay === null || typeof currentDay !== 'number' || currentDay < 0) {
    throw new Error('requestHumanApproval: currentDay must be a non-negative number');
  }
  if (!proposal || typeof proposal !== 'object') {
    throw new Error('requestHumanApproval: proposal object is required');
  }

  // 1. Mandate state validation: only 'pending' mandates are eligible
  if (mandate.status !== 'pending') {
    throw new Error(
      `requestHumanApproval: cannot create approval request for mandate ${mandate.id} in status '${mandate.status}' (must be 'pending')`
    );
  }

  // 2. Fetch simulation max_days if not passed
  let effectiveMaxDays = maxDays;
  if (effectiveMaxDays === undefined || effectiveMaxDays === null) {
    const { data: run, error: runErr } = await supabase
      .from('simulation_runs')
      .select('max_days')
      .eq('id', runId)
      .single();

    if (runErr || !run) {
      throw new Error(`requestHumanApproval: failed to fetch simulation run ${runId}: ${runErr?.message}`);
    }
    effectiveMaxDays = run.max_days;
  }

  // 3. Expiry day policy:
  //    - Normal default: currentDay + 2
  //    - Cannot be earlier than currentDay
  //    - Cannot exceed simulation_runs.max_days
  let calculatedExpiresDay = expiresDay;
  if (calculatedExpiresDay === undefined || calculatedExpiresDay === null) {
    calculatedExpiresDay = currentDay + DEFAULT_APPROVAL_WINDOW_DAYS;
  }

  if (typeof calculatedExpiresDay !== 'number' || !Number.isInteger(calculatedExpiresDay)) {
    throw new Error('requestHumanApproval: expiresDay must be an integer');
  }
  if (calculatedExpiresDay < currentDay) {
    throw new Error(
      `requestHumanApproval: expiresDay (${calculatedExpiresDay}) cannot be earlier than currentDay (${currentDay})`
    );
  }
  if (calculatedExpiresDay > effectiveMaxDays) {
    throw new Error(
      `requestHumanApproval: expiresDay (${calculatedExpiresDay}) cannot exceed simulation max_days (${effectiveMaxDays})`
    );
  }

  // 4. Construct stored proposed_action with absolute day:
  //    resolve_approval() requires proposed_action->>'day' to compute next_action_day
  const delayDays = Number.isInteger(proposal.delayDays)
    ? proposal.delayDays
    : Number.isInteger(proposal.retryDelayDays)
    ? proposal.retryDelayDays
    : 2;

  const storedProposedAction = {
    action: 'retry',
    day: currentDay + delayDays,
    delayDays,
    channel: proposal.channel || 'auto_debit',
    discountPercent: proposal.discountPercent ?? 0,
    confidence: proposal.confidence ?? 1,
    reasoning: proposal.reasoning || '',
  };

  // 5. Atomic transition via create_approval_request RPC
  const { data: approvalId, error: rpcErr } = await supabase.rpc('create_approval_request', {
    p_run_id: runId,
    p_mandate_id: mandate.id,
    p_created_day: currentDay,
    p_expires_day: calculatedExpiresDay,
    p_proposed_action: storedProposedAction,
  });

  if (rpcErr) {
    throw new Error(`create_approval_request RPC failed: ${rpcErr.message}`);
  }

  // 6. Audit log: approval_requested
  await logAudit({
    runId,
    mandateId: mandate.id,
    attemptId: null,
    day: currentDay,
    actor: 'smart_policy',
    decisionType: 'approval_requested',
    input: {
      currentDay,
      expiresDay: calculatedExpiresDay,
      proposal,
    },
    output: {
      approvalId,
      status: 'pending_human_approval',
      proposedAction: storedProposedAction,
    },
    reasoning: proposal.reasoning || 'Mandate routed to human review by Guardrails/Smart Policy',
  });

  return {
    approvalId,
    expiresDay: calculatedExpiresDay,
    proposedAction: storedProposedAction,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. approveHumanApproval
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves an approval request with decision 'approved'.
 * Returns the mandate to 'pending' with next_action = 'retry' and
 * next_action_day = max(decidedDay, proposed_action.day).
 *
 * @param {object} params
 * @param {string} params.approvalId - approval_requests.id (required)
 * @param {string} params.decidedBy - Reviewer identifier (required)
 * @param {number} params.decidedDay - Simulation day of decision (required)
 * @param {string} [params.decisionReason] - Optional reasoning text
 *
 * @returns {Promise<{
 *   approvalId: string,
 *   status: 'approved',
 *   mandate: object
 * }>}
 */
export async function approveHumanApproval({
  approvalId,
  decidedBy,
  decidedDay,
  decisionReason = null,
}) {
  if (!approvalId || typeof approvalId !== 'string' || approvalId.trim() === '') {
    throw new Error('approveHumanApproval: approvalId must be a non-empty string');
  }
  if (!decidedBy || typeof decidedBy !== 'string' || decidedBy.trim() === '') {
    throw new Error('approveHumanApproval: decidedBy is explicitly required');
  }
  if (decidedDay === undefined || decidedDay === null || typeof decidedDay !== 'number' || decidedDay < 0) {
    throw new Error('approveHumanApproval: decidedDay must be a non-negative number');
  }

  // Pre-fetch approval request to verify it is pending and retrieve IDs for auditing
  const { data: approval, error: fetchErr } = await supabase
    .from('approval_requests')
    .select('*')
    .eq('id', approvalId)
    .single();

  if (fetchErr || !approval) {
    throw new Error(`approveHumanApproval: approval request ${approvalId} not found`);
  }
  if (approval.status !== 'pending') {
    throw new Error(`approveHumanApproval: approval request ${approvalId} is not pending (status: '${approval.status}')`);
  }

  // Call resolve_approval RPC
  const { error: rpcErr } = await supabase.rpc('resolve_approval', {
    p_approval_id: approvalId,
    p_decision: 'approved',
    p_decided_by: decidedBy,
    p_decided_day: decidedDay,
    p_decision_reason: decisionReason,
  });

  if (rpcErr) {
    throw new Error(`resolve_approval(approved) failed: ${rpcErr.message}`);
  }

  // Audit log: approval_approved
  await logAudit({
    runId: approval.run_id,
    mandateId: approval.mandate_id,
    attemptId: null,
    day: decidedDay,
    actor: decidedBy,
    decisionType: 'approval_approved',
    input: {
      approvalId,
      decidedBy,
      decidedDay,
      decisionReason,
    },
    output: {
      decision: 'approved',
      status: 'approved',
    },
    reasoning: decisionReason || `Approval request ${approvalId} approved by ${decidedBy}`,
  });

  // Re-read authoritative mandate state fresh from DB
  const { data: freshMandate, error: mErr } = await supabase
    .from('mandates')
    .select('*')
    .eq('id', approval.mandate_id)
    .single();

  if (mErr || !freshMandate) {
    throw new Error(`approveHumanApproval: failed to re-read mandate: ${mErr?.message}`);
  }

  return {
    approvalId,
    status: 'approved',
    mandate: freshMandate,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. rejectHumanApproval
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves an approval request with decision 'rejected'.
 * Transitions the mandate to 'stood_down' with next_action = 'none' and next_action_day = null.
 *
 * @param {object} params
 * @param {string} params.approvalId - approval_requests.id (required)
 * @param {string} params.decidedBy - Reviewer identifier (required)
 * @param {number} params.decidedDay - Simulation day of decision (required)
 * @param {string} [params.decisionReason] - Optional reasoning text
 *
 * @returns {Promise<{
 *   approvalId: string,
 *   status: 'rejected',
 *   mandate: object
 * }>}
 */
export async function rejectHumanApproval({
  approvalId,
  decidedBy,
  decidedDay,
  decisionReason = null,
}) {
  if (!approvalId || typeof approvalId !== 'string' || approvalId.trim() === '') {
    throw new Error('rejectHumanApproval: approvalId must be a non-empty string');
  }
  if (!decidedBy || typeof decidedBy !== 'string' || decidedBy.trim() === '') {
    throw new Error('rejectHumanApproval: decidedBy is explicitly required');
  }
  if (decidedDay === undefined || decidedDay === null || typeof decidedDay !== 'number' || decidedDay < 0) {
    throw new Error('rejectHumanApproval: decidedDay must be a non-negative number');
  }

  // Pre-fetch approval request to verify it is pending and retrieve IDs for auditing
  const { data: approval, error: fetchErr } = await supabase
    .from('approval_requests')
    .select('*')
    .eq('id', approvalId)
    .single();

  if (fetchErr || !approval) {
    throw new Error(`rejectHumanApproval: approval request ${approvalId} not found`);
  }
  if (approval.status !== 'pending') {
    throw new Error(`rejectHumanApproval: approval request ${approvalId} is not pending (status: '${approval.status}')`);
  }

  // Call resolve_approval RPC
  const { error: rpcErr } = await supabase.rpc('resolve_approval', {
    p_approval_id: approvalId,
    p_decision: 'rejected',
    p_decided_by: decidedBy,
    p_decided_day: decidedDay,
    p_decision_reason: decisionReason,
  });

  if (rpcErr) {
    throw new Error(`resolve_approval(rejected) failed: ${rpcErr.message}`);
  }

  // Audit log: approval_rejected
  await logAudit({
    runId: approval.run_id,
    mandateId: approval.mandate_id,
    attemptId: null,
    day: decidedDay,
    actor: decidedBy,
    decisionType: 'approval_rejected',
    input: {
      approvalId,
      decidedBy,
      decidedDay,
      decisionReason,
    },
    output: {
      decision: 'rejected',
      status: 'rejected',
    },
    reasoning: decisionReason || `Approval request ${approvalId} rejected by ${decidedBy}`,
  });

  // Re-read authoritative mandate state fresh from DB
  const { data: freshMandate, error: mErr } = await supabase
    .from('mandates')
    .select('*')
    .eq('id', approval.mandate_id)
    .single();

  if (mErr || !freshMandate) {
    throw new Error(`rejectHumanApproval: failed to re-read mandate: ${mErr?.message}`);
  }

  return {
    approvalId,
    status: 'rejected',
    mandate: freshMandate,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. expireHumanApprovals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expires pending approval requests due by currentDay.
 * Captures affected approval_id/mandate_id pairs via pre-query for accurate audit logging,
 * invokes expire_approval_requests() RPC, and writes per-record audit logs.
 *
 * @param {object} params
 * @param {string} params.runId - simulation_runs.id (required)
 * @param {number} params.currentDay - Current simulation day (required)
 *
 * @returns {Promise<{
 *   expiredCount: number,
 *   expiredApprovals: Array<{ approvalId: string, mandateId: string }>
 * }>}
 */
export async function expireHumanApprovals({ runId, currentDay }) {
  if (!runId || typeof runId !== 'string' || runId.trim() === '') {
    throw new Error('expireHumanApprovals: runId must be a non-empty string');
  }
  if (currentDay === undefined || currentDay === null || typeof currentDay !== 'number' || currentDay < 0) {
    throw new Error('expireHumanApprovals: currentDay must be a non-negative number');
  }

  // 1. Pre-query due pending approvals for per-record auditing
  const { data: expiring, error: qErr } = await supabase
    .from('approval_requests')
    .select('id, mandate_id, expires_day')
    .eq('run_id', runId)
    .eq('status', 'pending')
    .lte('expires_day', currentDay);

  if (qErr) {
    throw new Error(`expireHumanApprovals pre-query failed: ${qErr.message}`);
  }

  // 2. Call atomic expire_approval_requests RPC
  const { data: rpcCount, error: expErr } = await supabase.rpc('expire_approval_requests', {
    p_run_id: runId,
    p_current_day: currentDay,
  });

  if (expErr) {
    throw new Error(`expire_approval_requests RPC failed: ${expErr.message}`);
  }

  const actualExpiredCount = typeof rpcCount === 'number' ? rpcCount : (expiring?.length || 0);

  // 3. Graceful handling of count mismatch (e.g. concurrent expiration)
  if (expiring && expiring.length !== actualExpiredCount) {
    console.warn(
      `expireHumanApprovals: pre-query captured ${expiring.length} records, but RPC returned ${actualExpiredCount}`
    );
  }

  // 4. Per-record audit logging
  for (const item of expiring || []) {
    await logAudit({
      runId,
      mandateId: item.mandate_id,
      attemptId: null,
      day: currentDay,
      actor: 'system_clock',
      decisionType: 'approval_expired',
      input: {
        approvalId: item.id,
        expiresDay: item.expires_day,
        currentDay,
      },
      output: {
        status: 'expired',
        action: 'stood_down',
      },
      reasoning: `Approval request ${item.id} expired on day ${currentDay} (expires_day: ${item.expires_day}). Mandate stood down.`,
    });
  }

  return {
    expiredCount: actualExpiredCount,
    expiredApprovals: (expiring || []).map((e) => ({
      approvalId: e.id,
      mandateId: e.mandate_id,
    })),
  };
}
