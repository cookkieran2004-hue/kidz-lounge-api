-- Employment type (lib/employment.js) decides which paid/unpaid time off
-- someone can take: salaried -> PTO and UPTO, hourly -> UPTO only,
-- neither -> neither (Lunch / Meeting / Unavailable / Other still work).
-- Everyone starts as 'neither' until an admin sets them on their profile.
-- Safe to run more than once.
ALTER TABLE "Staff" ADD COLUMN IF NOT EXISTS employment_type TEXT NOT NULL DEFAULT 'neither';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_employment_type_check') THEN
    ALTER TABLE "Staff" ADD CONSTRAINT staff_employment_type_check CHECK (employment_type IN ('salaried', 'hourly', 'neither'));
  END IF;
END $$;
