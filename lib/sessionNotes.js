// EI session notes (the "ei" feature, PedsDesk only; Kieran, Oct 2026;
// migrations/2026-11-05_ei_session_notes.sql, routes/sessionNotes.js).
//
// Follows the NYC EI Individual Session Note (June 2025) and its
// instructions: every EI session gets a note, a canceled one too (with the
// reason and a make-up-by date two weeks on). The parent or caregiver draws
// two signatures on the provider's device (the note, and the service log
// NYC also requires; typed signatures aren't accepted), and the provider
// draws theirs with their license #. The content locks at the first
// signature; corrections are dated addenda. EI billing won't claim a
// session until its note is signed by both (routes/eiHub.js claimData).
//
// A session is found by the same key as EI-Hub billing (routes/billing.js
// sessionKey): 'appt:<id>' or 'series:<series id>:<date>'.
//
// Also (migrations/2026-11-07_ei_compliance.sql): group sessions (the NYC
// Group Session Note: question 3 only for parent-child and family support
// groups), a supervisor's co-signature within 45 days for a provider
// working under supervision (Providers.supervisor_name), and a secure link
// so a telehealth parent signs on their own device. An evaluation
// (Appointments.is_eval) takes an evaluation report instead of a note.
const { getMergedAppointments } = require('./recurring');
const patientPrograms = require('./patientPrograms');
const history = require('./eiHistory');
const { codesFor } = require('./eiHubCodes');
const { typeOf } = require('./credentialTypes');
const { clinicToday, isHold } = require('./caseload');
const { sessionKey, eiServiceFor, settingOf, disciplinesOf, SESSION_KEY_RE } = require('../routes/billing');

// NYC: a missed session is made up within two weeks.
const MAKEUP_DAYS = 14;
const MAX_SIGNATURE = 300000; // a drawn signature as a PNG data URL (as Power Forms)
const PARENT_METHODS = ['observed', 'tried_feedback', 'demonstrated', 'communication_tool', 'other'];
const PARTICIPANTS = ['child', 'parent', 'other'];
const LOCATIONS = ['home', 'community', 'facility'];
const DELIVERY = ['in_person', 'telehealth'];
const MISSED = ['Canceled', 'No Show'];
const GROUP_TYPES = ['group', 'parent_child', 'family_support'];
const GROUP_DURATIONS = [60, 90, 120];
// NYC: the supervisor co-signs within 45 days of the provider.
const COSIGN_DAYS = 45;

