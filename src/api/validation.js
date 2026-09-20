// src/api/validation.js
//
// Phase 4 — Centralised Zod request-body schemas and validation middleware.
//
// Exports:
//   simulationCreateSchema   — POST /api/simulations
//   approvalResolveSchema    — POST /api/approvals/:id/resolve
//   manualOrderSchema        — POST /api/v1/razorpay/orders
//   validateBody(schema)     — Express middleware factory; returns 400 on failure
//
// Rules:
//   - Never exposes stack traces, secrets, or internal detail in error responses.
//   - Returns the first Zod error message as a plain string in { error }.
//   - On success, replaces req.body with the Zod-parsed (and default-applied) value.

import { z } from 'zod';

// ─── Schemas ─────────────────────────────────────────────────────────────────

/** POST /api/simulations */
export const simulationCreateSchema = z.object({
  seed:         z.number().finite(),
  mandateCount: z.number().int().min(1).max(10000),
  maxDays:      z.number().int().min(1).max(365),
});

/** POST /api/approvals/:id/resolve */
export const approvalResolveSchema = z.object({
  decision:       z.enum(['approved', 'rejected']),
  decidedBy:      z.string().trim().min(1),
  decidedDay:     z.number().int().min(0),
  decisionReason: z.string().nullable().optional().default(null),
});

/** POST /api/v1/razorpay/orders */
export const manualOrderSchema = z.object({
  mandateId: z.string().trim().min(1),
  currency:  z.string().trim().min(1).default('INR'),
});

// ─── Middleware factory ───────────────────────────────────────────────────────

/**
 * Returns Express middleware that validates req.body against a Zod schema.
 *
 * On failure → 400 { error: string } using the first validation error message.
 *              No stack traces or secrets are exposed.
 * On success → replaces req.body with Zod-parsed (coerced + defaulted) data,
 *              then calls next().
 *
 * @param {import('zod').ZodTypeAny} schema
 * @returns {import('express').RequestHandler}
 */
export function validateBody(schema) {
  return (req, res, next) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const msg = result.error.issues?.[0]?.message ?? result.error.errors?.[0]?.message ?? result.error.message;
      return res.status(400).json({ error: msg });
    }
    req.body = result.data;
    next();
  };
}
