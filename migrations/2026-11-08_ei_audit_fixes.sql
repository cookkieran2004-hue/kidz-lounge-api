-- NYC EI audit fixes (Oct 2026; the "ei" feature, PedsDesk only). Checked
-- against NYC's official forms (session notes 6/13/2025, group note
-- 7/29/2024, service log 11/2024, progress note 9/2024) and NYC's 2026
-- service provision citations. Additive only; safe to run more than once.

-- Parent consents the EI program asks agencies to hold before doing
-- something: telehealth (the NYS EI Consent for the Use of Telehealth, one
-- per service type, before any remote session) and email (written consent
-- before exchanging information by email; texting families isn't allowed).
CREATE TABLE IF NOT EXISTS "EiConsents" (
  id SERIAL PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES "Patients"(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('telehealth', 'email')),
  service TEXT,                  -- telehealth: ST / OT / PT / SI; email: NULL
  signed_on DATE NOT NULL,
  withdrawn_on DATE,
  document_id INTEGER,           -- the signed form in PatientDocuments, when uploaded
  notes TEXT,
  recorded_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ei_consents_patient ON "EiConsents" (patient_id, kind);

-- Session notes: what NYC's Group Session Note asks (service location type
-- and address), the supervisor's title (Version 2), and when the family got
-- its copy (NYC: "as close as possible to the completed session").
ALTER TABLE "EiSessionNotes"
  ADD COLUMN IF NOT EXISTS group_location TEXT CHECK (group_location IS NULL OR group_location IN ('center', 'other')),
  ADD COLUMN IF NOT EXISTS group_location_other TEXT,
  ADD COLUMN IF NOT EXISTS group_address TEXT,
  ADD COLUMN IF NOT EXISTS supervisor_title TEXT,
  ADD COLUMN IF NOT EXISTS family_copy_on DATE,
  ADD COLUMN IF NOT EXISTS family_copy_by TEXT;

ALTER TABLE "EiProgressReports"
  ADD COLUMN IF NOT EXISTS supervisor_title TEXT,
  ADD COLUMN IF NOT EXISTS family_copy_on DATE,
  ADD COLUMN IF NOT EXISTS family_copy_by TEXT;

ALTER TABLE "EiEvalReports"
  ADD COLUMN IF NOT EXISTS supervisor_title TEXT,
  ADD COLUMN IF NOT EXISTS family_copy_on DATE,
  ADD COLUMN IF NOT EXISTS family_copy_by TEXT;

-- A provider's planned absence: the family and the service coordinator must
-- be told at least 5 business days before (10 NYCRR 69-4.9(g)(2)(ii)). One
-- row per child told, per absence day.
CREATE TABLE IF NOT EXISTS "EiAbsenceNotices" (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  absence_date DATE NOT NULL,
  patient_id UUID NOT NULL REFERENCES "Patients"(id) ON DELETE CASCADE,
  notified_on DATE NOT NULL,
  notified_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, absence_date, patient_id)
);

-- The note's lock now covers the group location and address too.
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
    OR NEW.group_location IS DISTINCT FROM OLD.group_location
    OR NEW.group_address IS DISTINCT FROM OLD.group_address
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
