-- Out-of-office edits from My time + meeting agendas.
-- Safe to run more than once.

-- 1. A change to an already-approved entry is filed as a new pending
--    request pointing at the one it replaces (stored as text so it works
--    whether request ids are integers or uuids).
ALTER TABLE "TimeOffRequests" ADD COLUMN IF NOT EXISTS replaces_request_id TEXT;

-- 2. Meeting agendas.
--    kind = 'series' : the recurring agenda        (ref_id = OOO_RecurringSeries id)
--    kind = 'week'   : "this week only" notes      (ref_id = series id, occurrence_date = that week's date)
--    kind = 'single' : a one-time meeting's agenda (ref_id = Out_of_Office id)
CREATE TABLE IF NOT EXISTS "MeetingAgendas" (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('series', 'week', 'single')),
  ref_id TEXT NOT NULL,
  occurrence_date DATE,
  agenda TEXT NOT NULL DEFAULT '',
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS meeting_agendas_key
  ON "MeetingAgendas" (kind, ref_id, COALESCE(occurrence_date, DATE '1900-01-01'));
