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

export default router;
