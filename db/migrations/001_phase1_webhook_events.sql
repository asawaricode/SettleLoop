-- =============================================================================
-- Phase 1 -- Database Prep
-- Migration: 001_phase1_webhook_events.sql
--
-- Changes:
--   1. Add nullable JSONB metadata column to audit_logs (if not already present).
--   2. Create webhook_events table.
--
-- Safe to run multiple times (idempotent via IF NOT EXISTS / IF EXISTS guards).
-- Apply via Supabase SQL Editor or psql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. audit_logs: add nullable metadata JSONB column
--    (only if the column does not already exist)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_name  = 'audit_logs'
    AND    column_name = 'metadata'
  ) THEN
    ALTER TABLE audit_logs
      ADD COLUMN metadata JSONB DEFAULT NULL;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 2. webhook_events: new table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           TEXT        NOT NULL,
  event_type         TEXT        NOT NULL,
  payload            JSONB       NOT NULL DEFAULT '{}',
  signature_verified BOOLEAN     NOT NULL DEFAULT FALSE,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint on event_id (deduplication / idempotency)
CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_event_id_idx
  ON webhook_events (event_id);