const day10 = (v) => (v ? String(v).slice(0, 10) : null);
const pad = (n) => String(n).padStart(2, '0');
const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const toTime = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
function addDays(s, n) { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// The session's setting as NYC's IFSP service location: in-office rooms and
// offsite Center are the facility; School (day care) is community; Home.
const LOCATION_OF_SETTING = { C: 'facility', S: 'community', H: 'home' };

// The appointment (real or a weekly series' occurrence) for a key, or null.
async function findSession(db, key) {
  if (!SESSION_KEY_RE.test(String(key || ''))) return null;
  let date;
  let provider = null;
  if (key.startsWith('appt:')) {
    const row = (await db.query('SELECT appointment_date, provider FROM "Appointments" WHERE id::text=$1 AND deleted = false', [key.slice(5)])).rows[0];
    if (!row) return null;
    date = day10(row.appointment_date);
    provider = row.provider;
  } else {
    date = key.split(':')[2];
    const series = (await db.query('SELECT provider FROM "RecurringSeries" WHERE id::text=$1', [key.split(':')[1]])).rows[0];
    if (!series) return null;
    provider = series.provider;
  }
  const appts = await getMergedAppointments(db, { startDate: date, endDate: date, provider });
  return appts.find(a => sessionKey(a) === key) || null;
}

// A provider's license # from their credentials (as the provider
// directory): the License Number credential's notes, else License/Registration's.
async function licenseFor(db, provider) {
  const staff = (await db.query('SELECT username FROM "Staff" WHERE provider_name=$1 AND archived=false LIMIT 1', [provider])).rows[0];
  if (!staff) return null;
  const creds = (await db.query('SELECT credential_name, notes FROM "StaffCredentials" WHERE username=$1', [staff.username])).rows;
  const pick = (t) => creds.find(c => typeOf(c.credential_name) === t && String(c.notes || '').trim());
  return String((pick('License Number') || pick('License/Registration') || {}).notes || '').trim() || null;
}

// Everything the note's header needs, worked out now. `ei` is false when
// the session doesn't bill under EI (no note is kept for it).
async function sessionInfo(db, a) {
  const date = day10(a.appointment_date);
  const patient = (await db.query('SELECT id, "Name", "Date_of_Birth", "ID_Number", "Program", "Parent_Name", "Relationship_To_Patient" FROM "Patients" WHERE "Name"=$1', [a.patient_name])).rows[0];
  if (!patient || isHold(a.patient_name) || a.appointment_status === '*HOLD*') return { ei: false };
  if (a.is_eval) return { ei: false, eval: true };
  const prov = (await db.query('SELECT * FROM "Providers" WHERE "Name"=$1', [a.provider])).rows[0] || {};
  const programs = await patientPrograms.historyFor(db, [patient.id]);
  const ei = eiServiceFor(programs[patient.id], date, disciplinesOf(prov.specialty), patient.Program);
  if (!ei) return { ei: false };

  const versions = (await history.versionsFor(db, 'child', [patient.id]))[patient.id] || [];
  const child = history.versionOn(versions, date) || {};
  const override = (await db.query('SELECT codes FROM "EiSessionCodes" WHERE session_key=$1', [sessionKey(a)]).catch(() => ({ rows: [] }))).rows[0]?.codes || null;
  const duration = Number(a.duration) || 30;
  const codes = ei.service ? codesFor(ei.service, duration, prov.ei_default_codes || {}, override) : [];
  const license = await licenseFor(db, a.provider);
  // The IFSP outcomes in effect on the session date (routes/ifsp.js).
  let outcomes = [];
  const ifsp = (await db.query(
    `SELECT id, ifsp_type FROM "EiIfsps" WHERE patient_id=$1 AND start_date <= $2 AND (end_date IS NULL OR end_date >= $2)
     ORDER BY start_date DESC, id DESC LIMIT 1`, [patient.id, date]
  ).catch(() => ({ rows: [] }))).rows[0];
  if (ifsp) {
    outcomes = (await db.query('SELECT id, position, outcome, services FROM "EiIfspOutcomes" WHERE ifsp_id=$1 ORDER BY position, id', [ifsp.id]))
      .rows.map((o, i) => ({ id: o.id, number: i + 1, outcome: o.outcome, services: o.services }));
  }
  const missedFor = a.makeup_for
    ? (await db.query('SELECT appointment_date FROM "Appointments" WHERE id=$1', [a.makeup_for])).rows[0]
    : null;
  const start = mins(a.appointment_time);
  const cancelled = MISSED.includes(a.appointment_status);
  const isSI = ei.service === 'SI';
  return {
    ei: true,
    key: sessionKey(a),
    patient,
    date,
    start_time: toTime(start),
    end_time: toTime(start + duration),
    duration,
    provider: a.provider,
    service: ei.service,
    service_options: ei.options,
    status: a.appointment_status,
    cancelled,
    makeup_by: cancelled ? addDays(date, MAKEUP_DAYS) : null,
    makeup_for_date: a.is_makeup ? day10(missedFor?.appointment_date) : null,
    location: LOCATION_OF_SETTING[settingOf(a.treatment_area)] || null,
    supervisor: prov.supervisor_name || null,
    ifsp: ifsp ? { id: ifsp.id, type: ifsp.ifsp_type } : null,
    outcomes,
    header: {
      child_name: [child.first_name, child.last_name].filter(Boolean).join(' ') || patient.Name,
      date_of_birth: history.day(child.date_of_birth) || day10(patient.Date_of_Birth),
      sex: child.sex || null,
      ei_number: child.ei_child_id || patient.ID_Number || null,
      interventionist: [prov.ei_first_name || prov.first_name, prov.ei_last_name || prov.last_name].filter(Boolean).join(' ') || a.provider,
      credentials: prov.credentials || null,
      npi: prov.npi || null,
      license,
      service: ei.service,
      icd10: child.diagnosis_codes || null,
      cpt_codes: isSI ? [] : codes,
      hcpcs_codes: isSI ? codes : [],
    },
    parent_hint: { name: patient.Parent_Name || null, relationship: patient.Relationship_To_Patient || null },
  };
}

// Checks the provider's draft. Returns { value } or { error }.
function cleanDraft(body, info) {
  const b = body || {};
  const text = (v, max) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);
  const pickAll = (v, allowed) => [...new Set((Array.isArray(v) ? v : []).map(String))].filter(x => allowed.includes(x));
  const outcomeIds = [...new Set((Array.isArray(b.outcome_ids) ? b.outcome_ids : []).map(Number))]
    .filter(id => info.outcomes.some(o => o.id === id));
  const location = LOCATIONS.includes(b.location) ? b.location : null;
  const groupType = GROUP_TYPES.includes(b.group_type) ? b.group_type : null;
  const int = (v) => (Number.isInteger(Number(v)) && v !== '' && v !== null && v !== undefined ? Number(v) : null);
  const children = int(b.group_children);
  const length = int(b.group_duration);
  const delivery = DELIVERY.includes(b.delivery) ? b.delivery : null;
  return {
    value: {
      location, delivery,
      participants: pickAll(b.participants, PARTICIPANTS),
      participants_other: text(b.participants_other, 300),
      outcome_ids: outcomeIds,
      outcomes_text: text(b.outcomes_text, 4000),
      narrative: text(b.narrative, 12000),
      parent_methods: pickAll(b.parent_methods, PARENT_METHODS),
      parent_methods_other: text(b.parent_methods_other, 1000),
      strategies: text(b.strategies, 6000),
      group_type: groupType,
      group_children: groupType && children >= 2 && children <= 10 ? children : null,
      group_duration: groupType && GROUP_DURATIONS.includes(length) ? length : null,
      group_site: groupType ? text(b.group_site, 300) : null,
      aide_name: groupType ? text(b.aide_name, 200) : null,
      aide_notes: groupType ? text(b.aide_notes, 4000) : null,
    },
  };
}

