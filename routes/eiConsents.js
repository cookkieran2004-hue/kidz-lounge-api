// Parent consents the NYC EI program asks agencies to hold (the "ei"
// feature, PedsDesk only, Oct 2026; migrations/2026-11-08_ei_audit_fixes.sql):
//   telehealth: the NYS EI Consent for the Use of Telehealth, one per
//               service type, before any remote (or hybrid) session;
//   email:      written consent before exchanging information by email
//               (NYS: texting families isn't an approved method).
//
//   GET    /patients/:id/ei-consents             the office, or a provider with the child on their caseload
//   POST   /patients/:id/ei-consents             { kind, service, signed_on, document_id, notes }   (canManage)
//   PUT    /patients/:id/ei-consents/:consentId  { withdrawn_on }                                   (canManage)
//   DELETE /patients/:id/ei-consents/:consentId  an entry made by mistake                          (canAdminister)
//
// A withdrawn consent is kept (with its date): the record shows what was in
// force on any session's date. Session notes check it (lib/sessionNotes.js).
const { json } = require('../lib/http');
const { canManage, canAdminister } = require('../lib/roles');
const { featureOn } = require('../lib/features');
const { currentCaseloads } = require('../lib/caseload');

const SERVICES = ['ST', 'OT', 'PT', 'SI'];
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
let tableSeen = false;
async function hasTable(db) {
  if (tableSeen) return true;
  tableSeen = !!(await db.query(`SELECT to_regclass('"EiConsents"') AS t`)).rows[0]?.t;
  return tableSeen;
}
const day10 = (v) => (v ? String(v).slice(0, 10) : null);
const shape = (r) => ({ ...r, signed_on: day10(r.signed_on), withdrawn_on: day10(r.withdrawn_on) });

async function handle({ path, method, body, db, currentUser }) {
  const m = path.match(/^\/patients\/([^/]+)\/ei-consents(?:\/(\d+))?$/);
  if (!m) return null;
  if (!featureOn('ei')) return json(404, { error: 'Not available at this clinic.' });
  if (!(await hasTable(db))) return json(503, { error: 'Consents need the 2026-11-08 database update. It runs with the next deploy.' });
  const [, patientId, consentId] = m;
  if (!/^[0-9a-f-]{36}$/i.test(patientId)) return json(404, { error: 'Patient not found.' });
  const patient = (await db.query('SELECT id, "Name" FROM "Patients" WHERE id=$1', [patientId])).rows[0];
  if (!patient) return json(404, { error: 'Patient not found.' });

  if (!consentId && method === 'GET') {
    if (!canManage(currentUser)) {
      const team = (await currentCaseloads(db, { patientName: patient.Name })).get(patient.Name) || new Set();
      if (!currentUser.providerName || !team.has(currentUser.providerName)) return json(403, { error: "Only this child's current providers and the office can see consents." });
    }
    const rows = (await db.query('SELECT * FROM "EiConsents" WHERE patient_id=$1 ORDER BY kind, service NULLS FIRST, signed_on DESC', [patient.id])).rows;
    return json(200, { consents: rows.map(shape), can_edit: canManage(currentUser) });
  }

  if (!canManage(currentUser)) return json(403, { error: 'Only Reception, Admins and Developers can record consents.' });

  if (!consentId && method === 'POST') {
    const b = body || {};
    const kind = ['telehealth', 'email'].includes(b.kind) ? b.kind : null;
    if (!kind) return json(400, { error: 'Choose telehealth or email consent.' });
    const service = kind === 'telehealth' ? (SERVICES.includes(b.service) ? b.service : null) : null;
    if (kind === 'telehealth' && !service) return json(400, { error: 'Telehealth consent is signed for each service type: choose the service.' });
    if (!isDate(b.signed_on)) return json(400, { error: 'Enter the date the parent signed it.' });
    const docId = b.document_id ? Number(b.document_id) : null;
    if (docId && !(await db.query('SELECT 1 FROM "PatientDocuments" WHERE id=$1 AND patient_id=$2', [docId, patient.id])).rows.length) {
      return json(400, { error: "That document isn't in this child's Documents." });
    }
    const row = (await db.query(
      `INSERT INTO "EiConsents" (patient_id, kind, service, signed_on, document_id, notes, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [patient.id, kind, service, b.signed_on, docId, String(b.notes || '').trim().slice(0, 1000) || null, currentUser.username]
    )).rows[0];
    return json(201, shape(row));
  }

  const row = (await db.query('SELECT * FROM "EiConsents" WHERE id=$1 AND patient_id=$2', [Number(consentId), patient.id])).rows[0];
  if (!row) return json(404, { error: 'That consent was not found.' });

  if (method === 'PUT') {
    const on = body?.withdrawn_on;
    if (on !== null && !isDate(on)) return json(400, { error: 'Enter the date the parent withdrew consent.' });
    if (on && on < day10(row.signed_on)) return json(400, { error: "A consent can't be withdrawn before it was signed." });
    const updated = (await db.query('UPDATE "EiConsents" SET withdrawn_on=$1 WHERE id=$2 RETURNING *', [on, row.id])).rows[0];
    return json(200, shape(updated));
  }

  if (method === 'DELETE') {
    if (!canAdminister(currentUser)) return json(403, { error: 'Only Admins and Developers can remove a consent entered by mistake. To end one, record the date it was withdrawn.' });
    await db.query('DELETE FROM "EiConsents" WHERE id=$1', [row.id]);
    return json(200, { deleted: true });
  }
  return json(405, { error: 'Not supported.' });
}

module.exports = { handle };
