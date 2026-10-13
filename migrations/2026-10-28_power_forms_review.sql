-- Power Forms: a completed form "Needs review" until someone reviews it
-- (Kieran, Oct 2026). Reviewing (or applying its answers to the chart)
-- also completes the review tasks made when the parent submitted it.
-- Safe to run more than once.
ALTER TABLE "PowerFormRequests" ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE "PowerFormRequests" ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
-- Forms whose answers were already applied before this ran count as reviewed.
UPDATE "PowerFormRequests" SET reviewed_at = applied_at, reviewed_by = applied_by
  WHERE reviewed_at IS NULL AND applied_at IS NOT NULL;
