const { resolveCaseManagerAssignees, displayNameFor } = require('./utils');
const { syncRequiredTask } = require('./credentialTypes');
const { currentCaseloads } = require('./caseload');
const { getsPatientTasks, PATIENT_TASK_FALLBACK_ROLES } = require('./roles');
const { featureOn } = require('./features');
const { computeMandates, STREAK } = require('./mandates');
const ifsp = require('./ifsp');
const { clinicToday } = require('./caseload');

// Daily compliance-deadline check: RX expiration and IFSP end date notify
// the Case Manager; Report Date notifies every provider currently seeing
// the patient, and the Case Manager (same "Current Provider" definition used in the patient
// chart's Care Team tab -- whose caseload they're on, lib/caseload.js).
// Each task is created at most once per patient+deadline-type+exact-date
// combination, so if the underlying date later changes (e.g. RX renewed),
// a fresh date naturally allows a new task rather than being blocked.
// How far ahead staff credential tasks start (about a month).
const CREDENTIAL_LEAD_DAYS = 30;

async function runComplianceCheck(db) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // Whole days from today's date (not from the current time of day, which
  // made a date two days out count as one).
  const todayMidnight = new Date(todayStr + 'T00:00:00');
  function daysUntil(dateStr) {
    const target = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
    return Math.round((target - todayMidnight) / (24 * 60 * 60 * 1000));
  }

  async function createTaskIfNeeded({ patientId, deadlineType, deadlineDate, assignedTo, title, description, dueDate = null }) {
    // IS NOT DISTINCT FROM instead of = -- patientId is null for
    // credential-based tasks (no patient involved), and plain "=" never
    // matches NULL against NULL, which would silently break the dedup
    // check and create a fresh duplicate task every single day.
    const existing = await db.query(
      'SELECT id FROM "Tasks" WHERE related_patient_id IS NOT DISTINCT FROM $1 AND deadline_type=$2 AND deadline_date=$3 AND assigned_to=$4',
      [patientId, deadlineType, deadlineDate, assignedTo]
    );
    if (existing.rows[0]) return false;
    await db.query(
      `INSERT INTO "Tasks" (title, description, assigned_to, assigned_by, status, is_automated, related_patient_id, deadline_type, deadline_date, due_date)
       VALUES ($1, $2, $3, 'system', 'open', true, $4, $5, $6, $7)`,
      [title, description, assignedTo, patientId, deadlineType, deadlineDate, dueDate]
    );
    return true;
  }

  const staffRes = await db.query('SELECT username, first_name, last_name, preferred_name, role, provider_name FROM "Staff" WHERE archived=false');
  const staffList = staffRes.rows;
  // Patient deadlines (RX, IFSP, reports) never go to developers: a
  // developer who is somehow a case manager or provider is treated as not
  // linked. With no case manager, they go to admins and reception.
  const patientTaskStaff = staffList.filter(s => getsPatientTasks(s.role));
  const adminUsernames = staffList.filter(s => PATIENT_TASK_FALLBACK_ROLES.includes(s.role)).map(s => s.username);

  const patientsRes = await db.query(
    `SELECT id, "Name", "RX_Expiration", "Report_Date", "IFSP_End_Date", "Case_Manager", case_manager_username
     FROM "Patients" WHERE "Status" IS DISTINCT FROM 'Off Program'`
  );
  let createdCount = 0;

  for (const patient of patientsRes.rows) {
    if (patient.RX_Expiration) {
      const days = daysUntil(patient.RX_Expiration);
      if (days >= 0 && days <= 14) {
        for (const assignedTo of resolveCaseManagerAssignees(patient.case_manager_username, patientTaskStaff, adminUsernames)) {
          const created = await createTaskIfNeeded({
            patientId: patient.id, deadlineType: 'rx_expiration', deadlineDate: patient.RX_Expiration, assignedTo,
            title: `RX expiring soon: ${patient.Name}`,
            description: `${patient.Name}'s RX expires on ${patient.RX_Expiration}. Please arrange for renewal.`,
            dueDate: patient.RX_Expiration,
          });
          if (created) createdCount++;
        }
      }
    }

    if (patient.Report_Date) {
      const days = daysUntil(patient.Report_Date);
      if (days >= 0 && days <= 14) {
        // The patient's current providers: whose caseload they're on (lib/caseload.js).
        const team = (await currentCaseloads(db, { patientName: patient.Name })).get(patient.Name) || new Set();
        const writers = new Map(); // username -> provider name
        [...team].forEach(provider => {
          const staffMatch = patientTaskStaff.find(s => s.provider_name === provider);
          if (staffMatch) writers.set(staffMatch.username, provider);
        });
        const description = `${patient.Name}'s report is due on ${patient.Report_Date}.`;
        const assignees = [...writers.keys()].map(username => ({ username, description }));
        // ...and the Case Manager too (Kieran, Oct 2026), told who's writing
        // it. With no active case manager it goes to admins and reception
        // instead, as RX and IFSP do (resolveCaseManagerAssignees). Someone
        // who is also one of the writers gets just the one task.
        const names = [...new Set(writers.values())];
        const overseerText = `${description} ${names.length ? `Written by ${names.join(', ')}.` : 'No current provider is on file to write it.'}`;
        for (const username of resolveCaseManagerAssignees(patient.case_manager_username, patientTaskStaff, adminUsernames)) {
          if (!writers.has(username)) assignees.push({ username, description: overseerText });
        }
        for (const { username: assignedTo, description: text } of assignees) {
          const created = await createTaskIfNeeded({
            patientId: patient.id, deadlineType: 'report_date', deadlineDate: patient.Report_Date, assignedTo,
            title: `Report due soon: ${patient.Name}`,
            description: text,
            dueDate: patient.Report_Date,
          });
          if (created) createdCount++;
        }
      }
    }

    if (patient.IFSP_End_Date) {
      const days = daysUntil(patient.IFSP_End_Date);
      // Same 14-day lead as RX (was 3 days until Oct 2026).
      if (days >= 0 && days <= 14) {
        for (const assignedTo of resolveCaseManagerAssignees(patient.case_manager_username, patientTaskStaff, adminUsernames)) {
          const created = await createTaskIfNeeded({
            patientId: patient.id, deadlineType: 'ifsp_end', deadlineDate: patient.IFSP_End_Date, assignedTo,
            title: `IFSP ending soon: ${patient.Name}`,
            description: `${patient.Name}'s IFSP ends on ${patient.IFSP_End_Date}.`,
            dueDate: patient.IFSP_End_Date,
          });
          if (created) createdCount++;
        }
      }
    }
  }

  // Staff credentials expiring within 30 days (14 until Oct 2026): the holder gets a task to
  // renew it, and every active Admin (role 'admin' only -- not developers
  // or reception) gets one saying whose credential it is. An admin whose
  // own credential is expiring just gets the holder's task. Tasks are
  // de-duplicated per person, so each is created once per expiry date.
  const credentialsRes = await db.query(
    `SELECT sc.id, sc.username, sc.credential_name, sc.expiration_date,
            s.first_name, s.middle_name, s.last_name, s.preferred_name
     FROM "StaffCredentials" sc
     JOIN "Staff" s ON s.username = sc.username AND s.archived = false
     -- A credential with no expiration date never needs a reminder (without
     -- this it came out as a task "expiring" on an invalid date).
     WHERE sc.expiration_date IS NOT NULL`
  );
  const credentialAdmins = staffList.filter(s => s.role === 'admin').map(s => s.username);
  const longDate = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const whenText = (days) => (days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`);
  for (const cred of credentialsRes.rows) {
    const days = daysUntil(cred.expiration_date);
    if (days < 0 || days > CREDENTIAL_LEAD_DAYS) continue;
    const holder = displayNameFor(cred);
    const on = `${longDate(cred.expiration_date)} (${whenText(days)})`;
    const common = { patientId: null, deadlineType: `credential_${cred.id}`, deadlineDate: cred.expiration_date, dueDate: cred.expiration_date };
    if (await createTaskIfNeeded({
      ...common, assignedTo: cred.username,
      title: `Credential expiring: ${cred.credential_name}`,
      description: `Your ${cred.credential_name} credential expires on ${on}. Please renew it and update the new expiration date under Credentials on My profile.`,
    })) createdCount++;
    for (const admin of credentialAdmins) {
      if (admin === cred.username) continue;
      if (await createTaskIfNeeded({
        ...common, assignedTo: admin,
        title: `Staff credential expiring: ${holder} – ${cred.credential_name}`,
        description: `${holder}'s ${cred.credential_name} credential expires on ${on}. They've been sent a reminder to renew it.`,
      })) createdCount++;
    }
  }

  // EI: a child absent from more than 3 consecutive sessions (the
  // "mandates" feature, lib/mandates.js). NYS's EI policy makes the
  // provider tell the service coordinator within 24 hours, so the providers
  // who had those sessions and the case manager (Admins and Reception when
  // there's none) get a task, once per run of absences (keyed by the date of
  // the 4th). Runs that reached 4 in the last 14 days only.
  if (featureOn('mandates')) {
    const clinicDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(today);
    const lastMonth = (() => { const d = new Date(`${clinicDay.slice(0, 7)}-01T00:00:00`); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
    const seen = new Set();
    for (const month of [lastMonth, clinicDay.slice(0, 7)]) {
      const { rows } = await computeMandates(db, { month, today: clinicDay });
      for (const row of rows) {
        for (const st of row.streaks || []) {
          const days = -daysUntil(st.fourth);
          if (days < 0 || days > 14) continue;
          const key = `${row.patient_name}|${row.service}|${st.fourth}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const patient = (await db.query('SELECT id, case_manager_username FROM "Patients" WHERE "Name"=$1', [row.patient_name])).rows[0];
          if (!patient) continue;
          const assignees = new Set();
          for (const prov of st.providers) {
            const match = patientTaskStaff.find(x => x.provider_name === prov);
            if (match) assignees.add(match.username);
          }
          for (const u of resolveCaseManagerAssignees(patient.case_manager_username, patientTaskStaff, adminUsernames)) assignees.add(u);
          const due = new Date(`${st.fourth}T00:00:00`);
          due.setDate(due.getDate() + 1);
          for (const assignedTo of assignees) {
            if (await createTaskIfNeeded({
              patientId: patient.id, deadlineType: `absence_streak_${row.service}`, deadlineDate: st.fourth, assignedTo,
              title: `Absent ${STREAK}+ sessions in a row: ${row.patient_name} (${row.service})`,
              description: `${row.patient_name} has missed ${st.count} ${row.service} sessions in a row (${longDate(st.from)} to ${longDate(st.to)}). EI requires the provider to tell the service coordinator within 24 hours of the 4th absence, and to note the absences and that contact in the child's record.`,
              dueDate: `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`,
            })) createdCount++;
          }
        }
      }
    }
  }

  // Turning 3 (the "ei" feature, PedsDesk only; lib/ifsp.js): an EI child's
  // case manager (Admins and Reception when none) gets a task when telling
  // the CPSE or holding the transition conference is due within
  // TRANSITION_TASK_LEAD_DAYS and isn't recorded on the chart's IFSP tab.
  // Overdue ones still get their task (once per deadline), until EI ends.
  if (featureOn('ei')) {
    const tables = (await db.query(`SELECT to_regclass('"EiTransitions"') AS t, to_regclass('"EiIfsps"') AS i`)).rows[0];
    if (tables?.t && tables?.i) {
      const kids = (await db.query(
        `SELECT p.id, p."Name", p."Date_of_Birth", p.case_manager_username, row_to_json(t) AS record
         FROM "Patients" p LEFT JOIN "EiTransitions" t ON t.patient_id = p.id
         WHERE p."Status" IS DISTINCT FROM 'Off Program' AND p."Date_of_Birth" IS NOT NULL
           AND (p."Program" ~ '(^|,)\\s*EI\\s*(,|$)' OR EXISTS (SELECT 1 FROM "EiIfsps" i WHERE i.patient_id = p.id))`
      )).rows;
      const clinicDay = clinicToday();
      for (const kid of kids) {
        const dates = ifsp.transitionDates(kid.Date_of_Birth);
        for (const item of ifsp.transitionTodo(dates, kid.record, clinicDay)) {
          if (daysUntil(item.due) > ifsp.TRANSITION_TASK_LEAD_DAYS) continue;
          for (const assignedTo of resolveCaseManagerAssignees(kid.case_manager_username, patientTaskStaff, adminUsernames)) {
            if (await createTaskIfNeeded({
              patientId: kid.id, deadlineType: `transition_${item.key}`, deadlineDate: item.due, assignedTo,
              title: `Turning 3: ${kid.Name}`,
              description: `${item.text} by ${item.due} (${kid.Name} turns 3 on ${dates.third_birthday}). Record it on the IFSP tab of the chart when it's done.`,
              dueDate: item.due,
            })) createdCount++;
          }
        }
      }
    }
  }

  // EI paperwork reminders (the "ei" feature, PedsDesk only): one running
  // task per person and kind, its count updated every day and closed when
  // it reaches 0 (not a task per note). Providers: session notes to finish
  // (sessions before today, this month and last) and evaluation reports to
  // write; supervisors: notes and reports to co-sign; the office (Reception
  // and Admins, never Developers): progress reports to approve.
  if (featureOn('ei')) {
    try {
      createdCount += await syncEiPaperworkTasks(db, staffList, adminUsernames);
    } catch (err) {
      console.error('EI paperwork reminders failed', err);
    }
  }

  // Providers missing any of the owner's required credentials get one
  // "Enter your credentials" task (closed once they're all on file).
  for (const s of staffList.filter(x => x.provider_name)) {
    if (await syncRequiredTask(db, s.username)) createdCount++;
  }

  console.log(`Compliance check: created ${createdCount} new task(s).`);
}

