const { json } = require('../lib/http');
const { canUseEiHub } = require('../lib/roles');
const { ALLOWED_CODES, COUNTY_CODES, validNpi, normalizeIcd10, codesFor, linesFor, visitRate } = require('../lib/eiHubCodes');
const { build837, splitName, splitCharge } = require('../lib/ei837');
const { eiHubSessions } = require('./billing');
const { getPool } = require('../lib/db');
const history = require('../lib/eiHistory');

// EI-Hub 837P billing, part 1 (Oct 2026): the details every claim needs that
// the rest of the app doesn't keep -- the agency (billing provider and
// submitter), each provider as EI-Hub knows them plus their default codes,
// and each EI child's sex, address, county, diagnoses and, per service
// authorization, the referring provider. Admins and Developers, like the
// EI-Hub entry list (routes/billing.js). migrations/2026-10-21_ei_billing_setup.sql.
//
//   GET  /ei-hub/setup                    agency + providers + the code / county lists
//   PUT  /ei-hub/setup/agency
//   PUT  /ei-hub/setup/providers/:name
//   GET  /ei-hub/children                 EI children with their billing details
//   PUT  /ei-hub/children/:id
//   PUT  /ei-hub/referrals/:authorization
//   GET  /ei-hub/claims?month=YYYY-MM       part 2: each EI session, its codes and what blocks a claim
//   PUT  /ei-hub/claims/codes               change one session's codes (or back to the defaults)
//   POST /ei-hub/claim-files                make an 837P file from chosen sessions
//   GET  /ei-hub/claim-files/:id            download a file again

const MIGRATION = 'This needs the 2026-10-20, 2026-10-21 and 2026-10-23 database updates. Ask an admin to run them.';
const DENIED = 'EI-Hub billing is only open to Admins and Developers.';
let ready = false;
async function hasSetup(db) {
  if (ready) return true;
  // This part's tables and columns, the authorization number from the
  // 2026-10-20 migration, and the dated history from 2026-10-23.
  const r = await db.query(`SELECT to_regclass('"EiReferralPeriods"') AS t, to_regclass('"PatientEiDetails"') AS h,
    (SELECT COUNT(*)::int FROM information_schema.columns
     WHERE (table_name = 'Patients' AND column_name = 'diagnosis_codes')
        OR (table_name = 'PatientPrograms' AND column_name = 'authorization_number')) AS c`);
  if (r.rows[0]?.t && r.rows[0]?.h && r.rows[0]?.c === 2) ready = true;
  return ready;
}

// Part 2's tables (migrations/2026-10-22_ei_claims.sql).
let claimsReady = false;
async function hasClaims(db) {
  if (claimsReady) return true;
  const r = await db.query(`SELECT to_regclass('"EiClaims"') AS t`);
  if (r.rows[0]?.t) claimsReady = true;
  return claimsReady;
}
const CLAIMS_MIGRATION = 'Claim files need the 2026-10-22 database update. Ask an admin to run it.';
const TEST_LIMIT = 50;      // the state's limit for a test file
const FILE_LIMIT = 5000;    // and for any file
const FILING_DAYS = 90;     // timely filing
// Center (a room, or offsite at a center) is the office; home and school /
// community are both billed as home (Kieran, Oct 2026).
const PLACE_OF_SERVICE = { Center: '11', Home: '12', School: '12' };

const digits = (v) => String(v ?? '').replace(/\D/g, '');
const text = (v, max = 60) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};
// Providers has no archived column: a provider is archived when their staff
// account is (the same rule as routes/providers.js).
const PROVIDER_COLUMNS = `p.id, p."Name", p.first_name, p.last_name, p.specialty, p.npi, p.ei_first_name, p.ei_last_name, p.ei_default_codes,
  (EXISTS (SELECT 1 FROM "Staff" s WHERE s.provider_name = p."Name" AND s.archived = true)
   AND NOT EXISTS (SELECT 1 FROM "Staff" s WHERE s.provider_name = p."Name" AND s.archived = false)) AS archived`;
const disciplinesOf = (specialty) => String(specialty || '').split(/[,/]/).map(x => x.trim().toUpperCase()).filter(Boolean);

