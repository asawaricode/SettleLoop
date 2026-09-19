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
      confidence: approval?.proposed_action?.confidence ?? 0.8,
      guardrailResult: guardrailLog ? {
        allowed: guardrailLog.output?.allowed ?? true,
        reasons: guardrailLog.input?.reasons || (guardrailLog.reasoning ? [guardrailLog.reasoning] : ['Guardrails passed']),
      } : null,
      finalAction: mandate.next_action,
      retryDay: mandate.next_action_day,
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
