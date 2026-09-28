// src/recovery/proposalValidator.js
//
// Phase 3: Gemini Proposal Structural Validation & Deterministic Fallback.
//
// Responsibilities:
//   - Strictly validates the STRUCTURE of Gemini AI proposals using Zod at the LLM boundary.
//   - Validates types, required fields, allowed enum values, and structural shapes.
//   - Explicitly does NOT enforce business guardrails:
//       * Peak-hour restrictions, 24h pre-debit notice gaps, attempt caps,
//         terminal-state rules, customer consent, and financial thresholds remain
//         exclusively in the domain guardrail layer (src/recovery/guardrails.js).
//   - Distinguishes two separate failure categories:
//       1. 'schema_validation_failure' — malformed JSON, wrong types, missing fields, extra fields.
//       2. 'guardrail_rejection'       — structurally valid proposal that violates domain policy.
//   - Generates deterministic fallbacks satisfying:
//       * Non-peak dispatch slot (14:00 IST)
//       * 24-hour notice gap (retryDelayDays >= 2)
//       * Attempt cap escalation (stand_down when attempts_used >= maxAttemptsPerCycle)
//       * Zero unhandled throws on malformed input.

import { z } from 'zod';
import {
  maxAttemptsPerCycle,
  preDebitNoticeMinHours,
} from '../config/recoveryPolicy.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Zod Structural Schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structural schema for Gemini recovery proposals.
 * Strict mode (.strict()) ensures that unexpected extra fields, injected keys,
 * or prototype-pollution shapes are rejected as structural violations.
 */
export const GeminiProposalSchema = z.object({
  action: z.enum(['retry', 'stand_down', 'human_review']),
  retryDelayDays: z.number().int().min(0).max(30).nullable().optional(),
  delayDays: z.number().int().min(0).max(30).nullable().optional(),
  timeSlot: z.string().max(20).optional(),
  dispatchTime: z.string().max(60).optional(),
  channel: z.enum(['auto_debit', 'payment_link']).optional(),
  confidence: z.number().min(0).max(1).optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  reasoning: z.string().max(500).optional(),
}).strict();

// ─────────────────────────────────────────────────────────────────────────────
// 2. Structural Validator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the raw Gemini output against the structural Zod schema.
 * Never throws an unhandled exception.
 *
 * @param {unknown} rawOutput - Parsed object or JSON string from LLM.
 * @returns {{
 *   success: boolean,
 *   data?: z.infer<typeof GeminiProposalSchema>,
 *   category?: 'schema_validation_failure',
 *   errors?: string[]
 * }}
 */
export function validateProposalStructure(rawOutput) {
  let parsed = rawOutput;

  // Handle string JSON input safely
  if (typeof rawOutput === 'string') {
    try {
      parsed = JSON.parse(rawOutput.trim());
    } catch (parseErr) {
      return {
        success: false,
        category: 'schema_validation_failure',
        errors: [`Invalid JSON: ${parseErr.message}`],
      };
    }
  }

  // Reject non-objects (null, arrays, primitives)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      success: false,
      category: 'schema_validation_failure',
      errors: ['Proposal must be a non-null plain JSON object'],
    };
  }

  // Execute Zod structural validation
  const result = GeminiProposalSchema.safeParse(parsed);

  if (!result.success) {
    const errors = result.error.issues.map(
      (issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`
    );
    return {
      success: false,
      category: 'schema_validation_failure',
      errors,
    };
  }

  return {
    success: true,
    data: result.data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Deterministic Fallback Generator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministically constructs a safe fallback proposal when Gemini output is
 * invalid (schema_validation_failure) or rejected by guardrails (guardrail_rejection).
 *
 * Properties of this fallback:
 *   - Never proposes a peak slot (uses 14:00 IST).
 *   - Satisfies the 24-hour pre-debit notice gap (retryDelayDays = 2 >= 24h).
 *   - Escalates to stand_down if attempt cap is reached (attemptsUsed >= 4).
 *   - Respects non-retryable failure categories ('hard' / 'unknown' stand down).
 *   - Passes normal guardrail validation.
 *
 * @param {object} params
 * @param {object} [params.mandate]
 * @param {object} [params.context]
 * @param {number} [params.attemptsUsed=0]
 * @param {string} [params.category='soft']
 * @param {boolean} [params.retryEligible=true]
 * @param {'schema_validation_failure'|'guardrail_rejection'} [params.failureCategory='schema_validation_failure']
 * @returns {object} Safe, deterministic proposal
 */
export function generateDeterministicFallback({
  mandate,
  context,
  attemptsUsed,
  category,
  retryEligible,
  failureCategory = 'schema_validation_failure',
} = {}) {
  const currentAttempts =
    attemptsUsed ??
    mandate?.attempts_used ??
    context?.attemptsUsed ??
    context?.mandate?.attempts_used ??
    0;

  const currentCategory =
    category ??
    context?.failure?.category ??
    context?.category ??
    'soft';

  const isEligible =
    retryEligible ??
    context?.failure?.retryEligible ??
    context?.retryEligible ??
    true;

  // 1. Escalate if attempt cap reached
  if (currentAttempts >= maxAttemptsPerCycle) {
    return {
      action: 'stand_down',
      retryDelayDays: null,
      delayDays: null,
      timeSlot: null,
      channel: 'auto_debit',
      confidence: 1.0,
      reasoning: `Deterministic escalation: cycle attempt ceiling (${currentAttempts}/${maxAttemptsPerCycle}) reached.`,
      source: 'fallback',
      failureCategory,
    };
  }

  // 2. Stand down on non-retryable failure categories
  if (!isEligible || currentCategory === 'hard' || currentCategory === 'unknown') {
    return {
      action: 'stand_down',
      retryDelayDays: null,
      delayDays: null,
      timeSlot: null,
      channel: 'auto_debit',
      confidence: 1.0,
      reasoning: `Deterministic fallback: non-retryable failure (${currentCategory}) after ${failureCategory}.`,
      source: 'fallback',
      failureCategory,
    };
  }

  // 3. Next valid non-peak slot after the required notice/retry gap
  // Notice gap: 24h minimum => 2 days safe delay
  // Time slot: 14:00 IST (strictly non-peak window: 13:00 to 17:00 is non-peak)
  return {
    action: 'retry',
    retryDelayDays: 2,
    delayDays: 2,
    timeSlot: '14:00',
    channel: 'auto_debit',
    confidence: 0.80,
    reasoning: `Deterministic fallback: scheduled in non-peak slot (14:00 IST) with ${preDebitNoticeMinHours}h notice gap after ${failureCategory}.`,
    source: 'fallback',
    failureCategory,
  };
}
