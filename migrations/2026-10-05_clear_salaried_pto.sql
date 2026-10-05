-- One-time (Oct 2026): clear salaried staff's PTO so starting balances can
-- be entered by hand as of Sep 30 (Time off > Balances > Enter starting PTO).
-- Run AFTER 2026-10-12_employment_type.sql and after setting everyone's
-- employment type. Salaried staff only:
--   * deletes every accrual (and its cap trims), whatever the date
--   * deletes every other history entry dated before 2026-09-30
--   * keeps requests and the PTO taken from Sep 30 on
--   * PTO balance = 0 less the PTO taken since Sep 30, so history adds up
BEGIN;

DELETE FROM "TimeOffLedger" l
USING "Staff" s
WHERE l.username = s.username
  AND s.employment_type = 'salaried'
  AND (l.kind IN ('accrual', 'cap') OR l.entry_date < '2026-09-30');

UPDATE "TimeOffBalances" b
SET balance_hours = COALESCE((
      SELECT SUM(l.hours) FROM "TimeOffLedger" l
      WHERE l.username = b.username AND l.balance_type = 'PTO'), 0),
    updated_at = now()
FROM "Staff" s
WHERE b.username = s.username
  AND s.employment_type = 'salaried'
  AND b.balance_type = 'PTO';

COMMIT;
