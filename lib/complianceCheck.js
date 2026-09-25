const { resolveCaseManagerAssignees } = require('./utils');

// Daily compliance-deadline check: RX expiration and IFSP end date notify
// the Case Manager; Report Date notifies every provider currently seeing
// the patient (same "Current Provider" definition used in the patient
// chart's Care Team tab -- an upcoming, non-cancelled appointment).
// Each task is created at most once per patient+deadline-type+exact-date
// combination, so if the underlying date later changes (e.g. RX renewed),
// a fresh date naturally allows a new task rather than being blocked.
async function runComplianceCheck(db) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  function daysUntil(dateStr) {
    const target = new Date(dateStr + 'T00:00:00');
    return Math.floor((target - today) / (24 * 60 * 60 * 1000));
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
  const adminUsernames = staffList.filter(s => s.role === 'admin').map(s => s.username);

  const patientsRes = await db.query(
    `SELECT id, "Name", "RX_Expiration", "Report_Date", "IFSP_End_Date", "Case_Manager", case_manager_username
     FROM "Patients" WHERE "Status" IS DISTINCT FROM 'Off Program'`
  );
  let createdCount = 0;

  for (const patient of patientsRes.rows) {
    if (patient.RX_Expiration) {
      const days = daysUntil(patient.RX_Expiration);
      if (days >= 0 && days <= 14) {
        for (const assignedTo of resolveCaseManagerAssignees(patient.case_manager_username, staffList, adminUsernames)) {
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
        const providersRes = await db.query(
          `SELECT DISTINCT provider FROM "Appointments" WHERE patient_name=$1 AND appointment_date >= $2 AND appointment_status != 'Canceled'`,
          [patient.Name, todayStr]
        );
        const assignees = new Set();
        providersRes.rows.forEach(row => {
          const staffMatch = staffList.find(s => s.provider_name === row.provider);
          if (staffMatch) assignees.add(staffMatch.username);
        });
        for (const assignedTo of assignees) {
          const created = await createTaskIfNeeded({
            patientId: patient.id, deadlineType: 'report_date', deadlineDate: patient.Report_Date, assignedTo,
            title: `Report due soon: ${patient.Name}`,
            description: `${patient.Name}'s report is due on ${patient.Report_Date}.`,
            dueDate: patient.Report_Date,
          });
          if (created) createdCount++;
        }
      }
    }

    if (patient.IFSP_End_Date) {
      const days = daysUntil(patient.IFSP_End_Date);
      if (days >= 0 && days <= 3) {
        for (const assignedTo of resolveCaseManagerAssignees(patient.case_manager_username, staffList, adminUsernames)) {
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

  // Same shape of problem as patient RX/IFSP deadlines, just for staff
  // credentials -- the task goes to the credential holder themselves,
  // since they're the one who needs to actually renew it.
  const credentialsRes = await db.query(
    `SELECT sc.id, sc.username, sc.credential_name, sc.expiration_date
     FROM "StaffCredentials" sc
     JOIN "Staff" s ON s.username = sc.username AND s.archived = false`
  );
  for (const cred of credentialsRes.rows) {
    const days = daysUntil(cred.expiration_date);
    if (days >= 0 && days <= 14) {
      const created = await createTaskIfNeeded({
        patientId: null, deadlineType: `credential_${cred.id}`, deadlineDate: cred.expiration_date, assignedTo: cred.username,
        title: `${cred.credential_name} expiring soon`,
        description: `Your ${cred.credential_name} expires on ${cred.expiration_date}. Please renew it.`,
        dueDate: cred.expiration_date,
      });
      if (created) createdCount++;
    }
  }

  console.log(`Compliance check: created ${createdCount} new task(s).`);
}

module.exports = { runComplianceCheck };
