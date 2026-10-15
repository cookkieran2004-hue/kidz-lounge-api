// The office's EI compliance dashboard (the "ei" feature, PedsDesk only,
// Oct 2026). One GET that gathers everything an NYC EI agency is audited
// on and that's waiting on someone:
//
//   GET /compliance   (Reception, Admins and Developers: canManage)
//
// Sections, each a list of { patient_name, patient_id, provider, text, date, href, severity }:
//   notes          session notes not written, waiting for the parent, waiting for a co-signature
//   reports        progress reports due or late, to approve, approved but not sent
//   evals          evaluation reports not written
//   makeups        make-ups owed this month (the "mandates" feature)
//   transitions    turning-3 steps coming up
//   authorizations EI-Hub authorizations ending soon with nothing after them
//   ifsps          IFSPs ending soon with no next one entered
//   credentials    staff credentials expired or expiring
// Nothing here is stored: it's worked out from the records each time.
const { json } = require('../lib/http');
const { canManage } = require('../lib/roles');
const { featureOn } = require('../lib/features');
const { clinicToday } = require('../lib/caseload');
const ifspLib = require('../lib/ifsp');
const ev = require('../lib/evalReports');
const pr = require('../lib/progressReports');
const notesLib = require('../lib/sessionNotes');

// How far ahead the dashboard looks, and when an unwritten note is late
// (the agency's rule; NYC wants notes written at the session).
const LOOK_AHEAD_DAYS = 30;
const TRANSITION_LOOK_AHEAD_DAYS = 60;
const NOTE_LATE_DAYS = 2;

const day10 = (v) => (v ? String(v).slice(0, 10) : null);
// Dates in the text as staff read them: "Nov 22, 2026".
const nice = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const monthOf = (d) => d.slice(0, 7);
const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 2, 1)); return d.toISOString().slice(0, 7); };
const exists = async (db, table) => !!(await db.query('SELECT to_regclass($1) AS t', [`"${table}"`])).rows[0]?.t;

async function notesSection(db, today) {
  if (!(await exists(db, 'EiSessionNotes'))) return [];
  const { eiSessionsFor } = require('./sessionNotes');
  const sessions = [];
  for (const month of [prevMonth(monthOf(today)), monthOf(today)]) sessions.push(...await eiSessionsFor(db, { month, provider: null, patientName: null }));
  const keys = sessions.map(s => s.key);
  const found = keys.length ? (await db.query('SELECT * FROM "EiSessionNotes" WHERE session_key = ANY($1)', [keys])).rows : [];
  const byKey = Object.fromEntries(found.map(n => [n.session_key, n]));
  const out = [];
  const lateBefore = ifspLib.addDays(today, -NOTE_LATE_DAYS);
  for (const s of sessions) {
    const n = byKey[s.key];
    const status = notesLib.noteStatus(n);
    if (status === 'complete') continue;
    const base = { patient_name: s.patient_name, patient_id: s.patient_id, provider: s.provider, date: s.date, href: `/session-notes/note?key=${encodeURIComponent(s.key)}` };
    if (status === 'none' || status === 'draft') out.push({ ...base, kind: 'to_write', text: `${status === 'none' ? 'Not written' : 'Draft'}${s.cancelled ? ' (canceled session)' : ''}`, severity: s.date < lateBefore ? 'danger' : 'warning' });
    else if (status === 'needs_parent') out.push({ ...base, kind: 'needs_parent', text: n.parent_link_hash ? 'Waiting for the parent (link sent)' : 'Needs the parent\'s signature', severity: 'warning' });
    else if (status === 'needs_provider') out.push({ ...base, kind: 'to_write', text: 'Parent signed; the provider hasn\'t', severity: 'warning' });
    else if (status === 'needs_supervisor') {
      const due = ifspLib.addDays(day10(new Date(n.provider_signed_at).toISOString()), notesLib.COSIGN_DAYS);
      out.push({ ...base, kind: 'needs_supervisor', text: `Needs ${n.supervisor_name}'s co-signature by ${nice(due)}`, severity: due < today ? 'danger' : 'warning' });
    }
  }
  // Older notes still waiting on a co-signature (past the two months above).
  const older = (await db.query(
    `SELECT n.session_key, n.session_date, n.provider, n.supervisor_name, n.provider_signed_at, p."Name" AS patient_name, p.id AS patient_id
     FROM "EiSessionNotes" n JOIN "Patients" p ON p.id = n.patient_id
     WHERE n.supervisor_name IS NOT NULL AND n.supervisor_signed_at IS NULL AND n.provider_signed_at IS NOT NULL AND n.session_date < $1`,
    [`${prevMonth(monthOf(today))}-01`]
  ).catch(() => ({ rows: [] }))).rows;
  for (const n of older) {
    const due = ifspLib.addDays(day10(new Date(n.provider_signed_at).toISOString()), notesLib.COSIGN_DAYS);
    out.push({ patient_name: n.patient_name, patient_id: n.patient_id, provider: n.provider, date: day10(n.session_date), href: `/session-notes/note?key=${encodeURIComponent(n.session_key)}`, kind: 'needs_supervisor', text: `Needs ${n.supervisor_name}'s co-signature by ${nice(due)}`, severity: due < today ? 'danger' : 'warning' });
  }
  return out;
}

