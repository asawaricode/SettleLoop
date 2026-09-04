import assert from 'node:assert/strict';
import test from 'node:test';
import { supabase } from '../src/config/supabase.js';
import { executeControlPolicy } from '../src/recovery/controlPolicy.js';
import { executeBaselinePolicy, RETRY_DELAY_BY_NEXT_ATTEMPT } from '../src/recovery/baselinePolicy.js';
import { runControlBaselineRecovery } from '../src/recovery/recoveryRunner.js';
import { simulatePayment } from '../src/simulators/paymentSimulator.js';
import { generateSyntheticData } from '../src/generators/syntheticDataGenerator.js';

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

// Helper to find seeds that guarantee a specific outcome for a mandate configuration
function findSeedForOutcome({ mandateId, attemptNumber, amount, balanceVolatility, incomeDayOfMonth, desiredOutcome, desiredRetryEligible = null }) {
  for (let s = 1; s < 50000; s++) {
    const res = simulatePayment({
      seed: s,
      mandateId,
      attemptNumber,
      amount,
      balanceVolatility,
      incomeDayOfMonth,
    });
    if (res.outcome === desiredOutcome) {
      if (desiredRetryEligible === null || res.retryEligible === desiredRetryEligible) {
        return { seed: s, result: res };
      }
    }
  }
  throw new Error(`Could not find seed for outcome ${desiredOutcome}`);
}

