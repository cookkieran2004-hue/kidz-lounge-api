// A patient's programs over time, each with a mandate per service it
// covers (Oct 2026). One PatientPrograms row = one program covering one
// service ("EI, ST, 2x30") from start_date to end_date (NULL = from the
// beginning / still current). A program with no mandate entered yet (every
// patient brought over from the old single Program list) is one row with
// service NULL.
//
// Changing programs or mandates takes effect from a date: rows that change
// end the day before, new rows start on it, so billing for earlier
// appointments still sees what was in effect then (routes/billing.js).
// "Patients"."Program" and "Mandate" keep a plain summary of what's current,
// for the rest of the app.

const SERVICES = ['ST', 'OT', 'PT', 'SI'];
// Billing's section order: EI, then DOE, then insurance, then everything else.
const PROGRAM_ORDER = (p) => {
  const u = String(p || '').toUpperCase();
  if (u === 'EI') return 0;
  if (u === 'CPSE' || u === 'CSE' || u === 'DOE') return 1;
  if (['P', 'PP', 'NONE', 'PRIVATE', 'SELF PAY', 'OTHER', ''].includes(u)) return 3;
  return 2;
};

// Insurance, P and PP programs carry a billing code, shown as the program
// on the billing sheet (Oct 2026). EI / CPSE / CSE / NONE don't.
const BILLING_CODES = ['C-1', 'C-2', 'C-3', 'C-4', 'C-5', 'C-6', 'C-#'];
const NO_CODE_PROGRAMS = new Set(['EI', 'CPSE', 'CSE', 'DOE', 'NONE']);
const takesBillingCode = (program) => !NO_CODE_PROGRAMS.has(String(program || '').trim().toUpperCase());
let codeColumnSeen = false;
async function hasCodeColumn(db) {
  if (codeColumnSeen) return true;
  const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'PatientPrograms' AND column_name = 'billing_code'`);
  if (r.rows.length) codeColumnSeen = true;
  return codeColumnSeen;
}

// EI authorization number per service (migrations/2026-10-20_ei_hub.sql),
// typed into EI-Hub with each session. Only EI rows carry one.
let authColumnSeen = false;
async function hasAuthColumn(db) {
  if (authColumnSeen) return true;
  const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'PatientPrograms' AND column_name = 'authorization_number'`);
  if (r.rows.length) authColumnSeen = true;
  return authColumnSeen;
}
const takesAuthorization = (program) => String(program || '').trim().toUpperCase() === 'EI';

let tableSeen = false;
async function hasProgramsTable(db) {
  if (tableSeen) return true;
  const r = await db.query(`SELECT to_regclass('"PatientPrograms"') AS t`);
  if (r.rows[0]?.t) tableSeen = true;
  return tableSeen;
}

