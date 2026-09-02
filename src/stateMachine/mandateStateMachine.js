// src/stateMachine/mandateStateMachine.js
//
// Mandate State Machine — validates legal mandate lifecycle transitions.
//
// Responsibilities:
//   - Define the complete valid transition graph.
//   - Provide canTransition() for boolean checks.
//   - Provide assertTransition() for throwing validation.
//   - Document which existing RPC owns the persistence of each transition.
//
// Explicitly does NOT:
//   - Write to the database.
//   - Call any RPC.
//   - Update mandates.status directly.
//   - Contain payment, retry, AI, clock, or recovery-engine logic.
//   - Introduce new mandate statuses or next_action values.

// ─────────────────────────────────────────────────────────────────────────────
// Mandate statuses
// These are the only valid values for mandates.status in the database.
// ─────────────────────────────────────────────────────────────────────────────

export const MANDATE_STATUS = Object.freeze({
  PENDING:                "pending",
  PENDING_HUMAN_APPROVAL: "pending_human_approval",
  RECOVERED:              "recovered",
  STOOD_DOWN:             "stood_down",
  EXHAUSTED:              "exhausted",
});

// ─────────────────────────────────────────────────────────────────────────────
// Terminal states
// Once a mandate reaches one of these statuses it can never transition again.
// ─────────────────────────────────────────────────────────────────────────────

export const TERMINAL_STATUSES = Object.freeze(new Set([
  MANDATE_STATUS.RECOVERED,
  MANDATE_STATUS.STOOD_DOWN,
  MANDATE_STATUS.EXHAUSTED,
]));

// ─────────────────────────────────────────────────────────────────────────────
// Valid next_action values (kept separate from status)
// There is no next_action = 'exhausted'.
// ─────────────────────────────────────────────────────────────────────────────

export const NEXT_ACTION = Object.freeze({
  RETRY:        "retry",
  HUMAN_REVIEW: "human_review",
  STAND_DOWN:   "stand_down",
  NONE:         "none",
});

// ─────────────────────────────────────────────────────────────────────────────
// Transition ownership map
//
// For each valid (from → to) pair:
//   - `valid`: true
//   - `owner`: which existing RPC (or application layer) is responsible for
//              persisting this transition in the database.
//   - `notes`: clarifies usage rules.
//
// The state machine validates transitions; it does NOT execute them.
// ─────────────────────────────────────────────────────────────────────────────

const TRANSITIONS = Object.freeze({

  // ── pending ─────────────────────────────────────────────────────────────

  [`${MANDATE_STATUS.PENDING}→${MANDATE_STATUS.RECOVERED}`]: {
    valid: true,
    owner: "complete_attempt(p_attempt_id, p_outcome='success')",
    notes: "Persisted by complete_attempt() when payment outcome is 'success'. " +
           "The state machine must not independently update mandates to 'recovered'.",
  },

  [`${MANDATE_STATUS.PENDING}→${MANDATE_STATUS.STOOD_DOWN}`]: {
    valid: true,
    owner: "set_mandate_action(p_run_id, p_mandate_id, p_action='stand_down'[, p_action_day, p_reason])",
    notes: "Recovery Engine calls set_mandate_action with action='stand_down'. " +
           "The RPC updates mandates.status and mandates.next_action.",
  },

  [`${MANDATE_STATUS.PENDING}→${MANDATE_STATUS.EXHAUSTED}`]: {
    valid: true,
    owner: "set_mandate_action(p_run_id, p_mandate_id, p_action='exhausted'[, p_action_day, p_reason])",
    notes: "Recovery Engine calls set_mandate_action with action='exhausted' after " +
           "the maximum attempt limit is reached. The state machine does not decide when " +
           "a mandate is exhausted — that determination is made by the caller.",
  },

  [`${MANDATE_STATUS.PENDING}→${MANDATE_STATUS.PENDING_HUMAN_APPROVAL}`]: {
    valid: true,
    owner: "create_approval_request(p_run_id, p_mandate_id, p_created_day, p_expires_day, p_proposed_action)",
    notes: "Persisted by create_approval_request(). The RPC moves the mandate to " +
           "'pending_human_approval'. set_mandate_action MUST NOT be called with " +
           "'human_review' to trigger this transition.",
  },

  // ── pending_human_approval ───────────────────────────────────────────────

  [`${MANDATE_STATUS.PENDING_HUMAN_APPROVAL}→${MANDATE_STATUS.PENDING}`]: {
    valid: true,
    owner: "resolve_approval(p_approval_id, p_decision='approved', p_decided_by, p_decided_day[, p_decision_reason])",
    notes: "When a human approves the request, resolve_approval() returns the mandate " +
           "to 'pending' so the Recovery Engine can schedule a retry.",
  },

  [`${MANDATE_STATUS.PENDING_HUMAN_APPROVAL}→${MANDATE_STATUS.STOOD_DOWN}`]: {
    valid: true,
    owner: "resolve_approval(p_approval_id, p_decision='rejected', p_decided_by, p_decided_day[, p_decision_reason])",
    notes: "When a human rejects the request, resolve_approval() transitions the " +
           "mandate to 'stood_down'.",
  },

  // Terminal states have no outgoing transitions (enforced by canTransition).
});

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return true if transitioning from `fromStatus` to `toStatus` is a valid
 * lifecycle transition for a mandate.
 *
 * Returns false (never throws) for:
 *   - Unknown status values
 *   - Transitions from terminal states
 *   - Any other transition not in the explicit valid set
 *
 * @param {string} fromStatus
 * @param {string} toStatus
 * @returns {boolean}
 */
