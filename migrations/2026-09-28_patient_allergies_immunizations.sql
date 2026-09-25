-- Allergies and immunizations on the patient record. Free text; shown as
-- yellow alerts on the patient chart banner and schedule cards when filled
-- in. Safe to run more than once.
ALTER TABLE "Patients" ADD COLUMN IF NOT EXISTS "Allergies" TEXT;
ALTER TABLE "Patients" ADD COLUMN IF NOT EXISTS "Immunizations" TEXT;
