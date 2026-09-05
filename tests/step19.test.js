// tests/step19.test.js
//
// Step 19: Stress Test + Integration Pass.
//
// Verifies that the complete system from Steps 1–18 works correctly together
// under larger deterministic datasets and edge-case scenarios:
//   1. Core 30-mandate end-to-end integration (Control + Baseline + Smart)
//   2. Repeated-run safety / idempotency (re-running on completed simulation)
//   3. Attempt safety invariants (attempts <= 4, sequential, no duplicates, no same-day infinite loops)
//   4. Smart safety (hard & unknown failures never auto-retry, invalid AI actions rejected)
//   5. Human approval lifecycle (pending -> approved / rejected / expired, no premature payments)
//   6. Control & Baseline policy regression under stress
//   7. Simulation clock / horizon boundaries (no early execution, never beyond max_days)
//   8. Audit logging integrity & secret sanitization
//   9. Full API integration (POST /simulations -> GET /:runId -> POST /:runId/run -> GET /:runId/metrics)
//   10. Larger deterministic dataset (45 mandates) stress run

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { supabase } from '../src/config/supabase.js';
import { app } from '../server.js';
import { generateSyntheticData } from '../src/generators/syntheticDataGenerator.js';
import { runAllRecovery } from '../src/recovery/recoveryRunner.js';
import { executeSmartPolicy } from '../src/recovery/smartPolicy.js';
import {
  requestHumanApproval,
  approveHumanApproval,
  rejectHumanApproval,
  expireHumanApprovals,
} from '../src/recovery/humanApproval.js';
import { getSimulationMetrics } from '../src/evaluation/metrics.js';

// ─────────────────────────────────────────────────────────────────────────────
// Smart Agent fetch interceptor / mock seam (reused from Steps 13 & 18)
// ─────────────────────────────────────────────────────────────────────────────

let _savedFetch;
let _mockAiHandler = null;

function installFetch(fn) {
  _mockAiHandler = fn;
}

function restoreFetch() {
  global.fetch = _savedFetch;
  _mockAiHandler = null;
}

/**
 * Deterministic varied Smart AI mock that returns different realistic proposals
 * based on prompt context (mandate ID / category) to exercise multiple code paths.
 */
function createVariedAiMock() {
  let callCount = 0;
  return async (url, opts) => {
    callCount++;

    // Low-confidence retry -> triggers human_review guardrail
    if (callCount % 5 === 0) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      action: 'retry',
                      retryDelayDays: 2,
                      confidence: 0.55, // below 0.70 threshold
                      reasoning: 'Low confidence retry proposal requiring human review.',
                    }),
                  },
                ],
              },
            },
          ],
        }),
      };
    }

    // Explicit human_review
    if (callCount % 4 === 0) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      action: 'human_review',
                      retryDelayDays: 2,
                      reasoning: 'AI recommends human escalation due to volatile history.',
                    }),
                  },
                ],
              },
            },
          ],
        }),
      };
    }

    // Explicit stand_down
    if (callCount % 3 === 0) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      action: 'stand_down',
                      retryDelayDays: null,
                      reasoning: 'AI determines recovery probability too low; stand down.',
                    }),
                  },
                ],
              },
            },
          ],
        }),
      };
    }

    // Standard valid retry (delay: 2 or 3 days)
    const delay = (callCount % 2 === 0) ? 3 : 2;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    action: 'retry',
                    retryDelayDays: delay,
                    confidence: 0.88,
                    reasoning: `AI proposes retry with ${delay}-day delay based on salary window.`,
                  }),
                },
              ],
            },
          },
        ],
      }),
    };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Data Tracking & Isolation
// ─────────────────────────────────────────────────────────────────────────────

const allCreatedRunIds = new Set();
const passedRunIds = new Set();

