// src/recovery/guardrails.js
//
// Step 14: Guardrails for the Razorpay Payment Recovery System.
//
// Responsibilities:
//   - Pure, deterministic validation of Smart AI proposals before execution.
//   - Strictly enforce maximum attempt limits, failure retry eligibility, mandate state,
//     scheduling bounds, channel support, customer contact consent, discount validation,
//     and model confidence thresholds.
//   - Resolve rule conflicts using a deterministic, locked precedence hierarchy.
//   - Return a comprehensive reasons array logging every rule that triggered.
//
// Explicitly does NOT:
//   - Perform any database reads, writes, or Supabase queries (relies on freshly-read caller state).
//   - Execute payments or call any RPC.
//   - Make any network or AI/API requests.
//   - Mutate input proposals or context objects.

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_ATTEMPTS = 4;
export const MAX_DELAY_DAYS = 7;
export const CONFIDENCE_THRESHOLD = 0.70;

export const SUPPORTED_ACTIONS = Object.freeze(['retry', 'stand_down', 'human_review']);
export const SUPPORTED_CHANNELS = Object.freeze(['auto_debit', 'payment_link']);

// ─────────────────────────────────────────────────────────────────────────────
// Core Guardrail Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates a Smart AI recovery proposal against mandate, failure, and safety rules.
 *
 * @param {object} arg1 - Proposal object, or combined params object { proposal, mandate, ... }
 * @param {object} [arg2] - Context object if called as (proposal, context)
 *
 * @returns {{
 *   allowed: boolean,
 *   action: 'retry' | 'stand_down' | 'human_review',
 *   reasons: string[]
 * }}
 */
