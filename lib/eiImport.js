// Importing EI-Hub's "Child Info and Authorizations" report (Oct 2026;
// routes/eiHub.js POST /ei-hub/import/preview and /apply). The browser reads
// the Excel or CSV file and sends its header and rows; nothing is kept but
// what's applied. One row per service authorization, the child's details
// repeated on each.
//
// preview() compares the file with Kidz Lounge and lists every proposed
// change, each with an id; the person ticks which to apply (Kieran: "show me
// first"), and apply() works the preview out again from the same file (so
// it can't apply something stale) and saves the ticked ones in one
// transaction:
//   link      a child whose EI child ID isn't on any patient, matched by name
//             and date of birth: sets the patient's ID #
//   child     the child's EI-Hub details (name, DOB, sex, address, county):
//             a new dated version from today (lib/eiHistory.js), or the first
//   auth      an authorization record ("EiAuthorizations"): dates, service,
//             sessions authorized / used / remaining, make-ups, therapist
//   referral  the referring provider on an authorization: dated like EI
//             details (from the start for the first, else from today)
//   ifsp      the patient's IFSP type and dates (and so the report date)
//   sc        the patient's service coordinator name, phone and email
//   mandate   the patient's EI mandate for a service (the patient form's EI
//             tab): sessions per week x minutes and the auth #, from the
//             authorization in effect today (or the next one), dated from
//             its start; the service is added to the patient's Services
// Diagnosis codes aren't in the report, so they're kept as they are.
//
// Only children with a session in Kidz Lounge (any appointment, past or
// future, one-off or weekly) are imported, and then every row for them
// (Kieran, Oct 2026). This replaced matching the Therapist NPI against our
// providers' NPIs, which left children out whenever an NPI wasn't entered
// in Setup. Children with no sessions are left out and counted; children
// with no patient at all are listed to match by hand.

const history = require('./eiHistory');
const patientPrograms = require('./patientPrograms');
const { COUNTY_CODES } = require('./eiHubCodes');

// The report's columns (as EI-Hub names them) -> our keys. Matched loosely
// (case, spaces and punctuation ignored) in case EI-Hub tweaks the wording.
const COLUMNS = {
  'EI Child ID': 'ei_child_id', 'Child First Name': 'first', 'Child Middle Name': 'middle', 'Child Last Name': 'last', 'DOB': 'dob',
  'Child Address': 'address', 'Child City': 'city', 'Child State': 'state', 'Child Zip': 'zip', 'Sex': 'sex', 'County of Residence': 'county', 'Child Status': 'child_status',
  'Service Coordinator First Name': 'sc_first', 'Service Coordinator Last Name': 'sc_last', 'Service Coordinator Company': 'sc_company',
  'Service Coordinator Phone': 'sc_phone', 'Service Coordinator Email': 'sc_email',
  'Program': 'program', 'Enrollment Type': 'enrollment_type', 'Enrollment Status': 'enrollment_status', 'Authorization Number': 'authorization_number',
  'Start Date': 'start_date', 'End Date': 'end_date', 'Location Type': 'location_type', 'Suspended Start Date': 'suspended_start', 'Suspended End Date': 'suspended_end',
  'Length': 'length', 'Frequency': 'frequency', 'Frequency Unit': 'frequency_unit', 'Visits Per Day': 'visits_per_day',
  'IFSP Type': 'ifsp_type', 'IFSP Status': 'ifsp_status', 'IFSP Start Date': 'ifsp_start', 'IFSP End Date': 'ifsp_end',
  'Therapist First Name': 'therapist_first', 'Therapist Last Name': 'therapist_last', 'Therapist NPI': 'therapist_npi',
  'Referring Provider First Name': 'ref_first', 'Referring Provider Last Name': 'ref_last', 'Referring Provider NPI': 'ref_npi',
  'Last Session Date': 'last_session_date', 'Total Sessions Authorized': 'sessions_authorized', 'Total Sessions Used': 'sessions_used',
  'Number of Remaining Units/Sessions': 'sessions_remaining',
  'Number of Make-Up Session/Units Authorized': 'makeups_authorized', 'Total Make-Up Session/Units Used': 'makeups_used', 'Make-Up Units Remaining': 'makeups_remaining',
  'Total CoVisit Units': 'covisits_authorized', 'Co-Visit Units Used': 'covisits_used', 'Co-Visit Units Remaining': 'covisits_remaining',
};
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const BY_SQUASHED = Object.fromEntries(Object.entries(COLUMNS).map(([h, k]) => [squash(h), k]));
const DATE_KEYS = new Set(['dob', 'start_date', 'end_date', 'suspended_start', 'suspended_end', 'ifsp_start', 'ifsp_end', 'last_session_date']);
const MAX_ROWS = 5000;

