// The chart's Services tab (the "ei" feature, PedsDesk only; Kieran, Oct
// 2026): an EI child's mandates and authorizations per service, with their
// dates, in one place. Editing them in the patient form was hard to follow
// (a wrong start date had to be deleted and entered again), so here:
//   - "Change from a date" is a real change: the current mandate ends the
//     day before and the new one starts on the date.
//   - "Correct" fixes an entry in place, its dates included; the entry next
//     to it is moved to match, so there's never a gap or an overlap.
//   - Authorizations are their own records (auth #, service, start-end,
//     Basic / Facility, visits), entered by hand or imported from EI-Hub
//     (both in "EiAuthorizations"; billing uses the one covering each
//     session date: routes/billing.js eiHubSessions).
//
//   GET  /patients/:id/ei-services                          the office, or a provider with the child on their caseload
//   POST /patients/:id/ei-services/mandates                 { service, sessions, minutes, start_date }  a new mandate from a date
//   PUT  /patients/:id/ei-services/mandates/:rowId          { sessions, minutes, start_date, end_date } a correction
//   POST /patients/:id/ei-services/authorizations           { service, authorization_number, start_date, end_date, visit_type, sessions_authorized }  (canManage)
//   PUT  /patients/:id/ei-services/authorizations/:number   { start_date, end_date, visit_type, sessions_authorized }  a correction (canManage)
//   DELETE /patients/:id/ei-services/authorizations/:number one entered by hand (canManage)
//
// Who edits mandates: the office (Reception, Admins, Developers), and a
// provider for children on their caseload, in their own disciplines (Kieran:
// providers too). Providers never see auth #s (Kieran, Oct 2026). Deleting a
// mandate entry stays Admin / Developer (DELETE /patients/:id/programs/:id).
const { json } = require('../lib/http');
const { canManage } = require('../lib/roles');
const { featureOn } = require('../lib/features');
const { currentCaseloads } = require('../lib/caseload');
const programs = require('../lib/patientPrograms');

const SERVICES = ['ST', 'OT', 'PT', 'SI'];
// EI-Hub's program names; the part after " - " is the visit type that
// billing reads (routes/billing.js authVisitType).
const EI_HUB_PROGRAM = { ST: 'Speech Language', OT: 'Occupational Therapy', PT: 'Physical Therapy', SI: 'Special Instruction' };
const VISIT_TYPES = { basic: 'Basic', facility: 'Facility' };

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const day = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const nice = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'the beginning');
// Two entries' dates overlap (NULL start = from the beginning, NULL end = still current).
const overlaps = (aStart, aEnd, bStart, bEnd) => (!aStart || !bEnd || aStart <= bEnd) && (!bStart || !aEnd || bStart <= aEnd);

