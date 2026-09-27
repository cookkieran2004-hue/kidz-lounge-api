-- Waitlist (routes/waitlist.js): patients waiting to start a service. One
-- row per patient per specialty, so a child waiting for ST and OT has two
-- entries that are scheduled (or removed) separately. Safe to run more
-- than once.
CREATE TABLE IF NOT EXISTS "Waitlist" (
  id BIGSERIAL PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES "Patients"(id) ON DELETE CASCADE,
  specialty TEXT NOT NULL CHECK (specialty IN ('PT', 'OT', 'ST', 'SI')),
  preferred_provider TEXT,                    -- "Providers"."Name"; NULL = any provider
  available_days SMALLINT[] NOT NULL DEFAULT '{}', -- 1 = Mon ... 5 = Fri; empty = any day
  available_from TIME,                        -- NULL = no earliest time
  available_to TIME,                          -- NULL = no latest time
  referral_date DATE NOT NULL DEFAULT CURRENT_DATE, -- the wait counts from here
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'contacted', 'scheduled', 'removed')),
  contacted_at TIMESTAMPTZ,
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,                      -- when it was scheduled or removed
  closed_by TEXT
);
CREATE INDEX IF NOT EXISTS waitlist_status ON "Waitlist" (status, referral_date);
-- A patient can only be on the list once per specialty at a time.
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_one_active
  ON "Waitlist" (patient_id, specialty) WHERE status IN ('waiting', 'contacted');
