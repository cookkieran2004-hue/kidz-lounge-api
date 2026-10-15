// EI session notes (the "ei" feature, PedsDesk only, Oct 2026; rules in
// lib/sessionNotes.js). Where the feature is off every path here answers 404.
//
//   GET  /session-notes?month=&provider=&patient_id=   EI sessions up to today with their note's status
//   GET  /session-notes/note?key=                      one session: header, IFSP outcomes, the note, addenda
//   PUT  /session-notes/note                           save the draft { key, ...fields } (until the first signature)
//   POST /session-notes/note/parent-sign               { key, parent_name, relationship, note_signature, log_signature }
//   POST /session-notes/note/provider-sign             { key, signature, license }
//   POST /session-notes/note/addenda                   { key, body } (after a signature)
//   POST /session-notes/note/parent-link               { key } a telehealth parent signs from a secure link (7 days)
//   POST /session-notes/note/supervisor-sign           { key, signature, license } the supervisor's co-signature
//   GET  /session-notes/service-log?patient_id=&provider=&month=   the month's service log rows
//   GET  /session-notes/cosign                         notes waiting for my co-signature (the office: everyone's)
//   GET  /session-notes/record?patient_id=             the office: a child's signed EI records for the chart's record pack
//
//   Public (no sign-in; index.js, like Power Forms), the parent's side of a link:
//   GET  /sign/:token            POST /sign/:token/unlock { dob }      POST /sign/:token/submit { access, ... }
//
// Who: the session's own provider writes, gets the parent's signatures on
// their device (or sends a link), signs and adds addenda. Their supervisor
// (Providers.supervisor_name) reads and co-signs. Reception, Admins and
// Developers (canManage) see every note and print them, but never sign for
// a provider. A provider sees only their own sessions.
const jwt = require('jsonwebtoken');
const { json } = require('../lib/http');
const audit = require('../lib/audit');
const { hashToken, newToken } = require('../lib/powerForms');
const { canManage } = require('../lib/roles');
const { featureOn } = require('../lib/features');
const { getMergedAppointments, getMergedOOO } = require('../lib/recurring');
const patientPrograms = require('../lib/patientPrograms');
const { clinicToday, isHold } = require('../lib/caseload');
const { displayNameFor } = require('../lib/utils');
const notes = require('../lib/sessionNotes');
const { sessionKey, eiServiceFor, disciplinesOf } = require('./billing');