const pad = (n) => String(n).padStart(2, '0');
const txt = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};
const num = (v) => {
  const s = txt(v);
  if (s === null) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
// 'YYYY-MM-DD', 'MM/DD/YYYY' (or with a time after it), or an Excel date
// number (days since 1899-12-30).
function dateOf(v) {
  const s = txt(v);
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n < 1 || n > 100000) return null;
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000).toISOString().slice(0, 10);
  }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})\b/);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${pad(m[1])}-${pad(m[2])}`;
  // "Oct 1, 2026", "1-Oct-2026", "October 1 2026"
  if (/[a-z]{3}/i.test(s)) {
    const d = new Date(s.replace(/-/g, ' '));
    if (!Number.isNaN(d.getTime())) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return null;
}
// EI child IDs compared as digits without leading zeros (Excel may drop them).
const idKey = (v) => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
const nameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const splitName = (n) => { const p = String(n || '').trim().split(/\s+/); return { first: p[0] || '', last: p.slice(1).join(' ') }; };

// Name words, for matching "Ava Marie Brown" / "Brown, Ava" / "Ava Brown-Lee"
// to EI-Hub's first and last name.
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z\s,'-]/g, '').replace(/'/g, '').split(/[\s,-]+/).filter(Boolean);
const dobFits = (p, r) => !r.dob || !p.Date_of_Birth || history.day(p.Date_of_Birth) === r.dob;
// Patients who are this child, by name and date of birth: exactly the same
// name first; else every part of EI-Hub's last name and its first name
// (first word) somewhere in the patient's name; else the same last name and
// date of birth (a nickname). The first test with one answer wins.
function nameMatches(patients, r) {
  const first = words(r.first);
  const last = words(r.last);
  if (!first.length || !last.length) return [];
  const exact = patients.filter(p => nameKey(p.Name) === nameKey(`${r.first}${r.last}`) && dobFits(p, r));
  if (exact.length) return exact;
  const loose = patients.filter(p => { const w = words(p.Name); return w.includes(first[0]) && last.every(x => w.includes(x)) && dobFits(p, r); });
  if (loose.length) return loose;
  if (!r.dob) return [];
  return patients.filter(p => { const w = words(p.Name); return last.every(x => w.includes(x)) && p.Date_of_Birth && history.day(p.Date_of_Birth) === r.dob; });
}
// Likely patients for a child that couldn't be matched (same last name, or
// same date of birth), to pick from in the review.
function suggestionsFor(patients, r) {
  const last = words(r.last);
  return patients
    .filter(p => { const w = words(p.Name); return (last.length && last.some(x => w.includes(x))) || (r.dob && p.Date_of_Birth && history.day(p.Date_of_Birth) === r.dob); })
    .slice(0, 8)
    .map(p => ({ id: p.id, name: p.Name, date_of_birth: history.day(p.Date_of_Birth) }));
}

// "Speech Language - Facility" -> ST (the part before " - " is the service,
// the rest is where).
function serviceOf(program) {
  const s = String(program || '').split(' - ')[0].toLowerCase();
  if (/speech|\bslp\b|\bst\b/.test(s)) return 'ST';
  if (/occupational|\bot\b/.test(s)) return 'OT';
  if (/physical|\bpt\b/.test(s)) return 'PT';
  if (/special\s*instruction|special\s*ed|\bseit\b|\bsi\b/.test(s)) return 'SI';
  return null;
}
// The street part of EI-Hub's address line: some have the city, state, ZIP
// and county crammed onto the end ("15 1ST ST HOWARD BEACH NY 11414
// QUEENS"), which would go onto claims as the street. Those are trimmed off
// when they repeat the row's own city / state / ZIP / county columns (or
// are NY / a ZIP / an NYC borough); never down to nothing.
function streetOnly(r) {
  let a = String(txt(r.address) || '').replace(/\s+/g, ' ').trim();
  if (!a) return null;
  const tails = [txt(r.county), txt(r.city), txt(r.state), 'NY', 'New York', 'Queens', 'Kings', 'Bronx', 'Richmond', 'Brooklyn', 'Manhattan', 'Staten Island']
    .filter(Boolean).map(x => x.toLowerCase());
  for (let i = 0; i < 8; i++) {
    const before = a;
    a = a.replace(/[\s,]+$/, '');
    const zip = a.match(/^(.*\S)[\s,]+\d{5}(-?\d{4})?$/);
    if (zip) { a = zip[1]; continue; }
    const hit = tails.find(t => a.toLowerCase().endsWith(` ${t}`) && a.length > t.length + 4);
    if (hit) a = a.slice(0, a.length - hit.length);
    if (a === before) break;
  }
  a = a.replace(/[\s,]+$/, '');
  return a || txt(r.address);
}

// "New York" -> NY (EI-Hub may write the state out); a 2-letter code as is.
const STATES = { newyork: 'NY', newjersey: 'NJ', connecticut: 'CT', pennsylvania: 'PA', massachusetts: 'MA', vermont: 'VT', florida: 'FL' };
function stateOf(v) {
  const s = txt(v);
  if (!s) return null;
  if (/^[a-z]{2}$/i.test(s)) return s.toUpperCase();
  return STATES[squash(s)] || s;
}
// ZIP digits; Excel drops a leading zero (07030 -> 7030).
function zipOf(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  if (!d) return null;
  return d.length === 4 || d.length === 8 ? `0${d}` : d;
}
// NYC's boroughs are its counties; EI-Hub bills them all as New York City.
const NYC = new Set(['newyorkcity', 'nyc', 'bronx', 'kings', 'newyork', 'queens', 'richmond', 'brooklyn', 'manhattan', 'statenisland']);
function countyOf(v) {
  const s = txt(v);
  if (!s) return null;
  const k = squash(s.replace(/\s+county$/i, ''));
  if (NYC.has(k)) return 'New York City';
  return Object.keys(COUNTY_CODES).find(c => squash(c) === k) || undefined;
}
function phoneOf(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : txt(v);
}
const fmtDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const clinicToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const sameNum = (a, b) => (a === null || a === undefined || a === '' ? null : Number(a)) === (b === null || b === undefined || b === '' ? null : Number(b));

// An authorization's mandate: { sessions, minutes } (either may be null
// when EI-Hub's Frequency / Length can't be read as per week / minutes).
function mandateOf(r) {
  const len = String(r.length ?? '').trim();
  let minutes = null;
  const hm = len.match(/^(\d{1,2}):(\d{2})/);
  if (hm) minutes = Number(hm[1]) * 60 + Number(hm[2]);
  else if (/^\d+(\.\d+)?/.test(len)) minutes = Math.round(Number(len.match(/^\d+(\.\d+)?/)[0]) * (/hour|hr/i.test(len) ? 60 : 1));
  if (!(minutes >= 5 && minutes <= 240)) minutes = null;
  // "2", "2.00", "2.0" per "Week" / "Weekly" / "Per Week" / "Wk" / "W" (or no unit).
  const freq = String(r.frequency ?? '').trim();
  const unit = String(r.frequency_unit ?? '').trim();
  const fm = freq.match(/^(\d{1,2})(\.0+)?$/);
  const weekly = !unit || /week|\bwk|^w$/i.test(unit);
  const sessions = fm && weekly && Number(fm[1]) > 0 ? String(Number(fm[1])) : null;
  return { sessions, minutes };
}
const mandateLabel = (m) => (m && m.sessions && m.minutes ? `${m.sessions} × ${m.minutes} min a week` : null);

// { headers: [...], rows: [[...], ...] } -> { rows: [{ key: value }] } or { error }.
function readRows(payload) {
  const headers = Array.isArray(payload?.headers) ? payload.headers : null;
  const raw = Array.isArray(payload?.rows) ? payload.rows : null;
  if (!headers || !raw) return { error: 'Choose the Child Info and Authorizations file.' };
  const keys = headers.map(h => BY_SQUASHED[squash(h)] || null);
  if (!keys.includes('ei_child_id') || !keys.includes('authorization_number')) {
    return { error: 'This doesn\'t look like EI-Hub\'s Child Info and Authorizations report: it has no "EI Child ID" or "Authorization Number" column.' };
  }
  if (raw.length > MAX_ROWS) return { error: `The file has ${raw.length} rows; up to ${MAX_ROWS} can be imported at once.` };
  const rows = [];
  for (const r of raw) {
    if (!Array.isArray(r)) continue;
    const o = {};
    keys.forEach((k, i) => { if (k) o[k] = DATE_KEYS.has(k) ? dateOf(r[i]) : r[i]; });
    if (!txt(o.ei_child_id)) continue; // blank or total rows
    rows.push(o);
  }
  if (!rows.length) return { error: 'The file has no children in it.' };
  return { rows };
}

const AUTH_FIELDS = [
  ['service', 'Service'], ['program', 'Program'], ['location_type', 'Location'], ['enrollment_status', 'Enrollment status'],
  ['start_date', 'Starts'], ['end_date', 'Ends'], ['suspended_start', 'Suspended from'], ['suspended_end', 'Suspended to'],
  ['length', 'Length'], ['frequency', 'Frequency'], ['frequency_unit', 'Per'],
  ['sessions_authorized', 'Sessions authorized'], ['sessions_used', 'Sessions used'], ['sessions_remaining', 'Sessions remaining'],
  ['makeups_authorized', 'Make-ups authorized'], ['makeups_used', 'Make-ups used'],
  ['therapist_npi', 'Therapist NPI'], ['last_session_date', 'Last session'],
];
const NUMERIC_AUTH = new Set(['sessions_authorized', 'sessions_used', 'sessions_remaining', 'makeups_authorized', 'makeups_used', 'makeups_remaining', 'covisits_authorized', 'covisits_used', 'covisits_remaining']);
const CHILD_LABELS = {
  ei_child_id: 'EI child ID', first_name: 'First name in EI-Hub', last_name: 'Last name in EI-Hub', date_of_birth: 'Date of birth in EI-Hub',
  sex: 'Sex', address_line1: 'Address', address_line2: 'Address line 2', city: 'City', state: 'State', zip: 'ZIP code', county: 'County',
};

// Everything the file would change. `deps` are routes/eiHub.js helpers:
// cleanChild (the same checks as a typed change) and cleanReferral.
async function preview(db, payload, deps) {
  const read = readRows(payload);
  if (read.error) return { error: read.error };
  const today = clinicToday();
  const withLock = await hasIdLock(db);
  const [patientsRes, detailsRes] = await Promise.all([
    db.query(`SELECT id, "Name", "Date_of_Birth", "ID_Number", "IFSP_Type", "IFSP_Start_Date", "IFSP_End_Date",
                     "SC_Admin_Name", "SC_Admin_Phone", "SC_Admin_Email"${withLock ? ', ei_id_locked_at' : ''} FROM "Patients"`),
    db.query('SELECT patient_id, ei_child_id FROM "PatientEiDetails" WHERE end_date IS NULL'),
  ]);
  const patients = patientsRes.rows;
  // EI child ID -> patient: a locked ID first (it came from EI-Hub and is
  // the one to refer back to), then the current EI details, then the ID #.
  const byId = new Map();
  patients.forEach(p => { const k = idKey(lockedId(p)); if (k) byId.set(k, p); });
  detailsRes.rows.forEach(d => { const k = idKey(d.ei_child_id); if (k && !byId.has(k)) byId.set(k, patients.find(p => p.id === d.patient_id)); });
  patients.forEach(p => { const k = idKey(p.ID_Number); if (k && !byId.has(k)) byId.set(k, p); });
  // A patient whose ID is locked is never matched to a different EI child ID
  // (by name or by hand): that would be another child's data.
  const open = (k) => (p) => !lockedId(p) || idKey(lockedId(p)) === k;

  // Children the person matched to a patient by hand: { child id key: patient id }.
  const chosen = payload && typeof payload.matches === 'object' && payload.matches ? payload.matches : {};

  // The file's children, each with their authorization rows.
  const children = new Map();
  for (const r of read.rows) {
    const k = idKey(r.ei_child_id);
    if (!children.has(k)) children.set(k, []);
    children.get(k).push(r);
  }

  const changes = [];
  const unmatched = [];
  const problems = [];
  // One entry per patient, however many EI child IDs lead to them: EI-Hub
  // can list a child under two IDs (e.g. a re-referral), one matching the
  // ID # and one by name. Handled as two, their EI details were saved twice
  // in one import and the second failed ("Choose the date the change takes
  // effect"). The rows are merged, newest authorization first.
  const byPatient = new Map(); // patient id -> { patient, rows, linkedIds: Set, ids: Set }
  for (const [k, rows] of children) {
    const r0 = rows[0];
    let patient = byId.get(k);
    let linked = false;
    // Picked by the person in the review ("Match to patient").
    const free = patients.filter(open(k));
    if (!patient && chosen[k]) { patient = free.find(p => p.id === chosen[k]) || null; linked = !!patient; }
    if (!patient) {
      // Not by ID: by name and date of birth, if exactly one patient fits.
      const fits = nameMatches(free, r0);
      if (fits.length === 1) { patient = fits[0]; linked = true; }
    }
    const name = [txt(r0.first), txt(r0.last)].filter(Boolean).join(' ');
    if (!patient) {
      unmatched.push({ key: k, ei_child_id: txt(r0.ei_child_id), name, date_of_birth: r0.dob, authorizations: rows.length,
        suggestions: suggestionsFor(free, r0) });
      continue;
    }
    if (!byPatient.has(patient.id)) byPatient.set(patient.id, { patient, rows: [], linkedIds: new Set(), ids: new Set() });
    const entry = byPatient.get(patient.id);
    entry.rows.push(...rows);
    entry.ids.add(txt(r0.ei_child_id));
    if (linked) entry.linkedIds.add(k);
  }
  // Children with a session in Kidz Lounge: appointments (not deleted) or a
  // weekly series, any date.
  const names = [...byPatient.values()].map(e => e.patient.Name);
  const withSessions = new Set(names.length ? (await db.query(
    `SELECT DISTINCT patient_name FROM "Appointments" WHERE patient_name = ANY($1) AND COALESCE(deleted, false) = false
     UNION SELECT DISTINCT patient_name FROM "RecurringSeries" WHERE patient_name = ANY($1)`, [names]
  )).rows.map(x => x.patient_name) : []);
  const skipped = { no_sessions: 0, rows: 0 };
  let rowsUsed = 0;
  const matched = []; // [patient, rows, linked]
  for (const { patient, rows, linkedIds, ids } of byPatient.values()) {
    if (!withSessions.has(patient.Name)) { skipped.no_sessions += 1; skipped.rows += rows.length; continue; }
    rowsUsed += rows.length;
    rows.sort((a, b) => String(b.start_date || '').localeCompare(String(a.start_date || '')));
    const primary = txt(rows[0].ei_child_id);
    if (ids.size > 1) {
      problems.push({ patient_id: patient.id, patient_name: patient.Name, message: `EI-Hub lists this child under ${ids.size} EI child IDs (${[...ids].join(', ')}). Using ${primary}, from the newest authorization; check it's right.` });
    }
    // Set the ID # only when the ID being used was matched by name.
    matched.push([patient, rows, linkedIds.has(idKey(primary))]);
  }

  const authNumbers = [...new Set(matched.flatMap(([, rows]) => rows.map(r => txt(r.authorization_number)).filter(Boolean)))];
  const [childVersions, referralPeriods, authRes] = await Promise.all([
    history.versionsFor(db, 'child', matched.map(([p]) => p.id)),
    history.versionsFor(db, 'referral', authNumbers),
    authNumbers.length && deps.hasAuthTable
      ? db.query('SELECT * FROM "EiAuthorizations" WHERE authorization_number = ANY($1)', [authNumbers])
      : { rows: [] },
  ]);
  const existingAuth = Object.fromEntries(authRes.rows.map(a => [a.authorization_number, a]));
  const programRows = {};
  const [servicesRes] = await Promise.all([
    matched.length ? db.query('SELECT id, "Services" FROM "Patients" WHERE id = ANY($1)', [matched.map(([p]) => p.id)]) : { rows: [] },
  ]);
  const servicesOf = Object.fromEntries(servicesRes.rows.map(x => [x.id, x.Services]));
  if (matched.length && (await patientPrograms.hasProgramsTable(db))) {
    (await db.query('SELECT * FROM "PatientPrograms" WHERE patient_id = ANY($1) AND end_date IS NULL', [matched.map(([p]) => p.id)]))
      .rows.forEach(x => { (programRows[x.patient_id] = programRows[x.patient_id] || []).push(x); });
  }
  const programsOn = matched.length ? await patientPrograms.hasProgramsTable(db) : false;
  let unchanged = 0;

  for (const [patient, rows, linked] of matched) {
    const r0 = rows[0];
    const who = { patient_id: patient.id, patient_name: patient.Name, ei_child_id: txt(r0.ei_child_id) };
    const before = changes.length;
    if (linked) {
      changes.push({ id: `link:${patient.id}`, kind: 'link', ...who, title: 'Set the ID #',
        note: 'Matched by name and date of birth.', fields: [{ label: 'ID #', from: patient.ID_Number || null, to: txt(r0.ei_child_id) }], _apply: { id: txt(r0.ei_child_id) } });
    }

    // EI details: what EI-Hub has, over the current version.
    const versions = childVersions[patient.id] || [];
    const current = versions.find(v => !v.end_date) || null;
    const base = current ? Object.fromEntries(history.KINDS.child.fields.map(f => [f, f === 'date_of_birth' ? history.day(current[f]) : current[f]])) : {};
    const want = { ...base };
    const pn = splitName(patient.Name);
    const fieldChanges = [];
    const setIf = (field, value, effectiveCurrent) => {
      if (value === null || value === undefined || value === '') return;
      if (same(value, effectiveCurrent)) return;
      fieldChanges.push({ label: CHILD_LABELS[field], from: base[field] ?? null, to: value });
      want[field] = value;
    };
    setIf('ei_child_id', txt(r0.ei_child_id), base.ei_child_id ?? (current ? null : patient.ID_Number));
    setIf('first_name', txt(r0.first), base.first_name || pn.first);
    setIf('last_name', txt(r0.last), base.last_name || pn.last);
    setIf('date_of_birth', r0.dob, base.date_of_birth || history.day(patient.Date_of_Birth));
    const sex = txt(r0.sex) ? txt(r0.sex)[0].toUpperCase() : null;
    setIf('sex', sex === 'F' || sex === 'M' ? sex : null, base.sex);
    const addr = streetOnly(r0);
    if (addr && !same(addr, base.address_line1)) { setIf('address_line1', addr.slice(0, 55), base.address_line1); if (base.address_line2) { fieldChanges.push({ label: CHILD_LABELS.address_line2, from: base.address_line2, to: null }); want.address_line2 = null; } }
    setIf('city', txt(r0.city), base.city);
    setIf('state', stateOf(r0.state), base.state);
    setIf('zip', zipOf(r0.zip), base.zip);
    const county = countyOf(r0.county);
    if (county === undefined) problems.push({ ...who, message: `County "${txt(r0.county)}" isn't one EI-Hub billing knows. Check it on the chart's EI Billing tab.` });
    else setIf('county', county, base.county);
    // From when: the start of the child's authorization covering this or
    // last month (EI-Hub's details are what those sessions bill with), not
    // today -- dated today, this month's earlier sessions kept the old
    // details and the Sessions list looked as if nothing was imported. Never
    // before the current version starts (the same date corrects it instead).
    const monthAgo = (() => { const [y, m] = today.split('-').map(Number); const d = new Date(y, m - 2, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`; })();
    const recentStarts = rows.filter(r => r.start_date && r.start_date <= today && (!r.end_date || r.end_date >= monthAgo)).map(r => r.start_date).sort();
    const wantFrom = recentStarts[0] || today;
    let detailsFrom = wantFrom;
    if (current && current.start_date && history.day(current.start_date) > detailsFrom) detailsFrom = history.day(current.start_date);
    if (fieldChanges.length) {
      const cleaned = deps.cleanChild(want);
      if (cleaned.error) problems.push({ ...who, message: `EI details not imported: ${cleaned.error}` });
      else {
        changes.push({ id: `child:${patient.id}`, kind: 'child', ...who, title: current ? 'EI details changed' : 'EI details (first entry)',
          note: current ? `From ${fmtDay(detailsFrom)}; the earlier version is kept for sessions before then.` : 'Applies to all dates.',
          fields: fieldChanges, _apply: { values: cleaned.values, effective: current ? detailsFrom : null } });
      }
    } else {
      // Nothing new, but the details on file start after the authorization
      // (an earlier import dated them that day), so this month's earlier
      // sessions still use the version before: offer to start them sooner.
      const r = redate(versions, current, wantFrom);
      if (r) {
        changes.push({ id: `redate:child:${patient.id}`, kind: 'redate', ...who, title: 'EI details: use from the authorization start',
          note: `They start ${fmtDay(r.currentStart)}, so earlier sessions still use the details before them.`,
          fields: [{ label: 'EI details start', from: r.currentStart, to: wantFrom }], _apply: { table: 'child', id: current.id, prevId: r.prev.id, from: wantFrom } });
      }
    }

    // IFSP and service coordinator: from the row with the latest IFSP.
    const ifspRow = [...rows].sort((a, b) => String(b.ifsp_start || '').localeCompare(String(a.ifsp_start || '')))[0];
    const ifsp = [];
    const ifspWant = {};
    const cmp = (label, col, value) => {
      if (!value) return;
      const cur = col.endsWith('Date') ? history.day(patient[col]) : patient[col];
      if (!same(cur, value)) { ifsp.push({ label, from: cur || null, to: value }); ifspWant[col] = value; }
    };
    cmp('IFSP type', 'IFSP_Type', txt(ifspRow.ifsp_type));
    cmp('IFSP start date', 'IFSP_Start_Date', ifspRow.ifsp_start);
    cmp('IFSP end date', 'IFSP_End_Date', ifspRow.ifsp_end);
    if (ifsp.length) {
      changes.push({ id: `ifsp:${patient.id}`, kind: 'ifsp', ...who, title: 'IFSP',
        note: ifspWant.IFSP_End_Date ? 'The report date moves to 21 days before the new end date.' : null, fields: ifsp, _apply: ifspWant });
    }
    const sc = [];
    const scWant = {};
    const scCmp = (label, col, value) => { if (value && !same(patient[col], value)) { sc.push({ label, from: patient[col] || null, to: value }); scWant[col] = value; } };
    scCmp('SC name', 'SC_Admin_Name', [txt(r0.sc_first), txt(r0.sc_last)].filter(Boolean).join(' ') || null);
    scCmp('SC phone', 'SC_Admin_Phone', phoneOf(r0.sc_phone));
    scCmp('SC email', 'SC_Admin_Email', txt(r0.sc_email));
    if (sc.length) {
      changes.push({ id: `sc:${patient.id}`, kind: 'sc', ...who, title: 'Service coordinator',
        note: txt(r0.sc_company) ? `With ${txt(r0.sc_company)}.` : null, fields: sc, _apply: scWant });
    }

    // Each authorization, and its referring provider.
    for (const r of rows) {
      const auth = txt(r.authorization_number);
      if (!auth) continue;
      const rec = {
        patient_id: patient.id, ei_child_id: txt(r.ei_child_id), service: serviceOf(r.program), program: txt(r.program),
        location_type: txt(r.location_type), enrollment_type: txt(r.enrollment_type), enrollment_status: txt(r.enrollment_status),
        start_date: r.start_date, end_date: r.end_date, suspended_start: r.suspended_start, suspended_end: r.suspended_end,
        length: txt(r.length), frequency: txt(r.frequency), frequency_unit: txt(r.frequency_unit), visits_per_day: txt(r.visits_per_day),
        sessions_authorized: num(r.sessions_authorized), sessions_used: num(r.sessions_used), sessions_remaining: num(r.sessions_remaining),
        makeups_authorized: num(r.makeups_authorized), makeups_used: num(r.makeups_used), makeups_remaining: num(r.makeups_remaining),
        covisits_authorized: num(r.covisits_authorized), covisits_used: num(r.covisits_used), covisits_remaining: num(r.covisits_remaining),
        therapist_first: txt(r.therapist_first), therapist_last: txt(r.therapist_last), therapist_npi: txt(r.therapist_npi) && String(r.therapist_npi).replace(/\D/g, ''),
        last_session_date: r.last_session_date,
      };
      if (txt(r.program) && !rec.service) problems.push({ ...who, message: `Auth ${auth}: "${txt(r.program)}" isn't ST, OT, PT or SI, so it won't be used for billing.` });
      const old = existingAuth[auth];
      const diff = [];
      for (const [f, label] of AUTH_FIELDS) {
        const a = old ? (DATE_KEYS.has(f) ? history.day(old[f]) : old[f]) : null;
        const equal = NUMERIC_AUTH.has(f) ? sameNum(a, rec[f]) : same(a, rec[f]);
        if (!equal && (old || rec[f] !== null)) diff.push({ label, from: a ?? null, to: rec[f] ?? null });
      }
      if (old && old.patient_id !== patient.id) diff.unshift({ label: 'Child', from: 'another patient', to: patient.Name });
      if (!old || diff.length) {
        changes.push({ id: `auth:${auth}`, kind: 'auth', ...who, authorization_number: auth,
          title: `${old ? 'Authorization updated' : 'New authorization'}: ${rec.service || 'service?'} ${auth}`, fields: diff, _apply: rec });
      }

      if (txt(r.ref_last) || txt(r.ref_npi)) {
        const cleaned = deps.cleanReferral({ referring_last: txt(r.ref_last), referring_first: txt(r.ref_first), referring_npi: r.ref_npi });
        if (cleaned.error) { problems.push({ ...who, message: `Auth ${auth} referring provider not imported: ${cleaned.error}` }); continue; }
        const periods = referralPeriods[auth] || [];
        const cur = history.versionOn(periods, today) || periods.find(p => !p.end_date) || null;
        const v = cleaned.values;
        // From the authorization's start (the referral is for it), not before
        // the latest referring provider on file starts.
        const latestStart = periods.length ? history.day(periods[periods.length - 1].start_date) : null;
        const refWant = r.start_date || today;
        let refFrom = refWant;
        if (latestStart && latestStart > refFrom) refFrom = latestStart;
        if (!cur || !same(cur.referring_last, v.referring_last) || !same(cur.referring_first, v.referring_first) || cur.referring_npi !== v.referring_npi) {
          const show = (p) => (p ? `${[p.referring_first, p.referring_last].filter(Boolean).join(' ')} (NPI ${p.referring_npi})` : null);
          changes.push({ id: `referral:${auth}`, kind: 'referral', ...who, authorization_number: auth, title: `Referring provider: ${rec.service || ''} ${auth}`.replace('  ', ' '),
            note: periods.length ? `From ${fmtDay(refFrom)}; the earlier one is kept for sessions before then.` : 'For the whole authorization.',
            fields: [{ label: 'Referring provider', from: show(cur), to: show(v) }], _apply: { values: v, effective: periods.length ? refFrom : null } });
        } else {
          const latest = periods.find(x => !x.end_date) || null;
          const rd = latest && latest.id === cur.id ? redate(periods, latest, refWant) : null;
          if (rd) {
            changes.push({ id: `redate:referral:${auth}`, kind: 'redate', ...who, authorization_number: auth, title: `Referring provider ${auth}: use from the authorization start`,
              note: `It starts ${fmtDay(rd.currentStart)}, so earlier sessions still use the one before it.`,
              fields: [{ label: 'Referring provider starts', from: rd.currentStart, to: refWant }], _apply: { table: 'referral', id: latest.id, prevId: rd.prev.id, from: refWant } });
          }
        }
      }
    }
    // The EI mandate per service, from the authorization in effect today,
    // else the next one to start (ended ones are history: left alone).
    if (programsOn) {
      const current = programRows[patient.id] || [];
      const services = String(servicesOf[patient.id] || '').split(',').map(x => x.trim()).filter(Boolean);
      for (const service of [...new Set(rows.map(r => serviceOf(r.program)).filter(Boolean))]) {
        const forService = rows.filter(r => serviceOf(r.program) === service && txt(r.authorization_number));
        const now = forService.find(r => (!r.start_date || r.start_date <= today) && (!r.end_date || r.end_date >= today));
        const next = forService.filter(r => r.start_date && r.start_date > today).sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
        const r = now || next;
        if (!r) continue;
        const auth = txt(r.authorization_number);
        const elsewhere = current.find(x => x.service === service && x.program !== 'EI');
        if (elsewhere) {
          problems.push({ ...who, message: `${service} is under ${elsewhere.program} in the app, but EI-Hub has an EI authorization (${auth}) for it. Change the program on the patient form if it should be EI.` });
          continue;
        }
        const row = current.find(x => x.program === 'EI' && x.service === service);
        const parsed = mandateOf(r);
        const want = { sessions: parsed.sessions || (row && row.sessions) || null, minutes: parsed.minutes || (row && Number(row.minutes)) || null };
        if (!want.sessions || !want.minutes) {
          problems.push({ ...who, message: `Auth ${auth}: couldn't read the ${service} mandate from EI-Hub ("${[txt(r.frequency), txt(r.frequency_unit), txt(r.length)].filter(Boolean).join(' ') || 'blank'}"). Enter it on the patient form's EI tab.` });
          continue;
        }
        const fields = [];
        const haveMandate = row ? { sessions: row.sessions, minutes: Number(row.minutes) } : null;
        if (!row || String(row.sessions) !== String(want.sessions) || Number(row.minutes) !== Number(want.minutes)) {
          fields.push({ label: `${service} mandate`, from: mandateLabel(haveMandate), to: mandateLabel(want) });
        }
        if (!row || (row.authorization_number || null) !== auth) fields.push({ label: `${service} auth #`, from: row ? row.authorization_number || null : null, to: auth });
        const addService = !services.includes(service);
        if (addService && fields.length) fields.push({ label: 'Services', from: services.join(', ') || null, to: [...services, service].join(', ') });
        if (!fields.length) continue;
        const effective = r.start_date || today;
        changes.push({ id: `mandate:${patient.id}:${service}`, kind: 'mandate', ...who, title: `EI mandate: ${service}`,
          note: row ? `From ${fmtDay(effective)}; earlier appointments keep the old mandate.` : `From ${fmtDay(effective)}.`,
          fields, _apply: { service, sessions: want.sessions, minutes: want.minutes, authorization: auth, effective, addService } });
      }
    }
    // Exited in EI-Hub: listed, but left unticked (Kieran, Oct 2026).
    if (rows.every(r => /exit/i.test(String(r.child_status || '')))) {
      for (let i = before; i < changes.length; i++) changes[i].unticked = true;
      if (changes.length > before) problems.push({ ...who, message: "Exited in EI-Hub, so their changes are left unticked. Tick them only if they're right." });
    }
    if (changes.length === before) unchanged += 1;
  }
  return {
    rows: read.rows.length, rows_used: rowsUsed, skipped, children: children.size, matched: matched.length, unchanged,
    changes, unmatched, problems,
  };
}

