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

-- Changes to past appointments asked for by someone who isn't an Admin or
-- Developer. The original API call (method, path, body) is replayed as
-- the approver.
CREATE TABLE IF NOT EXISTS "ScheduleChangeRequests" (
  id BIGSERIAL PRIMARY KEY,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  body JSONB NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL,
  provider TEXT,
  appointment_date DATE,
  patient_name TEXT,
  reason TEXT,
  requested_by TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT
);
CREATE INDEX IF NOT EXISTS schedule_change_requests_status ON "ScheduleChangeRequests" (status, requested_at);