// Shared address checks; returns { values } or { error }.
function cleanAddress(b) {
  const zip = digits(b.zip);
  if (zip && zip.length !== 5 && zip.length !== 9) return { error: 'ZIP code must be 5 or 9 digits.' };
  const state = text(b.state, 2);
  if (state && !/^[A-Za-z]{2}$/.test(state)) return { error: 'State must be the 2-letter abbreviation, like NY.' };
  return {
    values: {
      address_line1: text(b.address_line1, 55), address_line2: text(b.address_line2, 55),
      city: text(b.city, 30), state: state ? state.toUpperCase() : null, zip: zip || null,
    },
  };
}


// Everything a month's claims need, with what blocks each one. Shared by the
// list and by making a file, so a file is only ever made from what the list
// shows as ready.
async function claimData(db, month) {
  const { sessions } = await eiHubSessions(db, month);
  const names = [...new Set(sessions.map(x => x.patient_name))];
  const keys = sessions.map(x => x.key);
  const auths = [...new Set(sessions.map(x => x.authorization).filter(Boolean))];
  const [agencyRes, providersRes, patientsRes, overridesRes, referralPeriods, claimsRes] = await Promise.all([
    db.query('SELECT * FROM "EiBillingSettings" WHERE id = 1'),
    db.query('SELECT "Name", first_name, last_name, npi, ei_first_name, ei_last_name, ei_default_codes FROM "Providers"'),
    names.length ? db.query('SELECT id, "Name", "Date_of_Birth", "ID_Number", mrn FROM "Patients" WHERE "Name" = ANY($1)', [names]) : { rows: [] },
    keys.length ? db.query('SELECT session_key, codes FROM "EiSessionCodes" WHERE session_key = ANY($1)', [keys]) : { rows: [] },
    history.versionsFor(db, 'referral', auths),
    keys.length ? db.query(`SELECT c.*, f.file_name FROM "EiClaims" c JOIN "EiClaimFiles" f ON f.id = c.file_id
                            WHERE c.session_key = ANY($1) AND NOT c.test ORDER BY c.created_at`, [keys]) : { rows: [] },
  ]);
  const agency = agencyRes.rows[0] || {};
  const agencyProblems = [];
  if (!agency.agency_name) agencyProblems.push('agency name');
  if (!agency.npi) agencyProblems.push('agency NPI');
  if (!agency.tax_id) agencyProblems.push('tax ID');
  if (!agency.address_line1 || !agency.city || !agency.state) agencyProblems.push('agency address');
  // The billing provider's ZIP must be the full 9 digits on a claim.
  if (String(agency.zip || '').length !== 9) agencyProblems.push('agency ZIP+4 (9 digits)');
  if (!agency.contact_name || (!agency.contact_phone && !agency.contact_email)) agencyProblems.push('billing contact');

  const providers = Object.fromEntries(providersRes.rows.map(x => [x.Name, x]));
  const patients = Object.fromEntries(patientsRes.rows.map(x => [x.Name, x]));
  const overrides = Object.fromEntries(overridesRes.rows.map(x => [x.session_key, x.codes]));
  // Every version of each child's EI details: a claim uses the one in effect
  // on the session's date (lib/eiHistory.js).
  const childVersions = await history.versionsFor(db, 'child', patientsRes.rows.map(x => x.id));
  const sent = {};
  claimsRes.rows.forEach(c => { sent[c.session_key] = c; }); // latest wins
  const cutoff = new Date(Date.now() - FILING_DAYS * 86400000).toISOString().slice(0, 10);

  const rows = sessions.map(x => {
    const problems = [];
    const warnings = [];
    const prov = providers[x.provider] || {};
    const patient = patients[x.patient_name] || {};
    const versions = childVersions[patient.id] || [];
    const child = history.versionOn(versions, x.date) || {};
    const current = versions.find(v => !v.end_date);
    const childId = child.ei_child_id || (versions.length ? null : patient.ID_Number);
    const pos = PLACE_OF_SERVICE[x.setting] || null;
    if (x.is_eval) problems.push("Evals aren't billed by file yet");
    if (!x.service) problems.push(x.service_options ? `Check the service (${x.service_options.join(' or ')})` : 'No service');
    if (!x.authorization) problems.push('No auth #');
    if (!pos) problems.push('No room or offsite setting');
    if (!versions.length) problems.push('No EI details entered');
    else if (!child.id) problems.push('No EI details in effect on this date');
    if (!childId) problems.push('No ID #');
    // Edited on the patient record but not in the EI details: don't bill
    // either until someone checks which is right.
    if (current && patient.ID_Number && current.ei_child_id && patient.ID_Number !== current.ei_child_id) {
      problems.push(`ID # on the patient record (${patient.ID_Number}) doesn't match the EI details (${current.ei_child_id})`);
    }
    if (!(child.date_of_birth || patient.Date_of_Birth)) problems.push('No date of birth');
    if (!child.sex) problems.push('No sex');
    if (!child.address_line1 || !child.city || !child.state || !child.zip) problems.push('No address');
    if (child.county !== 'New York City') problems.push(child.county ? `County ${child.county} (only New York City for now)` : 'No county');
    if (!child.diagnosis_codes) problems.push('No diagnosis');
    const referral = x.authorization ? history.versionOn(referralPeriods[x.authorization], x.date) : null;
    if (x.service && x.service !== 'SI' && x.authorization && !referral) {
      problems.push((referralPeriods[x.authorization] || []).length ? 'No referring provider in effect on this date' : 'No referring provider');
    }
    if (!prov.npi) problems.push(`No NPI for ${x.provider}`);
    const defaults = prov.ei_default_codes || {};
    const override = overrides[x.key] || null;
    const codes = x.service ? codesFor(x.service, x.duration, defaults, override) : [];
    if (x.service && !codes.length) problems.push(`No ${x.service} codes for ${x.provider}`);
    if (x.service && ['OT', 'PT', 'SI'].includes(x.service) && x.duration % 15) warnings.push(`${x.duration} minutes isn't a multiple of 15`);
    if (override && x.service && codes.length !== linesFor(x.service, x.duration)) {
      warnings.push(`${codes.length} line${codes.length === 1 ? '' : 's'} for a ${x.duration}-minute session`);
    }
    if (x.date < cutoff) warnings.push(`Over ${FILING_DAYS} days ago`);
    const charges = codes.length && pos ? splitCharge(visitRate(x.service, x.duration, pos), codes.length) : [];
    const claim = sent[x.key] || null;
    return {
      key: x.key, date: x.date, start_time: x.start_time, end_time: x.end_time, duration: x.duration,
      patient_name: x.patient_name, provider: x.provider, service: x.service, authorization: x.authorization,
      setting: x.setting, place_of_service: pos, is_makeup: x.is_makeup, is_eval: x.is_eval,
      codes, codes_changed: !!override, default_lines: x.service ? linesFor(x.service, x.duration) : 0,
      lines: codes.map((code, i) => ({ code, charge: charges[i] || 0 })),
      problems, warnings,
      claim: claim ? { claim_number: claim.claim_number, status: claim.status, file_name: claim.file_name, created_at: claim.created_at, eihub_claim_id: claim.eihub_claim_id } : null,
      // What lib/ei837.js needs (kept server side).
      _build: {
        child: {
          // Name and date of birth as EI-Hub has them, when entered.
          first: child.first_name || splitName(x.patient_name).first, last: child.last_name || splitName(x.patient_name).last,
          id: childId, dob: history.day(child.date_of_birth) || patient.Date_of_Birth, sex: child.sex, mrn: patient.mrn,
          address_line1: child.address_line1, address_line2: child.address_line2, city: child.city, state: child.state, zip: child.zip,
          version_id: child.id || null,
        },
        diagnoses: String(child.diagnosis_codes || '').split(',').map(d => d.trim()).filter(Boolean),
        referring: referral ? { last: referral.referring_last, first: referral.referring_first, npi: referral.referring_npi, period_id: referral.id } : null,
        rendering: { last: prov.ei_last_name || prov.last_name || splitName(x.provider).last, first: prov.ei_first_name || prov.first_name || splitName(x.provider).first, npi: prov.npi },
      },
    };
  });
  return { agency, agencyProblems, rows };
}

