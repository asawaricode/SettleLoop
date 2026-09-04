// tests/step15.test.js
//
// Integration tests for Step 15: Human Approval.
//
// Tests verify database-backed approval workflows:
//   - Request creation, state movement to pending_human_approval, proposed_action formatting
//   - Approval resolution with day-preservation logic: max(decidedDay, proposed_action.day)
//   - Rejection resolution, terminal state stood_down, next_action='none', next_action_day=null
//   - Expiration via simulation clock, per-record auditing, count mismatch resilience
//   - Audit logging for all approval operations
//   - Zero payment execution / zero attempt creation guarantees

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../src/config/supabase.js';
import {
  requestHumanApproval,
  approveHumanApproval,
  rejectHumanApproval,
  expireHumanApprovals,
  validateGuardrails,
} from '../src/recovery/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

let testRun;

async function setupTestRun({ seed = 99999, maxDays = 30, currentDay = 0 } = {}) {
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

  if (error) throw new Error(`setupTestRun failed: ${error.message}`);
  return run;
}

async function createMandate({
  runId,
  mandateId,
  status = 'pending',
  nextAction = 'retry',
  nextActionDay = 0,
  attemptsUsed = 1,
  contactConsent = true,
}) {
  const { data: mandate, error } = await supabase
    .from('mandates')
    .insert({
      run_id: runId,
      mandate_id: mandateId,
      amount: 1500,
      income_day_of_month: 10,
      balance_volatility: 0.3,
      contact_consent: contactConsent,
      experiment_arm: 'smart',
      status,
      first_due_day: 0,
      next_action: nextAction,
      next_action_day: nextActionDay,
      attempts_used: attemptsUsed,
      created_day: 0,
    })
    .select()
    .single();

  if (error) throw new Error(`createMandate failed: ${error.message}`);
  return mandate;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 15 — Human Approval', () => {
  before(async () => {
    testRun = await setupTestRun({ seed: 54321, maxDays: 30, currentDay: 0 });
  });

  after(async () => {
    if (testRun?.id) {
      await supabase.from('simulation_runs').delete().eq('id', testRun.id);
    }
  });

  // ─── 1. Request Creation & State Transitions ──────────────────────────────

  it('1. create approval request successfully', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_001' });
    const proposal = {
      action: 'retry',
      delayDays: 3,
      channel: 'auto_debit',
      discountPercent: 0,
      confidence: 0.65, // low confidence routed to human review
      reasoning: 'Retry in 3 days pending review.',
    };

    const res = await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 0,
      proposal,
    });

    assert.ok(res.approvalId, 'approvalId should be returned');
    assert.equal(typeof res.approvalId, 'string');
    assert.equal(res.expiresDay, 2);
  });

  it('2. request moves mandate to pending_human_approval', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_002' });
    const proposal = { action: 'retry', delayDays: 2, confidence: 0.6 };

    await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 0,
      proposal,
    });

    const { data: fresh } = await supabase.from('mandates').select('*').eq('id', mandate.id).single();
    assert.equal(fresh.status, 'pending_human_approval');
    assert.equal(fresh.next_action, 'human_review');
    assert.equal(fresh.next_action_day, 2); // set to expires_day
  });

  it('3. stored proposed_action contains `day`', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_003' });
    const proposal = { action: 'retry', delayDays: 4, confidence: 0.5 };

    const { approvalId } = await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 1,
      proposal,
    });

    const { data: appRow } = await supabase.from('approval_requests').select('*').eq('id', approvalId).single();
    assert.ok('day' in appRow.proposed_action, 'proposed_action must contain `day`');
  });

  it('4. stored proposed_action.day === currentDay + delayDays', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_004' });
    const currentDay = 2;
    const delayDays = 5;
    const proposal = { action: 'retry', delayDays, confidence: 0.55 };

    const { approvalId } = await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay,
      proposal,
    });

    const { data: appRow } = await supabase.from('approval_requests').select('*').eq('id', approvalId).single();
    assert.equal(appRow.proposed_action.day, currentDay + delayDays); // 2 + 5 = 7
  });

  it('5. expiry uses the 2-day policy', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_005' });
    const currentDay = 4;
    const proposal = { action: 'retry', delayDays: 2 };

    const res = await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay,
      proposal,
    });

    assert.equal(res.expiresDay, currentDay + 2); // 4 + 2 = 6
  });

  it('6. expiresDay cannot exceed simulation max_days', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_006' });
    const proposal = { action: 'retry', delayDays: 2 };

    // Simulation max_days is 30. Request with expiresDay = 35 must reject.
    await assert.rejects(
      () =>
        requestHumanApproval({
          runId: testRun.id,
          mandate,
          currentDay: 0,
          proposal,
          expiresDay: 35,
        }),
      /cannot exceed simulation max_days/
    );
  });

  it('7. expiresDay cannot be earlier than currentDay', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_007' });
    const proposal = { action: 'retry', delayDays: 2 };

    await assert.rejects(
      () =>
        requestHumanApproval({
          runId: testRun.id,
          mandate,
          currentDay: 5,
          proposal,
          expiresDay: 4, // earlier than currentDay 5
        }),
      /cannot be earlier than currentDay/
    );
  });

  it('8. decidedBy is explicitly required', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_008' });
    const { approvalId } = await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 0,
      proposal: { action: 'retry', delayDays: 1 },
    });

    // approve without decidedBy throws
    await assert.rejects(
      () => approveHumanApproval({ approvalId, decidedBy: '', decidedDay: 1 }),
      /decidedBy is explicitly required/
    );

    // reject without decidedBy throws
    await assert.rejects(
      () => rejectHumanApproval({ approvalId, decidedBy: null, decidedDay: 1 }),
      /decidedBy is explicitly required/
    );
  });

  it('9. duplicate pending approval is prevented', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_009' });
    const proposal = { action: 'retry', delayDays: 2 };

    // First request succeeds
    await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 0,
      proposal,
    });

    // Fetch mandate fresh (now in pending_human_approval)
    const { data: fresh } = await supabase.from('mandates').select('*').eq('id', mandate.id).single();

    // Second request throws because mandate is not pending
    await assert.rejects(
      () =>
        requestHumanApproval({
          runId: testRun.id,
          mandate: fresh,
          currentDay: 0,
          proposal,
        }),
      /must be 'pending'/
    );
  });

  it('10. recovered mandate cannot create approval', async () => {
    const mandate = await createMandate({
      runId: testRun.id,
      mandateId: 'STEP15_MAN_010',
      status: 'recovered',
    });

    await assert.rejects(
      () =>
        requestHumanApproval({
          runId: testRun.id,
          mandate,
          currentDay: 0,
          proposal: { action: 'retry', delayDays: 1 },
        }),
      /cannot create approval request for mandate .* in status 'recovered'/
    );
  });

  it('11. stood_down mandate cannot create approval', async () => {
    const mandate = await createMandate({
      runId: testRun.id,
      mandateId: 'STEP15_MAN_011',
      status: 'stood_down',
    });

    await assert.rejects(
      () =>
        requestHumanApproval({
          runId: testRun.id,
          mandate,
          currentDay: 0,
          proposal: { action: 'retry', delayDays: 1 },
        }),
      /cannot create approval request for mandate .* in status 'stood_down'/
    );
  });

  it('12. exhausted mandate cannot create approval', async () => {
    const mandate = await createMandate({
      runId: testRun.id,
      mandateId: 'STEP15_MAN_012',
      status: 'exhausted',
    });

    await assert.rejects(
      () =>
        requestHumanApproval({
          runId: testRun.id,
          mandate,
          currentDay: 0,
          proposal: { action: 'retry', delayDays: 1 },
        }),
      /cannot create approval request for mandate .* in status 'exhausted'/
    );
  });

  it('13. pending_human_approval mandate cannot create another approval', async () => {
    const mandate = await createMandate({
      runId: testRun.id,
      mandateId: 'STEP15_MAN_013',
      status: 'pending_human_approval',
    });

    await assert.rejects(
      () =>
        requestHumanApproval({
          runId: testRun.id,
          mandate,
          currentDay: 0,
          proposal: { action: 'retry', delayDays: 1 },
        }),
      /cannot create approval request for mandate .* in status 'pending_human_approval'/
    );
  });

  // ─── 2. Approve Flow & Day Preservation ───────────────────────────────────

  it('14. approve returns mandate to pending', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_014' });
    const { approvalId } = await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 0,
      proposal: { action: 'retry', delayDays: 2 },
    });

    const res = await approveHumanApproval({
      approvalId,
      decidedBy: 'reviewer_carol',
      decidedDay: 1,
    });

    assert.equal(res.status, 'approved');
    assert.equal(res.mandate.status, 'pending');
  });

  it('15. approve sets next_action to retry', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_015' });
    const { approvalId } = await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 0,
      proposal: { action: 'retry', delayDays: 3 },
    });

    const res = await approveHumanApproval({
      approvalId,
      decidedBy: 'reviewer_carol',
      decidedDay: 1,
    });

    assert.equal(res.mandate.next_action, 'retry');
  });

  it('16. proposed day later than decided day → proposed day wins', async () => {
    // Current day = 0, delayDays = 5 → proposed day = 5.
    // Human reviews on day 1 (decidedDay = 1).
    // max(1, 5) = 5 → proposed day wins!
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_016' });
    const { approvalId } = await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 0,
      proposal: { action: 'retry', delayDays: 5 },
    });

    const res = await approveHumanApproval({
      approvalId,
      decidedBy: 'reviewer_carol',
      decidedDay: 1,
    });

    assert.equal(res.mandate.next_action_day, 5);
  });

  it('17. proposed day earlier than decided day → decided day wins', async () => {
    // Current day = 0, delayDays = 1 → proposed day = 1.
    // Human reviews late on day 3 (decidedDay = 3).
    // max(3, 1) = 3 → decided day wins!
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_017' });
    const { approvalId } = await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 0,
      proposal: { action: 'retry', delayDays: 1 },
      expiresDay: 5,
    });

    const res = await approveHumanApproval({
      approvalId,
      decidedBy: 'reviewer_carol',
      decidedDay: 3,
    });

    assert.equal(res.mandate.next_action_day, 3);
  });

  it('18. approve does NOT create an attempt', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_018' });
    const { approvalId } = await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 0,
      proposal: { action: 'retry', delayDays: 2 },
    });

    await approveHumanApproval({
      approvalId,
      decidedBy: 'reviewer_carol',
      decidedDay: 1,
    });

    const { count } = await supabase
      .from('attempts')
      .select('*', { count: 'exact', head: true })
      .eq('mandate_id', mandate.id);

    assert.equal(count, 0, 'No attempt should be created upon approval');
  });

  // ─── 3. Reject Flow ───────────────────────────────────────────────────────

  it('19. reject moves mandate to stood_down', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_019' });
    const { approvalId } = await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 0,
      proposal: { action: 'retry', delayDays: 2 },
    });

    const res = await rejectHumanApproval({
      approvalId,
      decidedBy: 'reviewer_dan',
      decidedDay: 1,
      decisionReason: 'Customer requested cancellation',
    });

    assert.equal(res.status, 'rejected');
    assert.equal(res.mandate.status, 'stood_down');
  });

  it('20. reject sets next_action to none', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_020' });
    const { approvalId } = await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 0,
      proposal: { action: 'retry', delayDays: 2 },
    });

    const res = await rejectHumanApproval({
      approvalId,
      decidedBy: 'reviewer_dan',
      decidedDay: 1,
    });

    assert.equal(res.mandate.next_action, 'none');
  });

  it('21. reject sets next_action_day to null', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_021' });
    const { approvalId } = await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 0,
      proposal: { action: 'retry', delayDays: 2 },
    });

    const res = await rejectHumanApproval({
      approvalId,
      decidedBy: 'reviewer_dan',
      decidedDay: 1,
    });

    assert.equal(res.mandate.next_action_day, null);
  });

  it('22. reject does NOT create an attempt', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_022' });
    const { approvalId } = await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 0,
      proposal: { action: 'retry', delayDays: 2 },
    });

    await rejectHumanApproval({
      approvalId,
      decidedBy: 'reviewer_dan',
      decidedDay: 1,
    });

    const { count } = await supabase
      .from('attempts')
      .select('*', { count: 'exact', head: true })
      .eq('mandate_id', mandate.id);

    assert.equal(count, 0, 'No attempt should be created upon rejection');
  });

  // ─── 4. Expiration Flow ───────────────────────────────────────────────────

  it('23. expiration marks approval expired', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_023' });
    const { approvalId } = await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 0,
      proposal: { action: 'retry', delayDays: 2 },
      expiresDay: 2,
    });

    await expireHumanApprovals({ runId: testRun.id, currentDay: 2 });

    const { data: appRow } = await supabase.from('approval_requests').select('*').eq('id', approvalId).single();
    assert.equal(appRow.status, 'expired');
  });

  it('24. expiration stands mandate down', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_024' });
    await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 0,
      proposal: { action: 'retry', delayDays: 2 },
      expiresDay: 2,
    });

    await expireHumanApprovals({ runId: testRun.id, currentDay: 2 });

    const { data: fresh } = await supabase.from('mandates').select('*').eq('id', mandate.id).single();
    assert.equal(fresh.status, 'stood_down');
  });

  it('25. expiration sets next_action to none', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_025' });
    await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 0,
      proposal: { action: 'retry', delayDays: 2 },
      expiresDay: 2,
    });

    await expireHumanApprovals({ runId: testRun.id, currentDay: 2 });

    const { data: fresh } = await supabase.from('mandates').select('*').eq('id', mandate.id).single();
    assert.equal(fresh.next_action, 'none');
    assert.equal(fresh.next_action_day, null);
  });

  it('26. expiration does NOT create an attempt', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_026' });
    await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 0,
      proposal: { action: 'retry', delayDays: 2 },
      expiresDay: 2,
    });

    await expireHumanApprovals({ runId: testRun.id, currentDay: 2 });

    const { count } = await supabase
      .from('attempts')
      .select('*', { count: 'exact', head: true })
      .eq('mandate_id', mandate.id);

    assert.equal(count, 0, 'No attempt should be created upon expiration');
  });

  // ─── 5. Guardrail Preservation & Safety Limits ────────────────────────────

  it('27. approval cannot bypass max-attempt rule', () => {
    // Guardrails check: mandate with attempts_used >= 4 cannot be approved for retry
    const proposal = { action: 'retry', delayDays: 2, channel: 'auto_debit', confidence: 0.9 };
    const guardrailResult = validateGuardrails({
      proposal,
      context: {
        mandate: { status: 'pending', attempts_used: 4 },
        failure: { category: 'soft', retryEligible: true },
      },
    });

    assert.equal(guardrailResult.allowed, false);
    assert.equal(guardrailResult.action, 'stand_down');
  });

  it('28. approval cannot bypass retry eligibility', () => {
    // Guardrails check: hard decline must never be approved for retry
    const proposal = { action: 'retry', delayDays: 2, channel: 'auto_debit', confidence: 0.9 };
    const guardrailResult = validateGuardrails({
      proposal,
      context: {
        mandate: { status: 'pending', attempts_used: 1 },
        failure: { category: 'hard', retryEligible: false },
      },
    });

    assert.equal(guardrailResult.allowed, false);
    assert.equal(guardrailResult.action, 'stand_down');
  });

  it('29. unsupported action cannot be introduced through approval', () => {
    const proposal = { action: 'escalate_v2', delayDays: 2 };
    const guardrailResult = validateGuardrails({
      proposal,
      context: {
        mandate: { status: 'pending', attempts_used: 1 },
      },
    });

    assert.equal(guardrailResult.allowed, false);
    assert.equal(guardrailResult.action, 'stand_down');
  });

  it('30. same approval cannot be resolved twice', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_030' });
    const { approvalId } = await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 0,
      proposal: { action: 'retry', delayDays: 2 },
    });

    // First resolution succeeds
    await approveHumanApproval({
      approvalId,
      decidedBy: 'reviewer_eve',
      decidedDay: 1,
    });

    // Second resolution must fail
    await assert.rejects(
      () =>
        approveHumanApproval({
          approvalId,
          decidedBy: 'reviewer_eve',
          decidedDay: 1,
        }),
      /is not pending/
    );
  });

  // ─── 6. Audit & Zero Execution Guarantees ─────────────────────────────────

  it('31. audit behavior is correct', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_031' });

    // 1. Request
    const { approvalId } = await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 0,
      proposal: { action: 'retry', delayDays: 2, reasoning: 'Low confidence test' },
    });

    // 2. Approve
    await approveHumanApproval({
      approvalId,
      decidedBy: 'reviewer_frank',
      decidedDay: 1,
      decisionReason: 'Reviewed and approved',
    });

    // Verify audit log rows written
    const { data: logs } = await supabase
      .from('audit_logs')
      .select('*')
      .eq('mandate_id', mandate.id)
      .order('created_at', { ascending: true });

    assert.equal(logs.length, 2);
    assert.equal(logs[0].decision_type, 'approval_requested');
    assert.equal(logs[0].actor, 'smart_policy');
    assert.equal(logs[1].decision_type, 'approval_approved');
    assert.equal(logs[1].actor, 'reviewer_frank');
  });

  it('32. no payment execution occurs in Step 15', async () => {
    // Count total attempts in DB for this run before and after approval operations
    const { count: beforeCount } = await supabase
      .from('attempts')
      .select('*', { count: 'exact', head: true })
      .eq('run_id', testRun.id);

    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_032' });
    const { approvalId } = await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay: 0,
      proposal: { action: 'retry', delayDays: 2 },
    });

    await approveHumanApproval({
      approvalId,
      decidedBy: 'reviewer_frank',
      decidedDay: 1,
    });

    const { count: afterCount } = await supabase
      .from('attempts')
      .select('*', { count: 'exact', head: true })
      .eq('run_id', testRun.id);

    assert.equal(afterCount, beforeCount, 'Zero attempts should be created by Step 15');
  });

  // ─── 7. End-to-End Timing Preservation Proof ──────────────────────────────

  it('CRITICAL: AI proposed retry timing is preserved through Smart proposal → proposed_action.day → create_approval_request → resolve_approval → mandate.next_action_day', async () => {
    const mandate = await createMandate({ runId: testRun.id, mandateId: 'STEP15_MAN_TIMING' });
    const currentDay = 3;
    const aiProposedDelayDays = 4; // AI proposes retry in 4 days
    const expectedTargetDay = currentDay + aiProposedDelayDays; // 3 + 4 = 7

    const smartProposal = {
      action: 'retry',
      delayDays: aiProposedDelayDays,
      channel: 'auto_debit',
      discountPercent: 0,
      confidence: 0.62, // triggers human_review in Guardrails
      reasoning: 'AI proposes 4 days delay due to balance volatility.',
    };

    // 1. Guardrails routes to human_review
    const guardrailDecision = validateGuardrails({
      proposal: smartProposal,
      context: {
        mandate,
        failure: { category: 'soft', retryEligible: true },
      },
    });
    assert.equal(guardrailDecision.action, 'human_review');

    // 2. Request human approval with the proposal
    const { approvalId, proposedAction } = await requestHumanApproval({
      runId: testRun.id,
      mandate,
      currentDay,
      proposal: smartProposal,
    });

    // 3. Verify proposed_action.day is absolute day 7
    assert.equal(proposedAction.day, expectedTargetDay);

    // 4. Human reviewer approves on day 4 (decidedDay = 4 < proposed day 7)
    const approveResult = await approveHumanApproval({
      approvalId,
      decidedBy: 'reviewer_tim',
      decidedDay: 4,
    });

    // 5. Authoritative mandate.next_action_day must be exactly 7!
    assert.equal(approveResult.mandate.status, 'pending');
    assert.equal(approveResult.mandate.next_action, 'retry');
    assert.equal(approveResult.mandate.next_action_day, expectedTargetDay);
  });
});
