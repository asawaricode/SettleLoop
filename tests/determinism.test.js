// tests/determinism.test.js
//
// Focused regression test for synthetic experiment determinism and reproducibility.
//
// Verifies that two completely fresh synthetic runs executed with identical
// configuration (seed=20001, mandateCount=9, maxDays=7) produce byte-for-byte
// identical simulation outcomes and metrics, independent of PostgreSQL random UUIDs,
// database insertion order, or execution time.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../src/config/supabase.js';
import { generateSyntheticData } from '../src/generators/syntheticDataGenerator.js';
import { runAllRecovery } from '../src/recovery/recoveryRunner.js';
import { getSimulationMetrics } from '../src/evaluation/metrics.js';

describe('Synthetic Experiment Determinism & Reproducibility', () => {
  const createdRunIds = [];

  after(async () => {
    for (const runId of createdRunIds) {
      try {
        await supabase.from('approval_requests').delete().eq('run_id', runId);
        await supabase.from('audit_logs').delete().eq('run_id', runId);
        await supabase.from('attempts').delete().eq('run_id', runId);
        await supabase.from('mandates').delete().eq('run_id', runId);
        await supabase.from('simulation_runs').delete().eq('id', runId);
      } catch (err) {
        console.warn(`Cleanup error for run ${runId}:`, err.message);
      }
    }
  });

  it('Two completely fresh runs with seed=20001, mandateCount=9, maxDays=7 produce identical outcomes', async () => {
    const config = {
      seed: 20001,
      mandateCount: 9,
      maxDays: 7,
    };

    // ── 1. Create Run A (completely fresh) ───────────────────────────────────
    const runA = await generateSyntheticData(config);
    createdRunIds.push(runA.simulationRunId);

    // ── 2. Create Run B (completely fresh, separate database rows) ───────────
    const runB = await generateSyntheticData(config);
    createdRunIds.push(runB.simulationRunId);

    // Verify runs have distinct database UUIDs
    assert.notEqual(
      runA.simulationRunId,
      runB.simulationRunId,
      'Run A and Run B must have distinct simulation_runs UUIDs'
    );
    assert.equal(runA.mandateIds.length, 9);
    assert.equal(runB.mandateIds.length, 9);

    // ── 3. Verify initial generated synthetic mandate data matches ──────────
    const { data: rawMandatesA } = await supabase
      .from('mandates')
      .select('mandate_id, amount, income_day_of_month, balance_volatility, contact_consent, experiment_arm, status, first_due_day, next_action, next_action_day, attempts_used')
      .eq('run_id', runA.simulationRunId)
      .order('mandate_id', { ascending: true });

    const { data: rawMandatesB } = await supabase
      .from('mandates')
      .select('mandate_id, amount, income_day_of_month, balance_volatility, contact_consent, experiment_arm, status, first_due_day, next_action, next_action_day, attempts_used')
      .eq('run_id', runB.simulationRunId)
      .order('mandate_id', { ascending: true });

    assert.deepEqual(
      rawMandatesA,
      rawMandatesB,
      'Initial synthetic mandate data must be identical between Run A and Run B'
    );

    // ── 4. Execute recovery runner for both runs in deterministic benchmark mode ──
    const resultA = await runAllRecovery({
      runId: runA.simulationRunId,
      benchmark: true,
      deterministic: true,
    });

    const resultB = await runAllRecovery({
      runId: runB.simulationRunId,
      benchmark: true,
      deterministic: true,
    });

    // Compare runner execution summaries
    assert.equal(resultA.processedCount, resultB.processedCount, 'Processed count must match');
    assert.deepEqual(resultA.daysEvaluated, resultB.daysEvaluated, 'Days evaluated sequence must match');
    assert.equal(resultA.finalDay, resultB.finalDay, 'Final simulation day must match');
    assert.equal(resultA.terminatedReason, resultB.terminatedReason, 'Termination reason must match');

    // ── 5. Compare post-recovery mandate states ─────────────────────────────
    const { data: postMandatesA } = await supabase
      .from('mandates')
      .select('mandate_id, status, terminal_reason, attempts_used, next_action, next_action_day')
      .eq('run_id', runA.simulationRunId)
      .order('mandate_id', { ascending: true });

    const { data: postMandatesB } = await supabase
      .from('mandates')
      .select('mandate_id, status, terminal_reason, attempts_used, next_action, next_action_day')
      .eq('run_id', runB.simulationRunId)
      .order('mandate_id', { ascending: true });

    assert.deepEqual(
      postMandatesA,
      postMandatesB,
      'Post-recovery mandate statuses, attempts used, and terminal reasons must match exactly'
    );

    // ── 6. Compare payment attempts and outcomes ────────────────────────────
    // Fetch full mandate maps to translate DB UUID -> business mandate_id
    const { data: fullMA } = await supabase
      .from('mandates')
      .select('id, mandate_id')
      .eq('run_id', runA.simulationRunId);
    const { data: fullMB } = await supabase
      .from('mandates')
      .select('id, mandate_id')
      .eq('run_id', runB.simulationRunId);

    const uuidToBizA = new Map(fullMA.map(m => [m.id, m.mandate_id]));
    const uuidToBizB = new Map(fullMB.map(m => [m.id, m.mandate_id]));

    const { data: rawAttemptsA } = await supabase
      .from('attempts')
      .select('mandate_id, attempt_number, scheduled_day, executed_day, channel, outcome, decline_code, decline_category, retry_eligible')
      .eq('run_id', runA.simulationRunId);

    const { data: rawAttemptsB } = await supabase
      .from('attempts')
      .select('mandate_id, attempt_number, scheduled_day, executed_day, channel, outcome, decline_code, decline_category, retry_eligible')
      .eq('run_id', runB.simulationRunId);

    const normalizeAttempts = (attempts, uuidMap) =>
      attempts
        .map(a => ({
          mandate_biz_id: uuidMap.get(a.mandate_id),
          attempt_number: a.attempt_number,
          scheduled_day: a.scheduled_day,
          executed_day: a.executed_day,
          channel: a.channel,
          outcome: a.outcome,
          decline_code: a.decline_code,
          decline_category: a.decline_category,
          retry_eligible: a.retry_eligible,
        }))
        .sort((x, y) =>
          x.mandate_biz_id.localeCompare(y.mandate_biz_id) || x.attempt_number - y.attempt_number
        );

    const attemptsA = normalizeAttempts(rawAttemptsA || [], uuidToBizA);
    const attemptsB = normalizeAttempts(rawAttemptsB || [], uuidToBizB);

    assert.ok(attemptsA.length > 0, 'Run A must have generated attempts');
    assert.deepEqual(
      attemptsA,
      attemptsB,
      'Every payment attempt, scheduled day, executed day, and outcome must match between fresh runs'
    );

    // ── 7. Compare authoritative computed metrics ───────────────────────────
    const metricsA = await getSimulationMetrics({ runId: runA.simulationRunId });
    const metricsB = await getSimulationMetrics({ runId: runB.simulationRunId });

    // Safety violations must match (and be 0)
    assert.equal(metricsA.safety.totalViolations, metricsB.safety.totalViolations);
    assert.equal(metricsA.safety.safe, metricsB.safety.safe);

    // Compare each experiment arm: control, baseline, smart
    for (const arm of ['control', 'baseline', 'smart']) {
      const armA = metricsA.arms[arm];
      const armB = metricsB.arms[arm];

      assert.equal(armA.mandateCount, armB.mandateCount, `${arm}: mandateCount must match`);
      assert.equal(armA.recoveredCount, armB.recoveredCount, `${arm}: recoveredCount must match`);
      assert.equal(armA.totalAmount, armB.totalAmount, `${arm}: totalAmount must match`);
      assert.equal(armA.recoveredAmount, armB.recoveredAmount, `${arm}: recoveredAmount must match`);
      assert.equal(armA.attemptsTotal, armB.attemptsTotal, `${arm}: attemptsTotal must match`);
      assert.equal(armA.recoveryRate, armB.recoveryRate, `${arm}: recoveryRate must match`);
      assert.equal(armA.averageTimeToRecovery, armB.averageTimeToRecovery, `${arm}: averageTimeToRecovery must match`);
    }
  });
});
