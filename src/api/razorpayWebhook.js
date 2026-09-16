// src/api/razorpayWebhook.js
//
// Phase 3 — A1: Real Inbound Razorpay Webhook Handler.
//
// Responsibilities:
//   - Receive POST /api/v1/webhooks/razorpay from Razorpay.
//   - Verify HMAC-SHA256 signature against the RAW request bytes BEFORE any JSON parsing.
//   - Use crypto.timingSafeEqual for constant-time signature comparison.
//   - Insert verified events into webhook_events (idempotent via unique event_id index).
//   - Write a corresponding audit_logs entry (run_id = null-equiv sentinel, not linked to simulation).
//   - Return 200 for duplicates without re-inserting or touching any simulation table.
//
// Hard Isolation Rules (NEVER violated by this module):
//   - Does NOT write to mandates.
//   - Does NOT write to attempts.
//   - Does NOT trigger Smart policy, retry scheduling, or payment execution.
//   - Does NOT modify simulation_runs.
//   - Does NOT modify experiment metrics.
//   - Does NOT send notifications.
//
// Explicitly does NOT:
//   - Import or call recoveryRunner, smartPolicy, controlPolicy, baselinePolicy.
//   - Import or call requestHumanApproval or scheduleRetry.
//   - Import or call generateSyntheticData.
//   - Install the Razorpay SDK.

import crypto from 'node:crypto';
import express from 'express';
import { supabase } from '../config/supabase.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal: HMAC-SHA256 signature verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifies the Razorpay webhook signature using HMAC-SHA256 + timingSafeEqual.
 *
 * Handles unequal-length signatures safely (returns false, never throws).
 *
 * @param {Buffer}  rawBody   - Exact raw request bytes (pre-JSON-parse).
 * @param {string}  signature - Value of X-Razorpay-Signature header.
 * @param {string}  secret    - RAZORPAY_WEBHOOK_SECRET value.
 * @returns {boolean}
 */
export function verifyRazorpaySignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;

  let sigBuf;
  let hmacBuf;

  try {
    hmacBuf = Buffer.from(
      crypto.createHmac('sha256', secret).update(rawBody).digest('hex'),
      'utf8'
    );
    sigBuf = Buffer.from(signature, 'utf8');
  } catch {
    return false;
  }

  // Constant-time comparison; handle unequal lengths without throwing.
  if (sigBuf.length !== hmacBuf.length) {
    // Still call timingSafeEqual on equal-length buffers to avoid timing leak.
    crypto.timingSafeEqual(hmacBuf, hmacBuf);
    return false;
  }

  return crypto.timingSafeEqual(hmacBuf, sigBuf);
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook route factory
//
// Returns an Express Router with:
//   POST /  (i.e. POST /api/v1/webhooks/razorpay when mounted)
//
// IMPORTANT: express.raw({ type: 'application/json' }) is applied as the FIRST
// route-level middleware so that rawBody is captured before any JSON parsing.
// ─────────────────────────────────────────────────────────────────────────────

const webhookRouter = express.Router();

webhookRouter.post(
  '/',
  // Step 1: Capture raw bytes BEFORE JSON parsing.
  express.raw({ type: 'application/json' }),

  async (req, res) => {
    // ── 1. Read required headers ────────────────────────────────────────────
    const signature = req.headers['x-razorpay-signature'];
    const eventId   = req.headers['x-razorpay-event-id'];

    if (!signature || typeof signature !== 'string' || signature.trim() === '') {
      return res.status(400).json({ error: 'Missing or empty X-Razorpay-Signature header' });
    }

    if (!eventId || typeof eventId !== 'string' || eventId.trim() === '') {
      return res.status(400).json({ error: 'Missing or empty x-razorpay-event-id header' });
    }

    // ── 2. Get webhook secret ───────────────────────────────────────────────
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      // Secret not configured — refuse processing; do not leak why.
      return res.status(503).json({ error: 'Webhook endpoint not configured' });
    }

    // ── 3. Verify signature against raw bytes ───────────────────────────────
    const rawBody = req.body; // Buffer (from express.raw)
    if (!Buffer.isBuffer(rawBody)) {
      return res.status(400).json({ error: 'Unexpected body format' });
    }

    const signatureValid = verifyRazorpaySignature(rawBody, signature.trim(), webhookSecret);
    if (!signatureValid) {
      return res.status(401).json({ error: 'Signature verification failed' });
    }

    // ── 4. Parse JSON only after successful verification ─────────────────────
    let eventPayload;
    try {
      eventPayload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    const eventType = eventPayload?.event ?? 'unknown';

    // ── 5. Idempotency: insert into webhook_events ───────────────────────────
    //    webhook_events has UNIQUE INDEX on event_id — duplicate insert returns
    //    a PostgreSQL unique-violation error (code 23505).
    const { data: inserted, error: insertErr } = await supabase
      .from('webhook_events')
      .insert({
        event_id:           eventId.trim(),
        event_type:         eventType,
        payload:            eventPayload,
        signature_verified: true,
      })
      .select('id')
      .single();

    if (insertErr) {
      // 23505 = unique_violation (duplicate event_id)
      if (insertErr.code === '23505') {
        // Duplicate — return 200 without further action.
        return res.status(200).json({
          received:   true,
          duplicate:  true,
          event_id:   eventId.trim(),
          event_type: eventType,
        });
      }
      // Unexpected DB error
      console.error('[razorpayWebhook] webhook_events insert error:', insertErr.code, insertErr.message);
      return res.status(500).json({ error: 'Failed to store webhook event' });
    }

    // ── 6. Write audit log (isolated: not linked to any simulation run) ──────
    //    audit_logs.run_id has a FK to simulation_runs; we cannot use a null.
    //    We log to a dedicated real_webhook_audit_logs table or, since the FK
    //    prevents null run_id, we store the event reference in the
    //    webhook_events.payload which is already stored.
    //    audit_logs REQUIRES run_id (FK, NOT NULL) — so we skip logAudit here
    //    and instead embed audit-equivalent data in the webhook_events payload
    //    which is already stored with full event detail.
    //
    //    NOTE: We intentionally do NOT call logAudit because:
    //      1. audit_logs.run_id is NOT NULL with a FK to simulation_runs.
    //      2. Webhook events are NOT associated with any simulation run.
    //      3. Inserting a fake run_id would corrupt simulation data integrity.
    //    The webhook_events row IS the audit record for inbound webhooks.

    // ── 7. Return 200 ────────────────────────────────────────────────────────
    return res.status(200).json({
      received:           true,
      duplicate:          false,
      event_id:           eventId.trim(),
      event_type:         eventType,
      webhook_event_id:   inserted.id,
    });
  }
);

export default webhookRouter;
