const jwt = require('jsonwebtoken');
const { json } = require('../lib/http');
const { canManage, canAdminister } = require('../lib/roles');
const audit = require('../lib/audit');
const pf = require('../lib/powerForms');
const { PATIENT_TASK_FALLBACK_ROLES } = require('../lib/roles');

// Power Forms (Kieran, Oct 2026; migrations/2026-10-27_power_forms.sql).
// Staff (signed in):
//   GET  /power-forms/setup                     field types + chart fields (builder)
//   GET  /power-forms/templates                 Reception, Admins, Developers (?all=1: archived too)
//   POST /power-forms/templates                 Admins and Developers build them
//   PUT  /power-forms/templates/:id
//   POST /power-forms/templates/:id/archive     { archived }
//   GET  /power-forms/patient/:patientId        forms sent for a patient
//   POST /power-forms/requests                  { patient_id, template_id, recipient, days } -> the link's token (once)
//   POST /power-forms/requests/:id/new-link     a fresh link (the old one stops working)
//   POST /power-forms/requests/:id/cancel
//   GET  /power-forms/requests/:id              answers + what they'd change on the chart
//   POST /power-forms/requests/:id/apply        { fields: ['Parent_Phone', ...] }
//   POST /power-forms/requests/:id/document     { document_id } the PDF copy saved to Documents
//   POST /power-forms/requests/:id/review       mark a completed form reviewed
// A completed form "needs review" until someone reviews it (or applies its
// answers); submitting one gives every active Reception and Admin a review
// task, completed for all of them when it's reviewed (Kieran, Oct 2026;
// migrations/2026-10-28_power_forms_review.sql).
// Public (the parent, no sign-in; index.js routes /forms/ here first):
//   GET  /forms/:token                          is the link usable?
//   POST /forms/:token/unlock                   { dob } -> the form + a 2-hour access token
//   POST /forms/:token/submit                   { access, answers }
// The link's token is a 256-bit random value; only its SHA-256 is stored.
// Opening it takes the child's date of birth: 5 wrong in a row lock the link
// for 30 minutes. Reception, Admins and Developers send and review forms;
// providers don't (the chart tab is hidden from them too).

const MIGRATION = 'Power Forms need the 2026-10-27 database update. Ask an admin to run it.';
const DAYS = [3, 7, 14, 30];
const MAX_FAILS = 5;
const LOCK_MINUTES = 30;

let ready = false;
async function hasTables(db) {
  if (ready) return true;
  const r = await db.query(`SELECT to_regclass('"PowerFormRequests"') AS t`);
  if (r.rows[0]?.t) ready = true;
  return ready;
}