const ORDER = ['link', 'child', 'redate', 'mandate', 'auth', 'referral', 'ifsp', 'sc'];

// Applies the ticked changes (ids from preview), worked out again from the
// file. Returns { applied: { kind: count } } or { error }. Run in a transaction.
// The EI child ID lock (migrations/2026-10-25_ei_child_id_lock.sql). Cached
// once seen, so a warm Lambda picks the migration up when it's run.
let lockReady = false;
async function hasIdLock(db) {
  if (lockReady) return true;
  const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'Patients' AND column_name = 'ei_id_locked_at'`);
  if (r.rows.length) lockReady = true;
  return lockReady;
}
// A patient's locked EI child ID, or null when it isn't locked.
const lockedId = (p) => (p && p.ei_id_locked_at && String(p.ID_Number || '').trim() ? String(p.ID_Number).trim() : null);

// Whether the current version could start sooner (`from`, before its start):
// the one before it ended the day before it began and started before
// `from`. Returns { prev, currentStart } or null.
function redate(versions, current, from) {
  if (!current || !current.start_date || !from) return null;
  const currentStart = history.day(current.start_date);
  if (currentStart <= from) return null;
  const prev = versions.find(x => x.id !== current.id && x.end_date && history.day(x.end_date) < currentStart
    && (!x.start_date || history.day(x.start_date) < from)
    && !versions.some(y => y.id !== current.id && y.id !== x.id && y.start_date && history.day(y.start_date) > history.day(x.end_date) && history.day(y.start_date) < currentStart));
  return prev ? { prev, currentStart } : null;
}

// A change that can't be saved, with a reason to show (the rest still are).
class SkipChange extends Error {}

// Applies the ticked changes (ids from preview), worked out again from the
// file. Each change is saved on its own (a savepoint inside the caller's
// transaction): one that fails is rolled back and listed with its reason,
// and the rest are still saved. (All-or-nothing turned a single bad row into
// "nothing imported".) Returns { applied: { kind: count }, failed: [...] }
// or { error }.
async function apply(q, payload, ids, username, deps) {
  const p = await preview(q, payload, deps);
  if (p.error) return p;
  const want = new Set(ids);
  const seen = new Set();
  const picked = p.changes.filter(c => want.has(c.id) && !seen.has(c.id) && seen.add(c.id)).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  if (!picked.length) return { error: 'Tick at least one change to apply. (Something may have changed since the preview; check the list again.)' };
  const applied = {};
  const failed = [];
  const touched = new Map(); // patient id -> the EI child ID the file has for them
  for (const c of picked) {
    await q.query('SAVEPOINT ei_change');
    try {
      await applyOne(q, c, username, deps);
      await q.query('RELEASE SAVEPOINT ei_change');
      applied[c.kind] = (applied[c.kind] || 0) + 1;
      if (c.patient_id && c.ei_child_id) touched.set(c.patient_id, c.ei_child_id);
    } catch (err) {
      await q.query('ROLLBACK TO SAVEPOINT ei_change');
      if (!(err instanceof SkipChange)) console.error('EI import change failed', c.kind, err);
      failed.push({ patient_name: c.patient_name, title: c.title,
        error: err instanceof SkipChange ? err.message : "Couldn't be saved. Try the import again; if it keeps failing, tell your developer." });
    }
  }
  // Lock the EI child ID of every child this import saved something for, so
  // later imports refer back to it and no one changes it by hand.
  // Only when their ID # is that EI child ID (not if "Set the ID #" was
  // unticked and an old ID is still on the patient).
  if (touched.size && (await hasIdLock(q))) {
    for (const [patientId, eiId] of touched) {
      await q.query(
        `UPDATE "Patients" SET ei_id_locked_at = now(), ei_id_locked_by = $3
         WHERE id = $1 AND ei_id_locked_at IS NULL AND ltrim(regexp_replace(COALESCE("ID_Number", ''), '\D', '', 'g'), '0') = $2`,
        [patientId, idKey(eiId), username]
      );
    }
  }
  if (deps.hasAuthTable && Object.keys(applied).length) {
    await q.query('INSERT INTO "EiImports" (imported_by, row_count, applied) VALUES ($1, $2, $3)', [username, p.rows, JSON.stringify({ ...applied, failed: failed.length })]);
  }
  return { applied, failed };
}

async function applyOne(q, c, username, deps) {
  const a = c._apply;
  if (c.kind === 'link') {
    await q.query('UPDATE "Patients" SET "ID_Number"=$1 WHERE id=$2', [a.id, c.patient_id]);
  } else if (c.kind === 'child') {
    const r = await history.addVersion(q, 'child', c.patient_id, a.values, a.effective, username);
    if (r.error) throw new SkipChange(r.error);
    await deps.mirrorChild(q, c.patient_id);
  } else if (c.kind === 'auth') {
    if (!deps.hasAuthTable) throw new SkipChange(deps.authMigration);
    const cols = ['patient_id', 'ei_child_id', 'service', 'program', 'location_type', 'enrollment_type', 'enrollment_status', 'start_date', 'end_date',
      'suspended_start', 'suspended_end', 'length', 'frequency', 'frequency_unit', 'visits_per_day', 'sessions_authorized', 'sessions_used', 'sessions_remaining',
      'makeups_authorized', 'makeups_used', 'makeups_remaining', 'covisits_authorized', 'covisits_used', 'covisits_remaining',
      'therapist_first', 'therapist_last', 'therapist_npi', 'last_session_date'];
    await q.query(
      `INSERT INTO "EiAuthorizations" (authorization_number, ${cols.join(', ')}, imported_by, imported_at)
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, $${cols.length + 2}, now())
       ON CONFLICT (authorization_number) DO UPDATE SET ${cols.map((col, i) => `${col}=$${i + 2}`).join(', ')}, imported_by=$${cols.length + 2}, imported_at=now()${deps.hasAuthSource ? ', source=NULL' : ''}`,
      [c.authorization_number, ...cols.map(col => a[col] ?? null), username]
    );
  } else if (c.kind === 'referral') {
    const r = await history.addVersion(q, 'referral', c.authorization_number, a.values, a.effective, username);
    if (r.error) throw new SkipChange(r.error);
  } else if (c.kind === 'redate') {
    // Not if a sent claim was billed with the earlier version on a date it
    // would now hand over (what was billed must still match its version).
    const table = a.table === 'child' ? '"PatientEiDetails"' : '"EiReferralPeriods"';
    if ((await q.query(`SELECT to_regclass('"EiClaims"') AS t`)).rows[0]?.t) {
      const col = a.table === 'child' ? "details->'child'->>'version_id'" : "details->'referring'->>'period_id'";
      const used = await q.query(`SELECT 1 FROM "EiClaims" WHERE NOT test AND ${col} = $1 AND appointment_date >= $2 LIMIT 1`, [String(a.prevId), a.from]);
      if (used.rows.length) throw new SkipChange('A claim already sent was billed with the earlier version on one of those dates, so the dates stay as they are.');
    }
    await q.query(`UPDATE ${table} SET end_date = ($1::date - 1) WHERE id = $2`, [a.from, a.prevId]);
    await q.query(`UPDATE ${table} SET start_date = $1 WHERE id = $2`, [a.from, a.id]);
    if (a.table === 'child') await deps.mirrorChild(q, c.patient_id);
  } else if (c.kind === 'ifsp') {
    await q.query(
      `UPDATE "Patients" SET "IFSP_Type"=COALESCE($1, "IFSP_Type"), "IFSP_Start_Date"=COALESCE($2::date, "IFSP_Start_Date"),
         "IFSP_End_Date"=COALESCE($3::date, "IFSP_End_Date"),
         "Report_Date"=CASE WHEN $3::date IS NULL THEN "Report_Date" ELSE $3::date - 21 END
       WHERE id=$4`,
      [a.IFSP_Type || null, a.IFSP_Start_Date || null, a.IFSP_End_Date || null, c.patient_id]
    );
  } else if (c.kind === 'mandate') {
    // The patient's whole current plan, with this EI service set, saved
    // the same way as the patient form (lib/patientPrograms.js): rows that
    // don't change are left alone, the old mandate ends the day before.
    const programs = new Map();
    for (const r of await patientPrograms.currentRows(q, c.patient_id)) {
      if (!programs.has(r.program)) programs.set(r.program, { program: r.program, billing_code: r.billing_code || null, mandates: [] });
      if (r.service) programs.get(r.program).mandates.push({ service: r.service, sessions: r.sessions, minutes: Number(r.minutes), authorization: r.authorization_number || null });
    }
    if (!programs.has('EI')) programs.set('EI', { program: 'EI', billing_code: null, mandates: [] });
    const ei = programs.get('EI');
    ei.mandates = [...ei.mandates.filter(m => m.service !== a.service), { service: a.service, sessions: a.sessions, minutes: a.minutes, authorization: a.authorization }];
    const cleaned = patientPrograms.cleanPlan({ effective_from: a.effective, programs: [...programs.values()] });
    if (cleaned.error) throw new SkipChange(cleaned.error);
    await patientPrograms.applyPlan(q, c.patient_id, cleaned.plan, username);
    if (a.addService) {
      await q.query(
        `UPDATE "Patients" SET "Services" = CASE WHEN COALESCE(TRIM("Services"), '') = '' THEN $1 ELSE "Services" || ', ' || $1 END WHERE id=$2`,
        [a.service, c.patient_id]
      );
    }
  } else if (c.kind === 'sc') {
    await q.query(
      `UPDATE "Patients" SET "SC_Admin_Name"=COALESCE($1, "SC_Admin_Name"), "SC_Admin_Phone"=COALESCE($2, "SC_Admin_Phone"),
         "SC_Admin_Email"=COALESCE($3, "SC_Admin_Email") WHERE id=$4`,
      [a.SC_Admin_Name || null, a.SC_Admin_Phone || null, a.SC_Admin_Email || null, c.patient_id]
    );
  }
}

// What preview sends to the browser (without the values apply() needs).
const publicPreview = (p) => ({ ...p, changes: p.changes.map(({ _apply, ...c }) => c) });

module.exports = { preview, apply, publicPreview, serviceOf, countyOf, dateOf, hasIdLock, lockedId };
