// IFSP records and turning 3 on the patient chart (the "ei" feature,
// PedsDesk only, Oct 2026; lib/ifsp.js, migrations/2026-11-04_ifsp_records.sql).
// Where the feature is off every path here answers 404.
//
//   GET    /patients/:id/ifsp               the child's IFSPs (newest first, with outcomes and
//                                           the attached document), the current one, and turning 3
//   POST   /patients/:id/ifsps              add an IFSP period
//   PUT    /patients/:id/ifsps/:ifspId      change one (outcomes are replaced as a whole)
//   DELETE /patients/:id/ifsps/:ifspId      remove one entered by mistake (the PDF stays in Documents)
//   PUT    /patients/:id/transition         what's happened for turning 3
//
// Who (Kieran, Oct 2026): Reception, Admins and Developers (canManage) see
// and change everything; a provider sees the IFSP of a child on their
// caseload (lib/caseload.js) but can't change it. EI billing stays hidden
// from providers (routes/eiHub.js); nothing billing-related is returned here.
//
// Saving or removing an IFSP copies the current one onto the patient
// (IFSP_Type / Start / End, Report_Date = end - 21 days, the service
// coordinator when given), so the existing "Report due" and "IFSP ending"
// reminders (lib/complianceCheck.js) and the Overview tab follow it.
const { json } = require('../lib/http');
const { canManage } = require('../lib/roles');
const { featureOn } = require('../lib/features');
const { clinicToday, currentCaseloads } = require('../lib/caseload');
const ifsp = require('../lib/ifsp');

const MIGRATION = 'IFSP records need the 2026-11-04 database update. It runs with the next deploy.';
const SERVICES = ['ST', 'OT', 'PT', 'SI', 'SW', 'NUT', 'AUD', 'VIS', 'FT'];
const ELIGIBLE = ['pending', 'yes', 'no'];

// Positive-only cache: works before the migration (it just says so).
let tablesSeen = false;
async function hasTables(db) {
  if (tablesSeen) return true;
  const r = await db.query(`SELECT to_regclass('"EiIfsps"') AS a, to_regclass('"EiIfspOutcomes"') AS b, to_regclass('"EiTransitions"') AS c`);
  tablesSeen = !!(r.rows[0]?.a && r.rows[0]?.b && r.rows[0]?.c);
  return tablesSeen;
}

const text = (v, max) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const dateOrNull = (v) => (v === undefined || v === null || v === '' ? null : v);

