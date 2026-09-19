import { Router } from 'express';
import { supabase } from '../config/supabase.js';
import { generateSyntheticData } from '../generators/syntheticDataGenerator.js';
import { runAllRecovery } from '../recovery/recoveryRunner.js';
import { getSimulationMetrics } from '../evaluation/metrics.js';
import { approveHumanApproval, rejectHumanApproval } from '../recovery/humanApproval.js';
import { validateBody, simulationCreateSchema, approvalResolveSchema } from './validation.js';

const router = Router();

// ── GET /api/health ──────────────────────────────────────────────────────────
router.get('/health', (_req, res) => {
  return res.status(200).json({ status: 'ok' });
});

// ── POST /api/simulations ───────────────────────────────────────────────────
router.post('/simulations', validateBody(simulationCreateSchema), async (req, res) => {
  try {
    const { seed, mandateCount, maxDays } = req.body;
    const { simulationRunId, mandateIds } = await generateSyntheticData({
      seed,
      mandateCount,
      maxDays,
    });
    return res.status(201).json({
      runId: simulationRunId,
      mandateIds,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create simulation run' });
  }
});

// ── GET /api/simulations/:runId ─────────────────────────────────────────────
router.get('/simulations/:runId', async (req, res) => {
  try {
    const { runId } = req.params;
    if (!runId || typeof runId !== 'string' || runId.trim() === '') {
      return res.status(400).json({ error: 'runId is required' });
    }

    const { data: run, error } = await supabase
      .from('simulation_runs')
      .select('id, current_day, max_days, status')
      .eq('id', runId)
      .maybeSingle();

    if (error) {
      if (error.code === '22P02') {
        return res.status(404).json({ error: 'Simulation run not found' });
      }
      return res.status(500).json({ error: 'Failed to fetch simulation run' });
    }

    if (!run) {
      return res.status(404).json({ error: 'Simulation run not found' });
    }

    return res.status(200).json({
      runId: run.id,
      currentDay: run.current_day,
      maxDays: run.max_days,
      status: run.status,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch simulation run' });
  }
});

// ── POST /api/simulations/:runId/run ────────────────────────────────────────
router.post('/simulations/:runId/run', async (req, res) => {
  try {
    const { runId } = req.params;
    if (!runId || typeof runId !== 'string' || runId.trim() === '') {
      return res.status(400).json({ error: 'runId is required' });
    }

    const runnerResult = await runAllRecovery({ runId });

    return res.status(200).json({
      runId: runnerResult.runId,
      processedCount: runnerResult.processedCount,
      currentDay: runnerResult.finalDay,
      results: runnerResult,
    });
  } catch (err) {
    if (err.message && (err.message.includes('not found') || err.message.includes('22P02'))) {
      return res.status(404).json({ error: 'Simulation run not found' });
    }
    return res.status(500).json({ error: 'Simulation run failed to execute' });
  }
});

// ── GET /api/simulations/:runId/metrics ─────────────────────────────────────
router.get('/simulations/:runId/metrics', async (req, res) => {
  try {
    const { runId } = req.params;
    if (!runId || typeof runId !== 'string' || runId.trim() === '') {
      return res.status(400).json({ error: 'runId is required' });
    }

    const metrics = await getSimulationMetrics({ runId });
    return res.status(200).json(metrics);
  } catch (err) {
    if (err.message && (err.message.includes('not found') || err.message.includes('22P02'))) {
      return res.status(404).json({ error: 'Simulation run not found' });
    }
    return res.status(500).json({ error: 'Failed to retrieve simulation metrics' });
  }
});

// ── GET /api/simulations/:runId/eligible-mandates ───────────────────────────
//
// Read-only query returning mandates currently eligible for manual Razorpay
// Test Mode order creation:
//   - belongs to current simulation run (run_id = runId)
//   - experiment_arm = 'smart'
//   - next_action = 'retry'
//   - attempts_used < 4
//   - amount > 0
// ---------------------------------------------------------------------------
router.get('/simulations/:runId/eligible-mandates', async (req, res) => {
  try {
    const { runId } = req.params;
    if (!runId || typeof runId !== 'string' || runId.trim() === '') {
      return res.status(400).json({ error: 'runId is required' });
    }

    const { data: mandates, error } = await supabase
      .from('mandates')
      .select('id, mandate_id, amount, experiment_arm, next_action, attempts_used, status')
      .eq('run_id', runId.trim())
      .eq('experiment_arm', 'smart')
      .eq('next_action', 'retry')
      .lt('attempts_used', 4)
      .gt('amount', 0)
      .order('mandate_id', { ascending: true });

    if (error) {
      if (error.code === '22P02') {
        return res.status(404).json({ error: 'Simulation run not found' });
      }
      return res.status(500).json({ error: 'Failed to fetch eligible mandates' });
    }

    return res.status(200).json({
      runId: runId.trim(),
      mandates: mandates || [],
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch eligible mandates' });
  }
});

// ── POST /api/approvals/:id/resolve ────────────────────────────────────────
//
// Resolves a pending human approval request.
//
// Body: { decision: 'approved'|'rejected', decidedBy: string, decidedDay: number, decisionReason?: string }
//
// approve path → calls resolve_approval('approved') via approveHumanApproval().
//               Mandate returns to 'pending' with next_action='retry'.
// reject  path → calls resolve_approval('rejected') via rejectHumanApproval().
//               Mandate transitions to 'stood_down'.
//
// Both paths enforce:
//   - Approval must be in 'pending' status (checked inside approve/rejectHumanApproval).
//   - Max 4 total attempts enforced by the existing resolve_approval RPC.
//   - UPI AutoPay retry guardrail is preserved (execute_attempt is NOT called here).
// ---------------------------------------------------------------------------
router.post('/approvals/:id/resolve', validateBody(approvalResolveSchema), async (req, res) => {
  try {
    const { id: approvalId } = req.params;

    if (!approvalId || typeof approvalId !== 'string' || approvalId.trim() === '') {
      return res.status(400).json({ error: 'approvalId path parameter is required' });
    }

    const { decision, decidedBy, decidedDay, decisionReason } = req.body;

    let result;
    if (decision === 'approved') {
      result = await approveHumanApproval({ approvalId, decidedBy, decidedDay, decisionReason: decisionReason ?? null });
    } else {
      result = await rejectHumanApproval({ approvalId, decidedBy, decidedDay, decisionReason: decisionReason ?? null });
    }

    return res.status(200).json({
      approvalId: result.approvalId,
      decision: result.status,        // 'approved' | 'rejected'
      mandate: {
        id: result.mandate.id,
        status: result.mandate.status,
        next_action: result.mandate.next_action,
        next_action_day: result.mandate.next_action_day,
        attempts_used: result.mandate.attempts_used,
      },
    });
  } catch (err) {
    const msg = err.message || '';
    if (
      msg.includes('not found') ||
      msg.includes('22P02') ||
      msg.includes('approval request') && msg.includes('not found')
    ) {
      return res.status(404).json({ error: 'Approval request not found' });
    }
    if (msg.includes('is not pending')) {
      return res.status(409).json({ error: msg });
    }
    return res.status(500).json({ error: 'Failed to resolve approval request' });
  }
});

// ── GET /api/mandates/:id/trace ─────────────────────────────────────────────
//
// Read-only decision trace for a single mandate.
// Inspects mandate state, latest attempt failure category, AI proposal &
// guardrail decisions from audit_logs, and human approval record if present.
// ---------------------------------------------------------------------------
router.get('/mandates/:id/trace', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string' || id.trim() === '') {
      return res.status(400).json({ error: 'Mandate ID is required' });
    }

    const { data: mandate, error: mErr } = await supabase
      .from('mandates')
      .select('id, run_id, experiment_arm, status, next_action, next_action_day, attempts_used')
      .eq('id', id.trim())
      .maybeSingle();

    if (mErr || !mandate) {
      return res.status(404).json({ error: 'Mandate not found' });
    }

    // Latest attempt for failure classification
    const { data: latestAttempt } = await supabase
      .from('attempts')
      .select('outcome, decline_code, decline_category, retry_eligible, executed_day')
      .eq('mandate_id', id.trim())
      .order('attempt_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Audit logs for AI proposal and guardrail reasoning
    const { data: auditLogs } = await supabase
      .from('audit_logs')
      .select('actor, decision_type, input, output, reasoning, created_at')
      .eq('mandate_id', id.trim())
      .order('created_at', { ascending: false });

    // Human approval request if one was routed
    const { data: approval } = await supabase
      .from('approval_requests')
      .select('id, status, proposed_action, expires_day')
      .eq('mandate_id', id.trim())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const aiLog = (auditLogs || []).find(l => l.actor === 'smart_agent' || l.decision_type === 'ai_proposal');
    const guardrailLog = (auditLogs || []).find(l => l.actor === 'guardrails' || l.decision_type === 'guardrail_decision');
    const hasAiProposal = Boolean(aiLog || approval?.proposed_action);

    return res.status(200).json({
      mandateId: mandate.id,
      arm: mandate.experiment_arm,
      status: mandate.status,
      failureCategory: latestAttempt?.decline_category || 'none',
      aiProposal: aiLog ? {
        action: aiLog.output?.action || 'none',
        retryDelayDays: aiLog.output?.retryDelayDays ?? null,
        reasoning: aiLog.reasoning || '',
      } : null,
      confidence: approval?.proposed_action?.confidence ?? (hasAiProposal ? 0.8 : null),
      guardrailResult: guardrailLog ? {
        allowed: guardrailLog.output?.allowed ?? true,
        reasons: guardrailLog.input?.reasons || (guardrailLog.reasoning ? [guardrailLog.reasoning] : ['Guardrails passed']),
      } : null,
      finalAction: mandate.next_action,
      retryDay: (mandate.status === 'pending' && mandate.next_action === 'retry') ? mandate.next_action_day : null,
      humanApproval: approval ? {
        id: approval.id,
        status: approval.status,
        expiresDay: approval.expires_day,
      } : null,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to retrieve mandate trace' });
  }
});

// ── GET /api/mandates/:id/replay ────────────────────────────────────────────
//
// Decision Replay — returns a full chronological lifecycle timeline for one
// mandate derived entirely from authoritative stored data (mandates, attempts,
// audit_logs, approval_requests). READ-ONLY: never modifies any data.
//
// Response shape:
//   {
//     mandateId, arm, status, attemptsUsed, firstDueDay,
//     failureCategory, confidence, confidenceValue, aiProposal, guardrailResult,
//     finalAction, retryDay, humanApproval,
//     timeline: [
//       { eventType, day, data: { ... } }  // ordered chronologically
//     ]
//   }
//
// eventType values:
//   'initial_state'         — mandate configuration at creation
//   'attempt'               — a payment attempt execution record
//   'ai_proposal'           — Smart-arm AI / fallback proposal
//   'guardrail_evaluation'  — guardrail check result
//   'approval_event'        — human approval routed or resolved
//   'state_transition'      — terminal or scheduled-action state change
// ---------------------------------------------------------------------------
router.get('/mandates/:id/replay', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string' || id.trim() === '') {
      return res.status(400).json({ error: 'Mandate ID is required' });
    }
    const mid = id.trim();

    // ── 1. Mandate ──────────────────────────────────────────────────────────
    const { data: mandate, error: mErr } = await supabase
      .from('mandates')
      .select('id, run_id, experiment_arm, status, next_action, next_action_day, attempts_used, first_due_day, terminal_reason, created_at')
      .eq('id', mid)
      .maybeSingle();

    if (mErr || !mandate) {
      return res.status(404).json({ error: 'Mandate not found' });
    }

    // ── 2. All attempts (ascending by attempt_number) ───────────────────────
    const { data: attempts } = await supabase
      .from('attempts')
      .select('id, attempt_number, executed_day, outcome, decline_code, decline_category, retry_eligible, created_at')
      .eq('mandate_id', mid)
      .order('attempt_number', { ascending: true });

    // ── 3. All audit logs (ascending by created_at) ─────────────────────────
    const { data: auditLogs } = await supabase
      .from('audit_logs')
      .select('id, attempt_id, actor, decision_type, input, output, reasoning, day, created_at')
      .eq('mandate_id', mid)
      .order('created_at', { ascending: true });

    // ── 4. All approval requests (ascending) ────────────────────────────────
    const { data: approvals } = await supabase
      .from('approval_requests')
      .select('id, status, proposed_action, expires_day, created_day, decided_by, decided_at, decision_reason, created_at')
      .eq('mandate_id', mid)
      .order('created_at', { ascending: true });

    // ── 5. Build timeline from authoritative stored data ────────────────────
    const timeline = [];

    // Event: initial_state
    timeline.push({
      eventType: 'initial_state',
      day: mandate.first_due_day ?? 0,
      data: {
        arm: mandate.experiment_arm,
        firstDueDay: mandate.first_due_day,
        status: 'pending',
      },
    });

    // Event: attempt (for every executed attempt row)
    for (const attempt of (attempts || [])) {
      timeline.push({
        eventType: 'attempt',
        day: attempt.executed_day,
        data: {
          attemptNumber: attempt.attempt_number,
          executedDay: attempt.executed_day,
          outcome: attempt.outcome,
          declineCategory: attempt.decline_category || null,
          declineCode: attempt.decline_code || null,
          retryEligible: attempt.retry_eligible ?? null,
        },
      });
    }

    // Event: ai_proposal (only for actual AI / fallback proposal audit records)
    const aiLogs = (auditLogs || []).filter(l =>
      l.decision_type === 'ai_proposal' || l.actor === 'smart_agent'
    );
    for (const aiLog of aiLogs) {
      const proposalSource = aiLog.output?.source || 'unknown';
      timeline.push({
        eventType: 'ai_proposal',
        day: aiLog.day ?? null,
        data: {
          action: aiLog.output?.action || null,
          source: proposalSource,
          retryDelayDays: aiLog.output?.retryDelayDays ?? null,
          reasoning: aiLog.reasoning || null,
          confidenceNote: 'NON-TRIGGERING UNDER CURRENT CONFIGURATION — confidence is deterministically assigned 0.80; Gemini currently does not provide a confidence signal.',
        },
      });
    }

    // Event: guardrail_evaluation (only for actual guardrail evaluation audit records)
    const guardrailLogs = (auditLogs || []).filter(l =>
      l.decision_type === 'guardrail_decision' || l.actor === 'guardrails'
    );
    for (const grLog of guardrailLogs) {
      const allowed = grLog.output?.allowed ?? true;
      timeline.push({
        eventType: 'guardrail_evaluation',
        day: grLog.day ?? null,
        data: {
          result: allowed ? 'PASSED' : 'BLOCKED',
          allowed,
          reasons: grLog.input?.reasons || (grLog.reasoning ? [grLog.reasoning] : []),
          reasoning: grLog.reasoning || null,
        },
      });
    }

    // Event: approval_event (only for actual approval records)
    for (const apr of (approvals || [])) {
      timeline.push({
        eventType: 'approval_event',
        day: apr.created_day ?? null,
        data: {
          approvalId: apr.id,
          status: apr.status,
          proposedAction: apr.proposed_action || null,
          expiresDay: apr.expires_day ?? null,
          decidedBy: apr.decided_by || null,
          decisionReason: apr.decision_reason || null,
          decidedAt: apr.decided_at || null,
        },
      });
    }

    // Event: state_transition (terminal outcome or scheduled in-progress state)
    const isTerminal = ['recovered', 'stood_down', 'exhausted'].includes(mandate.status);
    const lastAttempt = (attempts && attempts.length > 0) ? attempts[attempts.length - 1] : null;
    const transitionDay = isTerminal
      ? (lastAttempt?.executed_day ?? mandate.first_due_day ?? 0)
      : (mandate.next_action_day ?? mandate.first_due_day ?? null);

    timeline.push({
      eventType: 'state_transition',
      day: transitionDay,
      data: {
        status: mandate.status,
        nextAction: mandate.next_action || null,
        nextActionDay: (mandate.status === 'pending' && mandate.next_action === 'retry') ? mandate.next_action_day : null,
        terminalReason: mandate.terminal_reason || (mandate.status === 'recovered' ? 'payment_success' : null),
        isFinal: isTerminal,
      },
    });

    // Chronological sort: initial_state first, state_transition last, day ascending,
    // and causal order within same day (attempt -> ai_proposal -> guardrail -> approval).
    const TYPE_ORDER = {
      initial_state: 0,
      attempt: 1,
      ai_proposal: 2,
      guardrail_evaluation: 3,
      approval_event: 4,
      state_transition: 5,
    };

    timeline.sort((a, b) => {
      if (a.eventType === 'initial_state') return -1;
      if (b.eventType === 'initial_state') return 1;
      if (a.eventType === 'state_transition') return 1;
      if (b.eventType === 'state_transition') return -1;

      const da = a.day ?? Infinity;
      const db = b.day ?? Infinity;
      if (da !== db) return da - db;

      const oa = TYPE_ORDER[a.eventType] ?? 99;
      const ob = TYPE_ORDER[b.eventType] ?? 99;
      return oa - ob;
    });

    const hasAiProposal = aiLogs.length > 0 || Boolean(approvals && approvals.some(a => a.proposed_action));
    const hasGuardrail = guardrailLogs.length > 0;
    const latestApproval = (approvals && approvals.length > 0) ? approvals[approvals.length - 1] : null;

    return res.status(200).json({
      mandateId: mandate.id,
      arm: mandate.experiment_arm,
      status: mandate.status,
      attemptsUsed: mandate.attempts_used,
      firstDueDay: mandate.first_due_day,
      failureCategory: lastAttempt?.decline_category || null,
      confidence: hasAiProposal ? '80%' : 'N/A',
      confidenceValue: hasAiProposal ? (latestApproval?.proposed_action?.confidence ?? 0.8) : null,
      aiProposal: hasAiProposal && aiLogs.length > 0 ? {
        action: aiLogs[0].output?.action || null,
        source: aiLogs[0].output?.source || null,
        retryDelayDays: aiLogs[0].output?.retryDelayDays ?? null,
        reasoning: aiLogs[0].reasoning || null,
      } : null,
      guardrailResult: hasGuardrail ? {
        allowed: guardrailLogs[0].output?.allowed ?? true,
        reasons: guardrailLogs[0].input?.reasons || (guardrailLogs[0].reasoning ? [guardrailLogs[0].reasoning] : []),
        reasoning: guardrailLogs[0].reasoning || null,
      } : null,
      finalAction: mandate.next_action || null,
      retryDay: (mandate.status === 'pending' && mandate.next_action === 'retry') ? mandate.next_action_day : null,
      humanApproval: latestApproval ? {
        id: latestApproval.id,
        status: latestApproval.status,
        expiresDay: latestApproval.expires_day ?? null,
      } : null,
      timeline,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to retrieve mandate replay' });
  }
});


// ── GET /api/approvals ──────────────────────────────────────────────────────
//
// Read-only query of pending human approval requests for the operator UI.
// ---------------------------------------------------------------------------
router.get('/approvals', async (req, res) => {
  try {
    const { runId } = req.query;
    let query = supabase
      .from('approval_requests')
      .select('id, run_id, mandate_id, created_day, status, proposed_action, expires_day, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(25);

    if (runId && typeof runId === 'string' && runId.trim() !== '') {
      query = query.eq('run_id', runId.trim());
    }

    const { data, error } = await query;
    if (error) {
      return res.status(500).json({ error: 'Failed to fetch pending approvals' });
    }
    return res.status(200).json({ approvals: data || [] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch pending approvals' });
  }
});

// ── GET /api/webhooks/recent ────────────────────────────────────────────────
//
// Read-only query of verified webhook events from PostgreSQL webhook_events.
// ---------------------------------------------------------------------------
router.get('/webhooks/recent', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('webhook_events')
      .select('event_id, event_type, signature_verified, received_at')
      .order('received_at', { ascending: false })
      .limit(10);

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch webhook events' });
    }
    return res.status(200).json({ events: data || [] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch webhook events' });
  }
});

export default router;
