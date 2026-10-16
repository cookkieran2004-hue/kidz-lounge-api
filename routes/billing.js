const { json } = require('../lib/http');
const { canManage, canUseEiHub, canAdminister } = require('../lib/roles');
const { getMergedAppointments, getMergedOOO } = require('../lib/recurring');
const { clinicToday, isHold, currentCaseloads } = require('../lib/caseload');
const { loadSchedule, chargeForRequest, addDays, round2 } = require('../lib/workSchedule');
const patientPrograms = require('../lib/patientPrograms');
const { makeMarker, loadClosures } = require('../lib/billingMarks');
const { unitTotals, TOTAL_COLUMNS } = require('../lib/billingTotals');
const { featureOn } = require('../lib/features');
const { computeMandates } = require('../lib/mandates');
// Positive-only cache, so the code works before a migration has run.
const tableSeen = new Set();
async function hasTable(db, name) {
  if (tableSeen.has(name)) return true;
  const r = await db.query('SELECT to_regclass($1) AS t', [`"${name}"`]);
  if (r.rows[0]?.t) { tableSeen.add(name); return true; }
  return false;
}

// Billing sheets (Oct 2026): one provider's month, laid out like the paper
// invoice. Same access as the weekly view: staff see their own linked
// provider, reception/admin/developer any provider.
//
// A row per patient on the provider's caseload that month (lib/caseload.js):
// anyone with an appointment in the month, any status, plus -- for the
// current month -- anyone booked with them later on.
// A day's mark: lib/billingMarks.js.
// *HOLD* sessions and the "HOLD - see comments" placeholder never show.

const DISCIPLINE = { ST: 'Speech Therapy', OT: 'Occupational Therapy', PT: 'Physical Therapy', SI: 'Special Instruction' };
// A provider's disciplines from Providers.specialty, saved as "ST/OT" by the
// specialty picker (older rows may use commas): ['ST', 'OT']. Splitting on
// commas alone read "ST/OT" as one unknown service, so a two-discipline
// provider's sessions billed under whichever program came first.
const disciplinesOf = (specialty) => String(specialty || '').split(/[,/]/).map(x => x.trim().toUpperCase()).filter(Boolean);
const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const pad = (n) => String(n).padStart(2, '0');