async function reportsSection(db, today) {
  if (!(await exists(db, 'EiProgressReports'))) return [];
  const { dueReports } = require('./progressReports');
  const due = await dueReports(db, { provider: null, patientId: null });
  const rows = (await db.query(
    `SELECT r.*, p."Name" AS patient_name FROM "EiProgressReports" r JOIN "Patients" p ON p.id = r.patient_id WHERE r.sent_on IS NULL`
  )).rows;
  const key = (x) => `${x.patient_id}|${x.ifsp_id}|${x.provider}|${x.service}|${x.report_type}`;
  const started = new Set(rows.map(key));
  const out = [];
  for (const d of due) {
    if (started.has(key(d))) continue;
    out.push({ patient_name: d.patient_name, patient_id: d.patient_id, provider: d.provider, date: d.due_date, href: '/progress-reports', kind: 'due', text: `${d.service} progress report not started`, severity: d.due_date < today ? 'danger' : 'warning' });
  }
  for (const r of rows) {
    const status = pr.reportStatus(r);
    const dueDate = day10(r.due_date);
    const base = { patient_name: r.patient_name, patient_id: r.patient_id, provider: r.provider, date: dueDate, href: `/progress-reports/${r.id}` };
    if (status === 'to_approve') out.push({ ...base, kind: 'to_approve', text: `${r.service} progress report to approve`, severity: dueDate && dueDate < today ? 'danger' : 'warning' });
    else if (status === 'approved') out.push({ ...base, kind: 'not_sent', text: `${r.service} progress report approved, not sent to the service coordinator`, severity: 'warning' });
    else if (status === 'returned') out.push({ ...base, kind: 'due', text: `${r.service} progress report returned: waiting for the provider's addendum`, severity: 'warning' });
    else out.push({ ...base, kind: 'due', text: `${r.service} progress report: ${{ draft: 'draft', needs_parent: 'needs the parent', needs_provider: 'needs the provider', needs_supervisor: `needs ${r.supervisor_name}'s co-signature` }[status] || status}`, severity: dueDate && dueDate < today ? 'danger' : 'warning' });
  }
  return out;
}

async function evalsSection(db, today) {
  if (!(await exists(db, 'EiEvalReports'))) return [];
  const { evalsBetween } = require('./evalReports');
  const evals = await evalsBetween(db, { start: ifspLib.addDays(today, -90), end: today, provider: null });
  const keys = evals.map(e => e.key);
  const found = keys.length ? (await db.query('SELECT session_key, details, provider_signed_at, supervisor_name, supervisor_signed_at FROM "EiEvalReports" WHERE session_key = ANY($1)', [keys])).rows : [];
  const byKey = Object.fromEntries(found.map(r => [r.session_key, r]));
  const out = [];
  for (const e of evals) {
    const status = ev.reportStatus(byKey[e.key] || { eval_date: e.appointment_date }, today);
    if (status === 'complete') continue;
    const due = ev.dueDateOf(e.appointment_date);
    out.push({
      patient_name: e.patient_name, patient_id: e.patient_id, provider: e.provider, date: due, href: `/eval-reports/report?key=${encodeURIComponent(e.key)}`,
      kind: status, text: `Evaluation on ${nice(e.appointment_date)}: ${{ none: 'report not written', late: 'report not written', draft: 'report in draft', needs_supervisor: 'needs a co-signature' }[status]}`,
      severity: due < today ? 'danger' : 'warning',
    });
  }
  return out;
}

async function makeupsSection(db, today) {
  if (!featureOn('mandates')) return [];
  const { computeMandates } = require('../lib/mandates');
  const r = await computeMandates(db, { month: monthOf(today), today });
  const names = [...new Set(r.issues.map(i => i.patient_name))];
  const ids = names.length ? Object.fromEntries((await db.query('SELECT id, "Name" FROM "Patients" WHERE "Name" = ANY($1)', [names])).rows.map(p => [p.Name, p.id])) : {};
  return r.issues.filter(i => ['makeup_due_soon', 'makeup_expired', 'makeup_problem', 'absence_streak'].includes(i.type))
    .map(i => ({ patient_name: i.patient_name, patient_id: ids[i.patient_name] || null, provider: (i.providers || []).join(', '), date: i.date || null, href: '/billing', kind: i.type, text: `${i.service}: ${i.text}`, severity: i.severity }));
}

async function transitionsSection(db, today) {
  if (!(await exists(db, 'EiIfsps'))) return [];
  const kids = (await db.query(
    `SELECT p.id, p."Name", p."Date_of_Birth", t.* FROM "Patients" p LEFT JOIN "EiTransitions" t ON t.patient_id = p.id
     WHERE p."Status" IS DISTINCT FROM 'Off Program' AND EXISTS (SELECT 1 FROM "EiIfsps" i WHERE i.patient_id = p.id)`
  )).rows;
  const until = ifspLib.addDays(today, TRANSITION_LOOK_AHEAD_DAYS);
  const out = [];
  for (const k of kids) {
    const dates = ifspLib.transitionDates(day10(k.Date_of_Birth));
    const record = { cpse_notified_date: day10(k.cpse_notified_date), parent_opted_out: k.parent_opted_out, conference_date: day10(k.conference_date), ei_end_date: day10(k.ei_end_date) };
    for (const t of ifspLib.transitionTodo(dates, record, today)) {
      if (t.due > until) continue;
      out.push({ patient_name: k.Name, patient_id: k.id, provider: null, date: t.due, href: null, kind: t.key, text: `Turning 3 on ${nice(dates.third_birthday)}: ${t.text}`, severity: t.due < today ? 'danger' : 'warning' });
    }
  }
  return out;
}

async function authorizationsSection(db, today) {
  if (!(await exists(db, 'EiAuthorizations'))) return [];
  const until = ifspLib.addDays(today, LOOK_AHEAD_DAYS);
  const rows = (await db.query(
    `SELECT a.authorization_number, a.service, a.end_date, p.id AS patient_id, p."Name" AS patient_name
     FROM "EiAuthorizations" a JOIN "Patients" p ON p.id = a.patient_id
     WHERE p."Status" IS DISTINCT FROM 'Off Program' AND a.end_date BETWEEN $1 AND $2
       AND NOT EXISTS (SELECT 1 FROM "EiAuthorizations" b WHERE b.patient_id = a.patient_id AND b.service = a.service AND b.end_date > a.end_date)
     ORDER BY a.end_date`, [ifspLib.addDays(today, -14), until]
  )).rows;
  return rows.map(a => ({ patient_name: a.patient_name, patient_id: a.patient_id, provider: null, date: day10(a.end_date), href: null, kind: 'auth_ending', text: `${a.service || 'EI'} authorization ${a.authorization_number} ${day10(a.end_date) < today ? 'ended' : 'ends'} ${nice(day10(a.end_date))}, nothing after it`, severity: day10(a.end_date) < today ? 'danger' : 'warning' }));
}

async function ifspsSection(db, today) {
  if (!(await exists(db, 'EiIfsps'))) return [];
  const rows = (await db.query(
    `SELECT i.id, i.ifsp_type, i.end_date, p.id AS patient_id, p."Name" AS patient_name
     FROM "EiIfsps" i JOIN "Patients" p ON p.id = i.patient_id
     WHERE p."Status" IS DISTINCT FROM 'Off Program' AND i.end_date BETWEEN $1 AND $2
       AND NOT EXISTS (SELECT 1 FROM "EiIfsps" j WHERE j.patient_id = i.patient_id AND j.start_date > i.start_date)
     ORDER BY i.end_date`, [ifspLib.addDays(today, -14), ifspLib.addDays(today, LOOK_AHEAD_DAYS)]
  )).rows;
  return rows.map(i => ({ patient_name: i.patient_name, patient_id: i.patient_id, provider: null, date: day10(i.end_date), href: null, kind: 'ifsp_ending', text: `IFSP (${i.ifsp_type || 'current'}) ${day10(i.end_date) < today ? 'ended' : 'ends'} ${nice(day10(i.end_date))}; no next IFSP entered`, severity: day10(i.end_date) < today ? 'danger' : 'warning' }));
}

async function credentialsSection(db, today) {
  const rows = (await db.query(
    `SELECT c.credential_name, c.expiration_date, s.username, s.first_name, s.last_name, s.preferred_name, s.provider_name
     FROM "StaffCredentials" c JOIN "Staff" s ON s.username = c.username
     WHERE s.archived = false AND c.expiration_date IS NOT NULL AND c.expiration_date <= $1 ORDER BY c.expiration_date`, [ifspLib.addDays(today, LOOK_AHEAD_DAYS)]
  )).rows;
  return rows.map(c => {
    const date = day10(c.expiration_date);
    const who = c.provider_name || [c.preferred_name || c.first_name, c.last_name].filter(Boolean).join(' ') || c.username;
    return { patient_name: null, patient_id: null, provider: who, date, href: '/credentials', kind: date < today ? 'expired' : 'expiring', text: `${c.credential_name} ${date < today ? 'expired' : 'expires'} ${nice(date)}`, severity: date < today ? 'danger' : 'warning' };
  });
}

async function handle({ path, method, db, currentUser }) {
  if (path !== '/compliance') return null;
  if (!featureOn('ei')) return json(404, { error: 'Not available at this clinic.' });
  if (method !== 'GET') return json(405, { error: 'Not supported.' });
  if (!canManage(currentUser)) return json(403, { error: 'The compliance dashboard is for Reception, Admins and Developers.' });
  const today = clinicToday();
  const sections = {};
  const parts = { notes: notesSection, reports: reportsSection, evals: evalsSection, makeups: makeupsSection, transitions: transitionsSection, authorizations: authorizationsSection, ifsps: ifspsSection, credentials: credentialsSection };
  for (const [name, fn] of Object.entries(parts)) {
    // One section failing (a migration not run yet) never hides the rest.
    try {
      sections[name] = (await fn(db, today)).sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'danger' ? -1 : 1) || String(a.date || '').localeCompare(String(b.date || '')));
    } catch (err) {
      console.error(`Compliance section ${name} failed`, err);
      sections[name] = null;
    }
  }
  return json(200, { today, sections });
}

module.exports = { handle };
