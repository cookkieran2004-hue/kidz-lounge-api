-- IFSP records (Oct 2026; the "ei" feature, PedsDesk only -- lib/features.js,
-- routes/ifsp.js). New tables only: nothing Kidz Lounge uses changes, and
-- they stay empty there. Safe to run more than once.
--
-- EiIfsps: every IFSP period a child has had ("Initial (6mo PR)", "First
-- Review (12mo PR)", ... or an amendment: the patient form's IFSP types),
-- typed in by the office from the IFSP document, which is attached as one
-- of the patient's documents (document_id). Each period ends at the next
-- review / annual meeting, with a progress report due before it. The
-- current one is the latest start date on or before today.
CREATE TABLE IF NOT EXISTS "EiIfsps" (
  id SERIAL PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES "Patients"(id) ON DELETE CASCADE,
  ifsp_type TEXT NOT NULL,
  meeting_date DATE,
  start_date DATE NOT NULL,
  end_date DATE,
  sc_name TEXT,
  sc_company TEXT,
  sc_phone TEXT,
  sc_email TEXT,
  document_id INTEGER,
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_by TEXT,
  updated_at TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ei_ifsps_patient ON "EiIfsps" (patient_id, start_date DESC);

-- An IFSP's outcomes (its goals), in order, and the services working on
-- each ('ST', 'OT', 'PT', 'SI', ...). Session notes and progress reports
-- will link to these later.
CREATE TABLE IF NOT EXISTS "EiIfspOutcomes" (
  id SERIAL PRIMARY KEY,
  ifsp_id INTEGER NOT NULL REFERENCES "EiIfsps"(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  services TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ei_ifsp_outcomes_ifsp ON "EiIfspOutcomes" (ifsp_id, position);

-- Turning 3: one row per child. The deadlines are worked out from the date
-- of birth (lib/ifsp.js); these are what actually happened.
CREATE TABLE IF NOT EXISTS "EiTransitions" (
  patient_id UUID PRIMARY KEY REFERENCES "Patients"(id) ON DELETE CASCADE,
  cpse_notified_date DATE,
  parent_opted_out BOOLEAN NOT NULL DEFAULT false,
  conference_date DATE,
  cpse_eligible TEXT CHECK (cpse_eligible IS NULL OR cpse_eligible IN ('pending', 'yes', 'no')),
  ei_end_date DATE,
  notes TEXT,
  updated_by TEXT,
  updated_at TIMESTAMP DEFAULT now()
);
