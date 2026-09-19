// tests/step21.test.js
//
// Phase 4 — API Hardening Tests
//
// Covers:
//   1. Rate limiting returns 429 after configured threshold
//   2. Valid POST /api/simulations body is accepted (not rejected with 400)
//   3. Invalid POST bodies return 400 with { error: string }
//   4. Manual Razorpay order route rejects x-automated-batch: 1 with 403
//   5. Webhook signature verification is unchanged (missing sig → 400)
//   6. Invalid POST /api/approvals body returns 400
//   7. Structural isolation: simulation runner files have no reference to razorpayOrder
//
// Testing rules:
//   - Tests 1 uses a custom Express app with a tight rate limit (max=2).
//   - Tests 2-6 use the main app from server.js (rate limit = 10 000 in non-prod).
//   - No simulation core is modified or committed.
//   - No existing test assertions are weakened or skipped.

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import http from 'node:http';
import express from 'express';
import { app } from '../server.js';
import { createLimiter } from '../src/middleware/rateLimiter.js';

// ─────────────────────────────────────────────────────────────────────────────

describe('Step 21 — Phase 4: API Hardening', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  // ── 1. Rate limiting returns 429 after threshold ──────────────────────────
  it('1. Rate limiting returns 429 after configured threshold', async () => {
    // Create an isolated test app with a tight limit of 2 requests.
    const testApp = express();
    const tightLimiter = createLimiter({ windowMs: 60_000, max: 2 });
    testApp.use('/api', tightLimiter);
    testApp.get('/api/ping', (_req, res) => res.json({ ok: true }));

    const ts = http.createServer(testApp);
    await new Promise((r) => ts.listen(0, r));
    const tUrl = `http://127.0.0.1:${ts.address().port}/api/ping`;

    // Requests 1 and 2 → 200
    const r1 = await fetch(tUrl);
    assert.equal(r1.status, 200, 'First request must succeed');

    const r2 = await fetch(tUrl);
    assert.equal(r2.status, 200, 'Second request must succeed');

    // Request 3 → 429 (limit exceeded)
    const r3 = await fetch(tUrl);
    assert.equal(r3.status, 429, 'Third request must be rate-limited (429)');
    const body = await r3.json();
    assert.ok(body.error && typeof body.error === 'string',
      'Rate limit response must contain { error: string }');

    await new Promise((r) => ts.close(r));
  });

  // ── 2. Valid POST body is accepted (not rejected as 400) ──────────────────
  it('2. Valid POST /api/simulations body is accepted (not rejected with 400)', async () => {
    const res = await fetch(`${baseUrl}/api/simulations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seed: 42001, mandateCount: 2, maxDays: 3 }),
    });
    // Valid body must never be rejected for validation reasons (400).
    // May be 201 (success) or 5xx (transient DB unavailability in CI).
    assert.notEqual(res.status, 400,
      'Valid body must not produce a 400 validation rejection');
  });

  // ── 3. Invalid POST bodies return 400 ─────────────────────────────────────
  it('3. Invalid POST /api/simulations bodies return 400', async () => {
    async function post400(body) {
      const res = await fetch(`${baseUrl}/api/simulations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, `Expected 400 for body: ${JSON.stringify(body)}`);
      const json = await res.json();
      assert.ok(json.error && typeof json.error === 'string',
        'Response must contain { error: string }');
    }

    await post400({});                                        // all fields missing
    await post400({ mandateCount: 5, maxDays: 7 });           // seed missing
    await post400({ seed: 'bad', mandateCount: 5, maxDays: 7 }); // seed not a number
    await post400({ seed: 1, mandateCount: 0, maxDays: 7 }); // mandateCount < 1
    await post400({ seed: 1, mandateCount: 5, maxDays: 0 }); // maxDays < 1
    await post400({ seed: 1, mandateCount: 5, maxDays: 400 }); // maxDays > 365
  });

  // ── 4. Manual order route rejects automated-batch header with 403 ─────────
  it('4. Manual Razorpay order route rejects x-automated-batch: 1 with 403', async () => {
    const res = await fetch(`${baseUrl}/api/v1/razorpay/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-automated-batch': '1',
      },
      body: JSON.stringify({ mandateId: '00000000-0000-0000-0000-000000000000', currency: 'INR' }),
    });
    assert.equal(res.status, 403,
      'Automated-batch header must be rejected with 403');
    const body = await res.json();
    assert.ok(body.error && typeof body.error === 'string',
      'Response must contain { error: string }');
    assert.ok(body.disclosure,
      'Response must include the mandatory disclosure string');
  });

  // ── 5. Webhook signature verification still intact ────────────────────────
  it('5. Webhook: missing X-Razorpay-Signature → 400 (Phase 3 verification intact)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/webhooks/razorpay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'payment.captured' }),
    });
    assert.equal(res.status, 400,
      'Missing signature header must still return 400');
    const body = await res.json();
    assert.ok(body.error && typeof body.error === 'string');
  });

  // ── 6. Invalid POST /api/approvals body returns 400 ───────────────────────
  it('6. Invalid POST /api/approvals/:id/resolve body returns 400', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';

    async function approvalPost400(body) {
      const res = await fetch(`${baseUrl}/api/approvals/${fakeId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      // Must be 400 (validation) not 404/500 for bad bodies
      assert.equal(res.status, 400,
        `Expected 400 for body: ${JSON.stringify(body)}`);
      const json = await res.json();
      assert.ok(json.error && typeof json.error === 'string',
        'Response must contain { error: string }');
    }

    await approvalPost400({});                                        // all missing
    await approvalPost400({ decision: 'bad', decidedBy: 'op', decidedDay: 1 }); // bad enum
    await approvalPost400({ decision: 'approved', decidedDay: 1 });  // decidedBy missing
    await approvalPost400({ decision: 'approved', decidedBy: 'op', decidedDay: -1 }); // negative day
  });

  // ── 7. Structural isolation: simulation files have no razorpayOrder import ─
  it('7. Structural isolation: simulation runner files do not reference razorpayOrder', async () => {
    const { readFile } = await import('node:fs/promises');
    const base = new URL('../src/', import.meta.url);

    const filesToCheck = [
      'recovery/recoveryRunner.js',
      'recovery/recoveryEngine.js',
      'recovery/smartPolicy.js',
      'recovery/controlPolicy.js',
      'recovery/baselinePolicy.js',
      'simulators/paymentSimulator.js',
    ];

    for (const rel of filesToCheck) {
      let content;
      try {
        content = await readFile(new URL(rel, base), 'utf8');
      } catch {
        continue; // file doesn't exist in this project variant — skip
      }
      assert.ok(
        !content.includes('razorpayOrder'),
        `${rel} must not import or reference razorpayOrder (structural isolation violated)`
      );
    }
  });
});
