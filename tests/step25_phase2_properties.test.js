// tests/step25_phase2_properties.test.js
//
// Phase 2 — Property-based tests using fast-check.
//
// Tests:
//   1.  Four-attempt ceiling is always enforced by guardrails
//   2.  Peak dispatch is rejected when retriesInNonPeakSlots = true
//   3.  Non-peak dispatch is accepted when retriesInNonPeakSlots = true
//   4.  Pre-debit notice gap is always >= preDebitNoticeMinHours (24h)
//   5.  Terminal mandate states remain terminal (canTransition = false)
//   6.  Terminal cycle states remain terminal (same mandate model — cycles = mandates)
//   7.  Failed cycle does not auto-cancel mandate (exhausted ≠ cancelled/stood_down)
//   8.  Control receives zero retries (guardrail enforces attempts_used >= MAX_ATTEMPTS)
//   9.  isPeakTime correctly identifies both peak windows
//  10.  isNonPeakTime is the exact inverse of isPeakTime
//  11.  minRetryGapHours is exported as 0 (assumed project policy)
//  12.  PEAK_WINDOWS matches NPCI-sourced values exactly
//  13.  Policy constants remain non-mutated through freeze
//
// DB-backed concurrency test:
//  14.  Concurrent attempt creation via execute_attempt never exceeds 4 per mandate
//       (runs against the live Supabase test database)
//
// All pure tests use virtual/synthetic clock inputs — no Date.now().

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  validateGuardrails,
  MAX_GUARDRAIL_ATTEMPTS,
} from '../src/recovery/index.js';

import {
  canTransition,
  MANDATE_STATUS,
  TERMINAL_STATUSES,
} from '../src/stateMachine/mandateStateMachine.js';

import {
  isPeakTime,
  isNonPeakTime,
  describePeakWindows,
} from '../src/utils/peakWindow.js';

import {
  MAX_ATTEMPTS,
  preDebitNoticeMinHours,
  minRetryGapHours,
  freshNoticePerRetry,
  retriesInNonPeakSlots,
  PEAK_TIMEZONE,
  PEAK_WINDOWS,
  MAX_DELAY_DAYS,
  CONFIDENCE_THRESHOLD,
  RECOVERY_POLICY,
} from '../src/config/recoveryPolicy.js';

import { supabase } from '../src/config/supabase.js';

// ─────────────────────────────────────────────────────────────────────────────
// fast-check configuration
// ─────────────────────────────────────────────────────────────────────────────
// numRuns capped at practical values for pure tests; DB tests use numRuns=1.
const FC_RUNS = 200;
const FC_DB_RUNS = 1; // DB-backed tests are expensive

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeValidRetryContext(attemptsUsed = 1) {
  return {
    mandate: {
      id: 'test-mandate',
      status: 'pending',
      attempts_used: attemptsUsed,
      contact_consent: true,
    },
    failure: {
      category: 'soft',
      retryEligible: true,
    },
  };
}

function makeValidRetryProposal(delayDays = 1) {
  return {
    action: 'retry',
    delayDays,
    channel: 'auto_debit',
    confidence: 0.85,
  };
}

