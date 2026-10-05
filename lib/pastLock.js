// Past appointments are locked for billing (Oct 2026).
//
// Once a day has ended (clinic time, America/New_York) its appointments are
// on that month's billing sheet (routes/billing.js). From then on:
//   * anyone who could before may still change an appointment's STATUS
//     (and comments) -- the sheet follows the status;
//   * any other change -- adding, moving, re-timing, changing provider /
//     room / length, deleting, or ending a recurring series early enough to
//     remove past dates -- needs an Admin or Developer. Admins and
//     Developers make it directly; anyone else's attempt is answered 409
//     { code: 'pastLocked' } and, resent with ?approval_reason=..., is
//     stored as a ScheduleChangeRequests row for an Admin or Developer to
//     approve (the request is replayed as them) or deny.
//   * the patient stays on that provider's sheet for the month even if the
//     appointment is later moved or deleted (BillingCaseload).

const { canAdminister } = require('./roles');
const { json } = require('./http');

const CLINIC_TZ = 'America/New_York';
function clinicToday(now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: CLINIC_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
const isPast = (dateStr) => !!dateStr && String(dateStr).slice(0, 10) < clinicToday();
const pad = (n) => String(n).padStart(2, '0');
function addDays(s, n) {
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const monthOf = (dateStr) => `${String(dateStr).slice(0, 7)}-01`;

// Positive-only cache, so the code works before the migration has run.
const tableSeen = new Set();
async function hasTable(db, name) {
  if (tableSeen.has(name)) return true;
  const r = await db.query('SELECT to_regclass($1) AS t', [`"${name}"`]);
  if (r.rows[0]?.t) { tableSeen.add(name); return true; }
  return false;
}

// Keeps a patient on a provider's sheet for the month of `date`.
async function lockOnSheet(db, provider, date, patientName) {
  if (!provider || !date || !patientName || !isPast(date)) return;
  if (!(await hasTable(db, 'BillingCaseload'))) return;
  await db.query(
    `INSERT INTO "BillingCaseload" (provider, month, patient_name) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [provider, monthOf(date), patientName]
  );
}

const normTime = (t) => (t ? String(t).slice(0, 5) : null);
const FIELDS = {
  patient_name: (v) => v || null,
  provider: (v) => v || null,
  appointment_date: (v) => (v ? String(v).slice(0, 10) : null),
  appointment_time: normTime,
  duration: (v) => (v === undefined || v === null || v === '' ? null : Number(v)),
  treatment_area: (v) => v || null,
};
const LABELS = { patient_name: 'patient', provider: 'provider', appointment_date: 'date', appointment_time: 'time', duration: 'length', treatment_area: 'room' };
// Fields `body` changes relative to `row` (status and comments don't count).
function changedFields(body, row) {
  const out = [];
  for (const [k, norm] of Object.entries(FIELDS)) {
    if (!(k in body)) continue;
    const a = norm(body[k]);
    const b = norm(row[k]);
    if (a !== b) out.push({ field: k, label: LABELS[k], from: b, to: a });
  }
  return out;
}
const fmtDate = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const fmtTime = (t) => {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const describeChange = (c) => {
  const show = (f, v) => (v === null ? 'none' : f === 'appointment_date' ? fmtDate(v) : f === 'appointment_time' ? fmtTime(v) : f === 'duration' ? `${v} min` : v);
  return `${c.label} ${show(c.field, c.from)} → ${show(c.field, c.to)}`;
};

// Works out whether this appointments request touches a past date in a
// locked way. Returns null when it's fine, or
// { summary, provider, date, patient, locks: [[provider, date, patient]] }.
async function lockedChange({ path, method, body, db }) {
  body = body || {};
  if (path === '/appointments' && method === 'POST') {
    if (!isPast(body.appointment_date)) return null;
    return {
      summary: `Add ${body.patient_name} with ${body.provider} on ${fmtDate(body.appointment_date)} at ${fmtTime(body.appointment_time)}`,
      provider: body.provider, date: body.appointment_date, patient: body.patient_name, locks: [],
    };
  }
  let m = path.match(/^\/appointments\/([^/]+)$/);
  if (m && (method === 'PUT' || method === 'DELETE')) {
    const row = (await db.query('SELECT * FROM "Appointments" WHERE id=$1', [m[1]])).rows[0];
    if (!row) return null;
    const base = { provider: row.provider, date: String(row.appointment_date).slice(0, 10), patient: row.patient_name, locks: [[row.provider, row.appointment_date, row.patient_name]] };
    const what = `${row.patient_name} with ${row.provider} on ${fmtDate(row.appointment_date)} at ${fmtTime(row.appointment_time)}`;
    if (method === 'DELETE') return isPast(row.appointment_date) ? { ...base, summary: `Delete ${what}` } : null;
    const changes = changedFields(body, row);
    if (!changes.length) return null;
    if (!isPast(row.appointment_date) && !isPast(body.appointment_date)) return null;
    return { ...base, summary: `Change ${what}: ${changes.map(describeChange).join('; ')}` };
  }
  m = path.match(/^\/appointments\/([^/]+)\/mark-deleted$/);
  if (m && method === 'PUT') {
    const row = (await db.query('SELECT * FROM "Appointments" WHERE id=$1', [m[1]])).rows[0];
    if (!row || !isPast(row.appointment_date)) return null;
    return {
      summary: `Delete ${row.patient_name} with ${row.provider} on ${fmtDate(row.appointment_date)} at ${fmtTime(row.appointment_time)}`,
      provider: row.provider, date: String(row.appointment_date).slice(0, 10), patient: row.patient_name, locks: [[row.provider, row.appointment_date, row.patient_name]],
    };
  }
  if (path === '/recurring-series' && method === 'POST') {
    if (!isPast(body.start_date)) return null;
    return {
      summary: `Start weekly ${body.patient_name} with ${body.provider} from ${fmtDate(body.start_date)} at ${fmtTime(body.appointment_time)}`,
      provider: body.provider, date: body.start_date, patient: body.patient_name, locks: [],
    };
  }
  m = path.match(/^\/recurring-series\/([^/]+)\/(end|purge-future-exceptions|exceptions)$/);
  if (m) {
    const series = (await db.query('SELECT * FROM "RecurringSeries" WHERE id=$1', [m[1]])).rows[0];
    if (!series) return null;
    const who = `${series.patient_name} with ${series.provider}`;
    const base = { provider: series.provider, patient: series.patient_name };
    if (m[2] === 'end' && method === 'PUT') {
      // Dates after end_date stop. Locked when that removes a past date.
      const firstRemoved = addDays(body.end_date, 1);
      if (!body.end_date || !isPast(firstRemoved) || !isPast(series.start_date)) return null;
      return { ...base, date: firstRemoved, summary: `End weekly ${who} after ${fmtDate(body.end_date)} (removes past dates)`, locks: [[series.provider, firstRemoved, series.patient_name]] };
    }
    if (m[2] === 'purge-future-exceptions' && method === 'PUT') {
      if (!isPast(body.from_date)) return null;
      return { ...base, date: body.from_date, summary: `Delete weekly ${who} from ${fmtDate(body.from_date)} on`, locks: [[series.provider, body.from_date, series.patient_name]] };
    }
    if (m[2] === 'exceptions' && method === 'POST') {
      const occ = body.occurrence_date;
      const target = body.appointment_date || occ;
      if (!isPast(occ) && !isPast(target)) return null;
      const what = `${who} on ${fmtDate(occ)} at ${fmtTime(series.appointment_time)}`;
      const locks = [[series.provider, occ, series.patient_name]];
      if (body.deleted) return { ...base, date: occ, summary: `Delete ${what}`, locks };
      const asRow = { ...series, appointment_date: occ };
      const changes = changedFields(body, asRow);
      if (!changes.length) return null;
      return { ...base, date: occ, summary: `Change ${what}: ${changes.map(describeChange).join('; ')}`, locks };
    }
  }
  return null;
}

// Called at the top of routes/appointments.js. Returns a response to send
// instead of running the route, or null to carry on.
async function guard(ctx) {
  if (ctx.skipPastLock) return null;
  const { db, currentUser, qs, path, method, body } = ctx;
  const locked = await lockedChange(ctx);
  if (!locked) return null;
  if (canAdminister(currentUser)) {
    for (const [p, d, n] of locked.locks) await lockOnSheet(db, p, d, n);
    return null;
  }
  const reason = String(qs?.approval_reason || '').trim();
  if (!reason) {
    return json(409, {
      code: 'pastLocked',
      error: 'This date has passed and is on the billing sheet. Only the status can be changed. Anything else needs an admin to approve it.',
      summary: locked.summary,
    });
  }
  if (!(await hasTable(db, 'ScheduleChangeRequests'))) {
    return json(409, { code: 'pastLocked', error: 'Changes to past dates need an admin. Ask an Admin or Developer to make this change.', summary: locked.summary });
  }
  const res = await db.query(
    `INSERT INTO "ScheduleChangeRequests" (method, path, body, summary, provider, appointment_date, patient_name, reason, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [method, path, JSON.stringify(body || {}), locked.summary, locked.provider || null, locked.date ? String(locked.date).slice(0, 10) : null,
      locked.patient || null, reason.slice(0, 500), currentUser.username]
  );
  return json(202, { pending: true, request_id: res.rows[0].id, message: 'Sent to an admin for approval.' });
}

module.exports = { clinicToday, isPast, monthOf, hasTable, lockOnSheet, lockedChange, guard };
