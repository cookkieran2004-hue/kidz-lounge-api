-- Deleted PTO/UPTO requests no longer appear in the balance history (their
-- "used" entry is removed instead of a refund being added -- removeUsage in
-- lib/ptoAccrual.js). This clears the used + refund pairs recorded before
-- that change. Each pair cancels out, so no balance changes, and the
-- history's running balances are worked out from today's balance, so they
-- stay correct. Safe to run more than once.
WITH pairs AS (
  SELECT u.id AS used_id, r.id AS refund_id
  FROM "TimeOffLedger" u
  JOIN "TimeOffLedger" r
    ON r.kind = 'refund' AND u.kind = 'used'
   AND r.username = u.username AND r.balance_type = u.balance_type
   AND r.request_id = u.request_id AND r.hours = -u.hours
)
DELETE FROM "TimeOffLedger"
WHERE id IN (SELECT used_id FROM pairs UNION SELECT refund_id FROM pairs);
