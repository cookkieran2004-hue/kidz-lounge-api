-- Records who created each time-off entry, so an entry an admin added for
-- an employee can show "Added by <admin>". Safe to run more than once.
-- Existing rows stay NULL (they were all submitted by the employee).
ALTER TABLE "TimeOffRequests" ADD COLUMN IF NOT EXISTS created_by TEXT;