// EI, DOE (CPSE/CSE), or Other (insurance, P, PP, none).
function groupFor(program) {
  const parts = String(program || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (parts.includes('EI')) return 'EI';
  if (parts.some(p => p === 'CPSE' || p === 'CSE' || p === 'DOE')) return 'DOE';
  // Insurance and Other are one section, "Other" (Oct 2026).
  return 'Other';
}
// Who pays, for the totals under the sheet (Kieran, Oct 2026): EI, DOE,
// Insurance (BCBS/Anthem, CIGNA, GHI, and private pay P / PP) or Other (no
// program). The table's sections stay EI / DOE / Other.
// 'INSURANCE' / 'PRIVATE PAY': PedsDesk's generic names for the same (Oct 2026).
const INSURANCE_PROGRAMS = new Set(['BCBS/ANTHEM', 'BCBS/ANTHEN', 'CIGNA', 'GHI', 'P', 'PP', 'INSURANCE', 'PRIVATE PAY']);
function payGroupFor(program) {
  const group = groupFor(program);
  if (group !== 'Other') return group;
  const parts = String(program || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  return parts.some(p => INSURANCE_PROGRAMS.has(p)) ? 'Insurance' : 'Other';
}
// A session's setting for the Setting column: an in-office room is C
// (center); an offsite session is C, S or H from the setting picked with it
// ("Offsite (School): ..." -- the frontend's makeOffsiteArea); no room, or
// an older offsite session with no setting, is blank.
const SETTING_LETTER = { Center: 'C', School: 'S', Home: 'H' };
function settingOf(area) {
  const a = String(area || '').trim();
  if (!a) return '';
  const m = a.match(/^Offsite(?: \((Center|School|Home)\))?(?::|$)/i);
  if (!m) return 'C';
  return m[1] ? SETTING_LETTER[m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()] : '';
}

async function buildSheet(db, provider, month) {
  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const end = `${month}-${pad(daysInMonth)}`;
  const today = clinicToday();

  const [apptsAll, oooAll, closures, providerRes, staffRes] = await Promise.all([
    getMergedAppointments(db, { startDate: start, endDate: end, provider }),
    getMergedOOO(db, { startDate: start, endDate: end, provider }),
    loadClosures(db, start, end),
    db.query('SELECT "Name", specialty FROM "Providers" WHERE "Name"=$1', [provider]),
    db.query('SELECT phone FROM "Staff" WHERE provider_name=$1 AND archived = false LIMIT 1', [provider]),
  ]);
  // A make-up or eval that was itself canceled or no-showed drops off the sheet.
  const appts = apptsAll.filter(a => a.appointment_status !== '*HOLD*' && !isHold(a.patient_name)
    && !((a.is_makeup || a.is_eval) && (a.appointment_status === 'Canceled' || a.appointment_status === 'No Show')));

  // The provider's caseload for the month (lib/caseload.js): everyone with
  // an appointment that month (any status), and -- for the current month --
  // anyone booked with them later on, who shows with no sessions yet. It
  // follows the schedule: a patient whose only appointment is moved to
  // another provider or deleted drops off.
  const names = [...new Set(appts.map(a => a.patient_name))];
  if (today >= start && today <= end) {
    for (const [name, providers] of await currentCaseloads(db, { today, provider })) {
      if (providers.has(provider) && !names.includes(name)) names.push(name);
    }
  }
  const patients = names.length
    ? (await db.query('SELECT id, "Name", "Mandate", "Program" FROM "Patients" WHERE "Name" = ANY($1)', [names])).rows
    : [];
  const patientByName = Object.fromEntries(patients.map(p => [p.Name, p]));

  const markFor = makeMarker({ closures, ooo: oooAll, today });

  // Which program (and mandate) each session bills under: the patient's
  // program history on the session's date, for this provider's discipline
  // (lib/patientPrograms.js). A child whose program or mandate changed
  // during the month gets a row for each, and so does each setting (Kieran,
  // Oct 15 2026: a child seen at the center and at home is one line for C
  // and one for H; sessions with no setting get their own blank line, to
  // fix). Before that migration, or for a
  // patient with no history, their current Program / Mandate.
  const services = disciplinesOf(providerRes.rows[0]?.specialty);
  const history = await patientPrograms.historyFor(db, patients.map(p => p.id));
  const billAs = (name, date) => {
    const p = patientByName[name] || {};
    const hit = patientPrograms.programFor(history[p.id], date, services);
    if (hit) return { program: hit.program, mandate: hit.mandate, code: hit.billing_code };
    return { program: p.Program || null, mandate: p.Mandate || null, code: null };
  };
  const rowMap = new Map();
  // An insurance / P / PP program shows as its billing code (C-1 ... C-#);
  // with none entered yet, its name plus needs_code (a red # on the sheet).
  const rowFor = (name, program, mandate, code = null, setting = '') => {
    const coded = program && String(program).split(',').some(x => patientPrograms.takesBillingCode(x.trim()));
    const shown = coded && code ? code : program;
    const key = `${name}\u0000${shown || ''}\u0000${mandate || ''}\u0000${setting}`;
    if (!rowMap.has(key)) {
      rowMap.set(key, { patient_name: name, mandate, program: shown, needs_code: !!(coded && !code), group: groupFor(program), pay_group: payGroupFor(program), setting, days: {}, scheduled: 0, total_sessions: 0 });
    }
    return rowMap.get(key);
  };
  for (const a of appts) {
    const date = String(a.appointment_date).slice(0, 10);
    const { program, mandate, code } = billAs(a.patient_name, date);
    const row = rowFor(a.patient_name, program, mandate, code, settingOf(a.treatment_area) || '');
    const d = Number(date.slice(8, 10));
    const mark = markFor(a);
    if (mark === 'X' || mark === 'M' || mark === 'E') row.total_sessions += 1;
    // Sessions on a closed day (H or Z) still show, but aren't scheduled; nor
    // is a make-up -- the canceled session it replaces already was.
    if (mark !== 'H' && mark !== 'Z' && !a.is_makeup) row.scheduled += 1;
    (row.days[d] = row.days[d] || []).push({ mark, status: a.appointment_status, time: String(a.appointment_time).slice(0, 5), room: a.treatment_area || null, id: a.id, outside_hours: !!a.outside_hours, duration: Number(a.duration) || 30 });
  }
  // On the caseload with no sessions this month (booked later on): their program today.
  for (const name of names) {
    if ([...rowMap.values()].some(r => r.patient_name === name)) continue;
    const { program, mandate, code } = billAs(name, today);
    rowFor(name, program, mandate, code);
  }
  // By name; a child's program / mandate periods by their first day; within
  // one, the settings in C, S, H order, then the line with no setting.
  const firstDay = (r) => Number(Object.keys(r.days)[0] || 99);
  const periodStart = new Map();
  for (const r of rowMap.values()) {
    const k = `${r.patient_name}\u0000${r.program || ''}\u0000${r.mandate || ''}`;
    periodStart.set(k, Math.min(periodStart.get(k) ?? 99, firstDay(r)));
  }
  const startOf = (r) => periodStart.get(`${r.patient_name}\u0000${r.program || ''}\u0000${r.mandate || ''}`);
  const SETTING_ORDER = { C: 0, S: 1, H: 2, '': 3 };
  const rows = [...rowMap.values()].sort((a, b) => a.patient_name.localeCompare(b.patient_name)
    || startOf(a) - startOf(b) || SETTING_ORDER[a.setting] - SETTING_ORDER[b.setting]);

  let reviewed = null;
  if (await hasTable(db, 'BillingReviews')) {
    reviewed = (await db.query('SELECT reviewed_by, reviewed_at FROM "BillingReviews" WHERE provider=$1 AND month=$2', [provider, start])).rows[0] || null;
  }
  const spec = providerRes.rows[0]?.specialty || '';
  const timeOff = await timeOffHours(db, provider, start, end);
  return {
    provider,
    month,
    start,
    end,
    today,
    days_in_month: daysInMonth,
    discipline: disciplinesOf(spec).map(s => DISCIPLINE[s] || s).join(', '),
    phone: staffRes.rows[0]?.phone || null,
    closures,
    rows,
    reviewed,
    time_off: timeOff,
    // The payroll totals in 30-minute units (lib/billingTotals.js).
    totals: unitTotals(rows),
  };
}

// ---------------------------------------------------------------------------
// EI-Hub entry (Oct 2026). EI sessions are typed into the state's EI-Hub by
// hand (Reception), one by one. This lists every EI session that took place
// in a month -- the same ones the billing sheets mark X, M or E -- with what
// EI-Hub asks for, and tracks which have been entered ("EiHubEntries",
// migrations/2026-10-20_ei_hub.sql). An 837P claim file for EI-Hub's file
// loader can be built from the same list once the state's companion guide
// is in hand.
//
// A session is EI when the program it bills under on its date (the
// patient's program history, for the provider's discipline -- the same
// rule as the billing sheet) is EI. Skipped: days not over yet, office
// closures, sessions while the provider was out (PA), Canceled / No Show,
// *HOLD* and the HOLD placeholder.

const SETTING_NAME = { C: 'Center', S: 'School', H: 'Home' };
// An EI-Hub authorization's visit type: "Facility" (at the agency) or
// "Basic" (home and community: the child's home, day care, school), from
// Program ("Speech Language - Facility") or else Location Type. A child can
// have both for one service at once, and EI-Hub rejects a session billed
// against the wrong one (Kieran, Oct 2026: pick by the session's setting).
function authVisitType(x) {
  const kind = String(x.program || '').split(' - ').slice(1).join(' - ');
  if (/facility/i.test(kind)) return 'facility';
  if (/basic|home|community/i.test(kind)) return 'basic';
  if (/agency provider site|facility/i.test(x.location_type || '')) return 'facility';
  if (/home|day care|daycare|community|school/i.test(x.location_type || '')) return 'basic';
  return null;
}
const VISIT_TYPE_OF_SETTING = { Center: 'facility', Home: 'basic', School: 'basic' };
const day10 = (v) => String(v).slice(0, 10);
const toTime = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

// Stays the same when a weekly-series date is edited into its own row, so
// a tick isn't lost (or doubled) by that.
function sessionKey(a) {
  if (a.is_virtual) return `series:${a.series_id}:${day10(a.appointment_date)}`;
  if (a.exception_of_series_id) return `series:${a.exception_of_series_id}:${day10(a.exception_occurrence_date)}`;
  return `appt:${a.id}`;
}
const SESSION_KEY_RE = /^(appt:[\w-]+|series:[\w-]+:\d{4}-\d{2}-\d{2})$/;

// Whether a session with a provider of these disciplines bills under EI on
// this date, and for which service: null when it doesn't, else { service,
// authorization, mandate, options }. A provider with more than one
// discipline (ST/OT) seeing a child with EI services in both: an appointment
// doesn't say which service it was, so don't guess (programFor would just
// take the first) -- options lists them and service is null.
function eiServiceFor(rows, date, services, programSummary) {
  const hit = patientPrograms.programFor(rows, date, services);
  if (groupFor(hit ? hit.program : programSummary) !== 'EI') return null;
  const options = [...new Set((rows || [])
    .filter(r => r.program === 'EI' && r.service && services.includes(r.service) && patientPrograms.activeOn(r, date))
    .map(r => r.service))];
  if (options.length > 1) return { service: null, authorization: null, mandate: null, options };
  return {
    service: hit?.service || (services.length === 1 ? services[0] : null),
    authorization: hit?.authorization || null,
    mandate: hit?.mandate || null,
    options: null,
  };
}

async function eiHubSessions(db, month) {
  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const end = `${month}-${pad(new Date(y, m, 0).getDate())}`;
  const today = clinicToday();
  const [apptsAll, ooo, closuresRes, providersRes] = await Promise.all([
    getMergedAppointments(db, { startDate: start, endDate: end }),
    getMergedOOO(db, { startDate: start, endDate: end }),
    db.query('SELECT closure_date FROM "OfficeClosures" WHERE closure_date BETWEEN $1 AND $2', [start, end]),
    db.query('SELECT "Name", specialty FROM "Providers"'),
  ]);
  const closed = new Set(closuresRes.rows.map(c => day10(c.closure_date)));
  const specialty = Object.fromEntries(providersRes.rows.map(p => [p.Name, disciplinesOf(p.specialty)]));
  const providerOut = (a) => ooo.some(o => o.provider === a.provider && day10(o.ooo_date) === day10(a.appointment_date)
    && mins(o.start_time) < mins(a.appointment_time) + (Number(a.duration) || 30) && mins(a.appointment_time) < mins(o.end_time));
  const appts = apptsAll.filter(a => {
    const date = day10(a.appointment_date);
    return date < today && !closed.has(date)
      && a.appointment_status !== '*HOLD*' && !isHold(a.patient_name)
      && a.appointment_status !== 'Canceled' && a.appointment_status !== 'No Show'
      && !providerOut(a);
  });

  const names = [...new Set(appts.map(a => a.patient_name).filter(Boolean))];
  const patients = names.length
    ? (await db.query('SELECT id, "Name", "ID_Number", "Program" FROM "Patients" WHERE "Name" = ANY($1)', [names])).rows
    : [];
  const byName = Object.fromEntries(patients.map(p => [p.Name, p]));
  const history = await patientPrograms.historyFor(db, patients.map(p => p.id));

  const entries = {};
  if (await hasTable(db, 'EiHubEntries')) {
    (await db.query('SELECT * FROM "EiHubEntries" WHERE appointment_date BETWEEN $1 AND $2', [start, end]))
      .rows.forEach(e => { entries[e.session_key] = e; });
  }

  // Authorizations imported from EI-Hub (lib/eiImport.js): when a child has
  // any for a service, the one covering the session's date is its auth #
  // (they change every few months; the mandate's auth # is the fallback).
  const eiAuths = {};
  if (await hasTable(db, 'EiAuthorizations') && patients.length) {
    (await db.query('SELECT * FROM "EiAuthorizations" WHERE patient_id = ANY($1)', [patients.map(x => x.id)]))
      .rows.forEach(x => { (eiAuths[x.patient_id] = eiAuths[x.patient_id] || []).push(x); });
  }

  const sessions = [];
  for (const a of appts) {
    const date = day10(a.appointment_date);
    const p = byName[a.patient_name] || {};
    const services = specialty[a.provider] || [];
    const ei = eiServiceFor(history[p.id], date, services, p.Program);
    if (!ei) continue;
    const { service, options: eiServices } = ei;
    let { authorization } = ei;
    const unclear = !!eiServices;
    const setting = SETTING_NAME[settingOf(a.treatment_area)] || null;
    const imported = service ? (eiAuths[p.id] || []).filter(x => x.service === service) : [];
    const covering = imported.filter(x => (!x.start_date || day10(x.start_date) <= date) && (!x.end_date || day10(x.end_date) >= date));
    // The one for this session's setting (center: Facility; home / school:
    // Basic); one of unknown type fits either. No setting: the first.
    const wantType = VISIT_TYPE_OF_SETTING[setting] || null;
    const authRecord = (wantType ? covering.find(x => authVisitType(x) === wantType) || covering.find(x => !authVisitType(x)) : covering[0]) || null;
    const wrongType = !authRecord && covering.length > 0;
    if (authRecord) authorization = authRecord.authorization_number;
    const startM = mins(a.appointment_time);
    const duration = Number(a.duration) || 30;
    const key = sessionKey(a);
    const problems = [];
    if (!p.ID_Number) problems.push('No ID # (EI child ID) on the patient');
    if (unclear) problems.push(`Check the service: ${a.provider} could have given ${eiServices.join(' or ')}`);
    // What the imported EI-Hub authorizations say (also blocks a claim file;
    // routes/eiHub.js claimData): EI-Hub rejects a session outside them.
    const authProblems = [];
    if (!unclear && wrongType) {
      authProblems.push(`The ${service} authorization for this date is ${authVisitType(covering[0]) === 'facility' ? 'Facility (at the agency)' : 'Basic (home / community)'}, but the session is ${setting === 'Center' ? 'at the center' : `at ${String(setting).toLowerCase()}`}`);
    } else if (!unclear && imported.length && !authRecord) authProblems.push(`No ${service} authorization in EI-Hub covers this date`);
    if (authRecord && authRecord.suspended_start && day10(authRecord.suspended_start) <= date
      && (!authRecord.suspended_end || day10(authRecord.suspended_end) >= date)) authProblems.push('The authorization is suspended on this date');
    if (!unclear && !authProblems.length && !authorization) problems.push(`No EI authorization number for ${service || 'this service'} on this date`);
    problems.push(...authProblems);
    if (!setting) problems.push('No room or offsite setting');
    const e = entries[key];
    sessions.push({
      key,
      appointment_id: a.id,
      date,
      start_time: toTime(startM),
      end_time: toTime(startM + duration),
      duration,
      patient_name: a.patient_name,
      ei_child_id: p.ID_Number || null,
      provider: a.provider,
      service,
      service_options: unclear ? eiServices : null,
      authorization,
      // EI-Hub's count at the last import (null when not imported).
      auth_problems: authProblems,
      auth_remaining: authRecord && authRecord.sessions_remaining !== null ? Number(authRecord.sessions_remaining) : null,
      setting,
      is_makeup: !!a.is_makeup,
      is_eval: !!a.is_eval,
      problems,
      entered: e ? {
        by: e.entered_by,
        at: e.entered_at,
        // Moved, shortened or given to someone else after it was entered:
        // EI-Hub may need correcting.
        changed: day10(e.appointment_date) !== date || String(e.appointment_time).slice(0, 5) !== toTime(startM)
          || Number(e.duration) !== duration || (e.provider || null) !== (a.provider || null),
      } : null,
    });
  }
  sessions.sort((x, y) => (x.date + x.start_time).localeCompare(y.date + y.start_time) || String(x.provider).localeCompare(String(y.provider)));
  return { month, start, end, today, tracking: await hasTable(db, 'EiHubEntries'), sessions };
}

// The provider's approved PTO and UPTO for days in the month, in hours --
// the same scheduled-hours cost as the request itself (lib/workSchedule.js),
// counting only a cross-month request's days in this month.
async function timeOffHours(db, provider, start, end) {
  const out = { PTO: 0, UPTO: 0, requests: [] };
  const staff = (await db.query(
    'SELECT username, provider_name, hire_date, archived FROM "Staff" WHERE provider_name=$1 ORDER BY archived LIMIT 1', [provider]
  )).rows[0];
  if (!staff) return out;
  const reqs = (await db.query(
    `SELECT * FROM "TimeOffRequests"
     WHERE username=$1 AND status='approved' AND is_balance_type AND request_type IN ('PTO', 'UPTO')
       AND start_date <= $3 AND end_date >= $2
     ORDER BY start_date`,
    [staff.username, start, end]
  )).rows;
  if (!reqs.length) return out;
  const day = (v) => String(v).slice(0, 10);
  const lo = reqs.reduce((m, r) => (day(r.start_date) < m ? day(r.start_date) : m), start);
  const hi = reqs.reduce((m, r) => (day(r.end_date) > m ? day(r.end_date) : m), end);
  const schedule = await loadSchedule(db, staff, lo, hi);
  for (const r0 of reqs) {
    const r = { ...r0, start_date: day(r0.start_date), end_date: day(r0.end_date) };
    const from = r.start_date > start ? r.start_date : start;
    const hours = round2(chargeForRequest(schedule, r, from) - (r.end_date > end ? chargeForRequest(schedule, r, addDays(end, 1)) : 0));
    if (hours <= 0) continue;
    out[r.request_type] = round2(out[r.request_type] + hours);
    out.requests.push({ type: r.request_type, start_date: from, end_date: r.end_date > end ? end : r.end_date, hours });
  }
  return out;
}

// Every provider's month (the "mandates" feature's overview): their payroll
// totals in 30-minute units, PTO / UPTO taken and Reviewed, from the same
// billing sheet each one opens to (buildSheet). `own`: just that provider.
async function monthOverview(db, month, own = null) {
  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const end = `${month}-${pad(new Date(y, m, 0).getDate())}`;
  let names;
  if (own) names = [own];
  else {
    const appts = await getMergedAppointments(db, { startDate: start, endDate: end });
    names = [...new Set(appts.filter(a => a.appointment_status !== '*HOLD*' && !isHold(a.patient_name)).map(a => a.provider).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }
  const providers = [];
  for (const name of names) {
    const sheet = await buildSheet(db, name, month);
    providers.push({ provider: name, discipline: sheet.discipline, totals: sheet.totals, time_off: { PTO: sheet.time_off?.PTO ?? 0, UPTO: sheet.time_off?.UPTO ?? 0 }, reviewed: sheet.reviewed });
  }
  const clinic = Object.fromEntries(TOTAL_COLUMNS.map(([k]) => [k, providers.reduce((t, p) => t + p.totals[k], 0)]));
  clinic.sessions = providers.reduce((t, p) => t + p.totals.sessions, 0);
  clinic.PTO = providers.reduce((t, p) => t + Number(p.time_off.PTO || 0), 0);
  clinic.UPTO = providers.reduce((t, p) => t + Number(p.time_off.UPTO || 0), 0);
  return { month, start, end, today: clinicToday(), columns: TOTAL_COLUMNS, providers, clinic };
}

async function handle(ctx) {
  const { path, method, qs, body, db, currentUser } = ctx;

  if (path === '/billing' && method === 'GET') {
    let provider = qs.provider;
    if (!canManage(currentUser)) {
      if (!currentUser.providerName) return json(403, { error: 'No provider is linked to your account.' });
      provider = currentUser.providerName;
    }
    const month = String(qs.month || '').trim();
    if (!provider) return json(400, { error: 'Choose a provider.' });
    if (!/^\d{4}-\d{2}$/.test(month)) return json(400, { error: 'Choose a month.' });
    const sheet = await buildSheet(db, provider, month);
    // With mandates on: problem sessions are flagged on the sheet (a make-up
    // past its 14 days or on a regular session's day, more sessions than the
    // mandate allows; lib/mandates.js).
    if (featureOn('mandates')) {
      const { session_flags: flags } = await computeMandates(db, { month, provider });
      for (const r of sheet.rows) for (const entries of Object.values(r.days)) for (const e of entries) if (flags[String(e.id)]) e.flags = flags[String(e.id)];
    }
    return json(200, sheet);
  }

  // ---- Month overview, mandates, needs attention (the "mandates" feature) ----
  // Reception, Admin and Developer see every provider and child; a provider
  // sees only their own row and the children they saw.
  const billingFeature = ['/billing/overview', '/billing/mandates', '/billing/attention', '/billing/program-on'].includes(path);
  if (billingFeature && method === 'GET') {
    if (!featureOn('mandates')) return json(404, { error: 'Not available at this clinic.' });
    const manager = canManage(currentUser);
    const own = manager ? null : currentUser.providerName;
    if (!manager && !own) return json(403, { error: 'No provider is linked to your account.' });

    // The program a session would bill under (the appointment window asks
    // why a child was absent only for EI): ?patient=&provider=&date=
    if (path === '/billing/program-on') {
      const { patient, date } = qs;
      const prov = qs.provider;
      if (!patient || !prov || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return json(400, { error: 'patient, provider and date are required.' });
      const p = (await db.query('SELECT id, "Program" FROM "Patients" WHERE "Name"=$1', [patient])).rows[0];
      if (!p) return json(200, { program: null, group: null });
      const spec = (await db.query('SELECT specialty FROM "Providers" WHERE "Name"=$1', [prov])).rows[0]?.specialty;
      const history = await patientPrograms.historyFor(db, [p.id]);
      const hit = patientPrograms.programFor(history[p.id], date, disciplinesOf(spec));
      const program = hit?.program || p.Program || null;
      return json(200, { program, group: program ? groupFor(program) : null });
    }

    const month = String(qs.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return json(400, { error: 'Choose a month.' });
    if (path === '/billing/mandates') return json(200, await computeMandates(db, { month, provider: own || qs.provider || null }));
    const overview = await monthOverview(db, month, own);
    if (path === '/billing/overview') return json(200, overview);
    // Needs attention: the mandates' problems plus each sheet's (not
    // reviewed after the month ended, sessions no total counts).
    const mandates = await computeMandates(db, { month, provider: own });
    const issues = [...mandates.issues];
    for (const pr of overview.providers) {
      for (const m of pr.totals.missed) issues.push({ type: 'not_counted', severity: 'warning', providers: [pr.provider], patient_name: m.patient_name, date: `${month}-${pad(m.day)}`, text: `Not in any payroll total: ${m.reason}` });
      if (!pr.reviewed && overview.end < overview.today) issues.push({ type: 'not_reviewed', severity: 'warning', providers: [pr.provider], text: `${pr.provider}'s billing sheet isn't marked reviewed` });
    }
    const rank = { danger: 0, warning: 1 };
    issues.sort((a, b) => rank[a.severity] - rank[b.severity] || String(a.date || '').localeCompare(String(b.date || '')));
    return json(200, { month, today: mandates.today, issues });
  }

  // A provider's caseload right now (staff profile > Caseload): each patient
  // with their program and next appointment with this provider. Staff see
  // their own; reception, admin and developer anyone's.
  const cm = path.match(/^\/providers\/([^/]+)\/caseload$/);
  if (cm && method === 'GET') {
    const provider = decodeURIComponent(cm[1]);
    if (!canManage(currentUser) && currentUser.providerName !== provider) return json(403, { error: 'You can only see your own caseload.' });
    const today = clinicToday();
    const names = [...(await currentCaseloads(db, { today, provider })).keys()];
    if (!names.length) return json(200, []);
    const horizon = addDays(today, 365);
    const [patientsRes, upcoming] = await Promise.all([
      db.query('SELECT "Name", "Program", "Status" FROM "Patients" WHERE "Name" = ANY($1)', [names]),
      getMergedAppointments(db, { startDate: today, endDate: horizon, provider }),
    ]);
    const info = Object.fromEntries(patientsRes.rows.map(p => [p.Name, p]));
    const next = {};
    for (const a of upcoming) {
      if (a.appointment_status === 'Canceled' || next[a.patient_name]) continue;
      next[a.patient_name] = { date: String(a.appointment_date).slice(0, 10), time: String(a.appointment_time).slice(0, 5) };
    }
    return json(200, names.sort((a, b) => a.localeCompare(b)).map(name => ({
      patient_name: name,
      program: info[name]?.Program || null,
      status: info[name]?.Status || null,
      next_appointment: next[name] || null,
    })));
  }

  // EI-Hub entry list (see eiHubSessions): Admins and Developers.
  if (path === '/billing/ei-hub' && method === 'GET') {
    if (!canUseEiHub(currentUser)) return json(403, { error: 'The EI-Hub list is only open to Admins and Developers.' });
    const month = String(qs.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return json(400, { error: 'Choose a month.' });
    return json(200, await eiHubSessions(db, month));
  }

  // Ticks (or unticks) a session as entered in EI-Hub. The body carries the
  // session as it is now, kept with the tick to spot later changes.
  if (path === '/billing/ei-hub/entered' && method === 'PUT') {
    if (!canUseEiHub(currentUser)) return json(403, { error: 'The EI-Hub list is only open to Admins and Developers.' });
    const { session_key: key, entered, patient_name, appointment_date, appointment_time, duration, provider } = body || {};
    if (!SESSION_KEY_RE.test(String(key || ''))) return json(400, { error: 'Unknown session.' });
    if (!(await hasTable(db, 'EiHubEntries'))) return json(409, { error: 'Tracking EI-Hub entry needs the 2026-10-20 migration. Ask an admin to run it.' });
    if (!entered) {
      await db.query('DELETE FROM "EiHubEntries" WHERE session_key=$1', [key]);
      return json(200, { ok: true });
    }
    // Already in a claim file: entering it by hand too would bill it twice.
    if (await hasTable(db, 'EiClaims')) {
      const sent = (await db.query('SELECT claim_number FROM "EiClaims" WHERE session_key=$1 AND NOT test LIMIT 1', [key])).rows[0];
      if (sent) return json(409, { error: `This session was already sent to EI-Hub in a claim file (${sent.claim_number}).` });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(appointment_date || '')) || !/^\d{2}:\d{2}/.test(String(appointment_time || '')) || !(Number(duration) > 0)) {
      return json(400, { error: 'The session date, time and length are required.' });
    }
    // PedsDesk ("ei" feature): billing by hand needs the signed session
    // note too, as a claim file does (routes/eiHub.js). Required here, not
    // at the top: lib/sessionNotes.js requires this file.
    if (featureOn('ei') && (await hasTable(db, 'EiSessionNotes'))) {
      const done = await require('../lib/sessionNotes').completeNoteKeys(db, [key]);
      if (!done.has(key)) return json(409, { error: 'This session has no session note signed by the provider and the parent yet, so it can\'t be billed.' });
    }
    await db.query(
      `INSERT INTO "EiHubEntries" (session_key, patient_name, appointment_date, appointment_time, duration, provider, entered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (session_key) DO UPDATE SET patient_name=$2, appointment_date=$3, appointment_time=$4, duration=$5, provider=$6, entered_by=$7, entered_at=now()`,
      [key, patient_name || null, appointment_date, String(appointment_time).slice(0, 5), Number(duration), provider || null, currentUser.username]
    );
    return json(200, { ok: true });
  }

  // The REVIEWED box: Admin and Developer.
  if (path === '/billing/review' && method === 'PUT') {
    if (!canAdminister(currentUser)) return json(403, { error: 'Only an Admin or Developer can mark a sheet reviewed.' });
    const { provider, month, reviewed } = body || {};
    if (!provider || !/^\d{4}-\d{2}$/.test(month || '')) return json(400, { error: 'provider and month are required.' });
    if (!(await hasTable(db, 'BillingReviews'))) return json(409, { error: 'Billing reviews need the 2026-10-13 migration.' });
    if (reviewed) {
      await db.query(
        `INSERT INTO "BillingReviews" (provider, month, reviewed_by) VALUES ($1, $2, $3)
         ON CONFLICT (provider, month) DO UPDATE SET reviewed_by=$3, reviewed_at=now()`,
        [provider, `${month}-01`, currentUser.username]
      );
    } else {
      await db.query('DELETE FROM "BillingReviews" WHERE provider=$1 AND month=$2', [provider, `${month}-01`]);
    }
    return json(200, { ok: true });
  }

  return null;
}

// eiServiceFor / settingOf / disciplinesOf: also EI session notes (lib/sessionNotes.js).
module.exports = { handle, groupFor, buildSheet, eiHubSessions, sessionKey, eiServiceFor, settingOf, disciplinesOf, SESSION_KEY_RE };
