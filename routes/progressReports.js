// EI progress reports (the "ei" feature, PedsDesk only, Oct 2026; rules in
// lib/progressReports.js). Where the feature is off every path answers 404.
//
//   GET  /progress-reports[?patient_id=]       reports due (from current IFSPs) and every report not yet sent
//   POST /progress-reports                     start one { patient_id, ifsp_id, service, report_type } (prefilled)
//   GET  /progress-reports/:id                 the report, its addenda and what's missing
//   PUT  /progress-reports/:id                 save the draft { details, outcomes, answers, proposed }
//   POST /progress-reports/:id/parent-sign     { parent_name, relationship, signature }
//   POST /progress-reports/:id/provider-sign   { signature, license }
//   POST /progress-reports/:id/addenda         { body }
//   POST /progress-reports/:id/supervisor-sign { signature, license }  the supervisor's co-signature (before the office approves)
//   GET  /progress-reports/cosign              reports waiting for my co-signature
//   POST /progress-reports/:id/office          { action: 'approve' | 'return', comment }   (canManage)
//   POST /progress-reports/:id/sent            { sent_on }                                  (canManage)
//
// Who: the report's own provider writes, gets the parent's signature on
// their device, signs and adds addenda; Reception, Admins and Developers
// see everything, approve or return, and mark reports sent. Providers see
// only their own. A provider's supervisor (Providers.supervisor_name, set
// on the report when the provider signs) reads and co-signs it.
const { json } = require('../lib/http');
const { canManage } = require('../lib/roles');
const { featureOn } = require('../lib/features');
const { clinicToday } = require('../lib/caseload');
const { displayNameFor } = require('../lib/utils');
const { addDays } = require('../lib/ifsp');
const pr = require('../lib/progressReports');
const notesLib = require('../lib/sessionNotes');
const { eiSessionsFor } = require('./sessionNotes');

