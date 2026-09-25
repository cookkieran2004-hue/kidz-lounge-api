// Reasonable starting defaults, now in hours since Time Off tracks PTO and
// UPTO by the hour instead of Vacation/Sick/Personal by the day. Easy to
// adjust later -- each admin can also manually correct anyone's balance
// directly via PUT /time-off/balances.
const ANNUAL_HOURS = { PTO: 80, UPTO: 40 };

function firstOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1).toISOString().slice(0, 10);
}

// Runs monthly (triggered the same way the compliance check is -- an
// EventBridge job hitting this Lambda). Credits every active staff member
// 1/12th of each type's annual amount, skipping anyone already credited
// for the current month so re-running this safely never double-credits.
// A new hire's first month is prorated by how much of that month is left
// from their hire date forward.
async function runTimeOffAccrual(db) {
  const today = new Date();
  const monthKey = firstOfMonth(today);
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

  const staffRes = await db.query('SELECT username, hire_date FROM "Staff" WHERE archived=false');
  let creditedCount = 0;

  for (const staff of staffRes.rows) {
    let prorationFactor = 1;
    if (staff.hire_date) {
      const hireDate = new Date(staff.hire_date + 'T00:00:00');
      const hireMonthKey = firstOfMonth(hireDate);
      if (hireMonthKey === monthKey) {
        const remainingDays = daysInMonth - hireDate.getDate() + 1;
        prorationFactor = remainingDays / daysInMonth;
      } else if (hireDate > today) {
        continue; // hasn't started yet
      }
    }

    for (const [balanceType, annualHours] of Object.entries(ANNUAL_HOURS)) {
      const existing = await db.query(
        'SELECT balance_hours, last_accrued_month FROM "TimeOffBalances" WHERE username=$1 AND balance_type=$2',
        [staff.username, balanceType]
      );
      const row = existing.rows[0];
      if (row && row.last_accrued_month === monthKey) continue; // already credited this month

      const monthlyAmount = Math.round((annualHours / 12) * prorationFactor * 4) / 4; // rounded to nearest quarter hour
      const currentBalance = row ? Number(row.balance_hours) : 0;
      const newBalance = currentBalance + monthlyAmount;

      await db.query(
        `INSERT INTO "TimeOffBalances" (username, balance_type, balance_hours, last_accrued_month)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (username, balance_type) DO UPDATE SET balance_hours = $3, last_accrued_month = $4, updated_at = now()`,
        [staff.username, balanceType, newBalance, monthKey]
      );
      creditedCount++;
    }
  }

  console.log(`Time-off accrual: credited ${creditedCount} balance line(s) for ${monthKey}.`);
}

module.exports = { runTimeOffAccrual };
