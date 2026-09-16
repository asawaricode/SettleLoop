// src/api/razorpayOrder.js
//
// Phase 3 — A2: Manual-Only Real Razorpay Test Mode Order Creation.
//
// Responsibilities:
//   - Provide POST /api/v1/razorpay/orders for MANUAL, operator-initiated
//     Razorpay Test Mode order creation ONLY.
//   - Run preflight validation before calling any external API.
//   - Call Razorpay Orders REST API directly using Node fetch + Basic Auth.
//   - Store the real Razorpay order_id and metadata in audit_logs (using
//     mandate.run_id to satisfy foreign key integrity, without mutating simulation state).
//   - Return the real Razorpay order artifact along with a mandatory disclosure.
//
// Preflight guards:
//   1. Mandate exists.
//   2. Mandate experiment_arm === 'smart'.
//   3. Mandate next_action === 'retry' (current decision is RETRY).
//   4. Mandate attempts_used < 4 (UPI AutoPay guardrail: max 4 total attempts).
//   5. Amount is a positive number.
//   6. Currency is a non-empty string (default: INR).
//
// Hard Isolation Rules (NEVER violated by this module):
//   - Does NOT write to mandates.
//   - Does NOT write to attempts.
//   - Does NOT trigger Smart policy, retry scheduling, or payment execution.
//   - Does NOT modify simulation_runs.
//   - Does NOT modify experiment metrics.
//   - Does NOT send notifications.
//   - Is NEVER called by simulation runner, Control, Baseline, or Smart policy.
//
// Explicitly does NOT:
//   - Send customer PII (name, email, contact).
//   - Set notify: true.
//   - Install or import the Razorpay SDK.
//   - Create an attempts row.
//   - Modify mandate state.

import { supabase } from '../config/supabase.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const RAZORPAY_ORDERS_API = 'https://api.razorpay.com/v1/orders';
const MAX_SMART_ATTEMPTS  = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Mandatory disclosure string (must appear in every response)
// ─────────────────────────────────────────────────────────────────────────────

export const ORDER_DISCLOSURE =
  'This creates a real Razorpay Test Mode order artifact. ' +
  'It is not a payment retry and does not execute a payment.';

// ─────────────────────────────────────────────────────────────────────────────
// Internal: call Razorpay Orders API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a Razorpay Test Mode order by calling the Orders REST API.
 *
 * Sends ONLY: amount (in paise), currency.
 * Does NOT send: customer PII, notify, or unrelated fields.
 *
 * @param {object} params
 * @param {number} params.amountPaise  - Amount in smallest currency unit (paise for INR).
 * @param {string} params.currency     - ISO currency code (e.g. 'INR').
 * @param {string} params.keyId        - RAZORPAY_KEY_ID.
 * @param {string} params.keySecret    - RAZORPAY_KEY_SECRET.
 * @returns {Promise<object>}          - Razorpay order object.
 */
