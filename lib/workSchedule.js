// Estimated hours worked, for weekly PTO accrual and for what a PTO/UPTO
// request costs. There are no timesheets -- hours come from the schedule:
//
//   Providers: their contracted weekly schedule (ProviderUsualSchedule, with
//     any scheduled hour changes in effect that day -- lib/scheduleChanges.js).
//   Everyone else: salaried, 8 hours a day Monday-Friday (9:00-5:00).
//
// A day's hours worked = its scheduled hours
//   - office closures (the whole day)
//   - approved PTO, UPTO, Unavailable and Other time inside scheduled hours
//     (Lunch and Meetings count as worked)
//   + providers' sessions outside their scheduled hours (overtime;
//     canceled sessions and no-shows don't count).
// Nobody works weekends, so only Monday-Friday is ever counted.
//
// The same scheduled hours price a PTO/UPTO request: each day it covers
// costs the scheduled time it overlaps (a full day off = that day's hours),
// instead of the clock hours between its start and end.

const { loadChangesByProvider, scheduleForDate } = require('./scheduleChanges');
const { getMergedAppointments } = require('./recurring');

const PTO_RATE = 0.08;             // PTO hours earned per hour worked
const PTO_BALANCE_CAP = 120;       // no accrual while the balance is at this
const PTO_CARRYOVER_MAX = 40;      // most PTO kept into a new calendar year
const POLICY_START = '2026-09-01'; // weekly accrual (and the reset) start here
const SALARIED_WINDOW = { start: 9 * 60, end: 17 * 60 };
const NOT_WORKED_TYPES = ['PTO', 'UPTO', 'Unavailable', 'Other'];
const NO_WORK_STATUSES = new Set(['Canceled', 'No Show']);

// ---------- dates and times ('YYYY-MM-DD', 'HH:MM[:SS]') ----------
const pad = (n) => String(n).padStart(2, '0');
const toDate = (s) => new Date(`${s}T00:00:00`);
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function addDays(s, n) { const d = toDate(s); d.setDate(d.getDate() + n); return fmt(d); }
const weekdayOf = (s) => toDate(s).getDay();
const mondayOf = (s) => addDays(s, -((weekdayOf(s) + 6) % 7));
const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const round2 = (n) => Math.round(n * 100) / 100;
function eachDate(start, end) { const out = []; for (let d = start; d <= end; d = addDays(d, 1)) out.push(d); return out; }
const todayStr = (now = new Date()) => fmt(now);

// Merge [start, end) minute intervals and total their length.
function unionMinutes(intervals) {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0; let curA = null; let curB = null;
  for (const [a, b] of sorted) {
    if (curB === null || a > curB) { if (curB !== null) total += curB - curA; curA = a; curB = b; } else if (b > curB) curB = b;
  }
  if (curB !== null) total += curB - curA;
  return total;
}
const clip = ([a, b], [lo, hi]) => [Math.max(a, lo), Math.min(b, hi)];

// The minutes of `dateStr` a time-off request covers, or null.
function requestWindowOn(r, dateStr) {
  if (r.is_balance_type) {
    if (!r.start_date || !r.end_date || dateStr < r.start_date || dateStr > r.end_date) return null;
    return [dateStr === r.start_date ? mins(r.start_time) : 0, dateStr === r.end_date ? mins(r.end_time) : 24 * 60];
  }
  if (r.is_recurring) {
    if (!r.recurring_start_date || dateStr < r.recurring_start_date || Number(r.weekday) !== weekdayOf(dateStr)) return null;
    return [mins(r.start_time), mins(r.end_time)];
  }
  return r.ooo_date === dateStr ? [mins(r.start_time), mins(r.end_time)] : null;
}