// One open task per (person, kind) whose title carries today's count.
// Returns 1 when a task was newly opened.
async function syncCountTask(db, { username, kind, count, title, description, href }) {
  const open = (await db.query(`SELECT id FROM "Tasks" WHERE assigned_to=$1 AND deadline_type=$2 AND status <> 'done' ORDER BY id`, [username, kind])).rows;
  if (!count) {
    if (open.length) await db.query(`UPDATE "Tasks" SET status='done', completed_at=now() WHERE id = ANY($1)`, [open.map(t => t.id)]);
    return 0;
  }
  const text = `${description}${href ? ` (${href})` : ''}`;
  if (open.length) {
    await db.query('UPDATE "Tasks" SET title=$1, description=$2 WHERE id=$3', [title, text, open[0].id]);
    return 0;
  }
  await db.query(
    `INSERT INTO "Tasks" (title, description, assigned_to, assigned_by, status, is_automated, deadline_type, due_date)
     VALUES ($1, $2, $3, 'system', 'open', true, $4, $5)`, [title, text, username, kind, clinicToday()]
  );
  return 1;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

async function syncEiPaperworkTasks(db, staffList, officeUsernames) {
  const has = (await db.query(`SELECT to_regclass('"EiSessionNotes"') AS n, to_regclass('"EiProgressReports"') AS r, to_regclass('"EiEvalReports"') AS e,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'EiSessionNotes' AND column_name = 'supervisor_name') AS sup`)).rows[0];
  if (!has?.n) return 0;
  // Required lazily: these route files require lib/ modules that require this one's neighbours.
  const { eiSessionsFor } = require('../routes/sessionNotes');
  const notesLib = require('./sessionNotes');
  const ev = require('./evalReports');
  const today = clinicToday();
  const thisMonth = today.slice(0, 7);
  const [y, m] = thisMonth.split('-').map(Number);
  const lastMonth = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);

  const toFinish = {};
  const sessions = [];
  for (const month of [lastMonth, thisMonth]) sessions.push(...await eiSessionsFor(db, { month, provider: null, patientName: null }));
  const past = sessions.filter(s => s.date < today);
  const keys = past.map(s => s.key);
  const notes = keys.length ? (await db.query('SELECT * FROM "EiSessionNotes" WHERE session_key = ANY($1)', [keys])).rows : [];
  const byKey = Object.fromEntries(notes.map(n => [n.session_key, n]));
  for (const s of past) {
    const status = notesLib.noteStatus(byKey[s.key]);
    if (['none', 'draft', 'needs_parent', 'needs_provider'].includes(status)) toFinish[s.provider] = (toFinish[s.provider] || 0) + 1;
  }

  const evalsDue = {};
  if (has.e) {
    const { evalsBetween } = require('../routes/evalReports');
    const evals = await evalsBetween(db, { start: `${lastMonth}-01`, end: today, provider: null });
    const evalKeys = evals.map(e => e.key);
    const signed = new Set(evalKeys.length ? (await db.query('SELECT session_key FROM "EiEvalReports" WHERE session_key = ANY($1) AND provider_signed_at IS NOT NULL', [evalKeys])).rows.map(r => r.session_key) : []);
    for (const e of evals) if (!signed.has(e.key)) evalsDue[e.provider] = (evalsDue[e.provider] || 0) + 1;
  }

  const cosign = {};
  if (has.sup) {
    const rows = (await db.query(
      `SELECT supervisor_name, count(*)::int AS n FROM (
         SELECT supervisor_name FROM "EiSessionNotes" WHERE supervisor_name IS NOT NULL AND supervisor_signed_at IS NULL AND provider_signed_at IS NOT NULL
         UNION ALL SELECT supervisor_name FROM "EiProgressReports" WHERE supervisor_name IS NOT NULL AND supervisor_signed_at IS NULL AND provider_signed_at IS NOT NULL
         ${has.e ? 'UNION ALL SELECT supervisor_name FROM "EiEvalReports" WHERE supervisor_name IS NOT NULL AND supervisor_signed_at IS NULL AND provider_signed_at IS NOT NULL' : ''}
       ) x GROUP BY supervisor_name`
    )).rows;
    for (const r of rows) cosign[r.supervisor_name] = r.n;
  }

  let created = 0;
  for (const s of staffList.filter(x => x.provider_name)) {
    const p = s.provider_name;
    created += await syncCountTask(db, {
      username: s.username, kind: 'ei_notes_to_finish', count: toFinish[p] || 0,
      title: `EI: ${plural(toFinish[p] || 0, 'session note', 'session notes')} to finish`,
      description: 'Session notes not yet written or signed by you and the parent, for sessions before today.', href: '/session-notes',
    });
    created += await syncCountTask(db, {
      username: s.username, kind: 'ei_evals_to_write', count: evalsDue[p] || 0,
      title: `EI: ${plural(evalsDue[p] || 0, 'evaluation report', 'evaluation reports')} to write`,
      description: `Evaluation reports not yet signed (due ${ev.REPORT_DUE_DAYS} days after the evaluation).`, href: '/eval-reports',
    });
    created += await syncCountTask(db, {
      username: s.username, kind: 'ei_to_cosign', count: cosign[p] || 0,
      title: `EI: ${plural(cosign[p] || 0, 'note or report', 'notes and reports')} to co-sign`,
      description: `Your supervisees' signed session notes and reports waiting for your co-signature (within ${notesLib.COSIGN_DAYS} days).`, href: '/session-notes',
    });
  }

  if (has.r) {
    const pr = require('./progressReports');
    const reports = (await db.query('SELECT * FROM "EiProgressReports" WHERE sent_on IS NULL AND office_status IS NULL AND provider_signed_at IS NOT NULL AND parent_signed_at IS NOT NULL')).rows;
    const toApprove = reports.filter(r => pr.reportStatus(r) === 'to_approve').length;
    for (const username of officeUsernames) {
      created += await syncCountTask(db, {
        username, kind: 'ei_reports_to_approve', count: toApprove,
        title: `EI: ${plural(toApprove, 'progress report', 'progress reports')} to approve`,
        description: 'Signed progress reports waiting for the office to check and approve before they go to the service coordinator.', href: '/progress-reports',
      });
    }
  }
  return created;
}

module.exports = { runComplianceCheck };