// Checks an IFSP from the form. Returns { value } or { error }.
async function cleanIfsp(db, patientId, body) {
  const ifspType = text(body.ifsp_type, 80);
  if (!ifspType) return { error: 'Choose the IFSP type.' };
  const start = dateOrNull(body.start_date);
  const end = dateOrNull(body.end_date);
  const meeting = dateOrNull(body.meeting_date);
  if (!start || !ifsp.isDate(start)) return { error: 'Enter the date the IFSP starts.' };
  for (const [label, d] of [['end', end], ['meeting', meeting]]) {
    if (d && !ifsp.isDate(d)) return { error: `The ${label} date isn't a valid date.` };
  }
  if (end && end < start) return { error: 'The end date is before the start date.' };
  const outcomes = Array.isArray(body.outcomes) ? body.outcomes : [];
  if (outcomes.length > 30) return { error: 'An IFSP can have up to 30 outcomes here.' };
  const cleanOutcomes = [];
  for (const o of outcomes) {
    const outcome = text(o?.outcome, 2000);
    if (!outcome) continue; // an empty row in the form
    const services = [...new Set((Array.isArray(o.services) ? o.services : []).map(s => String(s).toUpperCase()))];
    const unknown = services.find(s => !SERVICES.includes(s));
    if (unknown) return { error: `"${unknown}" isn't a service this list knows.` };
    cleanOutcomes.push({ outcome, services });
  }
  // US 10-digit, stored as (555) 555-5555 like every other phone number.
  let scPhone = null;
  if (text(body.sc_phone, 40)) {
    let d = String(body.sc_phone).replace(/\D/g, '');
    if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
    if (d.length !== 10) return { error: "Enter the service coordinator's full 10-digit phone number, or leave it blank." };
    scPhone = `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  let documentId = null;
  if (body.document_id !== undefined && body.document_id !== null && body.document_id !== '') {
    documentId = Number(body.document_id);
    const doc = Number.isInteger(documentId)
      ? (await db.query('SELECT id FROM "PatientDocuments" WHERE id=$1 AND patient_id=$2', [documentId, patientId])).rows[0]
      : null;
    if (!doc) return { error: "That document isn't one of this child's. Upload the IFSP again." };
  }
  return {
    value: {
      ifsp_type: ifspType, start_date: start, end_date: end, meeting_date: meeting,
      sc_name: text(body.sc_name, 200), sc_company: text(body.sc_company, 200), sc_phone: scPhone, sc_email: text(body.sc_email, 200),
      document_id: documentId, notes: text(body.notes, 4000), outcomes: cleanOutcomes,
    },
  };
}

async function loadIfsps(db, patientId) {
  const rows = (await db.query(
    `SELECT i.*, d.filename AS document_name FROM "EiIfsps" i
     LEFT JOIN "PatientDocuments" d ON d.id = i.document_id AND d.patient_id = i.patient_id
     WHERE i.patient_id=$1 ORDER BY i.start_date DESC, i.id DESC`, [patientId]
  )).rows;
  if (!rows.length) return [];
  const outcomes = (await db.query(
    'SELECT * FROM "EiIfspOutcomes" WHERE ifsp_id = ANY($1) ORDER BY position, id', [rows.map(r => r.id)]
  )).rows;
  return rows.map(r => ({
    ...r,
    report_due: ifsp.reportDue(r.end_date),
    outcomes: outcomes.filter(o => o.ifsp_id === r.id).map(o => ({ id: o.id, outcome: o.outcome, services: o.services })),
  }));
}

// Copies the current IFSP onto the patient (see the header). Leaves the
// patient alone when the child has no IFSP records left.
async function syncPatient(q, patientId) {
  const current = ifsp.currentIfsp(await loadIfsps(q, patientId), clinicToday());
  if (!current) return;
  await q.query(
    `UPDATE "Patients" SET "IFSP_Type"=$1, "IFSP_Start_Date"=$2, "IFSP_End_Date"=$3,
       "Report_Date"=COALESCE($4::date, "Report_Date"),
       "SC_Admin_Name"=COALESCE($5, "SC_Admin_Name"), "SC_Admin_Phone"=COALESCE($6, "SC_Admin_Phone"), "SC_Admin_Email"=COALESCE($7, "SC_Admin_Email")
     WHERE id=$8`,
    [current.ifsp_type, current.start_date, current.end_date, ifsp.reportDue(current.end_date), current.sc_name, current.sc_phone, current.sc_email, patientId]
  );
}

async function saveOutcomes(q, ifspId, outcomes) {
  await q.query('DELETE FROM "EiIfspOutcomes" WHERE ifsp_id=$1', [ifspId]);
  for (const [i, o] of outcomes.entries()) {
    await q.query('INSERT INTO "EiIfspOutcomes" (ifsp_id, position, outcome, services) VALUES ($1,$2,$3,$4)', [ifspId, i, o.outcome, o.services]);
  }
}

async function inTransaction(db, fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function handle({ path, method, body, db, currentUser }) {
  const m = path.match(/^\/patients\/([^/]+)\/(ifsp|ifsps|transition)(?:\/(\d+))?$/);
  if (!m) return null;
  const [, patientId, part, ifspId] = m;
  if (!featureOn('ei')) return json(404, { error: 'Not available at this clinic.' });
  if (!(await hasTables(db))) return json(503, { error: MIGRATION });

  const patient = /^[0-9a-f-]{36}$/i.test(patientId)
    ? (await db.query('SELECT id, "Name", "Date_of_Birth", "SC_Admin_Name", "SC_Admin_Phone", "SC_Admin_Email" FROM "Patients" WHERE id=$1', [patientId])).rows[0]
    : null;
  if (!patient) return json(404, { error: 'Patient not found.' });
  const manager = canManage(currentUser);

  if (part === 'ifsp' && !ifspId && method === 'GET') {
    if (!manager) {
      const team = (await currentCaseloads(db, { patientName: patient.Name })).get(patient.Name) || new Set();
      if (!currentUser.providerName || !team.has(currentUser.providerName)) {
        return json(403, { error: "Only this child's current providers and the office can see the IFSP." });
      }
    }
    const today = clinicToday();
    const ifsps = await loadIfsps(db, patient.id);
    const current = ifsp.currentIfsp(ifsps, today);
    const record = (await db.query('SELECT * FROM "EiTransitions" WHERE patient_id=$1', [patient.id])).rows[0] || null;
    const dates = ifsp.transitionDates(patient.Date_of_Birth);
    return json(200, {
      today,
      can_edit: manager,
      patient: { id: patient.id, name: patient.Name, date_of_birth: patient.Date_of_Birth },
      service_coordinator: { name: patient.SC_Admin_Name, phone: patient.SC_Admin_Phone, email: patient.SC_Admin_Email },
      ifsps,
      current_id: current?.id ?? null,
      transition: { dates, record, todo: ifsp.transitionTodo(dates, record, today) },
    });
  }

  if (!manager) return json(403, { error: 'Only Reception, Admins and Developers can change IFSP records.' });

  if (part === 'ifsps' && !ifspId && method === 'POST') {
    const { value, error } = await cleanIfsp(db, patient.id, body || {});
    if (error) return json(400, { error });
    const row = await inTransaction(db, async (q) => {
      const r = (await q.query(
        `INSERT INTO "EiIfsps" (patient_id, ifsp_type, meeting_date, start_date, end_date, sc_name, sc_company, sc_phone, sc_email, document_id, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
        [patient.id, value.ifsp_type, value.meeting_date, value.start_date, value.end_date, value.sc_name, value.sc_company, value.sc_phone, value.sc_email, value.document_id, value.notes, currentUser.username]
      )).rows[0];
      await saveOutcomes(q, r.id, value.outcomes);
      await syncPatient(q, patient.id);
      return r;
    });
    return json(201, { id: row.id });
  }

  if (part === 'ifsps' && ifspId && (method === 'PUT' || method === 'DELETE')) {
    const existing = (await db.query('SELECT id FROM "EiIfsps" WHERE id=$1 AND patient_id=$2', [ifspId, patient.id])).rows[0];
    if (!existing) return json(404, { error: 'That IFSP was not found. Reload the page.' });
    if (method === 'DELETE') {
      await inTransaction(db, async (q) => {
        await q.query('DELETE FROM "EiIfsps" WHERE id=$1', [existing.id]);
        await syncPatient(q, patient.id);
      });
      return json(200, { deleted: true });
    }
    const { value, error } = await cleanIfsp(db, patient.id, body || {});
    if (error) return json(400, { error });
    await inTransaction(db, async (q) => {
      await q.query(
        `UPDATE "EiIfsps" SET ifsp_type=$1, meeting_date=$2, start_date=$3, end_date=$4, sc_name=$5, sc_company=$6, sc_phone=$7, sc_email=$8,
           document_id=$9, notes=$10, updated_by=$11, updated_at=now() WHERE id=$12`,
        [value.ifsp_type, value.meeting_date, value.start_date, value.end_date, value.sc_name, value.sc_company, value.sc_phone, value.sc_email, value.document_id, value.notes, currentUser.username, existing.id]
      );
      await saveOutcomes(q, existing.id, value.outcomes);
      await syncPatient(q, patient.id);
    });
    return json(200, { id: existing.id });
  }

  if (part === 'transition' && !ifspId && method === 'PUT') {
    const b = body || {};
    const vals = {};
    for (const k of ['cpse_notified_date', 'conference_date', 'ei_end_date']) {
      const d = dateOrNull(b[k]);
      if (d && !ifsp.isDate(d)) return json(400, { error: 'One of the dates isn\'t a valid date.' });
      vals[k] = d;
    }
    const eligible = dateOrNull(b.cpse_eligible);
    if (eligible && !ELIGIBLE.includes(eligible)) return json(400, { error: 'CPSE eligibility must be pending, yes or no.' });
    await db.query(
      `INSERT INTO "EiTransitions" (patient_id, cpse_notified_date, parent_opted_out, conference_date, cpse_eligible, ei_end_date, notes, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (patient_id) DO UPDATE SET cpse_notified_date=EXCLUDED.cpse_notified_date, parent_opted_out=EXCLUDED.parent_opted_out,
         conference_date=EXCLUDED.conference_date, cpse_eligible=EXCLUDED.cpse_eligible, ei_end_date=EXCLUDED.ei_end_date,
         notes=EXCLUDED.notes, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [patient.id, vals.cpse_notified_date, !!b.parent_opted_out, vals.conference_date, eligible, vals.ei_end_date, text(b.notes, 4000), currentUser.username]
    );
    return json(200, { saved: true });
  }

  return json(405, { error: 'Not supported.' });
}

module.exports = { handle };