export async function createRazorpayOrder({ amountPaise, currency, keyId, keySecret }) {
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

  const response = await fetch(RAZORPAY_ORDERS_API, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      amount:   amountPaise,
      currency: currency,
    }),
  });

  if (!response.ok) {
    let detail = '';
    try { detail = await response.text(); } catch { /* ignore */ }
    throw new Error(`Razorpay Orders API returned ${response.status}: ${detail}`);
  }

  return await response.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Route handler (used by routes.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/razorpay/orders
 *
 * Body: { mandateId: string, currency?: string }
 *
 * MANUAL-ONLY. Not reachable from simulation runner or any recovery policy.
 */
export async function handleCreateOrder(req, res) {
  // ── 1. Validate request body ─────────────────────────────────────────────
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Request body must be a JSON object', disclosure: ORDER_DISCLOSURE });
  }

  const { mandateId, currency = 'INR' } = req.body;

  if (!mandateId || typeof mandateId !== 'string' || mandateId.trim() === '') {
    return res.status(400).json({ error: 'mandateId must be a non-empty string', disclosure: ORDER_DISCLOSURE });
  }

  if (!currency || typeof currency !== 'string' || currency.trim() === '') {
    return res.status(400).json({ error: 'currency must be a non-empty string', disclosure: ORDER_DISCLOSURE });
  }

  // ── 2. Fetch mandate from database ───────────────────────────────────────
  const { data: mandate, error: mandateErr } = await supabase
    .from('mandates')
    .select('id, run_id, experiment_arm, next_action, attempts_used, amount, status, next_action_day')
    .eq('id', mandateId.trim())
    .maybeSingle();

  if (mandateErr) {
    if (mandateErr.code === '22P02') {
      return res.status(404).json({ error: 'Mandate not found', disclosure: ORDER_DISCLOSURE });
    }
    return res.status(500).json({ error: 'Failed to fetch mandate', disclosure: ORDER_DISCLOSURE });
  }

  if (!mandate) {
    return res.status(404).json({ error: 'Mandate not found', disclosure: ORDER_DISCLOSURE });
  }

  // ── 3. Preflight: experiment arm ──────────────────────────────────────────
  if (mandate.experiment_arm !== 'smart') {
    return res.status(422).json({
      error:      `Mandate experiment_arm must be 'smart', got '${mandate.experiment_arm}'`,
      disclosure: ORDER_DISCLOSURE,
    });
  }

  // ── 4. Preflight: current decision must be RETRY ──────────────────────────
  if (mandate.next_action !== 'retry') {
    return res.status(422).json({
      error:      `Mandate next_action must be 'retry', got '${mandate.next_action}'`,
      disclosure: ORDER_DISCLOSURE,
    });
  }

  // ── 5. Preflight: attempts guardrail ──────────────────────────────────────
  if (mandate.attempts_used >= MAX_SMART_ATTEMPTS) {
    return res.status(422).json({
      error:      `Mandate has reached the maximum of ${MAX_SMART_ATTEMPTS} attempts (UPI AutoPay guardrail)`,
      disclosure: ORDER_DISCLOSURE,
    });
  }

  // ── 6. Preflight: amount ──────────────────────────────────────────────────
  if (!mandate.amount || typeof mandate.amount !== 'number' || mandate.amount <= 0) {
    return res.status(422).json({
      error:      'Mandate amount is invalid',
      disclosure: ORDER_DISCLOSURE,
    });
  }

  // ── 7. Check credentials ──────────────────────────────────────────────────
  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    return res.status(503).json({
      error:      'Razorpay credentials not configured',
      disclosure: ORDER_DISCLOSURE,
    });
  }

  // ── 8. Convert amount to paise (INR smallest unit) ────────────────────────
  //    mandate.amount is stored as a number (assumed rupees for INR).
  //    Razorpay requires amount in paise (multiply by 100).
  const amountPaise = Math.round(mandate.amount * 100);

  // ── 9. Call Razorpay Orders API ───────────────────────────────────────────
  let razorpayOrder;
  try {
    razorpayOrder = await createRazorpayOrder({
      amountPaise,
      currency: currency.trim().toUpperCase(),
      keyId,
      keySecret,
    });
  } catch (apiErr) {
    return res.status(502).json({
      error:      'Failed to create Razorpay order: ' + apiErr.message,
      disclosure: ORDER_DISCLOSURE,
    });
  }

  // ── 10. Store order artifact in audit_logs with metadata ─────────────────
  //    Stores the real Razorpay order_id, amount, status, and metadata in
  //    audit_logs with mandate.run_id to satisfy foreign key integrity.
  //    No attempt is created, no mandate mutated, and metrics are untouched.
  const { error: auditErr } = await supabase
    .from('audit_logs')
    .insert({
      run_id:        mandate.run_id,
      mandate_id:    mandate.id,
      attempt_id:    null,
      day:           mandate.next_action_day ?? 0,
      actor:         'operator_manual',
      decision_type: 'razorpay_order_created',
      input: {
        mandate_id:   mandate.id,
        amount_paise: amountPaise,
        currency:     currency.trim().toUpperCase(),
      },
      output: {
        razorpay_order_id: razorpayOrder.id,
        status:            razorpayOrder.status,
        created_at:        razorpayOrder.created_at,
      },
      reasoning: 'Manual operator-initiated Razorpay Test Mode order creation',
      metadata: {
        razorpay_order_id: razorpayOrder.id,
        amount_paise:      amountPaise,
        currency:          currency.trim().toUpperCase(),
        status:            razorpayOrder.status,
        created_at:        razorpayOrder.created_at,
        receipt:           razorpayOrder.receipt ?? null,
        source:            'manual_order_endpoint',
        note:              ORDER_DISCLOSURE,
      },
    });

  if (auditErr) {
    console.error('[razorpayOrder] audit_logs insert error:', auditErr.code, auditErr.message);
  }

  // ── 11. Return response ───────────────────────────────────────────────────
  return res.status(201).json({
    disclosure:       ORDER_DISCLOSURE,
    razorpay_order:   {
      id:          razorpayOrder.id,
      entity:      razorpayOrder.entity,
      amount:      razorpayOrder.amount,
      currency:    razorpayOrder.currency,
      status:      razorpayOrder.status,
      created_at:  razorpayOrder.created_at,
    },
    mandate: {
      id:            mandate.id,
      experiment_arm: mandate.experiment_arm,
      attempts_used: mandate.attempts_used,
      status:        mandate.status,
    },
  });
}