const MIGRATION = 'Session notes need the 2026-11-05 database update. It runs with the next deploy.';
const LINK_DAYS = 7;
const MAX_FAILS = 5;
const LOCK_MINUTES = 30;
let tablesSeen = false;
let complianceSeen = false;
async function hasCompliance(db) {
  if (complianceSeen) return true;
  const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'EiSessionNotes' AND column_name = 'parent_link_hash'`);
  complianceSeen = r.rows.length > 0;
  return complianceSeen;
}
async function hasTables(db) {
  if (tablesSeen) return true;
  const r = await db.query(`SELECT to_regclass('"EiSessionNotes"') AS a, to_regclass('"EiSessionNoteAddenda"') AS b`);
  tablesSeen = !!(r.rows[0]?.a && r.rows[0]?.b);
  return tablesSeen;
}

const day10 = (v) => (v ? String(v).slice(0, 10) : null);
const pad = (n) => String(n).padStart(2, '0');
const monthRange = (month) => {
  const [y, m] = month.split('-').map(Number);
  return { start: `${month}-01`, end: `${month}-${pad(new Date(y, m, 0).getDate())}` };
};

// The month's EI sessions up to today (Canceled / No Show included: NYC
// wants those documented too). Office closures and sessions while the
// provider was out aren't sessions and are left out, as in billing.
async function eiSessionsFor(db, { month, provider, patientName }) {
  const { start, end } = monthRange(month);
  const today = clinicToday();
  const [appts, closures, ooo, providersRes] = await Promise.all([
    getMergedAppointments(db, { startDate: start, endDate: end < today ? end : today, provider, patientName }),
    db.query('SELECT closure_date FROM "OfficeClosures" WHERE closure_date BETWEEN $1 AND $2', [start, end]),
    getMergedOOO(db, { startDate: start, endDate: end, provider }),
    db.query('SELECT "Name", specialty FROM "Providers"'),
  ]);
  const closed = new Set(closures.rows.map(c => day10(c.closure_date)));
  const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
  const out = (a) => ooo.some(o => o.provider === a.provider && day10(o.ooo_date) === day10(a.appointment_date)
    && mins(o.start_time) < mins(a.appointment_time) + (Number(a.duration) || 30) && mins(a.appointment_time) < mins(o.end_time));
  // An evaluation takes an evaluation report, not a session note.
  const real = appts.filter(a => a.appointment_status !== '*HOLD*' && !isHold(a.patient_name) && a.patient_name && a.provider && !a.is_eval
    && (!closed.has(day10(a.appointment_date)) || a.outside_hours) && !out(a));
  const names = [...new Set(real.map(a => a.patient_name))];
  const patients = names.length ? (await db.query('SELECT id, "Name", "Program" FROM "Patients" WHERE "Name" = ANY($1)', [names])).rows : [];
  const byName = Object.fromEntries(patients.map(p => [p.Name, p]));
  const programs = await patientPrograms.historyFor(db, patients.map(p => p.id));
  const specialty = Object.fromEntries(providersRes.rows.map(p => [p.Name, disciplinesOf(p.specialty)]));
  const rows = [];
  for (const a of real) {
    const p = byName[a.patient_name];
    if (!p) continue;
    const date = day10(a.appointment_date);
    const ei = eiServiceFor(programs[p.id], date, specialty[a.provider] || [], p.Program);
    if (!ei) continue;
    const startM = mins(a.appointment_time);
    rows.push({
      key: sessionKey(a), date, start_time: String(a.appointment_time).slice(0, 5),
      end_time: `${pad(Math.floor((startM + (Number(a.duration) || 30)) / 60) % 24)}:${pad((startM + (Number(a.duration) || 30)) % 60)}`,
      patient_name: a.patient_name, patient_id: p.id, provider: a.provider, service: ei.service,
      appointment_status: a.appointment_status, cancelled: ['Canceled', 'No Show'].includes(a.appointment_status), is_makeup: !!a.is_makeup,
    });
  }
  return rows.sort((x, y) => x.date.localeCompare(y.date) || x.start_time.localeCompare(y.start_time));
}

// What the browser sees of a note: never the link's hash.
function shown(note) {
  if (!note) return null;
  const { parent_link_hash, parent_link_failures, parent_link_locked_until, ...rest } = note;
  return { ...rest, parent_link_open: !!(parent_link_hash && note.parent_link_expires && new Date(note.parent_link_expires) > new Date() && !note.parent_signed_at) };
}

async function loadNote(db, key) {
  const note = (await db.query('SELECT * FROM "EiSessionNotes" WHERE session_key=$1', [key])).rows[0] || null;
  const addenda = note ? (await db.query('SELECT * FROM "EiSessionNoteAddenda" WHERE note_id=$1 ORDER BY signed_at, id', [note.id])).rows : [];
  return { note, addenda };
}

async function handle({ path, method, qs, body, db, currentUser }) {
  if (path !== '/session-notes' && !path.startsWith('/session-notes/')) return null;
  if (!featureOn('ei')) return json(404, { error: 'Not available at this clinic.' });
  if (!(await hasTables(db))) return json(503, { error: MIGRATION });
  const manager = canManage(currentUser);
  const own = currentUser.providerName || null;
  if (!manager && !own) return json(403, { error: 'Session notes are for providers and the office. No provider is linked to your account.' });

  if (path === '/session-notes' && method === 'GET') {
    const month = String(qs.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return json(400, { error: 'Choose a month.' });
    let patientName = null;
    if (qs.patient_id) {
      patientName = (await db.query('SELECT "Name" FROM "Patients" WHERE id::text=$1', [String(qs.patient_id)])).rows[0]?.Name;
      if (!patientName) return json(404, { error: 'Patient not found.' });
    }
    const provider = manager ? (qs.provider || null) : own;
    const sessions = await eiSessionsFor(db, { month, provider, patientName });
    const keys = sessions.map(s => s.key);
    const found = keys.length ? (await db.query('SELECT * FROM "EiSessionNotes" WHERE session_key = ANY($1)', [keys])).rows : [];
    const byKey = Object.fromEntries(found.map(n => [n.session_key, n]));
    return json(200, {
      month, today: clinicToday(),
      sessions: sessions.map(s => ({ ...s, note_status: notes.noteStatus(byKey[s.key]), note_id: byKey[s.key]?.id ?? null })),
    });
  }

  if (path === '/session-notes/service-log' && method === 'GET') {
    const month = String(qs.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month) || !qs.patient_id || !qs.provider) return json(400, { error: 'Choose a child, provider and month.' });
    if (!manager && qs.provider !== own) return json(403, { error: 'You can only print your own service logs.' });
    const { start, end } = monthRange(month);
    const rows = (await db.query(
      `SELECT session_key, session_date, start_time, end_time, service, header, parent_name, parent_relationship, parent_log_signature, parent_signed_at, location, delivery
       FROM "EiSessionNotes" WHERE patient_id::text=$1 AND provider=$2 AND session_date BETWEEN $3 AND $4 AND NOT cancelled AND parent_signed_at IS NOT NULL
       ORDER BY session_date, start_time`, [String(qs.patient_id), qs.provider, start, end]
    )).rows;
    const agency = (await db.query('SELECT agency_name FROM "EiBillingSettings" WHERE id = 1').catch(() => ({ rows: [] }))).rows[0];
    return json(200, { month, provider: qs.provider, agency_name: agency?.agency_name || null, rows });
  }

  if (path === '/session-notes/cosign' && method === 'GET') {
    if (!(await hasCompliance(db))) return json(200, { notes: [] });
    const rows = (await db.query(
      `SELECT n.id, n.session_key, n.session_date, n.start_time, n.provider, n.service, n.supervisor_name, n.provider_signed_at, p."Name" AS patient_name
       FROM "EiSessionNotes" n JOIN "Patients" p ON p.id = n.patient_id
       WHERE n.supervisor_name IS NOT NULL AND n.supervisor_signed_at IS NULL AND n.provider_signed_at IS NOT NULL
         AND ($1::text IS NULL OR n.supervisor_name = $1) ORDER BY n.provider_signed_at`, [manager && !qs.mine ? null : own]
    )).rows;
    return json(200, { cosign_days: notes.COSIGN_DAYS, notes: rows });
  }

  // The chart's record pack (the office): every signed note with its
  // addenda, the progress reports and evaluation reports to fetch, and the
  // documents on file (listed, not merged). The browser builds the PDF.
  if (path === '/session-notes/record' && method === 'GET') {
    if (!manager) return json(403, { error: 'Record packs are made by Reception, Admins and Developers.' });
    const patientId = String(qs.patient_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(patientId)) return json(400, { error: 'Choose a child.' });
    const list = (await db.query(
      `SELECT * FROM "EiSessionNotes" WHERE patient_id=$1 AND (provider_signed_at IS NOT NULL OR parent_signed_at IS NOT NULL) ORDER BY session_date, start_time`, [patientId]
    )).rows;
    const addenda = list.length ? (await db.query('SELECT * FROM "EiSessionNoteAddenda" WHERE note_id = ANY($1) ORDER BY signed_at, id', [list.map(n => n.id)])).rows : [];
    const has = (await db.query(`SELECT to_regclass('"EiProgressReports"') AS r, to_regclass('"EiEvalReports"') AS e`)).rows[0];
    const reports = has.r ? (await db.query('SELECT id FROM "EiProgressReports" WHERE patient_id=$1 AND (provider_signed_at IS NOT NULL OR parent_signed_at IS NOT NULL) ORDER BY ifsp_start, id', [patientId])).rows : [];
    const evals = has.e ? (await db.query('SELECT session_key FROM "EiEvalReports" WHERE patient_id=$1 AND provider_signed_at IS NOT NULL ORDER BY eval_date', [patientId])).rows : [];
    const documents = (await db.query('SELECT id, filename, document_type, uploaded_at FROM "PatientDocuments" WHERE patient_id=$1 ORDER BY uploaded_at', [patientId])).rows;
    const agency = (await db.query('SELECT agency_name FROM "EiBillingSettings" WHERE id = 1').catch(() => ({ rows: [] }))).rows[0];
    return json(200, {
      agency_name: agency?.agency_name || null,
      notes: list.map(n => ({ note: shown(n), addenda: addenda.filter(a => a.note_id === n.id) })),
      progress_report_ids: reports.map(r => r.id),
      eval_keys: evals.map(e => e.session_key),
      documents,
    });
  }

  if (!path.startsWith('/session-notes/note')) return json(404, { error: 'Not found.' });
  const key = String((method === 'GET' ? qs.key : body?.key) || '');
  const appt = await notes.findSession(db, key);
  if (!appt) return json(404, { error: 'That session was not found. It may have been moved or deleted.' });
  const info = await notes.sessionInfo(db, appt);
  if (info.eval) return json(400, { error: 'This is an evaluation: write an evaluation report for it instead of a session note.' });
  if (!info.ei) return json(400, { error: "This session doesn't bill under EI, so it doesn't take an EI session note." });
  if (info.date > clinicToday()) return json(400, { error: 'A session note can be written on or after the day of the session.' });
  let { note, addenda } = await loadNote(db, key);
  const mine = own && info.provider === own;
  const supervising = !!own && !mine && (note?.supervisor_name === own || (!note?.provider_signed_at && info.supervisor === own));
  if (!manager && !mine && !supervising) return json(403, { error: 'You can only see notes for your own sessions.' });

  if (path === '/session-notes/note' && method === 'GET') {
    const { patient, ...session } = info;
    return json(200, {
      session: { ...session, patient_id: patient.id, patient_name: patient.Name },
      note: shown(note), addenda, can_write: !!mine,
      can_cosign: !!(supervising && note?.supervisor_name === own && note.provider_signed_at && !note.supervisor_signed_at),
      cosign_days: notes.COSIGN_DAYS,
      status: notes.noteStatus(note),
      missing: notes.missingForSigning(note || { cancelled: info.cancelled }),
      today: clinicToday(),
    });
  }

  if (path === '/session-notes/note/supervisor-sign' && method === 'POST') {
    if (!note || !note.supervisor_name || note.supervisor_name !== own) return json(403, { error: "Only the provider's supervisor can co-sign this note." });
    if (!note.provider_signed_at) return json(400, { error: 'The provider signs the note first.' });
    if (note.supervisor_signed_at) return json(409, { error: 'You have already co-signed this note.' });
    const b = body || {};
    if (!notes.validSignature(b.signature)) return json(400, { error: 'Sign in the box.' });
    const license = String(b.license || (await notes.licenseFor(db, own)) || '').trim().slice(0, 60);
    if (!license) return json(400, { error: 'Enter your license #.' });
    note = (await db.query(
      `UPDATE "EiSessionNotes" SET supervisor_signature=$1, supervisor_license=$2, supervisor_signed_at=now(), supervisor_signed_by=$3, updated_at=now()
       WHERE id=$4 AND supervisor_signed_at IS NULL RETURNING *`, [b.signature, license, currentUser.username, note.id]
    )).rows[0];
    if (!note) return json(409, { error: 'This note was already co-signed. Reload the page.' });
    return json(200, { note: shown(note), status: notes.noteStatus(note) });
  }

  // Everything below writes: only the session's own provider.
  if (!mine) return json(403, { error: "Only the session's provider can write and sign its note." });
  const locked = !!(note && (note.provider_signed_at || note.parent_signed_at));

  if (path === '/session-notes/note' && method === 'PUT') {
    if (locked) return json(409, { error: 'This note has been signed, so it can no longer be changed. Add an addendum instead.' });
    const { value } = notes.cleanDraft(body, info);
    if (!note) {
      note = (await db.query(
        `INSERT INTO "EiSessionNotes" (session_key, patient_id, provider, session_date, start_time, end_time, service, cancelled, makeup_by, makeup_for_date,
           location, delivery, participants, participants_other, outcome_ids, outcomes_text, narrative, parent_methods, parent_methods_other, strategies, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
        [key, info.patient.id, info.provider, info.date, info.start_time, info.end_time, info.service, info.cancelled, info.makeup_by, info.makeup_for_date,
          value.location, value.delivery, value.participants, value.participants_other, value.outcome_ids, value.outcomes_text, value.narrative,
          value.parent_methods, value.parent_methods_other, value.strategies, currentUser.username]
      )).rows[0];
      if (await hasCompliance(db)) note = await saveGroup(db, note.id, value);
    } else {
      // The session's own details follow the schedule until the first
      // signature (a time or status changed after the draft was started).
      note = (await db.query(
        `UPDATE "EiSessionNotes" SET session_date=$1, start_time=$2, end_time=$3, service=$4, cancelled=$5, makeup_by=$6, makeup_for_date=$7,
           location=$8, delivery=$9, participants=$10, participants_other=$11, outcome_ids=$12, outcomes_text=$13, narrative=$14,
           parent_methods=$15, parent_methods_other=$16, strategies=$17, updated_at=now() WHERE id=$18 RETURNING *`,
        [info.date, info.start_time, info.end_time, info.service, info.cancelled, info.makeup_by, info.makeup_for_date,
          value.location, value.delivery, value.participants, value.participants_other, value.outcome_ids, value.outcomes_text, value.narrative,
          value.parent_methods, value.parent_methods_other, value.strategies, note.id]
      )).rows[0];
      // A change after a link went to the parent cancels the link: they'd
      // otherwise sign something they never saw.
      if (await hasCompliance(db)) note = await saveGroup(db, note.id, value, true);
    }
    return json(200, { note: shown(note), status: notes.noteStatus(note), missing: notes.missingForSigning(note) });
  }

  if (path === '/session-notes/note/parent-sign' && method === 'POST') {
    if (!note) return json(400, { error: 'Save the note before the parent signs.' });
    if (note.cancelled) return json(400, { error: "A canceled session doesn't need the parent's signature." });
    if (note.parent_signed_at) return json(409, { error: 'The parent has already signed this note.' });
    const missing = notes.missingForSigning(note);
    if (missing.length) return json(400, { error: `Finish the note before the parent signs: ${missing[0]}.`, missing });
    const b = body || {};
    const name = String(b.parent_name || '').trim().slice(0, 200);
    const relationship = String(b.relationship || '').trim().slice(0, 100);
    if (!name) return json(400, { error: "Enter the parent or caregiver's name." });
    if (!relationship) return json(400, { error: 'Enter their relationship to the child (e.g. mother, babysitter, child care teacher).' });
    if (!notes.validSignature(b.note_signature)) return json(400, { error: 'The parent needs to sign the session note in the box.' });
    if (!notes.validSignature(b.log_signature)) return json(400, { error: 'The parent needs to sign the service log in the box.' });
    note = (await db.query(
      `UPDATE "EiSessionNotes" SET parent_name=$1, parent_relationship=$2, parent_note_signature=$3, parent_log_signature=$4, parent_signed_at=now(), updated_at=now()
       WHERE id=$5 AND parent_signed_at IS NULL RETURNING *`, [name, relationship, b.note_signature, b.log_signature, note.id]
    )).rows[0];
    if (!note) return json(409, { error: 'The parent has already signed this note. Reload the page.' });
    if (await hasCompliance(db)) note = (await db.query(`UPDATE "EiSessionNotes" SET parent_signed_via='device', parent_link_hash=NULL WHERE id=$1 RETURNING *`, [note.id])).rows[0];
    return json(200, { note: shown(note), status: notes.noteStatus(note) });
  }

  if (path === '/session-notes/note/provider-sign' && method === 'POST') {
    if (!note) return json(400, { error: 'Save the note before signing it.' });
    if (note.provider_signed_at) return json(409, { error: 'You have already signed this note.' });
    const missing = notes.missingForSigning(note);
    if (missing.length) return json(400, { error: `Finish the note before signing: ${missing[0]}.`, missing });
    const b = body || {};
    if (!notes.validSignature(b.signature)) return json(400, { error: 'Sign in the box.' });
    const license = String(b.license || info.header.license || '').trim().slice(0, 60);
    if (!license) return json(400, { error: 'Enter your license or certification # (or "certified").' });
    note = (await db.query(
      `UPDATE "EiSessionNotes" SET provider_signature=$1, provider_license=$2, provider_signed_at=now(), provider_signed_by=$3, header=$4, updated_at=now()
       WHERE id=$5 AND provider_signed_at IS NULL RETURNING *`,
      [b.signature, license, currentUser.username, { ...info.header, license, outcomes: info.outcomes.filter(o => (note.outcome_ids || []).includes(o.id)) }, note.id]
    )).rows[0];
    if (!note) return json(409, { error: 'This note was already signed. Reload the page.' });
    // Their supervisor at the time of signing co-signs it.
    if (info.supervisor && (await hasCompliance(db))) {
      note = (await db.query('UPDATE "EiSessionNotes" SET supervisor_name=$1 WHERE id=$2 RETURNING *', [info.supervisor, note.id])).rows[0];
    }
    return json(200, { note: shown(note), status: notes.noteStatus(note) });
  }

  if (path === '/session-notes/note/parent-link' && method === 'POST') {
    if (!(await hasCompliance(db))) return json(503, { error: 'Signing links need the 2026-11-07 database update. It runs with the next deploy.' });
    if (!note) return json(400, { error: 'Save the note first.' });
    if (note.cancelled) return json(400, { error: "A canceled session doesn't need the parent's signature." });
    if (note.parent_signed_at) return json(409, { error: 'The parent has already signed this note.' });
    if (note.delivery !== 'telehealth') return json(400, { error: 'A signing link is for telehealth sessions. For an in-person session the parent signs on your device.' });
    const missing = notes.missingForSigning(note);
    if (missing.length) return json(400, { error: `Finish the note before sending it: ${missing[0]}.`, missing });
    const token = newToken();
    await db.query(
      `UPDATE "EiSessionNotes" SET parent_link_hash=$1, parent_link_expires=now() + ($2::text || ' days')::interval, parent_link_failures=0, parent_link_locked_until=NULL WHERE id=$3`,
      [hashToken(token), String(LINK_DAYS), note.id]
    );
    return json(200, { token, path: `/s/${token}`, expires_days: LINK_DAYS });
  }

  if (path === '/session-notes/note/addenda' && method === 'POST') {
    if (!locked) return json(400, { error: 'This note isn\'t signed yet: change the note itself instead.' });
    const text = String(body?.body || '').trim().slice(0, 6000);
    if (!text) return json(400, { error: 'Write the correction or addition.' });
    const staff = (await db.query('SELECT first_name, last_name, preferred_name, username FROM "Staff" WHERE username=$1', [currentUser.username])).rows[0] || {};
    await db.query('INSERT INTO "EiSessionNoteAddenda" (note_id, body, signed_by, signed_name) VALUES ($1,$2,$3,$4)',
      [note.id, text, currentUser.username, displayNameFor(staff)]);
    ({ addenda } = await loadNote(db, key));
    return json(201, { addenda });
  }

  return json(405, { error: 'Not supported.' });
}