export function canTransition(fromStatus, toStatus) {
  // Unknown statuses are not valid endpoints for any transition.
  const allStatuses = new Set(Object.values(MANDATE_STATUS));
  if (!allStatuses.has(fromStatus) || !allStatuses.has(toStatus)) {
    return false;
  }

  // Terminal states have no valid outgoing transitions.
  if (TERMINAL_STATUSES.has(fromStatus)) {
    return false;
  }

  const key = `${fromStatus}→${toStatus}`;
  return TRANSITIONS[key]?.valid === true;
}

/**
 * Assert that transitioning from `fromStatus` to `toStatus` is valid.
 * Throws a descriptive error if the transition is illegal.
 *
 * @param {string} fromStatus
 * @param {string} toStatus
 * @throws {Error} if the transition is not permitted
 */
export function assertTransition(fromStatus, toStatus) {
  const allStatuses = new Set(Object.values(MANDATE_STATUS));

  if (!allStatuses.has(fromStatus)) {
    throw new Error(
      `mandateStateMachine: unknown fromStatus '${fromStatus}'. ` +
      `Valid statuses: ${[...allStatuses].join(", ")}`
    );
  }
  if (!allStatuses.has(toStatus)) {
    throw new Error(
      `mandateStateMachine: unknown toStatus '${toStatus}'. ` +
      `Valid statuses: ${[...allStatuses].join(", ")}`
    );
  }
  if (TERMINAL_STATUSES.has(fromStatus)) {
    throw new Error(
      `mandateStateMachine: '${fromStatus}' is a terminal status — ` +
      `no further transitions are permitted.`
    );
  }

  const key = `${fromStatus}→${toStatus}`;
  if (TRANSITIONS[key]?.valid !== true) {
    throw new Error(
      `mandateStateMachine: illegal transition '${fromStatus}' → '${toStatus}'.`
    );
  }
}

/**
 * Return the ownership information for a valid transition.
 * Returns null if the transition is invalid.
 *
 * @param {string} fromStatus
 * @param {string} toStatus
 * @returns {{ owner: string, notes: string } | null}
 */
export function getTransitionOwner(fromStatus, toStatus) {
  if (!canTransition(fromStatus, toStatus)) return null;
  const entry = TRANSITIONS[`${fromStatus}→${toStatus}`];
  return { owner: entry.owner, notes: entry.notes };
}

/**
 * Return all valid transitions from the given status.
 *
 * @param {string} fromStatus
 * @returns {string[]} array of valid toStatus values
 */
export function validTransitionsFrom(fromStatus) {
  return Object.entries(TRANSITIONS)
    .filter(([key, val]) => key.startsWith(`${fromStatus}→`) && val.valid)
    .map(([key]) => key.split("→")[1]);
}
