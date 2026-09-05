import { Router } from 'express';
import { supabase } from '../config/supabase.js';
import { generateSyntheticData } from '../generators/syntheticDataGenerator.js';
import { runAllRecovery } from '../recovery/recoveryRunner.js';
import { getSimulationMetrics } from '../evaluation/metrics.js';

const router = Router();

// ── GET /api/health ──────────────────────────────────────────────────────────
router.get('/health', (_req, res) => {
  return res.status(200).json({ status: 'ok' });
});

// ── POST /api/simulations ───────────────────────────────────────────────────
router.post('/simulations', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }

    const { seed, mandateCount, maxDays } = req.body;

    if (seed === undefined || typeof seed !== 'number' || !Number.isFinite(seed)) {
      return res.status(400).json({ error: 'seed must be a finite number' });
    }

    if (
      mandateCount === undefined ||
      typeof mandateCount !== 'number' ||
      !Number.isInteger(mandateCount) ||
      mandateCount < 1 ||
      mandateCount > 10000
    ) {
      return res.status(400).json({ error: 'mandateCount must be a positive integer between 1 and 10000' });
    }

    if (
      maxDays === undefined ||
      typeof maxDays !== 'number' ||
      !Number.isInteger(maxDays) ||
      maxDays < 1 ||
      maxDays > 365
    ) {
      return res.status(400).json({ error: 'maxDays must be a positive integer between 1 and 365' });
    }

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

export default router;
