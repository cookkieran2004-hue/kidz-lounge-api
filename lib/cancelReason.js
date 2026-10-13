// Why a canceled offsite session didn't happen (migrations/2026-11-01_cancel_reason.sql):
// 'holiday' | 'emergency' | 'other' | null. Kept only while the session is
// Canceled AND offsite; any other status or an in-office room clears it, so
// a stale reason can never reach the billing sheet (H / Z there).
const CANCEL_REASONS = ['holiday', 'emergency', 'other'];

const isOffsiteArea = (area) => /^Offsite\b/.test(String(area || ''));

function normalizeCancelReason(status, area, requested) {
  if (status !== 'Canceled' || !isOffsiteArea(area)) return null;
  return CANCEL_REASONS.includes(requested) ? requested : null;
}

// Positive-only cache: works before the migration (the reason just isn't
// saved), and a warm Lambda picks the column up once it's there.
let columnSeen = false;
async function hasCancelReasonColumn(db) {
  if (columnSeen) return true;
  const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'Appointments' AND column_name = 'cancel_reason'`);
  if (r.rows.length) columnSeen = true;
  return columnSeen;
}

// After an appointment row is written: saves the reason the body asked for
// (or, when the body didn't mention it, keeps the one it had), normalized
// against the row's final status and room. Returns the up-to-date row.
async function applyCancelReason(db, row, body) {
  if (!row || !(await hasCancelReasonColumn(db))) return row;
  const requested = body.cancel_reason !== undefined ? body.cancel_reason : row.cancel_reason;
  const reason = normalizeCancelReason(row.appointment_status, row.treatment_area, requested);
  if ((row.cancel_reason ?? null) === reason) return row;
  const r = await db.query('UPDATE "Appointments" SET cancel_reason=$1 WHERE id=$2 RETURNING *', [reason, row.id]);
  return r.rows[0];
}

module.exports = { CANCEL_REASONS, isOffsiteArea, normalizeCancelReason, applyCancelReason };
