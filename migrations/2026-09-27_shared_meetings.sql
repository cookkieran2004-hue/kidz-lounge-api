-- Shared meetings, "Other" details, and notes on the schedule.
-- Run AFTER 2026-09-26_ooo_edits_and_meeting_agendas.sql. Safe to run more than once.

-- 1. Who else is in a meeting (usernames). The organizer is the request's own username.
ALTER TABLE "TimeOffRequests" ADD COLUMN IF NOT EXISTS attendees TEXT[] NOT NULL DEFAULT '{}';

-- 2. Every calendar block made from a time-off entry remembers which entry
--    it came from -- the organizer's block and each attendee's copy -- so
--    they share one agenda and comment thread and move together on changes.
ALTER TABLE "Out_of_Office"       ADD COLUMN IF NOT EXISTS time_off_request_id TEXT;
ALTER TABLE "OOO_RecurringSeries" ADD COLUMN IF NOT EXISTS time_off_request_id TEXT;

--    Fill it in for entries approved before today:
UPDATE "OOO_RecurringSeries" s SET time_off_request_id = r.id::text
  FROM "TimeOffRequests" r
  WHERE s.time_off_request_id IS NULL AND r.resulting_series_id IS NOT NULL AND r.resulting_series_id::text = s.id::text;
UPDATE "Out_of_Office" o SET time_off_request_id = r.id::text
  FROM "TimeOffRequests" r
  WHERE o.time_off_request_id IS NULL AND r.resulting_ooo_id IS NOT NULL AND r.resulting_ooo_id::text = o.id::text;
--    (multi-day PTO/UPTO: every day's block, not just the first)
UPDATE "Out_of_Office" o SET time_off_request_id = r.id::text
  FROM "TimeOffRequests" r JOIN "Staff" st ON st.username = r.username
  WHERE o.time_off_request_id IS NULL AND r.status = 'approved' AND r.is_balance_type
    AND o.provider = st.provider_name AND o.type = r.request_type
    AND o.ooo_date BETWEEN r.start_date AND r.end_date;

-- 3. Agendas now belong to the meeting (the time-off entry), not to one
--    person's calendar block. Re-point any saved since the last update.
UPDATE "MeetingAgendas" a SET ref_id = r.id::text
  FROM "TimeOffRequests" r
  WHERE a.kind IN ('series', 'week') AND r.resulting_series_id IS NOT NULL AND a.ref_id = r.resulting_series_id::text;
UPDATE "MeetingAgendas" a SET ref_id = r.id::text
  FROM "TimeOffRequests" r
  WHERE a.kind = 'single' AND r.resulting_ooo_id IS NOT NULL AND a.ref_id = r.resulting_ooo_id::text;

-- 4. One comment thread per meeting (per week for a recurring meeting),
--    shared by everyone in it. Same comment format as Out_of_Office.comments.
CREATE TABLE IF NOT EXISTS "MeetingComments" (
  id BIGSERIAL PRIMARY KEY,
  request_ref TEXT NOT NULL,
  occurrence_date DATE,
  comments TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS meeting_comments_key
  ON "MeetingComments" (request_ref, COALESCE(occurrence_date, DATE '1900-01-01'));
