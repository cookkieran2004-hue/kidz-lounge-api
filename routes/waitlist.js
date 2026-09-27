const { json } = require('../lib/http');
const { todayStr } = require('../lib/workSchedule');

// Waitlist (migrations/2026-10-08_waitlist.sql): patients waiting to start
// a service, one entry per patient per specialty. Every signed-in staff
// member can see and change it -- by design, not an oversight.
//
//   GET    /waitlist?view=active|history   (&patient=<name> for one patient's)
//                                          active = waiting/contacted, oldest
//                                          referral first; history = scheduled/
//                                          removed, most recently closed first
//   POST   /waitlist                       { patient_id, specialties: [...],
//                                            providers: { ST: 'Name' }, ... }
//                                          one entry per specialty, together
//   PUT    /waitlist/:id                   partial update; status changes stamp
//                                          contacted_at / closed_at + closed_by;
//                                          Scheduled also sets the patient On Program
//   DELETE /waitlist/:id                   permanently, for entries added by mistake
//
// Providers are stored by name like everywhere else, so a rename cascades
// here too (lib/providerNames.js).

const SPECIALTIES = ['PT', 'OT', 'ST', 'SI'];
const STATUSES = ['waiting', 'contacted', 'scheduled', 'removed'];
const ACTIVE = ['waiting', 'contacted'];

// Only a "yes" is remembered, so a warm Lambda picks the table up as soon
// as the migration has run.
let tableExists = false;
async function hasTable(db) {
  if (tableExists) return true;
  const r = await db.query(`SELECT to_regclass('"Waitlist"') IS NOT NULL AS ok`);
  tableExists = !!r.rows[0]?.ok;
  return tableExists;
}
const NEEDS_MIGRATION = 'The waitlist isn\'t set up yet. Run migrations/2026-10-08_waitlist.sql first.';

const SELECT = `
  SELECT w.*, p."Name" AS patient_name, p."Program" AS program, p."Parent_Name" AS parent_name,
         p."Parent_Phone" AS parent_phone, p."Status" AS patient_status
  FROM "Waitlist" w JOIN "Patients" p ON p.id = w.patient_id`;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:00)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Checks and normalises the availability / date / notes fields that both
// POST and PUT accept. Only keys present in `body` are returned, so a PUT
// leaves the rest alone. Throws a plain-English message on bad input.
function readFields(body) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (has('available_days')) {
    const days = Array.isArray(body.available_days) ? body.available_days.map(Number) : [];
    if (days.some(d => !Number.isInteger(d) || d < 1 || d > 5)) throw new Error('Available days must be Monday to Friday.');
    out.available_days = [...new Set(days)].sort();
  }
  for (const k of ['available_from', 'available_to']) {
    if (has(k)) {
      const v = body[k] || null;
      if (v && !TIME_RE.test(v)) throw new Error('Times must look like 15:30.');
      out[k] = v ? v.slice(0, 5) : null;
    }
  }
  if (out.available_from && out.available_to && out.available_from >= out.available_to) {
    throw new Error('The latest time has to be after the earliest time.');
  }
  if (has('referral_date')) {
    if (!DATE_RE.test(body.referral_date || '')) throw new Error('A referral date is required.');
    out.referral_date = body.referral_date;
  }
  if (has('notes')) out.notes = (body.notes || '').trim().slice(0, 4000) || null;
  return out;
}

