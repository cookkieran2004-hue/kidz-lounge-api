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
// Diagnosis codes aren't in the report, so they're kept as they are.

const history = require('./eiHistory');
const { COUNTY_CODES, validNpi } = require('./eiHubCodes');

// The report's columns (as EI-Hub names them) -> our keys. Matched loosely
// (case, spaces and punctuation ignored) in case EI-Hub tweaks the wording.
const COLUMNS = {
  'EI Child ID': 'ei_child_id', 'Child First Name': 'first', 'Child Middle Name': 'middle', 'Child Last Name': 'last', 'DOB': 'dob',
  'Child Address': 'address', 'Child City': 'city', 'Child State': 'state', 'Child Zip': 'zip', 'Sex': 'sex', 'County of Residence': 'county',
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
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${pad(m[1])}-${pad(m[2])}`;
  return null;
}
// EI child IDs compared as digits without leading zeros (Excel may drop them).
const idKey = (v) => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
const nameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const splitName = (n) => { const p = String(n || '').trim().split(/\s+/); return { first: p[0] || '', last: p.slice(1).join(' ') }; };

// "Speech Language - Facility" -> ST (the part before " - " is the service,
// the rest is where).
function serviceOf(program) {
  const s = String(program || '').split(' - ')[0].toLowerCase();
  if (/speech/.test(s)) return 'ST';
  if (/occupational/.test(s)) return 'OT';
  if (/physical/.test(s)) return 'PT';
  if (/special\s*instruction|special\s*ed/.test(s)) return 'SI';
  return null;
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
  const [patientsRes, detailsRes] = await Promise.all([
    db.query(`SELECT id, "Name", "Date_of_Birth", "ID_Number", "IFSP_Type", "IFSP_Start_Date", "IFSP_End_Date",
                     "SC_Admin_Name", "SC_Admin_Phone", "SC_Admin_Email" FROM "Patients"`),
    db.query('SELECT patient_id, ei_child_id FROM "PatientEiDetails" WHERE end_date IS NULL'),
  ]);
  const patients = patientsRes.rows;
  const byId = new Map();
  detailsRes.rows.forEach(d => { if (idKey(d.ei_child_id)) byId.set(idKey(d.ei_child_id), patients.find(p => p.id === d.patient_id)); });
  patients.forEach(p => { const k = idKey(p.ID_Number); if (k && !byId.has(k)) byId.set(k, p); });

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
  const matched = []; // [patient, rows, linked]
  for (const [k, rows] of children) {
    const r0 = rows[0];
    let patient = byId.get(k);
    let linked = false;
    if (!patient) {
      // Not by ID: by name and date of birth, if exactly one patient fits.
      const want = nameKey(`${txt(r0.first) || ''}${txt(r0.last) || ''}`);
      const fits = patients.filter(p => nameKey(p.Name) === want && (!r0.dob || !p.Date_of_Birth || history.day(p.Date_of_Birth) === r0.dob));
      if (fits.length === 1) { patient = fits[0]; linked = true; }
    }
    const name = [txt(r0.first), txt(r0.last)].filter(Boolean).join(' ');
    if (!patient) {
      unmatched.push({ ei_child_id: txt(r0.ei_child_id), name, date_of_birth: r0.dob, authorizations: rows.length });
      continue;
    }
    matched.push([patient, rows, linked]);
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
    const addr = txt(r0.address);
    if (addr && !same(addr, base.address_line1)) { setIf('address_line1', addr.slice(0, 55), base.address_line1); if (base.address_line2) { fieldChanges.push({ label: CHILD_LABELS.address_line2, from: base.address_line2, to: null }); want.address_line2 = null; } }
    setIf('city', txt(r0.city), base.city);
    setIf('state', txt(r0.state) && txt(r0.state).toUpperCase(), base.state);
    setIf('zip', txt(r0.zip) && String(r0.zip).replace(/\D/g, ''), base.zip);
    const county = countyOf(r0.county);
    if (county === undefined) problems.push({ ...who, message: `County "${txt(r0.county)}" isn't one EI-Hub billing knows. Check it on the chart's EI Billing tab.` });
    else setIf('county', county, base.county);
    if (fieldChanges.length) {
      const cleaned = deps.cleanChild(want);
      if (cleaned.error) problems.push({ ...who, message: `EI details not imported: ${cleaned.error}` });
      else {
        changes.push({ id: `child:${patient.id}`, kind: 'child', ...who, title: current ? 'EI details changed' : 'EI details (first entry)',
          note: current ? `A new version from ${fmtDay(today)}; the earlier one is kept.` : 'Applies to all dates.',
          fields: fieldChanges, _apply: { values: cleaned.values, effective: current ? today : null } });
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
        if (!cur || !same(cur.referring_last, v.referring_last) || !same(cur.referring_first, v.referring_first) || cur.referring_npi !== v.referring_npi) {
          const show = (p) => (p ? `${[p.referring_first, p.referring_last].filter(Boolean).join(' ')} (NPI ${p.referring_npi})` : null);
          changes.push({ id: `referral:${auth}`, kind: 'referral', ...who, authorization_number: auth, title: `Referring provider: ${rec.service || ''} ${auth}`.replace('  ', ' '),
            note: periods.length ? `From ${fmtDay(today)}; the earlier one is kept.` : 'For the whole authorization.',
            fields: [{ label: 'Referring provider', from: show(cur), to: show(v) }], _apply: { values: v, effective: periods.length ? today : null } });
        }
      }
    }
    if (changes.length === before) unchanged += 1;
  }
  // Not a value worth flagging: a valid-looking NPI that fails its check digit.
  for (const [patient, rows] of matched) {
    for (const r of rows) {
      const npi = String(r.therapist_npi || '').replace(/\D/g, '');
      if (npi && !validNpi(npi)) problems.push({ patient_id: patient.id, patient_name: patient.Name, message: `Auth ${txt(r.authorization_number)}: the therapist NPI in EI-Hub isn't a valid NPI.` });
    }
  }
  return {
    rows: read.rows.length, children: children.size, matched: matched.length, unchanged,
    changes, unmatched, problems,
  };
}

