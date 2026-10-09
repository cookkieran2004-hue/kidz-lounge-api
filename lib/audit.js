// HIPAA audit log (migrations/2026-10-09_audit_log.sql).
//
// Kieran's choice (Oct 2026): record sign-ins and CHANGES only -- creates,
// edits, deletes and uploads of patient information. Views, searches and
// downloads are not recorded (RECORDED_ACTIONS below).
//
// index.js runs every signed-in request through here: describe() decides
// whether it touches patient information and what it is (a chart view, an
// appointment change, a document download...), resolvePatient() works out
// which patient BEFORE the route runs (so a delete can still be traced),
// and record() writes the entry with the response's status -- refused
// attempts (403) are logged too. Sign-ins are logged from lib/auth.js.
//
// Rules:
//   - Logging must never break the app: every write is wrapped, and a
//     failure only goes to CloudWatch.
//   - Never store the patient data itself: updates record WHICH fields
//     changed, not their values.
//   - The schedule and patient list poll in the background; the same
//     person viewing the same thing is logged once per 10 minutes per
//     running Lambda, not every 30 seconds.

let tableExists = false; // only a "yes" is remembered (see CLAUDE.md)
async function hasTable(db) {
  if (tableExists) return true;
  try {
    const r = await db.query(`SELECT to_regclass('"AuditLog"') IS NOT NULL AS ok`);
    tableExists = !!r.rows[0]?.ok;
  } catch {
    tableExists = false;
  }
  return tableExists;
}

const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const SECRET_FIELDS = new Set(['admin_password', 'password', 'new_password', 'temporary_password', 'reset_temporary_password']);
const changedFields = (body) => Object.keys(body || {}).filter(k => !SECRET_FIELDS.has(k));
const VERB = { GET: 'view', POST: 'create', PUT: 'update', DELETE: 'delete' };

