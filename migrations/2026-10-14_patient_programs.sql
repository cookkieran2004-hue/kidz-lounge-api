-- Patient programs over time, with a mandate per service (lib/patientPrograms.js).
-- Safe to run more than once.
CREATE TABLE IF NOT EXISTS "PatientPrograms" (
  id BIGSERIAL PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES "Patients"(id) ON DELETE CASCADE,
  program TEXT NOT NULL,              -- EI, CPSE, BCBS/Anthem, P, ...
  service TEXT CHECK (service IN ('ST', 'OT', 'PT', 'SI')), -- NULL = no mandate entered yet
  sessions TEXT CHECK (sessions ~ '^[0-9]{1,2}(-[0-9]{1,2})?$'), -- per week: '2' or '1-2'
  minutes INTEGER CHECK (minutes BETWEEN 5 AND 240),
  start_date DATE,                    -- NULL = from the beginning
  end_date DATE,                      -- NULL = still current
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_by TEXT,
  legacy_mandate TEXT                 -- the old free-text Mandate, on rows brought over from before
);
CREATE INDEX IF NOT EXISTS patient_programs_patient ON "PatientPrograms" (patient_id);

-- Bring existing patients over: each program on their list becomes a
-- current program with no mandate yet (their old free-text Mandate stays on
-- the patient and shows until per-service mandates are entered). Only for
-- patients with no rows yet, so re-running adds nothing.
INSERT INTO "PatientPrograms" (patient_id, program, legacy_mandate, created_by)
SELECT p.id, TRIM(prog), NULLIF(TRIM(COALESCE(p."Mandate", '')), ''), 'migration'
FROM "Patients" p
CROSS JOIN LATERAL unnest(string_to_array(COALESCE(p."Program", ''), ',')) AS prog
WHERE TRIM(prog) <> ''
  AND NOT EXISTS (SELECT 1 FROM "PatientPrograms" pp WHERE pp.patient_id = p.id);