const MIGRATION = 'Progress reports need the 2026-11-06 database update. It runs with the next deploy.';
let tablesSeen = false;
let complianceSeen = false;
async function hasCompliance(db) {
  if (complianceSeen) return true;
  const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'EiProgressReports' AND column_name = 'supervisor_name'`);
  complianceSeen = r.rows.length > 0;
  return complianceSeen;
}
async function hasTables(db) {
  if (tablesSeen) return true;
  const r = await db.query(`SELECT to_regclass('"EiProgressReports"') AS a, to_regclass('"EiProgressReportAddenda"') AS b, to_regclass('"EiSessionNotes"') AS c`);
  tablesSeen = !!(r.rows[0]?.a && r.rows[0]?.b && r.rows[0]?.c);
  return tablesSeen;
}
const day10 = (v) => (v ? String(v).slice(0, 10) : null);
const months = (from, to) => {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ey, em] = to.slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m += 1; if (m > 12) { m = 1; y += 1; } }
  return out;
};

// One provider's EI sessions with a child in an IFSP period (up to today).
async function periodSessions(db, { patientName, provider, start, end }) {
  const today = clinicToday();
  const last = end && end < today ? end : today;
  if (!start || start > last) return [];
  const rows = [];
  for (const month of months(start, last)) rows.push(...await eiSessionsFor(db, { month, provider: provider || null, patientName }));
  return rows.filter(s => s.date >= start && s.date <= last);
}

async function loadIfsp(db, ifspId) {
  const ifsp = (await db.query('SELECT * FROM "EiIfsps" WHERE id=$1', [ifspId])).rows[0];
  if (!ifsp) return null;
  ifsp.outcomes = (await db.query('SELECT * FROM "EiIfspOutcomes" WHERE ifsp_id=$1 ORDER BY position, id', [ifspId])).rows.map(o => ({ ...o, steps: o.steps || [] }));
  return ifsp;
}

// The reports each current IFSP calls for: one per provider + service that
// saw the child under EI in the period, from SHOW_FROM_DAYS before due.
async function dueReports(db, { provider, patientId }) {
  const today = clinicToday();
  const params = [addDays(today, -60), addDays(today, pr.SHOW_FROM_DAYS + 21)];
  let filter = '';
  if (patientId) { params.push(patientId); filter = ` AND i.patient_id::text = $${params.length}`; }
  const ifsps = (await db.query(
    `SELECT i.*, p."Name" AS patient_name FROM "EiIfsps" i JOIN "Patients" p ON p.id = i.patient_id
     WHERE i.end_date BETWEEN $1 AND $2${filter} AND p."Status" IS DISTINCT FROM 'Off Program' ORDER BY i.end_date`, params
  )).rows;
  const out = [];
  for (const i of ifsps) {
    const type = pr.reportTypeOf(i.ifsp_type);
    if (!type) continue;
    const sessions = await periodSessions(db, { patientName: i.patient_name, provider, start: day10(i.start_date), end: day10(i.end_date) });
    const pairs = new Map();
    for (const s of sessions) if (s.service && !s.cancelled) pairs.set(`${s.provider}|${s.service}`, { provider: s.provider, service: s.service });
    for (const { provider: prov, service } of pairs.values()) {
      out.push({ patient_id: i.patient_id, patient_name: i.patient_name, ifsp_id: i.id, ifsp_type: i.ifsp_type, ifsp_start: day10(i.start_date), ifsp_end: day10(i.end_date), provider: prov, service, report_type: type, due_date: pr.dueDateOf(i.end_date) });
    }
  }
  return out;
}

async function loadReport(db, id) {
  const report = (await db.query('SELECT r.*, p."Name" AS patient_name FROM "EiProgressReports" r JOIN "Patients" p ON p.id = r.patient_id WHERE r.id=$1', [id])).rows[0] || null;
  const addenda = report ? (await db.query('SELECT * FROM "EiProgressReportAddenda" WHERE report_id=$1 ORDER BY signed_at, id', [id])).rows : [];
  return { report, addenda };
}

// The header the report prints with (names and IDs), worked out now.
async function headerFor(db, report) {
  const patient = (await db.query('SELECT id, "Name", "Date_of_Birth", "ID_Number" FROM "Patients" WHERE id=$1', [report.patient_id])).rows[0];
  const prov = (await db.query('SELECT "Name", first_name, last_name, credentials, ei_first_name, ei_last_name FROM "Providers" WHERE "Name"=$1', [report.provider])).rows[0] || {};
  const versions = (await require('../lib/eiHistory').versionsFor(db, 'child', [patient.id]))[patient.id] || [];
  const child = require('../lib/eiHistory').versionOn(versions, clinicToday()) || {};
  return {
    child_name: [child.first_name, child.last_name].filter(Boolean).join(' ') || patient.Name,
    date_of_birth: require('../lib/eiHistory').day(child.date_of_birth) || day10(patient.Date_of_Birth),
    ei_number: child.ei_child_id || patient.ID_Number || null,
    interventionist: [prov.ei_first_name || prov.first_name, prov.ei_last_name || prov.last_name].filter(Boolean).join(' ') || report.provider,
    credentials: prov.credentials || null,
    service: report.service,
  };
}

async function handle({ path, method, qs, body, db, currentUser }) {
  if (path !== '/progress-reports' && !path.startsWith('/progress-reports/')) return null;
  if (!featureOn('ei')) return json(404, { error: 'Not available at this clinic.' });
  if (!(await hasTables(db))) return json(503, { error: MIGRATION });
  const manager = canManage(currentUser);
  const own = currentUser.providerName || null;
  if (!manager && !own) return json(403, { error: 'Progress reports are for providers and the office. No provider is linked to your account.' });

  if (path === '/progress-reports' && method === 'GET') {
    const patientId = qs.patient_id ? String(qs.patient_id) : null;
    const provider = manager ? (qs.provider || null) : own;
    const due = await dueReports(db, { provider, patientId });
    const params = [];
    let where = 'WHERE (r.sent_on IS NULL OR r.sent_on >= $1)';
    params.push(addDays(clinicToday(), -60));
    if (provider) { params.push(provider); where += ` AND r.provider = $${params.length}`; }
    if (patientId) { params.push(patientId); where += ` AND r.patient_id::text = $${params.length}`; }
    const reports = (await db.query(
      `SELECT r.id, r.patient_id, p."Name" AS patient_name, r.ifsp_id, r.provider, r.service, r.report_type, r.ifsp_start, r.ifsp_end, r.due_date,
              r.parent_signed_at, r.provider_signed_at, r.office_status, r.office_comment, r.sent_on${await hasCompliance(db) ? ', r.supervisor_name, r.supervisor_signed_at' : ''}
       FROM "EiProgressReports" r JOIN "Patients" p ON p.id = r.patient_id ${where} ORDER BY r.due_date NULLS LAST, r.id`, params
    )).rows;
    const key = (x) => `${x.patient_id}|${x.ifsp_id}|${x.provider}|${x.service}|${x.report_type}`;
    const started = new Map(reports.map(r => [key(r), r]));
    const rows = [
      ...due.filter(d => !started.has(key(d))).map(d => ({ ...d, id: null, status: 'not_started' })),
      ...reports.map(r => ({ ...r, ifsp_start: day10(r.ifsp_start), ifsp_end: day10(r.ifsp_end), due_date: day10(r.due_date), status: pr.reportStatus(r) })),
    ].sort((a, b) => String(a.due_date || '9').localeCompare(String(b.due_date || '9')));
    return json(200, { today: clinicToday(), rows });
  }

  if (path === '/progress-reports' && method === 'POST') {
    const b = body || {};
    const ifsp = b.ifsp_id ? await loadIfsp(db, Number(b.ifsp_id)) : null;
    if (!ifsp || String(ifsp.patient_id) !== String(b.patient_id)) return json(400, { error: 'Choose the IFSP the report is for.' });
    const type = b.report_type === 'amendment' ? 'amendment' : pr.reportTypeOf(ifsp.ifsp_type);
    if (!type) return json(400, { error: 'This IFSP is an amendment; start an amendment report instead.' });
    const provider = own;
    if (!provider) return json(403, { error: 'Only a provider can write a progress report.' });
    const service = String(b.service || '');
    const patient = (await db.query('SELECT id, "Name" FROM "Patients" WHERE id=$1', [ifsp.patient_id])).rows[0];
    const sessions = await periodSessions(db, { patientName: patient.Name, provider, start: day10(ifsp.start_date), end: day10(ifsp.end_date) });
    if (!sessions.some(s => s.service === service)) return json(400, { error: `You have no ${service || 'EI'} sessions with this child in this IFSP period.` });
    if (type !== 'amendment') {
      const existing = (await db.query('SELECT id FROM "EiProgressReports" WHERE patient_id=$1 AND ifsp_id=$2 AND provider=$3 AND service=$4 AND report_type=$5', [patient.id, ifsp.id, provider, service, type])).rows[0];
      if (existing) return json(200, { id: existing.id });
    }
    const notes = (await db.query('SELECT * FROM "EiSessionNotes" WHERE patient_id=$1 AND provider=$2 AND session_date BETWEEN $3 AND $4',
      [patient.id, provider, day10(ifsp.start_date), day10(ifsp.end_date) || clinicToday()])).rows;
    const start = await pr.prefill(db, { patient, ifsp, provider, service, sessions: sessions.filter(s => s.service === service), notes });
    const row = (await db.query(
      `INSERT INTO "EiProgressReports" (patient_id, ifsp_id, provider, service, report_type, ifsp_start, ifsp_end, due_date, details, outcomes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [patient.id, ifsp.id, provider, service, type, day10(ifsp.start_date), day10(ifsp.end_date), type === 'amendment' ? clinicToday() : pr.dueDateOf(ifsp.end_date),
        start.details, JSON.stringify(start.outcomes), currentUser.username]
    )).rows[0];
    return json(201, { id: row.id });
  }

  if (path === '/progress-reports/cosign' && method === 'GET') {
    if (!(await hasCompliance(db))) return json(200, { reports: [] });
    const rows = (await db.query(
      `SELECT r.id, r.patient_id, p."Name" AS patient_name, r.provider, r.service, r.report_type, r.due_date, r.supervisor_name, r.provider_signed_at
       FROM "EiProgressReports" r JOIN "Patients" p ON p.id = r.patient_id
       WHERE r.supervisor_name IS NOT NULL AND r.supervisor_signed_at IS NULL AND r.provider_signed_at IS NOT NULL
         AND ($1::text IS NULL OR r.supervisor_name = $1) ORDER BY r.provider_signed_at`, [manager && !qs.mine ? null : own]
    )).rows.map(r => ({ ...r, due_date: day10(r.due_date) }));
    return json(200, { reports: rows });
  }

  const m = path.match(/^\/progress-reports\/(\d+)(?:\/(parent-sign|provider-sign|supervisor-sign|addenda|office|sent))?$/);
  if (!m) return json(404, { error: 'Not found.' });
  const [, idText, step] = m;
  let { report, addenda } = await loadReport(db, Number(idText));
  if (!report) return json(404, { error: 'That progress report was not found.' });
  const mine = own && report.provider === own;
  const supervising = !!own && !mine && report.supervisor_name === own;
  if (!manager && !mine && !supervising) return json(403, { error: 'You can only see your own progress reports.' });
  const locked = !!(report.provider_signed_at || report.parent_signed_at);

  if (!step && method === 'GET') {
    return json(200, {
      report: { ...report, ifsp_start: day10(report.ifsp_start), ifsp_end: day10(report.ifsp_end), due_date: day10(report.due_date) },
      header: report.header || await headerFor(db, report),
      addenda, status: pr.reportStatus(report), missing: pr.missingForSigning(report),
      can_write: !!mine, can_office: manager, today: clinicToday(),
      can_cosign: !!(supervising && report.provider_signed_at && !report.supervisor_signed_at),
      license_hint: report.provider_license ? null : await notesLib.licenseFor(db, report.provider),
    });
  }

  if (step === 'office' && method === 'POST') {
    if (!manager) return json(403, { error: 'Only Reception, Admins and Developers can approve progress reports.' });
    if (!report.provider_signed_at || !report.parent_signed_at) return json(400, { error: 'The provider and the parent both sign before the office reviews it.' });
    if (body?.action === 'approve' && report.supervisor_name && !report.supervisor_signed_at) return json(400, { error: `${report.supervisor_name} (the provider's supervisor) co-signs before the office approves it.` });
    const action = body?.action;
    const comment = String(body?.comment || '').trim().slice(0, 3000);
    if (!['approve', 'return'].includes(action)) return json(400, { error: 'Approve or return the report.' });
    if (action === 'return' && !comment) return json(400, { error: 'Say what needs fixing so the provider can add an addendum.' });
    await db.query('UPDATE "EiProgressReports" SET office_status=$1, office_comment=$2, office_by=$3, office_at=now(), updated_at=now() WHERE id=$4',
      [action === 'approve' ? 'approved' : 'returned', comment || null, currentUser.username, report.id]);
    return json(200, { status: action === 'approve' ? 'approved' : 'returned' });
  }

  if (step === 'sent' && method === 'POST') {
    if (!manager) return json(403, { error: 'Only Reception, Admins and Developers can mark reports sent.' });
    if (report.office_status !== 'approved') return json(400, { error: 'Approve the report before marking it sent.' });
    const sentOn = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.sent_on || '')) ? body.sent_on : clinicToday();
    await db.query('UPDATE "EiProgressReports" SET sent_on=$1, sent_by=$2, updated_at=now() WHERE id=$3', [sentOn, currentUser.username, report.id]);
    return json(200, { status: 'sent', sent_on: sentOn });
  }

  if (step === 'supervisor-sign' && method === 'POST') {
    if (!supervising) return json(403, { error: "Only the provider's supervisor can co-sign this report." });
    if (!report.provider_signed_at) return json(400, { error: 'The provider signs the report first.' });
    if (report.supervisor_signed_at) return json(409, { error: 'You have already co-signed this report.' });
    const b = body || {};
    if (!notesLib.validSignature(b.signature)) return json(400, { error: 'Sign in the box.' });
    const license = String(b.license || (await notesLib.licenseFor(db, own)) || '').trim().slice(0, 60);
    if (!license) return json(400, { error: 'Enter your license #.' });
    const row = (await db.query(
      `UPDATE "EiProgressReports" SET supervisor_signature=$1, supervisor_license=$2, supervisor_signed_at=now(), supervisor_signed_by=$3, updated_at=now()
       WHERE id=$4 AND supervisor_signed_at IS NULL RETURNING *`, [b.signature, license, currentUser.username, report.id]
    )).rows[0];
    if (!row) return json(409, { error: 'This report was already co-signed. Reload the page.' });
    return json(200, { status: pr.reportStatus(row) });
  }

  // Everything below is the provider's own.
  if (!mine) return json(403, { error: "Only the report's provider can write and sign it." });

  if (!step && method === 'PUT') {
    if (locked) return json(409, { error: 'This report has been signed, so it can no longer be changed. Add an addendum instead.' });
    const v = pr.cleanDraft(body);
    const row = (await db.query(
      'UPDATE "EiProgressReports" SET details=$1, outcomes=$2, answers=$3, proposed=$4, updated_at=now() WHERE id=$5 RETURNING *',
      [v.details, JSON.stringify(v.outcomes), v.answers, JSON.stringify(v.proposed), report.id]
    )).rows[0];
    return json(200, { report: row, status: pr.reportStatus(row), missing: pr.missingForSigning(row) });
  }

  if (step === 'parent-sign' && method === 'POST') {
    if (report.parent_signed_at) return json(409, { error: 'The parent has already signed this report.' });
    const missing = pr.missingForSigning(report);
    if (missing.length) return json(400, { error: `Finish the report before the parent reviews it: ${missing[0]}.`, missing });
    const b = body || {};
    const name = String(b.parent_name || '').trim().slice(0, 200);
    const relationship = String(b.relationship || '').trim().slice(0, 100);
    if (!name) return json(400, { error: "Enter the parent's name." });
    if (!relationship) return json(400, { error: 'Enter their relationship to the child.' });
    if (!notesLib.validSignature(b.signature)) return json(400, { error: 'The parent needs to sign in the box.' });
    const row = (await db.query(
      `UPDATE "EiProgressReports" SET parent_name=$1, parent_relationship=$2, parent_signature=$3, parent_reviewed_on=$4, parent_signed_at=now(), updated_at=now()
       WHERE id=$5 AND parent_signed_at IS NULL RETURNING *`, [name, relationship, b.signature, clinicToday(), report.id]
    )).rows[0];
    if (!row) return json(409, { error: 'The parent has already signed this report. Reload the page.' });
    return json(200, { status: pr.reportStatus(row) });
  }

  if (step === 'provider-sign' && method === 'POST') {
    if (report.provider_signed_at) return json(409, { error: 'You have already signed this report.' });
    const missing = pr.missingForSigning(report);
    if (missing.length) return json(400, { error: `Finish the report before signing: ${missing[0]}.`, missing });
    const b = body || {};
    if (!notesLib.validSignature(b.signature)) return json(400, { error: 'Sign in the box.' });
    const license = String(b.license || '').trim().slice(0, 60);
    if (!license) return json(400, { error: 'Enter your license number (or "certified").' });
    const header = { ...await headerFor(db, report), license };
    const row = (await db.query(
      `UPDATE "EiProgressReports" SET provider_signature=$1, provider_license=$2, provider_signed_at=now(), provider_signed_by=$3, header=$4, updated_at=now()
       WHERE id=$5 AND provider_signed_at IS NULL RETURNING *`, [b.signature, license, currentUser.username, header, report.id]
    )).rows[0];
    if (!row) return json(409, { error: 'This report was already signed. Reload the page.' });
    const supervisor = await supervisorOf(db, report.provider);
    if (supervisor) {
      const withSup = (await db.query('UPDATE "EiProgressReports" SET supervisor_name=$1 WHERE id=$2 RETURNING *', [supervisor, report.id])).rows[0];
      return json(200, { status: pr.reportStatus(withSup) });
    }
    return json(200, { status: pr.reportStatus(row) });
  }

  if (step === 'addenda' && method === 'POST') {
    if (!locked) return json(400, { error: "This report isn't signed yet: change the report itself instead." });
    const text = String(body?.body || '').trim().slice(0, 8000);
    if (!text) return json(400, { error: 'Write the correction or addition.' });
    const staff = (await db.query('SELECT first_name, last_name, preferred_name, username FROM "Staff" WHERE username=$1', [currentUser.username])).rows[0] || {};
    await db.query('INSERT INTO "EiProgressReportAddenda" (report_id, body, signed_by, signed_name) VALUES ($1,$2,$3,$4)', [report.id, text, currentUser.username, displayNameFor(staff)]);
    ({ addenda } = await loadReport(db, report.id));
    return json(201, { addenda });
  }

  return json(405, { error: 'Not supported.' });
}

// The provider's supervisor (Providers.supervisor_name), when they have one.
async function supervisorOf(db, provider) {
  if (!(await hasCompliance(db))) return null;
  return (await db.query('SELECT supervisor_name FROM "Providers" WHERE "Name"=$1', [provider])).rows[0]?.supervisor_name || null;
}

module.exports = { handle, dueReports };