// What a request is, or null when it doesn't involve patient information
// (time off, tasks, office hours...).
function describe(method, path, qs, body) {
  const p = path.split('/').filter(Boolean);
  const verb = VERB[method];
  if (!verb) return null;

  if (p[0] === 'patients') {
    if (p.length === 1) {
      return method === 'GET'
        ? { action: 'view', resource: 'patient list', details: { count: null } }
        : { action: 'create', resource: 'patient', patientName: body?.Name || null };
    }
    if (p[1] === 'search') return { action: 'search', resource: 'patient search', details: { query: qs.q || '' } };
    if (p[1] === 'alerts') return { action: 'view', resource: 'patient alerts' };
    if (p.length === 2) {
      // GET is by name (the chart); PUT and DELETE are by id.
      return method === 'GET'
        ? { action: 'view', resource: 'patient chart', patientName: decode(p[1]) }
        : { action: verb, resource: 'patient', patientId: p[1], details: method === 'PUT' ? { fields: changedFields(body) } : undefined };
    }
    if (p[2] === 'appointments') return { action: 'view', resource: 'patient appointments', patientName: decode(p[1]) };
    if (p[2] === 'documents' && p[3] === 'upload-url') return { action: 'upload', resource: 'document', patientId: p[1], details: { filename: body?.filename } };
    if (p[2] === 'documents') return { action: verb, resource: 'documents', patientId: p[1], details: method === 'POST' ? { filename: body?.filename } : undefined };
    if (p[2] === 'clinical-documents') return { action: verb, resource: 'clinical documents', patientId: p[1] };
    if (p[2] === 'programs') return { action: verb, resource: 'programs and mandates', patientId: p[1], details: p[3] ? { entry: p[3] } : undefined };
    return { action: verb, resource: 'patient', patientId: p[1] };
  }
  if (p[0] === 'documents' && p[1]) {
    return p[2] === 'download-url'
      ? { action: 'download', resource: 'document', docId: p[1] }
      : { action: verb, resource: 'document', docId: p[1] };
  }
  if (p[0] === 'clinical-documents' && p[1]) {
    return { action: verb, resource: 'clinical document', clinicalDocId: p[1], details: method === 'PUT' ? { fields: changedFields(body) } : undefined };
  }
  if (p[0] === 'appointments') {
    if (method === 'GET') {
      const scope = p[1] || 'day';
      return { action: 'view', resource: 'schedule', details: { scope, ...qs } };
    }
    if (p.length === 1) return { action: 'create', resource: 'appointment', patientName: body?.patient_name || null };
    const sub = p[2];
    return {
      action: sub === 'mark-deleted' ? 'delete' : sub === 'comments' ? 'update' : verb,
      resource: sub === 'comments' ? 'appointment comments' : 'appointment',
      appointmentId: p[1], patientName: body?.patient_name || null,
      details: method === 'PUT' && sub !== 'comments' ? { fields: changedFields(body) } : undefined,
    };
  }
  if (p[0] === 'recurring-series') {
    if (p.length === 1) return { action: 'create', resource: 'repeating appointment', patientName: body?.patient_name || null };
    return { action: p[2] === 'end' ? 'update' : verb, resource: 'repeating appointment', seriesId: p[1], patientName: body?.patient_name || null, details: { step: p[2] || null } };
  }
  // Ticking a session as entered in the state's EI-Hub (routes/billing.js).
  if (p[0] === 'billing' && p[1] === 'ei-hub' && p[2] === 'entered') {
    return { action: 'update', resource: 'EI-Hub entry', patientName: body?.patient_name || null, details: { session: body?.session_key || null, entered: !!body?.entered } };
  }
  // EI-Hub billing details (routes/eiHub.js): a child's sex, address, county
  // and diagnoses, and the referring provider on a service authorization.
  if (p[0] === 'ei-hub' && p[1] === 'children' && p[2] && method === 'PUT') {
    return { action: 'update', resource: 'EI billing details', patientId: p[2], details: { fields: changedFields(body) } };
  }
  if (p[0] === 'ei-hub' && p[1] === 'referrals' && p[2] && method === 'PUT') {
    return { action: 'update', resource: 'EI referring provider', details: { authorization: decode(p[2]) } };
  }
  if (p[0] === 'waitlist') {
    if (p.length === 1) {
      return method === 'GET'
        ? { action: 'view', resource: 'waitlist', details: { view: qs.view || 'active', ...(qs.patient ? { patient: qs.patient } : {}) } }
        : { action: 'create', resource: 'waitlist entry', patientId: body?.patient_id || null, details: { specialties: body?.specialties } };
    }
    return { action: verb, resource: 'waitlist entry', waitlistId: p[1], details: method === 'PUT' ? { fields: changedFields(body) } : undefined };
  }
  return null;
}

async function one(db, sql, params) {
  try { return (await db.query(sql, params)).rows[0] || null; } catch { return null; }
}

// Fills in patient_id / patient_name / record_id. Runs before the route,
// so a deleted appointment or document can still be traced to its patient.
async function resolvePatient(db, d) {
  const out = { ...d };
  if (d.docId) {
    out.recordId = d.docId;
    const r = await one(db, `SELECT p.id, p."Name" FROM "PatientDocuments" x JOIN "Patients" p ON p.id = x.patient_id WHERE x.id::text = $1`, [d.docId]);
    if (r) { out.patientId = r.id; out.patientName = r.Name; }
  } else if (d.clinicalDocId) {
    out.recordId = d.clinicalDocId;
    const r = await one(db, `SELECT p.id, p."Name" FROM "ClinicalDocuments" x JOIN "Patients" p ON p.id = x.patient_id WHERE x.id::text = $1`, [d.clinicalDocId]);
    if (r) { out.patientId = r.id; out.patientName = r.Name; }
  } else if (d.appointmentId) {
    out.recordId = d.appointmentId;
    if (!out.patientName) {
      const r = await one(db, `SELECT patient_name FROM "Appointments" WHERE id::text = $1`, [d.appointmentId]);
      if (r) out.patientName = r.patient_name;
    }
  } else if (d.seriesId) {
    out.recordId = d.seriesId;
    if (!out.patientName) {
      const r = await one(db, `SELECT patient_name FROM "RecurringSeries" WHERE id::text = $1`, [d.seriesId]);
      if (r) out.patientName = r.patient_name;
    }
  } else if (d.waitlistId) {
    out.recordId = d.waitlistId;
    const r = await one(db, `SELECT p.id, p."Name" FROM "Waitlist" w JOIN "Patients" p ON p.id = w.patient_id WHERE w.id::text = $1`, [d.waitlistId]);
    if (r) { out.patientId = r.id; out.patientName = r.Name; }
  }
  if (out.patientId && !out.patientName) {
    const r = await one(db, `SELECT "Name" FROM "Patients" WHERE id::text = $1`, [String(out.patientId)]);
    if (r) out.patientName = r.Name;
  }
  return out;
}

