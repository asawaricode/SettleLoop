// tests/step24.test.js
//
// Phase 8 — Decision Replay Tests
//
// Covers:
//   1. GET /api/mandates/:id/replay returns 200 with correct envelope fields.
//   2. Timeline begins with initial_state and ends with state_transition.
//   3. Timeline events are ordered chronologically.
//   4. Attempt events appear in ascending attempt_number order.
//   5. Unknown mandate ID returns 404.
//   6. Empty mandate ID returns 400 or 404.
//   7. Smart-arm mandate with audit logs produces ai_proposal and guardrail_evaluation events.
//   8. Control-arm mandate has no ai_proposal or guardrail_evaluation events.
//   9. Rule 4 transparency: ai_proposal events include NON-TRIGGERING confidenceNote.
//  10. Replay is strictly read-only — row counts unchanged.
//  11. Two different mandates produce different timelines.
//  12. Existing GET /api/mandates/:id/trace contract is completely unchanged.
//

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import http from 'node:http';
import { supabase } from '../src/config/supabase.js';
import { generateSyntheticData } from '../src/generators/syntheticDataGenerator.js';
import { runAllRecovery } from '../src/recovery/recoveryRunner.js';
import { app } from '../server.js';

describe('Step 24 — Decision Replay', () => {
  let server;
  let baseUrl;
  let testRunId;
  let testMandateIds = [];
  let mandateAId;
  let mandateBId;
  let mandateCId;
  let mandateDId;
  let mandateEId;

  async function countRows(table) {
    const { count } = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true })
      .eq('run_id', testRunId);
    return count ?? 0;
  }

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const gen = await generateSyntheticData({
      seed: 8801,
      mandateCount: 3,
      maxDays: 5,
    });
    testRunId = gen.simulationRunId;
    testMandateIds = gen.mandateIds;
    await runAllRecovery({ runId: testRunId });

    // A. Control with successful initial attempt (no AI proposal)
    const { data: mA } = await supabase.from('mandates').insert({
      run_id: testRunId,
      mandate_id: 'M-TEST-A',
      amount: 1000,
      income_day_of_month: 5,
      balance_volatility: 0.1,
      contact_consent: true,
      experiment_arm: 'control',
      status: 'recovered',
      attempts_used: 1,
      first_due_day: 1,
      next_action: 'none',
      next_action_day: null,
      terminal_reason: 'payment_success',
      created_day: 0,
    }).select('id').single();
    mandateAId = mA.id;
    await supabase.from('attempts').insert({
      run_id: testRunId,
      mandate_id: mandateAId,
      attempt_number: 1,
      scheduled_day: 1,
      executed_day: 1,
      outcome: 'success',
      retry_eligible: false,
      idempotency_key: `test:${testRunId}:${mandateAId}:1`,
    });

    // B. Baseline with successful initial attempt (no AI proposal)
    const { data: mB } = await supabase.from('mandates').insert({
      run_id: testRunId,
      mandate_id: 'M-TEST-B',
      amount: 1200,
      income_day_of_month: 5,
      balance_volatility: 0.1,
      contact_consent: true,
      experiment_arm: 'baseline',
      status: 'recovered',
      attempts_used: 1,
      first_due_day: 1,
      next_action: 'none',
      next_action_day: null,
      terminal_reason: 'payment_success',
      created_day: 0,
    }).select('id').single();
    mandateBId = mB.id;
    await supabase.from('attempts').insert({
      run_id: testRunId,
      mandate_id: mandateBId,
      attempt_number: 1,
      scheduled_day: 1,
      executed_day: 1,
      outcome: 'success',
      retry_eligible: false,
      idempotency_key: `test:${testRunId}:${mandateBId}:1`,
    });

    // C. Smart with successful initial attempt and no AI proposal
    const { data: mC } = await supabase.from('mandates').insert({
      run_id: testRunId,
      mandate_id: 'M-TEST-C',
      amount: 1500,
      income_day_of_month: 5,
      balance_volatility: 0.1,
      contact_consent: true,
      experiment_arm: 'smart',
      status: 'recovered',
      attempts_used: 1,
      first_due_day: 1,
      next_action: 'none',
      next_action_day: null,
      terminal_reason: 'payment_success',
      created_day: 0,
    }).select('id').single();
    mandateCId = mC.id;
    await supabase.from('attempts').insert({
      run_id: testRunId,
      mandate_id: mandateCId,
      attempt_number: 1,
      scheduled_day: 1,
      executed_day: 1,
      outcome: 'success',
      retry_eligible: false,
      idempotency_key: `test:${testRunId}:${mandateCId}:1`,
    });

    // D. Smart with actual AI/fallback proposal audit record
    const { data: mD } = await supabase.from('mandates').insert({
      run_id: testRunId,
      mandate_id: 'M-TEST-D',
      amount: 2000,
      income_day_of_month: 10,
      balance_volatility: 0.5,
      contact_consent: true,
      experiment_arm: 'smart',
      status: 'pending',
      attempts_used: 1,
      first_due_day: 1,
      next_action: 'retry',
      next_action_day: 4,
      created_day: 0,
    }).select('id').single();
    mandateDId = mD.id;
    const { data: attD } = await supabase.from('attempts').insert({
      run_id: testRunId,
      mandate_id: mandateDId,
      attempt_number: 1,
      scheduled_day: 1,
      executed_day: 1,
      outcome: 'failure',
      decline_category: 'soft',
      decline_code: 'insufficient_funds',
      retry_eligible: true,
      idempotency_key: `test:${testRunId}:${mandateDId}:1`,
    }).select('id').single();
    await supabase.from('audit_logs').insert([
      {
        run_id: testRunId,
        mandate_id: mandateDId,
        attempt_id: attD.id,
        day: 1,
        actor: 'smart_agent',
        decision_type: 'ai_proposal',
        input: { category: 'soft', retryEligible: true },
        output: { action: 'retry', retryDelayDays: 3, source: 'ai' },
        reasoning: 'AI recommends retry in 3 days',
      },
      {
        run_id: testRunId,
        mandate_id: mandateDId,
        attempt_id: attD.id,
        day: 1,
        actor: 'guardrails',
        decision_type: 'guardrail_decision',
        input: { proposedAction: 'retry', reasons: ['Within limits'] },
        output: { allowed: true, finalAction: 'retry' },
        reasoning: 'Guardrails approved retry proposal',
      },
    ]);

    // E. Mandate with no optional audit/approval records
    const { data: mE } = await supabase.from('mandates').insert({
      run_id: testRunId,
      mandate_id: 'M-TEST-E',
      amount: 500,
      income_day_of_month: 1,
      balance_volatility: 0.1,
      contact_consent: false,
      experiment_arm: 'control',
      status: 'pending',
      attempts_used: 0,
      first_due_day: 1,
      next_action: 'retry',
      next_action_day: 1,
      created_day: 0,
    }).select('id').single();
    mandateEId = mE.id;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (testRunId) {
      try {
        await supabase.from('audit_logs').delete().eq('run_id', testRunId);
        await supabase.from('approval_requests').delete().eq('run_id', testRunId);
        await supabase.from('attempts').delete().eq('run_id', testRunId);
        await supabase.from('mandates').delete().eq('run_id', testRunId);
        await supabase.from('simulation_runs').delete().eq('id', testRunId);
      } catch (_) {}
    }
  });

  it('1. GET /api/mandates/:id/replay returns 200 with required envelope fields', async () => {
    const id = testMandateIds[0];
    const res = await fetch(`${baseUrl}/api/mandates/${encodeURIComponent(id)}/replay`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mandateId, id);
    assert.ok(typeof body.arm === 'string');
    assert.ok(typeof body.status === 'string');
    assert.ok(typeof body.attemptsUsed === 'number');
    assert.ok(Array.isArray(body.timeline));
    assert.ok(body.timeline.length >= 2);
  });

  it('2. Timeline begins with initial_state and ends with state_transition', async () => {
    const id = testMandateIds[0];
    const res = await fetch(`${baseUrl}/api/mandates/${encodeURIComponent(id)}/replay`);
    const { timeline } = await res.json();
    assert.equal(timeline[0].eventType, 'initial_state');
    assert.equal(timeline[timeline.length - 1].eventType, 'state_transition');
  });

  it('3. Timeline events are ordered chronologically (day ascending, nulls last)', async () => {
    const id = testMandateIds[0];
    const res = await fetch(`${baseUrl}/api/mandates/${encodeURIComponent(id)}/replay`);
    const { timeline } = await res.json();
    const middle = timeline.slice(1, -1);
    for (let i = 1; i < middle.length; i++) {
      const prev = middle[i - 1].day ?? Infinity;
      const curr = middle[i].day ?? Infinity;
      assert.ok(curr >= prev, `Day ${prev} then ${curr} at index ${i} violates chronological order`);
    }
  });

  it('4. Attempt events appear in ascending attempt_number order', async () => {
    const id = testMandateIds[0];
    const res = await fetch(`${baseUrl}/api/mandates/${encodeURIComponent(id)}/replay`);
    const { timeline } = await res.json();
    const attempts = timeline.filter(e => e.eventType === 'attempt');
    for (let i = 1; i < attempts.length; i++) {
      assert.ok(
        attempts[i].data.attemptNumber > attempts[i - 1].data.attemptNumber,
        'Attempt events must be ascending by attemptNumber'
      );
    }
  });

  it('5. Unknown mandate ID returns 404', async () => {
    const res = await fetch(`${baseUrl}/api/mandates/00000000-0000-0000-0000-000000000000/replay`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error && typeof body.error === 'string');
  });

  it('6. Empty / whitespace mandate ID returns 400 or 404', async () => {
    const res = await fetch(`${baseUrl}/api/mandates/%20/replay`);
    assert.ok([400, 404].includes(res.status), `Expected 400 or 404, got ${res.status}`);
  });

  it('7. Smart-arm mandate with audit logs produces ai_proposal and guardrail_evaluation events', async () => {
    const { data: aiLogs } = await supabase
      .from('audit_logs')
      .select('mandate_id')
      .eq('run_id', testRunId)
      .eq('decision_type', 'ai_proposal')
      .limit(1);
    if (!aiLogs || aiLogs.length === 0) return; // no AI proposals in this run
    const smartId = aiLogs[0].mandate_id;
    const res = await fetch(`${baseUrl}/api/mandates/${encodeURIComponent(smartId)}/replay`);
    assert.equal(res.status, 200);
    const { timeline } = await res.json();
    const aiEvts = timeline.filter(e => e.eventType === 'ai_proposal');
    const grEvts = timeline.filter(e => e.eventType === 'guardrail_evaluation');
    assert.ok(aiEvts.length > 0, 'Must have at least one ai_proposal event');
    assert.ok(grEvts.length > 0, 'Must have at least one guardrail_evaluation event');
  });

  it('8. Control-arm mandate has no ai_proposal or guardrail_evaluation events', async () => {
    const { data: ctrlMandates } = await supabase
      .from('mandates')
      .select('id')
      .eq('run_id', testRunId)
      .eq('experiment_arm', 'control')
      .limit(1);
    if (!ctrlMandates || ctrlMandates.length === 0) return;
    const res = await fetch(`${baseUrl}/api/mandates/${encodeURIComponent(ctrlMandates[0].id)}/replay`);
    assert.equal(res.status, 200);
    const { arm, timeline } = await res.json();
    assert.equal(arm, 'control');
    assert.equal(timeline.filter(e => e.eventType === 'ai_proposal').length, 0);
    assert.equal(timeline.filter(e => e.eventType === 'guardrail_evaluation').length, 0);
  });

  it('9. ai_proposal events include Rule 4 confidenceNote with NON-TRIGGERING text', async () => {
    const { data: aiLogs } = await supabase
      .from('audit_logs')
      .select('mandate_id')
      .eq('run_id', testRunId)
      .eq('decision_type', 'ai_proposal')
      .limit(1);
    if (!aiLogs || aiLogs.length === 0) return;
    const res = await fetch(`${baseUrl}/api/mandates/${encodeURIComponent(aiLogs[0].mandate_id)}/replay`);
    assert.equal(res.status, 200);
    const { timeline } = await res.json();
    const aiEvts = timeline.filter(e => e.eventType === 'ai_proposal');
    if (aiEvts.length === 0) return;
    for (const evt of aiEvts) {
      assert.ok(typeof evt.data.confidenceNote === 'string', 'confidenceNote must be a string');
      assert.ok(
        evt.data.confidenceNote.includes('NON-TRIGGERING UNDER CURRENT CONFIGURATION'),
        'Must include NON-TRIGGERING UNDER CURRENT CONFIGURATION text'
      );
      assert.ok(
        evt.data.confidenceNote.includes('0.80'),
        'Must mention the deterministic 0.80 confidence assignment'
      );
    }
  });

  it('10. Replay endpoint does not insert, update, or delete any rows', async () => {
    const id = testMandateIds[0];
    const mBefore = await countRows('mandates');
    const aBefore = await countRows('attempts');
    const lBefore = await countRows('audit_logs');
    await (await fetch(`${baseUrl}/api/mandates/${encodeURIComponent(id)}/replay`)).json();
    assert.equal(await countRows('mandates'), mBefore, 'mandates row count must not change');
    assert.equal(await countRows('attempts'), aBefore, 'attempts row count must not change');
    assert.equal(await countRows('audit_logs'), lBefore, 'audit_logs row count must not change');
  });

  it('11. Two different mandates produce different replay responses', async () => {
    if (testMandateIds.length < 2) return;
    const [r1, r2] = await Promise.all([
      fetch(`${baseUrl}/api/mandates/${encodeURIComponent(testMandateIds[0])}/replay`),
      fetch(`${baseUrl}/api/mandates/${encodeURIComponent(testMandateIds[1])}/replay`),
    ]);
    const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
    assert.notEqual(b1.mandateId, b2.mandateId);
    assert.notEqual(JSON.stringify(b1), JSON.stringify(b2));
  });

  it('12. Existing GET /api/mandates/:id/trace contract is completely unchanged', async () => {
    const id = testMandateIds[0];
    const res = await fetch(`${baseUrl}/api/mandates/${encodeURIComponent(id)}/trace`);
    assert.equal(res.status, 200);
    const trace = await res.json();
    assert.equal(trace.mandateId, id);
    assert.ok(typeof trace.arm === 'string');
    assert.ok(typeof trace.status === 'string');
    assert.ok(typeof trace.finalAction === 'string');
    assert.ok('failureCategory' in trace);
    assert.ok('confidence' in trace);
    assert.ok('aiProposal' in trace);
    assert.ok('guardrailResult' in trace);
    assert.ok('humanApproval' in trace);
  });

  it('13. Scenario A: Control with successful initial attempt -> confidence N/A, no AI proposal, no guardrail evaluation', async () => {
    const res = await fetch(`${baseUrl}/api/mandates/${encodeURIComponent(mandateAId)}/replay`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.arm, 'control');
    assert.equal(body.status, 'recovered');
    assert.equal(body.confidence, 'N/A');
    assert.equal(body.aiProposal, null);
    assert.equal(body.guardrailResult, null);
    assert.equal(body.timeline.filter(e => e.eventType === 'ai_proposal').length, 0);
    assert.equal(body.timeline.filter(e => e.eventType === 'guardrail_evaluation').length, 0);
  });

  it('14. Scenario B: Baseline with successful initial attempt -> same semantics (confidence N/A, no AI proposal)', async () => {
    const res = await fetch(`${baseUrl}/api/mandates/${encodeURIComponent(mandateBId)}/replay`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.arm, 'baseline');
    assert.equal(body.status, 'recovered');
    assert.equal(body.confidence, 'N/A');
    assert.equal(body.aiProposal, null);
    assert.equal(body.guardrailResult, null);
    assert.equal(body.timeline.filter(e => e.eventType === 'ai_proposal').length, 0);
    assert.equal(body.timeline.filter(e => e.eventType === 'guardrail_evaluation').length, 0);
  });

  it('15. Scenario C: Smart with successful initial attempt and no AI proposal -> confidence N/A, no AI proposal', async () => {
    const res = await fetch(`${baseUrl}/api/mandates/${encodeURIComponent(mandateCId)}/replay`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.arm, 'smart');
    assert.equal(body.status, 'recovered');
    assert.equal(body.confidence, 'N/A');
    assert.equal(body.aiProposal, null);
    assert.equal(body.timeline.filter(e => e.eventType === 'ai_proposal').length, 0);
  });

  it('16. Scenario D: Smart with actual AI/fallback audit record -> confidence 80%, proposal and guardrail recorded', async () => {
    const res = await fetch(`${baseUrl}/api/mandates/${encodeURIComponent(mandateDId)}/replay`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.arm, 'smart');
    assert.equal(body.confidence, '80%');
    assert.ok(body.aiProposal);
    assert.equal(body.aiProposal.action, 'retry');
    assert.equal(body.aiProposal.retryDelayDays, 3);
    assert.ok(body.guardrailResult);
    assert.equal(body.guardrailResult.allowed, true);
    const aiEvts = body.timeline.filter(e => e.eventType === 'ai_proposal');
    const grEvts = body.timeline.filter(e => e.eventType === 'guardrail_evaluation');
    assert.equal(aiEvts.length, 1);
    assert.equal(grEvts.length, 1);
    assert.equal(aiEvts[0].data.action, 'retry');
    assert.equal(grEvts[0].data.result, 'PASSED');
  });

  it('17. Scenario E: Mandate with no optional audit/approval records -> replay works, no fabricated events', async () => {
    const res = await fetch(`${baseUrl}/api/mandates/${encodeURIComponent(mandateEId)}/replay`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mandateId, mandateEId);
    assert.equal(body.confidence, 'N/A');
    assert.equal(body.aiProposal, null);
    assert.equal(body.guardrailResult, null);
    assert.equal(body.humanApproval, null);
    assert.equal(body.timeline.length, 2);
    assert.equal(body.timeline[0].eventType, 'initial_state');
    assert.equal(body.timeline[1].eventType, 'state_transition');
    assert.equal(body.timeline.filter(e => ['ai_proposal', 'guardrail_evaluation', 'approval_event'].includes(e.eventType)).length, 0);
  });
});
