// Weekly PTO accrual, and the one place balances change.
//
// Every Sunday (EventBridge job 'pto-weekly-accrual') each active staff
// member is credited 0.08 hours of PTO per estimated hour worked Monday-
// Friday of the week just ended (lib/workSchedule.js), starting from the
// Sep 1 2026 policy start or their hire date. Rules:
//   - A balance at the 120-hour cap earns nothing; a credit that would pass
//     it tops the balance up to exactly 120.
//   - At the end of each calendar year a PTO balance over 40 hours is cut
//     to 40 (carryover).
//   - Each week is credited once: the ledger records it, so a re-run or a
//     late run catches up on missed weeks without ever paying twice.
// A week that runs over New Year is split, so December's days are credited
// before the carryover trim and January's after.

const {
  PTO_RATE, PTO_BALANCE_CAP, PTO_CARRYOVER_MAX, POLICY_START,
  addDays, mondayOf, round2, todayStr, estimateWeekFor,
} = require('./workSchedule');

// Only a "yes" is remembered: until the migration has run this keeps
// checking, so a warm Lambda starts using the ledger as soon as it exists.
let ledgerTableExists = false;
async function hasLedgerTable(db) {
  if (ledgerTableExists) return true;
  try {
    const r = await db.query(`SELECT to_regclass('"TimeOffLedger"') IS NOT NULL AS ok`);
    ledgerTableExists = !!r.rows[0]?.ok;
  } catch {
    ledgerTableExists = false;
  }
  return ledgerTableExists;
}

