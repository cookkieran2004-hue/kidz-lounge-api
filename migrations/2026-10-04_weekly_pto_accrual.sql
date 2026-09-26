-- Weekly PTO accrual (lib/ptoAccrual.js) and the time-off ledger.
-- Safe to run more than once.

-- Balances need two decimal places: weekly credits are 0.08 x hours worked
-- (e.g. 31.5h -> 2.52h). The original column held one.
ALTER TABLE "TimeOffBalances" ALTER COLUMN balance_hours TYPE NUMERIC(8,2);

-- Every change to a PTO/UPTO balance, with the balance after it -- weekly
-- credits (with the hours they were based on), the monthly UPTO credit,
-- time off used and refunded, admin adjustments, the 120-hour cap, the
-- year-end carryover trim, and the Sep 1 2026 reset.
CREATE TABLE IF NOT EXISTS "TimeOffLedger" (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  balance_type TEXT NOT NULL CHECK (balance_type IN ('PTO', 'UPTO')),
  entry_date DATE NOT NULL,              -- the day it applies to
  kind TEXT NOT NULL CHECK (kind IN ('accrual', 'used', 'refund', 'adjustment', 'cap', 'carryover', 'reset')),
  hours NUMERIC(8,2) NOT NULL,           -- signed: + credited, - taken away
  balance_after NUMERIC(8,2) NOT NULL,
  period_start DATE,                     -- accrual: the week (Monday) or month it covers
  worked_hours NUMERIC(6,2),             -- weekly accrual: estimated hours worked
  request_id TEXT,                       -- used / refund: the time-off request
  note TEXT,
  details JSONB,                         -- weekly accrual: the day-by-day estimate
  created_by TEXT,                       -- username, or 'system'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS time_off_ledger_user ON "TimeOffLedger" (username, balance_type, entry_date DESC, id DESC);
-- One credit per person per period, so a re-run or catch-up never pays twice.
CREATE UNIQUE INDEX IF NOT EXISTS time_off_ledger_one_accrual
  ON "TimeOffLedger" (username, balance_type, period_start) WHERE kind = 'accrual';
CREATE UNIQUE INDEX IF NOT EXISTS time_off_ledger_one_carryover
  ON "TimeOffLedger" (username, balance_type, entry_date) WHERE kind = 'carryover';

-- What a PTO/UPTO request costs in scheduled hours (not clock hours). Set
-- when it's filed (an estimate for display), fixed when it's approved, and
-- refunded exactly when it's removed.
ALTER TABLE "TimeOffRequests" ADD COLUMN IF NOT EXISTS charged_hours NUMERIC(8,2);
