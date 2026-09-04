// src/recovery/smartAgent.js
//
// Step 13: Smart AI Decision Layer.
//
// Responsibilities:
//   - Receive a classified failure context (from failureClassifier) and mandate metadata.
//   - Call the Gemini API to propose a recovery action.
//   - Apply safety guardrails to reject/downgrade unsafe proposals.
//   - Fall back to a deterministic heuristic if the API is unavailable or times out.
//   - Return a structured proposal object for Step 14 (Guardrails) to evaluate.
//
// Explicitly does NOT:
//   - Execute any action (no execute_attempt, complete_attempt, set_mandate_action calls).
//   - Query or write to the database / Supabase.
//   - Call any other RPC.
//   - Expose the GEMINI_API_KEY in logs, errors, returned objects, or audit data.
//   - Guarantee bit-for-bit deterministic AI output (LLM outputs are stochastic).

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Valid actions the agent may propose. */
export const VALID_ACTIONS = Object.freeze(['retry', 'stand_down', 'human_review']);

/** Maximum number of days in the future the agent may schedule a retry. */
const MAX_RETRY_DELAY_DAYS = 7;

/** Gemini API endpoint and model. */
const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

/** Timeout in milliseconds for the Gemini API call. */
const API_TIMEOUT_MS = 10_000;

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic fallback heuristic
//
// Used when the Gemini API is unavailable, times out, or returns an unusable
// response. Mirrors the Baseline policy's retry logic:
//   - soft failure and attempts < 4  → retry in 2 days
//   - hard / unknown, or attempts >= 4 → stand_down
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} params
 * @param {string} params.category       - 'soft' | 'hard' | 'unknown'
 * @param {boolean} params.retryEligible - classifier output
 * @param {number}  params.attemptsUsed  - current attempts_used count from mandate
 * @returns {{ action: string, retryDelayDays: number|null, reasoning: string, source: 'fallback' }}
 */
