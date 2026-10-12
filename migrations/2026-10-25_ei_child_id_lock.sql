-- Locks a child's EI child ID (their ID #) once an EI-Hub import has saved
-- anything for them (Kieran, Oct 2026: "once a kid's EI Child ID is entered
-- from an import, lock it and use it to refer back to"). Later imports match
-- the child by it first; the patient form, the EI details editor and the
-- patient save refuse to change it (lib/eiImport.js, routes/patients.js,
-- routes/eiHub.js). Safe to run more than once.

ALTER TABLE "Patients" ADD COLUMN IF NOT EXISTS ei_id_locked_at TIMESTAMPTZ;
ALTER TABLE "Patients" ADD COLUMN IF NOT EXISTS ei_id_locked_by TEXT;

-- Children already imported (they have authorization records from an
-- import, so their ID # came from EI-Hub) are locked as of that import.
UPDATE "Patients" p
SET ei_id_locked_at = a.first_import, ei_id_locked_by = a.imported_by
FROM (
  SELECT DISTINCT ON (patient_id) patient_id, imported_at AS first_import, imported_by
  FROM "EiAuthorizations" WHERE patient_id IS NOT NULL
  ORDER BY patient_id, imported_at
) a
WHERE a.patient_id = p.id AND p.ei_id_locked_at IS NULL
  AND COALESCE(TRIM(p."ID_Number"), '') <> '';
