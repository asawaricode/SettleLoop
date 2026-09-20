// src/recovery/mandateTransitions.js
//
// Phase 2: Mandate Action Transition Validator.
//
// Responsibilities:
//   - Provide assertMandateAction(currentStatus, action) as a guard that must
//     be called before every set_mandate_action RPC invocation.
//   - Map set_mandate_action action strings to the resulting mandate status.
//   - Delegate transition legality to the existing assertTransition() from
//     mandateStateMachine.js (the authoritative lookup table).
//
// Explicitly does NOT:
//   - Call any RPC or write to the database.
//   - Duplicate or replace mandateStateMachine.js transition definitions.
//   - Change any simulation, retry, or recovery engine behavior.
//   - Introduce Postgres enums or domain types.
//   - Replace the existing state machine.

import { assertTransition, MANDATE_STATUS } from '../stateMachine/mandateStateMachine.js';

// ---------------------------------------------------------------------------
// Action -> Resulting status lookup table.
//
// Maps every valid set_mandate_action p_action string to the mandate status
// that will result from calling the RPC. This is the single authoritative
// place where action strings are translated to lifecycle status transitions
// for pre-call validation.
// ---------------------------------------------------------------------------

const ACTION_TO_RESULT_STATUS = Object.freeze({
  retry:        MANDATE_STATUS.PENDING,                  // stays pending, retry rescheduled
  stand_down:   MANDATE_STATUS.STOOD_DOWN,
  exhausted:    MANDATE_STATUS.EXHAUSTED,
  human_review: MANDATE_STATUS.PENDING_HUMAN_APPROVAL,   // documented; must NOT be called directly
});

/**
 * Asserts that calling set_mandate_action(action) is a legal transition
 * from the mandate's current status.
 *
 * Throws a descriptive error if:
 *   - action is not a known set_mandate_action action string.
 *   - The implied status transition is illegal per mandateStateMachine.js.
 *
 * For the 'retry' action the mandate stays in 'pending' status (only
 * next_action / next_action_day change). Since pending->pending is not in the
 * transition graph, this function validates directly that the current status
 * is 'pending' — the only status from which a retry may be scheduled.
 *
 * @param {string} currentStatus  Current mandates.status value.
 * @param {string} action         p_action string passed to set_mandate_action.
 * @throws {Error}                If the action is unknown or transition is illegal.
 */
export function assertMandateAction(currentStatus, action) {
  const resultStatus = ACTION_TO_RESULT_STATUS[action];

  if (resultStatus === undefined) {
    throw new Error(
      'assertMandateAction: unknown action ' + JSON.stringify(action) + '. ' +
      'Valid actions: ' + Object.keys(ACTION_TO_RESULT_STATUS).join(', ') + '.'
    );
  }

  // Special case: 'retry' keeps status as 'pending' (no status change).
  // Validate the mandate is currently pending so a retry can be scheduled.
  if (action === 'retry') {
    if (currentStatus !== MANDATE_STATUS.PENDING) {
      throw new Error(
        'assertMandateAction: cannot schedule retry from status ' +
        JSON.stringify(currentStatus) + '. ' +
        'Only pending mandates may be scheduled for retry.'
      );
    }
    return; // valid
  }

  // For all status-changing actions, delegate to the existing transition graph.
  assertTransition(currentStatus, resultStatus);
}
