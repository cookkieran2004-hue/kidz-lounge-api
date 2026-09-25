const { json } = require('../lib/http');
const { verifyAdminPassword } = require('../lib/auth');
const { mergedField, generateUniqueMRN, displayNameFor } = require('../lib/utils');

// Allergies / Immunizations (migrations/2026-09-28_patient_allergies_immunizations.sql).
// Checked once per cold start so a deploy that lands before the migration
// keeps saving patients normally -- just without these two fields.
let alertColumnsPromise = null;
function hasAlertColumns(db) {
  if (!alertColumnsPromise) {
    alertColumnsPromise = db.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name = 'Patients' AND column_name IN ('Allergies', 'Immunizations')`
    ).then(r => r.rows[0]?.n === 2).catch(() => false);
  }
  return alertColumnsPromise;
}
// Saves whichever of the two fields the request included.
async function saveAlertFields(q, id, body, existing = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (!has('Allergies') && !has('Immunizations')) return null;
  const clean = (v) => ((v || '').trim() ? v.trim() : null);
  const res = await q.query(
    'UPDATE "Patients" SET "Allergies"=$1, "Immunizations"=$2 WHERE id=$3 RETURNING *',
    [has('Allergies') ? clean(body.Allergies) : (existing.Allergies ?? null), has('Immunizations') ? clean(body.Immunizations) : (existing.Immunizations ?? null), id]
  );
  return res.rows[0];
}

// case_manager_username is the real, stable link; Case_Manager (legacy
// text) is kept in sync purely so every existing display location (Patient
// Chart, Schedule panel, patient list badges) keeps working unchanged.
// Whenever a real staff member is linked, the display text is always
// derived from their actual name here -- never trusted from the client --
// so the two can never drift out of sync. The special "Not Needed" value
// and a plain empty/unassigned state have no staff link, so whatever text
// was sent for those passes through untouched.
async function resolveCaseManagerFields(db, caseManagerUsername, caseManagerText) {
  if (!caseManagerUsername) {
    return { case_manager_username: null, Case_Manager: caseManagerText || null };
  }
  const staffRes = await db.query(
    'SELECT username, first_name, middle_name, last_name, preferred_name FROM "Staff" WHERE username=$1',
    [caseManagerUsername]
  );
  const staff = staffRes.rows[0];
  if (!staff) return { case_manager_username: null, Case_Manager: caseManagerText || null };
  return { case_manager_username: staff.username, Case_Manager: displayNameFor(staff) };
}

async function handle({ path, method, qs, body, db, currentUser }) {
  if (path === '/patients' && method === 'GET') {
    const result = await db.query('SELECT * FROM "Patients" ORDER BY "Name"');
    return json(200, result.rows);
  }

  // Patients with an allergy or immunization note -- small, so the schedule
  // can mark those patients' appointment cards (appointments store only the
  // patient's name).
  if (path === '/patients/alerts' && method === 'GET') {
    if (!(await hasAlertColumns(db))) return json(200, []);
    const result = await db.query(
      `SELECT "Name", "Allergies", "Immunizations" FROM "Patients"
       WHERE COALESCE(TRIM("Allergies"), '') <> '' OR COALESCE(TRIM("Immunizations"), '') <> ''`
    );
    return json(200, result.rows);
  }

  if (path === '/patients' && method === 'POST') {
    const {
      Name, Program, Parent_Name, Relationship_To_Patient, Parent_Phone, Parent_Email,
      Date_of_Birth, ID_Number, Picture_Consent, Services, Mandate, Case_Manager, case_manager_username, SC_Admin_Name,
      IFSP_Type, IFSP_Start_Date, IFSP_End_Date, RX_Date, RX_Expiration, Report_Date, Scheduling_Notes,
      Status, SC_Admin_Phone, SC_Admin_Email, Google_Link,
    } = body;
    if (!Name || !Name.trim()) return json(400, { error: 'Name is required' });
    // MRN is always generated here, never accepted from the client -- it's
    // the patient's permanent, computer-assigned unique identifier.
    const mrn = await generateUniqueMRN(db);
    const caseManagerFields = await resolveCaseManagerFields(db, case_manager_username, Case_Manager);
    const result = await db.query(
      `INSERT INTO "Patients"
        (mrn, "Name", "Program", "Parent_Name", "Relationship_To_Patient", "Parent_Phone", "Parent_Email",
         "Date_of_Birth", "ID_Number", "Picture_Consent", "Services", "Mandate", "Case_Manager", case_manager_username, "SC_Admin_Name",
         "IFSP_Type", "IFSP_Start_Date", "IFSP_End_Date", "RX_Date", "RX_Expiration", "Report_Date", "Scheduling_Notes",
         "Status", "SC_Admin_Phone", "SC_Admin_Email", "Google_Link")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
       RETURNING *`,
      [
        mrn, Name.trim(), Program || null, Parent_Name || null, Relationship_To_Patient || null, Parent_Phone || null, Parent_Email || null,
        Date_of_Birth || null, ID_Number || null, Picture_Consent ?? null, Services || null, Mandate || null, caseManagerFields.Case_Manager, caseManagerFields.case_manager_username, SC_Admin_Name || null,
        IFSP_Type || null, IFSP_Start_Date || null, IFSP_End_Date || null, RX_Date || null, RX_Expiration || null, Report_Date || null, Scheduling_Notes || null,
        Status || null, SC_Admin_Phone || null, SC_Admin_Email || null, Google_Link || null,
      ]
    );
    const withAlerts = (await hasAlertColumns(db)) ? await saveAlertFields(db, result.rows[0].id, body) : null;
    return json(201, withAlerts || result.rows[0]);
  }

  if (path === '/patients/search' && method === 'GET') {
    const q = qs.q || '';
    // Used specifically for the "pick a patient" search when creating a new
    // appointment -- Off Program patients are excluded here so staff don't
    // accidentally book someone no longer active. This does not affect the
    // full patient list in Manage Data, where Off Program patients should
    // still be visible for record-keeping.
    const result = await db.query(
      `SELECT id, "Name", mrn FROM "Patients"
       WHERE "Name" ILIKE $1 AND "Status" IS DISTINCT FROM 'Off Program'
       ORDER BY "Name" LIMIT 10`,
      [`%${q}%`]
    );
    return json(200, result.rows);
  }

  if (path.match(/^\/patients\/[^/]+\/appointments$/) && method === 'GET') {
    const name = decodeURIComponent(path.split('/')[2]);
    const result = await db.query(
      'SELECT * FROM "Appointments" WHERE patient_name = $1 ORDER BY appointment_date DESC, appointment_time DESC',
      [name]
    );
    return json(200, result.rows);
  }

  if (path.match(/^\/patients\/[^/]+$/) && method === 'GET') {
    const name = decodeURIComponent(path.split('/').pop());
    const result = await db.query('SELECT * FROM "Patients" WHERE "Name" = $1 LIMIT 1', [name]);
    return json(200, result.rows[0] || null);
  }

  if (path.match(/^\/patients\/[^/]+$/) && method === 'PUT') {
    const id = path.split('/').pop();
    const { Name, admin_password } = body;
    const nameProvided = Object.prototype.hasOwnProperty.call(body, 'Name');
    if (nameProvided && (!Name || !Name.trim())) return json(400, { error: 'Name is required' });
    // Every staff member (not just admins) confirms their own password
    // before a patient edit is saved -- reuses the same verification
    // helper originally built for staff-account changes.
    if (!(await verifyAdminPassword(db, currentUser, admin_password))) {
      return json(403, { error: 'Incorrect password.' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const existingRes = await client.query('SELECT * FROM "Patients" WHERE id=$1', [id]);
      if (!existingRes.rows[0]) {
        await client.query('ROLLBACK');
        return json(404, { error: 'Patient not found' });
      }
      const existing = existingRes.rows[0];
      const oldName = existing.Name;
      const newName = nameProvided ? Name.trim() : oldName;
      // Resolved together, not independently mergedField'd -- these two
      // columns are a linked pair (the real link, and the display text
      // derived from it), so touching one without the other would let them
      // drift out of sync.
      const caseManagerFields = Object.prototype.hasOwnProperty.call(body, 'case_manager_username')
        ? await resolveCaseManagerFields(db, body.case_manager_username, body.Case_Manager)
        : { case_manager_username: existing.case_manager_username, Case_Manager: existing.Case_Manager };

      const updateRes = await client.query(
        `UPDATE "Patients" SET
           "Name"=$1, "Program"=$2, "Parent_Name"=$3, "Relationship_To_Patient"=$4, "Parent_Phone"=$5, "Parent_Email"=$6,
           "Date_of_Birth"=$7, "ID_Number"=$8, "Picture_Consent"=$9, "Services"=$10, "Mandate"=$11, "Case_Manager"=$12, case_manager_username=$13, "SC_Admin_Name"=$14,
           "IFSP_Type"=$15, "IFSP_Start_Date"=$16, "IFSP_End_Date"=$17, "RX_Date"=$18, "RX_Expiration"=$19, "Report_Date"=$20, "Scheduling_Notes"=$21,
           "Status"=$22, "SC_Admin_Phone"=$23, "SC_Admin_Email"=$24, "Google_Link"=$25
         WHERE id=$26 RETURNING *`,
        [
          newName,
          mergedField(body, 'Program', existing),
          mergedField(body, 'Parent_Name', existing),
          mergedField(body, 'Relationship_To_Patient', existing),
          mergedField(body, 'Parent_Phone', existing),
          mergedField(body, 'Parent_Email', existing),
          mergedField(body, 'Date_of_Birth', existing),
          mergedField(body, 'ID_Number', existing),
          mergedField(body, 'Picture_Consent', existing, (v) => v ?? null),
          mergedField(body, 'Services', existing),
          mergedField(body, 'Mandate', existing),
          caseManagerFields.Case_Manager,
          caseManagerFields.case_manager_username,
          mergedField(body, 'SC_Admin_Name', existing),
          mergedField(body, 'IFSP_Type', existing),
          mergedField(body, 'IFSP_Start_Date', existing),
          mergedField(body, 'IFSP_End_Date', existing),
          mergedField(body, 'RX_Date', existing),
          mergedField(body, 'RX_Expiration', existing),
          mergedField(body, 'Report_Date', existing),
          mergedField(body, 'Scheduling_Notes', existing),
          mergedField(body, 'Status', existing),
          mergedField(body, 'SC_Admin_Phone', existing),
          mergedField(body, 'SC_Admin_Email', existing),
          mergedField(body, 'Google_Link', existing),
          id,
        ]
      );
      // Patients are referenced by name (not id) on Appointments, so a rename
      // has to cascade or existing appointment history silently detaches.
      if (oldName !== newName) {
        await client.query('UPDATE "Appointments" SET patient_name=$1 WHERE patient_name=$2', [newName, oldName]);
      }
      const withAlerts = (await hasAlertColumns(db)) ? await saveAlertFields(client, id, body, existing) : null;
      await client.query('COMMIT');
      return json(200, withAlerts || updateRes.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  if (path.match(/^\/patients\/[^/]+$/) && method === 'DELETE') {
    const id = path.split('/').pop();
    const patientRes = await db.query('SELECT "Name" FROM "Patients" WHERE id=$1', [id]);
    const name = patientRes.rows[0]?.Name;
    if (!name) return json(404, { error: 'Patient not found' });

    // A patient with any real appointment history is a real clinical
    // record, not a mistaken entry -- unlike before, there is no force
    // override here. Deleting it would permanently erase treatment history,
    // parent contact info, and program dates with no way to recover them.
    // Setting Status to "Off Program" already exists for exactly this
    // situation (a patient no longer being seen) and keeps the record intact.
    const countRes = await db.query(
      'SELECT COUNT(*)::int AS count FROM "Appointments" WHERE patient_name=$1',
      [name]
    );
    if (countRes.rows[0].count > 0) {
      return json(409, {
        error: 'This patient has appointment history and cannot be deleted. Set their status to Off Program instead to keep their record.',
        linkedCount: countRes.rows[0].count,
        blocked: true,
      });
    }
    await db.query('DELETE FROM "Patients" WHERE id=$1', [id]);
    return json(200, { deleted: true });
  }

  return null;
}

module.exports = { handle };
