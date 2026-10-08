// Who is on a provider's caseload (Oct 2026, Kieran's rule).
//
// A patient is on a provider's caseload -- and that provider is one of the
// patient's current providers (their care team) -- when they have any
// appointment with that provider from today on (however far ahead), or had
// any appointment with them in the current calendar month. Any status
// counts, Canceled included. The "HOLD - see comments" placeholder is never
// a patient.
//
// Used by the billing sheet (routes/billing.js), the patient list's care
// team (routes/patients.js), the Report Date reminders
// (lib/complianceCheck.js) and the staff profile's caseload list.

const HOLD_PATIENT = 'hold - see comments';
const isHold = (name) => String(name || '').trim().toLowerCase() === HOLD_PATIENT;

// Today in the clinic's time zone (the Lambda runs in UTC), 'YYYY-MM-DD'.
function clinicToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
const monthStartOf = (dateStr) => `${String(dateStr).slice(0, 7)}-01`;

// Map of patient name -> Set of provider names, for everyone (or one
// patient / one provider). Single appointments from the 1st of this month
// on, plus weekly series still running then (their dates aren't stored as
// rows; a series counts as long as it hasn't ended before this month).
async function currentCaseloads(db, { today = clinicToday(), patientName = null, provider = null } = {}) {
  const since = monthStartOf(today);
  const filters = (params) => {
    let sql = '';
    if (patientName) { params.push(patientName); sql += ` AND patient_name = $${params.length}`; }
    if (provider) { params.push(provider); sql += ` AND provider = $${params.length}`; }
    return sql;
  };
  const singleParams = [since];
  const seriesParams = [since];
  const [single, series] = await Promise.all([
    db.query(
      `SELECT DISTINCT patient_name, provider FROM "Appointments"
       WHERE appointment_date >= $1 AND deleted = false AND provider IS NOT NULL${filters(singleParams)}`,
      singleParams
    ),
    db.query(
      `SELECT DISTINCT patient_name, provider FROM "RecurringSeries"
       WHERE (end_date IS NULL OR end_date >= $1) AND provider IS NOT NULL${filters(seriesParams)}`,
      seriesParams
    ),
  ]);
  const out = new Map();
  for (const r of [...single.rows, ...series.rows]) {
    if (isHold(r.patient_name)) continue;
    if (!out.has(r.patient_name)) out.set(r.patient_name, new Set());
    out.get(r.patient_name).add(r.provider);
  }
  return out;
}

module.exports = { HOLD_PATIENT, isHold, clinicToday, monthStartOf, currentCaseloads };
