const { resolveCaseManagerAssignees, displayNameFor } = require('./utils');
const { syncRequiredTask } = require('./credentialTypes');
const { currentCaseloads } = require('./caseload');
const { getsPatientTasks, PATIENT_TASK_FALLBACK_ROLES } = require('./roles');
const { featureOn } = require('./features');
const { computeMandates, STREAK } = require('./mandates');

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

  // Providers missing any of the owner's required credentials get one
  // "Enter your credentials" task (closed once they're all on file).
  for (const s of staffList.filter(x => x.provider_name)) {
    if (await syncRequiredTask(db, s.username)) createdCount++;
  }

  console.log(`Compliance check: created ${createdCount} new task(s).`);
}

module.exports = { runComplianceCheck };