const ORDER = ['link', 'child', 'auth', 'referral', 'ifsp', 'sc'];

// Applies the ticked changes (ids from preview), worked out again from the
// file. Returns { applied: { kind: count } } or { error }. Run in a transaction.
async function apply(q, payload, ids, username, deps) {
  const p = await preview(q, payload, deps);
  if (p.error) return p;
  const want = new Set(ids);
  const picked = p.changes.filter(c => want.has(c.id)).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  if (!picked.length) return { error: 'Tick at least one change to apply. (Something may have changed since the preview; check the list again.)' };
  const applied = {};
  const mirror = new Set();
  for (const c of picked) {
    const a = c._apply;
    if (c.kind === 'link') {
      await q.query('UPDATE "Patients" SET "ID_Number"=$1 WHERE id=$2', [a.id, c.patient_id]);
    } else if (c.kind === 'child') {
      const r = await history.addVersion(q, 'child', c.patient_id, a.values, a.effective, username);
      if (r.error) return { error: `${c.patient_name}: ${r.error}` };
      mirror.add(c.patient_id);
    } else if (c.kind === 'auth') {
      if (!deps.hasAuthTable) return { error: deps.authMigration };
      const cols = ['patient_id', 'ei_child_id', 'service', 'program', 'location_type', 'enrollment_type', 'enrollment_status', 'start_date', 'end_date',
        'suspended_start', 'suspended_end', 'length', 'frequency', 'frequency_unit', 'visits_per_day', 'sessions_authorized', 'sessions_used', 'sessions_remaining',
        'makeups_authorized', 'makeups_used', 'makeups_remaining', 'covisits_authorized', 'covisits_used', 'covisits_remaining',
        'therapist_first', 'therapist_last', 'therapist_npi', 'last_session_date'];
      await q.query(
        `INSERT INTO "EiAuthorizations" (authorization_number, ${cols.join(', ')}, imported_by, imported_at)
         VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, $${cols.length + 2}, now())
         ON CONFLICT (authorization_number) DO UPDATE SET ${cols.map((col, i) => `${col}=$${i + 2}`).join(', ')}, imported_by=$${cols.length + 2}, imported_at=now()`,
        [c.authorization_number, ...cols.map(col => a[col] ?? null), username]
      );
    } else if (c.kind === 'referral') {
      const r = await history.addVersion(q, 'referral', c.authorization_number, a.values, a.effective, username);
      if (r.error) return { error: `Auth ${c.authorization_number}: ${r.error}` };
    } else if (c.kind === 'ifsp') {
      await q.query(
        `UPDATE "Patients" SET "IFSP_Type"=COALESCE($1, "IFSP_Type"), "IFSP_Start_Date"=COALESCE($2::date, "IFSP_Start_Date"),
           "IFSP_End_Date"=COALESCE($3::date, "IFSP_End_Date"),
           "Report_Date"=CASE WHEN $3::date IS NULL THEN "Report_Date" ELSE $3::date - 21 END
         WHERE id=$4`,
        [a.IFSP_Type || null, a.IFSP_Start_Date || null, a.IFSP_End_Date || null, c.patient_id]
      );
    } else if (c.kind === 'sc') {
      await q.query(
        `UPDATE "Patients" SET "SC_Admin_Name"=COALESCE($1, "SC_Admin_Name"), "SC_Admin_Phone"=COALESCE($2, "SC_Admin_Phone"),
           "SC_Admin_Email"=COALESCE($3, "SC_Admin_Email") WHERE id=$4`,
        [a.SC_Admin_Name || null, a.SC_Admin_Phone || null, a.SC_Admin_Email || null, c.patient_id]
      );
    }
    applied[c.kind] = (applied[c.kind] || 0) + 1;
  }
  for (const id of mirror) await deps.mirrorChild(q, id);
  if (deps.hasAuthTable) {
    await q.query('INSERT INTO "EiImports" (imported_by, row_count, applied) VALUES ($1, $2, $3)', [username, p.rows, JSON.stringify(applied)]);
  }
  return { applied };
}

// What preview sends to the browser (without the values apply() needs).
const publicPreview = (p) => ({ ...p, changes: p.changes.map(({ _apply, ...c }) => c) });

module.exports = { preview, apply, publicPreview, serviceOf, countyOf, dateOf };
