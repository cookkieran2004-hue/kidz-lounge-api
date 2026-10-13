const jwt = require('jsonwebtoken');
const { json } = require('../lib/http');
const { canManage, canAdminister } = require('../lib/roles');
const audit = require('../lib/audit');
const pf = require('../lib/powerForms');
const { deleteDocument } = require('./documents');
const { PATIENT_TASK_FALLBACK_ROLES } = require('../lib/roles');

// Power Forms (Kieran, Oct 2026; migrations/2026-10-27_power_forms.sql).
// Staff (signed in):
//   GET  /power-forms/setup                     field types + chart fields (builder)
//   GET  /power-forms/templates                 Reception, Admins, Developers (?all=1: archived too)
//   POST /power-forms/templates                 Admins and Developers build them
//   PUT  /power-forms/templates/:id
//   POST /power-forms/templates/:id/archive     { archived }
//   GET  /power-forms/patient/:patientId        forms sent for a patient
//   GET  /power-forms/packages                  packages of forms (?all=1: archived too)
//   POST /power-forms/packages                  { name, template_ids } Admins and Developers
//   PUT  /power-forms/packages/:id
//   POST /power-forms/packages/:id/archive      { archived }
//   POST /power-forms/requests                  { patient_id, template_ids (or template_id), package_id, recipient, days }
//                                               -> the link's token (once). Several forms = one link for all of them
//                                               (a "packet", migrations/2026-10-29_power_form_packages.sql).
//   POST /power-forms/requests/:id/new-link     a fresh link (the old one stops working)
//   POST /power-forms/requests/:id/cancel       removes a form not filled in yet
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
//   POST /forms/:token/submit                   { access, answers, request_id (a form in a packet) }
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
let packetsReady = false;
async function hasPackets(db) {
  if (packetsReady) return true;
  const r = await db.query(`SELECT to_regclass('"PowerFormPackets"') AS t`);
  if (r.rows[0]?.t) packetsReady = true;
  return packetsReady;
}
const PACKAGES_MIGRATION = 'Packages need the 2026-10-29 database update. Ask an admin to run it.';