async function handle({ path, method, qs, body, db, currentUser }) {
  const listRoute = path === '/waitlist';
  const idMatch = path.match(/^\/waitlist\/([^/]+)$/);
  if (!listRoute && !idMatch) return null;

  if (!(await hasTable(db))) {
    return listRoute && method === 'GET' ? json(200, { setup_needed: true, entries: [] }) : json(503, { error: NEEDS_MIGRATION });
  }

  if (listRoute && method === 'GET') {
    const history = qs.view === 'history';
    // ?patient=<name>: one patient's active entries -- how the appointment
    // form checks, after booking, whether to offer taking them off the list.
    const byPatient = !history && qs.patient ? qs.patient : null;
    const res = await db.query(
      history
        ? `${SELECT} WHERE w.status IN ('scheduled', 'removed') ORDER BY w.closed_at DESC NULLS LAST, w.id DESC LIMIT 300`
        : `${SELECT} WHERE w.status IN ('waiting', 'contacted') ${byPatient ? 'AND p."Name" = $1' : ''} ORDER BY w.referral_date, w.id`,
      byPatient ? [byPatient] : []
    );
    return json(200, { entries: res.rows });
  }

  if (listRoute && method === 'POST') {
    const specialties = [...new Set(Array.isArray(body.specialties) ? body.specialties : [body.specialty])].filter(Boolean);
    if (!body.patient_id) return json(400, { error: 'Choose a patient.' });
    if (!specialties.length) return json(400, { error: 'Choose at least one specialty.' });
    if (specialties.some(s => !SPECIALTIES.includes(s))) return json(400, { error: `Specialty must be one of ${SPECIALTIES.join(', ')}.` });
    let fields;
    try {
      // The app always sends the date the person picked; this fallback is
      // the server's today (UTC on Lambda).
      fields = readFields({ ...body, referral_date: body.referral_date || todayStr() });
    } catch (err) {
      return json(400, { error: err.message });
    }
    const patient = (await db.query('SELECT "Name" FROM "Patients" WHERE id::text=$1', [String(body.patient_id)])).rows[0];
    if (!patient) return json(400, { error: 'That patient wasn\'t found. They may have been deleted.' });
    const already = (await db.query(
      `SELECT specialty FROM "Waitlist" WHERE patient_id::text=$1 AND specialty = ANY($2) AND status = ANY($3)`,
      [String(body.patient_id), specialties, ACTIVE]
    )).rows.map(r => r.specialty);
    if (already.length) {
      return json(409, { error: `${patient.Name} is already on the waitlist for ${already.join(' and ')}. Edit that entry instead.` });
    }
    const providers = body.providers && typeof body.providers === 'object' ? body.providers : {};
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const ids = [];
      for (const specialty of specialties) {
        const r = await client.query(
          `INSERT INTO "Waitlist" (patient_id, specialty, preferred_provider, available_days, available_from, available_to, referral_date, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [body.patient_id, specialty, providers[specialty] || null, fields.available_days || [], fields.available_from || null,
            fields.available_to || null, fields.referral_date, fields.notes || null, currentUser.username]
        );
        ids.push(r.rows[0].id);
      }
      await client.query('COMMIT');
      const created = await db.query(`${SELECT} WHERE w.id = ANY($1) ORDER BY w.id`, [ids]);
      return json(201, { entries: created.rows });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  const id = idMatch && idMatch[1];
  if (idMatch && method === 'PUT') {
    const existing = (await db.query('SELECT * FROM "Waitlist" WHERE id::text=$1', [id])).rows[0];
    if (!existing) return json(404, { error: 'That waitlist entry wasn\'t found.' });
    let fields;
    try {
      fields = readFields(body);
    } catch (err) {
      return json(400, { error: err.message });
    }
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    if (has('specialty')) {
      if (!SPECIALTIES.includes(body.specialty)) return json(400, { error: `Specialty must be one of ${SPECIALTIES.join(', ')}.` });
      fields.specialty = body.specialty;
    }
    if (has('preferred_provider')) fields.preferred_provider = body.preferred_provider || null;
    if (has('status') && body.status !== existing.status) {
      if (!STATUSES.includes(body.status)) return json(400, { error: 'Unknown status.' });
      fields.status = body.status;
      const closing = !ACTIVE.includes(body.status);
      fields.closed_at = closing ? new Date() : null;
      fields.closed_by = closing ? currentUser.username : null;
      if (body.status === 'contacted') fields.contacted_at = new Date();
      if (body.status === 'waiting') fields.contacted_at = null;
    }
    // Back onto the list (or a new specialty) mustn't duplicate an active entry.
    const nextStatus = fields.status || existing.status;
    const nextSpecialty = fields.specialty || existing.specialty;
    if (ACTIVE.includes(nextStatus) && (fields.status || fields.specialty)) {
      const clash = await db.query(
        `SELECT 1 FROM "Waitlist" WHERE patient_id=$1 AND specialty=$2 AND status = ANY($3) AND id<>$4`,
        [existing.patient_id, nextSpecialty, ACTIVE, existing.id]
      );
      if (clash.rows[0]) return json(409, { error: `This patient is already on the waitlist for ${nextSpecialty}.` });
    }
    const keys = Object.keys(fields);
    if (!keys.length) return json(400, { error: 'Nothing to change.' });
    const sets = keys.map((k, i) => `"${k}"=$${i + 1}`);
    // Scheduled off the waitlist means they're starting services: the
    // patient's own status becomes On Program, whichever screen did it.
    const nowScheduled = fields.status === 'scheduled';
    let patientNowOnProgram = false;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE "Waitlist" SET ${sets.join(', ')}, updated_at=now() WHERE id=$${keys.length + 1}`,
        [...keys.map(k => fields[k]), existing.id]
      );
      if (nowScheduled) {
        const changed = await client.query(
          `UPDATE "Patients" SET "Status"='On Program' WHERE id=$1 AND "Status" IS DISTINCT FROM 'On Program' RETURNING id`,
          [existing.patient_id]
        );
        patientNowOnProgram = !!changed.rows[0];
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    const updated = await db.query(`${SELECT} WHERE w.id=$1`, [existing.id]);
    return json(200, { ...updated.rows[0], patient_now_on_program: patientNowOnProgram });
  }

  if (idMatch && method === 'DELETE') {
    const res = await db.query('DELETE FROM "Waitlist" WHERE id::text=$1 RETURNING id', [id]);
    if (!res.rows[0]) return json(404, { error: 'That waitlist entry wasn\'t found.' });
    return json(200, { deleted: true });
  }

  return null;
}

module.exports = { handle, SPECIALTIES };
