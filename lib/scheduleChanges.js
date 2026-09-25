// Scheduled changes to providers' contracted weekly hours
// (migrations/2026-09-29_schedule_changes.sql).
//
// Which hours apply on a date: among the changes covering that date
// (start_date <= date, and no end_date or end_date >= date), the one that
// started most recently wins; with none, the standing hours
// (ProviderUsualSchedule) apply. So a permanent change on Nov 1 plus a
// temporary Dec 20 - Jan 2 change gives: Nov 1 hours, holiday hours over
// the holidays, then Nov 1 hours again.

let tablePromise = null;
function hasChangesTable(db) {
  if (!tablePromise) {
    tablePromise = db.query(`SELECT to_regclass('"ProviderScheduleChanges"') IS NOT NULL AND to_regclass('"ProviderScheduleChangeDays"') IS NOT NULL AS ok`)
      .then(r => !!r.rows[0]?.ok)
      .catch(() => false);
  }
  return tablePromise;
}

// Changes that could apply anywhere in [start, end], grouped by provider:
// { providerName: [{ id, start_date, end_date, days: { weekday: { start_time, end_time } } }] }
async function loadChangesByProvider(db, { start, end, provider = null }) {
  if (!(await hasChangesTable(db))) return {};
  const params = [start, end];
  let sql = `SELECT id, provider, start_date, end_date FROM "ProviderScheduleChanges"
             WHERE start_date <= $2 AND (end_date IS NULL OR end_date >= $1)`;
  if (provider) { params.push(provider); sql += ` AND provider = $3`; }
  const changes = (await db.query(sql, params)).rows;
  if (!changes.length) return {};
  const days = (await db.query(
    'SELECT change_id, weekday, start_time, end_time FROM "ProviderScheduleChangeDays" WHERE change_id::text = ANY($1)',
    [changes.map(c => String(c.id))]
  )).rows;
  const byProvider = {};
  for (const c of changes) {
    const entry = { id: c.id, start_date: c.start_date, end_date: c.end_date, days: {} };
    days.filter(d => String(d.change_id) === String(c.id)).forEach(d => { entry.days[Number(d.weekday)] = d; });
    (byProvider[c.provider] = byProvider[c.provider] || []).push(entry);
  }
  return byProvider;
}

// The weekday -> hours map in effect on `dateStr`.
function scheduleForDate(standingByWeekday, changes, dateStr) {
  let pick = null;
  for (const c of changes || []) {
    if (c.start_date > dateStr || (c.end_date && c.end_date < dateStr)) continue;
    if (!pick || c.start_date > pick.start_date || (c.start_date === pick.start_date && Number(c.id) > Number(pick.id))) pick = c;
  }
  return pick ? pick.days : standingByWeekday;
}

module.exports = { hasChangesTable, loadChangesByProvider, scheduleForDate };