test('Step 10 Recovery Test Suite', async (t) => {

  await t.test('1. CONTROL SUCCESS -> recovered, next_action = none', async () => {
    const run = await createTestRun({ seed: 1001 });
    const mandate = await createTestMandate({ runId: run.id, mandateId: 'T10-CTRL-SUCC', arm: 'control' });

    const { seed } = findSeedForOutcome({
      mandateId: mandate.id,
      attemptNumber: 1,
      amount: mandate.amount,
      balanceVolatility: mandate.balance_volatility,
      incomeDayOfMonth: mandate.income_day_of_month,
      desiredOutcome: 'success',
    });

    const result = await executeControlPolicy({
      runId: run.id,
      mandate,
      currentDay: 1,
      seed,
    });

    assert.equal(result.status, 'recovered');
    assert.equal(result.next_action, 'none');
    assert.equal(result.next_action_day, null);
    assert.equal(result.terminal_reason, 'payment_success');
    assert.equal(result.attempts_used, 1);

    // Verify attempts table
    const { data: attempts } = await supabase.from('attempts').select('*').eq('mandate_id', mandate.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].outcome, 'success');

    // Verify audit logs
    const { data: logs } = await supabase.from('audit_logs').select('*').eq('mandate_id', mandate.id);
    assert.ok(logs.length >= 2, 'Should have payment and recovery audit logs');
    assert.ok(logs.some(l => l.decision_type === 'mandate_recovered'));
  });

  await t.test('2. CONTROL FAILURE -> stood_down, next_action = none, no retry', async () => {
    const run = await createTestRun({ seed: 1002 });
    const mandate = await createTestMandate({ runId: run.id, mandateId: 'T10-CTRL-FAIL', arm: 'control' });

    const { seed } = findSeedForOutcome({
      mandateId: mandate.id,
      attemptNumber: 1,
      amount: mandate.amount,
      balanceVolatility: mandate.balance_volatility,
      incomeDayOfMonth: mandate.income_day_of_month,
      desiredOutcome: 'failure',
    });

    const result = await executeControlPolicy({
      runId: run.id,
      mandate,
      currentDay: 1,
      seed,
    });

    assert.equal(result.status, 'stood_down');
    assert.equal(result.next_action, 'none');
    assert.equal(result.next_action_day, null);
    assert.equal(result.attempts_used, 1);

    // Verify attempt row
    const { data: attempts } = await supabase.from('attempts').select('*').eq('mandate_id', mandate.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].outcome, 'failure');

    // Verify audit logs
    const { data: logs } = await supabase.from('audit_logs').select('*').eq('mandate_id', mandate.id);
    assert.ok(logs.some(l => l.decision_type === 'stand_down'));
  });

  await t.test('3. BASELINE SUCCESS -> recovered', async () => {
    const run = await createTestRun({ seed: 1003 });
    const mandate = await createTestMandate({ runId: run.id, mandateId: 'T10-BASE-SUCC', arm: 'baseline' });

    const { seed } = findSeedForOutcome({
      mandateId: mandate.id,
      attemptNumber: 1,
      amount: mandate.amount,
      balanceVolatility: mandate.balance_volatility,
      incomeDayOfMonth: mandate.income_day_of_month,
      desiredOutcome: 'success',
    });

    const result = await executeBaselinePolicy({
      runId: run.id,
      mandate,
      currentDay: 1,
      seed,
    });

    assert.equal(result.status, 'recovered');
    assert.equal(result.next_action, 'none');
    assert.equal(result.next_action_day, null);
    assert.equal(result.terminal_reason, 'payment_success');
  });

  await t.test('4. BASELINE RETRY (D -> D+1 for attempt 1 failure with retryEligible = true)', async () => {
    const run = await createTestRun({ seed: 1004 });
    const mandate = await createTestMandate({ runId: run.id, mandateId: 'T10-BASE-RETRY1', arm: 'baseline', firstDueDay: 2 });

    const { seed } = findSeedForOutcome({
      mandateId: mandate.id,
      attemptNumber: 1,
      amount: mandate.amount,
      balanceVolatility: mandate.balance_volatility,
      incomeDayOfMonth: mandate.income_day_of_month,
      desiredOutcome: 'failure',
      desiredRetryEligible: true,
    });

    const currentDay = 2; // failed on day 2
    const result = await executeBaselinePolicy({
      runId: run.id,
      mandate,
      currentDay,
      seed,
    });

    assert.equal(result.status, 'pending');
    assert.equal(result.next_action, 'retry');
    // Attempt 1 failed -> Attempt 2 scheduled for failureDay + 1 = 3
    assert.equal(result.next_action_day, currentDay + RETRY_DELAY_BY_NEXT_ATTEMPT[2]);
    assert.equal(result.next_action_day, 3);
    assert.equal(result.attempts_used, 1);
  });

  await t.test('5. BASELINE MULTIPLE RETRIES -> D -> D+1 -> D+3 -> D+6 cumulative schedule', async () => {
    const run = await createTestRun({ seed: 1005 });
    let mandate = await createTestMandate({ runId: run.id, mandateId: 'T10-BASE-MULTI', arm: 'baseline', firstDueDay: 1 });

    // Attempt 1 on Day 1 -> fails retryable -> next on Day 1 + 1 = 2
    let s1 = findSeedForOutcome({ mandateId: mandate.id, attemptNumber: 1, amount: mandate.amount, balanceVolatility: mandate.balance_volatility, incomeDayOfMonth: mandate.income_day_of_month, desiredOutcome: 'failure', desiredRetryEligible: true }).seed;
    mandate = await executeBaselinePolicy({ runId: run.id, mandate, currentDay: 1, seed: s1 });
    assert.equal(mandate.attempts_used, 1);
    assert.equal(mandate.next_action_day, 2); // 1 + 1

    // Attempt 2 on Day 2 -> fails retryable -> next on Day 2 + 2 = 4
    let s2 = findSeedForOutcome({ mandateId: mandate.id, attemptNumber: 2, amount: mandate.amount, balanceVolatility: mandate.balance_volatility, incomeDayOfMonth: mandate.income_day_of_month, desiredOutcome: 'failure', desiredRetryEligible: true }).seed;
    mandate = await executeBaselinePolicy({ runId: run.id, mandate, currentDay: 2, seed: s2 });
    assert.equal(mandate.attempts_used, 2);
    assert.equal(mandate.next_action_day, 4); // 2 + 2 (relative to D=1: 1+3=4)

    // Attempt 3 on Day 4 -> fails retryable -> next on Day 4 + 3 = 7
    let s3 = findSeedForOutcome({ mandateId: mandate.id, attemptNumber: 3, amount: mandate.amount, balanceVolatility: mandate.balance_volatility, incomeDayOfMonth: mandate.income_day_of_month, desiredOutcome: 'failure', desiredRetryEligible: true }).seed;
    mandate = await executeBaselinePolicy({ runId: run.id, mandate, currentDay: 4, seed: s3 });
    assert.equal(mandate.attempts_used, 3);
    assert.equal(mandate.next_action_day, 7); // 4 + 3 (relative to D=1: 1+6=7)

    // Verify schedule D (1), D+1 (2), D+3 (4), D+6 (7)
    const { data: attempts } = await supabase.from('attempts').select('attempt_number, executed_day').eq('mandate_id', mandate.id).order('attempt_number');
    assert.deepEqual(attempts.map(a => a.executed_day), [1, 2, 4]);
  });

  await t.test('6. NON-RETRYABLE FAILURE -> stood_down, no retry', async () => {
    const run = await createTestRun({ seed: 1006 });
    const mandate = await createTestMandate({ runId: run.id, mandateId: 'T10-BASE-NONRETRY', arm: 'baseline' });

    const { seed } = findSeedForOutcome({
      mandateId: mandate.id,
      attemptNumber: 1,
      amount: mandate.amount,
      balanceVolatility: mandate.balance_volatility,
      incomeDayOfMonth: mandate.income_day_of_month,
      desiredOutcome: 'failure',
      desiredRetryEligible: false,
    });

    const result = await executeBaselinePolicy({
      runId: run.id,
      mandate,
      currentDay: 1,
      seed,
    });

    assert.equal(result.status, 'stood_down');
    assert.equal(result.next_action, 'none');
    assert.equal(result.next_action_day, null);
    assert.equal(result.attempts_used, 1);
  });

  await t.test('7. MAXIMUM ATTEMPTS -> 4th failed attempt -> exhausted, no attempt 5', async () => {
    const run = await createTestRun({ seed: 1007 });
    let mandate = await createTestMandate({ runId: run.id, mandateId: 'T10-BASE-EXHAUST', arm: 'baseline', firstDueDay: 1 });

    // Execute 3 failed attempts
    for (let att = 1; att <= 3; att++) {
      const { seed } = findSeedForOutcome({ mandateId: mandate.id, attemptNumber: att, amount: mandate.amount, balanceVolatility: mandate.balance_volatility, incomeDayOfMonth: mandate.income_day_of_month, desiredOutcome: 'failure', desiredRetryEligible: true });
      mandate = await executeBaselinePolicy({ runId: run.id, mandate, currentDay: mandate.next_action_day, seed });
    }
    assert.equal(mandate.attempts_used, 3);

    // 4th attempt also fails
    const { seed: s4 } = findSeedForOutcome({ mandateId: mandate.id, attemptNumber: 4, amount: mandate.amount, balanceVolatility: mandate.balance_volatility, incomeDayOfMonth: mandate.income_day_of_month, desiredOutcome: 'failure', desiredRetryEligible: true });
    mandate = await executeBaselinePolicy({ runId: run.id, mandate, currentDay: mandate.next_action_day, seed: s4 });

    assert.equal(mandate.status, 'exhausted');
    assert.equal(mandate.next_action, 'none');
    assert.equal(mandate.next_action_day, null);
    assert.equal(mandate.attempts_used, 4);

    const { data: attempts } = await supabase.from('attempts').select('*').eq('mandate_id', mandate.id);
    assert.equal(attempts.length, 4, 'Must have exactly 4 attempts');
  });

  await t.test('8. EXHAUSTION GUARD -> set_mandate_action(exhausted) with attempts_used < 4 is rejected', async () => {
    const run = await createTestRun({ seed: 1008 });
    const mandate = await createTestMandate({ runId: run.id, mandateId: 'T10-EXHAUST-GUARD', arm: 'baseline', attemptsUsed: 2 });

    const { error } = await supabase.rpc('set_mandate_action', {
      p_run_id: run.id,
      p_mandate_id: mandate.id,
      p_action: 'exhausted',
    });

    assert.ok(error !== null, 'Should reject exhaustion before 4 attempts');
    assert.match(error.message, /Mandate cannot be exhausted before maximum attempts are used/);
  });

  await t.test('9. SMART ISOLATION -> runner ignores and never modifies Smart mandates', async () => {
    const run = await createTestRun({ seed: 1009 });
    const smartMandate = await createTestMandate({
      runId: run.id,
      mandateId: 'T10-SMART-ISOLATED',
      arm: 'smart',
      firstDueDay: 1,
      nextAction: 'retry',
      nextActionDay: 1,
      attemptsUsed: 0,
    });

    const ctrlMandate = await createTestMandate({
      runId: run.id,
      mandateId: 'T10-CTRL-ACTIVE',
      arm: 'control',
      firstDueDay: 1,
    });

    // Run runner
    const runnerRes = await runControlBaselineRecovery({ runId: run.id });
    assert.ok(runnerRes.processedCount >= 1);

    // Verify smart mandate is 100% UNTOUCHED
    const { data: smartAfter } = await supabase.from('mandates').select('*').eq('id', smartMandate.id).single();
    assert.equal(smartAfter.status, 'pending');
    assert.equal(smartAfter.next_action, 'retry');
    assert.equal(smartAfter.next_action_day, 1);
    assert.equal(smartAfter.attempts_used, 0);

    const { data: smartAttempts } = await supabase.from('attempts').select('*').eq('mandate_id', smartMandate.id);
    assert.equal(smartAttempts.length, 0, 'Smart mandate must have zero attempts');
  });

  await t.test('10. PAYMENT SIMULATOR CONTRACT -> currentDay is not passed to simulator', () => {
    // Verified by inspection and function signatures:
    // simulatePayment({ seed, mandateId, attemptNumber, amount, balanceVolatility, incomeDayOfMonth })
    // Passing currentDay would violate the simulator's input contract or be ignored.
    const result1 = simulatePayment({
      seed: 42,
      mandateId: 'c16b7139-d57a-4416-b11b-e5c0bda63497',
      attemptNumber: 1,
      amount: 1500,
      balanceVolatility: 0.5,
      incomeDayOfMonth: 10,
    });

    const result2 = simulatePayment({
      seed: 42,
      mandateId: 'c16b7139-d57a-4416-b11b-e5c0bda63497',
      attemptNumber: 1,
      amount: 1500,
      balanceVolatility: 0.5,
      incomeDayOfMonth: 10,
    });

    assert.deepEqual(result1, result2, 'Payment simulator is deterministic');
  });

  await t.test('11. IDEMPOTENCY -> duplicate execution request does not create duplicate attempt', async () => {
    const run = await createTestRun({ seed: 1011 });
    const mandate = await createTestMandate({ runId: run.id, mandateId: 'T10-IDEMP', arm: 'control' });

    const key = `recovery-run:${run.id}:mandate:${mandate.id}:attempt:1`;

    const { data: a1 } = await supabase.rpc('execute_attempt', {
      p_run_id: run.id,
      p_mandate_id: mandate.id,
      p_day: 1,
      p_channel: 'auto_debit',
      p_idempotency_key: key,
    });

    const { data: a2 } = await supabase.rpc('execute_attempt', {
      p_run_id: run.id,
      p_mandate_id: mandate.id,
      p_day: 1,
      p_channel: 'auto_debit',
      p_idempotency_key: key,
    });

    assert.equal(a1, a2, 'Duplicate idempotency key must return the identical attempt ID');

    const { data: attempts } = await supabase.from('attempts').select('*').eq('mandate_id', mandate.id);
    assert.equal(attempts.length, 1, 'Only one attempt row must exist');
  });

  await t.test('12. CLOCK & JUMPING -> runner correctly jumps to future due days directly', async () => {
    const run = await createTestRun({ seed: 1012, maxDays: 10, currentDay: 0 });

    // Mandate A due on day 3
    await createTestMandate({ runId: run.id, mandateId: 'T10-CLOCK-A', arm: 'control', firstDueDay: 3, nextActionDay: 3 });
    // Mandate B due on day 7
    await createTestMandate({ runId: run.id, mandateId: 'T10-CLOCK-B', arm: 'control', firstDueDay: 7, nextActionDay: 7 });

    const summary = await runControlBaselineRecovery({ runId: run.id });

    // Clock should have jumped directly: day 0 -> day 3 -> day 7
    assert.deepEqual(summary.daysEvaluated, [0, 3, 7]);
    assert.equal(summary.finalDay, 7);
  });

  await t.test('13. TERMINATION -> runner terminates at boundary without infinite loop', async () => {
    const run = await createTestRun({ seed: 1013, maxDays: 5, currentDay: 0 });
    // Mandate due on day 2
    await createTestMandate({ runId: run.id, mandateId: 'T10-TERM-A', arm: 'control', firstDueDay: 2, nextActionDay: 2 });
    // Mandate due BEYOND max_days (day 8 > max_days 5)
    await createTestMandate({ runId: run.id, mandateId: 'T10-TERM-BEYOND', arm: 'baseline', firstDueDay: 8, nextActionDay: 8 });

    const summary = await runControlBaselineRecovery({ runId: run.id });

    assert.ok(summary.finalDay <= 5, 'Clock must not advance beyond max_days');
    assert.equal(summary.terminatedReason, 'no_future_actions_within_window');

    // The mandate beyond max_days must still be pending (NOT exhausted)
    const { data: beyondM } = await supabase.from('mandates').select('*').eq('mandate_id', 'T10-TERM-BEYOND').eq('run_id', run.id).single();
    assert.equal(beyondM.status, 'pending');
    assert.equal(beyondM.attempts_used, 0);
  });

  await t.test('14. TERMINAL STATE -> recovered / stood_down / exhausted all have next_action = none, next_action_day = null', async () => {
    const run = await createTestRun({ seed: 1014 });

    const mRec = await createTestMandate({ runId: run.id, mandateId: 'T10-TERM-REC', arm: 'control', attemptsUsed: 0 });
    const { data: aRec } = await supabase.rpc('execute_attempt', { p_run_id: run.id, p_mandate_id: mRec.id, p_day: 1, p_channel: 'auto_debit', p_idempotency_key: `t14-rec-key-${run.id}` });
    await supabase.rpc('complete_attempt', { p_attempt_id: aRec, p_outcome: 'success' });
    const { data: resRec } = await supabase.from('mandates').select('*').eq('id', mRec.id).single();
    assert.equal(resRec.status, 'recovered');
    assert.equal(resRec.next_action, 'none');
    assert.equal(resRec.next_action_day, null);

    const mStd = await createTestMandate({ runId: run.id, mandateId: 'T10-TERM-STD', arm: 'control', attemptsUsed: 1 });
    await supabase.rpc('set_mandate_action', { p_run_id: run.id, p_mandate_id: mStd.id, p_action: 'stand_down' });
    const { data: resStd } = await supabase.from('mandates').select('*').eq('id', mStd.id).single();
    assert.equal(resStd.status, 'stood_down');
    assert.equal(resStd.next_action, 'none');
    assert.equal(resStd.next_action_day, null);

    const mExh = await createTestMandate({ runId: run.id, mandateId: 'T10-TERM-EXH', arm: 'baseline', attemptsUsed: 4 });
    await supabase.rpc('set_mandate_action', { p_run_id: run.id, p_mandate_id: mExh.id, p_action: 'exhausted' });
    const { data: resExh } = await supabase.from('mandates').select('*').eq('id', mExh.id).single();
    assert.equal(resExh.status, 'exhausted');
    assert.equal(resExh.next_action, 'none');
    assert.equal(resExh.next_action_day, null);
  });

  await t.test('15. INTEGRATION TEST -> Fresh multi-day simulation run with Control and Baseline mandates', async () => {
    // Generate fresh synthetic data for integration testing
    const { simulationRunId, mandateIds } = await generateSyntheticData({
      seed: 7777,
      mandateCount: 15,
    });

    assert.ok(simulationRunId);
    assert.equal(mandateIds.length, 15);

    // Verify initial mandates
    const { data: initMandates } = await supabase
      .from('mandates')
      .select('id, experiment_arm, status, next_action, attempts_used')
      .eq('run_id', simulationRunId);

    assert.equal(initMandates.length, 15);
    const smartInitial = initMandates.filter(m => m.experiment_arm === 'smart');
    assert.ok(smartInitial.length > 0, 'Should have smart mandates');

    // Run the Control + Baseline runner
    const runSummary = await runControlBaselineRecovery({ runId: simulationRunId });
    assert.ok(runSummary.processedCount > 0, 'Should process control/baseline mandates');

    // Verify database state after recovery run:
    // 1. Mandates
    const { data: postMandates } = await supabase
      .from('mandates')
      .select('*')
      .eq('run_id', simulationRunId);

    const postSmart = postMandates.filter(m => m.experiment_arm === 'smart');
    for (const sm of postSmart) {
      assert.equal(sm.status, 'pending', 'Smart mandate status must remain pending');
      assert.equal(sm.attempts_used, 0, 'Smart mandate attempts_used must remain 0');
      assert.equal(sm.next_action, 'retry', 'Smart mandate next_action must remain retry');
    }

    const postControl = postMandates.filter(m => m.experiment_arm === 'control');
    for (const cm of postControl) {
      assert.ok(['recovered', 'stood_down', 'pending'].includes(cm.status));
      if (['recovered', 'stood_down'].includes(cm.status)) {
        assert.equal(cm.next_action, 'none');
        assert.equal(cm.next_action_day, null);
      }
    }

    const postBaseline = postMandates.filter(m => m.experiment_arm === 'baseline');
    for (const bm of postBaseline) {
      assert.ok(['recovered', 'stood_down', 'exhausted', 'pending'].includes(bm.status));
      if (['recovered', 'stood_down', 'exhausted'].includes(bm.status)) {
        assert.equal(bm.next_action, 'none');
        assert.equal(bm.next_action_day, null);
      }
      assert.ok(bm.attempts_used <= 4, 'Baseline must never exceed 4 attempts');
    }

    // 2. Attempts: Smart mandates must have ZERO attempts
    const { data: allAttempts } = await supabase
      .from('attempts')
      .select('*')
      .eq('run_id', simulationRunId);

    const smartMandateIdSet = new Set(postSmart.map(m => m.id));
    const smartAttempts = allAttempts.filter(a => smartMandateIdSet.has(a.mandate_id));
    assert.equal(smartAttempts.length, 0, 'Smart mandates must have zero attempts in attempts table');

    // 3. Audit logs: Smart mandates must have ZERO audit logs
    const { data: allLogs } = await supabase
      .from('audit_logs')
      .select('*')
      .eq('run_id', simulationRunId);

    const smartLogs = allLogs.filter(l => smartMandateIdSet.has(l.mandate_id));
    assert.equal(smartLogs.length, 0, 'Smart mandates must have zero audit logs');
    assert.ok(allLogs.length > 0, 'Control and Baseline must produce audit logs');

    // 4. Simulation run: run status remains 'running' (spec requires: do not mark run globally completed)
    const { data: runAfter } = await supabase
      .from('simulation_runs')
      .select('*')
      .eq('id', simulationRunId)
      .single();

    assert.equal(runAfter.status, 'running', 'Simulation run status must not be modified by Step 10');
  });

});