// The group-session fields (and, on a change, cancelling an open link).
async function saveGroup(db, id, v, changed) {
  return (await db.query(
    `UPDATE "EiSessionNotes" SET group_type=$1, group_children=$2, group_duration=$3, group_site=$4, aide_name=$5, aide_notes=$6,
       parent_link_hash=CASE WHEN $7::boolean THEN NULL ELSE parent_link_hash END WHERE id=$8 RETURNING *`,
    [v.group_type, v.group_children, v.group_duration, v.group_site, v.aide_name, v.aide_notes, !!changed, id]
  )).rows[0];
}

// ---------- Public: a telehealth parent signs from a link ----------
const accessSecret = () => `${process.env.JWT_SECRET}:session-sign`;
const NOT_VALID = "This link isn't valid. Ask your provider to send you a new one.";

async function handlePublic({ path, method, body, db, meta }) {
  const m = path.match(/^\/sign\/([^/]+)(?:\/(unlock|submit))?$/);
  if (!m) return null;
  if (!featureOn('ei') || !(await hasTables(db)) || !(await hasCompliance(db))) return json(404, { error: NOT_VALID });
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(m[1])) return json(404, { error: NOT_VALID });
  const note = (await db.query('SELECT * FROM "EiSessionNotes" WHERE parent_link_hash=$1', [hashToken(m[1])])).rows[0];
  if (!note) return json(404, { error: NOT_VALID });
  if (note.parent_signed_at) return json(200, { status: 'completed' });
  if (!note.parent_link_expires || new Date(note.parent_link_expires) < new Date()) {
    return json(410, { status: 'expired', error: 'This link has expired. Ask your provider to send you a new one.' });
  }
  if (note.parent_link_locked_until && new Date(note.parent_link_locked_until) > new Date()) {
    const mins = Math.max(1, Math.ceil((new Date(note.parent_link_locked_until) - new Date()) / 60000));
    return json(429, { status: 'locked', error: `Too many tries. Please try again in ${mins} minute${mins === 1 ? '' : 's'}.` });
  }
  const b = body || {};
  if (!m[2] && method === 'GET') return json(200, { status: 'ready' });

  const patient = (await db.query('SELECT * FROM "Patients" WHERE id=$1', [note.patient_id])).rows[0];
  if (m[2] === 'unlock' && method === 'POST') {
    const real = patient?.Date_of_Birth ? String(patient.Date_of_Birth).slice(0, 10) : null;
    if (!real || String(b.dob || '').slice(0, 10) !== real) {
      const fails = note.parent_link_failures + 1;
      const lock = fails >= MAX_FAILS;
      await db.query(
        `UPDATE "EiSessionNotes" SET parent_link_failures=$1::int,
           parent_link_locked_until=CASE WHEN $2::boolean THEN now() + ($3::text || ' minutes')::interval ELSE parent_link_locked_until END WHERE id=$4`,
        [lock ? 0 : fails, lock, String(LOCK_MINUTES), note.id]
      );
      if (lock) return json(429, { status: 'locked', error: `Too many tries. Please try again in ${LOCK_MINUTES} minutes.` });
      return json(400, { error: "That date of birth doesn't match our records. Please check it and try again." });
    }
    await db.query('UPDATE "EiSessionNotes" SET parent_link_failures=0 WHERE id=$1', [note.id]);
    const access = jwt.sign({ nid: note.id }, accessSecret(), { expiresIn: '2h' });
    // Only what the parent is signing: the session and the note's answers.
    const ifspOutcomes = note.outcome_ids?.length
      ? (await db.query('SELECT id, outcome FROM "EiIfspOutcomes" WHERE id = ANY($1) ORDER BY position, id', [note.outcome_ids])).rows : [];
    return json(200, {
      access,
      session: {
        child_first_name: String(patient.Name || '').trim().split(/\s+/)[0] || null,
        date: day10(note.session_date), start_time: String(note.start_time).slice(0, 5), end_time: String(note.end_time).slice(0, 5),
        service: note.service, provider: note.provider, delivery: note.delivery,
      },
      note: {
        outcomes: ifspOutcomes.map(o => o.outcome), outcomes_text: note.outcomes_text, narrative: note.narrative,
        parent_methods: note.parent_methods, parent_methods_other: note.parent_methods_other, strategies: note.strategies, group_type: note.group_type,
      },
      parent_hint: { name: patient.Parent_Name || null, relationship: patient.Relationship_To_Patient || null },
    });
  }

  if (m[2] === 'submit' && method === 'POST') {
    let claims = null;
    try { claims = jwt.verify(String(b.access || ''), accessSecret()); } catch { claims = null; }
    if (!claims || claims.nid !== note.id) return json(401, { error: 'Your session ran out. Reload the page and enter the date of birth again.' });
    const name = String(b.parent_name || '').trim().slice(0, 200);
    const relationship = String(b.relationship || '').trim().slice(0, 100);
    if (!name) return json(400, { error: 'Enter your name.' });
    if (!relationship) return json(400, { error: 'Enter your relationship to the child.' });
    if (!notes.validSignature(b.note_signature)) return json(400, { error: 'Sign the session note in the box.' });
    if (!notes.validSignature(b.log_signature)) return json(400, { error: 'Sign the service log in the box.' });
    const done = (await db.query(
      `UPDATE "EiSessionNotes" SET parent_name=$1, parent_relationship=$2, parent_note_signature=$3, parent_log_signature=$4, parent_signed_at=now(),
         parent_signed_via='link', parent_link_hash=NULL, updated_at=now()
       WHERE id=$5 AND parent_signed_at IS NULL AND parent_link_hash=$6 RETURNING id`,
      [name, relationship, b.note_signature, b.log_signature, note.id, hashToken(m[1])]
    )).rows[0];
    if (!done) return json(409, { error: 'This note was already signed.' });
    await audit.record(db, {
      username: null, role: 'parent', action: 'create', resource: 'Session note signature', patientId: note.patient_id,
      recordId: note.id, method, path: '/sign/:token/submit', status: 200, ip: meta.ip, userAgent: meta.userAgent,
      details: { session_date: day10(note.session_date), provider: note.provider },
    });
    return json(200, { status: 'completed' });
  }
  return null;
}

module.exports = { handle, handlePublic, eiSessionsFor };
