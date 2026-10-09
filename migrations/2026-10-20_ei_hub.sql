-- EI-Hub entry (Oct 2026): sessions are still typed into the state's EI-Hub
-- by hand; Kidz Lounge lists what to type and tracks what's been done
-- (routes/billing.js, GET/PUT /billing/ei-hub). Safe to run more than once.

-- The EI authorization number for a service, kept on its program row so it's
-- dated like the mandate (lib/patientPrograms.js). Only EI rows use it.
ALTER TABLE "PatientPrograms" ADD COLUMN IF NOT EXISTS authorization_number TEXT;

-- One row per session that's been entered in EI-Hub. session_key stays the
-- same if a weekly-series date is edited into its own row:
--   appt:<id>                      a one-off appointment
--   series:<series id>:<YYYY-MM-DD> a series date (virtual or edited)
-- The date/time/length/provider when it was ticked, so a session changed
-- afterwards can be flagged for a second look in EI-Hub.
CREATE TABLE IF NOT EXISTS "EiHubEntries" (
  session_key TEXT PRIMARY KEY,
  patient_name TEXT,
  appointment_date DATE NOT NULL,
  appointment_time TEXT NOT NULL,
  duration INTEGER NOT NULL,
  provider TEXT,
  entered_by TEXT NOT NULL,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ei_hub_entries_date ON "EiHubEntries" (appointment_date);