export function validateGuardrails(arg1, arg2) {
  let proposal;
  let context;

  if (arg2 !== undefined) {
    proposal = arg1 || {};
    context = arg2 || {};
  } else if (arg1 && typeof arg1 === 'object') {
    if ('proposal' in arg1) {
      proposal = arg1.proposal || {};
      context = arg1.context || arg1;
    } else {
      proposal = arg1;
      context = arg1;
    }
  } else {
    proposal = {};
    context = {};
  }

  const reasons = [];
  let hasStructuralViolation = false;
  let hasConsentViolation = false;
  let hasUncertaintyViolation = false;

  // ── 1. Proposal Action Validation ─────────────────────────────────────────
  const action = proposal?.action;
  if (!SUPPORTED_ACTIONS.includes(action)) {
    hasStructuralViolation = true;
    reasons.push(`Invalid or unsupported action: "${action}". Supported actions: ${SUPPORTED_ACTIONS.join(', ')}.`);
  }

  // ── 2. Mandate State Validation ───────────────────────────────────────────
  // A new recovery decision is valid ONLY when mandate.status === 'pending'.
  const mandateStatus = context.mandate?.status ?? context.status ?? context.mandateStatus;
  if (mandateStatus !== 'pending') {
    hasStructuralViolation = true;
    reasons.push(`Mandate state invalid for decision: status must be 'pending', but got "${mandateStatus}".`);
  }

  // ── 3. Discount Validation ────────────────────────────────────────────────
  // discountPercent is proposal-only: numeric, between 0 and 100 inclusive.
  const discountPercent = proposal?.discountPercent;
  if (discountPercent !== undefined) {
    if (
      discountPercent === null ||
      typeof discountPercent !== 'number' ||
      !Number.isFinite(discountPercent) ||
      discountPercent < 0 ||
      discountPercent > 100
    ) {
      hasStructuralViolation = true;
      reasons.push(
        `Invalid discountPercent: must be a finite number between 0 and 100 inclusive, got ${discountPercent}.`
      );
    }
  }

  // ── 4. Confidence Validation ──────────────────────────────────────────────
  // confidence must be numeric between 0 and 1 inclusive.
  const confidence = proposal?.confidence;
  const isConfidenceProvided = confidence !== undefined && confidence !== null;

  if (isConfidenceProvided) {
    if (
      typeof confidence !== 'number' ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      hasStructuralViolation = true;
      reasons.push(
        `Invalid confidence: must be a finite number between 0 and 1 inclusive, got ${confidence}.`
      );
    }
  } else if (action === 'retry') {
    // Retry proposals strictly require confidence
    hasStructuralViolation = true;
    reasons.push('Missing required confidence for retry proposal.');
  }

  // ── 5. Channel Validation (for retry) ─────────────────────────────────────
  const channel = proposal?.channel;
  if (action === 'retry') {
    if (!channel || !SUPPORTED_CHANNELS.includes(channel)) {
      hasStructuralViolation = true;
      reasons.push(
        `Invalid or missing channel for retry: "${channel}". Supported channels: ${SUPPORTED_CHANNELS.join(', ')}.`
      );
    }
  } else if (channel !== undefined && channel !== null && !SUPPORTED_CHANNELS.includes(channel)) {
    hasStructuralViolation = true;
    reasons.push(
      `Invalid channel specified: "${channel}". Supported channels: ${SUPPORTED_CHANNELS.join(', ')}.`
    );
  }

  // ── 6. Retry-Specific Rules (Max Attempts, Eligibility, Timing) ───────────
  if (action === 'retry') {
    const attemptsUsed =
      context.mandate?.attempts_used ??
      context.mandate?.attemptsUsed ??
      context.attempts_used ??
      context.attemptsUsed ??
      context.attempt?.attempt_number ??
      0;

    // Rule 1: Max Attempts (hard ceiling: 4)
    if (typeof attemptsUsed !== 'number' || attemptsUsed >= MAX_ATTEMPTS) {
      hasStructuralViolation = true;
      reasons.push(
        `Maximum recovery attempts reached or exceeded (attempts_used: ${attemptsUsed}, max: ${MAX_ATTEMPTS}).`
      );
    }

    // Rule 2: Retry Eligibility (category must be 'soft' and retryEligible must be true)
    const category =
      context.failure?.category ??
      context.failureClassification?.category ??
      context.category ??
      context.declineCategory;

    const retryEligible =
      context.failure?.retryEligible ??
      context.failureClassification?.retryEligible ??
      context.retryEligible;

    if (category !== 'soft') {
      hasStructuralViolation = true;
      reasons.push(
        `Retry ineligible: failure category must be 'soft', but got "${category}".`
      );
    }

    if (retryEligible !== true) {
      hasStructuralViolation = true;
      reasons.push(
        `Retry ineligible: attempt outcome is marked retryEligible === ${retryEligible}.`
      );
    }

    // Rule 4: Timing (delayDays must be integer in [0, MAX_DELAY_DAYS])
    const delay = proposal?.delayDays ?? proposal?.retryDelayDays;
    if (
      delay === undefined ||
      delay === null ||
      typeof delay !== 'number' ||
      !Number.isInteger(delay) ||
      delay < 0 ||
      delay > MAX_DELAY_DAYS
    ) {
      hasStructuralViolation = true;
      reasons.push(
        `Invalid delayDays for retry: must be an integer between 0 and ${MAX_DELAY_DAYS} inclusive, got ${delay}.`
      );
    }

    // Rule 6: Customer Consent for Payment Link
    const contactConsent =
      context.mandate?.contact_consent ??
      context.mandate?.contactConsent ??
      context.contact_consent ??
      context.contactConsent;

    if (channel === 'payment_link' && contactConsent === false) {
      hasConsentViolation = true;
      reasons.push('Customer contact consent is false for payment_link channel.');
    }

    // Rule 8: Uncertainty Threshold (confidence < 0.70)
    // Only fires if confidence is a valid numeric value
    if (
      isConfidenceProvided &&
      typeof confidence === 'number' &&
      Number.isFinite(confidence) &&
      confidence >= 0 &&
      confidence <= 1 &&
      confidence < CONFIDENCE_THRESHOLD
    ) {
      hasUncertaintyViolation = true;
      reasons.push(
        `Proposal confidence (${confidence}) is below conservative threshold of ${CONFIDENCE_THRESHOLD}.`
      );
    }
  }

  // ── 7. Precedence Hierarchy Resolution ────────────────────────────────────
  // Precedence 1: Structural / Hard Safety Violations -> stand_down
  // Precedence 2: Consent Violation                   -> human_review
  // Precedence 3: Uncertainty (low confidence)        -> human_review
  // Precedence 4: Valid Proposal                      -> proposal.action

  let finalAction;
  let allowed;

  if (hasStructuralViolation) {
    allowed = false;
    finalAction = 'stand_down';
  } else if (hasConsentViolation) {
    allowed = false;
    finalAction = 'human_review';
  } else if (hasUncertaintyViolation) {
    allowed = false;
    finalAction = 'human_review';
  } else {
    allowed = true;
    finalAction = action;
  }

  return {
    allowed,
    action: finalAction,
    reasons,
  };
}

// Aliases for consumer flexibility
export const evaluateGuardrails = validateGuardrails;
export const applyGuardrails = validateGuardrails;