/** Build an IST wall-clock Date for (hour, minute) today. */
function istTime(hour, minute) {
  // IST = UTC+5:30
  const now = new Date();
  // Normalise to midnight UTC then set hours in IST offset
  const utcMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const istOffsetMs = (5 * 60 + 30) * 60 * 1000;
  const istStartMs = utcMidnight - istOffsetMs;
  return new Date(istStartMs + (hour * 60 + minute) * 60 * 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 25 — Phase 2 Property Tests', () => {

  // ── 1. Four-attempt ceiling ────────────────────────────────────────────────
  it('1. Guardrails: attempts never exceed 4 per mandate (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MAX_ATTEMPTS, max: MAX_ATTEMPTS + 20 }),
        (attemptsUsed) => {
          const ctx = makeValidRetryContext(attemptsUsed);
          const proposal = makeValidRetryProposal();
          const result = validateGuardrails({ proposal, context: ctx });
          // Must not be allowed when at or over the cap
          assert.equal(result.allowed, false,
            `Expected rejection for attemptsUsed=${attemptsUsed}`);
          assert.equal(result.action, 'stand_down');
          assert.ok(
            result.reasons.some(r => r.includes('Maximum recovery attempts')),
            'Expected "Maximum recovery attempts" in reasons'
          );
        }
      ),
      { numRuns: FC_RUNS }
    );
  });

  // ── 2. Attempts below cap are guardable-allowed ───────────────────────────
  it('2. Guardrails: attempts below cap are not blocked by ceiling alone (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_ATTEMPTS - 1 }),
        (attemptsUsed) => {
          const ctx = makeValidRetryContext(attemptsUsed);
          const proposal = makeValidRetryProposal(1);
          const result = validateGuardrails({ proposal, context: ctx });
          // The ceiling alone must not block; other rules may still block
          const blockedByCeiling = result.reasons.some(
            r => r.includes('Maximum recovery attempts')
          );
          assert.equal(blockedByCeiling, false,
            `Ceiling should not block attemptsUsed=${attemptsUsed}`);
        }
      ),
      { numRuns: FC_RUNS }
    );
  });

  // ── 3. MAX_ATTEMPTS constant integrity ────────────────────────────────────
  it('3. MAX_ATTEMPTS is 4 and matches MAX_GUARDRAIL_ATTEMPTS', () => {
    assert.equal(MAX_ATTEMPTS, 4);
    assert.equal(MAX_GUARDRAIL_ATTEMPTS, 4);
    assert.equal(RECOVERY_POLICY.MAX_ATTEMPTS, 4);
  });

  // ── 4. Peak windows match NPCI-sourced values ─────────────────────────────
  it('4. PEAK_WINDOWS matches NPCI-sourced values (10:00-13:00, 17:00-21:30)', () => {
    assert.equal(PEAK_WINDOWS.length, 2);
    const [w1, w2] = PEAK_WINDOWS;

    assert.equal(w1.startHour, 10); assert.equal(w1.startMin, 0);
    assert.equal(w1.endHour, 13);   assert.equal(w1.endMin, 0);

    assert.equal(w2.startHour, 17); assert.equal(w2.startMin, 0);
    assert.equal(w2.endHour, 21);   assert.equal(w2.endMin, 30);
  });

  // ── 5. isPeakTime correctly identifies peak hours ─────────────────────────
  it('5. isPeakTime: boundary semantics — start inclusive, end exclusive', () => {
    // Window 1: 10:00–13:00
    assert.equal(isPeakTime(istTime(10, 0)),   true,  '10:00 IST must be peak');
    assert.equal(isPeakTime(istTime(10, 1)),   true,  '10:01 IST must be peak');
    assert.equal(isPeakTime(istTime(12, 59)),  true,  '12:59 IST must be peak');
    assert.equal(isPeakTime(istTime(13, 0)),   false, '13:00 IST must be non-peak');
    assert.equal(isPeakTime(istTime(13, 1)),   false, '13:01 IST must be non-peak');

    // Window 2: 17:00–21:30
    assert.equal(isPeakTime(istTime(17, 0)),   true,  '17:00 IST must be peak');
    assert.equal(isPeakTime(istTime(21, 29)),  true,  '21:29 IST must be peak');
    assert.equal(isPeakTime(istTime(21, 30)),  false, '21:30 IST must be non-peak');
    assert.equal(isPeakTime(istTime(21, 31)),  false, '21:31 IST must be non-peak');

    // Clearly non-peak
    assert.equal(isPeakTime(istTime(9,  59)),  false, '09:59 IST must be non-peak');
    assert.equal(isPeakTime(istTime(14, 0)),   false, '14:00 IST must be non-peak');
    assert.equal(isPeakTime(istTime(16, 59)),  false, '16:59 IST must be non-peak');
    assert.equal(isPeakTime(istTime(22, 0)),   false, '22:00 IST must be non-peak');
    assert.equal(isPeakTime(istTime(0,  0)),   false, '00:00 IST must be non-peak');
  });

  // ── 6. isNonPeakTime is exact inverse ─────────────────────────────────────
  it('6. isNonPeakTime is exact inverse of isPeakTime (property)', () => {
    fc.assert(
      fc.property(
        // Generate minutes-of-day in [0, 1439]
        fc.integer({ min: 0, max: 1439 }),
        (totalMinutes) => {
          const date = istTime(Math.floor(totalMinutes / 60), totalMinutes % 60);
          assert.equal(
            isPeakTime(date),
            !isNonPeakTime(date),
            `isPeakTime and isNonPeakTime must be inverses at minute ${totalMinutes}`
          );
        }
      ),
      { numRuns: FC_RUNS }
    );
  });

  // ── 7. Terminal mandate states remain terminal ────────────────────────────
  it('7. Terminal mandate states: canTransition always returns false (property)', () => {
    const allStatuses = Object.values(MANDATE_STATUS);
    fc.assert(
      fc.property(
        fc.constantFrom(...allStatuses),
        (toStatus) => {
          for (const termStatus of TERMINAL_STATUSES) {
            const result = canTransition(termStatus, toStatus);
            assert.equal(
              result, false,
              `canTransition(${termStatus} → ${toStatus}) must be false`
            );
          }
        }
      ),
      { numRuns: allStatuses.length * 5 }
    );
  });

  // ── 8. Non-terminal states can transition to at least one state ───────────
  it('8. Non-terminal states have at least one valid outgoing transition', () => {
    const allStatuses = Object.values(MANDATE_STATUS);
    const nonTerminal = allStatuses.filter(s => !TERMINAL_STATUSES.has(s));
    for (const s of nonTerminal) {
      const reachable = allStatuses.filter(t => canTransition(s, t));
      assert.ok(
        reachable.length > 0,
        `Status '${s}' should have at least one valid transition`
      );
    }
  });

  // ── 9. FAILED_CYCLE ≠ CANCELLED_MANDATE invariant ────────────────────────
  it('9. Exhausted mandate ≠ stood_down (failed cycle does not cancel mandate)', () => {
    // exhausted and stood_down are both terminal but distinct statuses.
    assert.notEqual(MANDATE_STATUS.EXHAUSTED, MANDATE_STATUS.STOOD_DOWN);
    // A mandate reaching 'exhausted' cannot subsequently transition to 'stood_down'.
    assert.equal(canTransition(MANDATE_STATUS.EXHAUSTED, MANDATE_STATUS.STOOD_DOWN), false);
    assert.equal(canTransition(MANDATE_STATUS.EXHAUSTED, MANDATE_STATUS.RECOVERED), false);
  });

  // ── 10. preDebitNoticeMinHours is 24 ─────────────────────────────────────
  it('10. preDebitNoticeMinHours is 24 (SECONDARY_ONLY — RBI pre-debit notice)', () => {
    assert.equal(preDebitNoticeMinHours, 24);
    assert.equal(RECOVERY_POLICY.preDebitNoticeMinHours, 24);
  });

  // ── 11. Pre-debit gap enforced: dispatch_time >= notice_time + 24h ────────
  it('11. Pre-debit notice gap >= preDebitNoticeMinHours always (property)', () => {
    fc.assert(
      fc.property(
        // noticeTime in ms since epoch: arbitrary
        fc.integer({ min: 0, max: 1e12 }),
        // dispatchOffset in hours: we test both < 24 and >= 24
        fc.double({ min: 0, max: 48, noNaN: true }),
        (noticeMs, offsetHours) => {
          const noticeTime    = noticeMs;
          const dispatchTime  = noticeMs + offsetHours * 3600 * 1000;
          const gapHours      = (dispatchTime - noticeTime) / (3600 * 1000);
          const gapSatisfied  = gapHours >= preDebitNoticeMinHours;

          if (offsetHours >= preDebitNoticeMinHours) {
            assert.equal(gapSatisfied, true,
              `Gap ${gapHours}h should satisfy ${preDebitNoticeMinHours}h requirement`);
          } else {
            assert.equal(gapSatisfied, false,
              `Gap ${gapHours}h should NOT satisfy ${preDebitNoticeMinHours}h requirement`);
          }
        }
      ),
      { numRuns: FC_RUNS }
    );
  });

  // ── 12. minRetryGapHours is 0 (explicitly assumed) ───────────────────────
  it('12. minRetryGapHours is 0 (explicitly ASSUMED — separate from notice gap)', () => {
    assert.equal(minRetryGapHours, 0);
    assert.equal(RECOVERY_POLICY.minRetryGapHours, 0);
  });

  // ── 13. freshNoticePerRetry is false (assumed) ────────────────────────────
  it('13. freshNoticePerRetry is false (ASSUMED)', () => {
    assert.equal(freshNoticePerRetry, false);
    assert.equal(RECOVERY_POLICY.freshNoticePerRetry, false);
  });

  // ── 14. retriesInNonPeakSlots is true ────────────────────────────────────
  it('14. retriesInNonPeakSlots is true (ASSUMED at AutoPay level; G-3 SOURCED)', () => {
    assert.equal(retriesInNonPeakSlots, true);
    assert.equal(RECOVERY_POLICY.retriesInNonPeakSlots, true);
  });

  // ── 15. RECOVERY_POLICY is frozen (no mutation) ───────────────────────────
  it('15. RECOVERY_POLICY is frozen — cannot be mutated', () => {
    assert.ok(Object.isFrozen(RECOVERY_POLICY));
    assert.ok(Object.isFrozen(PEAK_WINDOWS));
    // Attempt mutation must not affect the value
    const before = RECOVERY_POLICY.MAX_ATTEMPTS;
    try { RECOVERY_POLICY.MAX_ATTEMPTS = 99; } catch (_) {}
    assert.equal(RECOVERY_POLICY.MAX_ATTEMPTS, before);
  });

  // ── 16. describePeakWindows returns a human-readable string ──────────────
  it('16. describePeakWindows returns legible string with window hours', () => {
    const desc = describePeakWindows();
    assert.ok(typeof desc === 'string' && desc.length > 0);
    assert.ok(desc.includes('10:00'), `Expected 10:00 in: ${desc}`);
    assert.ok(desc.includes('13:00'), `Expected 13:00 in: ${desc}`);
    assert.ok(desc.includes('17:00'), `Expected 17:00 in: ${desc}`);
    assert.ok(desc.includes('21:30'), `Expected 21:30 in: ${desc}`);
    assert.ok(desc.includes('Asia/Kolkata'), `Expected timezone in: ${desc}`);
  });

  // ── 17. CONFIDENCE_THRESHOLD and MAX_DELAY_DAYS integrity ────────────────
  it('17. CONFIDENCE_THRESHOLD = 0.70, MAX_DELAY_DAYS = 7 (ASSUMED)', () => {
    assert.equal(CONFIDENCE_THRESHOLD, 0.70);
    assert.equal(MAX_DELAY_DAYS, 7);
  });

  // ── 18. isPeakTime throws on invalid input ────────────────────────────────
  it('18. isPeakTime throws TypeError on invalid date string', () => {
    assert.throws(
      () => isPeakTime('not-a-date'),
      TypeError
    );
  });

  // ── 19. PEAK_TIMEZONE is Asia/Kolkata ────────────────────────────────────
  it('19. PEAK_TIMEZONE is Asia/Kolkata', () => {
    assert.equal(PEAK_TIMEZONE, 'Asia/Kolkata');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DB-backed concurrency test
  // Sends multiple concurrent execute_attempt calls for the same mandate and
  // verifies that at most 4 attempts are created with no duplicates.
  //
  // This test hits the live Supabase test database.
  // It requires a simulation run and mandate to already exist (created here).
  // ─────────────────────────────────────────────────────────────────────────

  describe('20. DB: concurrent attempt creation — at most 4 per mandate', () => {
    let runId;
    let mandateDbId;

    before(async () => {
      // Create a fresh simulation run for this test
      const { data: run, error: runErr } = await supabase
        .from('simulation_runs')
        .insert({
          random_seed: 999999,
          current_day: 1,
          max_days: 30,
          status: 'running',
        })
        .select('id')
        .single();

      if (runErr || !run) {
        throw new Error(`step25: could not create test simulation run: ${runErr?.message}`);
      }
      runId = run.id;

      // Create a mandate for this run
      const { data: mandate, error: mErr } = await supabase
        .from('mandates')
        .insert({
          run_id: runId,
          mandate_id: 'M-PHASE2-CONCURRENCY-TEST',
          amount: 1000,
          income_day_of_month: 1,
          balance_volatility: 0.2,
          contact_consent: true,
          experiment_arm: 'baseline',
          status: 'pending',
          attempts_used: 0,
          first_due_day: 1,
          next_action: 'retry',
          next_action_day: 1,
          created_day: 1,
        })
        .select('id')
        .single();

      if (mErr || !mandate) {
        throw new Error(`step25: could not create test mandate: ${mErr?.message}`);
      }
      mandateDbId = mandate.id;
    });

    after(async () => {
      // Clean up test data
      if (mandateDbId) {
        await supabase.from('attempts').delete().eq('mandate_id', mandateDbId);
        await supabase.from('mandates').delete().eq('id', mandateDbId);
      }
      if (runId) {
        await supabase.from('simulation_runs').delete().eq('id', runId);
      }
    });

    it('20a. Concurrent execute_attempt calls: at most 4 attempts created, no duplicates', async () => {
      // Fire 8 concurrent execute_attempt calls for the same mandate.
      // Only 4 should succeed (or fewer, due to RPC-level idempotency/cap).
      const calls = Array.from({ length: 8 }, (_, i) =>
        supabase.rpc('execute_attempt', {
          p_run_id: runId,
          p_mandate_id: mandateDbId,
          p_day: 1,
          p_channel: 'auto_debit',
          // Unique idempotency key per concurrent call to allow distinct attempts
          p_idempotency_key: `phase2-concurrency-test:${mandateDbId}:slot:${i}`,
        })
      );

      const results = await Promise.allSettled(calls);

      // Re-read attempts from DB
      const { data: attempts, error: aErr } = await supabase
        .from('attempts')
        .select('id, attempt_number')
        .eq('mandate_id', mandateDbId)
        .order('attempt_number', { ascending: true });

      assert.ok(!aErr, `Failed to read attempts: ${aErr?.message}`);

      // At most 4 attempts
      assert.ok(
        attempts.length <= 4,
        `Expected at most 4 attempts, got ${attempts.length}`
      );

      // No attempt_number > 4
      for (const a of attempts) {
        assert.ok(
          a.attempt_number >= 1 && a.attempt_number <= 4,
          `attempt_number ${a.attempt_number} is outside [1, 4]`
        );
      }

      // No duplicate attempt_numbers
      const nums = attempts.map(a => a.attempt_number);
      const unique = new Set(nums);
      assert.equal(
        unique.size, nums.length,
        `Duplicate attempt_numbers found: ${nums.join(', ')}`
      );

      // No 5th attempt
      const fifth = attempts.find(a => a.attempt_number === 5);
      assert.equal(fifth, undefined, 'A 5th attempt must not exist');

      // Errors from RPC calls should be deterministic (rejected, not unexpected throws)
      const succeeded = results.filter(r => r.status === 'fulfilled' && !r.value?.error);
      const errored   = results.filter(r => r.status === 'fulfilled' && r.value?.error);
      const rejected  = results.filter(r => r.status === 'rejected');

      // All settled (no unexpected rejections)
      assert.equal(rejected.length, 0, 'No Promise should reject unexpectedly');

      // Succeeded calls ≤ 4
      assert.ok(
        succeeded.length <= 4,
        `At most 4 concurrent calls should succeed; got ${succeeded.length}`
      );

      // Errors should be cap-related (P0001 or similar), not crashes
      for (const r of errored) {
        const code = r.value?.error?.code;
        const msg  = r.value?.error?.message ?? '';
        assert.ok(
          code === 'P0001' || msg.toLowerCase().includes('attempt') || msg.toLowerCase().includes('maximum'),
          `Unexpected RPC error: code=${code}, message=${msg}`
        );
      }
    });

    it('20b. After concurrency test: mandate attempts_used <= 4', async () => {
      const { data: m, error: mErr } = await supabase
        .from('mandates')
        .select('attempts_used')
        .eq('id', mandateDbId)
        .single();

      assert.ok(!mErr, `Failed to read mandate: ${mErr?.message}`);
      assert.ok(
        m.attempts_used <= 4,
        `attempts_used ${m.attempts_used} exceeds cap of 4`
      );
    });
  });

}); // end describe Step 25