const recentViews = new Map();
const VIEW_REPEAT_MS = 10 * 60 * 1000;
function isRepeatView(username, method, path, qs, action) {
  if (action !== 'view') return false;
  const key = `${username}|${method}|${path}|${JSON.stringify(qs || {})}`;
  const now = Date.now();
  const last = recentViews.get(key);
  if (last && now - last < VIEW_REPEAT_MS) return true;
  recentViews.set(key, now);
  if (recentViews.size > 5000) recentViews.clear();
  return false;
}

function requestMeta(event) {
  const headers = event?.headers || {};
  return {
    ip: event?.requestContext?.http?.sourceIp || event?.requestContext?.identity?.sourceIp || null,
    userAgent: (headers['user-agent'] || headers['User-Agent'] || '').slice(0, 300) || null,
  };
}

// Writes one entry. Never throws.
async function record(db, entry) {
  try {
    if (!(await hasTable(db))) return;
    await db.query(
      `INSERT INTO "AuditLog" (username, role, action, resource, patient_id, patient_name, record_id, method, path, status, ip, user_agent, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [entry.username || null, entry.role || null, entry.action, entry.resource,
        entry.patientId === null || entry.patientId === undefined ? null : String(entry.patientId), entry.patientName || null,
        entry.recordId === null || entry.recordId === undefined ? null : String(entry.recordId),
        entry.method || null, entry.path || null, entry.status ?? null, entry.ip || null, entry.userAgent || null,
        entry.details ? JSON.stringify(entry.details) : null]
    );
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
}

// For index.js: describe + resolve before the route runs, returning a
// function that records the result once it's known (or null to skip).
const RECORDED_ACTIONS = new Set(['create', 'update', 'delete', 'upload']);

async function begin(db, { method, path, qs, body, currentUser, event }) {
  let d;
  try { d = describe(method, path, qs || {}, body || {}); } catch { d = null; }
  if (!d || !RECORDED_ACTIONS.has(d.action)) return null;
  if (isRepeatView(currentUser.username, method, path, qs, d.action)) return null;
  if (!(await hasTable(db))) return null;
  const resolved = await resolvePatient(db, d);
  const meta = requestMeta(event);
  return async (result) => {
    let details = resolved.details;
    // A new patient or appointment: the id and name come back in the response.
    if ((resolved.action === 'create' || resolved.resource === 'patient list') && result?.body && result.statusCode < 300) {
      try {
        const parsed = JSON.parse(result.body);
        if (Array.isArray(parsed)) details = { ...(details || {}), count: parsed.length };
        else if (parsed && typeof parsed === 'object') {
          resolved.recordId = resolved.recordId || parsed.id || null;
          if (resolved.resource === 'patient') { resolved.patientId = parsed.id; resolved.patientName = parsed.Name || resolved.patientName; }
        }
      } catch { /* not JSON */ }
    }
    await record(db, {
      username: currentUser.username, role: currentUser.role,
      action: resolved.action, resource: resolved.resource,
      patientId: resolved.patientId, patientName: resolved.patientName, recordId: resolved.recordId,
      method, path, status: result?.statusCode ?? 500, ...meta, details,
    });
  };
}

module.exports = { begin, record, requestMeta, hasTable, describe };
