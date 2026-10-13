-- Power Forms (Kieran, Oct 2026): forms built in Admin -> Power Forms, sent
-- from a patient's chart as a secure link for a parent to fill in (public
-- page /f/<token>, unlocked with the child's date of birth). Answers wait on
-- the chart; staff review and apply the ones linked to chart fields
-- (lib/powerForms.js, routes/powerForms.js). Safe to run more than once.

CREATE TABLE IF NOT EXISTS "PowerFormTemplates" (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  intro TEXT,                          -- shown to the parent above the form
  fields JSONB NOT NULL DEFAULT '[]',  -- [{ id, type, label, help, required, options, chart_field }]
  archived BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  updated_at TIMESTAMPTZ
);

-- One per form sent. The link's token is never stored, only its SHA-256,
-- so the database can't be used to open a form. The form's name, intro and
-- fields are copied when sent, so editing the template later doesn't change
-- what a parent was asked. Expired = expires_at passed and not completed.
CREATE TABLE IF NOT EXISTS "PowerFormRequests" (
  id SERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  patient_id UUID NOT NULL REFERENCES "Patients"(id) ON DELETE CASCADE,
  template_id INTEGER REFERENCES "PowerFormTemplates"(id),
  form_name TEXT NOT NULL,
  intro TEXT,
  fields JSONB NOT NULL,
  recipient TEXT,                      -- who it's for, e.g. "Maria Brown (mother)"
  status TEXT NOT NULL DEFAULT 'sent', -- sent | opened | completed | cancelled
  expires_at TIMESTAMPTZ NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  answers JSONB,
  submitted_ip TEXT,
  failed_checks INTEGER NOT NULL DEFAULT 0,  -- wrong dates of birth in a row
  locked_until TIMESTAMPTZ,
  cancelled_by TEXT,
  cancelled_at TIMESTAMPTZ,
  applied_by TEXT,
  applied_at TIMESTAMPTZ,
  applied_fields JSONB,                -- chart fields applied: ["Parent_Phone", ...]
  document_id TEXT                     -- the PDF copy saved to the patient's Documents
);
CREATE INDEX IF NOT EXISTS power_form_requests_patient ON "PowerFormRequests" (patient_id, created_at DESC);