// ---------- a person's schedule ----------
// { kind, windowOn(date) -> [start, end] minutes | null, closed(date) }
// covering [start, end] (closures and schedule changes are loaded for it).
async function loadSchedule(db, staff, start, end) {
  const closuresRes = await db.query('SELECT closure_date FROM "OfficeClosures" WHERE closure_date BETWEEN $1 AND $2', [start, end]);
  const closures = new Set(closuresRes.rows.map(r => String(r.closure_date).slice(0, 10)));
  const closed = (d) => closures.has(d);
  if (!staff.provider_name) {
    return { kind: 'salaried', closed, windowOn: (d) => (weekdayOf(d) >= 1 && weekdayOf(d) <= 5 ? [SALARIED_WINDOW.start, SALARIED_WINDOW.end] : null) };
  }
  const standingRes = await db.query('SELECT weekday, start_time, end_time FROM "ProviderUsualSchedule" WHERE provider=$1', [staff.provider_name]);
  const standing = Object.fromEntries(standingRes.rows.map(r => [Number(r.weekday), r]));
  const changes = (await loadChangesByProvider(db, { start, end, provider: staff.provider_name }))[staff.provider_name] || [];
  return {
    kind: 'provider',
    closed,
    windowOn: (d) => {
      const wd = weekdayOf(d);
      if (wd === 0 || wd === 6) return null;
      const day = scheduleForDate(standing, changes, d)[wd];
      return day && day.start_time && day.end_time ? [mins(day.start_time), mins(day.end_time)] : null;
    },
  };
}

// Scheduled hours in the Monday-Friday week containing `dateStr` (closures
// ignored) -- the basis of "two weeks' worth" of PTO.
function weeklyScheduledHours(schedule, dateStr) {
  const monday = mondayOf(dateStr);
  let total = 0;
  for (let i = 0; i < 5; i++) { const w = schedule.windowOn(addDays(monday, i)); if (w) total += w[1] - w[0]; }
  return round2(total / 60);
}

// ---------- pure estimates ----------
// One day: { date, scheduled, off, overtime, worked } (hours), plus what
// was subtracted/added for the history view.
function estimateDay(schedule, dateStr, requests, appointments) {
  const window = schedule.windowOn(dateStr);
  const day = { date: dateStr, scheduled: 0, off: 0, overtime: 0, worked: 0, closed: false, notes: [] };
  if (window) day.scheduled = round2((window[1] - window[0]) / 60);
  if (schedule.closed(dateStr)) {
    day.closed = true;
    day.off = day.scheduled;
    day.notes.push('Office closed');
  } else if (window) {
    const offIntervals = [];
    for (const r of requests) {
      if (!NOT_WORKED_TYPES.includes(r.request_type)) continue;
      const w = requestWindowOn(r, dateStr);
      if (!w) continue;
      const c = clip(w, window);
      if (c[1] > c[0]) { offIntervals.push(c); day.notes.push(`${r.request_type} ${Math.round((c[1] - c[0]) / 60 * 100) / 100}h`); }
    }
    day.off = round2(unionMinutes(offIntervals) / 60);
  }
  // Sessions outside scheduled hours (all of them on an unscheduled weekday).
  const outside = [];
  for (const a of appointments || []) {
    if (a.appointment_date !== dateStr || NO_WORK_STATUSES.has(a.appointment_status)) continue;
    const s = mins(a.appointment_time);
    const e = s + (Number(a.duration) || 30);
    if (!window) outside.push([s, e]);
    else { if (s < window[0]) outside.push([s, Math.min(e, window[0])]); if (e > window[1]) outside.push([Math.max(s, window[1]), e]); }
  }
  day.overtime = round2(unionMinutes(outside) / 60);
  day.worked = round2(Math.max(0, day.scheduled - day.off) + day.overtime);
  return day;
}

// Monday-Friday of the week starting `monday`, from `fromDate` on.
function estimateWeek(schedule, monday, requests, appointments, fromDate = null) {
  const days = [];
  for (let i = 0; i < 5; i++) {
    const d = addDays(monday, i);
    if (fromDate && d < fromDate) continue;
    days.push(estimateDay(schedule, d, requests, appointments));
  }
  return { monday, days, worked: round2(days.reduce((s, d) => s + d.worked, 0)) };
}

// What a PTO/UPTO request costs: the scheduled time it covers on each
// weekday that isn't an office closure. `fromDate` limits it to days on or
// after that date (the Sep 1 2026 reset).
function chargeForRequest(schedule, r, fromDate = null) {
  if (!r.is_balance_type || !r.start_date || !r.end_date) return 0;
  let total = 0;
  for (const d of eachDate(fromDate && fromDate > r.start_date ? fromDate : r.start_date, r.end_date)) {
    if (schedule.closed(d)) continue;
    const window = schedule.windowOn(d);
    const w = requestWindowOn(r, d);
    if (!window || !w) continue;
    const c = clip(w, window);
    if (c[1] > c[0]) total += c[1] - c[0];
  }
  return round2(total / 60);
}

