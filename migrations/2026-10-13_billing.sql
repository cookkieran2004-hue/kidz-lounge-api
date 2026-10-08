-- Billing sheets (routes/billing.js, lib/pastLock.js). Safe to run more
-- than once.

-- Office closures: Holiday (H) or Emergency closure (Z) on the sheet.
-- Existing closures count as holidays.
ALTER TABLE "OfficeClosures" ADD COLUMN IF NOT EXISTS closure_type TEXT NOT NULL DEFAULT 'holiday';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'officeclosures_type_check') THEN
    ALTER TABLE "OfficeClosures" ADD CONSTRAINT officeclosures_type_check CHECK (closure_type IN ('holiday', 'emergency'));
  END IF;
END $$;

-- A patient seen by a provider on a day that has ended stays on that
-- provider's sheet for the month, even if the appointment is later moved
-- or deleted.
CREATE TABLE IF NOT EXISTS "BillingCaseload" (
  provider TEXT NOT NULL,          -- "Providers"."Name"
  month DATE NOT NULL,             -- first of the month
  patient_name TEXT NOT NULL,      -- "Patients"."Name"
  locked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, month, patient_name)
);

-- The sheet's REVIEWED box.
CREATE TABLE IF NOT EXISTS "BillingReviews" (
  provider TEXT NOT NULL,
  month DATE NOT NULL,
  reviewed_by TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, month)
);
