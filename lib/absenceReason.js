// Why a child missed a session (migrations/2026-11-03_absence_reason.sql):
// 'illness' | 'vacation' | 'other' | null. The appointment window asks for
// it when an EI session is Canceled or No Show (only where the "mandates"
// feature is on, lib/features.js). It decides whether NYS's make-up policy
// lets the session be made up: a family vacation can't be (lib/mandates.js).
// Kept only while the session is Canceled / No Show for a child absence: any
// other status, or a holiday / emergency closure reason, clears it.
const ABSENCE_REASONS = ['illness', 'vacation', 'other'];
const CHILD_ABSENT = ['Canceled', 'No Show'];

function normalizeAbsenceReason(row, requested) {
  if (!CHILD_ABSENT.includes(row.appointment_status)) return null;
  if (row.cancel_reason === 'holiday' || row.cancel_reason === 'emergency') return null;
  return ABSENCE_REASONS.includes(requested) ? requested : null;
}

// Positive-only cache: works before the migration (the reason just isn't saved).
let columnSeen = false;
async function hasAbsenceReasonColumn(db) {
  if (columnSeen) return true;
  const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'Appointments' AND column_name = 'absence_reason'`);
  if (r.rows.length) columnSeen = true;
  return columnSeen;
}

// After an appointment row is written (and its cancel reason settled):
// saves the reason the body asked for, or keeps the one it had when the
// body didn't mention it. Returns the up-to-date row.
async function applyAbsenceReason(db, row, body) {
  if (!row || !(await hasAbsenceReasonColumn(db))) return row;
  const requested = body.absence_reason !== undefined ? body.absence_reason : row.absence_reason;
  const reason = normalizeAbsenceReason(row, requested);
  if ((row.absence_reason ?? null) === reason) return row;
  const r = await db.query('UPDATE "Appointments" SET absence_reason=$1 WHERE id=$2 RETURNING *', [reason, row.id]);
  return r.rows[0];
}

module.exports = { ABSENCE_REASONS, normalizeAbsenceReason, applyAbsenceReason };