// Changes one balance and records why. Pass `delta` (+/- hours) or `setTo`
// (a new balance). Run inside the caller's transaction; the balance row is
// locked so two changes can't overwrite each other. Returns { before, after }.
async function adjustBalance(q, {
  username, type, delta, setTo, kind, entryDate, periodStart = null, workedHours = null,
  requestId = null, note = null, details = null, createdBy = 'system',
}) {
  const row = (await q.query(
    'SELECT balance_hours FROM "TimeOffBalances" WHERE username=$1 AND balance_type=$2 FOR UPDATE',
    [username, type]
  )).rows[0];
  const before = row ? Number(row.balance_hours) : 0;
  const after = round2(setTo !== undefined ? setTo : before + delta);
  await q.query(
    `INSERT INTO "TimeOffBalances" (username, balance_type, balance_hours)
     VALUES ($1, $2, $3)
     ON CONFLICT (username, balance_type) DO UPDATE SET balance_hours = $3, updated_at = now()`,
    [username, type, after]
  );
  if (await hasLedgerTable(q)) {
    await q.query(
      `INSERT INTO "TimeOffLedger" (username, balance_type, entry_date, kind, hours, balance_after, period_start, worked_hours, request_id, note, details, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [username, type, entryDate || todayStr(), kind, round2(after - before), after, periodStart, workedHours,
        requestId === null ? null : String(requestId), note, details ? JSON.stringify(details) : null, createdBy]
    );
  }
  return { before, after };
}

// Runs `fn` in a transaction on a pooled client. Given a client that's
// already checked out (it has release()), `fn` joins that client's own
// transaction instead -- how the one-time reset script runs everything.
async function inTransaction(db, fn) {
  if (!db.connect || db.release) return fn(db);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// The accrual periods to consider for someone: each Monday-Friday week
// from `from`, split at New Year, that has had its Sunday by `today`.
function periodsSince(from, today) {
  const periods = [];
  for (let monday = mondayOf(from); addDays(monday, 6) <= today; monday = addDays(monday, 7)) {
    const start = monday < from ? from : monday;
    const friday = addDays(monday, 4);
    if (start > friday) continue;
    const newYear = `${friday.slice(0, 4)}-01-01`;
    if (start < newYear) {
      periods.push({ monday, start, end: addDays(newYear, -1) });
      periods.push({ monday, start: newYear, end: friday });
    } else {
      periods.push({ monday, start, end: friday });
    }
  }
  return periods;
}

async function creditPeriod(q, staff, period) {
  const done = await q.query(
    `SELECT 1 FROM "TimeOffLedger" WHERE username=$1 AND balance_type='PTO' AND kind='accrual' AND period_start=$2`,
    [staff.username, period.start]
  );
  if (done.rows[0]) return null;
  const week = await estimateWeekFor(q, staff, period.monday, period.start);
  const days = week.days.filter(d => d.date <= period.end);
  const worked = round2(days.reduce((s, d) => s + d.worked, 0));
  const earned = round2(worked * PTO_RATE);
  const current = Number((await q.query(
    `SELECT balance_hours FROM "TimeOffBalances" WHERE username=$1 AND balance_type='PTO'`, [staff.username]
  )).rows[0]?.balance_hours ?? 0);
  const room = round2(Math.max(0, PTO_BALANCE_CAP - current));
  const credit = Math.min(earned, room);
  const note = credit < earned
    ? (credit === 0 ? `At the ${PTO_BALANCE_CAP}-hour cap: ${earned}h not credited` : `Topped up to the ${PTO_BALANCE_CAP}-hour cap (${earned}h earned)`)
    : `${worked}h worked x ${PTO_RATE}`;
  return adjustBalance(q, {
    username: staff.username, type: 'PTO', delta: credit, kind: 'accrual',
    entryDate: addDays(period.monday, 6), periodStart: period.start, workedHours: worked, note,
    details: { kind: week.kind, earned, rate: PTO_RATE, cap: PTO_BALANCE_CAP, days },
  });
}

async function applyCarryover(q, username, year) {
  const yearEnd = `${year}-12-31`;
  const done = await q.query(
    `SELECT 1 FROM "TimeOffLedger" WHERE username=$1 AND balance_type='PTO' AND kind='carryover' AND entry_date=$2`,
    [username, yearEnd]
  );
  if (done.rows[0]) return;
  const current = Number((await q.query(
    `SELECT balance_hours FROM "TimeOffBalances" WHERE username=$1 AND balance_type='PTO'`, [username]
  )).rows[0]?.balance_hours ?? 0);
  await adjustBalance(q, {
    username, type: 'PTO', setTo: current > PTO_CARRYOVER_MAX ? PTO_CARRYOVER_MAX : current, kind: 'carryover', entryDate: yearEnd,
    note: current > PTO_CARRYOVER_MAX ? `Year-end carryover: ${PTO_CARRYOVER_MAX}h kept, ${round2(current - PTO_CARRYOVER_MAX)}h not carried over` : `Year-end carryover: all ${current}h kept`,
  });
}

// Credits every completed, not-yet-credited week for everyone.
async function runWeeklyPtoAccrual(db, { now = new Date(), onlyUsername = null } = {}) {
  if (!(await hasLedgerTable(db))) {
    console.log('Weekly PTO accrual skipped: run migrations/2026-10-04_weekly_pto_accrual.sql first.');
    return { credited: 0 };
  }
  const today = todayStr(now);
  const staffRes = await db.query(
    `SELECT username, provider_name, hire_date FROM "Staff" WHERE archived=false ${onlyUsername ? 'AND username=$1' : ''} ORDER BY username`,
    onlyUsername ? [onlyUsername] : []
  );
  let credited = 0;
  for (const staff of staffRes.rows) {
    const hire = staff.hire_date ? String(staff.hire_date).slice(0, 10) : null;
    const from = hire && hire > POLICY_START ? hire : POLICY_START;
    for (const period of periodsSince(from, today)) {
      await inTransaction(db, async (client) => {
        // Close out any earlier year before crediting anything in a new one
        // (periods run in date order, so its last week is already credited;
        // applyCarryover does nothing if that year is already done).
        const year = Number(period.start.slice(0, 4));
        for (let y = Number(from.slice(0, 4)); y < year; y++) await applyCarryover(client, staff.username, y);
        if (await creditPeriod(client, staff, period)) credited++;
      });
    }
    // A year whose last week is fully credited gets its carryover now,
    // even before anything in the new year is.
    const lastYear = Number(today.slice(0, 4)) - 1;
    const lastWeekSunday = addDays(mondayOf(`${lastYear}-12-31`), 6);
    if (lastYear >= Number(from.slice(0, 4)) && lastWeekSunday <= today) {
      await inTransaction(db, (client) => applyCarryover(client, staff.username, lastYear));
    }
  }
  console.log(`Weekly PTO accrual: ${credited} week(s) credited.`);
  return { credited };
}

module.exports = { adjustBalance, hasLedgerTable, inTransaction, runWeeklyPtoAccrual, periodsSince, applyCarryover };
