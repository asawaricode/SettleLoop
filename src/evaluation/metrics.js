// src/evaluation/metrics.js
//
// Step 16: Metrics and Evaluation Layer for the Razorpay Payment Recovery System.
//
// Responsibilities:
//   - Pure read-only evaluation of persisted simulation data from Supabase.
//   - Calculate recovery performance metrics grouped by experiment arm (control, baseline, smart).
//   - Calculate Smart recovery lift (absolute percentage-points and relative lift).
//   - Audit safety invariant violations:
//       * hardDeclineRetryViolations (retrying after hard/unknown decline or retry_eligible === false)
//       * duplicateAttemptViolations (duplicate mandate+attempt_number or idempotency_key)
//       * consentViolations (payment_link executed without contact consent)
//       * notificationViolations (notification sent without contact consent)
//   - Enforce exact numeric precision (rounded to 4 decimal places, no NaN/Infinity).
//
// Explicitly does NOT:
//   - Execute payments, call execute_attempt() or complete_attempt().
//   - Create attempts, mandates, or approval requests.
//   - Modify any table or database state.
//   - Make external AI/API calls or add dependencies.

import { supabase } from '../config/supabase.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rounds a numeric value to 4 decimal places.
 * Returns 0 if value is not finite (protects against NaN / Infinity).
 *
 * @param {number|null|undefined} val
 * @returns {number|null}
 */
