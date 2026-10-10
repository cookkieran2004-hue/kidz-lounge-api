-- EI-Hub billing: dated history for what a claim says about a child
-- (lib/eiHistory.js, routes/eiHub.js). EI-Hub checks each claim against the
-- child's record as it stood on the date of service, and the agency must keep
-- what it billed and when it changed, so nothing here is overwritten: a change
-- takes effect from a date and the earlier version is kept, ended the day
-- before. Safe to run more than once.

-- What a claim says about the child, one row per version. start_date NULL =
-- from the beginning, end_date NULL = current. Name and date of birth as
-- EI-Hub has them, which can differ from the patient record's.
CREATE TABLE IF NOT EXISTS "PatientEiDetails" (
  id BIGSERIAL PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES "Patients"(id) ON DELETE CASCADE,
  start_date DATE,
  end_date DATE,
  ei_child_id TEXT,
  first_name TEXT,
  last_name TEXT,
  date_of_birth DATE,
  sex TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  county TEXT,
  diagnosis_codes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,   -- set when a version is corrected in place
  updated_at TIMESTAMPTZ,
  ended_by TEXT
);
CREATE INDEX IF NOT EXISTS patient_ei_details_patient ON "PatientEiDetails" (patient_id);

-- The referring provider on an authorization over time: EI-Hub allows a new
-- prescriber on the same authorization from a date, never overlapping.
CREATE TABLE IF NOT EXISTS "EiReferralPeriods" (
  id BIGSERIAL PRIMARY KEY,
  authorization_number TEXT NOT NULL,
  start_date DATE,
  end_date DATE,
  referring_last TEXT,
  referring_first TEXT,
  referring_npi TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  updated_at TIMESTAMPTZ,
  ended_by TEXT
);
CREATE INDEX IF NOT EXISTS ei_referral_periods_auth ON "EiReferralPeriods" (authorization_number);

-- Exactly what each claim was sent with (child, diagnoses, referring and
-- rendering provider, codes, charges), readable without the X12 file.
ALTER TABLE "EiClaims" ADD COLUMN IF NOT EXISTS details JSONB;

-- Bring over what's been entered so far as each child's first version (from
-- the beginning), only for patients with no history yet: re-running adds nothing.
INSERT INTO "PatientEiDetails" (patient_id, ei_child_id, date_of_birth, sex, address_line1, address_line2, city, state, zip, county, diagnosis_codes, created_by)
SELECT p.id, NULLIF(TRIM(COALESCE(p."ID_Number", '')), ''), p."Date_of_Birth", p.sex, p.address_line1, p.address_line2, p.city, p.state, p.zip, p.county, p.diagnosis_codes, 'migration'
FROM "Patients" p
WHERE (p.sex IS NOT NULL OR p.address_line1 IS NOT NULL OR p.county IS NOT NULL OR p.diagnosis_codes IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM "PatientEiDetails" d WHERE d.patient_id = p.id);

INSERT INTO "EiReferralPeriods" (authorization_number, referring_last, referring_first, referring_npi, created_by)
SELECT r.authorization_number, r.referring_last, r.referring_first, r.referring_npi, COALESCE(r.updated_by, 'migration')
FROM "EiReferrals" r
WHERE NOT EXISTS (SELECT 1 FROM "EiReferralPeriods" x WHERE x.authorization_number = r.authorization_number);
-- "EiReferrals" stays (now unused) until this has been checked in production.
