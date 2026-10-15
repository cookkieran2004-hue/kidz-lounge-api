// EI evaluation reports (the "ei" feature, PedsDesk only, Oct 2026; rules
// in lib/evalReports.js). Where the feature is off every path answers 404.
//
//   GET  /eval-reports?month=&provider=            evaluations up to today with their report's status
//   GET  /eval-reports/report?key=                 one evaluation: header, the report, addenda, what's missing
//   PUT  /eval-reports/report                      save the draft { key, details, instruments, domains }
//   POST /eval-reports/report/provider-sign        { key, signature, license }
//   POST /eval-reports/report/supervisor-sign      { key, signature, license }
//   POST /eval-reports/report/addenda              { key, body }
//
// One report per evaluation appointment (Appointments.is_eval, keyed
// 'appt:<id>' like session notes). A canceled or no-show evaluation needs
// none. Who: the evaluation's provider writes and signs; their supervisor
// (Providers.supervisor_name) co-signs; Reception, Admins and Developers
// see and print every report. Providers see only their own.
const { json } = require('../lib/http');
const { canManage } = require('../lib/roles');
const { featureOn } = require('../lib/features');
const { clinicToday, isHold } = require('../lib/caseload');
const { displayNameFor } = require('../lib/utils');
const history = require('../lib/eiHistory');
const ev = require('../lib/evalReports');
const notesLib = require('../lib/sessionNotes');

const MIGRATION = 'Evaluation reports need the 2026-11-07 database update. It runs with the next deploy.';
let tablesSeen = false;
async function hasTables(db) {
  if (tablesSeen) return true;
  const r = await db.query(`SELECT to_regclass('"EiEvalReports"') AS a, to_regclass('"EiEvalReportAddenda"') AS b,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Appointments' AND column_name = 'is_eval') AS c`);
  tablesSeen = !!(r.rows[0]?.a && r.rows[0]?.b && r.rows[0]?.c);
  return tablesSeen;
}
const day10 = (v) => (v ? String(v).slice(0, 10) : null);
const pad = (n) => String(n).padStart(2, '0');
const MISSED = ['Canceled', 'No Show'];
const DISCIPLINE_SERVICE = { ST: 'ST', SLP: 'ST', OT: 'OT', PT: 'PT', SI: 'SI', SEIT: 'SI' };

// Evaluations (real appointments only: an eval is booked one time) in a
// date range, not missed, not HOLD.
async function evalsBetween(db, { start, end, provider }) {
  const params = [start, end];
  let filter = '';
  if (provider) { params.push(provider); filter = ` AND a.provider = $${params.length}`; }
  const rows = (await db.query(
    `SELECT a.id, a.appointment_date, a.appointment_time, a.duration, a.provider, a.patient_name, a.appointment_status, p.id AS patient_id
     FROM "Appointments" a JOIN "Patients" p ON p."Name" = a.patient_name
     WHERE a.is_eval = true AND a.deleted = false AND a.appointment_date BETWEEN $1 AND $2${filter}
     ORDER BY a.appointment_date, a.appointment_time`, params
  )).rows;
  return rows.filter(a => !MISSED.includes(a.appointment_status) && a.appointment_status !== '*HOLD*' && !isHold(a.patient_name))
    .map(a => ({ ...a, key: `appt:${a.id}`, appointment_date: day10(a.appointment_date) }));
}

// The report's header: the child as EI-Hub knows them, the evaluator.
async function headerFor(db, appt, patientId) {
  const patient = (await db.query('SELECT id, "Name", "Date_of_Birth", "ID_Number", "Parent_Name" FROM "Patients" WHERE id=$1', [patientId])).rows[0];
  const prov = (await db.query('SELECT * FROM "Providers" WHERE "Name"=$1', [appt.provider])).rows[0] || {};
  const versions = (await history.versionsFor(db, 'child', [patient.id]))[patient.id] || [];
  const child = history.versionOn(versions, day10(appt.appointment_date)) || {};
  const disciplines = String(prov.specialty || '').split(/[,/]/).map(x => x.trim().toUpperCase()).filter(Boolean);
  return {
    child_name: [child.first_name, child.last_name].filter(Boolean).join(' ') || patient.Name,
    date_of_birth: history.day(child.date_of_birth) || day10(patient.Date_of_Birth),
    sex: child.sex || null,
    ei_number: child.ei_child_id || patient.ID_Number || null,
    parent_name: patient.Parent_Name || null,
    evaluator: [prov.ei_first_name || prov.first_name, prov.ei_last_name || prov.last_name].filter(Boolean).join(' ') || appt.provider,
    credentials: prov.credentials || null,
    npi: prov.npi || null,
    service: disciplines.map(d => DISCIPLINE_SERVICE[d]).find(Boolean) || null,
    supervisor: prov.supervisor_name || null,
    age_months: child.date_of_birth || patient.Date_of_Birth ? ageMonths(history.day(child.date_of_birth) || day10(patient.Date_of_Birth), day10(appt.appointment_date)) : null,
  };
}
function ageMonths(dob, on) {
  const [y1, m1, d1] = dob.split('-').map(Number);
  const [y2, m2, d2] = on.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
}

