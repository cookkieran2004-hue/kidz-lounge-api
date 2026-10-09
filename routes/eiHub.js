const { json } = require('../lib/http');
const { canUseEiHub } = require('../lib/roles');
const { ALLOWED_CODES, COUNTY_CODES, validNpi, normalizeIcd10 } = require('../lib/eiHubCodes');

// EI-Hub 837P billing, part 1 (Oct 2026): the details every claim needs that
// the rest of the app doesn't keep -- the agency (billing provider and
// submitter), each provider as EI-Hub knows them plus their default codes,
// and each EI child's sex, address, county, diagnoses and, per service
// authorization, the referring provider. Developers only for now, like the
// EI-Hub entry list (routes/billing.js). migrations/2026-10-21_ei_billing_setup.sql.
//
//   GET  /ei-hub/setup                    agency + providers + the code / county lists
//   PUT  /ei-hub/setup/agency
//   PUT  /ei-hub/setup/providers/:name
//   GET  /ei-hub/children                 EI children with their billing details
//   PUT  /ei-hub/children/:id
//   PUT  /ei-hub/referrals/:authorization

const MIGRATION = 'This needs the 2026-10-20 and 2026-10-21 database updates. Ask an admin to run them.';
const DENIED = 'EI-Hub billing is only open to Developers for now.';
let ready = false;
async function hasSetup(db) {
  if (ready) return true;
  // This part's tables and columns, and the authorization number from the
  // 2026-10-20 migration that the children list reads.
  const r = await db.query(`SELECT to_regclass('"EiReferrals"') AS t,
    (SELECT COUNT(*)::int FROM information_schema.columns
     WHERE (table_name = 'Patients' AND column_name = 'diagnosis_codes')
        OR (table_name = 'PatientPrograms' AND column_name = 'authorization_number')) AS c`);
  if (r.rows[0]?.t && r.rows[0]?.c === 2) ready = true;
  return ready;
}

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

async function handle(ctx) {
  const { path, method, body, db, currentUser } = ctx;
  if (!path.startsWith('/ei-hub/')) return null;
  if (!canUseEiHub(currentUser)) return json(403, { error: DENIED });
  const b = body || {};

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
    // before program history), with their current EI services.
    const [patientsRes, servicesRes] = await Promise.all([
      db.query(`SELECT id, "Name", "Date_of_Birth", "ID_Number", "Status", "Program", sex, address_line1, address_line2, city, state, zip, county, diagnosis_codes
                FROM "Patients"
                WHERE id IN (SELECT patient_id FROM "PatientPrograms" WHERE program = 'EI' AND end_date IS NULL)
                   OR ',' || REPLACE(COALESCE("Program", ''), ' ', '') || ',' LIKE '%,EI,%'
                ORDER BY "Name"`),
      db.query(`SELECT patient_id, service, sessions, minutes, start_date, authorization_number
                FROM "PatientPrograms" WHERE program = 'EI' AND end_date IS NULL AND service IS NOT NULL ORDER BY service`),
    ]);
    const auths = [...new Set(servicesRes.rows.map(s => s.authorization_number).filter(Boolean))];
    const referrals = auths.length
      ? Object.fromEntries((await db.query('SELECT * FROM "EiReferrals" WHERE authorization_number = ANY($1)', [auths])).rows.map(r => [r.authorization_number, r]))
      : {};
    const byPatient = {};
    servicesRes.rows.forEach(s => {
      (byPatient[s.patient_id] = byPatient[s.patient_id] || []).push({
        service: s.service, mandate: s.sessions && s.minutes ? `${s.sessions}x${s.minutes}` : null,
        start_date: s.start_date ? String(s.start_date).slice(0, 10) : null,
        authorization_number: s.authorization_number || null,
        referral: s.authorization_number ? referrals[s.authorization_number] || null : null,
      });
    });
    return json(200, { available: true, children: patientsRes.rows.map(p => ({ ...p, services: byPatient[p.id] || [] })) });
  }

  const cm = path.match(/^\/ei-hub\/children\/([^/]+)$/);
  if (cm && method === 'PUT') {
    if (!(await hasSetup(db))) return json(409, { error: MIGRATION });
    const sex = b.sex ? String(b.sex).toUpperCase() : null;
    if (sex && !['F', 'M'].includes(sex)) return json(400, { error: 'Sex must be F or M.' });
    if (b.county && !COUNTY_CODES[b.county]) return json(400, { error: 'Choose the county from the list.' });
    const addr = cleanAddress(b);
    if (addr.error) return json(400, { error: addr.error });
    const codes = [];
    for (const part of String(b.diagnosis_codes || '').split(/[,;\n]/)) {
      if (!part.trim()) continue;
      const code = normalizeIcd10(part);
      if (code === undefined) return json(400, { error: `"${part.trim()}" isn't an ICD-10 code. Codes look like F80.2.` });
      if (!codes.includes(code)) codes.push(code);
    }
    if (codes.length > 12) return json(400, { error: 'A claim can carry up to 12 diagnosis codes.' });
    const a = addr.values;
    const row = (await db.query(
      `UPDATE "Patients" SET sex=$1, address_line1=$2, address_line2=$3, city=$4, state=$5, zip=$6, county=$7, diagnosis_codes=$8
       WHERE id=$9 RETURNING id, "Name", sex, address_line1, address_line2, city, state, zip, county, diagnosis_codes`,
      [sex, a.address_line1, a.address_line2, a.city, a.state, a.zip, b.county || null, codes.length ? codes.join(', ') : null, cm[1]]
    )).rows[0];
    if (!row) return json(404, { error: 'Patient not found.' });
    return json(200, row);
  }

  const rm = path.match(/^\/ei-hub\/referrals\/([^/]+)$/);
  if (rm && method === 'PUT') {
    if (!(await hasSetup(db))) return json(409, { error: MIGRATION });
    const auth = decodeURIComponent(rm[1]).trim();
    if (!auth || auth.length > 30) return json(400, { error: 'Unknown authorization number.' });
    const npi = digits(b.referring_npi);
    const last = text(b.referring_last, 60);
    if (!last && !npi) {
      await db.query('DELETE FROM "EiReferrals" WHERE authorization_number=$1', [auth]);
      return json(200, { authorization_number: auth, cleared: true });
    }
    if (!last) return json(400, { error: "Enter the referring provider's last name (or the organization's name)." });
    if (!validNpi(npi)) return json(400, { error: "That NPI isn't valid. Check the referring provider's 10-digit NPI." });
    const row = (await db.query(
      `INSERT INTO "EiReferrals" (authorization_number, referring_last, referring_first, referring_npi, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (authorization_number) DO UPDATE SET referring_last=$2, referring_first=$3, referring_npi=$4, updated_by=$5, updated_at=now()
       RETURNING *`,
      [auth, last, text(b.referring_first, 35), npi, currentUser.username]
    )).rows[0];
    return json(200, row);
  }

  return null;
}

module.exports = { handle };