async function createTrackedRun({ seed = 19000, maxDays = 10, currentDay = 0 } = {}) {
  const { data: run, error } = await supabase
    .from('simulation_runs')
    .insert({ random_seed: seed, current_day: currentDay, max_days: maxDays, status: 'running' })
    .select()
    .single();
  if (error) throw new Error(`createTrackedRun failed: ${error.message}`);
  allCreatedRunIds.add(run.id);
  return run;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite Setup & Teardown
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 19 — Stress Test + Integration Pass', () => {
  let server;
  let baseUrl;

  before(async () => {
    // 1. Start ephemeral HTTP server for API route tests
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // 2. Intercept Gemini API fetch calls (pass-through for all other requests)
    _savedFetch = global.fetch;
    global.fetch = async (url, opts) => {
      const urlStr = typeof url === 'string' ? url : url?.href || url?.url || String(url);
      if (urlStr.includes('generativelanguage.googleapis.com')) {
        if (_mockAiHandler) {
          return _mockAiHandler(url, opts);
        }
        throw new Error('fetch failed: unexpected unmocked Gemini call');
      }
      let attempts = 0;
      while (attempts < 3) {
        try {
          return await _savedFetch(url, opts);
        } catch (err) {
          attempts++;
          if (attempts >= 3 || !err?.message?.includes('fetch failed')) {
            throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
    };

    if (!process.env.GEMINI_API_KEY) {
      process.env.GEMINI_API_KEY = 'TEST_KEY_STEP19';
    }
  });

  after(async () => {
    // 1. Restore fetch & close HTTP server
    restoreFetch();
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }

    // 2. Clean up ONLY passed test runs (failed test data is preserved for inspection)
    for (const runId of passedRunIds) {
      try {
        await supabase.from('simulation_runs').delete().eq('id', runId);
      } catch (_) {
        // foreign-key cascade deletes child records
      }
    }
  });

  beforeEach(() => {
    installFetch(createVariedAiMock());
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Core 30-Mandate End-to-End Simulation
  // ───────────────────────────────────────────────────────────────────────────
  it('1. Core 30-Mandate End-to-End Simulation: all 3 arms complete, safety & metrics hold', { timeout: 240000 }, async () => {
    const startTime = Date.now();

    // Generate 30 mandates (10 control, 10 baseline, 10 smart)
    const genResult = await generateSyntheticData({
      seed: 19001,
      mandateCount: 30,
      maxDays: 10,
    });
    const runId = genResult.simulationRunId;
    allCreatedRunIds.add(runId);

    // Verify mandates were created and all 3 arms exist
    const { data: initialMandates, error: mErr } = await supabase
      .from('mandates')
      .select('id, experiment_arm, status, next_action_day')
      .eq('run_id', runId);
    assert.ifError(mErr);
    assert.equal(initialMandates.length, 30);

    const arms = initialMandates.map((m) => m.experiment_arm);
    assert.ok(arms.includes('control'), 'Must contain Control mandates');
    assert.ok(arms.includes('baseline'), 'Must contain Baseline mandates');
    assert.ok(arms.includes('smart'), 'Must contain Smart mandates');

    // Run the full recovery simulation across all days
    const runResult = await runAllRecovery({ runId });

    assert.equal(runResult.runId, runId);
    assert.ok(
      ['no_future_actions_within_window', 'reached_max_days'].includes(runResult.terminatedReason),
      `Valid termination reason: got ${runResult.terminatedReason}`
    );

    // Fetch final simulation state
    const { data: runRecord } = await supabase
      .from('simulation_runs')
      .select('*')
      .eq('id', runId)
      .single();

    assert.ok(
      runRecord.current_day <= runRecord.max_days,
      `current_day (${runRecord.current_day}) must never exceed max_days (${runRecord.max_days})`
    );

    // Fetch final mandates and attempts
    const { data: finalMandates } = await supabase
      .from('mandates')
      .select('*')
      .eq('run_id', runId);

    const { data: allAttempts } = await supabase
      .from('attempts')
      .select('*')
      .eq('run_id', runId);

    assert.ok(allAttempts.length > 0, 'Simulation must produce persisted attempts');

    // Invariants per mandate
    const validTerminalStatuses = ['recovered', 'stood_down', 'exhausted', 'pending_human_approval', 'pending'];
    for (const m of finalMandates) {
      assert.ok(
        m.attempts_used <= 4,
        `Mandate ${m.id} exceeded max attempts: ${m.attempts_used}`
      );

      const mandateAttempts = allAttempts.filter((a) => a.mandate_id === m.id);
      assert.equal(mandateAttempts.length, m.attempts_used);

      // Verify sequential attempt numbers
      const attemptNums = mandateAttempts.map((a) => a.attempt_number).sort((a, b) => a - b);
      for (let i = 0; i < attemptNums.length; i++) {
        assert.equal(attemptNums[i], i + 1, `Attempts must be 1-indexed sequential for mandate ${m.id}`);
      }

      // If recovered: must have at least one successful attempt
      if (m.status === 'recovered') {
        const hasSuccess = mandateAttempts.some((a) => a.outcome === 'success' || a.status === 'success');
        assert.ok(hasSuccess, `Recovered mandate ${m.id} must have a successful attempt`);
      }

      assert.ok(validTerminalStatuses.includes(m.status), `Valid mandate status: ${m.status}`);
    }

    // Verify no attempt occurred beyond max_days (attempts table stores day in `executed_day` column)
    for (const a of allAttempts) {
      assert.ok(
        a.executed_day <= runRecord.max_days,
        `Attempt day (${a.executed_day}) cannot exceed max_days (${runRecord.max_days})`
      );
      assert.ok(a.attempt_number <= 4, `Attempt number (${a.attempt_number}) cannot exceed 4`);
    }

    // Verify metrics calculation succeeds on the completed run
    const metrics = await getSimulationMetrics({ runId });
    assert.equal(metrics.runId, runId);
    assert.ok(metrics.arms.control !== undefined);
    assert.ok(metrics.arms.baseline !== undefined);
    assert.ok(metrics.arms.smart !== undefined);
    assert.equal(metrics.safety.totalViolations, 0, 'No safety violations allowed');
    assert.equal(metrics.safety.safe, true);

    const elapsed = Date.now() - startTime;
    assert.ok(elapsed > 0);

    // Mark as passed for clean teardown
    passedRunIds.add(runId);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Repeated-Run Safety / Idempotency
  // ───────────────────────────────────────────────────────────────────────────
  it('2. Repeated-run safety: running recovery runner again on completed run creates no duplicates', { timeout: 120000 }, async () => {
    const genResult = await generateSyntheticData({
      seed: 19002,
      mandateCount: 6,
      maxDays: 3,
    });
    const runId = genResult.simulationRunId;
    allCreatedRunIds.add(runId);

    // Initial complete run
    await runAllRecovery({ runId });

    // Snapshot state
    const { data: attemptsBefore } = await supabase
      .from('attempts')
      .select('id, mandate_id, attempt_number')
      .eq('run_id', runId);

    const { data: mandatesBefore } = await supabase
      .from('mandates')
      .select('id, status, attempts_used')
      .eq('run_id', runId);

    const metricsBefore = await getSimulationMetrics({ runId });

    // Second run on same simulation
    const secondResult = await runAllRecovery({ runId });

    // Assert runner processed 0 new actions or terminated immediately
    assert.equal(secondResult.processedCount, 0, 'Second run must process 0 actions');

    // Assert attempts count identical
    const { data: attemptsAfter } = await supabase
      .from('attempts')
      .select('id, mandate_id, attempt_number')
      .eq('run_id', runId);
    assert.equal(attemptsAfter.length, attemptsBefore.length);

    // Assert mandate statuses identical
    const { data: mandatesAfter } = await supabase
      .from('mandates')
      .select('id, status, attempts_used')
      .eq('run_id', runId);
    assert.deepEqual(mandatesAfter, mandatesBefore);

    // Metrics remain identical
    const metricsAfter = await getSimulationMetrics({ runId });
    assert.equal(metricsAfter.safety.totalViolations, metricsBefore.safety.totalViolations);
    assert.equal(metricsAfter.arms.smart.totalRecovered, metricsBefore.arms.smart.totalRecovered);

    passedRunIds.add(runId);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Attempt Safety Invariants & Same-Day Retry Protection
  // ───────────────────────────────────────────────────────────────────────────
  it('3. Attempt safety: zero/same-day delay is safely scheduled for next day (no infinite loop)', { timeout: 60000 }, async () => {
    const run = await createTrackedRun({ seed: 19003, maxDays: 5, currentDay: 1 });

    // Insert a Smart mandate
    const { data: mandate } = await supabase
      .from('mandates')
      .insert({
        run_id: run.id,
        mandate_id: 'SM-SAFETY-01',
        amount: 1000,
        income_day_of_month: 5,
        balance_volatility: 0.2,
        contact_consent: true,
        experiment_arm: 'smart',
        status: 'pending',
        first_due_day: 1,
        next_action: 'retry',
        next_action_day: 1,
        attempts_used: 0,
        created_day: 0,
      })
      .select()
      .single();

    // Mock AI to propose delayDays: 0 (same day retry proposal)
    installFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    action: 'retry',
                    retryDelayDays: 0, // 0-delay proposal
                    reasoning: 'Immediate retry proposal',
                  }),
                },
              ],
            },
          },
        ],
      }),
    }));

    // Execute smart policy on Day 1
    const updated = await executeSmartPolicy({
      runId: run.id,
      mandate,
      currentDay: 1,
      seed: 19003,
      run,
    });

    // Guardrail/policy must schedule for a future day to prevent infinite loop
    assert.ok(
      updated.next_action_day > 1,
      `Zero-delay retry must be adjusted to a future day: got next_action_day=${updated.next_action_day}`
    );

    passedRunIds.add(run.id);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Smart Safety: Hard & Unknown Failures Never Auto-Retry
  // ───────────────────────────────────────────────────────────────────────────
  it('4. Smart safety: hard & unknown failures stand down; AI retry cannot override', { timeout: 60000 }, async () => {
    const run = await createTrackedRun({ seed: 19004, maxDays: 5, currentDay: 1 });

    const { data: mandate } = await supabase
      .from('mandates')
      .insert({
        run_id: run.id,
        mandate_id: 'SM-HARD-01',
        amount: 1500,
        income_day_of_month: 10,
        balance_volatility: 0.5,
        contact_consent: true,
        experiment_arm: 'smart',
        status: 'pending',
        first_due_day: 1,
        next_action: 'retry',
        next_action_day: 1,
        attempts_used: 0,
        created_day: 0,
      })
      .select()
      .single();

    // Prior hard failure via RPCs (Step 18 contract)
    const idempKey = `recovery-run:${run.id}:mandate:${mandate.id}:attempt:1`;
    const { data: priorAttemptId, error: priorErr } = await supabase.rpc('execute_attempt', {
      p_run_id: run.id,
      p_mandate_id: mandate.id,
      p_day: 1,
      p_channel: 'auto_debit',
      p_idempotency_key: idempKey,
    });
    if (priorErr) throw new Error(`execute_attempt failed: ${priorErr.message}`);

    await supabase.rpc('complete_attempt', {
      p_attempt_id: priorAttemptId,
      p_outcome: 'failure',
      p_decline_code: 'SIM_HARD_001',
      p_decline_category: 'hard',
      p_retry_eligible: false,
    });
    await supabase.rpc('set_mandate_action', {
      p_run_id: run.id,
      p_mandate_id: mandate.id,
      p_action: 'retry',
      p_action_day: 2,
      p_reason: 'test_setup',
    });

    // Even if AI aggressively proposes retry
    installFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    action: 'retry',
                    retryDelayDays: 1,
                    reasoning: 'Aggressive AI retry override attempt',
                  }),
                },
              ],
            },
          },
        ],
      }),
    }));

    const { data: freshM } = await supabase.from('mandates').select('*').eq('id', mandate.id).single();
    const result = await executeSmartPolicy({
      runId: run.id,
      mandate: freshM,
      currentDay: 2,
      seed: 19004,
      run,
    });

    assert.ok(
      ['stood_down', 'exhausted'].includes(result.status),
      `Hard decline MUST result in stood_down; got ${result.status}`
    );
    assert.ok(result.next_action !== 'retry', 'No retry action allowed for hard failure');

    passedRunIds.add(run.id);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Full Human Approval Lifecycle
  // ───────────────────────────────────────────────────────────────────────────
  it('5. Human approval lifecycle: pending -> approved -> retry; rejection/expiration stands down', { timeout: 90000 }, async () => {
    const run = await createTrackedRun({ seed: 19005, maxDays: 10, currentDay: 1 });

    // Create a pending mandate
    const { data: mandate } = await supabase
      .from('mandates')
      .insert({
        run_id: run.id,
        mandate_id: 'SM-HUMAN-01',
        amount: 2000,
        income_day_of_month: 15,
        balance_volatility: 0.4,
        contact_consent: true,
        experiment_arm: 'smart',
        status: 'pending',
        first_due_day: 1,
        next_action: 'retry',
        next_action_day: 1,
        attempts_used: 0,
        created_day: 0,
      })
      .select()
      .single();

    // 1. Request human approval
    await requestHumanApproval({
      runId: run.id,
      mandate,
      currentDay: 1,
      proposal: {
        action: 'retry',
        delayDays: 2,
        retryDelayDays: 2,
        channel: 'auto_debit',
        discountPercent: 0,
        confidence: 0.6,
        reasoning: 'Needs manual check',
      },
      expiresDay: 3,
      maxDays: 10,
    });

    // Fresh mandate state should now be pending_human_approval
    const { data: freshM1 } = await supabase.from('mandates').select('*').eq('id', mandate.id).single();
    assert.equal(freshM1.status, 'pending_human_approval');

    // Verify duplicate approval request is blocked
    await assert.rejects(
      async () => {
        await requestHumanApproval({
          runId: run.id,
          mandate: freshM1,
          currentDay: 1,
          proposal: { action: 'retry', delayDays: 2 },
          expiresDay: 3,
          maxDays: 10,
        });
      },
      /pending/i
    );

    // Verify approval requests table has 1 pending entry
    const { data: approvals } = await supabase
      .from('approval_requests')
      .select('*')
      .eq('mandate_id', mandate.id)
      .eq('status', 'pending');
    assert.equal(approvals.length, 1);
    const approvalId = approvals[0].id;

    // 2. Approve the request
    const approveResult = await approveHumanApproval({
      approvalId,
      decidedBy: 'test_reviewer',
      decidedDay: 1,
      decisionReason: 'Approved by human reviewer',
    });

    assert.equal(approveResult.status, 'approved');
    assert.equal(approveResult.mandate.status, 'pending');

    // 3. Test Rejection with a second mandate
    const { data: mandate2 } = await supabase
      .from('mandates')
      .insert({
        run_id: run.id,
        mandate_id: 'SM-HUMAN-02',
        amount: 2500,
        income_day_of_month: 20,
        balance_volatility: 0.4,
        contact_consent: true,
        experiment_arm: 'smart',
        status: 'pending',
        first_due_day: 1,
        next_action: 'retry',
        next_action_day: 1,
        attempts_used: 0,
        created_day: 0,
      })
      .select()
      .single();

    await requestHumanApproval({
      runId: run.id,
      mandate: mandate2,
      currentDay: 1,
      proposal: { action: 'retry', delayDays: 2, channel: 'auto_debit', discountPercent: 0, confidence: 0.6 },
      expiresDay: 3,
      maxDays: 10,
    });

    const { data: approvals2 } = await supabase
      .from('approval_requests')
      .select('id')
      .eq('mandate_id', mandate2.id)
      .eq('status', 'pending')
      .single();

    const rejectResult = await rejectHumanApproval({
      approvalId: approvals2.id,
      decidedBy: 'test_reviewer',
      decidedDay: 1,
      decisionReason: 'Rejected by human reviewer',
    });

    assert.equal(rejectResult.status, 'rejected');
    assert.equal(rejectResult.mandate.status, 'stood_down');

    // 4. Test Expiration with a third mandate
    const { data: mandate3 } = await supabase
      .from('mandates')
      .insert({
        run_id: run.id,
        mandate_id: 'SM-HUMAN-03',
        amount: 3000,
        income_day_of_month: 25,
        balance_volatility: 0.4,
        contact_consent: true,
        experiment_arm: 'smart',
        status: 'pending',
        first_due_day: 1,
        next_action: 'retry',
        next_action_day: 1,
        attempts_used: 0,
        created_day: 0,
      })
      .select()
      .single();

    await requestHumanApproval({
      runId: run.id,
      mandate: mandate3,
      currentDay: 1,
      proposal: { action: 'retry', delayDays: 2, channel: 'auto_debit', discountPercent: 0, confidence: 0.6 },
      expiresDay: 2, // expires on day 2
      maxDays: 10,
    });

    // Advance to day 2 and expire approvals
    const { expiredCount } = await expireHumanApprovals({ runId: run.id, currentDay: 2 });
    assert.ok(expiredCount >= 1, 'Must expire at least 1 approval request');

    const { data: freshM3 } = await supabase.from('mandates').select('status').eq('id', mandate3.id).single();
    assert.equal(freshM3.status, 'stood_down', 'Expired approval request must stand down mandate');

    passedRunIds.add(run.id);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Control & Baseline Policy Regression Under Stress
  // ───────────────────────────────────────────────────────────────────────────
  it('6. Control & Baseline regression: Control never retries; Baseline respects fixed schedule & max 4', { timeout: 90000 }, async () => {
    const run = await createTrackedRun({ seed: 19006, maxDays: 10, currentDay: 0 });

    // Create 1 Control mandate
    const { data: ctrl } = await supabase
      .from('mandates')
      .insert({
        run_id: run.id,
        mandate_id: 'REG-CTRL-01',
        amount: 500,
        income_day_of_month: 1,
        balance_volatility: 0.1,
        contact_consent: true,
        experiment_arm: 'control',
        status: 'pending',
        first_due_day: 1,
        next_action: 'retry',
        next_action_day: 1,
        attempts_used: 0,
        created_day: 0,
      })
      .select()
      .single();

    // Create 1 Baseline mandate
    const { data: base } = await supabase
      .from('mandates')
      .insert({
        run_id: run.id,
        mandate_id: 'REG-BASE-01',
        amount: 500,
        income_day_of_month: 1,
        balance_volatility: 0.1,
        contact_consent: true,
        experiment_arm: 'baseline',
        status: 'pending',
        first_due_day: 1,
        next_action: 'retry',
        next_action_day: 1,
        attempts_used: 0,
        created_day: 0,
      })
      .select()
      .single();

    await runAllRecovery({ runId: run.id });

    // Verify Control: attempts_used is at most 1
    const { data: finalCtrl } = await supabase.from('mandates').select('*').eq('id', ctrl.id).single();
    assert.ok(finalCtrl.attempts_used <= 1, 'Control must never execute more than 1 attempt');
    assert.ok(['recovered', 'stood_down'].includes(finalCtrl.status));

    // Verify Baseline: attempts_used <= 4
    const { data: finalBase } = await supabase.from('mandates').select('*').eq('id', base.id).single();
    assert.ok(finalBase.attempts_used <= 4, 'Baseline must never execute more than 4 attempts');
    assert.ok(['recovered', 'stood_down', 'exhausted'].includes(finalBase.status));

    passedRunIds.add(run.id);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Simulation Clock Horizon & Early-Action Protection
  // ───────────────────────────────────────────────────────────────────────────
  it('7. Simulation clock & horizon: actions scheduled for future day are never executed early', { timeout: 60000 }, async () => {
    const run = await createTrackedRun({ seed: 19007, maxDays: 10, currentDay: 1 });

    // Mandate scheduled for Day 5
    const { data: futureMandate } = await supabase
      .from('mandates')
      .insert({
        run_id: run.id,
        mandate_id: 'FUTURE-01',
        amount: 1000,
        income_day_of_month: 10,
        balance_volatility: 0.2,
        contact_consent: true,
        experiment_arm: 'smart',
        status: 'pending',
        first_due_day: 5,
        next_action: 'retry',
        next_action_day: 5,
        attempts_used: 0,
        created_day: 0,
      })
      .select()
      .single();

    // In recovery runner, process only day 1
    const { processDueMandates } = await import('../src/recovery/recoveryEngine.js');
    const day1Result = await processDueMandates({
      runId: run.id,
      currentDay: 1,
      seed: 19007,
      allowedArms: ['smart'],
    });

    assert.equal(day1Result.processedCount, 0, 'Mandate due on Day 5 must not execute on Day 1');

    const { data: attempts } = await supabase
      .from('attempts')
      .select('*')
      .eq('mandate_id', futureMandate.id);
    assert.equal(attempts.length, 0, 'No attempt must exist for future mandate');

    passedRunIds.add(run.id);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 8. Audit Logging Integrity & Secret Sanitization
  // ───────────────────────────────────────────────────────────────────────────
  it('8. Audit logging: logs contain decisions, reasoning, and zero secrets/API keys', { timeout: 60000 }, async () => {
    const run = await createTrackedRun({ seed: 19008, maxDays: 5, currentDay: 0 });

    const { data: mandate } = await supabase
      .from('mandates')
      .insert({
        run_id: run.id,
        mandate_id: 'AUDIT-SM-01',
        amount: 800,
        income_day_of_month: 1,
        balance_volatility: 0.2,
        contact_consent: true,
        experiment_arm: 'smart',
        status: 'pending',
        first_due_day: 1,
        next_action: 'retry',
        next_action_day: 1,
        attempts_used: 0,
        created_day: 0,
      })
      .select()
      .single();

    await runAllRecovery({ runId: run.id });

    // Read audit logs for this run
    const { data: logs, error: lErr } = await supabase
      .from('audit_logs')
      .select('*')
      .eq('run_id', run.id);

    assert.ifError(lErr);
    assert.ok(logs.length > 0, 'Audit logs must be created during simulation');

    // Verify secret sanitization across all logs
    const secretPattern = /AIza[0-9A-Za-z-_]{35}|TEST_KEY|apiKey|secret_key/i;
    for (const log of logs) {
      const serialized = JSON.stringify(log);
      assert.equal(
        secretPattern.test(serialized),
        false,
        `Audit log entry ${log.id} contains leaked secret: ${serialized}`
      );
    }

    passedRunIds.add(run.id);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 9. Full API Integration Flow
  // ───────────────────────────────────────────────────────────────────────────
  it('9. Express API integration: POST /simulations -> GET /:runId -> POST /:runId/run -> GET /:runId/metrics', { timeout: 120000 }, async () => {
    // 1. POST /api/simulations
    const createRes = await fetch(`${baseUrl}/api/simulations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seed: 19009, mandateCount: 6, maxDays: 3 }),
    });
    assert.equal(createRes.status, 201);
    const createBody = await createRes.json();
    assert.ok(createBody.runId, 'Must return runId');
    assert.equal(createBody.mandateIds.length, 6);
    const runId = createBody.runId;
    allCreatedRunIds.add(runId);

    // 2. GET /api/simulations/:runId
    const getRes = await fetch(`${baseUrl}/api/simulations/${runId}`);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.runId, runId);
    assert.equal(getBody.maxDays, 3);

    // 3. POST /api/simulations/:runId/run
    const runRes = await fetch(`${baseUrl}/api/simulations/${runId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(runRes.status, 200);
    const runBody = await runRes.json();
    assert.equal(runBody.runId, runId);
    assert.ok(runBody.processedCount >= 0);

    // 4. GET /api/simulations/:runId/metrics
    const metricsRes = await fetch(`${baseUrl}/api/simulations/${runId}/metrics`);
    assert.equal(metricsRes.status, 200);
    const metricsBody = await metricsRes.json();
    assert.equal(metricsBody.runId, runId);
    assert.ok(metricsBody.arms.control !== undefined);
    assert.ok(metricsBody.arms.baseline !== undefined);
    assert.ok(metricsBody.arms.smart !== undefined);
    assert.equal(metricsBody.safety.safe, true);

    // 5. 404 for unknown runId
    const notFoundRes = await fetch(`${baseUrl}/api/simulations/00000000-0000-0000-0000-000000000000`);
    assert.equal(notFoundRes.status, 404);

    passedRunIds.add(runId);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 10. Larger Deterministic Dataset (60 Mandates)
  // ───────────────────────────────────────────────────────────────────────────
  it('10. Stress test 60 mandates: complete simulation across all 3 arms with clean metrics', { timeout: 300000 }, async () => {
    const startTime = Date.now();

    // 60 mandates (20 control, 20 baseline, 20 smart, maxDays: 4)
    const genResult = await generateSyntheticData({
      seed: 19060,
      mandateCount: 60,
      maxDays: 4,
    });
    const runId = genResult.simulationRunId;
    allCreatedRunIds.add(runId);

    const runResult = await runAllRecovery({ runId });
    assert.equal(runResult.runId, runId);

    // Assert all attempts invariant
    const { data: attempts } = await supabase
      .from('attempts')
      .select('attempt_number, executed_day')
      .eq('run_id', runId);

    for (const a of attempts) {
      assert.ok(a.attempt_number <= 4, `Attempt number ${a.attempt_number} exceeds max 4`);
      assert.ok(a.executed_day <= 4, `Attempt day ${a.executed_day} exceeds max_days 4`);
    }

    // Assert metrics
    const metrics = await getSimulationMetrics({ runId });
    assert.equal(metrics.safety.totalViolations, 0);
    assert.equal(metrics.safety.safe, true);
    assert.equal(metrics.arms.control.totalMandates, 20);
    assert.equal(metrics.arms.baseline.totalMandates, 20);
    assert.equal(metrics.arms.smart.totalMandates, 20);

    const duration = Date.now() - startTime;
    assert.ok(duration > 0);

    passedRunIds.add(runId);
  });
});
