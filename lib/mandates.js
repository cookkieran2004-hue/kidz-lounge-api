// Mandates (Oct 2026, behind the "mandates" feature, lib/features.js): is
// each child getting the sessions their mandate says, week by week? One row
// per child and service (ST / OT / PT / SI), a cell per Sunday-Saturday week
// (Kieran's choice), for every program (EI, DOE, insurance, P, PP, other).
//
// Rules (Kieran, Oct 2026, checked against the NYS DOH "Policy for the
// Provision of Make-up Early Intervention Program Visits", Oct 26 2023,
// under 10 NYCRR 69-4.9(g)(2)(ii)(a)):
//   - A week owes the mandate's sessions per week. Each day uses the mandate
//     in effect that day (EI-Hub ends the old authorization the day before
//     an amendment starts), so a week where it changes owes a blend
//     (rounded). Ranges like "1-2" owe the low end and allow the high end.
//   - Credited: sessions provided (X), make-ups provided for that week's
//     misses (counted in the week of the session they replace), and excused
//     misses: holidays (H) for every program; a family vacation for EI.
//   - EI make-ups (only EI; DOE and the rest show delivered vs owed):
//     owed for a child absence (illness / other / not given), a provider
//     absence (PA, vacation included) and an emergency closure (Z, weather);
//     not for a holiday or a family vacation. One must happen within 14
//     calendar days after the missed session, inside the authorization
//     period, never on a day with a regular session for that child and
//     service, and only as many as EI-Hub's authorization allows. Missing
//     authorization data shows as "check authorization", never as allowed.
//   - Frequency: more regular sessions in a week than the mandate allows is
//     flagged; make-ups that take a week over need make-ups authorized.
//   - A child absent from more than 3 consecutive EI sessions: the provider
//     must tell the service coordinator within 24 hours (the daily check
//     makes a task, lib/complianceCheck.js).
// Weeks that cross a month edge are checked whole; only the month's summary
// figures are prorated by the days inside the month.
const { getMergedAppointments, getMergedOOO } = require('./recurring');
const { clinicToday, isHold } = require('./caseload');
const { makeMarker, loadClosures } = require('./billingMarks');
const patientPrograms = require('./patientPrograms');

