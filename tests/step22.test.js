// tests/step22.test.js
//
// Phase 6 — Dashboard UX Corrections Tests
//
// Covers:
//   1. GET /api/simulations/:runId/eligible-mandates returns only eligible Smart mandates:
//      - experiment_arm === 'smart'
//      - next_action === 'retry'
//      - attempts_used < 4
//      - amount > 0
//      - belongs to current runId
//   2. GET /api/simulations/:runId/eligible-mandates excludes Control and Baseline mandates
//   3. Unknown runId for eligible-mandates returns 404 or empty list
//   4. GET /api/mandates/:id/trace returns authoritative trace for a mandate
//   5. Invalid mandate ID for trace returns 404
//

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import http from 'node:http';
import { supabase } from '../src/config/supabase.js';
import { generateSyntheticData } from '../src/generators/syntheticDataGenerator.js';
import { requestHumanApproval } from '../src/recovery/humanApproval.js';
import { app } from '../server.js';

describe('Step 22 — Phase 6: Dashboard UX Corrections', () => {
  let server;
  let baseUrl;
  let testRunId;
  let testMandateIds = [];

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    // Create a deterministic small test simulation
    const gen = await generateSyntheticData({
      seed: 9901,
      mandateCount: 6,
      maxDays: 5,
    });
    testRunId = gen.simulationRunId;
    testMandateIds = gen.mandateIds;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));

    if (testRunId) {
      try {
        await supabase.from('mandates').delete().eq('run_id', testRunId);
        await supabase.from('simulation_runs').delete().eq('id', testRunId);
      } catch (_) {}
    }
  });

  // ── 1. GET /api/simulations/:runId/eligible-mandates ───────────────────────
  it('1. Returns only eligible Smart mandates for the current run', async () => {
    const res = await fetch(`${baseUrl}/api/simulations/${testRunId}/eligible-mandates`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.runId, testRunId);
    assert.ok(Array.isArray(body.mandates), 'mandates must be an array');
    assert.ok(body.mandates.length > 0, 'should have eligible smart mandates');

    for (const m of body.mandates) {
      assert.equal(m.experiment_arm, 'smart', 'All eligible mandates must have experiment_arm = smart');
      assert.equal(m.next_action, 'retry', 'All eligible mandates must have next_action = retry');
      assert.ok(m.attempts_used < 4, 'attempts_used must be < 4');
      assert.ok(m.amount > 0, 'amount must be > 0');
    }
  });

  // ── 2. Excludes Control and Baseline mandates ─────────────────────────────
  it('2. Excludes Control and Baseline mandates completely', async () => {
    const res = await fetch(`${baseUrl}/api/simulations/${testRunId}/eligible-mandates`);
    assert.equal(res.status, 200);

    const body = await res.json();
    const returnedIds = new Set(body.mandates.map((m) => m.id));

    // Fetch all mandates in the run to check control/baseline arms
    const { data: allMandates } = await supabase
      .from('mandates')
      .select('id, experiment_arm')
      .eq('run_id', testRunId);

    const nonSmart = (allMandates || []).filter((m) => m.experiment_arm !== 'smart');
    assert.ok(nonSmart.length > 0, 'Run should have non-smart mandates');

    for (const ns of nonSmart) {
      assert.ok(
        !returnedIds.has(ns.id),
        `Mandate ${ns.id} (${ns.experiment_arm}) must NOT be present in eligible mandates`
      );
    }
  });

  // ── 3. Unknown or invalid runId returns 404 or empty ──────────────────────
  it('3. Unknown runId returns 404 or empty list', async () => {
    const fakeUuid = '00000000-0000-0000-0000-000000000000';
    const res = await fetch(`${baseUrl}/api/simulations/${fakeUuid}/eligible-mandates`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.mandates, []);
  });

  // ── 4. GET /api/mandates/:id/trace returns authoritative trace ─────────────
  it('4. GET /api/mandates/:id/trace returns authoritative trace for a mandate', async () => {
    const targetId = testMandateIds[0];
    const res = await fetch(`${baseUrl}/api/mandates/${targetId}/trace`);
    assert.equal(res.status, 200);

    const trace = await res.json();
    assert.equal(trace.mandateId, targetId);
    assert.ok(typeof trace.arm === 'string', 'trace must specify arm');
    assert.ok(typeof trace.status === 'string', 'trace must specify status');
    assert.ok(typeof trace.finalAction === 'string', 'trace must specify finalAction');
  });

  // ── 5. Unknown mandate ID returns 404 for trace ───────────────────────────
  it('5. Unknown mandate ID returns 404 for trace', async () => {
    const fakeUuid = '00000000-0000-0000-0000-000000000000';
    const res = await fetch(`${baseUrl}/api/mandates/${fakeUuid}/trace`);
    assert.equal(res.status, 404);
  });

  // ── 6. GET /api/approvals returns empty when no pending approvals exist ───
  it('6. GET /api/approvals returns empty list when run has no pending approvals', async () => {
    const res = await fetch(`${baseUrl}/api/approvals?runId=${testRunId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.approvals));
    assert.equal(body.approvals.length, 0, 'Newly created run should have 0 pending approvals');
  });

  // ── 7. Approval lifecycle: query -> resolve -> empty ──────────────────────
  it('7. Approval lifecycle: returns real pending approval and clears upon resolution', async () => {
    const { data: mandate } = await supabase
      .from('mandates')
      .select('*')
      .eq('id', testMandateIds[0])
      .single();

    const { approvalId } = await requestHumanApproval({
      mandate,
      runId: testRunId,
      currentDay: 1,
      proposal: { action: 'retry', delayDays: 2, confidence: 0.9 },
    });

    try {
      // 1. Query: must return the real pending approval
      const res1 = await fetch(`${baseUrl}/api/approvals?runId=${testRunId}`);
      assert.equal(res1.status, 200);
      const body1 = await res1.json();
      assert.equal(body1.approvals.length, 1);
      assert.equal(body1.approvals[0].id, approvalId);

      // 2. Resolve via existing endpoint
      const res2 = await fetch(`${baseUrl}/api/approvals/${approvalId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision: 'rejected',
          decidedBy: 'operator',
          decidedDay: 1,
          decisionReason: 'Test rejection',
        }),
      });
      assert.equal(res2.status, 200);
      const body2 = await res2.json();
      assert.equal(body2.decision, 'rejected');

      // 3. Query again: must now be empty
      const res3 = await fetch(`${baseUrl}/api/approvals?runId=${testRunId}`);
      assert.equal(res3.status, 200);
      const body3 = await res3.json();
      assert.equal(body3.approvals.length, 0, 'No pending approvals should remain after resolution');
    } finally {
      await supabase.from('approval_requests').delete().eq('id', approvalId);
    }
  });
});
