-- Help desk / support tickets. Anyone can submit one from the Help &
-- Support page (signed in or not); only the support owner (KJC135) sees
-- the inbox. Safe to run more than once.
CREATE TABLE IF NOT EXISTS "SupportTickets" (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_by TEXT,                 -- username, when signed in
  contact_name TEXT NOT NULL,
  contact_info TEXT NOT NULL,        -- email and/or phone
  urgency TEXT NOT NULL CHECK (urgency IN ('Low', 'Medium', 'High', 'Urgent')),
  issue TEXT NOT NULL,
  page TEXT,                         -- where they were when they opened Help
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  resolution_note TEXT,
  task_id TEXT                       -- the bell task created for it
);
CREATE INDEX IF NOT EXISTS support_tickets_status ON "SupportTickets" (status, created_at DESC);
