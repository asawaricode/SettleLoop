// src/recovery/llmCache.js
//
// Phase 5: Deterministic LLM Cache & Replay Layer.
//
// Responsibilities:
//   - Computes a deterministic SHA-256 cache key based on:
//       hash(canonicalized input + ":" + model name + ":" + prompt version)
//   - Canonical input is derived strictly from public Observation / proposal inputs:
//       * mandateId, attemptsUsed, maxAttempts, amount, category, retryEligible,
//         declineCode, noisyPaydayHint, bankId, currentDay, cycleState.
//   - Strictly shields and excludes hidden simulator traits:
//       * salaryDay, balanceDynamics, bankReliability, balance_volatility, etc.
//         are NEVER included in the cache key.
//   - Canonicalization sorts object keys recursively to ensure order-invariant hashing.
//   - Isolates replay, mock, and live cache entries so they are NEVER silently mixed.
//   - In 'replay' mode: misses fail explicitly rather than silently falling back to live Gemini.

import crypto from 'node:crypto';

export const DEFAULT_MODEL_NAME = 'gemini-2.0-flash';
export const DEFAULT_PROMPT_VERSION = 'v1.0';

/**
 * Public allowlisted fields that may be included in the canonical input.
 * All hidden simulator traits are omitted.
 */
export const ALLOWED_CANONICAL_KEYS = Object.freeze([
  'mandateId',
  'attemptsUsed',
  'maxAttempts',
  'amount',
  'category',
  'retryEligible',
  'declineCode',
  'noisyPaydayHint',
  'bankId',
  'currentDay',
  'cycleState',
]);

/**
 * Hidden traits that MUST NEVER appear in canonical input or cache keys.
 */
export const FORBIDDEN_HIDDEN_KEYS = Object.freeze([
  'salaryDay',
  'income_day_of_month',
  'balanceDynamics',
  'bankReliability',
  'balanceVolatility',
  'balance_volatility',
  'salaryMultiplier',
  'dailySpendFraction',
  'baselineBufferFraction',
  'volatilityNoiseScale',
]);

/**
 * Recursively sorts the keys of an object to ensure deterministic JSON serialization.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function deepSortKeys(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(deepSortKeys);
  }
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) {
      sorted[key] = deepSortKeys(value[key]);
    }
  }
  return sorted;
}

/**
 * Extracts and canonicalizes public observation / proposal input for caching.
 * Explicitly rejects and strips any hidden simulator traits.
 *
 * @param {object} rawInput
 * @returns {object} Canonical, sorted public input
 */
export function canonicalizeInput(rawInput = {}) {
  const input = rawInput?.observation || rawInput;
  const filtered = {};

  for (const key of ALLOWED_CANONICAL_KEYS) {
    if (input[key] !== undefined && input[key] !== null) {
      filtered[key] = input[key];
    }
  }

  // Double-check: ensure no forbidden hidden trait key is present
  for (const forbidden of FORBIDDEN_HIDDEN_KEYS) {
    if (forbidden in filtered) {
      delete filtered[forbidden];
    }
  }

  return deepSortKeys(filtered);
}

/**
 * Computes a deterministic SHA-256 cache key for an LLM request.
 *
 * @param {object} params
 * @param {object} params.canonicalInput - Raw or pre-canonicalized input object
 * @param {string} [params.modelName=DEFAULT_MODEL_NAME] - Model identifier
 * @param {string} [params.promptVersion=DEFAULT_PROMPT_VERSION] - Prompt version string
 * @returns {string} 64-character hex SHA-256 digest
 */
export function computeLLMCacheKey({
  canonicalInput,
  modelName = DEFAULT_MODEL_NAME,
  promptVersion = DEFAULT_PROMPT_VERSION,
}) {
  if (!canonicalInput || typeof canonicalInput !== 'object') {
    throw new Error('computeLLMCacheKey: canonicalInput must be a non-null object');
  }
  if (!modelName || typeof modelName !== 'string') {
    throw new Error('computeLLMCacheKey: modelName must be a non-empty string');
  }
  if (!promptVersion || typeof promptVersion !== 'string') {
    throw new Error('computeLLMCacheKey: promptVersion must be a non-empty string');
  }

  const canonicalObj = canonicalizeInput(canonicalInput);
  const serialized = JSON.stringify(canonicalObj);

  const hashPayload = `${serialized}:${modelName}:${promptVersion}`;
  return crypto.createHash('sha256').update(hashPayload).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Isolated Cache Stores
// ─────────────────────────────────────────────────────────────────────────────

/** Separate storage for replay cache entries (strictly isolated from live/mock) */
const _replayCache = new Map();

/** Separate storage for live recorded cache entries */
const _liveCache = new Map();

/**
 * Sets an entry in the replay cache.
 *
 * @param {string} cacheKey
 * @param {object} proposal
 * @param {object} [metadata]
 */
export function setReplayEntry(cacheKey, proposal, metadata = {}) {
  if (!cacheKey || typeof cacheKey !== 'string') {
    throw new Error('setReplayEntry: cacheKey must be a non-empty string');
  }
  if (!proposal || typeof proposal !== 'object') {
    throw new Error('setReplayEntry: proposal must be a non-null object');
  }

  _replayCache.set(cacheKey, {
    key: cacheKey,
    source: 'replay',
    proposal: Object.freeze({ ...proposal }),
    metadata: Object.freeze({ ...metadata }),
    storedAt: Date.now(),
  });
}

/**
 * Retrieves an entry from the replay cache.
 *
 * @param {string} cacheKey
 * @returns {object|null}
 */
export function getReplayEntry(cacheKey) {
  const entry = _replayCache.get(cacheKey);
  return entry ? entry.proposal : null;
}

/**
 * Checks if a key exists in the replay cache.
 *
 * @param {string} cacheKey
 * @returns {boolean}
 */
export function hasReplayEntry(cacheKey) {
  return _replayCache.has(cacheKey);
}

/**
 * Clears the replay cache.
 */
export function clearReplayCache() {
  _replayCache.clear();
}

/**
 * Returns the count of stored replay cache entries.
 *
 * @returns {number}
 */
export function getReplayCacheSize() {
  return _replayCache.size;
}

/**
 * Sets an entry in the live cache (never mixed with replay).
 *
 * @param {string} cacheKey
 * @param {object} proposal
 * @param {object} [metadata]
 */
export function setLiveCacheEntry(cacheKey, proposal, metadata = {}) {
  if (!cacheKey) return;
  _liveCache.set(cacheKey, {
    key: cacheKey,
    source: 'live',
    proposal: Object.freeze({ ...proposal }),
    metadata: Object.freeze({ ...metadata }),
    storedAt: Date.now(),
  });
}

/**
 * Retrieves an entry from the live cache.
 *
 * @param {string} cacheKey
 * @returns {object|null}
 */
export function getLiveCacheEntry(cacheKey) {
  const entry = _liveCache.get(cacheKey);
  return entry ? entry.proposal : null;
}

/**
 * Loads a batch of replay entries (e.g., fixtures or saved runs).
 *
 * @param {Record<string, object>|Array<{key: string, proposal: object}>} entries
 */
export function loadReplayCache(entries) {
  if (!entries) return;
  if (Array.isArray(entries)) {
    for (const item of entries) {
      if (item?.key && item?.proposal) {
        setReplayEntry(item.key, item.proposal, item.metadata);
      }
    }
  } else if (typeof entries === 'object') {
    for (const [key, proposal] of Object.entries(entries)) {
      setReplayEntry(key, proposal);
    }
  }
}
