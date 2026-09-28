// src/config/recoveryPolicy.js
//
// Phase 2: Central Recovery Policy Configuration.
//
// All values are configurable in one place. Each value carries an explicit
// evidence annotation matching ASSUMPTIONS.md:
//
//   SOURCED(rule)  — the value is directly supported by a reviewed primary source.
//                    Rule reference matches ASSUMPTIONS.md §3.
//   ASSUMED        — the value is a project-level policy decision with no
//                    primary regulatory source. Changing it changes only the
//                    simulator behaviour, not any regulatory fact.
//   SECONDARY_ONLY — the value is reported by secondary sources only; no primary
//                    document was reviewed (see ASSUMPTIONS.md §2).
//
// === REGULATORY REMINDERS ===
//
// A policy being enforced by the simulator/domain does NOT make it a sourced
// regulatory fact.  Do not remove evidence annotations.
//
// NPCI peak-hour windows (G-3) — SOURCED from NPCI/UPI/OC/215A/2025-26,
//   21 May 2025, continuation page bullet 3.
//   Verbatim: "Peak hours are defined as the period during the day when UPI
//   financial transactions reach the highest transactions per second, observed
//   from 10:00 hrs to 13:00 hrs and from 17:00 hrs to 21:30 hrs.
//   Any other time shall be referred as non-peak hour.
//   During peak hours, UPI members are required to restrict
//   non-customer-initiated APIs."
//
// NPCI attempt limit (Rule D) — not verified: specific table row was not
//   present in the supplied image extracts. See ASSUMPTIONS.md §3, Rule D.
//   Implemented here as ASSUMED project policy (1 initial + 3 retries = 4 max).
//
// Pre-debit notification (Rule A) — SECONDARY_ONLY; primary RBI circular
//   not reviewed. See ASSUMPTIONS.md §2, Rule A.
// ============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// §1  Attempt cap
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum total attempts per mandate (1 initial + 3 retries = 4).
 *  ASSUMED: Rule D (NPCI/UPI/OC/215A/2025-26 AutoPay retry limit) is not
 *  verified from an accessible primary-source image extract.
 *  This value is implemented as project policy.
 *
 *  @type {number}
 */
export const MAX_ATTEMPTS = 4; // ASSUMED — see ASSUMPTIONS.md §3 Rule D (not verified)

// ─────────────────────────────────────────────────────────────────────────────
// §2  Pre-debit notification window
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum hours from the applicable pre-debit notification timestamp to the
 *  allowed dispatch time (clock-time hours).
 *  SECONDARY_ONLY: mirrors the widely-reported RBI 24-hour pre-debit notice
 *  requirement, but primary circular text was not reviewed.
 *  See ASSUMPTIONS.md §2 Rule A.
 *
 *  IMPORTANT: This is SEPARATE from minRetryGapHours.
 *
 *  @type {number}
 */
export const preDebitNoticeMinHours = 24; // SECONDARY_ONLY — see ASSUMPTIONS.md §2 Rule A

// ─────────────────────────────────────────────────────────────────────────────
// §3  Minimum retry gap
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum elapsed time (clock-time hours) between successive retry attempts.
 *  ASSUMED: no primary-sourced minimum-gap regulation has been verified.
 *  This is a project design parameter; it is explicitly SEPARATE from the
 *  preDebitNoticeMinHours requirement.
 *
 *  0 = no enforced minimum gap beyond the notice requirement.
 *
 *  @type {number}
 */
export const minRetryGapHours = 0; // ASSUMED — see ASSUMPTIONS.md §7

// ─────────────────────────────────────────────────────────────────────────────
// §4  Fresh pre-debit notice per retry
// ─────────────────────────────────────────────────────────────────────────────

/** If true, a fresh pre-debit notification must be sent before each retry
 *  attempt (not just the initial attempt).
 *  ASSUMED: actual regulatory treatment of notices for retry attempts is not
 *  modelled in the simulator.
 *
 *  @type {boolean}
 */
export const freshNoticePerRetry = false; // ASSUMED — see ASSUMPTIONS.md §7

// ─────────────────────────────────────────────────────────────────────────────
// §5  Non-peak dispatch requirement
// ─────────────────────────────────────────────────────────────────────────────

/** If true, retry/attempt dispatch must be restricted to non-peak time slots.
 *  ASSUMED at the AutoPay-specific level: Rule E (AutoPay non-peak requirement)
 *  is not verified from accessible image extracts.
 *  The general restriction (G-3) — "during peak hours, UPI members are required
 *  to restrict non-customer-initiated APIs" — IS sourced. AutoPay debits are
 *  non-customer-initiated and therefore subject to G-3.
 *
 *  @type {boolean}
 */
export const retriesInNonPeakSlots = true; // ASSUMED (AutoPay-specific); G-3 is SOURCED

// ─────────────────────────────────────────────────────────────────────────────
// §6  Peak-hour windows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Timezone for all peak-hour evaluation.
 * ASSUMED: the boundary interpretation as "Asia/Kolkata" is a project policy.
 * The NPCI circular states hours without specifying a timezone; IST / Asia/Kolkata
 * is the natural interpretation.
 *
 * @type {string}
 */
export const PEAK_TIMEZONE = 'Asia/Kolkata'; // ASSUMED timezone interpretation

/**
 * NPCI-sourced peak windows.
 *
 * Sourced: NPCI/UPI/OC/215A/2025-26, 21 May 2025, continuation page bullet 3.
 * Verbatim: "…observed from 10:00 hrs to 13:00 hrs and from 17:00 hrs to 21:30 hrs."
 *
 * Boundary semantics (ASSUMED): start inclusive, end exclusive.
 *   10:00 → peak, 13:00 → non-peak, 17:00 → peak, 21:30 → non-peak.
 *
 * Each entry: { startHour: number, startMin: number, endHour: number, endMin: number }
 * Values represent IST (Asia/Kolkata) wall-clock time.
 *
 * @type {ReadonlyArray<{startHour:number, startMin:number, endHour:number, endMin:number}>}
 */
export const PEAK_WINDOWS = Object.freeze([
  // SOURCED from NPCI/UPI/OC/215A/2025-26 — 10:00–13:00
  { startHour: 10, startMin: 0, endHour: 13, endMin: 0 },
  // SOURCED from NPCI/UPI/OC/215A/2025-26 — 17:00–21:30
  { startHour: 17, startMin: 0, endHour: 21, endMin: 30 },
]);

// ─────────────────────────────────────────────────────────────────────────────
// §7  Proposal timing constraints
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum allowed delayDays in a retry proposal. ASSUMED.
 *  @type {number}
 */
export const MAX_DELAY_DAYS = 7; // ASSUMED — project design parameter

/** Minimum confidence threshold for a retry proposal to be allowed.
 *  ASSUMED — project design parameter.
 *  @type {number}
 */
export const CONFIDENCE_THRESHOLD = 0.70; // ASSUMED — project design parameter

// ─────────────────────────────────────────────────────────────────────────────
// §8  Convenience export: full policy object (typed snapshot)
// ─────────────────────────────────────────────────────────────────────────────

/** Complete recovery policy snapshot. Freeze prevents accidental mutation. */
export const RECOVERY_POLICY = Object.freeze({
  MAX_ATTEMPTS,
  preDebitNoticeMinHours,
  minRetryGapHours,
  freshNoticePerRetry,
  retriesInNonPeakSlots,
  PEAK_TIMEZONE,
  PEAK_WINDOWS,
  MAX_DELAY_DAYS,
  CONFIDENCE_THRESHOLD,
});
