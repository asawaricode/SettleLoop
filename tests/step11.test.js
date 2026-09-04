import assert from 'node:assert/strict';
import test from 'node:test';
import { supabase } from '../src/config/supabase.js';
import { processMandate, processDueMandates } from '../src/recovery/recoveryEngine.js';
import { runControlBaselineRecovery } from '../src/recovery/recoveryRunner.js';

// Helper to create a fresh isolated test simulation run
async function createTestRun({ seed = 12345, maxDays = 10, currentDay = 0 } = {}) {
  const { data: run, error } = await supabase
    .from('simulation_runs')
    .insert({
      random_seed: seed,
      current_day: currentDay,
      max_days: maxDays,
      status: 'running',
    })
    .select()
    .single();

  if (error) throw new Error(`createTestRun failed: ${error.message}`);
  return run;
}

// Helper to create an isolated test mandate
async function createTestMandate({
  runId,
  mandateId,
  arm = 'control',
  amount = 1000,
  incomeDay = 15,
  balanceVolatility = 0.5,
  contactConsent = true,
  status = 'pending',
  firstDueDay = 1,
  nextAction = 'retry',
  nextActionDay = 1,
  attemptsUsed = 0,
}) {
  const { data: mandate, error } = await supabase
    .from('mandates')
    .insert({
      run_id: runId,
      mandate_id: mandateId,
      amount,
      income_day_of_month: incomeDay,
      balance_volatility: balanceVolatility,
      contact_consent: contactConsent,
      experiment_arm: arm,
      status,
      first_due_day: firstDueDay,
      next_action: nextAction,
      next_action_day: nextActionDay,
      attempts_used: attemptsUsed,
      created_day: 0,
    })
    .select()
    .single();

  if (error) throw new Error(`createTestMandate failed: ${error.message}`);
  return mandate;
}

