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

const { expandSeriesOccurrences, loadExceptionDates } = require('./recurring');

const HOLD_PATIENT = 'hold - see comments';
// How far ahead a never-ending weekly series is checked for a session.
const SERIES_HORIZON_DAYS = 730;
const isHold = (name) => String(name || '').trim().toLowerCase() === HOLD_PATIENT;

// Today in the clinic's time zone (the Lambda runs in UTC), 'YYYY-MM-DD'.
function clinicToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
const monthStartOf = (dateStr) => `${String(dateStr).slice(0, 7)}-01`;

// Map of patient name -> Set of provider names, for everyone (or one
// patient / one provider). Single appointments from the 1st of this month
// on (moved or edited series sessions are stored as single rows too, under
// whoever they're with now), plus weekly series that still have a session
// of their own from then on. A series whose remaining sessions were all
// deleted or moved away doesn't count: it was putting patients with nothing
// scheduled on a caseload (Oct 2026).
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
      `SELECT * FROM "RecurringSeries"
       WHERE (end_date IS NULL OR end_date >= $1) AND provider IS NOT NULL${filters(seriesParams)}`,
      seriesParams
    ),
  ]);
  // Keep only series with at least one session left that hasn't been
  // deleted or moved (each such date has an exception row).
  const horizon = (() => { const d = new Date(`${since}T00:00:00`); d.setDate(d.getDate() + SERIES_HORIZON_DAYS); return d.toISOString().slice(0, 10); })();
  const exceptions = await loadExceptionDates(db, 'Appointments', series.rows.map(x => x.id), since, horizon);
  const liveSeries = series.rows.filter(x => {
    const end = x.end_date && String(x.end_date).slice(0, 10) < horizon ? String(x.end_date).slice(0, 10) : horizon;
    return expandSeriesOccurrences(x, since, end, exceptions[String(x.id)] || new Set()).length > 0;
  });
  const out = new Map();
  for (const r of [...single.rows, ...liveSeries]) {
    if (isHold(r.patient_name)) continue;
    if (!out.has(r.patient_name)) out.set(r.patient_name, new Set());
    out.get(r.patient_name).add(r.provider);
  }
  return out;
}

module.exports = { HOLD_PATIENT, isHold, clinicToday, monthStartOf, currentCaseloads };