const taskKey = (id) => `power_form_${id}`;
const packetTaskKey = (id) => `power_packet_${id}`;
// A packet's review task closes once none of its completed forms needs review.
async function closePacketTask(db, packetId) {
  if (!packetId) return;
  const left = (await db.query(
    `SELECT count(*)::int AS n FROM "PowerFormRequests" WHERE packet_id=$1 AND status='completed' AND reviewed_at IS NULL`, [packetId]
  ).catch(() => ({ rows: [{ n: 1 }] }))).rows[0].n;
  if (!left) await db.query(`UPDATE "Tasks" SET status='done', completed_at=now() WHERE deadline_type=$1 AND status <> 'done'`, [packetTaskKey(packetId)]).catch(() => {});
}
// Done reviewing: the form is marked, and everyone's review task completes.
async function markReviewed(db, id, username) {
  if (!(await hasReview(db))) return;
  await db.query('UPDATE "PowerFormRequests" SET reviewed_at=COALESCE(reviewed_at, now()), reviewed_by=COALESCE(reviewed_by, $1) WHERE id=$2', [username, id]);
  await db.query(`UPDATE "Tasks" SET status='done', completed_at=now() WHERE deadline_type=$1 AND status <> 'done'`, [taskKey(id)]).catch(() => {});
  const r = (await db.query('SELECT packet_id FROM "PowerFormRequests" WHERE id=$1', [id]).catch(() => ({ rows: [] }))).rows[0];
  if (r?.packet_id) await closePacketTask(db, r.packet_id);
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
  packet_id: r.packet_id || null, packet_name: r.packet_name || null,
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
      prefill: pf.PREFILL,
      days: DAYS, can_build: canAdminister(currentUser), packages_available: await hasPackets(db),
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

  // ---- Packages ----
  if (path.startsWith('/power-forms/packages')) {
    if (!(await hasPackets(db))) return method === 'GET' ? json(200, []) : json(409, { error: PACKAGES_MIGRATION });
    if (path === '/power-forms/packages' && method === 'GET') {
      const all = qs.all === '1' && canAdminister(currentUser);
      return json(200, (await db.query(`SELECT * FROM "PowerFormPackages" ${all ? '' : 'WHERE NOT archived'} ORDER BY archived, lower(name)`)).rows);
    }
    if (!canAdminister(currentUser)) return json(403, { error: 'Only Admins and Developers can build packages.' });
    const xm = path.match(/^\/power-forms\/packages\/(\d+)\/archive$/);
    if (xm && method === 'POST') {
      const row = (await db.query('UPDATE "PowerFormPackages" SET archived=$1, updated_by=$2, updated_at=now() WHERE id=$3 RETURNING *',
        [!!b.archived, currentUser.username, Number(xm[1])])).rows[0];
      return row ? json(200, row) : json(404, { error: 'Package not found.' });
    }
    const km = path.match(/^\/power-forms\/packages(?:\/(\d+))?$/);
    if (km && (method === 'POST' || method === 'PUT')) {
      const name = String(b.name || '').trim().slice(0, 120);
      if (!name) return json(400, { error: 'Give the package a name.' });
      const wanted = [...new Set((Array.isArray(b.template_ids) ? b.template_ids : []).map(Number).filter(Boolean))];
      const found = new Set((await db.query('SELECT id FROM "PowerFormTemplates" WHERE id = ANY($1::int[])', [wanted])).rows.map(r => r.id));
      const ids = wanted.filter(id => found.has(id));
      if (ids.length < 2) return json(400, { error: 'Pick at least two forms for a package.' });
      const row = method === 'POST'
        ? (await db.query('INSERT INTO "PowerFormPackages" (name, template_ids, created_by) VALUES ($1, $2, $3) RETURNING *', [name, JSON.stringify(ids), currentUser.username])).rows[0]
        : (await db.query('UPDATE "PowerFormPackages" SET name=$1, template_ids=$2, updated_by=$3, updated_at=now() WHERE id=$4 RETURNING *', [name, JSON.stringify(ids), currentUser.username, Number(km[1])])).rows[0];
      return row ? json(method === 'POST' ? 201 : 200, row) : json(404, { error: 'Package not found.' });
    }
    return null;
  }

  // ---- Sent forms ----
  const pm = path.match(/^\/power-forms\/patient\/([^/]+)$/);
  if (pm && method === 'GET') {
    const rows = (await db.query(await hasPackets(db)
      ? 'SELECT r.*, k.name AS packet_name FROM "PowerFormRequests" r LEFT JOIN "PowerFormPackets" k ON k.id = r.packet_id WHERE r.patient_id=$1 ORDER BY r.created_at DESC, r.id'
      : 'SELECT * FROM "PowerFormRequests" WHERE patient_id=$1 ORDER BY created_at DESC', [pm[1]])).rows;
    return json(200, rows.map(summaryOf));
  }

  if (path === '/power-forms/requests' && method === 'POST') {
    const patient = await patientRow(db, b.patient_id);
    if (!patient) return json(404, { error: 'Patient not found.' });
    // The parent unlocks the form with the child's date of birth.
    if (!patient.Date_of_Birth) return json(400, { error: "Add the child's date of birth to their chart first: parents enter it to open the form." });
    const wanted = [...new Set((Array.isArray(b.template_ids) ? b.template_ids : [b.template_id]).map(Number).filter(Boolean))];
    const byId = new Map((await db.query('SELECT * FROM "PowerFormTemplates" WHERE id = ANY($1::int[]) AND NOT archived', [wanted])).rows.map(t => [t.id, t]));
    const templates = wanted.map(id => byId.get(id)).filter(Boolean);
    if (!templates.length) return json(400, { error: 'Choose a form to send.' });
    const days = DAYS.includes(Number(b.days)) ? Number(b.days) : 7;
    const token = pf.newToken();
    const recipient = String(b.recipient || '').trim().slice(0, 120) || null;
    // Several forms: one link (a packet) opens all of them.
    if (templates.length > 1) {
      if (!(await hasPackets(db))) return json(409, { error: PACKAGES_MIGRATION });
      const pkg = b.package_id ? (await db.query('SELECT * FROM "PowerFormPackages" WHERE id=$1', [Number(b.package_id)])).rows[0] : null;
      const packet = (await db.query(
        `INSERT INTO "PowerFormPackets" (token_hash, patient_id, package_id, name, recipient, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, now() + ($6::text || ' days')::interval, $7) RETURNING *`,
        [pf.hashToken(token), patient.id, pkg ? pkg.id : null, pkg ? pkg.name : 'Forms', recipient, String(days), currentUser.username]
      )).rows[0];
      const rows = [];
      for (const t of templates) {
        rows.push((await db.query(
          `INSERT INTO "PowerFormRequests" (token_hash, patient_id, template_id, form_name, intro, fields, recipient, expires_at, created_by, packet_id)
           VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [patient.id, t.id, t.name, t.intro, JSON.stringify(t.fields), recipient, packet.expires_at, currentUser.username, packet.id]
        )).rows[0]);
      }
      return json(201, { request: summaryOf(rows[0]), requests: rows.map(r => summaryOf({ ...r, packet_name: packet.name })), packet: { id: packet.id, name: packet.name }, token });
    }
    const template = templates[0];
    const row = (await db.query(
      `INSERT INTO "PowerFormRequests" (token_hash, patient_id, template_id, form_name, intro, fields, recipient, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8::text || ' days')::interval, $9) RETURNING *`,
      [pf.hashToken(token), patient.id, template.id, template.name, template.intro, JSON.stringify(template.fields),
        recipient, String(days), currentUser.username]
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

  // Delete a form for good (Admins and Developers; Kieran, Oct 2026): its
  // answers, its PDF in the patient's Documents, and any review tasks still
  // open. Changes already applied to the chart stay. The audit log keeps
  // who deleted it.
  if (!action && method === 'DELETE') {
    if (!canAdminister(currentUser)) return json(403, { error: 'Only Admins and Developers can delete forms.' });
    if (r.document_id) {
      const doc = (await db.query('SELECT id FROM "PatientDocuments" WHERE id::text=$1 AND patient_id::text=$2', [String(r.document_id), String(r.patient_id)])).rows[0];
      if (doc) await deleteDocument(db, doc.id);
    }
    await db.query(`DELETE FROM "Tasks" WHERE deadline_type=$1 AND status <> 'done'`, [taskKey(id)]).catch(() => {});
    await db.query('DELETE FROM "PowerFormRequests" WHERE id=$1', [id]);
    if (r.packet_id) {
      await closePacketTask(db, r.packet_id);
      // The last form of a packet gone: its link goes too.
      await db.query('DELETE FROM "PowerFormPackets" WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM "PowerFormRequests" WHERE packet_id=$1)', [r.packet_id]);
    }
    return json(200, { deleted: true });
  }

  if (action === 'new-link' && method === 'POST') {
    if (r.status === 'completed') return json(400, { error: 'This form is already filled in.' });
    const days = DAYS.includes(Number(b.days)) ? Number(b.days) : 7;
    const token = pf.newToken();
    // A form in a packet: the packet gets the new link, and its forms still
    // to fill in (plus this one, if it was cancelled) work again until then.
    if (r.packet_id) {
      const packet = (await db.query(
        `UPDATE "PowerFormPackets" SET token_hash=$1, expires_at=now() + ($2::text || ' days')::interval, failed_checks=0, locked_until=NULL
         WHERE id=$3 RETURNING *`, [pf.hashToken(token), String(days), r.packet_id]
      )).rows[0];
      await db.query(
        `UPDATE "PowerFormRequests" SET expires_at=$1, status=CASE WHEN status='cancelled' THEN 'sent' ELSE status END, cancelled_by=NULL, cancelled_at=NULL
         WHERE packet_id=$2 AND status <> 'completed' AND (status <> 'cancelled' OR id=$3)`, [packet.expires_at, packet.id, id]
      );
      const row = (await db.query('SELECT * FROM "PowerFormRequests" WHERE id=$1', [id])).rows[0];
      return json(200, { request: summaryOf({ ...row, packet_name: packet.name }), token });
    }
    const row = (await db.query(
      `UPDATE "PowerFormRequests" SET token_hash=$1, status=CASE WHEN status='cancelled' THEN 'sent' ELSE status END,
         expires_at=now() + ($2::text || ' days')::interval, failed_checks=0, locked_until=NULL, cancelled_by=NULL, cancelled_at=NULL
       WHERE id=$3 RETURNING *`,
      [pf.hashToken(token), String(days), id]
    )).rows[0];
    return json(200, { request: summaryOf(row), token });
  }

  // Cancelling a form not filled in yet removes it from the chart (Kieran,
  // Oct 2026: "no need to keep"); its link stops working. The audit log
  // keeps the record of it.
  if (action === 'cancel' && method === 'POST') {
    if (r.status === 'completed') return json(400, { error: 'This form is already filled in.' });
    await db.query('DELETE FROM "PowerFormRequests" WHERE id=$1', [id]);
    if (r.packet_id) {
      await closePacketTask(db, r.packet_id);
      await db.query('DELETE FROM "PowerFormPackets" WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM "PowerFormRequests" WHERE packet_id=$1)', [r.packet_id]);
    }
    return json(200, { deleted: true });
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

// A link is either one form (PowerFormRequests.token_hash) or a packet of
// forms (PowerFormPackets.token_hash). -> { kind: 'form', link: request }
// or { kind: 'packet', link: packet, forms: its forms (not cancelled) }.
async function findByToken(db, token) {
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(String(token || ''))) return null;
  const hash = pf.hashToken(token);
  const r = (await db.query('SELECT * FROM "PowerFormRequests" WHERE token_hash=$1', [hash])).rows[0];
  if (r) return { kind: 'form', link: r };
  if (!(await hasPackets(db))) return null;
  const k = (await db.query('SELECT * FROM "PowerFormPackets" WHERE token_hash=$1', [hash])).rows[0];
  if (!k) return null;
  const forms = (await db.query(`SELECT * FROM "PowerFormRequests" WHERE packet_id=$1 AND status <> 'cancelled' ORDER BY id`, [k.id])).rows;
  return { kind: 'packet', link: k, forms };
}
// Whether a link can be used right now: null, or { status, body }.
function blocked(found) {
  if (!found) return { status: 404, body: { error: NOT_VALID } };
  const { link } = found;
  const name = found.kind === 'packet' ? link.name : link.form_name;
  let s;
  if (found.kind === 'packet') {
    if (!found.forms.length) s = 'cancelled';
    else if (found.forms.every(f => f.status === 'completed')) s = 'completed';
    else s = new Date(link.expires_at) < new Date() ? 'expired' : 'open';
  } else {
    s = statusOf(link);
  }
  if (s === 'completed') return { status: 200, body: { status: 'completed', form_name: name } };
  if (s === 'cancelled') return { status: 410, body: { status: 'cancelled', error: 'This form is no longer needed. If you think that\'s a mistake, contact Kidz Lounge.' } };
  if (s === 'expired') return { status: 410, body: { status: 'expired', error: 'This link has expired. Ask Kidz Lounge to send you a new one.' } };
  if (link.locked_until && new Date(link.locked_until) > new Date()) {
    const mins = Math.max(1, Math.ceil((new Date(link.locked_until) - new Date()) / 60000));
    return { status: 429, body: { status: 'locked', error: `Too many tries. Please try again in ${mins} minute${mins === 1 ? '' : 's'}.` } };
  }
  return null;
}

// A parent's answers saved: the form is completed, staff get a review task
// (one per packet, not one per form), and the audit log records it.
async function complete(db, r, answers, meta, method) {
  const done = (await db.query(
    `UPDATE "PowerFormRequests" SET answers=$1, status='completed', completed_at=now(), submitted_ip=$2
     WHERE id=$3 AND status IN ('sent', 'opened') RETURNING id`,
    [JSON.stringify(answers), meta.ip || null, r.id]
  )).rows[0];
  if (!done) return false;
  // A review task for every active Reception and Admin (never Developers,
  // like the other patient tasks). Never blocks the parent's submission.
  try {
    const patient = (await db.query('SELECT "Name" FROM "Patients" WHERE id=$1', [r.patient_id])).rows[0];
    const who = patient ? patient.Name : 'A patient';
    const packet = r.packet_id ? (await db.query('SELECT name FROM "PowerFormPackets" WHERE id=$1', [r.packet_id])).rows[0] : null;
    const key = packet ? packetTaskKey(r.packet_id) : taskKey(r.id);
    const title = packet ? `Review Power Forms: ${packet.name}` : `Review Power Form: ${r.form_name}`;
    const description = packet
      ? `${who}'s family is filling in "${packet.name}". Open their chart, Power Forms, to review the completed forms.`
      : `${who}'s family completed "${r.form_name}". Open their chart, Power Forms, to review it.`;
    const staff = (await db.query('SELECT username FROM "Staff" WHERE archived=false AND role = ANY($1)', [PATIENT_TASK_FALLBACK_ROLES])).rows;
    for (const s of staff) {
      // A packet's task is made once (while it's open), not for every form.
      if (packet && (await db.query(`SELECT 1 FROM "Tasks" WHERE deadline_type=$1 AND assigned_to=$2 AND status <> 'done'`, [key, s.username])).rows.length) continue;
      await db.query(
        `INSERT INTO "Tasks" (title, description, assigned_to, assigned_by, status, is_automated, related_patient_id, deadline_type, deadline_date, due_date)
         VALUES ($1, $2, $3, 'system', 'open', true, $4, $5, CURRENT_DATE, CURRENT_DATE)`,
        [title, description, s.username, r.patient_id, key]
      );
    }
  } catch (err) {
    console.error('Power Form review tasks not created', err);
  }
  // HIPAA audit log: a submission from outside (no staff account).
  await audit.record(db, {
    username: null, role: 'parent', action: 'create', resource: 'Power Form submission', patientId: r.patient_id,
    recordId: r.id, method, path: '/forms/:token/submit', status: 200, ip: meta.ip, userAgent: meta.userAgent,
    details: { form: r.form_name, fields: Object.keys(answers).length },
  });
  return true;
}

async function handlePublic({ path, method, body, db, meta }) {
  const m = path.match(/^\/forms\/([^/]+)(?:\/(unlock|submit))?$/);
  if (!m) return null;
  if (!(await hasTables(db))) return json(404, { error: NOT_VALID });
  const found = await findByToken(db, m[1]);
  const stop = blocked(found);
  if (stop) return json(stop.status, stop.body);
  const { kind, link } = found;
  const table = kind === 'packet' ? '"PowerFormPackets"' : '"PowerFormRequests"';
  const b = body || {};

  if (!m[2] && method === 'GET') {
    return json(200, kind === 'packet'
      ? { status: 'ready', form_name: link.name, packet: true, count: found.forms.length }
      : { status: 'ready', form_name: link.form_name });
  }

  if (m[2] === 'unlock' && method === 'POST') {
    const dob = String(b.dob || '').slice(0, 10);
    const patient = (await db.query('SELECT * FROM "Patients" WHERE id=$1', [link.patient_id])).rows[0];
    const real = patient && patient.Date_of_Birth ? String(patient.Date_of_Birth).slice(0, 10) : null;
    if (!real || dob !== real) {
      // The 5th wrong try in a row locks the link for 30 minutes and starts the count again.
      const fails = link.failed_checks + 1;
      const lock = fails >= MAX_FAILS;
      await db.query(
        `UPDATE ${table} SET failed_checks=$1::int,
           locked_until=CASE WHEN $2::boolean THEN now() + ($3::text || ' minutes')::interval ELSE locked_until END
         WHERE id=$4`,
        [lock ? 0 : fails, lock, String(LOCK_MINUTES), link.id]
      );
      if (fails >= MAX_FAILS) return json(429, { status: 'locked', error: `Too many tries. Please try again in ${LOCK_MINUTES} minutes.` });
      return json(400, { error: "That date of birth doesn't match our records. Please check it and try again." });
    }
    const child_first_name = String(patient.Name || '').trim().split(/\s+/)[0] || null;
    // The form is labelled with who it's for, like a chart label, and the
    // patient's saved details are filled in (only now the DOB matched).
    const label = { name: patient.Name, dob: real, mrn: patient.mrn || null };
    const fill = (fields) => pf.withPatient(fields, patient);
    if (kind === 'packet') {
      await db.query('UPDATE "PowerFormPackets" SET failed_checks=0, opened_at=COALESCE(opened_at, now()) WHERE id=$1', [link.id]);
      await db.query(`UPDATE "PowerFormRequests" SET opened_at=COALESCE(opened_at, now()), status='opened' WHERE packet_id=$1 AND status='sent'`, [link.id]);
      const access = jwt.sign({ pid: link.id }, accessSecret(), { expiresIn: '2h' });
      return json(200, {
        access, packet: true, form_name: link.name, child_first_name, label,
        forms: found.forms.map(f => ({ id: f.id, form_name: f.form_name, intro: f.intro, fields: fill(f.fields), status: f.status === 'completed' ? 'completed' : 'open' })),
      });
    }
    await db.query(
      `UPDATE "PowerFormRequests" SET failed_checks=0, opened_at=COALESCE(opened_at, now()), status=CASE WHEN status='sent' THEN 'opened' ELSE status END WHERE id=$1`,
      [link.id]
    );
    const access = jwt.sign({ rid: link.id }, accessSecret(), { expiresIn: '2h' });
    return json(200, { access, form_name: link.form_name, intro: link.intro, fields: fill(link.fields), child_first_name, label });
  }

  if (m[2] === 'submit' && method === 'POST') {
    let claims = null;
    try { claims = jwt.verify(String(b.access || ''), accessSecret()); } catch { claims = null; }
    const ok = kind === 'packet' ? claims && claims.pid === link.id : claims && claims.rid === link.id;
    if (!ok) return json(401, { error: 'Your session ran out. Reload the page and enter the date of birth again.' });
    const r = kind === 'packet' ? found.forms.find(f => f.id === Number(b.request_id)) : link;
    if (!r) return json(404, { error: 'That form isn\'t part of this link.' });
    const c = pf.cleanAnswers(r.fields, b.answers);
    if (c.error) return json(400, { error: c.error, field: c.field });
    if (!(await complete(db, r, c.answers, meta, method))) return json(409, { error: 'This form was already submitted.' });
    const remaining = kind === 'packet' ? found.forms.filter(f => f.id !== r.id && f.status !== 'completed').length : 0;
    return json(200, { status: 'completed', remaining });
  }
  return null;
}

module.exports = { handle, handlePublic, statusOf };
