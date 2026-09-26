// Monthly UPTO credit. PTO no longer accrues monthly -- it's earned weekly
// from hours worked (lib/ptoAccrual.js). UPTO stays a flat 40 hours a year:
// 1/12th credited on the 1st of each month, rounded to the nearest quarter
// hour, a new hire's first month prorated by how much of it is left.
//
// Runs monthly (EventBridge job 'time-off-accrual'). Skips anyone already
// credited for the month, so re-running never double-credits.

const { adjustBalance, inTransaction } = require('./ptoAccrual');

const UPTO_ANNUAL_HOURS = 40;
const UPTO_MONTHLY_HOURS = Math.round((UPTO_ANNUAL_HOURS / 12) * 4) / 4;

function firstOfMonth(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

async function runTimeOffAccrual(db) {
  const today = new Date();
  const monthKey = firstOfMonth(today);
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

  const staffRes = await db.query('SELECT username, hire_date FROM "Staff" WHERE archived=false');
  let creditedCount = 0;

  for (const staff of staffRes.rows) {
    let prorationFactor = 1;
    if (staff.hire_date) {
      const hireDate = new Date(String(staff.hire_date).slice(0, 10) + 'T00:00:00');
      if (firstOfMonth(hireDate) === monthKey) {
        prorationFactor = (daysInMonth - hireDate.getDate() + 1) / daysInMonth;
      } else if (hireDate > today) {
        continue; // hasn't started yet
      }
    }

    const existing = await db.query(
      `SELECT last_accrued_month FROM "TimeOffBalances" WHERE username=$1 AND balance_type='UPTO'`,
      [staff.username]
    );
    const lastMonth = existing.rows[0]?.last_accrued_month ? String(existing.rows[0].last_accrued_month).slice(0, 10) : null;
    if (lastMonth === monthKey) continue; // already credited this month

    const amount = Math.round((UPTO_ANNUAL_HOURS / 12) * prorationFactor * 4) / 4;
    await inTransaction(db, async (client) => {
      await adjustBalance(client, {
        username: staff.username, type: 'UPTO', delta: amount, kind: 'accrual', entryDate: monthKey, periodStart: monthKey,
        note: prorationFactor < 1 ? `Monthly UPTO (first month, prorated)` : 'Monthly UPTO',
      });
      await client.query(`UPDATE "TimeOffBalances" SET last_accrued_month=$1 WHERE username=$2 AND balance_type='UPTO'`, [monthKey, staff.username]);
    });
    creditedCount++;
  }

  console.log(`Monthly UPTO accrual: credited ${creditedCount} staff for ${monthKey}.`);
}

module.exports = { runTimeOffAccrual, UPTO_MONTHLY_HOURS, UPTO_ANNUAL_HOURS };
