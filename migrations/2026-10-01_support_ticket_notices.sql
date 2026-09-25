-- Popup for the sender when their support ticket is resolved.
-- notice_seen_at: when the sender dismissed the "resolved" popup. Cleared
-- each time the ticket is resolved, so a reopened-then-resolved ticket
-- pops up again. Run after 2026-09-30_support_tickets.sql. Safe to re-run.
ALTER TABLE "SupportTickets" ADD COLUMN IF NOT EXISTS notice_seen_at TIMESTAMPTZ;
-- Tickets already resolved before this update don't pop up out of the blue.
UPDATE "SupportTickets" SET notice_seen_at = COALESCE(resolved_at, now())
  WHERE status = 'resolved' AND notice_seen_at IS NULL;