const pad = (n) => String(n).padStart(2, '0');
const day = (v) => (v ? (v instanceof Date ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` : String(v).slice(0, 10)) : null);
function addDays(s, n) {
  const d = new Date(`${s}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const weekday = (s) => new Date(`${s}T00:00:00`).getDay(); // 0 = Sunday
const sundayOf = (s) => addDays(s, -weekday(s));
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);
const disciplinesOf = (specialty) => String(specialty || '').split(/[,/]/).map(x => x.trim().toUpperCase()).filter(Boolean);

// "Sep 29" for the messages people read.
const nice = (ymd) => (ymd ? new Date(`${ymd}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');

const MAKEUP_DAYS = 14;
const STREAK = 4; // "more than three consecutive"
const DUE_SOON_DAYS = 3;

function groupFor(program) {
  const parts = String(program || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (parts.includes('EI')) return 'EI';
  if (parts.some(p => p === 'CPSE' || p === 'CSE' || p === 'DOE')) return 'DOE';
  return 'Other';
}
// "2" -> { min: 2, max: 2 }, "1-2" -> { min: 1, max: 2 }
function parseSessions(v) {
  const m = String(v ?? '').match(/^(\d{1,2})(?:-(\d{1,2}))?$/);
  if (!m) return null;
  const min = Number(m[1]);
  return { min, max: m[2] ? Math.max(min, Number(m[2])) : min };
}

let authTableSeen = false;
async function hasAuthTable(db) {
  if (authTableSeen) return true;
  const r = await db.query(`SELECT to_regclass('"EiAuthorizations"') AS t`);
  if (r.rows[0]?.t) authTableSeen = true;
  return authTableSeen;
}

const DELIVERED = new Set(['X', 'M']);
const MISS_LABEL = { A: 'Child absent', PA: 'Provider absent', Z: 'Emergency closure', H: 'Holiday' };
const REASON_LABEL = { illness: 'illness', vacation: 'family vacation', other: 'other' };

// { start, end } -> the weeks (Sunday-Saturday) that touch it.
function weeksCovering(start, end) {
  const out = [];
  for (let s = sundayOf(start); s <= end; s = addDays(s, 7)) {
    const e = addDays(s, 6);
    let inside = 0;
    for (let i = 0; i < 7; i++) { const d = addDays(s, i); if (d >= start && d <= end) inside++; }
    out.push({ start: s, end: e, days_inside: inside });
  }
  return out;
}

// The month's mandates. `provider`: only children that provider saw in
// those weeks (a provider's own view). Returns
//   { month, start, end, today, weeks, rows, issues, session_flags }
async function computeMandates(db, { month, provider = null, today = clinicToday() }) {
  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const end = `${month}-${pad(new Date(y, m, 0).getDate())}`;
  const weeks = weeksCovering(start, end);
  const wStart = weeks[0].start;
  const wEnd = weeks[weeks.length - 1].end;
  // Earlier sessions for absence streaks; later ones for make-ups (14 days).
  const fetchStart = addDays(wStart, -28);
  const fetchEnd = addDays(wEnd, MAKEUP_DAYS + 7);

  const [apptsAll, ooo, closures, providerRes] = await Promise.all([
    getMergedAppointments(db, { startDate: fetchStart, endDate: fetchEnd }),
    getMergedOOO(db, { startDate: fetchStart, endDate: fetchEnd }),
    loadClosures(db, fetchStart, fetchEnd),
    db.query('SELECT "Name", specialty FROM "Providers"'),
  ]);
  const markFor = makeMarker({ closures, ooo, today, early: true });
  const specialtyOf = Object.fromEntries(providerRes.rows.map(p => [p.Name, disciplinesOf(p.specialty)]));
  const appts = apptsAll.filter(a => a.appointment_status !== '*HOLD*' && !isHold(a.patient_name) && !a.is_eval);

  // Children with a mandate in effect this month but nothing booked are
  // part of the picture too (only in the full view: they have no provider).
  const withMandate = (await patientPrograms.hasProgramsTable(db)) && !provider
    ? (await db.query(
      `SELECT DISTINCT p."Name" FROM "PatientPrograms" pp JOIN "Patients" p ON p.id = pp.patient_id
       WHERE pp.service IS NOT NULL AND pp.sessions IS NOT NULL
         AND (pp.start_date IS NULL OR pp.start_date <= $2) AND (pp.end_date IS NULL OR pp.end_date >= $1)
         AND p."Status" IS DISTINCT FROM 'Off Program'`, [wStart, wEnd])).rows.map(r => r.Name)
    : [];
  const names = [...new Set([...appts.map(a => a.patient_name), ...withMandate])];
  const patients = names.length ? (await db.query('SELECT id, "Name", "Program" FROM "Patients" WHERE "Name" = ANY($1)', [names])).rows : [];
  const patientByName = Object.fromEntries(patients.map(p => [p.Name, p]));
  const history = await patientPrograms.historyFor(db, patients.map(p => p.id));
  const auths = patients.length && (await hasAuthTable(db))
    ? (await db.query('SELECT * FROM "EiAuthorizations" WHERE patient_id = ANY($1)', [patients.map(p => p.id)])).rows
    : [];

  // The mandate for one child and service on a date.
  const mandateOn = (pid, service, date) => {
    const live = (history[pid] || []).filter(r => r.service === service && r.sessions && patientPrograms.activeOn(r, date));
    if (!live.length) return null;
    live.sort((a, b) => patientPrograms.PROGRAM_ORDER(a.program) - patientPrograms.PROGRAM_ORDER(b.program));
    const r = live[0];
    const s = parseSessions(r.sessions);
    return s ? { ...s, program: r.program, minutes: r.minutes, text: patientPrograms.mandateText(r), end_date: day(r.end_date) } : null;
  };
  const authFor = (pid, service, date) => auths.find(a => String(a.patient_id) === String(pid) && a.service === service
    && (!a.start_date || day(a.start_date) <= date) && (!a.end_date || day(a.end_date) >= date)) || null;

  // Every session, sorted into its child + service.
  const units = new Map();
  const unitFor = (name, service) => {
    const key = `${name}\u0000${service}`;
    if (!units.has(key)) units.set(key, { key, patient_name: name, patient_id: patientByName[name]?.id || null, service, sessions: [] });
    return units.get(key);
  };
  for (const a of appts) {
    const date = day(a.appointment_date);
    const p = patientByName[a.patient_name];
    const services = specialtyOf[a.provider] || [];
    const hit = p ? patientPrograms.programFor(history[p.id], date, services) : null;
    const service = hit?.service || services[0] || '?';
    const s = {
      id: a.id, date, time: String(a.appointment_time).slice(0, 5), provider: a.provider, status: a.appointment_status,
      mark: markFor(a), is_makeup: !!a.is_makeup, makeup_for: a.makeup_for ? String(a.makeup_for) : null,
      absence_reason: a.absence_reason || null, program: hit?.program || p?.Program || null,
    };
    unitFor(a.patient_name, service).sessions.push(s);
  }
  // Children with a mandate and nothing booked: a unit per mandated service.
  for (const name of withMandate) {
    const p = patientByName[name];
    if (!p) continue;
    for (const r of history[p.id] || []) {
      if (r.service && r.sessions && weeks.some(w => patientPrograms.activeOn(r, w.end) || patientPrograms.activeOn(r, w.start))) unitFor(name, r.service);
    }
  }

  const issues = [];
  const sessionFlags = {};
  const flag = (id, text) => { if (id != null) (sessionFlags[String(id)] = sessionFlags[String(id)] || []).push(text); };
  const rows = [];

  for (const u of units.values()) {
    u.sessions.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const regular = u.sessions.filter(s => !s.is_makeup);
    const makeups = u.sessions.filter(s => s.is_makeup);
    const inWeeks = (s) => s.date >= wStart && s.date <= wEnd;
    const providers = [...new Set(u.sessions.filter(inWeeks).map(s => s.provider))].sort();
    if (provider && !providers.includes(provider)) continue;

    const pid = u.patient_id;
    const latestMandate = (() => { for (let d = wEnd; d >= wStart; d = addDays(d, -1)) { const md = pid && mandateOn(pid, u.service, d); if (md) return md; } return null; })();
    const program = latestMandate?.program || [...u.sessions].reverse().find(s => s.program)?.program || patientByName[u.patient_name]?.Program || null;
    const group = groupFor(program);
    const isEI = group === 'EI';

    // Make-ups for each missed session, linked by makeup_for.
    const makeupOf = {};
    for (const mu of makeups) {
      if (!mu.makeup_for) continue;
      const prev = makeupOf[mu.makeup_for];
      // Prefer one that happened (or is still booked) over one that was itself missed.
      const ok = (x) => DELIVERED.has(x.mark) || x.mark === null;
      if (!prev || (!ok(prev) && ok(mu))) makeupOf[mu.makeup_for] = mu;
    }
    // A regular session for this child and service that day (booked or provided).
    const regularOn = (date) => regular.some(s => s.date === date && (s.mark === 'X' || s.mark === null));

    const ei = isEI ? (() => {
      const a = pid && (authFor(pid, u.service, end) || authFor(pid, u.service, start));
      if (!a) return null;
      const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
      return {
        authorization_number: a.authorization_number, start_date: day(a.start_date), end_date: day(a.end_date),
        makeups_authorized: num(a.makeups_authorized), makeups_used: num(a.makeups_used), makeups_remaining: num(a.makeups_remaining),
      };
    })() : null;

    // EI's make-up rules for one missed session: its deadline, and what's
    // wrong with a make-up (none = billable).
    const makeupRules = (missedDate, dayMandate) => {
      const auth = pid ? authFor(pid, u.service, missedDate) : null;
      const authEnd = auth ? day(auth.end_date) : dayMandate?.end_date || null;
      const window = addDays(missedDate, MAKEUP_DAYS);
      const due = authEnd && authEnd < window ? authEnd : window;
      const problemsOf = (mu) => {
        const out = [];
        if (mu.date > window) out.push(`after the ${MAKEUP_DAYS} days (by ${nice(window)}): not billable`);
        if (authEnd && mu.date > authEnd) out.push(`after the authorization ends (${nice(authEnd)}): not billable`);
        if (regularOn(mu.date)) out.push('on the same day as a regular session: not allowed');
        return out;
      };
      return { due, problemsOf };
    };

    const weekCells = [];
    const obligations = [];
    let monthOwed = 0; let monthCredited = 0; let anyMandate = false;
    for (const w of weeks) {
      const dayMandates = Array.from({ length: 7 }, (_, i) => (pid ? mandateOn(pid, u.service, addDays(w.start, i)) : null));
      const has = dayMandates.some(Boolean);
      const owed = has ? Math.round(dayMandates.reduce((t, md) => t + (md ? md.min : 0), 0) / 7) : null;
      const max = has ? Math.round(dayMandates.reduce((t, md) => t + (md ? md.max : 0), 0) / 7) : null;
      const reg = regular.filter(s => s.date >= w.start && s.date <= w.end);
      const delivered = reg.filter(s => s.mark === 'X');
      const booked = reg.filter(s => s.mark === null);
      const missed = reg.filter(s => ['A', 'PA', 'Z', 'H'].includes(s.mark));
      // Make-ups provided this week for any week's misses (frequency) ...
      const makeupsHere = makeups.filter(s => s.date >= w.start && s.date <= w.end && DELIVERED.has(s.mark));
      let madeUp = 0; let excused = 0;
      const missedOut = [];
      for (const s of missed) {
        const vacation = s.mark === 'A' && s.absence_reason === 'vacation';
        const excusedHere = s.mark === 'H' || (isEI && vacation);
        if (excusedHere) excused++;
        const mu = makeupOf[String(s.id)] || null;
        const muDelivered = mu && DELIVERED.has(mu.mark);
        // An EI make-up that breaks the rules isn't billable, so it doesn't
        // count toward the week (it's flagged instead).
        const muOk = !mu || !isEI || !makeupRules(s.date, dayMandates[daysBetween(w.start, s.date)]).problemsOf(mu).length;
        if (muDelivered && muOk) madeUp++;
        const label = s.mark === 'A' ? `${MISS_LABEL.A}${s.absence_reason ? ` (${REASON_LABEL[s.absence_reason]})` : ''}` : MISS_LABEL[s.mark];
        missedOut.push({ id: s.id, date: s.date, time: s.time, provider: s.provider, mark: s.mark, label, excused: excusedHere,
          makeup: mu ? { id: mu.id, date: mu.date, time: mu.time, provider: mu.provider, done: !!muDelivered } : null });
      }
      const credited = delivered.length + madeUp + excused;
      const over = max !== null && delivered.length > max;
      if (over) for (const s of delivered.slice(max)) flag(s.id, `More ${u.service} sessions this week than the mandate allows (${max} a week)`);

      // EI make-up obligations for this week's misses.
      let pendingCover = 0; let dueFirst = null;
      if (isEI) {
        for (const mo of missedOut) {
          if (mo.excused) continue; // holiday or family vacation: no make-up
          const { due, problemsOf } = makeupRules(mo.date, dayMandates[daysBetween(w.start, mo.date)]);
          const ob = { patient_name: u.patient_name, service: u.service, missed_id: mo.id, missed_date: mo.date, missed_time: mo.time, provider: mo.provider, reason: mo.label, due_date: due, makeup: mo.makeup, problems: [] };
          const mu = makeupOf[String(mo.id)];
          if (mu && (DELIVERED.has(mu.mark) || mu.mark === null)) {
            ob.problems = problemsOf(mu);
            ob.status = mu.mark === null ? 'scheduled' : 'made_up';
            for (const p of ob.problems) flag(mu.id, `Make-up for ${nice(mo.date)}: ${p}`);
            if (mu.mark === null && !ob.problems.length) { pendingCover++; if (!dueFirst || due < dueFirst) dueFirst = due; }
          } else if (credited >= (owed ?? 0) && owed !== null) {
            ob.status = 'not_needed';
          } else if (today <= due) {
            ob.status = daysBetween(today, due) <= DUE_SOON_DAYS ? 'due_soon' : 'pending';
            pendingCover++;
            if (!dueFirst || due < dueFirst) dueFirst = due;
          } else {
            ob.status = 'expired';
          }
          obligations.push(ob);
        }
      }

      // Frequency with make-ups: a week taken over its mandate by make-ups
      // needs make-ups authorized on the IFSP / in EI-Hub.
      if (isEI && max !== null && delivered.length + makeupsHere.length > max && makeupsHere.length) {
        const allowed = ei?.makeups_authorized;
        if (!allowed) for (const s of makeupsHere) flag(s.id, allowed === 0 ? 'Make-up over the weekly frequency, and EI-Hub shows no make-ups authorized' : 'Make-up over the weekly frequency: check the authorization allows make-ups');
      }

      let status;
      if (owed === null) status = 'no_mandate';
      else if (w.start > today) status = 'upcoming';
      else if (credited >= owed) status = 'met';
      else if (w.end >= today) status = credited + booked.length + pendingCover >= owed ? 'in_progress' : 'short';
      else if (isEI && credited + pendingCover >= owed) status = 'makeup_due';
      else status = 'short';
      if (owed !== null) {
        anyMandate = true;
        const frac = w.days_inside / 7;
        monthOwed += owed * frac;
        monthCredited += Math.min(credited, owed) * frac;
      }
      weekCells.push({
        start: w.start, end: w.end, owed, max, delivered: delivered.length, made_up: madeUp, excused, booked: booked.length,
        credited, status, over, due: dueFirst, missed: missedOut, makeups_in_week: makeupsHere.length,
        mandate: dayMandates.find(Boolean)?.text || null,
      });
    }

    // More than 3 consecutive child absences (EI): provider and case manager
    // must tell the service coordinator within 24 hours. Provider absences,
    // holidays and closures neither count nor break a run.
    const streaks = [];
    if (isEI) {
      let run = [];
      for (const s of regular) {
        if (s.mark === 'A') run.push(s);
        else if (s.mark === 'X') { if (run.length >= STREAK) streaks.push(run); run = []; }
      }
      if (run.length >= STREAK) streaks.push(run);
    }
    const streaksOut = streaks
      .filter(r => r[r.length - 1].date >= wStart)
      .map(r => ({ from: r[0].date, to: r[r.length - 1].date, count: r.length, fourth: r[STREAK - 1].date, providers: [...new Set(r.map(s => s.provider))] }));

    // Make-ups actually provided inside the current authorization, vs EI-Hub's allowance.
    if (ei && ei.makeups_authorized !== null) {
      const used = makeups.filter(s => DELIVERED.has(s.mark) && (!ei.start_date || s.date >= ei.start_date) && (!ei.end_date || s.date <= ei.end_date)).length;
      if (used > ei.makeups_authorized) issues.push({ type: 'makeups_over_auth', severity: 'danger', patient_name: u.patient_name, service: u.service, providers, text: `${used} make-ups provided; EI-Hub authorizes ${ei.makeups_authorized} (auth ${ei.authorization_number})` });
    }

    const row = {
      key: u.key, patient_name: u.patient_name, service: u.service, program, group, providers,
      mandate: latestMandate?.text || null, weeks: weekCells, makeups: obligations, streaks: streaksOut,
      ei_auth: isEI ? ei : undefined,
      month: anyMandate ? { owed: Math.round(monthOwed * 10) / 10, credited: Math.round(monthCredited * 10) / 10 } : null,
    };
    rows.push(row);

    // Needs attention.
    const base = { patient_name: u.patient_name, service: u.service, program, providers };
    for (const ob of obligations) {
      if (ob.status === 'due_soon') issues.push({ ...base, type: 'makeup_due_soon', severity: 'warning', date: ob.due_date, text: `Make-up for ${nice(ob.missed_date)} (${ob.reason}) due by ${nice(ob.due_date)}` });
      if (ob.status === 'expired' && ob.missed_date >= wStart) issues.push({ ...base, type: 'makeup_expired', severity: 'danger', date: ob.due_date, text: `No make-up for ${nice(ob.missed_date)} (${ob.reason}) within ${MAKEUP_DAYS} days` });
      for (const p of ob.problems) issues.push({ ...base, type: 'makeup_problem', severity: 'danger', date: ob.makeup?.date, text: `Make-up on ${nice(ob.makeup?.date)} for ${nice(ob.missed_date)}: ${p}` });
    }
    if (isEI && !ei && obligations.some(ob => ['pending', 'due_soon', 'scheduled'].includes(ob.status))) {
      issues.push({ ...base, type: 'check_authorization', severity: 'warning', text: 'Make-ups owed, but no EI-Hub authorization is imported for this service: check make-ups are authorized' });
    }
    for (const st of streaksOut) issues.push({ ...base, type: 'absence_streak', severity: 'danger', date: st.to, text: `Absent ${st.count} sessions in a row (${nice(st.from)} to ${nice(st.to)}): the provider must tell the service coordinator within 24 hours` });
    for (const w of weekCells) {
      if (w.over) issues.push({ ...base, type: 'over_mandate', severity: 'warning', date: w.start, text: `Week of ${nice(w.start)}: ${w.delivered} sessions, the mandate allows ${w.max}` });
      if (w.status === 'short' && w.end < today) issues.push({ ...base, type: 'short_week', severity: 'warning', date: w.start, text: `Week of ${nice(w.start)}: ${w.credited} of ${w.owed} sessions` });
    }
  }

  rows.sort((a, b) => a.patient_name.localeCompare(b.patient_name) || a.service.localeCompare(b.service));
  return { month, start, end, today, weeks, rows, issues, session_flags: sessionFlags };
}

module.exports = { computeMandates, weeksCovering, parseSessions, sundayOf, MAKEUP_DAYS, STREAK };
