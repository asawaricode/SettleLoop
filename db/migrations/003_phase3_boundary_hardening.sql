-- =============================================================================
-- Phase 3 — Boundary Hardening
-- Migration: 003_phase3_boundary_hardening.sql
--
-- Changes:
--   1. Ensure webhook_events.event_id has a database-level non-empty CHECK constraint.
--   2. Ensure webhook_events.event_id has a formal database-level UNIQUE constraint.
--   3. Ensure webhook_events.event_type has a non-empty CHECK constraint.
--   4. Document Sandbox isolation guarantees:
--      webhook processing remains strictly isolated to webhook_events
--      and never writes to simulation_runs, mandates, attempts, or benchmark tables.
--
-- Safe to run multiple times (idempotent via IF NOT EXISTS / exception guards).
-- Apply via Supabase SQL Editor or psql against LOCAL/TEST database only.
-- DO NOT apply to hosted Supabase without explicit instruction.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. webhook_events: non-empty check on event_id
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'webhook_events_event_id_not_empty'
  ) THEN
    ALTER TABLE webhook_events
      ADD CONSTRAINT webhook_events_event_id_not_empty
      CHECK (length(trim(event_id)) > 0);
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. webhook_events: formal UNIQUE constraint on event_id (using existing index if present)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'webhook_events_event_id_unique'
  ) THEN
    -- Try to add constraint using existing unique index or add fresh constraint
    BEGIN
      ALTER TABLE webhook_events
        ADD CONSTRAINT webhook_events_event_id_unique
        UNIQUE (event_id);
    EXCEPTION
      WHEN duplicate_table OR duplicate_object THEN
        NULL;
    END;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. webhook_events: non-empty check on event_type
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'webhook_events_event_type_not_empty'
  ) THEN
    ALTER TABLE webhook_events
      ADD CONSTRAINT webhook_events_event_type_not_empty
      CHECK (length(trim(event_type)) > 0);
  END IF;
END $$;