let reviewReady = false;
async function hasReview(db) {
  if (reviewReady) return true;
  const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'PowerFormRequests' AND column_name = 'reviewed_at'`);
  if (r.rows.length) reviewReady = true;
  return reviewReady;
}
const taskKey = (id) => `power_form_${id}`;
// Done reviewing: the form is marked, and everyone's review task completes.
async function markReviewed(db, id, username) {
  if (!(await hasReview(db))) return;
  await db.query('UPDATE "PowerFormRequests" SET reviewed_at=COALESCE(reviewed_at, now()), reviewed_by=COALESCE(reviewed_by, $1) WHERE id=$2', [username, id]);
  await db.query(`UPDATE "Tasks" SET status='done', completed_at=now() WHERE deadline_type=$1 AND status <> 'done'`, [taskKey(id)]).catch(() => {});
}

// A request's status as people see it: sent / opened / completed /
// cancelled / expired (sent or opened, past its date).
function statusOf(r) {
  if (r.status === 'completed' || r.status === 'cancelled') return r.status;
  return new Date(r.expires_at) < new Date() ? 'expired' : r.status;
}
const summaryOf = (r) => ({
  id: r.id, form_name: r.form_name, recipient: r.recipient, status: statusOf(r), expires_at: r.expires_at,
  created_by: r.created_by, created_at: r.created_at, opened_at: r.opened_at, completed_at: r.completed_at,
  cancelled_by: r.cancelled_by, cancelled_at: r.cancelled_at, applied_by: r.applied_by, applied_at: r.applied_at,
  applied_fields: r.applied_fields, document_id: r.document_id, template_id: r.template_id,
  reviewed_at: r.reviewed_at || null, reviewed_by: r.reviewed_by || null,
  // Completed and not yet reviewed (only once the review columns exist).
  needs_review: r.status === 'completed' && r.reviewed_at === null,
});

async function patientRow(db, id) {
  return (await db.query('SELECT * FROM "Patients" WHERE id=$1', [id])).rows[0] || null;
}

async function handle({ path, method, qs, body, db, currentUser }) {
  if (!path.startsWith('/power-forms')) return null;
  if (!canManage(currentUser)) return json(403, { error: 'Power Forms are only open to Reception, Admins and Developers.' });
  const b = body || {};

  if (path === '/power-forms/setup' && method === 'GET') {
    return json(200, {
      available: await hasTables(db), types: pf.TYPES,
      chart_fields: Object.fromEntries(Object.entries(pf.CHART_FIELDS).map(([k, v]) => [k, { label: v.label, types: v.types }])),
      days: DAYS, can_build: canAdminister(currentUser),
    });
  }
  if (!(await hasTables(db))) return json(409, { error: MIGRATION });

  // ---- Templates ----
  if (path === '/power-forms/templates' && method === 'GET') {
    const all = qs.all === '1' && canAdminister(currentUser);
    const rows = (await db.query(`SELECT * FROM "PowerFormTemplates" ${all ? '' : 'WHERE NOT archived'} ORDER BY archived, lower(name)`)).rows;
    return json(200, rows);
  }
  if (path === '/power-forms/templates' && method === 'POST') {
    if (!canAdminister(currentUser)) return json(403, { error: 'Only Admins and Developers can build forms.' });
    const c = pf.cleanTemplate(b);
    if (c.error) return json(400, { error: c.error });
    const row = (await db.query(
      `INSERT INTO "PowerFormTemplates" (name, intro, fields, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
      [c.values.name, c.values.intro, JSON.stringify(c.values.fields), currentUser.username]
    )).rows[0];
    return json(201, row);
  }
  const tm = path.match(/^\/power-forms\/templates\/(\d+)$/);
  if (tm && method === 'PUT') {
    if (!canAdminister(currentUser)) return json(403, { error: 'Only Admins and Developers can build forms.' });
    const c = pf.cleanTemplate(b);
    if (c.error) return json(400, { error: c.error });
    const row = (await db.query(
      `UPDATE "PowerFormTemplates" SET name=$1, intro=$2, fields=$3, updated_by=$4, updated_at=now() WHERE id=$5 RETURNING *`,
      [c.values.name, c.values.intro, JSON.stringify(c.values.fields), currentUser.username, Number(tm[1])]
    )).rows[0];
    return row ? json(200, row) : json(404, { error: 'Form not found.' });
  }
  const am = path.match(/^\/power-forms\/templates\/(\d+)\/archive$/);
  if (am && method === 'POST') {
    if (!canAdminister(currentUser)) return json(403, { error: 'Only Admins and Developers can build forms.' });
    const row = (await db.query(
      'UPDATE "PowerFormTemplates" SET archived=$1, updated_by=$2, updated_at=now() WHERE id=$3 RETURNING *',
      [!!b.archived, currentUser.username, Number(am[1])]
    )).rows[0];
    return row ? json(200, row) : json(404, { error: 'Form not found.' });
  }

  // ---- Sent forms ----
  const pm = path.match(/^\/power-forms\/patient\/([^/]+)$/);
  if (pm && method === 'GET') {
    const rows = (await db.query('SELECT * FROM "PowerFormRequests" WHERE patient_id=$1 ORDER BY created_at DESC', [pm[1]])).rows;
    return json(200, rows.map(summaryOf));
  }

  if (path === '/power-forms/requests' && method === 'POST') {
    const patient = await patientRow(db, b.patient_id);
    if (!patient) return json(404, { error: 'Patient not found.' });
    // The parent unlocks the form with the child's date of birth.
    if (!patient.Date_of_Birth) return json(400, { error: "Add the child's date of birth to their chart first: parents enter it to open the form." });
    const template = (await db.query('SELECT * FROM "PowerFormTemplates" WHERE id=$1 AND NOT archived', [Number(b.template_id)])).rows[0];
    if (!template) return json(400, { error: 'Choose a form to send.' });
    const days = DAYS.includes(Number(b.days)) ? Number(b.days) : 7;
    const token = pf.newToken();
    const row = (await db.query(
      `INSERT INTO "PowerFormRequests" (token_hash, patient_id, template_id, form_name, intro, fields, recipient, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8::text || ' days')::interval, $9) RETURNING *`,
      [pf.hashToken(token), patient.id, template.id, template.name, template.intro, JSON.stringify(template.fields),
        String(b.recipient || '').trim().slice(0, 120) || null, String(days), currentUser.username]
    )).rows[0];
    return json(201, { request: summaryOf(row), token });
  }

  const rm = path.match(/^\/power-forms\/requests\/(\d+)(?:\/([a-z-]+))?$/);
  if (!rm) return null;
  const id = Number(rm[1]);
  const action = rm[2] || null;
  const r = (await db.query('SELECT * FROM "PowerFormRequests" WHERE id=$1', [id])).rows[0];
  if (!r) return json(404, { error: 'Form not found.' });

  if (!action && method === 'GET') {
    const patient = await patientRow(db, r.patient_id);
    const answers = r.answers || {};
    return json(200, {
      ...summaryOf(r), intro: r.intro, fields: r.fields, answers, signer_ip: r.submitted_ip,
      patient_name: patient ? patient.Name : null,
      changes: r.status === 'completed' && patient ? pf.chartChanges(r.fields, answers, patient) : [],
    });
  }

  if (action === 'new-link' && method === 'POST') {
    if (r.status === 'completed') return json(400, { error: 'This form is already filled in.' });
    const days = DAYS.includes(Number(b.days)) ? Number(b.days) : 7;
    const token = pf.newToken();
    const row = (await db.query(
      `UPDATE "PowerFormRequests" SET token_hash=$1, status=CASE WHEN status='cancelled' THEN 'sent' ELSE status END,
         expires_at=now() + ($2::text || ' days')::interval, failed_checks=0, locked_until=NULL, cancelled_by=NULL, cancelled_at=NULL
       WHERE id=$3 RETURNING *`,
      [pf.hashToken(token), String(days), id]
    )).rows[0];
    return json(200, { request: summaryOf(row), token });
  }

  if (action === 'cancel' && method === 'POST') {
    if (r.status === 'completed') return json(400, { error: 'This form is already filled in.' });
    const row = (await db.query(
      `UPDATE "PowerFormRequests" SET status='cancelled', cancelled_by=$1, cancelled_at=now() WHERE id=$2 RETURNING *`,
      [currentUser.username, id]
    )).rows[0];
    return json(200, summaryOf(row));
  }

  if (action === 'apply' && method === 'POST') {
    if (r.status !== 'completed') return json(400, { error: 'The form hasn\'t been filled in yet.' });
    const patient = await patientRow(db, r.patient_id);
    if (!patient) return json(404, { error: 'Patient not found.' });
    const wanted = new Set(Array.isArray(b.fields) ? b.fields.map(String) : []);
    const changes = pf.chartChanges(r.fields, r.answers || {}, patient).filter(c => wanted.has(c.key));
    if (!changes.length) return json(400, { error: 'Tick at least one change to apply.' });
    // Allergies / Immunizations only once their columns exist.
    const cols = new Set((await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'Patients'`)).rows.map(x => x.column_name));
    const usable = changes.filter(c => cols.has(c.key));
    if (!usable.length) return json(400, { error: 'Those chart fields aren\'t available yet.' });
    await db.query(
      `UPDATE "Patients" SET ${usable.map((c, i) => `"${c.key}"=$${i + 1}`).join(', ')} WHERE id=$${usable.length + 1}`,
      [...usable.map(c => c.to), patient.id]
    );
    const applied = [...new Set([...(r.applied_fields || []), ...usable.map(c => c.key)])];
    const row = (await db.query(
      'UPDATE "PowerFormRequests" SET applied_by=$1, applied_at=now(), applied_fields=$2 WHERE id=$3 RETURNING *',
      [currentUser.username, JSON.stringify(applied), id]
    )).rows[0];
    await markReviewed(db, id, currentUser.username);
    const after = (await db.query('SELECT * FROM "PowerFormRequests" WHERE id=$1', [id])).rows[0];
    return json(200, { request: summaryOf(after || row), applied: usable.map(c => c.key) });
  }

  if (action === 'review' && method === 'POST') {
    if (r.status !== 'completed') return json(400, { error: 'The form hasn\'t been filled in yet.' });
    if (!(await hasReview(db))) return json(409, { error: 'Marking forms reviewed needs the 2026-10-28 database update. Ask an admin to run it.' });
    await markReviewed(db, id, currentUser.username);
    return json(200, summaryOf((await db.query('SELECT * FROM "PowerFormRequests" WHERE id=$1', [id])).rows[0]));
  }

  if (action === 'document' && method === 'POST') {
    const docId = String(b.document_id || '').slice(0, 64);
    if (!docId) return json(400, { error: 'Missing document.' });
    const row = (await db.query('UPDATE "PowerFormRequests" SET document_id=$1 WHERE id=$2 RETURNING *', [docId, id])).rows[0];
    return json(200, summaryOf(row));
  }
  return null;
}

// ---------- Public: the parent's side ----------
const accessSecret = () => `${process.env.JWT_SECRET}:power-forms`;
const NOT_VALID = "This link isn't valid. Ask Kidz Lounge to send you a new one.";

async function findByToken(db, token) {
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(String(token || ''))) return null;
  return (await db.query('SELECT * FROM "PowerFormRequests" WHERE token_hash=$1', [pf.hashToken(token)])).rows[0] || null;
}
// Whether a link can be used right now: null, or { status, body }.
function blocked(r) {
  if (!r) return { status: 404, body: { error: NOT_VALID } };
  const s = statusOf(r);
  if (s === 'completed') return { status: 200, body: { status: 'completed', form_name: r.form_name } };
  if (s === 'cancelled') return { status: 410, body: { status: 'cancelled', error: 'This form is no longer needed. If you think that\'s a mistake, contact Kidz Lounge.' } };
  if (s === 'expired') return { status: 410, body: { status: 'expired', error: 'This link has expired. Ask Kidz Lounge to send you a new one.' } };
  if (r.locked_until && new Date(r.locked_until) > new Date()) {
    const mins = Math.max(1, Math.ceil((new Date(r.locked_until) - new Date()) / 60000));
    return { status: 429, body: { status: 'locked', error: `Too many tries. Please try again in ${mins} minute${mins === 1 ? '' : 's'}.` } };
  }
  return null;
}

async function handlePublic({ path, method, body, db, meta }) {
  const m = path.match(/^\/forms\/([^/]+)(?:\/(unlock|submit))?$/);
  if (!m) return null;
  if (!(await hasTables(db))) return json(404, { error: NOT_VALID });
  const r = await findByToken(db, m[1]);
  const stop = blocked(r);
  if (stop) return json(stop.status, stop.body);
  const b = body || {};

  if (!m[2] && method === 'GET') {
    return json(200, { status: 'ready', form_name: r.form_name });
  }

  if (m[2] === 'unlock' && method === 'POST') {
    const dob = String(b.dob || '').slice(0, 10);
    const patient = (await db.query('SELECT "Name", "Date_of_Birth" FROM "Patients" WHERE id=$1', [r.patient_id])).rows[0];
    const real = patient && patient.Date_of_Birth ? String(patient.Date_of_Birth).slice(0, 10) : null;
    if (!real || dob !== real) {
      // The 5th wrong try in a row locks the link for 30 minutes and starts the count again.
      const fails = r.failed_checks + 1;
      const lock = fails >= MAX_FAILS;
      await db.query(
        `UPDATE "PowerFormRequests" SET failed_checks=$1::int,
           locked_until=CASE WHEN $2::boolean THEN now() + ($3::text || ' minutes')::interval ELSE locked_until END
         WHERE id=$4`,
        [lock ? 0 : fails, lock, String(LOCK_MINUTES), r.id]
      );
      if (fails >= MAX_FAILS) return json(429, { status: 'locked', error: `Too many tries. Please try again in ${LOCK_MINUTES} minutes.` });
      return json(400, { error: "That date of birth doesn't match our records. Please check it and try again." });
    }
    await db.query(
      `UPDATE "PowerFormRequests" SET failed_checks=0, opened_at=COALESCE(opened_at, now()), status=CASE WHEN status='sent' THEN 'opened' ELSE status END WHERE id=$1`,
      [r.id]
    );
    const access = jwt.sign({ rid: r.id }, accessSecret(), { expiresIn: '2h' });
    return json(200, {
      access, form_name: r.form_name, intro: r.intro, fields: r.fields,
      child_first_name: String(patient.Name || '').trim().split(/\s+/)[0] || null,
    });
  }

  if (m[2] === 'submit' && method === 'POST') {
    let claims = null;
    try { claims = jwt.verify(String(b.access || ''), accessSecret()); } catch { claims = null; }
    if (!claims || claims.rid !== r.id) return json(401, { error: 'Your session ran out. Reload the page and enter the date of birth again.' });
    const c = pf.cleanAnswers(r.fields, b.answers);
    if (c.error) return json(400, { error: c.error, field: c.field });
    const done = (await db.query(
      `UPDATE "PowerFormRequests" SET answers=$1, status='completed', completed_at=now(), submitted_ip=$2
       WHERE id=$3 AND status IN ('sent', 'opened') RETURNING id`,
      [JSON.stringify(c.answers), meta.ip || null, r.id]
    )).rows[0];
    if (!done) return json(409, { error: 'This form was already submitted.' });
    // A review task for every active Reception and Admin (never Developers,
    // like the other patient tasks). Never blocks the parent's submission.
    try {
      const patient = (await db.query('SELECT "Name" FROM "Patients" WHERE id=$1', [r.patient_id])).rows[0];
      const staff = (await db.query('SELECT username FROM "Staff" WHERE archived=false AND role = ANY($1)', [PATIENT_TASK_FALLBACK_ROLES])).rows;
      for (const s of staff) {
        await db.query(
          `INSERT INTO "Tasks" (title, description, assigned_to, assigned_by, status, is_automated, related_patient_id, deadline_type, deadline_date, due_date)
           VALUES ($1, $2, $3, 'system', 'open', true, $4, $5, CURRENT_DATE, CURRENT_DATE)`,
          [`Review Power Form: ${r.form_name}`, `${patient ? patient.Name : 'A patient'}'s family completed "${r.form_name}". Open their chart, Power Forms, to review it.`,
            s.username, r.patient_id, taskKey(r.id)]
        );
      }
    } catch (err) {
      console.error('Power Form review tasks not created', err);
    }
    // HIPAA audit log: a submission from outside (no staff account).
    await audit.record(db, {
      username: null, role: 'parent', action: 'create', resource: 'Power Form submission', patientId: r.patient_id,
      recordId: r.id, method, path: '/forms/:token/submit', status: 200, ip: meta.ip, userAgent: meta.userAgent,
      details: { form: r.form_name, fields: Object.keys(c.answers).length },
    });
    return json(200, { status: 'completed' });
  }
  return null;
}

module.exports = { handle, handlePublic, statusOf };