const pad = (n) => String(n).padStart(2, '0');
const day = (v) => (v ? (v instanceof Date ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` : String(v).slice(0, 10)) : null);
function addDays(s, n) {
  const d = new Date(`${s}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const mandateText = (r) => (r.sessions && r.minutes ? `${r.sessions}x${r.minutes}` : null);
const activeOn = (r, date) => (!r.start_date || day(r.start_date) <= date) && (!r.end_date || day(r.end_date) >= date);

// Checks and tidies a plan from the form:
//   { effective_from: 'YYYY-MM-DD' | null,
//     programs: [{ program, mandates: [{ service, sessions: '2' | '1-2', minutes: 30, authorization? }] }] }
// Returns { plan } or { error }.
function cleanPlan(raw) {
  if (!raw || !Array.isArray(raw.programs)) return { error: 'Programs are missing.' };
  const effective = raw.effective_from ? String(raw.effective_from).slice(0, 10) : null;
  if (effective && !/^\d{4}-\d{2}-\d{2}$/.test(effective)) return { error: 'Choose the date the program change starts.' };
  const seenProgram = new Set();
  const serviceOwner = {};
  const programs = [];
  for (const p of raw.programs) {
    const program = String(p?.program || '').trim();
    if (!program) continue;
    if (seenProgram.has(program)) return { error: `${program} is listed twice.` };
    seenProgram.add(program);
    const code = takesBillingCode(program) && BILLING_CODES.includes(p?.billing_code) ? p.billing_code : null;
    const mandates = [];
    for (const m of p.mandates || []) {
      const service = String(m?.service || '').trim().toUpperCase();
      if (!SERVICES.includes(service)) return { error: `Unknown service "${m?.service}".` };
      const sessions = String(m?.sessions ?? '').replace(/\s+/g, '');
      const minutes = Number(m?.minutes);
      if (!/^\d{1,2}(-\d{1,2})?$/.test(sessions)) return { error: `Enter sessions per week for ${program} ${service}, like 2 or 1-2.` };
      if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240) return { error: `Enter the minutes for ${program} ${service}, like 30.` };
      if (serviceOwner[service]) return { error: `${service} can only be under one program at a time. It's under both ${serviceOwner[service]} and ${program}.` };
      serviceOwner[service] = program;
      const authorization = takesAuthorization(program) ? String(m?.authorization || '').trim().slice(0, 40) || null : null;
      mandates.push({ service, sessions, minutes, authorization });
    }
    programs.push({ program, billing_code: code, mandates });
  }
  return { plan: { effective_from: effective, programs } };
}

// Plain-text summaries for "Patients"."Program" / "Mandate".
function summarize(rows) {
  const byProgram = new Map();
  for (const r of rows) {
    if (!byProgram.has(r.program)) byProgram.set(r.program, []);
    if (r.service && mandateText(r)) byProgram.get(r.program).push(`${r.service} ${mandateText(r)}`);
  }
  const programs = [...byProgram.keys()].sort((a, b) => PROGRAM_ORDER(a) - PROGRAM_ORDER(b));
  const mandateParts = programs.filter(p => byProgram.get(p).length).map(p => `${p}: ${byProgram.get(p).join(', ')}`);
  return { program: programs.join(', ') || null, mandate: mandateParts.length ? mandateParts.join('; ') : null };
}

// Rows that are still current (no end date) -- what the form edits.
async function currentRows(q, patientId) {
  return (await q.query(
    'SELECT * FROM "PatientPrograms" WHERE patient_id=$1 AND end_date IS NULL ORDER BY program, service NULLS FIRST', [patientId]
  )).rows;
}

// Providers (staff) don't see or set EI auth #s (Kieran, Oct 2026: no EI
// billing information for providers). Their saves keep each EI service's
// current auth # (none for a service that's new, or for a new patient), so
// a provider changing a mandate can't blank one out by accident.
async function keepAuthorizations(q, patientId, plan) {
  const current = patientId ? await currentRows(q, patientId) : [];
  for (const p of plan.programs) {
    for (const m of p.mandates) {
      if (!takesAuthorization(p.program)) continue;
      const r = current.find(x => x.program === p.program && x.service === m.service);
      m.authorization = r ? r.authorization_number || null : null;
    }
  }
  return plan;
}

// Applies a cleaned plan. Unchanged rows are left alone; changed or removed
// ones end the day before `effective_from` (or are deleted when they would
// start on/after it, or when there's no date -- a new patient); new ones
// start on it. Then refreshes the patient's Program / Mandate summary
// (an old free-text Mandate is kept until per-service mandates exist).
async function applyPlan(q, patientId, plan, username) {
  const eff = plan.effective_from;
  const withCode = await hasCodeColumn(q);
  const withAuth = await hasAuthColumn(q);
  const want = new Map(); // key -> row to have
  for (const p of plan.programs) {
    const code = withCode ? p.billing_code || null : null;
    if (!p.mandates.length) want.set(`${p.program}|`, { program: p.program, service: null, sessions: null, minutes: null, billing_code: code, authorization: null });
    for (const m of p.mandates) want.set(`${p.program}|${m.service}`, { program: p.program, ...m, authorization: withAuth ? m.authorization || null : null, billing_code: code });
  }
  for (const r of await currentRows(q, patientId)) {
    const key = `${r.program}|${r.service || ''}`;
    const w = want.get(key);
    if (w && String(w.sessions ?? '') === String(r.sessions ?? '') && Number(w.minutes ?? 0) === Number(r.minutes ?? 0)
      && (!withCode || (w.billing_code || null) === (r.billing_code || null))
      && (!withAuth || (w.authorization || null) === (r.authorization_number || null))) {
      want.delete(key); // unchanged
      continue;
    }
    if (!eff || (r.start_date && day(r.start_date) >= eff)) {
      await q.query('DELETE FROM "PatientPrograms" WHERE id=$1', [r.id]);
    } else {
      await q.query('UPDATE "PatientPrograms" SET end_date=$1, ended_by=$2 WHERE id=$3', [addDays(eff, -1), username, r.id]);
    }
  }
  for (const w of want.values()) {
    if (withCode && withAuth) {
      await q.query(
        `INSERT INTO "PatientPrograms" (patient_id, program, service, sessions, minutes, start_date, created_by, billing_code, authorization_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [patientId, w.program, w.service, w.sessions, w.minutes, eff, username, w.billing_code, w.authorization]
      );
    } else if (withCode) {
      await q.query(
        `INSERT INTO "PatientPrograms" (patient_id, program, service, sessions, minutes, start_date, created_by, billing_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [patientId, w.program, w.service, w.sessions, w.minutes, eff, username, w.billing_code]
      );
    } else {
      await q.query(
        `INSERT INTO "PatientPrograms" (patient_id, program, service, sessions, minutes, start_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [patientId, w.program, w.service, w.sessions, w.minutes, eff, username]
      );
    }
  }
  const now = await currentRows(q, patientId);
  const { program, mandate } = summarize(now);
  await q.query(
    `UPDATE "Patients" SET "Program"=$1, "Mandate"=COALESCE($2, "Mandate") WHERE id=$3`,
    [program, mandate, patientId]
  );
}

// Deletes one history entry -- for fixing a mistake (Admin / Developer,
// routes/patients.js). Deleting a current entry undoes that change: any
// entry it replaced (ended the day before it started, for the same service,
// or the same program with no mandate yet) becomes current again, unless
// something current already covers that service. Deleting a past entry just
// removes it. Then refreshes the patient's Program / Mandate summary.
// Returns false if the entry isn't this patient's.
async function deleteEntry(q, patientId, entryId) {
  const row = (await q.query('SELECT * FROM "PatientPrograms" WHERE id=$1 AND patient_id=$2', [entryId, patientId])).rows[0];
  if (!row) return false;
  await q.query('DELETE FROM "PatientPrograms" WHERE id=$1', [row.id]);
  if (!row.end_date && row.start_date) {
    const dayBefore = addDays(day(row.start_date), -1);
    const replaced = (await q.query(
      'SELECT * FROM "PatientPrograms" WHERE patient_id=$1 AND end_date=$2 ORDER BY id', [patientId, dayBefore]
    )).rows.filter(c => (row.service && c.service === row.service) || (!c.service && c.program === row.program) || (!row.service && c.program === row.program));
    for (const c of replaced) {
      const current = await currentRows(q, patientId);
      const clash = current.some(x => (c.service ? x.service === c.service : (!x.service && x.program === c.program)));
      if (!clash) await q.query('UPDATE "PatientPrograms" SET end_date=NULL, ended_by=NULL WHERE id=$1', [c.id]);
    }
  }
  const now = await currentRows(q, patientId);
  const { program, mandate } = summarize(now);
  // With no per-service mandates left, fall back to the old free-text one.
  const legacy = now.find(x => x.legacy_mandate)?.legacy_mandate || null;
  await q.query('UPDATE "Patients" SET "Program"=$1, "Mandate"=$2 WHERE id=$3', [program, mandate || legacy, patientId]);
  return true;
}

// Every row for a set of patients (by id), for billing.
async function historyFor(db, patientIds) {
  if (!patientIds.length || !(await hasProgramsTable(db))) return {};
  const rows = (await db.query('SELECT * FROM "PatientPrograms" WHERE patient_id = ANY($1)', [patientIds])).rows;
  const out = {};
  for (const r of rows) (out[r.patient_id] = out[r.patient_id] || []).push(r);
  return out;
}

// The program (and mandate) a session on `date` bills under, for a provider
// whose disciplines are `services` (e.g. ['ST']). Prefers the program that
// covers that service; then a program with no mandates entered yet; then
// any current program. Ties go to the billing order (EI, DOE, insurance,
// other). Returns { program, billing_code, mandate, service, authorization }
// or null when nothing applies.
function programFor(rows, date, services) {
  const live = (rows || []).filter(r => activeOn(r, date));
  if (!live.length) return null;
  const pick = (list) => list.sort((a, b) => PROGRAM_ORDER(a.program) - PROGRAM_ORDER(b.program) || String(a.program).localeCompare(String(b.program)))[0];
  const exact = live.filter(r => r.service && services.includes(r.service));
  const r = exact.length ? pick(exact) : pick(live.filter(x => !x.service).length ? live.filter(x => !x.service) : live);
  return {
    program: r.program, billing_code: r.billing_code || null, mandate: exact.length ? mandateText(r) : (r.legacy_mandate || null),
    service: exact.length ? r.service : null, authorization: exact.length ? r.authorization_number || null : null,
  };
}

// True while a patient only has what the migration brought over (programs
// with the old free-text mandate, never changed) -- the first change may then
// replace them for all dates instead of from a date.
async function onlyOldMandates(q, patientId) {
  const r = await q.query(
    `SELECT COUNT(*)::int AS n FROM "PatientPrograms"
     WHERE patient_id=$1 AND (service IS NOT NULL OR end_date IS NOT NULL OR COALESCE(created_by, '') <> 'migration')`,
    [patientId]
  );
  return r.rows[0].n === 0;
}

module.exports = { keepAuthorizations, BILLING_CODES, takesBillingCode, takesAuthorization, onlyOldMandates, deleteEntry, SERVICES, PROGRAM_ORDER, hasProgramsTable, cleanPlan, applyPlan, currentRows, summarize, historyFor, programFor, mandateText, activeOn };