// What's still missing before the provider can sign ([] = ready). NYC: all
// fields are mandatory. A canceled session needs only the reason.
function missingForSigning(note) {
  const n = note || {};
  if (n.cancelled) return n.outcomes_text ? [] : ['Why the session was canceled (question 1)'];
  const out = [];
  if (!n.location) out.push('Where the session was (home, community or facility)');
  if (!n.delivery) out.push('In person or telehealth');
  if (!(n.participants || []).length) out.push('Who took part');
  if ((n.participants || []).includes('other') && !n.participants_other) out.push('Who else took part');
  if (!(n.outcome_ids || []).length && !n.outcomes_text) out.push('The IFSP outcomes worked on (question 1)');
  if (n.group_type) {
    if (!n.group_children) out.push('How many children were in the group (2 to 10)');
    if (!n.group_duration) out.push('How long the group ran (60, 90 or 120 minutes)');
    if (!n.group_site) out.push('Where the group met');
  }
  if (!n.narrative) out.push('What happened in the session (question 2)');
  // A children-only group has no parent in the room: no question 3.
  const parentQ = !n.group_type || n.group_type !== 'group';
  if (parentQ && !(n.parent_methods || []).length) out.push('How you worked with the parent or caregiver (question 3)');
  if (parentQ && (n.parent_methods || []).includes('other') && !n.parent_methods_other) out.push('Describe "Other" for question 3');
  if (!n.strategies) out.push(n.group_type ? 'The strategies for the family between visits (question 4)' : 'The strategies agreed for between visits (question 4)');
  return out;
}

const validSignature = (v) => typeof v === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(v) && v.length <= MAX_SIGNATURE;

// A note's state for lists and billing.
function noteStatus(note) {
  if (!note) return 'none';
  const cosigned = !note.supervisor_name || !!note.supervisor_signed_at;
  if (note.cancelled) return note.provider_signed_at ? (cosigned ? 'complete' : 'needs_supervisor') : 'draft';
  if (note.provider_signed_at && note.parent_signed_at) return cosigned ? 'complete' : 'needs_supervisor';
  if (note.provider_signed_at) return 'needs_parent';
  if (note.parent_signed_at) return 'needs_provider';
  return 'draft';
}

// Session keys (of these) whose note is complete: signed by the provider,
// for a session that took place by the parent (note + service log), and by
// the supervisor when the provider works under one.
async function completeNoteKeys(db, keys) {
  if (!keys.length) return new Set();
  const r = await db.query(
    `SELECT session_key FROM "EiSessionNotes" WHERE session_key = ANY($1) AND provider_signed_at IS NOT NULL
       AND (cancelled OR parent_signed_at IS NOT NULL) AND (supervisor_name IS NULL OR supervisor_signed_at IS NOT NULL)`, [keys]
  );
  return new Set(r.rows.map(x => x.session_key));
}

module.exports = {
  MAKEUP_DAYS, COSIGN_DAYS, PARENT_METHODS, PARTICIPANTS, LOCATIONS, DELIVERY, GROUP_TYPES, GROUP_DURATIONS,
  findSession, sessionInfo, licenseFor, cleanDraft, missingForSigning, validSignature, noteStatus, completeNoteKeys, clinicToday,
};
