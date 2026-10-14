-- EI session notes (Oct 2026; the "ei" feature, PedsDesk only --
-- lib/sessionNotes.js, routes/sessionNotes.js). New tables only: they stay
-- empty at Kidz Lounge. Safe to run more than once.
--
-- One note per EI session, keyed like EI-Hub billing (session_key:
-- 'appt:<id>' or 'series:<series id>:<date>'), following the NYC EI
-- Individual Session Note (June 2025). The content locks at the first
-- signature (parent or provider); later corrections are addenda. A
-- canceled session is documented too (cancelled, with the reason in
-- outcomes_text and the make-up-by date).
CREATE TABLE IF NOT EXISTS "EiSessionNotes" (
  id SERIAL PRIMARY KEY,
  session_key TEXT NOT NULL UNIQUE,
  patient_id UUID NOT NULL REFERENCES "Patients"(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  session_date DATE NOT NULL,
  start_time TEXT,
  end_time TEXT,
  service TEXT,
  cancelled BOOLEAN NOT NULL DEFAULT false,
  makeup_by DATE,
  makeup_for_date DATE,
  location TEXT,              -- 'home' | 'community' | 'facility'
  delivery TEXT,              -- 'in_person' | 'telehealth'
  participants TEXT[] NOT NULL DEFAULT '{}',   -- 'child' | 'parent' | 'other'
  participants_other TEXT,
  outcome_ids INTEGER[] NOT NULL DEFAULT '{}', -- EiIfspOutcomes worked on
  outcomes_text TEXT,         -- 1. outcomes / developmental steps (or why canceled)
  narrative TEXT,             -- 2. what happened, routine, strategies, progress
  parent_methods TEXT[] NOT NULL DEFAULT '{}', -- 3. how the provider worked with the parent
  parent_methods_other TEXT,
  strategies TEXT,            -- 4. agreed between visits
  -- Filled in when the provider signs: what the note's header said then
  -- (names, DOB, EI #, NPI, credentials, license #, ICD-10, codes).
  header JSONB,
  parent_name TEXT,
  parent_relationship TEXT,
  parent_note_signature TEXT, -- PNG data URLs, drawn on the provider's device
  parent_log_signature TEXT,
  parent_signed_at TIMESTAMPTZ,
  provider_signature TEXT,
  provider_license TEXT,
  provider_signed_at TIMESTAMPTZ,
  provider_signed_by TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ei_session_notes_patient ON "EiSessionNotes" (patient_id, session_date);
CREATE INDEX IF NOT EXISTS ei_session_notes_provider ON "EiSessionNotes" (provider, session_date);

-- Corrections to a note once it's signed: never edited or deleted.
CREATE TABLE IF NOT EXISTS "EiSessionNoteAddenda" (
  id SERIAL PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES "EiSessionNotes"(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  signed_by TEXT NOT NULL,
  signed_name TEXT,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ei_session_note_addenda_note ON "EiSessionNoteAddenda" (note_id);

-- Signed notes can't be changed in the database either (the app never
-- tries): once provider_signed_at is set, only the parent's signature may
-- still be added, and the row can't be deleted. Addenda are append-only.
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
    OR NEW.cancelled IS DISTINCT FROM OLD.cancelled) THEN
    RAISE EXCEPTION 'A signed session note can''t be changed. Add an addendum instead.';
  END IF;
  IF OLD.parent_signed_at IS NOT NULL AND (
       NEW.parent_note_signature IS DISTINCT FROM OLD.parent_note_signature
    OR NEW.parent_log_signature IS DISTINCT FROM OLD.parent_log_signature
    OR NEW.parent_signed_at IS DISTINCT FROM OLD.parent_signed_at) THEN
    RAISE EXCEPTION 'The parent''s signature can''t be changed.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ei_session_notes_locked ON "EiSessionNotes";
CREATE TRIGGER ei_session_notes_locked BEFORE UPDATE OR DELETE ON "EiSessionNotes"
  FOR EACH ROW EXECUTE FUNCTION ei_session_notes_locked();

CREATE OR REPLACE FUNCTION ei_session_note_addenda_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Addenda can''t be changed or deleted.';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ei_session_note_addenda_append_only ON "EiSessionNoteAddenda";
CREATE TRIGGER ei_session_note_addenda_append_only BEFORE UPDATE OR DELETE ON "EiSessionNoteAddenda"
  FOR EACH ROW EXECUTE FUNCTION ei_session_note_addenda_append_only();