async function loadReport(db, key) {
  const report = (await db.query('SELECT * FROM "EiEvalReports" WHERE session_key=$1', [key])).rows[0] || null;
  const addenda = report ? (await db.query('SELECT * FROM "EiEvalReportAddenda" WHERE report_id=$1 ORDER BY signed_at, id', [report.id])).rows : [];
  return { report: report ? { ...report, eval_date: day10(report.eval_date) } : null, addenda };
}

async function handle({ path, method, qs, body, db, currentUser }) {
  if (path !== '/eval-reports' && !path.startsWith('/eval-reports/')) return null;
  if (!featureOn('ei')) return json(404, { error: 'Not available at this clinic.' });
  if (!(await hasTables(db))) return json(503, { error: MIGRATION });
  const manager = canManage(currentUser);
  const own = currentUser.providerName || null;
  if (!manager && !own) return json(403, { error: 'Evaluation reports are for providers and the office. No provider is linked to your account.' });
  const today = clinicToday();

  if (path === '/eval-reports' && method === 'GET') {
    const month = String(qs.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return json(400, { error: 'Choose a month.' });
    const [y, m] = month.split('-').map(Number);
    const end = `${month}-${pad(new Date(y, m, 0).getDate())}`;
    const provider = manager ? (qs.provider || null) : own;
    const evals = await evalsBetween(db, { start: `${month}-01`, end: end < today ? end : today, provider });
    const keys = evals.map(e => e.key);
    const found = keys.length ? (await db.query('SELECT session_key, id, details, provider_signed_at, supervisor_name, supervisor_signed_at, eval_date FROM "EiEvalReports" WHERE session_key = ANY($1)', [keys])).rows : [];
    const byKey = Object.fromEntries(found.map(r => [r.session_key, r]));
    return json(200, {
      month, today,
      evals: evals.map(e => ({
        key: e.key, date: e.appointment_date, start_time: String(e.appointment_time).slice(0, 5), patient_id: e.patient_id, patient_name: e.patient_name,
        provider: e.provider, due_date: ev.dueDateOf(e.appointment_date),
        status: ev.reportStatus(byKey[e.key] || { eval_date: e.appointment_date }, today),
      })),
    });
  }

  if (!path.startsWith('/eval-reports/report')) return json(404, { error: 'Not found.' });
  const key = String((method === 'GET' ? qs.key : body?.key) || '');
  if (!/^appt:[0-9a-f-]{36}$/i.test(key)) return json(404, { error: 'That evaluation was not found.' });
  const appt = (await db.query(
    `SELECT a.*, p.id AS patient_id FROM "Appointments" a JOIN "Patients" p ON p."Name" = a.patient_name WHERE a.id::text=$1 AND a.deleted = false`, [key.slice(5)]
  )).rows[0];
  if (!appt || !appt.is_eval) return json(404, { error: 'That evaluation was not found. It may have been moved or deleted.' });
  const evalDate = day10(appt.appointment_date);
  if (evalDate > today) return json(400, { error: 'An evaluation report can be written on or after the day of the evaluation.' });
  if (MISSED.includes(appt.appointment_status)) return json(400, { error: `This evaluation was ${appt.appointment_status === 'No Show' ? 'a no-show' : 'canceled'}, so there's no report to write.` });
  let { report, addenda } = await loadReport(db, key);
  const mine = own && appt.provider === own;
  const supervising = !!own && !mine && report?.supervisor_name === own;
  if (!manager && !mine && !supervising) return json(403, { error: 'You can only see your own evaluation reports.' });
  const header = report?.header || await headerFor(db, appt, appt.patient_id);

  if (path === '/eval-reports/report' && method === 'GET') {
    return json(200, {
      eval: { key, date: evalDate, start_time: String(appt.appointment_time).slice(0, 5), duration: Number(appt.duration) || null, provider: appt.provider, patient_id: appt.patient_id, patient_name: appt.patient_name, due_date: ev.dueDateOf(evalDate) },
      header, report, addenda,
      status: ev.reportStatus(report || { eval_date: evalDate }, today),
      missing: ev.missingForSigning(report),
      can_write: !!mine,
      can_cosign: !!(supervising && report?.provider_signed_at && !report.supervisor_signed_at),
      license_hint: report?.provider_license ? null : await notesLib.licenseFor(db, appt.provider),
      domain_labels: ev.DOMAIN_LABEL,
      today,
    });
  }

  if (path === '/eval-reports/report/supervisor-sign' && method === 'POST') {
    if (!supervising) return json(403, { error: "Only the evaluator's supervisor can co-sign this report." });
    if (!report.provider_signed_at) return json(400, { error: 'The evaluator signs the report first.' });
    if (report.supervisor_signed_at) return json(409, { error: 'You have already co-signed this report.' });
    const b = body || {};
    if (!notesLib.validSignature(b.signature)) return json(400, { error: 'Sign in the box.' });
    const license = String(b.license || (await notesLib.licenseFor(db, own)) || '').trim().slice(0, 60);
    if (!license) return json(400, { error: 'Enter your license #.' });
    const row = (await db.query(
      `UPDATE "EiEvalReports" SET supervisor_signature=$1, supervisor_license=$2, supervisor_signed_at=now(), supervisor_signed_by=$3, updated_at=now()
       WHERE id=$4 AND supervisor_signed_at IS NULL RETURNING *`, [b.signature, license, currentUser.username, report.id]
    )).rows[0];
    if (!row) return json(409, { error: 'This report was already co-signed. Reload the page.' });
    return json(200, { status: ev.reportStatus(row, today) });
  }

  if (!mine) return json(403, { error: "Only the evaluation's provider can write and sign its report." });
  const locked = !!report?.provider_signed_at;

  if (path === '/eval-reports/report' && method === 'PUT') {
    if (locked) return json(409, { error: 'This report has been signed, so it can no longer be changed. Add an addendum instead.' });
    const v = ev.cleanDraft(body);
    if (!report) {
      report = (await db.query(
        `INSERT INTO "EiEvalReports" (session_key, patient_id, provider, eval_date, service, details, instruments, domains, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [key, appt.patient_id, appt.provider, evalDate, header.service, v.details, JSON.stringify(v.instruments), v.domains, currentUser.username]
      )).rows[0];
    } else {
      report = (await db.query(
        'UPDATE "EiEvalReports" SET eval_date=$1, details=$2, instruments=$3, domains=$4, updated_at=now() WHERE id=$5 RETURNING *',
        [evalDate, v.details, JSON.stringify(v.instruments), v.domains, report.id]
      )).rows[0];
    }
    return json(200, { report: { ...report, eval_date: day10(report.eval_date) }, status: ev.reportStatus(report, today), missing: ev.missingForSigning(report) });
  }

  if (path === '/eval-reports/report/provider-sign' && method === 'POST') {
    if (!report) return json(400, { error: 'Save the report before signing it.' });
    if (locked) return json(409, { error: 'You have already signed this report.' });
    const missing = ev.missingForSigning(report);
    if (missing.length) return json(400, { error: `Finish the report before signing: ${missing[0]}.`, missing });
    const b = body || {};
    if (!notesLib.validSignature(b.signature)) return json(400, { error: 'Sign in the box.' });
    const license = String(b.license || '').trim().slice(0, 60);
    if (!license) return json(400, { error: 'Enter your license number.' });
    const row = (await db.query(
      `UPDATE "EiEvalReports" SET provider_signature=$1, provider_license=$2, provider_signed_at=now(), provider_signed_by=$3, header=$4,
         supervisor_name=$5, updated_at=now()
       WHERE id=$6 AND provider_signed_at IS NULL RETURNING *`,
      [b.signature, license, currentUser.username, { ...header, license }, header.supervisor || null, report.id]
    )).rows[0];
    if (!row) return json(409, { error: 'This report was already signed. Reload the page.' });
    return json(200, { status: ev.reportStatus(row, today) });
  }

  if (path === '/eval-reports/report/addenda' && method === 'POST') {
    if (!locked) return json(400, { error: "This report isn't signed yet: change the report itself instead." });
    const text = String(body?.body || '').trim().slice(0, 8000);
    if (!text) return json(400, { error: 'Write the correction or addition.' });
    const staff = (await db.query('SELECT first_name, last_name, preferred_name, username FROM "Staff" WHERE username=$1', [currentUser.username])).rows[0] || {};
    await db.query('INSERT INTO "EiEvalReportAddenda" (report_id, body, signed_by, signed_name) VALUES ($1,$2,$3,$4)', [report.id, text, currentUser.username, displayNameFor(staff)]);
    ({ addenda } = await loadReport(db, key));
    return json(201, { addenda });
  }

  return json(405, { error: 'Not supported.' });
}

module.exports = { handle, evalsBetween };
