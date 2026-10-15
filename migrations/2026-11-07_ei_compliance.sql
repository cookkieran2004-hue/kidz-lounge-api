-- EI compliance additions (Oct 2026; the "ei" feature, PedsDesk only).
-- Additive only: new nullable columns and new tables. The one column on a
-- shared table (Providers.supervisor_name) stays empty at Kidz Lounge.
-- Safe to run more than once.

-- A provider working under a plan of supervision (CFY, OTA, PTA...): their
-- supervisor co-signs their EI session notes and progress reports within
-- 45 days (NYC session note and progress note instructions).
ALTER TABLE "Providers" ADD COLUMN IF NOT EXISTS supervisor_name TEXT;

-- Session notes: group sessions (NYC Group Session Note, 7/2024), the
-- supervisor's co-signature, and a secure link for a telehealth parent to
-- sign remotely (only its sha256 is kept, like Power Forms).
ALTER TABLE "EiSessionNotes"
  ADD COLUMN IF NOT EXISTS group_type TEXT CHECK (group_type IS NULL OR group_type IN ('group', 'parent_child', 'family_support')),
  ADD COLUMN IF NOT EXISTS group_children INTEGER,
  ADD COLUMN IF NOT EXISTS group_duration INTEGER,
  ADD COLUMN IF NOT EXISTS group_site TEXT,
  ADD COLUMN IF NOT EXISTS aide_name TEXT,
  ADD COLUMN IF NOT EXISTS aide_notes TEXT,
  ADD COLUMN IF NOT EXISTS supervisor_name TEXT,
  ADD COLUMN IF NOT EXISTS supervisor_signature TEXT,
  ADD COLUMN IF NOT EXISTS supervisor_license TEXT,
  ADD COLUMN IF NOT EXISTS supervisor_signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS supervisor_signed_by TEXT,
  ADD COLUMN IF NOT EXISTS parent_link_hash TEXT,
  ADD COLUMN IF NOT EXISTS parent_link_expires TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS parent_link_failures INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS parent_link_locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS parent_signed_via TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ei_session_notes_link ON "EiSessionNotes" (parent_link_hash) WHERE parent_link_hash IS NOT NULL;

ALTER TABLE "EiProgressReports"
  ADD COLUMN IF NOT EXISTS supervisor_name TEXT,
  ADD COLUMN IF NOT EXISTS supervisor_signature TEXT,
  ADD COLUMN IF NOT EXISTS supervisor_license TEXT,
  ADD COLUMN IF NOT EXISTS supervisor_signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS supervisor_signed_by TEXT;