export function round4(val) {
  if (val === null || val === undefined) return null;
  if (!Number.isFinite(val)) return 0;
  const rounded = Math.round(val * 10000) / 10000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Creates a lift comparison object with both absolute and relative lift.
 * Implements valueOf() returning absolute lift for dual object/scalar compatibility.
 */
function createLiftValue(absolute, relative) {
  const roundedAbs = round4(absolute);
  const roundedRel = relative === null ? null : round4(relative);

  return {
    absolute: roundedAbs,
    relative: roundedRel,
    valueOf() {
      return roundedAbs;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retrieves and calculates comprehensive recovery and safety metrics for a simulation run.
 *
 * @param {object} params
 * @param {string} params.runId - simulation_runs.id UUID (required)
 *
 * @returns {Promise<{
 *   runId: string,
 *   arms: {
 *     control: object,
 *     baseline: object,
 *     smart: object
 *   },
 *   lift: {
 *     vsControl: object,
 *     vsBaseline: object
 *   },
 *   safety: {
 *     hardDeclineRetryViolations: number,
 *     duplicateAttemptViolations: number,
 *     consentViolations: number,
 *     notificationViolations: number,
 *     totalViolations: number,
 *     safe: boolean
 *   }
 * }>}
 */
export async function getSimulationMetrics({ runId }) {
  if (!runId || typeof runId !== 'string' || runId.trim() === '') {
    throw new Error('getSimulationMetrics: runId must be a non-empty string');
  }

  // 1. Verify simulation run exists
  const { data: run, error: runErr } = await supabase
    .from('simulation_runs')
    .select('id, current_day, max_days, status')
    .eq('id', runId)
    .single();

  if (runErr || !run) {
    throw new Error(`getSimulationMetrics: simulation run ${runId} not found`);
  }

  // 2. Read mandates for this run
  const { data: mandates, error: mErr } = await supabase
    .from('mandates')
    .select(
      'id, mandate_id, run_id, experiment_arm, amount, status, first_due_day, attempts_used, contact_consent'
    )
    .eq('run_id', runId);

  if (mErr) {
    throw new Error(`getSimulationMetrics: failed to fetch mandates: ${mErr.message}`);
  }

  // 3. Read attempts for this run
  const { data: attempts, error: aErr } = await supabase
    .from('attempts')
    .select(
      'id, mandate_id, attempt_number, scheduled_day, executed_day, channel, outcome, decline_category, retry_eligible, idempotency_key, notification_sent_day, notification_message'
    )
    .eq('run_id', runId);

  if (aErr) {
    throw new Error(`getSimulationMetrics: failed to fetch attempts: ${aErr.message}`);
  }

  const mandateMap = new Map((mandates || []).map((m) => [m.id, m]));

  // Group executed attempts by mandate_id
  const attemptsByMandate = new Map();
  for (const attempt of attempts || []) {
    if (!attemptsByMandate.has(attempt.mandate_id)) {
      attemptsByMandate.set(attempt.mandate_id, []);
    }
    attemptsByMandate.get(attempt.mandate_id).push(attempt);
  }

  // ── 4. Arm-Level Metrics ──────────────────────────────────────────────────

  const armNames = ['control', 'baseline', 'smart'];
  const arms = {};

  for (const arm of armNames) {
    const armMandates = (mandates || []).filter((m) => m.experiment_arm === arm);
    const mandateCount = armMandates.length;

    let recoveredCount = 0;
    let totalAmount = 0;
    let recoveredAmount = 0;
    let attemptsTotal = 0;
    const timeToRecoveryList = [];

    for (const m of armMandates) {
      const amount = Number(m.amount) || 0;
      totalAmount += amount;

      const mAttempts = attemptsByMandate.get(m.id) || [];
      // Do not count pending attempts as executed attempts
      const executedAttempts = mAttempts.filter(
        (a) => a.executed_day !== null && a.outcome !== 'pending'
      );
      attemptsTotal += executedAttempts.length;

      if (m.status === 'recovered') {
        recoveredCount++;
        recoveredAmount += amount;

        // Determine recovery day from successful attempt's executed_day
        const successfulAttempt = executedAttempts.find((a) => a.outcome === 'success');
        if (successfulAttempt && successfulAttempt.executed_day !== null) {
          const firstDueDay = Number(m.first_due_day) || 0;
          const timeToRecovery = successfulAttempt.executed_day - firstDueDay;
          timeToRecoveryList.push(timeToRecovery);
        }
      }
    }

    const recoveryRate = mandateCount > 0 ? round4(recoveredCount / mandateCount) : 0;
    const attemptsPerMandate = mandateCount > 0 ? round4(attemptsTotal / mandateCount) : 0;
    const attemptsPerRecovery = recoveredCount > 0 ? round4(attemptsTotal / recoveredCount) : 0;

    let averageTimeToRecovery = 0;
    if (timeToRecoveryList.length > 0) {
      const sumTime = timeToRecoveryList.reduce((acc, t) => acc + t, 0);
      averageTimeToRecovery = round4(sumTime / timeToRecoveryList.length);
    }

    arms[arm] = {
      mandateCount,
      recoveredCount,
      recoveryRate,
      totalAmount: round4(totalAmount),
      recoveredAmount: round4(recoveredAmount),
      attemptsTotal,
      attemptsPerMandate,
      attemptsPerRecovery,
      averageTimeToRecovery,
    };
  }

  // ── 5. Recovery Lift ──────────────────────────────────────────────────────

  const smartRate = arms.smart.recoveryRate;
  const controlRate = arms.control.recoveryRate;
  const baselineRate = arms.baseline.recoveryRate;

  const vsControlAbs = smartRate - controlRate;
  const vsControlRel = controlRate === 0 ? null : (smartRate - controlRate) / controlRate;

  const vsBaselineAbs = smartRate - baselineRate;
  const vsBaselineRel = baselineRate === 0 ? null : (smartRate - baselineRate) / baselineRate;

  const lift = {
    vsControl: createLiftValue(vsControlAbs, vsControlRel),
    vsBaseline: createLiftValue(vsBaselineAbs, vsBaselineRel),
  };

  // Embed lift into smart arm as well for caller convenience
  arms.smart.lift = lift;

  // ── 6. Safety Metrics ─────────────────────────────────────────────────────

  let hardDeclineRetryViolations = 0;
  let duplicateAttemptViolations = 0;
  let consentViolations = 0;
  let notificationViolations = 0;

  // 6a. hardDeclineRetryViolations:
  // For each mandate, sort attempts by attempt_number.
  // For attempt N > 1, if attempt (N-1) had decline_category in ('hard', 'unknown')
  // or retry_eligible === false, executing attempt N is a violation.
  for (const [mandateId, mAttempts] of attemptsByMandate.entries()) {
    const executedAttempts = mAttempts
      .filter((a) => a.executed_day !== null && a.outcome !== 'pending')
      .sort((a, b) => (a.attempt_number || 0) - (b.attempt_number || 0));

    for (let i = 1; i < executedAttempts.length; i++) {
      const prevAttempt = executedAttempts[i - 1];
      const prevCategory = prevAttempt.decline_category;
      const prevRetryEligible = prevAttempt.retry_eligible;

      if (
        prevCategory === 'hard' ||
        prevCategory === 'unknown' ||
        prevRetryEligible === false
      ) {
        hardDeclineRetryViolations++;
      }
    }
  }

  // 6b. duplicateAttemptViolations:
  // Detect duplicate attempts for same mandate + attempt_number or duplicate idempotency keys.
  const seenMandateAttempt = new Set();
  const seenIdempotency = new Set();

  for (const attempt of attempts || []) {
    let isDuplicate = false;

    if (attempt.mandate_id && attempt.attempt_number !== undefined && attempt.attempt_number !== null) {
      const maKey = `${attempt.mandate_id}:${attempt.attempt_number}`;
      if (seenMandateAttempt.has(maKey)) {
        isDuplicate = true;
      } else {
        seenMandateAttempt.add(maKey);
      }
    }

    if (attempt.idempotency_key) {
      if (seenIdempotency.has(attempt.idempotency_key)) {
        isDuplicate = true;
      } else {
        seenIdempotency.add(attempt.idempotency_key);
      }
    }

    if (isDuplicate) {
      duplicateAttemptViolations++;
    }
  }

  // 6c. consentViolations & 6d. notificationViolations:
  for (const attempt of attempts || []) {
    const mandate = mandateMap.get(attempt.mandate_id);
    const contactConsent = mandate?.contact_consent;

    // consentViolations: payment_link executed when contact_consent = false
    if (attempt.channel === 'payment_link' && contactConsent === false) {
      consentViolations++;
    }

    // notificationViolations: notification sent despite contact_consent = false
    const notificationSent =
      attempt.notification_sent_day !== null && attempt.notification_sent_day !== undefined;
    if (notificationSent && contactConsent === false) {
      notificationViolations++;
    }
  }

  const totalViolations =
    hardDeclineRetryViolations +
    duplicateAttemptViolations +
    consentViolations +
    notificationViolations;

  const safety = {
    hardDeclineRetryViolations,
    duplicateAttemptViolations,
    consentViolations,
    notificationViolations,
    totalViolations,
    safe: totalViolations === 0,
  };

  return {
    runId,
    arms,
    lift,
    safety,
  };
}
