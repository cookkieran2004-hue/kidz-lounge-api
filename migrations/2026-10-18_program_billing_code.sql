-- Billing code (C-1 ... C-6, C-#) for an insurance, P or PP program
-- (lib/patientPrograms.js). Shown as the program on the billing sheet. Kept
-- on each PatientPrograms row of that program, so it's dated like the
-- mandate. Safe to run more than once.
ALTER TABLE "PatientPrograms" ADD COLUMN IF NOT EXISTS billing_code TEXT;
