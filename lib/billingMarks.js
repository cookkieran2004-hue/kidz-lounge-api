// A session's billing-sheet mark (moved here from routes/billing.js, Oct
// 2026, so the sheet and the mandates view, lib/mandates.js, can't
// disagree). Once the day has ended:
//   H / Z  the office was closed (closure_type holiday / emergency), or an
//          offsite session was Canceled because the school/home was closed
//          (cancel_reason holiday / emergency; lib/cancelReason.js)
//   PA     the provider had any out-of-office block over the session (PTO,
//          UPTO, Unavailable, Other, Lunch, Meeting -- every type, Oct 2026)
//   X      session provided (Scheduled, Confirmed, Left Message, Emailed)
//   A      child absent (No Show, Canceled)
//   E      an evaluation (is_eval; migrations/2026-10-19_evals.sql)
//   M      a make-up session (is_makeup; migrations/2026-10-17_makeups.sql)
// null = booked, the day hasn't ended yet.
const STATUS_MARK = {
  Scheduled: 'X', Confirmed: 'X', 'Left Message': 'X', Emailed: 'X',
  'No Show': 'A', Canceled: 'A',
  'Make Up': 'M', MUS: 'M', // retired statuses, in case any are left
};
const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };

let closureTypeSeen = false;
async function hasClosureType(db) {
  if (closureTypeSeen) return true;
  const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name='OfficeClosures' AND column_name='closure_type'`);
  if (r.rows.length) closureTypeSeen = true;
  return closureTypeSeen;
}

// { 'YYYY-MM-DD': { type: 'holiday' | 'emergency', reason } } for a date range.
async function loadClosures(db, start, end) {
  const res = await db.query(`SELECT closure_date, reason${(await hasClosureType(db)) ? ', closure_type' : ''} FROM "OfficeClosures" WHERE closure_date BETWEEN $1 AND $2`, [start, end]);
  const closures = {};
  res.rows.forEach(c => {
    closures[String(c.closure_date).slice(0, 10)] = { type: c.closure_type === 'emergency' ? 'emergency' : 'holiday', reason: c.reason || null };
  });
  return closures;
}

// markFor(appointment) given the closures, the out-of-office blocks (one
// provider's, or everyone's: matched by provider when the rows have one)
// and today's date in the clinic. `early`: also mark a session that hasn't
// happened yet when its outcome is already known -- PA when the provider is
// booked off, A when it's already Canceled / No Show (the mandates view
// counts those as missed straight away; the sheet waits for the day).
function makeMarker({ closures, ooo, today, early = false }) {
  const byDate = {};
  for (const o of ooo || []) (byDate[String(o.ooo_date).slice(0, 10)] = byDate[String(o.ooo_date).slice(0, 10)] || []).push(o);
  const providerAbsent = (a) => (byDate[String(a.appointment_date).slice(0, 10)] || []).some(o => {
    if (o.provider && a.provider && o.provider !== a.provider) return false;
    const s = mins(a.appointment_time);
    const e = s + (Number(a.duration) || 30);
    return mins(o.start_time) < e && s < mins(o.end_time);
  });
  // Order matters: a closure, then the provider being out, win over the
  // session's status -- a session Canceled (or No Show) while the provider
  // was on PTO/UPTO/Unavailable is PA, not A.
  return (a) => {
    const date = String(a.appointment_date).slice(0, 10);
    // A closure is known in advance, so it shows even before the day ends.
    // An outside-hours session isn't affected by an office closure: it
    // happened anyway, and counts as usual (Kieran, Oct 2026).
    if (closures[date] && !a.outside_hours) return closures[date].type === 'emergency' ? 'Z' : 'H';
    // The same for an offsite session canceled for a holiday or emergency
    // closure there (Kieran, Oct 2026). 'other' or no reason stays A.
    // Both come before providerAbsent on purpose: H / Z wins over PA even
    // when the provider was also out, and their PTO / UPTO still counts in
    // the time-off tally at the bottom (timeOffHours, from the requests).
    if (a.appointment_status === 'Canceled' && a.cancel_reason === 'holiday') return 'H';
    if (a.appointment_status === 'Canceled' && a.cancel_reason === 'emergency') return 'Z';
    if (date >= today) { // the day hasn't ended yet
      if (!early) return null;
      if (providerAbsent(a)) return 'PA';
      return STATUS_MARK[a.appointment_status] === 'A' ? 'A' : null;
    }
    if (providerAbsent(a)) return 'PA';
    if (a.is_makeup) return 'M';
    if (a.is_eval) return 'E';
    return STATUS_MARK[a.appointment_status] || 'X';
  };
}

module.exports = { STATUS_MARK, makeMarker, loadClosures, hasClosureType };
