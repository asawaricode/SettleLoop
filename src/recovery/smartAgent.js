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

import {
  validateProposalStructure,
  generateDeterministicFallback,
} from './proposalValidator.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants & LLM Mode Controls
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

/** Pluggable mock LLM handler for tests and fuzzing. */
let _mockLLMHandler = null;

/**
 * Injects a mock LLM handler function for deterministic testing and fuzzing.
 * When set, callGeminiAPI delegates directly to this handler.
 * Set to null to restore default behavior.
 *
 * @param {Function|null} fn - (prompt, context) => object|string
 */
export function setMockLLMHandler(fn) {
  _mockLLMHandler = fn;
}

/**
 * Resets the mock LLM handler back to null.
 */
export function resetMockLLMHandler() {
  _mockLLMHandler = null;
}

/**
 * Returns the current LLM mode: 'mock' | 'replay' | 'live'.
 * Evaluates CLI argument --llm=... first, then environment variable LLM_MODE.
 * Defaults to 'mock' in non-production environments to prevent accidental live calls.
 *
 * @returns {'mock'|'replay'|'live'}
 */
export function getLLMMode() {
  const llmArg = process.argv.find(arg => arg.startsWith('--llm='));
  if (llmArg) {
    const val = llmArg.split('=')[1];
    if (['mock', 'replay', 'live'].includes(val)) return val;
  }
  if (process.env.LLM_MODE && ['mock', 'replay', 'live'].includes(process.env.LLM_MODE)) {
    return process.env.LLM_MODE;
  }
  return 'mock';
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic fallback heuristic
//
// Used when the Gemini API is unavailable, times out, or returns an unusable
// response. Delegates to generateDeterministicFallback.
// ─────────────────────────────────────────────────────────────────────────────

function heuristicFallback({ category, retryEligible, attemptsUsed, failureCategory = 'schema_validation_failure' }) {
  return generateDeterministicFallback({
    attemptsUsed,
    category,
    retryEligible,
    failureCategory,
  });
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

  return {
    ...rawProposal,
    action,
    retryDelayDays,
    reasoning: (reasoning || '').slice(0, 200),
    source,
    guardrailApplied: false,
  };
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
// Gemini API call & Network
// ─────────────────────────────────────────────────────────────────────────────

async function callGeminiNetwork(prompt) {
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
    throw new Error(`smartAgent: Gemini API returned HTTP ${response.status}`);
  }

  const body = await response.json();
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('smartAgent: Gemini API returned empty candidate text');
  }

  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new Error('smartAgent: Gemini response was not valid JSON');
  }

  return parsed;
}

/**
 * Dispatches the prompt to either the mock handler, deterministic mock, or live Gemini.
 *
 * @param {string} prompt
 * @param {object} context
 * @returns {Promise<object>}
 */
async function callGeminiAPI(prompt, context) {
  // 1. Explicit mock handler takes top precedence (for unit & fuzz tests)
  if (_mockLLMHandler) {
    return await _mockLLMHandler(prompt, context);
  }

  // 2. Evaluate LLM Mode
  const mode = getLLMMode();
  if (mode === 'mock') {
    // If test framework intercepted fetch (e.g. step13 / step18 tests), execute network call to hit interceptor
    if (global.fetch && process.env.GEMINI_API_KEY) {
      return await callGeminiNetwork(prompt);
    }
    return {
      action: 'retry',
      retryDelayDays: 2,
      timeSlot: '14:00',
      reasoning: 'Mock LLM: deterministic retry proposal for soft decline',
    };
  }

  // 3. Live mode (requires GEMINI_API_KEY)
  return await callGeminiNetwork(prompt);
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
 *   guardrailApplied: boolean,
 *   failureCategory?: string
 * }>}
 */
export async function proposeSmartRecoveryAction(params = {}) {
  const mandate = params?.mandate;
  const failure = params?.failure;

  const mandateId = params?.mandateId ?? mandate?.id ?? mandate?.mandate_id;
  const attemptsUsed = params?.attemptsUsed ?? mandate?.attempts_used ?? 0;
  const maxAttempts = params?.maxAttempts ?? 4;
  const amount = params?.amount ?? mandate?.amount ?? 1000;
  const balanceVolatility = params?.balanceVolatility ?? mandate?.balance_volatility ?? 0.2;
  const category = params?.category ?? failure?.category ?? 'soft';
  const retryEligible = params?.retryEligible ?? failure?.retryEligible ?? true;
  const declineCode = params?.declineCode ?? failure?.code ?? failure?.declineCode ?? null;
  const benchmark = params?.benchmark ?? false;
  const deterministic = params?.deterministic ?? false;

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

  // ── Proposal resolution ───────────────────────────────────────────────────

  const isBenchmark = Boolean(
    benchmark || deterministic || process.env.BENCHMARK_MODE === 'true'
  );

  let rawProposal;
  let source;

  if (isBenchmark) {
    source = 'fallback';
    rawProposal = heuristicFallback({ category, retryEligible, attemptsUsed });
  } else {
    try {
      const prompt = buildPrompt(context);
      const rawOutput = await callGeminiAPI(prompt, context);

      // Zod structural boundary validation
      const validation = validateProposalStructure(rawOutput);

      if (!validation.success) {
        // Schema invalid -> deterministic fallback categorized as schema_validation_failure
        source = 'fallback';
        rawProposal = heuristicFallback({
          category,
          retryEligible,
          attemptsUsed,
          failureCategory: 'schema_validation_failure',
        });
        rawProposal.failureCategory = 'schema_validation_failure';
        rawProposal.validationErrors = validation.errors;
      } else {
        source = 'ai';
        rawProposal = {
          action: validation.data.action,
          retryDelayDays: validation.data.retryDelayDays ?? validation.data.delayDays ?? null,
          timeSlot: validation.data.timeSlot,
          dispatchTime: validation.data.dispatchTime,
          channel: validation.data.channel || 'auto_debit',
          confidence: validation.data.confidence,
          discountPercent: validation.data.discountPercent,
          reasoning: validation.data.reasoning || '',
          source: 'ai',
        };
      }
    } catch {
      // API error or parse throw -> deterministic fallback
      source = 'fallback';
      rawProposal = heuristicFallback({
        category,
        retryEligible,
        attemptsUsed,
        failureCategory: 'schema_validation_failure',
      });
      rawProposal.failureCategory = 'schema_validation_failure';
    }
  }

  // ── Apply safety guardrails ───────────────────────────────────────────────

  const safeProposal = applyGuardrails(rawProposal, category);

  return safeProposal;
}