// ---------- database-backed helpers ----------
async function loadStaff(db, username) {
  const res = await db.query('SELECT username, provider_name, hire_date, archived FROM "Staff" WHERE username=$1', [username]);
  return res.rows[0] || null;
}

async function chargeHoursFor(db, username, r, fromDate = null) {
  if (!r.is_balance_type || !r.start_date || !r.end_date) return 0;
  const staff = await loadStaff(db, username);
  if (!staff) return 0;
  const schedule = await loadSchedule(db, staff, r.start_date, r.end_date);
  return chargeForRequest(schedule, r, fromDate);
}

// The estimate for one person's week, with everything it's based on.
async function estimateWeekFor(db, staff, monday, fromDate = null) {
  const friday = addDays(monday, 4);
  const schedule = await loadSchedule(db, staff, monday, friday);
  const reqRes = await db.query(
    `SELECT * FROM "TimeOffRequests" WHERE username=$1 AND status='approved' AND request_type = ANY($2)`,
    [staff.username, NOT_WORKED_TYPES]
  );
  const appointments = schedule.kind === 'provider'
    ? await getMergedAppointments(db, { startDate: monday, endDate: friday, provider: staff.provider_name })
    : [];
  return { ...estimateWeek(schedule, monday, reqRes.rows, appointments, fromDate), kind: schedule.kind };
}

// Two weeks' worth of PTO in a row, at most. Looks at the unbroken run of
// PTO this request would be part of -- other approved or pending PTO next to
// it, where the only days between are ones the person isn't scheduled to
// work (weekends, closures, days off) -- and returns its total hours and the
// limit (2 x their scheduled weekly hours).
async function consecutivePtoCheck(db, username, r, { excludeIds = [] } = {}) {
  const staff = await loadStaff(db, username);
  if (!staff || r.request_type !== 'PTO') return null;
  const lo = addDays(r.start_date, -45);
  const hi = addDays(r.end_date, 45);
  const schedule = await loadSchedule(db, staff, lo, hi);
  const othersRes = await db.query(
    `SELECT * FROM "TimeOffRequests" WHERE username=$1 AND request_type='PTO' AND status IN ('approved', 'pending')
       AND end_date >= $2 AND start_date <= $3`,
    [username, lo, hi]
  );
  const excluded = new Set(excludeIds.map(String));
  const all = [...othersRes.rows.filter(o => !excluded.has(String(o.id))), { ...r, id: '__new__' }];
  const covering = (d) => all.filter(o => o.start_date <= d && o.end_date >= d);
  const isWorkday = (d) => !!schedule.windowOn(d) && !schedule.closed(d);
  const chain = new Set(['__new__']);
  // Walk outward from the new request while days are covered or not workdays.
  for (const [from, step] of [[addDays(r.start_date, -1), -1], [addDays(r.end_date, 1), 1]]) {
    for (let d = from; d >= lo && d <= hi; d = addDays(d, step)) {
      const cov = covering(d);
      if (cov.length) cov.forEach(o => chain.add(String(o.id)));
      else if (isWorkday(d)) break;
    }
  }
  const hours = round2(all.filter(o => chain.has(String(o.id))).reduce((s, o) => s + chargeForRequest(schedule, o), 0));
  const limit = round2(2 * weeklyScheduledHours(schedule, r.start_date));
  return { hours, limit, over: limit > 0 && hours > limit };
}

module.exports = {
  PTO_RATE, PTO_BALANCE_CAP, PTO_CARRYOVER_MAX, POLICY_START, NOT_WORKED_TYPES,
  addDays, mondayOf, weekdayOf, round2, todayStr,
  requestWindowOn, estimateDay, estimateWeek, chargeForRequest, weeklyScheduledHours,
  loadSchedule, loadStaff, chargeHoursFor, estimateWeekFor, consecutivePtoCheck,
};
