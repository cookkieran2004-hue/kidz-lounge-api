// IFSP records and turning 3 (the "ei" feature, PedsDesk only, Oct 2026;
// migrations/2026-11-04_ifsp_records.sql, routes/ifsp.js). Dates are
// 'YYYY-MM-DD' strings end to end, like the rest of the API.
//
// Turning 3 (NYS EI, 10 NYCRR 69-4.20 and DOH transition guidance; Kieran,
// Oct 2026). The sources found disagree on the notice lead time (older
// guidance 120 days, a later reading 90), so the earlier one is used: a
// reminder that comes early does no harm. Change the numbers here only.
//   - The school district's CPSE is told about a child who may be eligible
//     for preschool special education at least CPSE_NOTICE_DAYS before
//     the 3rd birthday, unless the parent opted out.
//   - The transition conference is held no more than CONFERENCE_EARLIEST_
//     MONTHS and at least CONFERENCE_LATEST_DAYS before the 3rd birthday.
//   - EI ends the day before the 3rd birthday. A child found eligible for
//     CPSE services may stay in EI, if the parent chooses, until Sept 1
//     (birthday Jan 1 - Aug 31) or Jan 2 (birthday Sept 1 - Dec 31).
const CPSE_NOTICE_DAYS = 120;
const CONFERENCE_LATEST_DAYS = 90;
const CONFERENCE_EARLIEST_MONTHS = 9;
// The progress report is due this many days before an IFSP period ends
// (the patient form and the EI-Hub import already use 21).
const REPORT_LEAD_DAYS = 21;
// How far ahead the daily check makes transition tasks (as for RX / IFSP).
const TRANSITION_TASK_LEAD_DAYS = 14;

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00Z`);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parse(s).getTime()) && fmt(parse(s)) === s;
function addDays(s, n) { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); }
// Same day n months later; a day the month doesn't have becomes its last
// (Aug 31 + 6 months = Feb 28/29).
function addMonths(s, n) {
  const d = parse(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return fmt(d);
}

// The deadlines worked out from the date of birth (null without one).
function transitionDates(dob) {
  if (!isDate(dob)) return null;
  const third = addMonths(dob, 36);
  const month = Number(third.slice(5, 7));
  const year = Number(third.slice(0, 4));
  return {
    third_birthday: third,
    cpse_notice_by: addDays(third, -CPSE_NOTICE_DAYS),
    conference_from: addMonths(third, -CONFERENCE_EARLIEST_MONTHS),
    conference_by: addDays(third, -CONFERENCE_LATEST_DAYS),
    ei_ends: addDays(third, -1),
    may_continue_until: month <= 8 ? `${year}-09-01` : `${year + 1}-01-02`,
  };
}

// The IFSP in effect: the latest start on or before today, else (all in the
// future) the earliest.
function currentIfsp(ifsps, today) {
  const sorted = [...(ifsps || [])].sort((a, b) => b.start_date.localeCompare(a.start_date));
  return sorted.find(i => i.start_date <= today) || sorted[sorted.length - 1] || null;
}

const reportDue = (endDate) => (isDate(endDate) ? addDays(endDate, -REPORT_LEAD_DAYS) : null);

// What's left to do for turning 3, given the record of what happened:
// [{ key, text, due }] in date order. Nothing is left once the child is 3
// (even one staying in EI until Sept 1 / Jan 2: the conference and notice
// were due before the birthday) or once a recorded early EI end has passed.
function transitionTodo(dates, record, today) {
  if (!dates) return [];
  const r = record || {};
  if (today >= dates.third_birthday || (r.ei_end_date && r.ei_end_date < today)) return [];
  const todo = [];
  if (!r.cpse_notified_date && !r.parent_opted_out) todo.push({ key: 'cpse_notice', text: 'Tell the CPSE (school district) about the child', due: dates.cpse_notice_by });
  if (!r.conference_date) todo.push({ key: 'conference', text: `Hold the transition conference (not before ${dates.conference_from})`, due: dates.conference_by });
  return todo.sort((a, b) => a.due.localeCompare(b.due));
}

module.exports = {
  CPSE_NOTICE_DAYS, CONFERENCE_LATEST_DAYS, CONFERENCE_EARLIEST_MONTHS, REPORT_LEAD_DAYS, TRANSITION_TASK_LEAD_DAYS,
  isDate, addDays, addMonths, transitionDates, currentIfsp, reportDue, transitionTodo,
};