test('STEP 11: RECOVERY ENGINE', async (t) => {

  await t.test('1. processMandate dispatches Control correctly', async () => {
    const run = await createTestRun({ seed: 42, maxDays: 5, currentDay: 1 });
    const mandate = await createTestMandate({
      runId: run.id,
      mandateId: 'step11-ctrl-dispatch-1',
      arm: 'control',
      amount: 1000,
      nextActionDay: 1,
    });

    const updated = await processMandate({
      runId: run.id,
      mandate,
      currentDay: 1,
      seed: run.random_seed,
    });

    assert.ok(updated);
    assert.ok(['recovered', 'stood_down'].includes(updated.status));
    assert.equal(updated.attempts_used, 1);
  });

  await t.test('2. processMandate dispatches Baseline correctly', async () => {
    const run = await createTestRun({ seed: 777, maxDays: 5, currentDay: 1 });
    const mandate = await createTestMandate({
      runId: run.id,
      mandateId: 'step11-base-dispatch-1',
      arm: 'baseline',
      amount: 1000,
      nextActionDay: 1,
    });

    const updated = await processMandate({
      runId: run.id,
      mandate,
      currentDay: 1,
      seed: run.random_seed,
    });

    assert.ok(updated);
    assert.ok(['recovered', 'pending', 'stood_down', 'exhausted'].includes(updated.status));
    assert.equal(updated.attempts_used, 1);
  });

  await t.test('3. Smart is rejected/not executed by processMandate', async () => {
    const run = await createTestRun({ seed: 999, maxDays: 5, currentDay: 1 });
    const mandate = await createTestMandate({
      runId: run.id,
      mandateId: 'step11-smart-reject-1',
      arm: 'smart',
      amount: 1000,
      nextActionDay: 1,
    });

    await assert.rejects(
      async () => {
        await processMandate({
          runId: run.id,
          mandate,
          currentDay: 1,
          seed: run.random_seed,
        });
      },
      {
        message: /Smart policy is not yet enabled in Recovery Engine/,
      }
    );

    // Verify mandate was untouched
    const { data: fresh } = await supabase.from('mandates').select('*').eq('id', mandate.id).single();
    assert.equal(fresh.status, 'pending');
    assert.equal(fresh.attempts_used, 0);
  });

  await t.test('4. allowedArms filtering prevents Smart from being processed in processDueMandates', async () => {
    const run = await createTestRun({ seed: 101, maxDays: 5, currentDay: 1 });
    const smartMandate = await createTestMandate({
      runId: run.id,
      mandateId: 'step11-smart-skip-1',
      arm: 'smart',
      amount: 1000,
      nextActionDay: 1,
    });
    const controlMandate = await createTestMandate({
      runId: run.id,
      mandateId: 'step11-ctrl-process-1',
      arm: 'control',
      amount: 1000,
      nextActionDay: 1,
    });

    // Default allowedArms = ['control', 'baseline']
    const res = await processDueMandates({
      runId: run.id,
      currentDay: 1,
      seed: run.random_seed,
    });

    assert.equal(res.processedCount, 1);
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].mandateId, 'step11-ctrl-process-1');
    assert.equal(res.results[0].arm, 'control');

    // Confirm Smart mandate remains untouched in database
    const { data: freshSmart } = await supabase.from('mandates').select('*').eq('id', smartMandate.id).single();
    assert.equal(freshSmart.status, 'pending');
    assert.equal(freshSmart.attempts_used, 0);
  });

  await t.test('5. processDueMandates discovers due mandates for currentDay', async () => {
    const run = await createTestRun({ seed: 202, maxDays: 10, currentDay: 2 });
    // Due (day 1 <= 2)
    const m1 = await createTestMandate({
      runId: run.id,
      mandateId: 'step11-due-1',
      arm: 'control',
      nextActionDay: 1,
    });
    // Due (day 2 <= 2)
    const m2 = await createTestMandate({
      runId: run.id,
      mandateId: 'step11-due-2',
      arm: 'baseline',
      nextActionDay: 2,
    });
    // Future (day 3 > 2) - should not be discovered
    const m3 = await createTestMandate({
      runId: run.id,
      mandateId: 'step11-future-3',
      arm: 'control',
      nextActionDay: 3,
    });

    const res = await processDueMandates({
      runId: run.id,
      currentDay: 2,
      seed: run.random_seed,
    });

    assert.equal(res.processedCount, 2);
    assert.equal(res.results.length, 2);
    const processedIds = res.results.map(r => r.mandateId);
    assert.ok(processedIds.includes('step11-due-1'));
    assert.ok(processedIds.includes('step11-due-2'));
    assert.ok(!processedIds.includes('step11-future-3'));

    const { data: freshFuture } = await supabase.from('mandates').select('*').eq('id', m3.id).single();
    assert.equal(freshFuture.attempts_used, 0);
  });

  await t.test('6. processDueMandates re-validates fresh mandate state & skips ineligible mandates', async () => {
    const run = await createTestRun({ seed: 303, maxDays: 5, currentDay: 1 });
    const mandate = await createTestMandate({
      runId: run.id,
      mandateId: 'step11-stale-check-1',
      arm: 'control',
      nextActionDay: 1,
    });

    // Simulate concurrent modification before engine acts: set to terminal recovered
    await supabase
      .from('mandates')
      .update({ status: 'recovered', next_action: 'none', next_action_day: null })
      .eq('id', mandate.id);

    const res = await processDueMandates({
      runId: run.id,
      currentDay: 1,
      seed: run.random_seed,
    });

    // Stale mandate must be skipped
    assert.equal(res.processedCount, 0);
    assert.equal(res.results.length, 0);
  });

  await t.test('7. processDueMandates returns correct result shape', async () => {
    const run = await createTestRun({ seed: 404, maxDays: 5, currentDay: 1 });
    await createTestMandate({
      runId: run.id,
      mandateId: 'step11-shape-1',
      arm: 'control',
      nextActionDay: 1,
    });

    const res = await processDueMandates({
      runId: run.id,
      currentDay: 1,
      seed: run.random_seed,
    });

    assert.equal(typeof res.day, 'number');
    assert.equal(res.day, 1);
    assert.equal(typeof res.processedCount, 'number');
    assert.equal(res.processedCount, 1);
    assert.ok(Array.isArray(res.results));
    assert.equal(res.results.length, 1);

    const first = res.results[0];
    assert.equal(first.mandateId, 'step11-shape-1');
    assert.equal(first.arm, 'control');
    assert.ok(typeof first.status === 'string');
    assert.ok(['recovered', 'stood_down'].includes(first.status));
  });

  await t.test('8. recoveryRunner simulation behavior is completely preserved with Recovery Engine', async () => {
    const run = await createTestRun({ seed: 505, maxDays: 10, currentDay: 0 });
    // Create Control mandate due day 1
    await createTestMandate({
      runId: run.id,
      mandateId: 'step11-runner-preserv-ctrl',
      arm: 'control',
      nextActionDay: 1,
    });
    // Create Baseline mandate due day 2
    await createTestMandate({
      runId: run.id,
      mandateId: 'step11-runner-preserv-base',
      arm: 'baseline',
      nextActionDay: 2,
    });

    const runResult = await runControlBaselineRecovery({ runId: run.id });

    assert.equal(runResult.runId, run.id);
    assert.ok(runResult.processedCount >= 2);
    assert.ok(runResult.daysEvaluated.includes(0));
    assert.ok(runResult.daysEvaluated.includes(1));
    assert.ok(runResult.daysEvaluated.includes(2));
    assert.ok(
      ['no_future_actions_within_window', 'reached_max_days'].includes(
        runResult.terminatedReason
      )
    );
  });
});
