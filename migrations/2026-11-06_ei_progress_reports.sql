-- EI progress reports (Oct 2026; the "ei" feature, PedsDesk only --
-- lib/progressReports.js, routes/progressReports.js). Additive only: a new
-- column on a PedsDesk-only table and new tables, all empty at Kidz Lounge.
-- Safe to run more than once.

-- An IFSP outcome's developmental steps (1a, 1b, ...), in order: the
-- progress report rates each one (NYC Provider Progress Note, 9/2024).
ALTER TABLE "EiIfspOutcomes" ADD COLUMN IF NOT EXISTS steps TEXT[] NOT NULL DEFAULT '{}';

-- One provider's progress report on one child for one IFSP period (type
-- '6' / '12', from the IFSP type) or an amendment request. The content
-- locks at the first signature (parent or provider); the office then
-- approves it or returns it for an addendum, and marks it sent to the
-- service coordinator.
CREATE TABLE IF NOT EXISTS "EiProgressReports" (
  id SERIAL PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES "Patients"(id) ON DELETE CASCADE,
  ifsp_id INTEGER REFERENCES "EiIfsps"(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  service TEXT NOT NULL,
  report_type TEXT NOT NULL CHECK (report_type IN ('6', '12', 'amendment')),
  ifsp_start DATE,
  ifsp_end DATE,
  due_date DATE,
  -- The answers (NYC's form, in order). Prefilled from the IFSP, session
  -- notes and mandates when the report is started; the provider edits them.
  details JSONB NOT NULL DEFAULT '{}',
  outcomes JSONB NOT NULL DEFAULT '[]',   -- [{ outcome_id, number, text, rating, keep, at_ifsp, change_note, steps: [{ label, text, rating, keep }] }]
  answers JSONB NOT NULL DEFAULT '{}',    -- q2 ... q7
  proposed JSONB NOT NULL DEFAULT '[]',   -- q8: [{ number, text, kind, steps: [{ label, text, kind }] }]
  header JSONB,                           -- names / IDs at the provider's signature
  parent_reviewed_on DATE,
  parent_name TEXT,
  parent_relationship TEXT,
  parent_signature TEXT,
  parent_signed_at TIMESTAMPTZ,
  provider_signature TEXT,
  provider_license TEXT,
  provider_signed_at TIMESTAMPTZ,
  provider_signed_by TEXT,
  office_status TEXT CHECK (office_status IS NULL OR office_status IN ('approved', 'returned')),
  office_comment TEXT,
  office_by TEXT,
  office_at TIMESTAMPTZ,
  sent_on DATE,
  sent_by TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ei_progress_reports_patient ON "EiProgressReports" (patient_id, ifsp_end);
CREATE INDEX IF NOT EXISTS ei_progress_reports_provider ON "EiProgressReports" (provider, due_date);
-- One 6- or 12-month report per child, IFSP, provider and service (any number of amendments).
CREATE UNIQUE INDEX IF NOT EXISTS ei_progress_reports_one ON "EiProgressReports" (patient_id, ifsp_id, provider, service, report_type)
  WHERE report_type <> 'amendment';

CREATE TABLE IF NOT EXISTS "EiProgressReportAddenda" (
  id SERIAL PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES "EiProgressReports"(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  signed_by TEXT NOT NULL,
  signed_name TEXT,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ei_progress_report_addenda_report ON "EiProgressReportAddenda" (report_id);

-- As session notes: signed content can't change, signatures can't change,
-- a signed report can't be deleted, addenda are append-only. The office
-- fields (approval, sent) stay editable.
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
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ei_progress_reports_locked ON "EiProgressReports";
CREATE TRIGGER ei_progress_reports_locked BEFORE UPDATE OR DELETE ON "EiProgressReports"
  FOR EACH ROW EXECUTE FUNCTION ei_progress_reports_locked();

CREATE OR REPLACE FUNCTION ei_progress_report_addenda_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Addenda can''t be changed or deleted.';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ei_progress_report_addenda_append_only ON "EiProgressReportAddenda";
CREATE TRIGGER ei_progress_report_addenda_append_only BEFORE UPDATE OR DELETE ON "EiProgressReportAddenda"
  FOR EACH ROW EXECUTE FUNCTION ei_progress_report_addenda_append_only();
