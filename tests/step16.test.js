// tests/step16.test.js
//
// Unit & Integration tests for Step 16: Metrics & Evaluation Layer.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../src/config/supabase.js';
import { getSimulationMetrics, round4 } from '../src/evaluation/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

const createdRunIds = [];

async function createTestRun({ seed = 12345, currentDay = 10, maxDays = 30 } = {}) {
  const { data: run, error } = await supabase
    .from('simulation_runs')
    .insert({
      random_seed: seed,
      current_day: currentDay,
      max_days: maxDays,
      status: 'completed',
    })
    .select()
    .single();

  if (error) throw new Error(`createTestRun failed: ${error.message}`);
  createdRunIds.push(run.id);
  return run;
}

async function insertMandates(mandates) {
  const normalized = mandates.map((m) => ({
    income_day_of_month: 15,
    balance_volatility: 0.5,
    created_day: 0,
    ...m,
  }));
  const { data, error } = await supabase.from('mandates').insert(normalized).select();
  if (error) throw new Error(`insertMandates failed: ${error.message}`);
  return data;
}

let attemptCounter = 0;
async function insertAttempts(attempts) {
  const normalized = attempts.map((a) => {
    attemptCounter++;
    return {
      scheduled_day: a.executed_day ?? 0,
      idempotency_key:
        a.idempotency_key ??
        `idemp-${Date.now()}-${attemptCounter}-${Math.random().toString(36).substring(2, 8)}`,
      ...a,
    };
  });
  const { data, error } = await supabase.from('attempts').insert(normalized).select();
  if (error) throw new Error(`insertAttempts failed: ${error.message}`);
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 16 — Metrics & Evaluation Layer', () => {
  after(async () => {
    // Clean up all simulation runs created during tests (cascade deletes mandates/attempts)
    for (const runId of createdRunIds) {
      await supabase.from('simulation_runs').delete().eq('id', runId);
    }
  });

  // 1. Empty run produces zero metrics.
  it('1. Empty run produces zero metrics', async () => {
    const run = await createTestRun();
    const metrics = await getSimulationMetrics({ runId: run.id });

    assert.equal(metrics.runId, run.id);
    for (const arm of ['control', 'baseline', 'smart']) {
      assert.equal(metrics.arms[arm].mandateCount, 0);
      assert.equal(metrics.arms[arm].recoveredCount, 0);
      assert.equal(metrics.arms[arm].recoveryRate, 0);
      assert.equal(metrics.arms[arm].totalAmount, 0);
      assert.equal(metrics.arms[arm].recoveredAmount, 0);
      assert.equal(metrics.arms[arm].attemptsTotal, 0);
      assert.equal(metrics.arms[arm].attemptsPerMandate, 0);
      assert.equal(metrics.arms[arm].attemptsPerRecovery, 0);
      assert.equal(metrics.arms[arm].averageTimeToRecovery, 0);
    }

    assert.equal(metrics.lift.vsControl.absolute, 0);
    assert.equal(metrics.lift.vsControl.relative, null);
    assert.equal(metrics.safety.totalViolations, 0);
    assert.equal(metrics.safety.safe, true);
  });

  // 2. Mandate counts are correct by arm.
  it('2. Mandate counts are correct by arm', async () => {
    const run = await createTestRun();
    await insertMandates([
      { run_id: run.id, mandate_id: 'M1', experiment_arm: 'control', amount: 1000, status: 'pending', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'M2', experiment_arm: 'control', amount: 2000, status: 'recovered', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'M3', experiment_arm: 'baseline', amount: 1500, status: 'pending', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'M4', experiment_arm: 'smart', amount: 3000, status: 'recovered', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'M5', experiment_arm: 'smart', amount: 4000, status: 'recovered', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'M6', experiment_arm: 'smart', amount: 5000, status: 'stood_down', first_due_day: 0 },
    ]);

    const metrics = await getSimulationMetrics({ runId: run.id });
    assert.equal(metrics.arms.control.mandateCount, 2);
    assert.equal(metrics.arms.baseline.mandateCount, 1);
    assert.equal(metrics.arms.smart.mandateCount, 3);
  });

  // 3. Recovered counts are correct.
  it('3. Recovered counts are correct', async () => {
    const run = await createTestRun();
    await insertMandates([
      { run_id: run.id, mandate_id: 'MC1', experiment_arm: 'control', amount: 1000, status: 'recovered', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MC2', experiment_arm: 'control', amount: 1000, status: 'stood_down', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MS1', experiment_arm: 'smart', amount: 2000, status: 'recovered', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MS2', experiment_arm: 'smart', amount: 2000, status: 'recovered', first_due_day: 0 },
    ]);

    const metrics = await getSimulationMetrics({ runId: run.id });
    assert.equal(metrics.arms.control.recoveredCount, 1);
    assert.equal(metrics.arms.baseline.recoveredCount, 0);
    assert.equal(metrics.arms.smart.recoveredCount, 2);
  });

  // 4. Recovery rate is correct.
  it('4. Recovery rate is correct', async () => {
    const run = await createTestRun();
    await insertMandates([
      { run_id: run.id, mandate_id: 'MR1', experiment_arm: 'control', amount: 1000, status: 'recovered', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MR2', experiment_arm: 'control', amount: 1000, status: 'stood_down', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MR3', experiment_arm: 'control', amount: 1000, status: 'stood_down', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MR4', experiment_arm: 'control', amount: 1000, status: 'stood_down', first_due_day: 0 },
    ]); // 1 recovered out of 4 = 0.2500

    const metrics = await getSimulationMetrics({ runId: run.id });
    assert.equal(metrics.arms.control.recoveryRate, 0.25);
  });

  // 5. Total amount is correct.
  it('5. Total amount is correct', async () => {
    const run = await createTestRun();
    await insertMandates([
      { run_id: run.id, mandate_id: 'MA1', experiment_arm: 'control', amount: 1200.5, status: 'pending', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MA2', experiment_arm: 'control', amount: 800.25, status: 'recovered', first_due_day: 0 },
    ]);

    const metrics = await getSimulationMetrics({ runId: run.id });
    assert.equal(metrics.arms.control.totalAmount, 2000.75);
  });

  // 6. Recovered amount is correct.
  it('6. Recovered amount is correct', async () => {
    const run = await createTestRun();
    await insertMandates([
      { run_id: run.id, mandate_id: 'MRA1', experiment_arm: 'control', amount: 1200, status: 'stood_down', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MRA2', experiment_arm: 'control', amount: 850.5, status: 'recovered', first_due_day: 0 },
    ]);

    const metrics = await getSimulationMetrics({ runId: run.id });
    assert.equal(metrics.arms.control.recoveredAmount, 850.5);
  });

  // 7. Attempt totals are correct (excluding pending attempts).
  it('7. Attempt totals are correct', async () => {
    const run = await createTestRun();
    const [m1] = await insertMandates([
      { run_id: run.id, mandate_id: 'MAT1', experiment_arm: 'baseline', amount: 1000, status: 'pending', first_due_day: 0 },
    ]);

    await insertAttempts([
      { run_id: run.id, mandate_id: m1.id, attempt_number: 1, scheduled_day: 0, executed_day: 0, channel: 'auto_debit', outcome: 'failure' },
      { run_id: run.id, mandate_id: m1.id, attempt_number: 2, scheduled_day: 1, executed_day: 1, channel: 'auto_debit', outcome: 'failure' },
      { run_id: run.id, mandate_id: m1.id, attempt_number: 3, scheduled_day: 3, executed_day: null, channel: 'auto_debit', outcome: 'pending' }, // pending!
    ]);

    const metrics = await getSimulationMetrics({ runId: run.id });
    // 2 executed attempts, 1 pending excluded
    assert.equal(metrics.arms.baseline.attemptsTotal, 2);
  });

  // 8. Attempts per mandate is correct.
  it('8. Attempts per mandate is correct', async () => {
    const run = await createTestRun();
    const [m1, m2] = await insertMandates([
      { run_id: run.id, mandate_id: 'MAPM1', experiment_arm: 'baseline', amount: 1000, status: 'pending', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MAPM2', experiment_arm: 'baseline', amount: 1000, status: 'pending', first_due_day: 0 },
    ]);

    await insertAttempts([
      { run_id: run.id, mandate_id: m1.id, attempt_number: 1, executed_day: 0, channel: 'auto_debit', outcome: 'failure' },
      { run_id: run.id, mandate_id: m1.id, attempt_number: 2, executed_day: 1, channel: 'auto_debit', outcome: 'failure' },
      { run_id: run.id, mandate_id: m2.id, attempt_number: 1, executed_day: 0, channel: 'auto_debit', outcome: 'failure' },
    ]); // 3 total attempts / 2 mandates = 1.5

    const metrics = await getSimulationMetrics({ runId: run.id });
    assert.equal(metrics.arms.baseline.attemptsPerMandate, 1.5);
  });

  // 9. Attempts per recovery is correct.
  it('9. Attempts per recovery is correct', async () => {
    const run = await createTestRun();
    const [m1, m2] = await insertMandates([
      { run_id: run.id, mandate_id: 'MAPR1', experiment_arm: 'smart', amount: 1000, status: 'recovered', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MAPR2', experiment_arm: 'smart', amount: 1000, status: 'stood_down', first_due_day: 0 },
    ]);

    await insertAttempts([
      { run_id: run.id, mandate_id: m1.id, attempt_number: 1, executed_day: 0, channel: 'auto_debit', outcome: 'failure' },
      { run_id: run.id, mandate_id: m1.id, attempt_number: 2, executed_day: 2, channel: 'auto_debit', outcome: 'success' },
      { run_id: run.id, mandate_id: m2.id, attempt_number: 1, executed_day: 0, channel: 'auto_debit', outcome: 'failure' },
      { run_id: run.id, mandate_id: m2.id, attempt_number: 2, executed_day: 2, channel: 'auto_debit', outcome: 'failure' },
    ]); // 4 total executed attempts / 1 recovered = 4.0

    const metrics = await getSimulationMetrics({ runId: run.id });
    assert.equal(metrics.arms.smart.attemptsPerRecovery, 4);
  });

  // 10. Time to recovery uses successful attempt executed_day.
  it('10. Time to recovery uses successful attempt executed_day', async () => {
    const run = await createTestRun();
    const [m1] = await insertMandates([
      { run_id: run.id, mandate_id: 'MTR1', experiment_arm: 'smart', amount: 1000, status: 'recovered', first_due_day: 2 },
    ]);

    await insertAttempts([
      { run_id: run.id, mandate_id: m1.id, attempt_number: 1, scheduled_day: 2, executed_day: 2, channel: 'auto_debit', outcome: 'failure' },
      { run_id: run.id, mandate_id: m1.id, attempt_number: 2, scheduled_day: 5, executed_day: 6, channel: 'auto_debit', outcome: 'success' },
    ]); // executed_day = 6, first_due_day = 2 -> timeToRecovery = 6 - 2 = 4

    const metrics = await getSimulationMetrics({ runId: run.id });
    assert.equal(metrics.arms.smart.averageTimeToRecovery, 4);
  });

  // 11. Average time to recovery is correct.
  it('11. Average time to recovery is correct', async () => {
    const run = await createTestRun();
    const [m1, m2] = await insertMandates([
      { run_id: run.id, mandate_id: 'MATR1', experiment_arm: 'control', amount: 1000, status: 'recovered', first_due_day: 1 },
      { run_id: run.id, mandate_id: 'MATR2', experiment_arm: 'control', amount: 1000, status: 'recovered', first_due_day: 0 },
    ]);

    await insertAttempts([
      { run_id: run.id, mandate_id: m1.id, attempt_number: 1, executed_day: 3, channel: 'auto_debit', outcome: 'success' }, // 3 - 1 = 2
      { run_id: run.id, mandate_id: m2.id, attempt_number: 1, executed_day: 6, channel: 'auto_debit', outcome: 'success' }, // 6 - 0 = 6
    ]); // (2 + 6) / 2 = 4.0000

    const metrics = await getSimulationMetrics({ runId: run.id });
    assert.equal(metrics.arms.control.averageTimeToRecovery, 4);
  });

  // 12. Smart recovery lift vs Control is correct.
  it('12. Smart recovery lift vs Control is correct', async () => {
    const run = await createTestRun();
    await insertMandates([
      // Control: 1/2 = 0.5000
      { run_id: run.id, mandate_id: 'MLC1', experiment_arm: 'control', amount: 1000, status: 'recovered', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MLC2', experiment_arm: 'control', amount: 1000, status: 'stood_down', first_due_day: 0 },
      // Smart: 3/4 = 0.7500
      { run_id: run.id, mandate_id: 'MLS1', experiment_arm: 'smart', amount: 1000, status: 'recovered', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MLS2', experiment_arm: 'smart', amount: 1000, status: 'recovered', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MLS3', experiment_arm: 'smart', amount: 1000, status: 'recovered', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MLS4', experiment_arm: 'smart', amount: 1000, status: 'stood_down', first_due_day: 0 },
    ]);

    const metrics = await getSimulationMetrics({ runId: run.id });
    // absolute = 0.75 - 0.50 = 0.2500
    // relative = (0.75 - 0.50) / 0.50 = 0.5000
    assert.equal(metrics.lift.vsControl.absolute, 0.25);
    assert.equal(metrics.lift.vsControl.relative, 0.5);
  });

  // 13. Smart recovery lift vs Baseline is correct.
  it('13. Smart recovery lift vs Baseline is correct', async () => {
    const run = await createTestRun();
    await insertMandates([
      // Baseline: 2/5 = 0.4000
      { run_id: run.id, mandate_id: 'MLB1', experiment_arm: 'baseline', amount: 1000, status: 'recovered', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MLB2', experiment_arm: 'baseline', amount: 1000, status: 'recovered', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MLB3', experiment_arm: 'baseline', amount: 1000, status: 'stood_down', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MLB4', experiment_arm: 'baseline', amount: 1000, status: 'stood_down', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MLB5', experiment_arm: 'baseline', amount: 1000, status: 'stood_down', first_due_day: 0 },
      // Smart: 3/5 = 0.6000
      { run_id: run.id, mandate_id: 'MLS10', experiment_arm: 'smart', amount: 1000, status: 'recovered', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MLS11', experiment_arm: 'smart', amount: 1000, status: 'recovered', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MLS12', experiment_arm: 'smart', amount: 1000, status: 'recovered', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MLS13', experiment_arm: 'smart', amount: 1000, status: 'stood_down', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MLS14', experiment_arm: 'smart', amount: 1000, status: 'stood_down', first_due_day: 0 },
    ]);

    const metrics = await getSimulationMetrics({ runId: run.id });
    // absolute = 0.60 - 0.40 = 0.2000
    // relative = (0.60 - 0.40) / 0.40 = 0.5000
    assert.equal(metrics.lift.vsBaseline.absolute, 0.2);
    assert.equal(metrics.lift.vsBaseline.relative, 0.5);
  });

  // 14. Relative lift handles zero denominator safely.
  it('14. Relative lift handles zero denominator safely', async () => {
    const run = await createTestRun();
    await insertMandates([
      // Control: 0 recovered
      { run_id: run.id, mandate_id: 'MLZ1', experiment_arm: 'control', amount: 1000, status: 'stood_down', first_due_day: 0 },
      // Smart: 1 recovered out of 1 = 1.0000
      { run_id: run.id, mandate_id: 'MLZ2', experiment_arm: 'smart', amount: 1000, status: 'recovered', first_due_day: 0 },
    ]);

    const metrics = await getSimulationMetrics({ runId: run.id });
    assert.equal(metrics.lift.vsControl.absolute, 1.0);
    assert.equal(metrics.lift.vsControl.relative, null, 'Relative lift should be null when comparison rate is 0');
  });

  // 15. A retry after a previous hard decline is detected as a violation.
  it('15. A retry after a previous hard decline is detected as a violation', async () => {
    const run = await createTestRun();
    const [m1] = await insertMandates([
      { run_id: run.id, mandate_id: 'MSAFE1', experiment_arm: 'smart', amount: 1000, status: 'pending', first_due_day: 0 },
    ]);

    await insertAttempts([
      // Attempt 1: hard decline
      { run_id: run.id, mandate_id: m1.id, attempt_number: 1, executed_day: 0, channel: 'auto_debit', outcome: 'failure', decline_category: 'hard', retry_eligible: false },
      // Attempt 2: retry executed after hard decline -> VIOLATION!
      { run_id: run.id, mandate_id: m1.id, attempt_number: 2, executed_day: 2, channel: 'auto_debit', outcome: 'failure', decline_category: 'soft', retry_eligible: true },
    ]);

    const metrics = await getSimulationMetrics({ runId: run.id });
    assert.equal(metrics.safety.hardDeclineRetryViolations, 1);
  });

  // 16. A retry after a previous unknown decline is detected as a violation.
  it('16. A retry after a previous unknown decline is detected as a violation', async () => {
    const run = await createTestRun();
    const [m1] = await insertMandates([
      { run_id: run.id, mandate_id: 'MSAFE2', experiment_arm: 'smart', amount: 1000, status: 'pending', first_due_day: 0 },
    ]);

    await insertAttempts([
      // Attempt 1: unknown decline
      { run_id: run.id, mandate_id: m1.id, attempt_number: 1, executed_day: 0, channel: 'auto_debit', outcome: 'failure', decline_category: 'unknown', retry_eligible: false },
      // Attempt 2: retry executed after unknown decline -> VIOLATION!
      { run_id: run.id, mandate_id: m1.id, attempt_number: 2, executed_day: 2, channel: 'auto_debit', outcome: 'failure', decline_category: 'soft', retry_eligible: true },
    ]);

    const metrics = await getSimulationMetrics({ runId: run.id });
    assert.equal(metrics.safety.hardDeclineRetryViolations, 1);
  });

  // 17. A retry after retry_eligible=false is detected as a violation.
  it('17. A retry after retry_eligible=false is detected as a violation', async () => {
    const run = await createTestRun();
    const [m1] = await insertMandates([
      { run_id: run.id, mandate_id: 'MSAFE3', experiment_arm: 'smart', amount: 1000, status: 'pending', first_due_day: 0 },
    ]);

    await insertAttempts([
      // Attempt 1: retry_eligible = false (even if category was not explicitly hard)
      { run_id: run.id, mandate_id: m1.id, attempt_number: 1, executed_day: 0, channel: 'auto_debit', outcome: 'failure', decline_category: 'soft', retry_eligible: false },
      // Attempt 2: retry executed -> VIOLATION!
      { run_id: run.id, mandate_id: m1.id, attempt_number: 2, executed_day: 2, channel: 'auto_debit', outcome: 'failure', decline_category: 'soft', retry_eligible: true },
    ]);

    const metrics = await getSimulationMetrics({ runId: run.id });
    assert.equal(metrics.safety.hardDeclineRetryViolations, 1);
  });

  // 18. A current attempt receiving a hard decline is NOT itself incorrectly counted as a retry violation.
  it('18. A current attempt receiving a hard decline is NOT itself incorrectly counted as a retry violation', async () => {
    const run = await createTestRun();
    const [m1] = await insertMandates([
      { run_id: run.id, mandate_id: 'MSAFE4', experiment_arm: 'control', amount: 1000, status: 'stood_down', first_due_day: 0 },
    ]);

    await insertAttempts([
      // Attempt 1: receives hard decline, and NO attempt 2 was ever made
      { run_id: run.id, mandate_id: m1.id, attempt_number: 1, executed_day: 0, channel: 'auto_debit', outcome: 'failure', decline_category: 'hard', retry_eligible: false },
    ]);

    const metrics = await getSimulationMetrics({ runId: run.id });
    assert.equal(metrics.safety.hardDeclineRetryViolations, 0, 'Attempt 1 itself receiving hard decline is not a retry violation');
  });

  // 19. Duplicate attempt violation logic is correct.
  it('19. Duplicate attempt violation logic is correct', async () => {
    const run = await createTestRun();
    const [m1, m2] = await insertMandates([
      { run_id: run.id, mandate_id: 'MDUP1', experiment_arm: 'control', amount: 1000, status: 'pending', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MDUP2', experiment_arm: 'control', amount: 1000, status: 'pending', first_due_day: 0 },
    ]);

    // Normal valid attempts produce 0 duplicate violations
    await insertAttempts([
      { run_id: run.id, mandate_id: m1.id, attempt_number: 1, executed_day: 0, channel: 'auto_debit', outcome: 'failure' },
      { run_id: run.id, mandate_id: m2.id, attempt_number: 1, executed_day: 0, channel: 'auto_debit', outcome: 'failure' },
    ]);

    const metrics = await getSimulationMetrics({ runId: run.id });
    assert.equal(metrics.safety.duplicateAttemptViolations, 0, 'Normal persisted data should produce 0 duplicate violations');

    // Verify DB unique constraint prevents duplicate idempotency keys as expected
    const dupKey = `unique-test-key-${Date.now()}`;
    await insertAttempts([
      { run_id: run.id, mandate_id: m1.id, attempt_number: 2, executed_day: 1, channel: 'auto_debit', outcome: 'failure', idempotency_key: dupKey },
    ]);
    await assert.rejects(
      () =>
        insertAttempts([
          { run_id: run.id, mandate_id: m2.id, attempt_number: 2, executed_day: 1, channel: 'auto_debit', outcome: 'failure', idempotency_key: dupKey },
        ]),
      /violates unique constraint "attempts_idempotency_key_key"/
    );
  });

  // 20. Payment-link consent violations are detected.
  it('20. Payment-link consent violations are detected', async () => {
    const run = await createTestRun();
    const [m1] = await insertMandates([
      // contact_consent = false!
      { run_id: run.id, mandate_id: 'MNOCONSENT1', experiment_arm: 'smart', amount: 1000, status: 'pending', first_due_day: 0, contact_consent: false },
    ]);

    await insertAttempts([
      // Executed on payment_link channel when contact_consent = false -> VIOLATION!
      { run_id: run.id, mandate_id: m1.id, attempt_number: 1, executed_day: 0, channel: 'payment_link', outcome: 'failure' },
    ]);

    const metrics = await getSimulationMetrics({ runId: run.id });
    assert.equal(metrics.safety.consentViolations, 1);
  });

  // 21. Notification consent violations are detected.
  it('21. Notification consent violations are detected', async () => {
    const run = await createTestRun();
    const [m1] = await insertMandates([
      // contact_consent = false!
      { run_id: run.id, mandate_id: 'MNONOTIF1', experiment_arm: 'smart', amount: 1000, status: 'pending', first_due_day: 0, contact_consent: false },
    ]);

    await insertAttempts([
      // auto_debit channel, BUT notification_sent_day is set when contact_consent = false -> VIOLATION!
      { run_id: run.id, mandate_id: m1.id, attempt_number: 1, executed_day: 0, channel: 'auto_debit', outcome: 'failure', notification_sent_day: 0, notification_message: 'Payment failed' },
    ]);

    const metrics = await getSimulationMetrics({ runId: run.id });
    assert.equal(metrics.safety.notificationViolations, 1);
  });

  // 22. Safety total is correct.
  it('22. Safety total is correct', async () => {
    const run = await createTestRun();
    const [m1, m2] = await insertMandates([
      { run_id: run.id, mandate_id: 'MST1', experiment_arm: 'smart', amount: 1000, status: 'pending', first_due_day: 0, contact_consent: false },
      { run_id: run.id, mandate_id: 'MST2', experiment_arm: 'smart', amount: 1000, status: 'pending', first_due_day: 0, contact_consent: false },
    ]);

    await insertAttempts([
      // 1. Hard decline retry violation on m1
      { run_id: run.id, mandate_id: m1.id, attempt_number: 1, executed_day: 0, channel: 'auto_debit', outcome: 'failure', decline_category: 'hard', retry_eligible: false, idempotency_key: 'KEY_A' },
      { run_id: run.id, mandate_id: m1.id, attempt_number: 2, executed_day: 1, channel: 'payment_link', outcome: 'failure', idempotency_key: 'KEY_B' }, // also consentViolation (payment_link + false consent)
      // 2. Notification violation on m2
      { run_id: run.id, mandate_id: m2.id, attempt_number: 1, executed_day: 0, channel: 'auto_debit', outcome: 'failure', notification_sent_day: 0, idempotency_key: 'KEY_C' },
    ]);

    const metrics = await getSimulationMetrics({ runId: run.id });
    // hardDeclineRetryViolations = 1
    // consentViolations = 1
    // notificationViolations = 1
    // duplicateAttemptViolations = 0
    // total = 3
    assert.equal(metrics.safety.hardDeclineRetryViolations, 1);
    assert.equal(metrics.safety.consentViolations, 1);
    assert.equal(metrics.safety.notificationViolations, 1);
    assert.equal(metrics.safety.totalViolations, 3);
  });

  // 23. safe === true when there are zero violations.
  it('23. safe === true when there are zero violations', async () => {
    const run = await createTestRun();
    const [m1] = await insertMandates([
      { run_id: run.id, mandate_id: 'MOK1', experiment_arm: 'control', amount: 1000, status: 'recovered', first_due_day: 0, contact_consent: true },
    ]);

    await insertAttempts([
      { run_id: run.id, mandate_id: m1.id, attempt_number: 1, executed_day: 0, channel: 'auto_debit', outcome: 'success' },
    ]);

    const metrics = await getSimulationMetrics({ runId: run.id });
    assert.equal(metrics.safety.totalViolations, 0);
    assert.equal(metrics.safety.safe, true);
  });

  // 24. safe === false when violations exist.
  it('24. safe === false when violations exist', async () => {
    const run = await createTestRun();
    const [m1] = await insertMandates([
      { run_id: run.id, mandate_id: 'MBAD1', experiment_arm: 'smart', amount: 1000, status: 'pending', first_due_day: 0, contact_consent: false },
    ]);

    await insertAttempts([
      { run_id: run.id, mandate_id: m1.id, attempt_number: 1, executed_day: 0, channel: 'payment_link', outcome: 'failure' },
    ]);

    const metrics = await getSimulationMetrics({ runId: run.id });
    assert.ok(metrics.safety.totalViolations > 0);
    assert.equal(metrics.safety.safe, false);
  });

  // 25. No metric calculation modifies persisted data.
  it('25. No metric calculation modifies persisted data', async () => {
    const run = await createTestRun();
    const [m1] = await insertMandates([
      { run_id: run.id, mandate_id: 'MIMMUT1', experiment_arm: 'baseline', amount: 1250, status: 'recovered', first_due_day: 1 },
    ]);
    const [a1] = await insertAttempts([
      { run_id: run.id, mandate_id: m1.id, attempt_number: 1, executed_day: 2, channel: 'auto_debit', outcome: 'success' },
    ]);

    // Snapshot before
    const { data: runBefore } = await supabase.from('simulation_runs').select('*').eq('id', run.id).single();
    const { data: mandateBefore } = await supabase.from('mandates').select('*').eq('id', m1.id).single();
    const { data: attemptBefore } = await supabase.from('attempts').select('*').eq('id', a1.id).single();

    // Call metrics
    await getSimulationMetrics({ runId: run.id });

    // Snapshot after
    const { data: runAfter } = await supabase.from('simulation_runs').select('*').eq('id', run.id).single();
    const { data: mandateAfter } = await supabase.from('mandates').select('*').eq('id', m1.id).single();
    const { data: attemptAfter } = await supabase.from('attempts').select('*').eq('id', a1.id).single();

    assert.deepEqual(runBefore, runAfter);
    assert.deepEqual(mandateBefore, mandateAfter);
    assert.deepEqual(attemptBefore, attemptAfter);
  });

  // 26. No payment attempt is created by metrics.
  it('26. No payment attempt is created by metrics', async () => {
    const run = await createTestRun();
    const { count: beforeCount } = await supabase
      .from('attempts')
      .select('*', { count: 'exact', head: true })
      .eq('run_id', run.id);

    await getSimulationMetrics({ runId: run.id });

    const { count: afterCount } = await supabase
      .from('attempts')
      .select('*', { count: 'exact', head: true })
      .eq('run_id', run.id);

    assert.equal(afterCount, beforeCount);
  });

  // 27. Unknown/nonexistent runId fails clearly.
  it('27. Unknown/nonexistent runId fails clearly', async () => {
    const fakeRunId = '00000000-0000-0000-0000-000000000999';
    await assert.rejects(
      () => getSimulationMetrics({ runId: fakeRunId }),
      /simulation run .* not found/
    );

    await assert.rejects(
      () => getSimulationMetrics({ runId: '' }),
      /runId must be a non-empty string/
    );
  });

  // 28. No NaN or Infinity is returned.
  it('28. No NaN or Infinity is returned', async () => {
    const run = await createTestRun();
    const metrics = await getSimulationMetrics({ runId: run.id });

    function assertNoNaNOrInfinity(obj) {
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'number') {
          assert.ok(Number.isFinite(value), `${key} must be finite number, got ${value}`);
        } else if (value && typeof value === 'object') {
          assertNoNaNOrInfinity(value);
        }
      }
    }

    assertNoNaNOrInfinity(metrics);
  });

  // 29. All applicable rate/average metrics are rounded to 4 decimal places.
  it('29. All applicable rate/average metrics are rounded to 4 decimal places', async () => {
    const run = await createTestRun();
    // 1 recovered out of 3 = 0.3333333...
    await insertMandates([
      { run_id: run.id, mandate_id: 'MRND1', experiment_arm: 'control', amount: 1000, status: 'recovered', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MRND2', experiment_arm: 'control', amount: 1000, status: 'pending', first_due_day: 0 },
      { run_id: run.id, mandate_id: 'MRND3', experiment_arm: 'control', amount: 1000, status: 'pending', first_due_day: 0 },
    ]);

    const metrics = await getSimulationMetrics({ runId: run.id });
    assert.equal(metrics.arms.control.recoveryRate, 0.3333);

    // Verify round4 helper directly
    assert.equal(round4(1 / 3), 0.3333);
    assert.equal(round4(0.123456), 0.1235);
    assert.equal(round4(0), 0);
    assert.equal(round4(NaN), 0);
    assert.equal(round4(Infinity), 0);
  });
});
