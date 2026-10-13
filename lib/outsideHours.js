// "Outside hours" sessions (migrations/2026-11-02_outside_hours.sql): a
// provider's extra offsite visits outside contracted and office hours.
// The flag only sticks on an offsite session (home, school or center).
// Billing counts one on an office-closure day as a normal session.
const { isOffsiteArea } = require('./cancelReason');

const normalizeOutsideHours = (flag, area) => flag === true && isOffsiteArea(area);

// Positive-only cache per table: works before the migration (the flag just
// isn't saved), and a warm Lambda picks the columns up once they're there.
const seen = new Set();
async function hasOutsideHoursColumn(db, table) {
  if (seen.has(table)) return true;
  const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'outside_hours'`, [table]);
  if (r.rows.length) seen.add(table);
  return seen.has(table);
}

// After a row is written: saves the flag the body asked for (or, when the
// body didn't mention it, `fallback`, else the row's own), normalized
// against its final room. Returns the up-to-date row.
async function applyOutsideHours(db, row, body, { table = 'Appointments', fallback } = {}) {
  if (!row || !(await hasOutsideHoursColumn(db, table))) return row;
  const requested = body.outside_hours !== undefined ? body.outside_hours : fallback !== undefined ? fallback : row.outside_hours;
  const value = normalizeOutsideHours(requested, row.treatment_area);
  if (!!row.outside_hours === value) return row;
  const r = await db.query(`UPDATE "${table}" SET outside_hours=$1 WHERE id=$2 RETURNING *`, [value, row.id]);
  return r.rows[0];
}

module.exports = { normalizeOutsideHours, hasOutsideHoursColumn, applyOutsideHours };