function heuristicFallback({ category, retryEligible, attemptsUsed }) {
  if (retryEligible && attemptsUsed < 4) {
    return {
      action: 'retry',
      retryDelayDays: 2,
      reasoning: `Fallback heuristic: soft failure (${category}), ${attemptsUsed} attempts used, scheduling retry in 2 days.`,
      source: 'fallback',
    };
  }

  return {
    action: 'stand_down',
    retryDelayDays: null,
    reasoning: `Fallback heuristic: non-retryable failure (${category}) or attempts exhausted (${attemptsUsed}/4).`,
    source: 'fallback',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Safety guardrails
//
// Applied to both AI proposals and, as a sanity check, to fallback proposals.
// Rules (applied in order):
//   1. action must be one of VALID_ACTIONS.
//   2. Hard or unknown failures must NEVER be retried automatically.
//   3. retryDelayDays must be a positive integer ≤ MAX_RETRY_DELAY_DAYS when
//      action === 'retry', otherwise coerced to null.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Applies safety guardrails to a raw proposal. Mutates proposal in-place or
 * downgrades to 'stand_down' when the proposal violates safety rules.
 *
 * @param {object} rawProposal
 * @param {'soft'|'hard'|'unknown'} category
 * @returns {object} Safe, validated proposal
 */
function applyGuardrails(rawProposal, category) {
  let { action, retryDelayDays, reasoning, source } = rawProposal;

  // Rule 1: action must be valid
  if (!VALID_ACTIONS.includes(action)) {
    return {
      action: 'stand_down',
      retryDelayDays: null,
      reasoning: `Guardrail: unknown action "${action}" downgraded to stand_down.`,
      source,
      guardrailApplied: true,
    };
  }

  // Rule 2: hard/unknown must never auto-retry
  if (action === 'retry' && (category === 'hard' || category === 'unknown')) {
    return {
      action: 'stand_down',
      retryDelayDays: null,
      reasoning: `Guardrail: auto-retry rejected for ${category} failure — downgraded to stand_down.`,
      source,
      guardrailApplied: true,
    };
  }

  // Rule 3: retryDelayDays coercion
  if (action === 'retry') {
    const delay = Number.isInteger(retryDelayDays) && retryDelayDays >= 1 && retryDelayDays <= MAX_RETRY_DELAY_DAYS
      ? retryDelayDays
      : 2; // safe default
    retryDelayDays = delay;
  } else {
    retryDelayDays = null;
  }

  return { action, retryDelayDays, reasoning: reasoning || '', source, guardrailApplied: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a structured prompt for Gemini.
 * Excludes any internal fields that could expose keys or secret data.
 *
 * @param {object} context
 * @returns {string} Prompt text
 */
function buildPrompt(context) {
  const {
    mandateId,
    attemptsUsed,
    maxAttempts,
    amount,
    category,
    retryEligible,
    declineCode,
    balanceVolatility,
  } = context;

  return `You are a payment recovery AI for a recurring mandate system.

A payment attempt has failed and you must propose a recovery action.

## Failure Context
- Mandate ID: ${mandateId}
- Attempts Used: ${attemptsUsed} of ${maxAttempts} maximum
- Amount: ₹${amount}
- Decline Category: ${category}
- Decline Code: ${declineCode || 'N/A'}
- Retry Eligible (classifier): ${retryEligible}
- Balance Volatility: ${balanceVolatility} (0 = stable, 1 = very volatile)

## Rules You Must Follow
1. Hard or unknown failures must NEVER be retried — always propose stand_down.
2. Soft failures with remaining attempts may be retried after a delay.
3. If attempts are exhausted (${attemptsUsed} >= ${maxAttempts}), propose stand_down.
4. retryDelayDays must be an integer from 1 to ${MAX_RETRY_DELAY_DAYS}.
5. For high balance volatility (> 0.7), prefer a longer delay (3–5 days).
6. For low balance volatility (≤ 0.3), prefer a shorter delay (1–2 days).

## Output Format
Respond with ONLY a valid JSON object. No explanation, no markdown, no extra text.

{
  "action": "retry" | "stand_down" | "human_review",
  "retryDelayDays": <integer 1–${MAX_RETRY_DELAY_DAYS} if retry, else null>,
  "reasoning": "<brief explanation, max 200 chars>"
}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini API call
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Makes a single request to the Gemini API.
 * Returns parsed { action, retryDelayDays, reasoning } or throws on error.
 *
 * Security: The API key is read from process.env and NEVER passed back to
 * the caller or logged. The key is interpolated only into the URL.
 *
 * @param {string} prompt
 * @returns {Promise<{ action: string, retryDelayDays: number|null, reasoning: string }>}
 */
async function callGeminiAPI(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('smartAgent: GEMINI_API_KEY is not set in environment');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 256,
          responseMimeType: 'application/json',
        },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // Do NOT include response body — it may echo the prompt or contain key info
    throw new Error(`smartAgent: Gemini API returned HTTP ${response.status}`);
  }

  const body = await response.json();

  // Extract text from the Gemini response envelope
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('smartAgent: Gemini API returned empty candidate text');
  }

  // Parse the JSON proposal
  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new Error(`smartAgent: Gemini response was not valid JSON`);
  }

  return {
    action: parsed.action,
    retryDelayDays: parsed.retryDelayDays ?? null,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 200) : '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Proposes a smart recovery action for a failed mandate attempt.
 *
 * This is the sole exported function for Step 13. It is a proposal-only
 * function — it never executes any action or modifies any state.
 *
 * Input: classification output (from failureClassifier) + mandate metadata.
 * Output: a structured proposal for Step 14 (Guardrails) to evaluate.
 *
 * @param {object} params
 * @param {string} params.mandateId         - mandates.id UUID (required, for audit/logging)
 * @param {number} params.attemptsUsed      - mandate.attempts_used (required)
 * @param {number} [params.maxAttempts=4]   - system maximum (default: 4)
 * @param {number} params.amount            - mandate.amount in INR (required)
 * @param {number} params.balanceVolatility - mandate.balance_volatility in [0, 1]
 * @param {string} params.category          - failureClassifier output: 'soft' | 'hard' | 'unknown'
 * @param {boolean} params.retryEligible    - failureClassifier output
 * @param {string|null} [params.declineCode=null] - failureClassifier output
 *
 * @returns {Promise<{
 *   action: 'retry' | 'stand_down' | 'human_review',
 *   retryDelayDays: number | null,
 *   reasoning: string,
 *   source: 'ai' | 'fallback',
 *   guardrailApplied: boolean
 * }>}
 */
export async function proposeSmartRecoveryAction({
  mandateId,
  attemptsUsed,
  maxAttempts = 4,
  amount,
  balanceVolatility,
  category,
  retryEligible,
  declineCode = null,
} = {}) {
  // ── Input validation ──────────────────────────────────────────────────────

  if (!mandateId || typeof mandateId !== 'string' || mandateId.trim() === '') {
    throw new Error('smartAgent: mandateId must be a non-empty string');
  }
  if (!Number.isInteger(attemptsUsed) || attemptsUsed < 0) {
    throw new Error('smartAgent: attemptsUsed must be a non-negative integer');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('smartAgent: maxAttempts must be a positive integer');
  }
  if (!Number.isFinite(amount) || amount < 100 || amount > 50000) {
    throw new Error(`smartAgent: amount must be a finite number in [100, 50000], got ${amount}`);
  }
  if (!Number.isFinite(balanceVolatility) || balanceVolatility < 0 || balanceVolatility > 1) {
    throw new Error(`smartAgent: balanceVolatility must be in [0, 1], got ${balanceVolatility}`);
  }
  if (!category || !['soft', 'hard', 'unknown'].includes(category)) {
    throw new Error(`smartAgent: category must be 'soft', 'hard', or 'unknown', got "${category}"`);
  }
  if (typeof retryEligible !== 'boolean') {
    throw new Error('smartAgent: retryEligible must be a boolean');
  }

  // ── Context object (shared by prompt builder and fallback) ────────────────

  const context = {
    mandateId,
    attemptsUsed,
    maxAttempts,
    amount,
    balanceVolatility,
    category,
    retryEligible,
    declineCode,
  };

  // ── Attempt AI proposal ───────────────────────────────────────────────────

  let rawProposal;
  let source = 'ai';

  try {
    const prompt = buildPrompt(context);
    const aiResult = await callGeminiAPI(prompt);
    rawProposal = { ...aiResult, source: 'ai' };
  } catch {
    // API unavailable, timed out, or returned unusable response → fall back
    source = 'fallback';
    rawProposal = heuristicFallback({ category, retryEligible, attemptsUsed });
  }

  // ── Apply safety guardrails ───────────────────────────────────────────────

  const safeProposal = applyGuardrails(rawProposal, category);

  return safeProposal;
}
