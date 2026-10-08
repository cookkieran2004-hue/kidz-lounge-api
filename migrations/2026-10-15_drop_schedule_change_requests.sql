-- The approval step for changes to past appointments was removed (Oct 2026).
-- Drops its table if the 2026-10-13 billing migration created it. Any
-- requests still waiting are discarded. Safe to run more than once.
DROP TABLE IF EXISTS "ScheduleChangeRequests";
