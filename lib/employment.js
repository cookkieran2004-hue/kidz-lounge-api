// Employment type (Staff.employment_type, migrations/2026-10-12_employment_type.sql)
// decides which balance-type time off someone can take (Oct 2026 policy):
//   salaried -> PTO and UPTO
//   hourly   -> UPTO only
//   neither  -> neither
// Lunch / Meeting / Unavailable / Other are open to everyone. UPTO is
// unlimited (no balance; hours used are only counted). PTO is a balance
// admins set "as of" a date (PUT /time-off/balances/as-of); weekly accrual
// is paused (lib/ptoAccrual.js WEEKLY_ACCRUAL_ENABLED).

const EMPLOYMENT_TYPES = ['salaried', 'hourly', 'neither'];
const EMPLOYMENT_LABELS = { salaried: 'Salaried', hourly: 'Hourly', neither: 'Neither' };

// Only a "yes" is remembered, so a warm Lambda picks the column up once the
// migration has run. Before it has, everyone is treated as salaried (the
// old rules: anyone could request PTO and UPTO).
let columnExists = false;
async function hasEmploymentColumn(db) {
  if (columnExists) return true;
  try {
    const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'Staff' AND column_name = 'employment_type'`);
    columnExists = !!r.rows[0];
  } catch { columnExists = false; }
  return columnExists;
}

async function employmentTypeOf(db, username) {
  if (!(await hasEmploymentColumn(db))) return 'salaried';
  const r = await db.query('SELECT employment_type FROM "Staff" WHERE username = $1', [username]);
  return r.rows[0]?.employment_type || 'neither';
}

const allowedBalanceTypes = (type) => (type === 'salaried' ? ['PTO', 'UPTO'] : type === 'hourly' ? ['UPTO'] : []);

// null when allowed, otherwise the message to show. `self`: the person is
// asking for themselves (wording).
async function balanceTypeRefusal(db, username, requestType, self) {
  if (requestType !== 'PTO' && requestType !== 'UPTO') return null;
  const type = await employmentTypeOf(db, username);
  if (allowedBalanceTypes(type).includes(requestType)) return null;
  if (requestType === 'PTO' && type === 'hourly') {
    return self ? 'PTO is only for salaried staff. Request UPTO instead.' : `${username} is hourly, so they can take UPTO but not PTO.`;
  }
  return self
    ? "You're not set up for PTO or UPTO. Choose Lunch, Meeting, Unavailable or Other, or ask an admin about your employment type."
    : `${username}'s employment type is set to Neither, so they can't take PTO or UPTO. Change it on their profile first.`;
}

module.exports = { EMPLOYMENT_TYPES, EMPLOYMENT_LABELS, hasEmploymentColumn, employmentTypeOf, allowedBalanceTypes, balanceTypeRefusal };