-- Evaluation reports (NYS DOH Memo 2005-02 required parts), one per eval
-- appointment (Appointments.is_eval), keyed like session notes.
CREATE TABLE IF NOT EXISTS "EiEvalReports" (
  id SERIAL PRIMARY KEY,
  session_key TEXT NOT NULL UNIQUE,
  patient_id UUID NOT NULL REFERENCES "Patients"(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  eval_date DATE NOT NULL,
  service TEXT,
  details JSONB NOT NULL DEFAULT '{}',
  instruments JSONB NOT NULL DEFAULT '[]',
  domains JSONB NOT NULL DEFAULT '{}',
  header JSONB,
  provider_signature TEXT,
  provider_license TEXT,
  provider_signed_at TIMESTAMPTZ,
  provider_signed_by TEXT,
  supervisor_name TEXT,
  supervisor_signature TEXT,
  supervisor_license TEXT,
  supervisor_signed_at TIMESTAMPTZ,
  supervisor_signed_by TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ei_eval_reports_patient ON "EiEvalReports" (patient_id, eval_date);
CREATE TABLE IF NOT EXISTS "EiEvalReportAddenda" (
  id SERIAL PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES "EiEvalReports"(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  signed_by TEXT NOT NULL,
  signed_name TEXT,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Session notes: the lock now also covers the group fields and the
-- supervisor's signature (the parent-link columns stay changeable: they
-- only manage the link).
CREATE OR REPLACE FUNCTION ei_session_notes_locked() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.provider_signed_at IS NOT NULL OR OLD.parent_signed_at IS NOT NULL THEN
      RAISE EXCEPTION 'A signed session note can''t be deleted.';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.provider_signed_at IS NOT NULL AND (
       NEW.provider_signed_at IS DISTINCT FROM OLD.provider_signed_at
    OR NEW.provider_signature IS DISTINCT FROM OLD.provider_signature
    OR NEW.header IS DISTINCT FROM OLD.header
    OR NEW.narrative IS DISTINCT FROM OLD.narrative
    OR NEW.outcomes_text IS DISTINCT FROM OLD.outcomes_text
    OR NEW.strategies IS DISTINCT FROM OLD.strategies
    OR NEW.outcome_ids IS DISTINCT FROM OLD.outcome_ids
    OR NEW.parent_methods IS DISTINCT FROM OLD.parent_methods
    OR NEW.participants IS DISTINCT FROM OLD.participants
    OR NEW.cancelled IS DISTINCT FROM OLD.cancelled
    OR NEW.group_type IS DISTINCT FROM OLD.group_type
    OR NEW.group_children IS DISTINCT FROM OLD.group_children
    OR NEW.aide_notes IS DISTINCT FROM OLD.aide_notes) THEN
    RAISE EXCEPTION 'A signed session note can''t be changed. Add an addendum instead.';
  END IF;
  IF OLD.parent_signed_at IS NOT NULL AND (
       NEW.parent_note_signature IS DISTINCT FROM OLD.parent_note_signature
    OR NEW.parent_log_signature IS DISTINCT FROM OLD.parent_log_signature
    OR NEW.parent_signed_at IS DISTINCT FROM OLD.parent_signed_at) THEN
    RAISE EXCEPTION 'The parent''s signature can''t be changed.';
  END IF;
  IF OLD.supervisor_signed_at IS NOT NULL AND (
       NEW.supervisor_signature IS DISTINCT FROM OLD.supervisor_signature
    OR NEW.supervisor_signed_at IS DISTINCT FROM OLD.supervisor_signed_at) THEN
    RAISE EXCEPTION 'The supervisor''s signature can''t be changed.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Progress reports: the same for the supervisor's signature.
CREATE OR REPLACE FUNCTION ei_progress_reports_locked() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.provider_signed_at IS NOT NULL OR OLD.parent_signed_at IS NOT NULL THEN
      RAISE EXCEPTION 'A signed progress report can''t be deleted.';
    END IF;
    RETURN OLD;
  END IF;
  IF (OLD.provider_signed_at IS NOT NULL OR OLD.parent_signed_at IS NOT NULL) AND (
       NEW.details IS DISTINCT FROM OLD.details
    OR NEW.outcomes IS DISTINCT FROM OLD.outcomes
    OR NEW.answers IS DISTINCT FROM OLD.answers
    OR NEW.proposed IS DISTINCT FROM OLD.proposed
    OR NEW.report_type IS DISTINCT FROM OLD.report_type) THEN
    RAISE EXCEPTION 'A signed progress report can''t be changed. Add an addendum instead.';
  END IF;
  IF OLD.provider_signed_at IS NOT NULL AND (
       NEW.provider_signed_at IS DISTINCT FROM OLD.provider_signed_at
    OR NEW.provider_signature IS DISTINCT FROM OLD.provider_signature
    OR NEW.header IS DISTINCT FROM OLD.header) THEN
    RAISE EXCEPTION 'The provider''s signature can''t be changed.';
  END IF;
  IF OLD.parent_signed_at IS NOT NULL AND (
       NEW.parent_signature IS DISTINCT FROM OLD.parent_signature
    OR NEW.parent_signed_at IS DISTINCT FROM OLD.parent_signed_at) THEN
    RAISE EXCEPTION 'The parent''s signature can''t be changed.';
  END IF;
  IF OLD.supervisor_signed_at IS NOT NULL AND (
       NEW.supervisor_signature IS DISTINCT FROM OLD.supervisor_signature
    OR NEW.supervisor_signed_at IS DISTINCT FROM OLD.supervisor_signed_at) THEN
    RAISE EXCEPTION 'The supervisor''s signature can''t be changed.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Evaluation reports: locked once the evaluator signs.
CREATE OR REPLACE FUNCTION ei_eval_reports_locked() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.provider_signed_at IS NOT NULL THEN
      RAISE EXCEPTION 'A signed evaluation report can''t be deleted.';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.provider_signed_at IS NOT NULL AND (
       NEW.details IS DISTINCT FROM OLD.details
    OR NEW.instruments IS DISTINCT FROM OLD.instruments
    OR NEW.domains IS DISTINCT FROM OLD.domains
    OR NEW.header IS DISTINCT FROM OLD.header
    OR NEW.provider_signature IS DISTINCT FROM OLD.provider_signature
    OR NEW.provider_signed_at IS DISTINCT FROM OLD.provider_signed_at) THEN
    RAISE EXCEPTION 'A signed evaluation report can''t be changed. Add an addendum instead.';
  END IF;
  IF OLD.supervisor_signed_at IS NOT NULL AND (
       NEW.supervisor_signature IS DISTINCT FROM OLD.supervisor_signature
    OR NEW.supervisor_signed_at IS DISTINCT FROM OLD.supervisor_signed_at) THEN
    RAISE EXCEPTION 'The supervisor''s signature can''t be changed.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ei_eval_reports_locked ON "EiEvalReports";
CREATE TRIGGER ei_eval_reports_locked BEFORE UPDATE OR DELETE ON "EiEvalReports"
  FOR EACH ROW EXECUTE FUNCTION ei_eval_reports_locked();

CREATE OR REPLACE FUNCTION ei_eval_report_addenda_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Addenda can''t be changed or deleted.';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ei_eval_report_addenda_append_only ON "EiEvalReportAddenda";
CREATE TRIGGER ei_eval_report_addenda_append_only BEFORE UPDATE OR DELETE ON "EiEvalReportAddenda"
  FOR EACH ROW EXECUTE FUNCTION ei_eval_report_addenda_append_only();
