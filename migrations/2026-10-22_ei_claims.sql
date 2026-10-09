-- EI-Hub 837P billing, part 2: claim files (routes/eiHub.js, lib/ei837.js).
-- Safe to run more than once.

-- Codes changed for one session (one per line); otherwise the provider's
-- defaults apply. session_key as in "EiHubEntries" (appt:<id> or
-- series:<series id>:<date>).
CREATE TABLE IF NOT EXISTS "EiSessionCodes" (
  session_key TEXT PRIMARY KEY,
  codes JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every 837P file made. The id is the file's control number; the invoice
-- number and file name must never repeat (EI-Hub refuses a reused one).
-- The file itself is kept so it can be downloaded again.
CREATE TABLE IF NOT EXISTS "EiClaimFiles" (
  id SERIAL PRIMARY KEY,
  file_name TEXT UNIQUE,
  invoice_number TEXT UNIQUE,
  test BOOLEAN NOT NULL DEFAULT false,
  month TEXT,
  claim_count INTEGER NOT NULL DEFAULT 0,
  content TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every claim (one session) in a file. A session in a production file isn't
-- offered again; test files don't count. status: sent until EI-Hub's 277CA
-- says accepted (with its claim id) or rejected (part 3).
CREATE TABLE IF NOT EXISTS "EiClaims" (
  claim_number TEXT PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES "EiClaimFiles"(id),
  session_key TEXT NOT NULL,
  test BOOLEAN NOT NULL DEFAULT false,
  patient_name TEXT,
  provider TEXT,
  appointment_date DATE,
  start_time TEXT,
  end_time TEXT,
  service TEXT,
  authorization_number TEXT,
  codes JSONB,
  charge NUMERIC(10, 2),
  status TEXT NOT NULL DEFAULT 'sent',
  status_detail TEXT,
  eihub_claim_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ei_claims_session ON "EiClaims" (session_key);
