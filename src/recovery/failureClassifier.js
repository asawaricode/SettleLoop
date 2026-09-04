// src/recovery/failureClassifier.js
//
// Pure, deterministic Failure Classifier.
//
// Responsibilities:
//   - Receive raw attempt outcome information (outcome, declineCode, declineCategory, retryEligible).
//   - Validate and normalize into a standardized classification schema.
//   - Provide clear, safe classification for downstream consumers (Smart policy, AI agent).
//
// Explicitly does NOT:
//   - Call any AI model / LLM.
//   - Query or write to the database / Supabase.
//   - Decide retry delays or schedules.
//   - Modify mandate or attempt records.
//   - Contain guardrails or approval logic.

export const VALID_CATEGORIES = Object.freeze(['soft', 'hard', 'unknown']);

/**
 * Classifies and normalizes a payment attempt outcome.
 *
 * @param {object} params
 * @param {string} params.outcome - 'success' | 'failure'
 * @param {string|null} [params.declineCode=null] - Decline code (e.g. 'SIM_SOFT_001')
 * @param {string|null} [params.declineCategory=null] - 'soft' | 'hard' | 'unknown'
 * @param {boolean|null} [params.retryEligible=null] - Whether the attempt is eligible for retry
 *
 * @returns {{
 *   isFailure: boolean,
 *   category: 'soft' | 'hard' | 'unknown' | null,
 *   retryEligible: boolean,
 *   declineCode: string | null
 * }}
 */
export function classifyFailure({
  outcome,
  declineCode = null,
  declineCategory = null,
  retryEligible = null,
} = {}) {
  if (!outcome || (outcome !== 'success' && outcome !== 'failure')) {
    throw new Error(`failureClassifier: invalid outcome "${outcome}", must be 'success' or 'failure'`);
  }

  // 1. Success path: not a failure
  if (outcome === 'success') {
    return {
      isFailure: false,
      category: null,
      retryEligible: false,
      declineCode: null,
    };
  }

  // 2. Failure path: validate category
  if (!declineCategory || !VALID_CATEGORIES.includes(declineCategory)) {
    throw new Error(
      `failureClassifier: invalid or missing declineCategory "${declineCategory}", expected one of: ${VALID_CATEGORIES.join(', ')}`
    );
  }

  // Normalize retryEligible to a strict boolean:
  // - If retryEligible is explicitly provided as boolean, honor it.
  // - If category is 'hard' or 'unknown', retryEligible must strictly resolve to false.
  // - If category is 'soft', default to true unless explicitly false.
  let resolvedRetryEligible = false;
  if (declineCategory === 'soft') {
    resolvedRetryEligible = retryEligible !== false;
  } else {
    // 'hard' and 'unknown' declines are not retryable
    resolvedRetryEligible = false;
  }

  return {
    isFailure: true,
    category: declineCategory,
    retryEligible: resolvedRetryEligible,
    declineCode: declineCode || null,
  };
}