let sourceSeen = false;
async function authTable(db) {
  const t = (await db.query(`SELECT to_regclass('"EiAuthorizations"') AS t`)).rows[0]?.t;
  if (!t) return { exists: false, source: false };
  if (!sourceSeen) sourceSeen = (await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'EiAuthorizations' AND column_name = 'source'`)).rows.length > 0;
  return { exists: true, source: sourceSeen };
}

// The services this person may change mandates for: all for the office; a
// provider's own disciplines for a child on their caseload; none otherwise.
async function editableServices(db, currentUser, patient) {
  if (canManage(currentUser)) return SERVICES;
  if (!currentUser.providerName) return [];
  const team = (await currentCaseloads(db, { patientName: patient.Name })).get(patient.Name) || new Set();
  if (!team.has(currentUser.providerName)) return [];
  const spec = (await db.query('SELECT specialty FROM "Providers" WHERE "Name"=$1', [currentUser.providerName])).rows[0]?.specialty || '';
  return SERVICES.filter(s => String(spec).toUpperCase().split(/[^A-Z]+/).includes(s));
}

async function refreshSummary(q, patientId) {
  const now = await programs.currentRows(q, patientId);
  const { program, mandate } = programs.summarize(now);
  const legacy = now.find(x => x.legacy_mandate)?.legacy_mandate || null;
  await q.query('UPDATE "Patients" SET "Program"=$1, "Mandate"=$2 WHERE id=$3', [program, mandate || legacy, patientId]);
}

function cleanMandate(b) {
  const sessions = String(b?.sessions ?? '').replace(/\s+/g, '');
  const minutes = Number(b?.minutes);
  if (!/^\d{1,2}(-\d{1,2})?$/.test(sessions)) return { error: 'Enter sessions per week, like 2 or 1-2.' };
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240) return { error: 'Enter the minutes per session, like 30.' };
  return { sessions, minutes };
}

async function inTransaction(db, fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query(out?.statusCode && out.statusCode >= 400 ? 'ROLLBACK' : 'COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const shapeMandate = (r, withAuth) => ({
  id: r.id, service: r.service, sessions: r.sessions, minutes: r.minutes,
  start_date: day(r.start_date), end_date: day(r.end_date), current: !r.end_date,
  legacy_mandate: r.legacy_mandate || null, created_by: r.created_by || null,
  ...(withAuth ? { authorization_number: r.authorization_number || null } : {}),
});
const visitTypeOf = (a) => {
  const kind = String(a.program || '').split(' - ').slice(1).join(' - ');
  return /facility/i.test(kind) ? 'facility' : /basic|home|community/i.test(kind) ? 'basic' : null;
};
const shapeAuth = (a) => ({
  authorization_number: a.authorization_number, service: a.service,
  start_date: day(a.start_date), end_date: day(a.end_date), visit_type: visitTypeOf(a),
  sessions_authorized: a.sessions_authorized === null || a.sessions_authorized === undefined ? null : Number(a.sessions_authorized),
  sessions_used: a.sessions_used === null || a.sessions_used === undefined ? null : Number(a.sessions_used),
  suspended_start: day(a.suspended_start), suspended_end: day(a.suspended_end),
  by_hand: a.source === 'hand',
});

async function handle({ path, method, body, db, currentUser }) {
  const m = path.match(/^\/patients\/([^/]+)\/ei-services(?:\/(mandates|authorizations)(?:\/([^/]+))?)?$/);
  if (!m) return null;
  if (!featureOn('ei')) return json(404, { error: 'Not available at this clinic.' });
  const [, patientId, kind, itemId] = m;
  if (!/^[0-9a-f-]{36}$/i.test(patientId)) return json(404, { error: 'Patient not found.' });
  const patient = (await db.query('SELECT id, "Name", "ID_Number" FROM "Patients" WHERE id=$1', [patientId])).rows[0];
  if (!patient) return json(404, { error: 'Patient not found.' });
  if (!(await programs.hasProgramsTable(db))) return json(503, { error: 'Programs and mandates need a database update. It runs with the next deploy.' });
  const office = canManage(currentUser);
  const editable = await editableServices(db, currentUser, patient);
  const auths = await authTable(db);

  if (!kind && method === 'GET') {
    if (!office && !editable.length) {
      const team = (await currentCaseloads(db, { patientName: patient.Name })).get(patient.Name) || new Set();
      if (!currentUser.providerName || !team.has(currentUser.providerName)) return json(403, { error: "Only this child's current providers and the office can see their services." });
    }
    const rows = (await db.query(`SELECT * FROM "PatientPrograms" WHERE patient_id=$1 ORDER BY start_date DESC NULLS LAST, id DESC`, [patient.id])).rows;
    const authRows = office && auths.exists
      ? (await db.query('SELECT * FROM "EiAuthorizations" WHERE patient_id=$1 ORDER BY start_date DESC NULLS LAST', [patient.id])).rows
      : [];
    const ei = rows.filter(r => r.program === 'EI');
    const used = new Set([...ei.filter(r => r.service).map(r => r.service), ...authRows.map(a => a.service).filter(Boolean)]);
    const services = SERVICES.filter(s => used.has(s)).map(s => ({
      service: s,
      mandates: ei.filter(r => r.service === s).map(r => shapeMandate(r, office)),
      authorizations: authRows.filter(a => a.service === s).map(shapeAuth),
      can_edit: editable.includes(s),
    }));
    // Services that are under another program now (they can't be EI at the same time).
    const elsewhere = rows.filter(r => r.program !== 'EI' && r.service && !r.end_date).map(r => ({ service: r.service, program: r.program }));
    const eiNoMandate = ei.find(r => !r.service && !r.end_date);
    return json(200, {
      services, elsewhere, editable_services: editable, can_edit_authorizations: office && auths.exists,
      can_delete: ['admin', 'developer'].includes(currentUser.role),
      ei_without_mandate: eiNoMandate ? { id: eiNoMandate.id, legacy_mandate: eiNoMandate.legacy_mandate || null } : null,
    });
  }

  // ---- Mandates ----
  if (kind === 'mandates' && !itemId && method === 'POST') {
    const service = String(body?.service || '').toUpperCase();
    if (!SERVICES.includes(service)) return json(400, { error: 'Choose the service.' });
    if (!editable.includes(service)) return json(403, { error: office ? 'Not allowed.' : `You can change mandates for your own services (${editable.join(', ') || 'none'}) for children on your caseload.` });
    const v = cleanMandate(body);
    if (v.error) return json(400, { error: v.error });
    const start = body?.start_date || null;
    if (start !== null && !isDate(start)) return json(400, { error: 'Choose the date the mandate starts.' });
    return inTransaction(db, async (q) => {
      const rows = (await q.query('SELECT * FROM "PatientPrograms" WHERE patient_id=$1 FOR UPDATE', [patient.id])).rows;
      const other = rows.find(r => r.program !== 'EI' && r.service === service && overlaps(start, null, day(r.start_date), day(r.end_date)));
      if (other) return json(409, { error: `${service} is under ${other.program} ${other.end_date ? `until ${nice(day(other.end_date))}` : 'now'}. A service can only be under one program at a time: change that in the patient form first.` });
      const mine = rows.filter(r => r.program === 'EI' && r.service === service);
      const current = mine.find(r => !r.end_date);
      if (mine.length && !start) return json(400, { error: 'Choose the date the new mandate starts. To fix the dates of one already entered, use Correct.' });
      if (current && current.start_date && day(current.start_date) >= start) {
        return json(409, { error: `The current ${service} mandate starts on ${nice(day(current.start_date))}, not before ${nice(start)}. To fix its date or numbers, use Correct on it.` });
      }
      if (mine.some(r => r.end_date && day(r.end_date) >= start)) return json(409, { error: `An earlier ${service} mandate runs past ${nice(start)}. Use Correct on it to fix its dates.` });
      if (current) await q.query('UPDATE "PatientPrograms" SET end_date=$1, ended_by=$2 WHERE id=$3', [addDays(start, -1), currentUser.username, current.id]);
      // EI with no mandate entered yet: the first mandate replaces it from the date.
      const placeholder = rows.find(r => r.program === 'EI' && !r.service && !r.end_date);
      if (placeholder) {
        if (!start || (placeholder.start_date && day(placeholder.start_date) >= start)) await q.query('DELETE FROM "PatientPrograms" WHERE id=$1', [placeholder.id]);
        else await q.query('UPDATE "PatientPrograms" SET end_date=$1, ended_by=$2 WHERE id=$3', [addDays(start, -1), currentUser.username, placeholder.id]);
      }
      const row = (await q.query(
        `INSERT INTO "PatientPrograms" (patient_id, program, service, sessions, minutes, start_date, created_by, authorization_number)
         VALUES ($1, 'EI', $2, $3, $4, $5, $6, $7) RETURNING *`,
        [patient.id, service, v.sessions, v.minutes, start, currentUser.username, current?.authorization_number || null]
      )).rows[0];
      await refreshSummary(q, patient.id);
      return json(201, shapeMandate(row, office));
    });
  }

  if (kind === 'mandates' && itemId && method === 'PUT') {
    return inTransaction(db, async (q) => {
      const row = (await q.query('SELECT * FROM "PatientPrograms" WHERE id=$1 AND patient_id=$2 FOR UPDATE', [Number(itemId) || 0, patient.id])).rows[0];
      if (!row || row.program !== 'EI' || !row.service) return json(404, { error: 'That EI mandate was not found.' });
      if (!editable.includes(row.service)) return json(403, { error: `You can correct mandates for your own services (${editable.join(', ') || 'none'}) for children on your caseload.` });
      const v = cleanMandate(body);
      if (v.error) return json(400, { error: v.error });
      const oldStart = day(row.start_date);
      const oldEnd = day(row.end_date);
      const start = body?.start_date === undefined ? oldStart : (body.start_date || null);
      const end = oldEnd ? (body?.end_date === undefined ? oldEnd : body.end_date) : null;
      if (start !== null && !isDate(start)) return json(400, { error: 'Choose the start date.' });
      if (oldEnd && !isDate(end)) return json(400, { error: 'Choose the end date. (Only the current mandate has none.)' });
      if (start && end && start > end) return json(400, { error: 'The start date is after the end date.' });
      const others = (await q.query('SELECT * FROM "PatientPrograms" WHERE patient_id=$1 AND service=$2 AND id<>$3 FOR UPDATE', [patient.id, row.service, row.id])).rows;
      // The entries right before and after it (they touch it).
      const prev = oldStart ? others.find(r => r.program === 'EI' && day(r.end_date) === addDays(oldStart, -1)) : null;
      const next = oldEnd ? others.find(r => r.program === 'EI' && day(r.start_date) === addDays(oldEnd, 1)) : null;
      if (prev && start !== oldStart) {
        if (!start || (prev.start_date && addDays(start, -1) < day(prev.start_date))) {
          return json(409, { error: `That would cover all of the ${prev.sessions && prev.minutes ? `${prev.sessions}x${prev.minutes} ` : ''}mandate from ${nice(day(prev.start_date))}. Correct or delete that one first.` });
        }
      }
      if (next && end !== oldEnd && day(next.end_date) && addDays(end, 1) > day(next.end_date)) {
        return json(409, { error: `That would cover all of the next mandate (from ${nice(day(next.start_date))}). Correct or delete that one first.` });
      }
      const clash = others.find(r => r !== prev && r !== next && overlaps(start, end, day(r.start_date), day(r.end_date)));
      if (clash) {
        return json(409, { error: clash.program === 'EI'
          ? `Those dates overlap the ${row.service} mandate from ${nice(day(clash.start_date))}${clash.end_date ? ` to ${nice(day(clash.end_date))}` : ''}. Correct that one first.`
          : `${row.service} is under ${clash.program} on some of those dates. A service can only be under one program at a time.` });
      }
      if (prev && start !== oldStart) await q.query('UPDATE "PatientPrograms" SET end_date=$1 WHERE id=$2', [addDays(start, -1), prev.id]);
      if (next && end !== oldEnd) await q.query('UPDATE "PatientPrograms" SET start_date=$1 WHERE id=$2', [addDays(end, 1), next.id]);
      const updated = (await q.query(
        'UPDATE "PatientPrograms" SET sessions=$1, minutes=$2, start_date=$3, end_date=$4 WHERE id=$5 RETURNING *',
        [v.sessions, v.minutes, start, end, row.id]
      )).rows[0];
      await refreshSummary(q, patient.id);
      return json(200, shapeMandate(updated, office));
    });
  }

  // ---- Authorizations (the office) ----
  if (kind === 'authorizations') {
    if (!office) return json(403, { error: 'Only Reception, Admins and Developers can see and change authorizations.' });
    if (!auths.exists) return json(503, { error: 'Authorizations need a database update. It runs with the next deploy.' });
    const b = body || {};
    const fields = () => {
      if (!isDate(b.start_date) || !isDate(b.end_date)) return { error: 'Enter the authorization\'s start and end dates.' };
      if (b.start_date > b.end_date) return { error: 'The start date is after the end date.' };
      const visit = b.visit_type ? VISIT_TYPES[b.visit_type] : null;
      if (b.visit_type && !visit) return { error: 'Choose Basic or Facility.' };
      const n = b.sessions_authorized === '' || b.sessions_authorized === null || b.sessions_authorized === undefined ? null : Number(b.sessions_authorized);
      if (n !== null && (!Number.isFinite(n) || n < 0 || n > 999)) return { error: 'Enter the number of visits authorized, or leave it blank.' };
      return { visit, n };
    };
    if (!itemId && method === 'POST') {
      const service = String(b.service || '').toUpperCase();
      if (!SERVICES.includes(service)) return json(400, { error: 'Choose the service.' });
      const number = String(b.authorization_number || '').trim();
      if (!/^[A-Za-z0-9-]{3,40}$/.test(number)) return json(400, { error: 'Enter the authorization number.' });
      const f = fields();
      if (f.error) return json(400, { error: f.error });
      const taken = (await db.query('SELECT patient_id FROM "EiAuthorizations" WHERE authorization_number=$1', [number])).rows[0];
      if (taken) return json(409, { error: taken.patient_id === patient.id ? 'That authorization is already on file for this child: use Correct on it.' : 'That authorization number is already on file for another child.' });
      const row = (await db.query(
        `INSERT INTO "EiAuthorizations" (authorization_number, patient_id, ei_child_id, service, program, start_date, end_date, sessions_authorized, imported_by, imported_at${auths.source ? ', source' : ''})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()${auths.source ? ", 'hand'" : ''}) RETURNING *`,
        [number, patient.id, patient.ID_Number || null, service, `${EI_HUB_PROGRAM[service]}${f.visit ? ` - ${f.visit}` : ''}`, b.start_date, b.end_date, f.n, currentUser.username]
      )).rows[0];
      return json(201, shapeAuth(row));
    }
    const existing = itemId ? (await db.query('SELECT * FROM "EiAuthorizations" WHERE authorization_number=$1 AND patient_id=$2', [decodeURIComponent(itemId), patient.id])).rows[0] : null;
    if (itemId && !existing) return json(404, { error: 'That authorization was not found.' });
    if (itemId && method === 'PUT') {
      const f = fields();
      if (f.error) return json(400, { error: f.error });
      const row = (await db.query(
        'UPDATE "EiAuthorizations" SET start_date=$1, end_date=$2, program=$3, sessions_authorized=$4 WHERE authorization_number=$5 RETURNING *',
        [b.start_date, b.end_date, `${EI_HUB_PROGRAM[existing.service] || String(existing.program || '').split(' - ')[0]}${f.visit ? ` - ${f.visit}` : ''}`, f.n, existing.authorization_number]
      )).rows[0];
      return json(200, shapeAuth(row));
    }
    if (itemId && method === 'DELETE') {
      if (auths.source && existing.source !== 'hand') return json(409, { error: 'This one came from the EI-Hub import, which keeps it up to date. Correct it instead, or fix it in EI-Hub.' });
      await db.query('DELETE FROM "EiAuthorizations" WHERE authorization_number=$1', [existing.authorization_number]);
      return json(200, { deleted: true });
    }
  }
  return json(405, { error: 'Not supported.' });
}

module.exports = { handle };
