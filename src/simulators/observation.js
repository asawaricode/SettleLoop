// src/simulators/observation.js
//
// Phase 4: Observation Boundary.
//
// Responsibilities:
//   - Constructs the arm-facing Observation object strictly from an ALLOWLIST.
//   - Completely shields all hidden simulator traits (salaryDay, balanceDynamics,
//     bankReliability, balanceVolatility, etc.) from recovery strategy arms.
//
// Explicit Constraints:
//   - Does NOT copy the full mandate or simulator object and delete fields.
//   - Deeply freezes the Observation so callers cannot mutate or attach hidden fields.
//   - Ensures that JSON.stringify(observation) contains only allowlisted keys.

export const OBSERVATION_ALLOWLIST = Object.freeze([
  'mandateId',
  'amount',
  'bankId',
  'currentDay',
  'cycleState',
  'attemptsUsed',
  'attemptHistory',
  'previousOutcomes',
  'declineCodes',
  'noisyPaydayHint',
]);

/**
 * Constructs an arm-facing Observation strictly from an allowlist.
 *
 * @param {object} params
 * @param {object} params.mandate           - Mandate database record or object
 * @param {number} params.currentDay        - Current virtual simulation day
 * @param {Array}  [params.attemptHistory]  - Past attempt records for this mandate
 * @returns {Readonly<{
 *   mandateId: string,
 *   amount: number,
 *   bankId: string,
 *   currentDay: number,
 *   cycleState: string,
 *   attemptsUsed: number,
 *   attemptHistory: ReadonlyArray<object>,
 *   previousOutcomes: ReadonlyArray<string>,
 *   declineCodes: ReadonlyArray<string>,
 *   noisyPaydayHint?: number | null
 * }>}
 */
export function buildObservation({
  mandate,
  currentDay,
  attemptHistory = [],
}) {
  if (!mandate) {
    throw new Error('buildObservation: mandate is required');
  }

  // 1. Sanitize attempt history to strictly allowlisted fields
  const safeHistory = Array.isArray(attemptHistory)
    ? attemptHistory.map((att) =>
        Object.freeze({
          attemptNumber: att.attempt_number ?? att.attemptNumber ?? 1,
          day: att.day ?? att.created_day ?? 0,
          outcome: att.outcome,
          declineCode: att.decline_code ?? att.declineCode ?? null,
          declineCategory: att.decline_category ?? att.declineCategory ?? null,
        })
      )
    : [];

  const previousOutcomes = safeHistory.map((h) => h.outcome).filter(Boolean);
  const declineCodes = safeHistory.map((h) => h.declineCode).filter(Boolean);

  // 2. Strict allowlist construction — only allowed fields are assigned
  const observation = {
    mandateId: mandate.mandate_id || mandate.id,
    amount: Number(mandate.amount) || 0,
    bankId: mandate.bank_id || mandate.bankId || 'BANK_01',
    currentDay: Number(currentDay) || 0,
    cycleState: mandate.status || 'pending',
    attemptsUsed: Number(mandate.attempts_used ?? safeHistory.length) || 0,
    attemptHistory: Object.freeze(safeHistory),
    previousOutcomes: Object.freeze(previousOutcomes),
    declineCodes: Object.freeze(declineCodes),
  };

  if (mandate.payday_hint !== undefined || mandate.noisyPaydayHint !== undefined) {
    observation.noisyPaydayHint = mandate.noisyPaydayHint ?? mandate.payday_hint ?? null;
  }

  return Object.freeze(observation);
}
