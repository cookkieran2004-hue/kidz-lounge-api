-- EI-Hub 837P billing, part 1: the details every claim needs (routes/eiHub.js).
-- Safe to run more than once.

-- The agency (billing provider and submitter). One row.
CREATE TABLE IF NOT EXISTS "EiBillingSettings" (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  agency_name TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  npi TEXT,           -- the agency's (Type 2) NPI: claim billing provider
  tax_id TEXT,        -- 9 digits, no dash: also the EI-Hub submitter ID
  contact_name TEXT,  -- EDI contact on every file
  contact_phone TEXT,
  contact_email TEXT,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Each provider as EI-Hub knows them (rendering provider), and the CPT codes
-- their sessions bill by default, per discipline: {"OT": ["97530", "97533"]}.
ALTER TABLE "Providers" ADD COLUMN IF NOT EXISTS npi TEXT;
ALTER TABLE "Providers" ADD COLUMN IF NOT EXISTS ei_first_name TEXT;
ALTER TABLE "Providers" ADD COLUMN IF NOT EXISTS ei_last_name TEXT;
ALTER TABLE "Providers" ADD COLUMN IF NOT EXISTS ei_default_codes JSONB;

-- The child as EI-Hub has them (claim subscriber), and their diagnoses
-- (ICD-10, comma-separated, in the order they go on the claim).
ALTER TABLE "Patients" ADD COLUMN IF NOT EXISTS sex TEXT;
ALTER TABLE "Patients" ADD COLUMN IF NOT EXISTS address_line1 TEXT;
ALTER TABLE "Patients" ADD COLUMN IF NOT EXISTS address_line2 TEXT;
ALTER TABLE "Patients" ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE "Patients" ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE "Patients" ADD COLUMN IF NOT EXISTS zip TEXT;
ALTER TABLE "Patients" ADD COLUMN IF NOT EXISTS county TEXT;
ALTER TABLE "Patients" ADD COLUMN IF NOT EXISTS diagnosis_codes TEXT;

-- The referring provider for each EI service authorization: it must match
-- EI-Hub's "Scripts, Orders, Recommendations, and Referrals" panel for that
-- authorization, so it's kept by authorization number.
CREATE TABLE IF NOT EXISTS "EiReferrals" (
  authorization_number TEXT PRIMARY KEY,
  referring_last TEXT,   -- or the organization's name
  referring_first TEXT,  -- empty for an organization
  referring_npi TEXT,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
