-- =============================================================================
-- Phase 2 — Domain Guardrails and State Machines
-- Migration: 002_phase2_attempt_constraints.sql
--
-- Changes:
--   1. Add UNIQUE constraint on (mandate_id, attempt_number) in the attempts
--      table.  In this schema, attempts.mandate_id references mandates.id,
--      which represents the specific billing/recovery cycle for that simulation run.
--      This guarantees uniqueness of attempt numbers per cycle and closes the
--      concurrency gap from non-atomic SELECT MAX()+1 patterns.
--
--   2. Add CHECK constraint requiring attempt_number IN [1, 4].
--      Enforces the 4-attempt ceiling per cycle at the database boundary, so the
--      limit cannot be bypassed by any application-layer caller.
--
--   3. Add a DB-level trigger that prevents any direct UPDATE to
--      mandates.status that would illegally skip a terminal state or
--      bypass an authoritative RPC.  The trigger ensures terminal cycle
--      states (recovered, exhausted, stood_down) remain immutable.
--      Note: Invariant 'failed cycle != cancelled mandate' is preserved —
--      a cycle that exhausts attempts reaches status='exhausted' (failed cycle)
--      without automatically cancelling the mandate agreement ('stood_down').
--
-- Pre-condition checks:
--   All statements are idempotent (use IF NOT EXISTS).
--   A pre-migration data check verified:
--     - 0 rows with attempt_number outside [1, 4]
--     - 0 duplicate (mandate_id, attempt_number) pairs
--   (Verified against the database before creating this migration.)
--
-- Evidence / policy annotation:
--   The 4-attempt ceiling per cycle (attempt_number <= 4) is ASSUMED project policy
--   based on the reported Rule D (1 initial + 3 retries per sequence number).
--   Rule D primary-source verification is `not verified` in ASSUMPTIONS.md §3.
--   The UNIQUE constraint is a concurrency-safety measure independent of the
--   regulatory debate about the exact retry limit.
--
-- Application:
--   Apply via Supabase SQL Editor or psql against the LOCAL/TEST database.
--   DO NOT apply to the hosted Supabase project without explicit instruction.
-- =============================================================================

-- ── NOTE: Supabase/PostgREST environment ─────────────────────────────────────
-- We use DO blocks and IF NOT EXISTS guards for idempotency.
-- The UNIQUE INDEX is created separately from the CHECK constraint so each
-- can be dropped/re-created independently during development.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. UNIQUE constraint on (mandate_id, attempt_number)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  c.relkind = 'i'
    AND    n.nspname = 'public'
    AND    c.relname = 'attempts_mandate_attempt_no_unique'
  ) THEN
    CREATE UNIQUE INDEX attempts_mandate_attempt_no_unique
      ON public.attempts (mandate_id, attempt_number);

    RAISE NOTICE 'Created UNIQUE INDEX attempts_mandate_attempt_no_unique';
  ELSE
    RAISE NOTICE 'UNIQUE INDEX attempts_mandate_attempt_no_unique already exists — skipping';
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. CHECK constraint: attempt_number must be in [1, 4]
--    Evidence status: ASSUMED project policy (Rule D not verified from primary
--    source — see ASSUMPTIONS.md §3 Rule D).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conrelid = 'public.attempts'::regclass
    AND    conname  = 'attempts_attempt_number_range'
  ) THEN
    ALTER TABLE public.attempts
      ADD CONSTRAINT attempts_attempt_number_range
        CHECK (attempt_number >= 1 AND attempt_number <= 4);

    RAISE NOTICE 'Added CHECK constraint attempts_attempt_number_range';
  ELSE
    RAISE NOTICE 'CHECK constraint attempts_attempt_number_range already exists — skipping';
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Terminal-state protection trigger on mandates
--
--    Prevents any caller from directly UPDATEing mandates.status to a new
--    value when the current status is a terminal state (recovered, stood_down,
--    exhausted).
--
--    Authoritative RPCs (complete_attempt, set_mandate_action, resolve_approval)
--    are responsible for state transitions.  This trigger is a database-level
--    safety net that blocks bypasses.
--
--    The trigger fires BEFORE UPDATE OF status on mandates.
--    It raises an exception, which rolls back the calling transaction.
-- ─────────────────────────────────────────────────────────────────────────────

-- 3a. Create the trigger function
CREATE OR REPLACE FUNCTION public.prevent_terminal_status_bypass()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Terminal states: recovered, stood_down, exhausted
  IF OLD.status IN ('recovered', 'stood_down', 'exhausted') THEN
    -- Any attempt to change status away from a terminal state is illegal.
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION
        'mandates terminal-state violation: mandate % is in terminal status ''%'' — '
        'direct status change to ''%'' is not permitted. '
        'Only authoritative RPCs may transition mandate status.',
        OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 3b. Attach the trigger (idempotent: drop and recreate)
DROP TRIGGER IF EXISTS trg_prevent_terminal_status_bypass ON public.mandates;

CREATE TRIGGER trg_prevent_terminal_status_bypass
  BEFORE UPDATE OF status
  ON public.mandates
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_terminal_status_bypass();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Verify: sanity-check the constraints exist after creation
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  unique_idx  INTEGER;
  check_cst   INTEGER;
  trigger_cnt INTEGER;
BEGIN
  SELECT COUNT(*) INTO unique_idx
  FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE  c.relkind = 'i'
  AND    n.nspname = 'public'
  AND    c.relname = 'attempts_mandate_attempt_no_unique';

  SELECT COUNT(*) INTO check_cst
  FROM   pg_constraint
  WHERE  conrelid = 'public.attempts'::regclass
  AND    conname  = 'attempts_attempt_number_range';

  SELECT COUNT(*) INTO trigger_cnt
  FROM   pg_trigger
  WHERE  tgrelid  = 'public.mandates'::regclass
  AND    tgname   = 'trg_prevent_terminal_status_bypass';

  IF unique_idx < 1 THEN
    RAISE EXCEPTION 'POST-MIGRATION CHECK FAILED: UNIQUE INDEX on attempts not found';
  END IF;
  IF check_cst < 1 THEN
    RAISE EXCEPTION 'POST-MIGRATION CHECK FAILED: CHECK constraint on attempts not found';
  END IF;
  IF trigger_cnt < 1 THEN
    RAISE EXCEPTION 'POST-MIGRATION CHECK FAILED: terminal-state trigger on mandates not found';
  END IF;

  RAISE NOTICE 'Migration 002 verified: UNIQUE INDEX ✓, CHECK constraint ✓, trigger ✓';
END
$$;
