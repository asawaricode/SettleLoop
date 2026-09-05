import assert from 'node:assert/strict';
import test, { describe, it, before, after } from 'node:test';
import http from 'node:http';
import { supabase } from '../src/config/supabase.js';
import { generateSyntheticData } from '../src/generators/syntheticDataGenerator.js';
import { app } from '../server.js';

describe('Step 17 — Express API + Dashboard Backend API', () => {
  let server;
  let baseUrl;
  const createdRunIds = [];

  before(async () => {
    // Start ephemeral server on random free port (port 0)
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    // Close server
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }

    // Clean up all simulation runs created during tests
    for (const runId of createdRunIds) {
      try {
        await supabase.from('simulation_runs').delete().eq('id', runId);
      } catch (e) {
        // ignore cleanup error
      }
    }
  });

  // ── 1. GET /api/health → 200 ──────────────────────────────────────────────
  it('1. GET /api/health → 200', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { status: 'ok' });
  });

  // ── 2. Invalid POST /api/simulations → 400 ────────────────────────────────
  it('2. Invalid POST /api/simulations → 400', async () => {
    // Missing seed
    const res1 = await fetch(`${baseUrl}/api/simulations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mandateCount: 10, maxDays: 10 }),
    });
    assert.equal(res1.status, 400);
    const body1 = await res1.json();
    assert.ok(body1.error && typeof body1.error === 'string');

    // Invalid seed (NaN / infinite)
    const res2 = await fetch(`${baseUrl}/api/simulations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seed: 'not-a-number', mandateCount: 10, maxDays: 10 }),
    });
    assert.equal(res2.status, 400);
    const body2 = await res2.json();
    assert.ok(body2.error);

    // Invalid mandateCount (negative or zero or non-integer)
    const res3 = await fetch(`${baseUrl}/api/simulations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seed: 42, mandateCount: -5, maxDays: 10 }),
    });
    assert.equal(res3.status, 400);
    const body3 = await res3.json();
    assert.ok(body3.error);

    // Invalid maxDays (zero or negative)
    const res4 = await fetch(`${baseUrl}/api/simulations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seed: 42, mandateCount: 10, maxDays: 0 }),
    });
    assert.equal(res4.status, 400);
    const body4 = await res4.json();
    assert.ok(body4.error);

    // Empty body
    const res5 = await fetch(`${baseUrl}/api/simulations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res5.status, 400);
    const body5 = await res5.json();
    assert.ok(body5.error);
  });

  // ── 3. Valid POST /api/simulations creates a run ──────────────────────────
  let createdRunId;
  it('3. Valid POST /api/simulations creates a run', async () => {
    const res = await fetch(`${baseUrl}/api/simulations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seed: 4242,
        mandateCount: 6,
        maxDays: 8,
      }),
    });

    assert.ok(res.status === 200 || res.status === 201, `Expected 200 or 201, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.runId && typeof body.runId === 'string');
    assert.ok(Array.isArray(body.mandateIds));
    assert.equal(body.mandateIds.length, 6);

    createdRunId = body.runId;
    createdRunIds.push(createdRunId);
  });

  // ── 4. Created run can be fetched ─────────────────────────────────────────
  it('4. Created run can be fetched', async () => {
    assert.ok(createdRunId, 'Previous test must have created a runId');

    const res = await fetch(`${baseUrl}/api/simulations/${createdRunId}`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.runId, createdRunId);
    assert.equal(body.currentDay, 0);
    assert.equal(body.maxDays, 8);
    assert.equal(body.status, 'running');
  });

  // ── 5. Unknown run → 404 ──────────────────────────────────────────────────
  it('5. Unknown run → 404', async () => {
    // Unknown UUID
    const unknownUuid = '00000000-0000-0000-0000-000000000000';
    const res1 = await fetch(`${baseUrl}/api/simulations/${unknownUuid}`);
    assert.equal(res1.status, 404);
    const body1 = await res1.json();
    assert.equal(body1.error, 'Simulation run not found');

    // Malformed runId string
    const res2 = await fetch(`${baseUrl}/api/simulations/not-a-valid-uuid`);
    assert.equal(res2.status, 404);
    const body2 = await res2.json();
    assert.equal(body2.error, 'Simulation run not found');
  });

  // ── 6. POST /run uses the existing recovery runner ────────────────────────
  let runExecutionResponse;
  it('6. POST /run uses the existing recovery runner', async () => {
    assert.ok(createdRunId, 'Run ID must exist');

    const res = await fetch(`${baseUrl}/api/simulations/${createdRunId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    assert.equal(res.status, 200);
    runExecutionResponse = await res.json();

    assert.equal(runExecutionResponse.runId, createdRunId);
    assert.ok(typeof runExecutionResponse.processedCount === 'number');
    assert.ok(typeof runExecutionResponse.currentDay === 'number');
    assert.ok(runExecutionResponse.results && typeof runExecutionResponse.results === 'object');
    assert.ok(Array.isArray(runExecutionResponse.results.daysEvaluated));
    assert.ok(typeof runExecutionResponse.results.terminatedReason === 'string');

    // Verify Smart arm mandates were NOT touched (preserving runner invariant)
    const { data: smartMandates, error: sErr } = await supabase
      .from('mandates')
      .select('id, experiment_arm, attempts_used')
      .eq('run_id', createdRunId)
      .eq('experiment_arm', 'smart');

    assert.ifError(sErr);
    assert.ok(smartMandates.length > 0, 'Should have smart mandates generated');
    for (const sm of smartMandates) {
      assert.equal(sm.attempts_used, 0, 'Smart mandates must remain untouched');
    }
  });

  // ── 7. /run uses persisted simulation clock ───────────────────────────────
  it('7. /run uses persisted simulation clock', async () => {
    assert.ok(createdRunId, 'Run ID must exist');

    // Query simulation_runs directly from DB to verify clock state was persisted
    const { data: dbRun, error: dbErr } = await supabase
      .from('simulation_runs')
      .select('id, current_day, max_days, status')
      .eq('id', createdRunId)
      .single();

    assert.ifError(dbErr);
    assert.equal(dbRun.current_day, runExecutionResponse.currentDay);
    assert.equal(dbRun.current_day, runExecutionResponse.results.finalDay);
  });

  // ── 8. /run does not implement a separate recovery loop ───────────────────
  it('8. /run does not implement a separate recovery loop', async () => {
    assert.ok(createdRunId, 'Run ID must exist');

    // Re-running a completed simulation uses existing runner logic which detects no further work
    const res = await fetch(`${baseUrl}/api/simulations/${createdRunId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.runId, createdRunId);
    assert.equal(body.processedCount, 0); // No new work processed
    assert.ok(
      body.results.terminatedReason === 'reached_max_days' ||
      body.results.terminatedReason === 'no_future_actions_within_window'
    );
  });

  // ── 9. Metrics endpoint returns Step 16 metrics ───────────────────────────
  it('9. Metrics endpoint returns Step 16 metrics', async () => {
    assert.ok(createdRunId, 'Run ID must exist');

    const res = await fetch(`${baseUrl}/api/simulations/${createdRunId}/metrics`);
    assert.equal(res.status, 200);
    const metrics = await res.json();

    assert.equal(metrics.runId, createdRunId);
    assert.ok(metrics.arms, 'Must contain arms');
    assert.ok(metrics.arms.control, 'Must contain control arm metrics');
    assert.ok(metrics.arms.baseline, 'Must contain baseline arm metrics');
    assert.ok(metrics.arms.smart, 'Must contain smart arm metrics');

    // Verify arm metric fields
    for (const arm of ['control', 'baseline', 'smart']) {
      assert.ok(typeof metrics.arms[arm].mandateCount === 'number');
      assert.ok(typeof metrics.arms[arm].recoveredCount === 'number');
      assert.ok(typeof metrics.arms[arm].recoveryRate === 'number');
      assert.ok(typeof metrics.arms[arm].totalAmount === 'number');
      assert.ok(typeof metrics.arms[arm].recoveredAmount === 'number');
      assert.ok(typeof metrics.arms[arm].attemptsTotal === 'number');
    }

    // Verify lift and safety fields
    assert.ok(metrics.lift);
    assert.ok('vsControl' in metrics.lift);
    assert.ok('vsBaseline' in metrics.lift);
    assert.ok(metrics.safety);
    assert.ok(typeof metrics.safety.safe === 'boolean');
    assert.ok(typeof metrics.safety.totalViolations === 'number');
  });

  // ── 10. Unknown metrics run → 404 ─────────────────────────────────────────
  it('10. Unknown metrics run → 404', async () => {
    const unknownUuid = '00000000-0000-0000-0000-000000000000';
    const res = await fetch(`${baseUrl}/api/simulations/${unknownUuid}/metrics`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'Simulation run not found');

    // Also verify malformed string
    const res2 = await fetch(`${baseUrl}/api/simulations/invalid-uuid/metrics`);
    assert.equal(res2.status, 404);
    const body2 = await res2.json();
    assert.equal(body2.error, 'Simulation run not found');
  });

  // ── 11. API responses do not expose secrets ───────────────────────────────
  it('11. API responses do not expose secrets', async () => {
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;

    const endpointsToTest = [
      { url: `${baseUrl}/api/health`, method: 'GET' },
      { url: `${baseUrl}/api/simulations/not-found-id`, method: 'GET' },
      { url: `${baseUrl}/api/simulations/not-found-id/run`, method: 'POST' },
      { url: `${baseUrl}/api/simulations/not-found-id/metrics`, method: 'GET' },
      { url: `${baseUrl}/api/simulations`, method: 'POST', body: JSON.stringify({ seed: 'bad' }) },
    ];

    for (const ep of endpointsToTest) {
      const res = await fetch(ep.url, {
        method: ep.method,
        headers: ep.body ? { 'Content-Type': 'application/json' } : undefined,
        body: ep.body,
      });

      const text = await res.text();

      if (secretKey) {
        assert.ok(!text.includes(secretKey), `Secret key exposed in response from ${ep.url}`);
      }
      if (geminiKey) {
        assert.ok(!text.includes(geminiKey), `Gemini key exposed in response from ${ep.url}`);
      }
      assert.ok(!text.includes('stack'), `Stack trace exposed in response from ${ep.url}`);
      assert.ok(!text.includes('password'), `Password exposed in response from ${ep.url}`);
    }
  });

  // ── 12. maxDays is correctly passed to the generator if supported ─────────
  it('12. maxDays is correctly passed to the generator if supported', async () => {
    const res = await fetch(`${baseUrl}/api/simulations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seed: 7777,
        mandateCount: 3,
        maxDays: 14,
      }),
    });

    assert.ok(res.status === 200 || res.status === 201);
    const body = await res.json();
    createdRunIds.push(body.runId);

    const { data: run, error } = await supabase
      .from('simulation_runs')
      .select('max_days')
      .eq('id', body.runId)
      .single();

    assert.ifError(error);
    assert.equal(run.max_days, 14, 'max_days should be 14 as requested');

    // Also test direct call to generator
    const direct = await generateSyntheticData({
      seed: 8888,
      mandateCount: 3,
      maxDays: 21,
    });
    createdRunIds.push(direct.simulationRunId);

    const { data: directRun, error: directErr } = await supabase
      .from('simulation_runs')
      .select('max_days')
      .eq('id', direct.simulationRunId)
      .single();

    assert.ifError(directErr);
    assert.equal(directRun.max_days, 21, 'max_days should be 21 from direct call');
  });

  // ── 13. If generator required minimal maxDays extension, default is kept ──
  it('13. If generator required minimal maxDays extension, verify default is unchanged', async () => {
    // Calling generateSyntheticData without maxDays should default to 10
    const result = await generateSyntheticData({
      seed: 9999,
      mandateCount: 3,
    });
    createdRunIds.push(result.simulationRunId);

    const { data: run, error } = await supabase
      .from('simulation_runs')
      .select('max_days')
      .eq('id', result.simulationRunId)
      .single();

    assert.ifError(error);
    assert.equal(run.max_days, 10, 'Default max_days must remain 10');
  });
});
