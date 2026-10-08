-- Make-up sessions (Oct 2026). A make-up is an ordinary one-time
-- appointment linked to the Canceled / No Show appointment it makes up for
-- (makeup_for). The old "Make Up" and "MUS" statuses are retired: those
-- appointments become Scheduled and are flagged as make-ups (is_makeup),
-- just without a link. Safe to run more than once.
DO $$
DECLARE id_type TEXT;
BEGIN
  SELECT format_type(atttypid, atttypmod) INTO id_type
  FROM pg_attribute WHERE attrelid = '"Appointments"'::regclass AND attname = 'id';
  EXECUTE format('ALTER TABLE "Appointments" ADD COLUMN IF NOT EXISTS makeup_for %s', id_type);
END $$;
ALTER TABLE "Appointments" ADD COLUMN IF NOT EXISTS is_makeup BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS appointments_makeup_for ON "Appointments" (makeup_for) WHERE makeup_for IS NOT NULL;

UPDATE "Appointments" SET appointment_status = 'Scheduled', is_makeup = true
WHERE appointment_status IN ('Make Up', 'MUS');
-- A weekly series can't be a make-up; any with those statuses just become Scheduled.
UPDATE "RecurringSeries" SET appointment_status = 'Scheduled'
WHERE appointment_status IN ('Make Up', 'MUS');
