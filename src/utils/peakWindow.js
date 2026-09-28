// src/utils/peakWindow.js
//
// Phase 2: Peak-window evaluation utility.
//
// Evaluates whether a given wall-clock time falls inside a NPCI-sourced
// peak window (G-3: 10:00–13:00 or 17:00–21:30 IST).
//
// Responsibilities:
//   - Accept a Date object or ISO timestamp string.
//   - Convert to Asia/Kolkata time.
//   - Return whether that time is peak or non-peak.
//   - Accept configurable windows (defaults from recoveryPolicy).
//
// Explicitly does NOT:
//   - Use Date.now() for simulator-domain timing.
//   - Read the database.
//   - Enforce dispatch — evaluation only.
//
// Evidence:
//   Peak windows are SOURCED from NPCI/UPI/OC/215A/2025-26, 21 May 2025,
//   continuation page bullet 3.
//   The timezone interpretation as Asia/Kolkata is ASSUMED project policy.
//   Boundary semantics (start inclusive, end exclusive) is ASSUMED.

import { PEAK_WINDOWS, PEAK_TIMEZONE } from '../config/recoveryPolicy.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract wall-clock hours and minutes for the given Date in the given timezone.
 *
 * Uses Intl.DateTimeFormat which is part of the ECMAScript Internationalization
 * API — no external library required.
 *
 * @param {Date}   date     - A valid Date object (any UTC instant).
 * @param {string} timezone - IANA timezone identifier (e.g., 'Asia/Kolkata').
 * @returns {{ hour: number, minute: number }}
 */
function extractHourMinute(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour:   'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date);

  let hour   = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === 'hour')   hour   = parseInt(part.value, 10);
    if (part.type === 'minute') minute = parseInt(part.value, 10);
  }
  // Intl formats midnight as 24 in some locales; normalise.
  if (hour === 24) hour = 0;
  return { hour, minute };
}

/**
 * Check whether (hour, minute) falls inside the given window using
 * start-inclusive, end-exclusive semantics.
 *
 * @param {number} hour
 * @param {number} minute
 * @param {{ startHour:number, startMin:number, endHour:number, endMin:number }} window
 * @returns {boolean}
 */
function inWindow(hour, minute, { startHour, startMin, endHour, endMin }) {
  // Convert to total minutes for simple comparison.
  const t     = hour * 60 + minute;
  const start = startHour * 60 + startMin;
  const end   = endHour   * 60 + endMin;
  return t >= start && t < end;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine whether `dateOrIso` falls in a NPCI peak window.
 *
 * IMPORTANT: The simulator operates in virtual-day granularity.
 * This function is used when a wall-clock timestamp IS available (e.g., for
 * real-time dispatch scheduling or for tests that supply an explicit
 * wall-clock time).  It must NOT be called with Date.now() in simulator code
 * paths that operate in virtual-day space.
 *
 * @param {Date|string} dateOrIso  - Wall-clock instant (UTC Date or ISO string).
 * @param {object}      [options]
 * @param {string}      [options.timezone=PEAK_TIMEZONE] - IANA timezone.
 * @param {ReadonlyArray} [options.windows=PEAK_WINDOWS] - Array of window configs.
 * @returns {boolean}  true if the instant is inside a peak window.
 */
export function isPeakTime(dateOrIso, options = {}) {
  const timezone = options.timezone ?? PEAK_TIMEZONE;
  const windows  = options.windows  ?? PEAK_WINDOWS;

  const date = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);

  if (isNaN(date.getTime())) {
    throw new TypeError(`isPeakTime: invalid date/ISO string — "${dateOrIso}"`);
  }

  const { hour, minute } = extractHourMinute(date, timezone);
  return windows.some(w => inWindow(hour, minute, w));
}

/**
 * Determine whether `dateOrIso` is a NON-peak time.
 * Convenience inverse of isPeakTime().
 *
 * @param {Date|string} dateOrIso
 * @param {object}      [options]
 * @returns {boolean}
 */
export function isNonPeakTime(dateOrIso, options = {}) {
  return !isPeakTime(dateOrIso, options);
}

/**
 * Build a human-readable description of the configured peak windows.
 * Used for error messages and audit logging.
 *
 * @param {ReadonlyArray} [windows=PEAK_WINDOWS]
 * @param {string}        [timezone=PEAK_TIMEZONE]
 * @returns {string}
 */
export function describePeakWindows(windows = PEAK_WINDOWS, timezone = PEAK_TIMEZONE) {
  const parts = windows.map(
    ({ startHour, startMin, endHour, endMin }) =>
      `${String(startHour).padStart(2,'0')}:${String(startMin).padStart(2,'0')}` +
      `–` +
      `${String(endHour).padStart(2,'0')}:${String(endMin).padStart(2,'0')}`
  );
  return `${parts.join(' and ')} ${timezone} (start inclusive, end exclusive)`;
}