const publicRow = ({ _build, ...rest }) => rest;

async function claimsRoutes({ path, method, qs, body, db, currentUser }) {
  const b = body || {};
  if (path === '/ei-hub/claims' && method === 'GET') {
    if (!(await hasSetup(db)) || !(await hasClaims(db))) return json(200, { available: false });
    const month = String(qs.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return json(400, { error: 'Choose a month.' });
    const { agencyProblems, rows } = await claimData(db, month);
    const files = (await db.query(
      'SELECT id, file_name, invoice_number, test, month, claim_count, created_by, created_at FROM "EiClaimFiles" ORDER BY id DESC LIMIT 30'
    )).rows;
    return json(200, { available: true, month, agency_problems: agencyProblems, sessions: rows.map(publicRow), files, test_limit: TEST_LIMIT });
  }

  if (path === '/ei-hub/claims/codes' && method === 'PUT') {
    if (!(await hasClaims(db))) return json(409, { error: CLAIMS_MIGRATION });
    const key = String(b.session_key || '');
    if (!/^(appt:[\w-]+|series:[\w-]+:\d{4}-\d{2}-\d{2})$/.test(key)) return json(400, { error: 'Unknown session.' });
    if (!Array.isArray(b.codes) || !b.codes.length) {
      await db.query('DELETE FROM "EiSessionCodes" WHERE session_key=$1', [key]);
      return json(200, { session_key: key, codes: null });
    }
    const allowed = (ALLOWED_CODES[b.service] || []).map(x => x.code);
    const codes = b.codes.map(c => String(c || '').trim().toUpperCase());
    if (!allowed.length) return json(400, { error: 'Unknown service.' });
    const bad = codes.find(c => !allowed.includes(c));
    if (bad) return json(400, { error: `${bad || 'A blank line'} isn't one of the ${b.service} codes.` });
    if (codes.length > 8) return json(400, { error: 'A session can have up to 8 lines.' });
    await db.query(
      `INSERT INTO "EiSessionCodes" (session_key, codes, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (session_key) DO UPDATE SET codes=$2, updated_by=$3, updated_at=now()`,
      [key, JSON.stringify(codes), currentUser.username]
    );
    return json(200, { session_key: key, codes });
  }

  if (path === '/ei-hub/claim-files' && method === 'POST') {
    if (!(await hasSetup(db)) || !(await hasClaims(db))) return json(409, { error: CLAIMS_MIGRATION });
    const month = String(b.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return json(400, { error: 'Choose a month.' });
    const test = !!b.test;
    const wanted = new Set(Array.isArray(b.session_keys) ? b.session_keys.map(String) : []);
    if (!wanted.size) return json(400, { error: 'Choose the sessions to bill.' });
    const limit = test ? TEST_LIMIT : FILE_LIMIT;
    if (wanted.size > limit) return json(400, { error: test ? `A test file can hold up to ${TEST_LIMIT} claims.` : `A file can hold up to ${FILE_LIMIT} claims.` });
    const { agency, agencyProblems, rows } = await claimData(db, month);
    if (agencyProblems.length) return json(400, { error: `Finish the agency setup first: ${agencyProblems.join(', ')}.` });
    const chosen = rows.filter(r => wanted.has(r.key));
    if (chosen.length !== wanted.size) return json(409, { error: 'Some of the chosen sessions have changed. Reload the list and try again.' });
    const blocked = chosen.find(r => r.problems.length);
    if (blocked) return json(400, { error: `${blocked.patient_name} on ${blocked.date}: ${blocked.problems[0]}.` });
    const already = !test && chosen.find(r => r.claim);
    if (already) return json(409, { error: `${already.patient_name} on ${already.date} was already sent in ${already.claim.file_name}.` });

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const file = (await client.query(
        'INSERT INTO "EiClaimFiles" (test, month, claim_count, created_by) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
        [test, month, chosen.length, currentUser.username]
      )).rows[0];
      const now = new Date();
      const stamp = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
      // KL + date + file id: never repeats, and can't collide with invoice
      // numbers typed into EI-Hub by hand.
      const invoice = `KL${stamp}${String(file.id).padStart(5, '0')}`;
      const fileName = `KidzLounge_837P_${invoice}${test ? '_TEST' : ''}.txt`;
      const claims = chosen.map((r, i) => ({
        claim_number: `KL${String(file.id).padStart(6, '0')}${String(i + 1).padStart(4, '0')}${test ? 'T' : ''}`,
        ...r._build,
        authorization: r.authorization,
        visit_type: r.is_makeup ? 'CV2' : 'CV1',
        start_time: r.start_time, end_time: r.end_time, date: r.date,
        place_of_service: r.place_of_service,
        referring: r.service === 'SI' ? null : r._build.referring,
        lines: r.lines,
      }));
      const content = build837({ agency, control: file.id, invoice, test, now, municipality: { name: 'New York City', code: COUNTY_CODES['New York City'] }, claims });
      await client.query('UPDATE "EiClaimFiles" SET file_name=$1, invoice_number=$2, content=$3 WHERE id=$4', [fileName, invoice, content, file.id]);
      for (let i = 0; i < chosen.length; i++) {
        const r = chosen[i];
        await client.query(
          `INSERT INTO "EiClaims" (claim_number, file_id, session_key, test, patient_name, provider, appointment_date, start_time, end_time, service, authorization_number, codes, charge, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [claims[i].claim_number, file.id, r.key, test, r.patient_name, r.provider, r.date, r.start_time, r.end_time, r.service, r.authorization,
            JSON.stringify(r.codes), r.lines.reduce((t, l) => t + l.charge, 0),
            // Exactly what this claim said, kept with it (what the agency billed, and when).
            JSON.stringify(claims[i])]
        );
      }
      await client.query('COMMIT');
      return json(201, { id: file.id, file_name: fileName, invoice_number: invoice, test, claim_count: chosen.length, content });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  const fm = path.match(/^\/ei-hub\/claim-files\/(\d+)$/);
  if (fm && method === 'GET') {
    if (!(await hasClaims(db))) return json(409, { error: CLAIMS_MIGRATION });
    const file = (await db.query('SELECT id, file_name, test, content FROM "EiClaimFiles" WHERE id=$1', [Number(fm[1])])).rows[0];
    if (!file || !file.content) return json(404, { error: 'File not found.' });
    return json(200, file);
  }
  return null;
}

// A child's EI details from a form; returns { values } or { error }.
function cleanChild(b) {
  const sex = b.sex ? String(b.sex).toUpperCase() : null;
  if (sex && !['F', 'M'].includes(sex)) return { error: 'Sex must be F or M.' };
  if (b.county && !COUNTY_CODES[b.county]) return { error: 'Choose the county from the list.' };
  const addr = cleanAddress(b);
  if (addr.error) return { error: addr.error };
  const codes = [];
  for (const part of String(b.diagnosis_codes || '').split(/[,;\n]/)) {
    if (!part.trim()) continue;
    const code = normalizeIcd10(part);
    if (code === undefined) return { error: `"${part.trim()}" isn't an ICD-10 code. Codes look like F80.2.` };
    if (!codes.includes(code)) codes.push(code);
  }
  if (codes.length > 12) return { error: 'A claim can carry up to 12 diagnosis codes.' };
  const dob = b.date_of_birth ? String(b.date_of_birth).slice(0, 10) : null;
  if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return { error: 'Enter the date of birth as EI-Hub has it.' };
  return {
    values: {
      ei_child_id: text(b.ei_child_id, 30), first_name: text(b.first_name, 35), last_name: text(b.last_name, 60), date_of_birth: dob,
      sex, ...addr.values, county: b.county || null, diagnosis_codes: codes.length ? codes.join(', ') : null,
    },
  };
}

async function correctChildVersion(q, patientId, versionId, values, username) {
  const own = (await q.query('SELECT id FROM "PatientEiDetails" WHERE id=$1 AND patient_id=$2', [versionId, patientId])).rows[0];
  return own ? history.correctVersion(q, 'child', own.id, values, username) : { error: 'That version no longer exists. Reload and try again.' };
}

// The patient record keeps a copy of the current EI details, for the rest of
// the app (the ID # is the child's EI ID). Claims always read the versions.
async function mirrorChild(q, patientId) {
  const current = (await q.query('SELECT * FROM "PatientEiDetails" WHERE patient_id=$1 AND end_date IS NULL ORDER BY id DESC LIMIT 1', [patientId])).rows[0];
  if (!current) return;
  await q.query(
    `UPDATE "Patients" SET "ID_Number" = COALESCE($1, "ID_Number"), sex=$2, address_line1=$3, address_line2=$4, city=$5, state=$6, zip=$7, county=$8, diagnosis_codes=$9 WHERE id=$10`,
    [current.ei_child_id, current.sex, current.address_line1, current.address_line2, current.city, current.state, current.zip, current.county, current.diagnosis_codes, patientId]
  );
}

// A version a sent claim was built from stays in the history for good (the
// agency's record of what it billed): it can be corrected or replaced from a
// date, not taken back. Test files don't count. Returns { error } or null.
async function billedWith(q, kind, id) {
  const path = kind === 'child' ? "details->'child'->>'version_id'" : "details->'referring'->>'period_id'";
  const used = (await q.query(`SELECT claim_number FROM "EiClaims" WHERE NOT test AND ${path} = $1 LIMIT 1`, [String(id)])).rows[0];
  return used ? { error: `Claim ${used.claim_number} was billed with this, so it stays in the history. Correct it, or add a new version from a date.` } : null;
}

// Runs fn(client) in a transaction; fn returns { status, body }.
async function withClient(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query(out.status < 400 ? 'COMMIT' : 'ROLLBACK');
    return json(out.status, out.body);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function handle(ctx) {
  const { path, method, body, db, currentUser } = ctx;
  if (!path.startsWith('/ei-hub/')) return null;
  if (!canUseEiHub(currentUser)) return json(403, { error: DENIED });
  const b = body || {};

  const claimsResponse = await claimsRoutes(ctx);
  if (claimsResponse) return claimsResponse;

  if (path === '/ei-hub/setup' && method === 'GET') {
    const lists = { allowed_codes: ALLOWED_CODES, counties: Object.keys(COUNTY_CODES).sort() };
    if (!(await hasSetup(db))) return json(200, { available: false, ...lists });
    const [agency, providers] = await Promise.all([
      db.query('SELECT * FROM "EiBillingSettings" WHERE id = 1'),
      db.query(`SELECT ${PROVIDER_COLUMNS} FROM "Providers" p ORDER BY archived, p."Name"`),
    ]);
    return json(200, { available: true, agency: agency.rows[0] || null, providers: providers.rows, ...lists });
  }

  if (path === '/ei-hub/setup/agency' && method === 'PUT') {
    if (!(await hasSetup(db))) return json(409, { error: MIGRATION });
    const npi = digits(b.npi);
    if (npi && !validNpi(npi)) return json(400, { error: "That NPI isn't valid. Check it's the agency's 10-digit NPI." });
    const taxId = digits(b.tax_id);
    if (taxId && taxId.length !== 9) return json(400, { error: 'The tax ID must be 9 digits.' });
    const phone = digits(b.contact_phone);
    if (phone && phone.length !== 10) return json(400, { error: 'Enter a 10-digit contact phone number.' });
    const addr = cleanAddress(b);
    if (addr.error) return json(400, { error: addr.error });
    const a = addr.values;
    const row = (await db.query(
      `INSERT INTO "EiBillingSettings" (id, agency_name, address_line1, address_line2, city, state, zip, npi, tax_id, contact_name, contact_phone, contact_email, updated_by, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
       ON CONFLICT (id) DO UPDATE SET agency_name=$1, address_line1=$2, address_line2=$3, city=$4, state=$5, zip=$6, npi=$7, tax_id=$8,
         contact_name=$9, contact_phone=$10, contact_email=$11, updated_by=$12, updated_at=now()
       RETURNING *`,
      [text(b.agency_name, 60), a.address_line1, a.address_line2, a.city, a.state, a.zip, npi || null, taxId || null,
        text(b.contact_name, 60), phone || null, text(b.contact_email, 80), currentUser.username]
    )).rows[0];
    return json(200, row);
  }

  const pm = path.match(/^\/ei-hub\/setup\/providers\/(.+)$/);
  if (pm && method === 'PUT') {
    if (!(await hasSetup(db))) return json(409, { error: MIGRATION });
    const name = decodeURIComponent(pm[1]);
    const provider = (await db.query('SELECT "Name", specialty FROM "Providers" WHERE "Name"=$1', [name])).rows[0];
    if (!provider) return json(404, { error: 'Provider not found.' });
    const npi = digits(b.npi);
    if (npi && !validNpi(npi)) return json(400, { error: `That NPI isn't valid. Check ${name}'s 10-digit individual NPI.` });
    // Default codes, only for the provider's own disciplines and only from
    // that discipline's list; 1 to 4 codes (one per 15-minute line).
    const codes = {};
    const theirs = disciplinesOf(provider.specialty);
    for (const [disc, list] of Object.entries(b.ei_default_codes || {})) {
      const clean = (Array.isArray(list) ? list : []).map(c => String(c || '').trim().toUpperCase()).filter(Boolean);
      if (!clean.length) continue;
      if (!theirs.includes(disc)) return json(400, { error: `${name} doesn't provide ${disc}.` });
      const allowed = (ALLOWED_CODES[disc] || []).map(x => x.code);
      const bad = clean.find(c => !allowed.includes(c));
      if (bad) return json(400, { error: `${bad} isn't one of the ${disc} codes.` });
      if (clean.length > 4) return json(400, { error: `Choose up to 4 ${disc} codes.` });
      codes[disc] = clean;
    }
    await db.query(
      'UPDATE "Providers" SET npi=$1, ei_first_name=$2, ei_last_name=$3, ei_default_codes=$4 WHERE "Name"=$5',
      [npi || null, text(b.ei_first_name, 35), text(b.ei_last_name, 60), Object.keys(codes).length ? JSON.stringify(codes) : null, name]
    );
    return json(200, (await db.query(`SELECT ${PROVIDER_COLUMNS} FROM "Providers" p WHERE p."Name"=$1`, [name])).rows[0]);
  }

  if (path === '/ei-hub/children' && method === 'GET') {
    if (!(await hasSetup(db))) return json(200, { available: false, children: [] });
    // Everyone with a current EI program (or "EI" in their Program summary,
    // before program history), with their current EI services, every version
    // of their EI details, and each authorization's referring providers.
    const [patientsRes, servicesRes] = await Promise.all([
      db.query(`SELECT id, "Name", "Date_of_Birth", "ID_Number", "Status", "Program"
                FROM "Patients"
                WHERE id IN (SELECT patient_id FROM "PatientPrograms" WHERE program = 'EI' AND end_date IS NULL)
                   OR ',' || REPLACE(COALESCE("Program", ''), ' ', '') || ',' LIKE '%,EI,%'
                ORDER BY "Name"`),
      db.query(`SELECT patient_id, service, sessions, minutes, start_date, authorization_number
                FROM "PatientPrograms" WHERE program = 'EI' AND end_date IS NULL AND service IS NOT NULL ORDER BY service`),
    ]);
    const auths = [...new Set(servicesRes.rows.map(x => x.authorization_number).filter(Boolean))];
    const [details, referrals] = await Promise.all([
      history.versionsFor(db, 'child', patientsRes.rows.map(x => x.id)),
      history.versionsFor(db, 'referral', auths),
    ]);
    const byPatient = {};
    servicesRes.rows.forEach(x => {
      const periods = x.authorization_number ? referrals[x.authorization_number] || [] : [];
      (byPatient[x.patient_id] = byPatient[x.patient_id] || []).push({
        service: x.service, mandate: x.sessions && x.minutes ? `${x.sessions}x${x.minutes}` : null,
        start_date: history.day(x.start_date),
        authorization_number: x.authorization_number || null,
        referrals: periods,
        referral: periods.find(r => !r.end_date) || null,
      });
    });
    return json(200, {
      available: true,
      children: patientsRes.rows.map(x => {
        const versions = details[x.id] || [];
        return { ...x, versions, current: versions.find(v => !v.end_date) || null, services: byPatient[x.id] || [] };
      }),
    });
  }

  // A change to a child's EI details, from a date (the earlier version is
  // kept); a correction to one version; or taking back the newest version.
  const cm = path.match(/^\/ei-hub\/children\/([^/]+)$/);
  const cvm = path.match(/^\/ei-hub\/children\/([^/]+)\/versions\/(\d+)$/);
  if ((cm && method === 'PUT') || (cvm && (method === 'PUT' || method === 'DELETE'))) {
    if (!(await hasSetup(db))) return json(409, { error: MIGRATION });
    const patientId = (cm || cvm)[1];
    const patient = (await db.query('SELECT id, "Name", "Date_of_Birth", "ID_Number" FROM "Patients" WHERE id=$1', [patientId])).rows[0];
    if (!patient) return json(404, { error: 'Patient not found.' });
    let values = null;
    if (method === 'PUT') {
      const cleaned = cleanChild(b);
      if (cleaned.error) return json(400, { error: cleaned.error });
      values = cleaned.values;
    }
    const effective = b.effective_from ? String(b.effective_from).slice(0, 10) : null;
    if (effective && !/^\d{4}-\d{2}-\d{2}$/.test(effective)) return json(400, { error: 'Choose the date the change takes effect.' });
    return withClient(async (q) => {
      const result = cm
        ? await history.addVersion(q, 'child', patientId, values, effective, currentUser.username)
        : method === 'PUT'
          ? await correctChildVersion(q, patientId, cvm[2], values, currentUser.username)
          : (await billedWith(q, 'child', cvm[2])) || await history.deleteLatest(q, 'child', patientId, cvm[2]);
      if (result.error) return { status: 400, body: { error: result.error } };
      await mirrorChild(q, patientId);
      return { status: 200, body: { versions: await history.listVersions(q, 'child', patientId) } };
    });
  }

  // The referring provider on an authorization, dated the same way.
  const rm = path.match(/^\/ei-hub\/referrals\/([^/]+)$/);
  const rvm = path.match(/^\/ei-hub\/referrals\/([^/]+)\/periods\/(\d+)$/);
  if ((rm && method === 'PUT') || (rvm && (method === 'PUT' || method === 'DELETE'))) {
    if (!(await hasSetup(db))) return json(409, { error: MIGRATION });
    const auth = decodeURIComponent((rm || rvm)[1]).trim();
    if (!auth || auth.length > 30) return json(400, { error: 'Unknown authorization number.' });
    let values = null;
    if (method === 'PUT') {
      const npi = digits(b.referring_npi);
      const last = text(b.referring_last, 60);
      if (!last) return json(400, { error: "Enter the referring provider's last name (or the organization's name)." });
      if (!validNpi(npi)) return json(400, { error: "That NPI isn't valid. Check the referring provider's 10-digit NPI." });
      values = { referring_last: last, referring_first: text(b.referring_first, 35), referring_npi: npi };
    }
    const effective = b.effective_from ? String(b.effective_from).slice(0, 10) : null;
    return withClient(async (q) => {
      let result;
      if (rm) result = await history.addVersion(q, 'referral', auth, values, effective, currentUser.username);
      else if (method === 'PUT') {
        const own = (await q.query('SELECT id FROM "EiReferralPeriods" WHERE id=$1 AND authorization_number=$2', [rvm[2], auth])).rows[0];
        result = own ? await history.correctVersion(q, 'referral', own.id, values, currentUser.username) : { error: 'That referring provider entry no longer exists.' };
      } else result = (await billedWith(q, 'referral', rvm[2])) || await history.deleteLatest(q, 'referral', auth, rvm[2]);
      if (result.error) return { status: 400, body: { error: result.error } };
      return { status: 200, body: { periods: await history.listVersions(q, 'referral', auth) } };
    });
  }

  return null;
}

module.exports = { handle };
