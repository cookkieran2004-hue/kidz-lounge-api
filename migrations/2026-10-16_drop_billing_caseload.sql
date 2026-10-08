-- The billing sheet now follows the schedule (lib/caseload.js), so patients
-- are no longer locked onto a month's sheet. Drops the lock table if the
-- 2026-10-13 billing migration created it. Safe to run more than once.
DROP TABLE IF EXISTS "BillingCaseload";
