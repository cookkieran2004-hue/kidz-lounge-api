-- EI-Hub authorizations as their own records, filled in from EI-Hub's
-- "Child Info and Authorizations" report (Service Logging / Case Management
-- -> Reports; lib/eiImport.js, routes/eiHub.js POST /ei-hub/import/...).
-- One row per authorization number, as EI-Hub had it at the last import:
-- EI-Hub is the record of an authorization's dates and counts, so an import
-- updates the row in place (who and when are kept with it, and every import
-- is logged in "EiImports"). Safe to run more than once.

CREATE TABLE IF NOT EXISTS "EiAuthorizations" (
  authorization_number TEXT PRIMARY KEY,
  patient_id UUID REFERENCES "Patients"(id) ON DELETE CASCADE,
  ei_child_id TEXT,
  service TEXT,              -- ST / OT / PT / SI, from Program
  program TEXT,              -- as EI-Hub has it, e.g. "Speech Language - Facility"
  location_type TEXT,
  enrollment_type TEXT,
  enrollment_status TEXT,
  start_date DATE,
  end_date DATE,
  suspended_start DATE,
  suspended_end DATE,
  length TEXT,
  frequency TEXT,
  frequency_unit TEXT,
  visits_per_day TEXT,
  sessions_authorized NUMERIC,
  sessions_used NUMERIC,
  sessions_remaining NUMERIC,
  makeups_authorized NUMERIC,
  makeups_used NUMERIC,
  makeups_remaining NUMERIC,
  covisits_authorized NUMERIC,
  covisits_used NUMERIC,
  covisits_remaining NUMERIC,
  therapist_first TEXT,
  therapist_last TEXT,
  therapist_npi TEXT,
  last_session_date DATE,
  imported_by TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ei_authorizations_patient ON "EiAuthorizations" (patient_id);

-- Every import that was applied: who, when, and how many of each kind of
-- change (counts only, never the data).
CREATE TABLE IF NOT EXISTS "EiImports" (
  id SERIAL PRIMARY KEY,
  imported_by TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_count INTEGER,
  applied JSONB
);
