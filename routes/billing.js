const { json } = require('../lib/http');
const { canManage, canAdminister } = require('../lib/roles');
const { getMergedAppointments, getMergedOOO } = require('../lib/recurring');
const pastLock = require('../lib/pastLock');
const { loadSchedule, chargeForRequest, addDays, round2 } = require('../lib/workSchedule');
const patientPrograms = require('../lib/patientPrograms');
const { clinicToday, monthOf, hasTable, lockOnSheet } = pastLock;

// Billing sheets (Oct 2026): one provider's month, laid out like the paper
// invoice. Same access as the weekly view: staff see their own linked
// provider, reception/admin/developer any provider.
//
// A row per patient seen that month (appointments in the month, plus any
// patient locked onto the sheet by a day that has ended -- lib/pastLock.js).
// A day's mark, once the day has ended:
//   H / Z  the office was closed (closure_type holiday / emergency)
//   PA     the provider had PTO/UPTO/Unavailable/Other (etc.) over the session
//   X      session provided (Scheduled, Confirmed, Left Message, Emailed)
//   A      child absent (No Show, Canceled)
//   M      make-up (Make Up, MUS)
// *HOLD* sessions and the "HOLD - see comments" placeholder never show.
//
// Also the change requests for past appointments (ScheduleChangeRequests):
// listed for Admins/Developers to approve (replayed as them) or deny.

const HOLD_PATIENT = 'hold - see comments';
const PROVIDER_ABSENT_TYPES = new Set(['PTO', 'UPTO', 'Unavailable', 'Other', 'Vacation', 'Sick', 'Personal']);
const STATUS_MARK = {
  Scheduled: 'X', Confirmed: 'X', 'Left Message': 'X', Emailed: 'X',
  'No Show': 'A', Canceled: 'A',
  'Make Up': 'M', MUS: 'M',
};
const DISCIPLINE = { ST: 'Speech Therapy', OT: 'Occupational Therapy', PT: 'Physical Therapy', SI: 'Special Instruction' };
const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const pad = (n) => String(n).padStart(2, '0');

// Programs on the Other section (P and PP included -- not insurance).
const OTHER_PROGRAMS = new Set(['P', 'PP', 'NONE', 'PRIVATE', 'SELF PAY', 'OTHER']);
// EI, DOE (CPSE/CSE), Insurance, or Other.
function groupFor(program) {
  const parts = String(program || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (parts.includes('EI')) return 'EI';
  if (parts.some(p => p === 'CPSE' || p === 'CSE' || p === 'DOE')) return 'DOE';
  if (!parts.length || parts.every(p => OTHER_PROGRAMS.has(p))) return 'Other';
  return 'Insurance';
}
// An in-office room (not offsite, not unset).
const inOffice = (area) => !!area && !/^offsite/i.test(String(area).trim());

let closureTypeSeen = false;
async function hasClosureType(db) {
  if (closureTypeSeen) return true;
  const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name='OfficeClosures' AND column_name='closure_type'`);
  if (r.rows.length) closureTypeSeen = true;
  return closureTypeSeen;
}

async function buildSheet(db, provider, month) {
  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const end = `${month}-${pad(daysInMonth)}`;
  const today = clinicToday();

  const [apptsAll, oooAll, closuresRes, providerRes, staffRes] = await Promise.all([
    getMergedAppointments(db, { startDate: start, endDate: end, provider }),
    getMergedOOO(db, { startDate: start, endDate: end, provider }),
    db.query(`SELECT closure_date, reason${(await hasClosureType(db)) ? ', closure_type' : ''} FROM "OfficeClosures" WHERE closure_date BETWEEN $1 AND $2`, [start, end]),
    db.query('SELECT "Name", specialty FROM "Providers" WHERE "Name"=$1', [provider]),
    db.query('SELECT phone FROM "Staff" WHERE provider_name=$1 AND archived = false LIMIT 1', [provider]),
  ]);
  const appts = apptsAll.filter(a => a.appointment_status !== '*HOLD*' && String(a.patient_name || '').trim().toLowerCase() !== HOLD_PATIENT);

  // Lock every patient seen on a day that has ended.
  if (await hasTable(db, 'BillingCaseload')) {
    const past = [...new Set(appts.filter(a => String(a.appointment_date).slice(0, 10) < today).map(a => a.patient_name))];
    if (past.length) {
      await db.query(
        `INSERT INTO "BillingCaseload" (provider, month, patient_name) SELECT $1, $2, unnest($3::text[]) ON CONFLICT DO NOTHING`,
        [provider, start, past]
      );
    }
  }
  const lockedNames = (await hasTable(db, 'BillingCaseload'))
    ? (await db.query('SELECT patient_name FROM "BillingCaseload" WHERE provider=$1 AND month=$2', [provider, start])).rows.map(r => r.patient_name)
    : [];
  const names = [...new Set([...lockedNames, ...appts.map(a => a.patient_name)])];
  const patients = names.length
    ? (await db.query('SELECT id, "Name", "Mandate", "Program" FROM "Patients" WHERE "Name" = ANY($1)', [names])).rows
    : [];
  const patientByName = Object.fromEntries(patients.map(p => [p.Name, p]));

  const closures = {};
  closuresRes.rows.forEach(c => {
    closures[String(c.closure_date).slice(0, 10)] = { type: c.closure_type === 'emergency' ? 'emergency' : 'holiday', reason: c.reason || null };
  });
  const absences = oooAll.filter(o => PROVIDER_ABSENT_TYPES.has(o.type));
  const providerAbsent = (a) => absences.some(o => {
    if (String(o.ooo_date).slice(0, 10) !== String(a.appointment_date).slice(0, 10)) return false;
    const s = mins(a.appointment_time);
    const e = s + (Number(a.duration) || 30);
    return mins(o.start_time) < e && s < mins(o.end_time);
  });
  // Order matters: a closure, then the provider being out, win over the
  // session's status -- a session Canceled (or No Show) while the provider
  // was on PTO/UPTO/Unavailable is PA, not A.
  const markFor = (a) => {
    const date = String(a.appointment_date).slice(0, 10);
    // A closure is known in advance, so it shows even before the day ends.
    if (closures[date]) return closures[date].type === 'emergency' ? 'Z' : 'H';
    if (date >= today) return null; // the day hasn't ended yet
    if (providerAbsent(a)) return 'PA';
    return STATUS_MARK[a.appointment_status] || 'X';
  };

  const lockedSet = new Set(lockedNames);
  // Which program (and mandate) each session bills under: the patient's
  // program history on the session's date, for this provider's discipline
  // (lib/patientPrograms.js). A child whose program or mandate changed
  // during the month gets a row for each. Before that migration, or for a
  // patient with no history, their current Program / Mandate.
  const services = String(providerRes.rows[0]?.specialty || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
  const history = await patientPrograms.historyFor(db, patients.map(p => p.id));
  const billAs = (name, date) => {
    const p = patientByName[name] || {};
    const hit = patientPrograms.programFor(history[p.id], date, services);
    if (hit) return { program: hit.program, mandate: hit.mandate };
    return { program: p.Program || null, mandate: p.Mandate || null };
  };
  const rowMap = new Map();
  const rowFor = (name, program, mandate) => {
    const key = `${name}\u0000${program || ''}\u0000${mandate || ''}`;
    if (!rowMap.has(key)) {
      rowMap.set(key, { patient_name: name, mandate, program, group: groupFor(program), setting: '', days: {}, scheduled: 0, total_sessions: 0, locked: lockedSet.has(name) });
    }
    return rowMap.get(key);
  };
  for (const a of appts) {
    const date = String(a.appointment_date).slice(0, 10);
    const { program, mandate } = billAs(a.patient_name, date);
    const row = rowFor(a.patient_name, program, mandate);
    const d = Number(date.slice(8, 10));
    const mark = markFor(a);
    if (mark === 'X' || mark === 'M') row.total_sessions += 1;
    // Sessions on a closed day (H or Z) still show, but aren't scheduled.
    if (mark !== 'H' && mark !== 'Z') row.scheduled += 1;
    if (inOffice(a.treatment_area)) row.setting = 'C';
    (row.days[d] = row.days[d] || []).push({ mark, status: a.appointment_status, time: String(a.appointment_time).slice(0, 5), room: a.treatment_area || null, id: a.id });
  }
  // Locked onto the sheet with no sessions left: their program at month end.
  for (const name of names) {
    if ([...rowMap.values()].some(r => r.patient_name === name)) continue;
    const { program, mandate } = billAs(name, end);
    rowFor(name, program, mandate);
  }
  const rows = [...rowMap.values()].sort((a, b) => a.patient_name.localeCompare(b.patient_name)
    || (Object.keys(a.days)[0] || 99) - (Object.keys(b.days)[0] || 99));

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
    discipline: spec.split(',').map(s => DISCIPLINE[s.trim()] || s.trim()).filter(Boolean).join(', '),
    phone: staffRes.rows[0]?.phone || null,
    closures,
    rows,
    reviewed,
    time_off: timeOff,
  };
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
    return json(200, await buildSheet(db, provider, month));
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

  // ---------- Change requests for past appointments ----------
  if (path === '/schedule-change-requests' && method === 'GET') {
    if (!(await hasTable(db, 'ScheduleChangeRequests'))) return json(200, []);
    const status = ['pending', 'approved', 'denied'].includes(qs.status) ? qs.status : 'pending';
    const params = [status];
    let sql = `SELECT id, summary, provider, appointment_date, patient_name, reason, requested_by, requested_at, status, reviewed_by, reviewed_at, review_note
               FROM "ScheduleChangeRequests" WHERE status=$1`;
    if (!canAdminister(currentUser)) { params.push(currentUser.username); sql += ` AND requested_by=$${params.length}`; }
    sql += status === 'pending' ? ' ORDER BY requested_at' : ' ORDER BY reviewed_at DESC LIMIT 100';
    return json(200, (await db.query(sql, params)).rows);
  }

  const m = path.match(/^\/schedule-change-requests\/(\d+)\/(approve|deny)$/);
  if (m && method === 'PUT') {
    if (!canAdminister(currentUser)) return json(403, { error: 'Only an Admin or Developer can approve changes to past dates.' });
    const reqRow = (await db.query('SELECT * FROM "ScheduleChangeRequests" WHERE id=$1', [m[1]])).rows[0];
    if (!reqRow) return json(404, { error: 'Request not found.' });
    if (reqRow.status !== 'pending') return json(409, { error: `This request was already ${reqRow.status}.` });
    const note = String(body?.note || '').trim().slice(0, 500) || null;
    if (m[2] === 'approve') {
      // Keep the patient on the original sheet, then make the change as the
      // approver.
      await lockOnSheet(db, reqRow.provider, reqRow.appointment_date, reqRow.patient_name);
      const appointmentRoutes = require('./appointments');
      const result = await appointmentRoutes.handle({
        path: reqRow.path, method: reqRow.method, qs: {}, body: reqRow.body || {}, db, currentUser, skipPastLock: true,
      });
      if (!result || result.statusCode >= 400) {
        let msg = 'The change could not be made. The appointment may have been changed or removed since.';
        try { msg = JSON.parse(result.body).error || msg; } catch { /* keep default */ }
        return json(409, { error: msg });
      }
    }
    await db.query(
      `UPDATE "ScheduleChangeRequests" SET status=$1, reviewed_by=$2, reviewed_at=now(), review_note=$3 WHERE id=$4`,
      [m[2] === 'approve' ? 'approved' : 'denied', currentUser.username, note, reqRow.id]
    );
    return json(200, { ok: true, status: m[2] === 'approve' ? 'approved' : 'denied' });
  }

  return null;
}

module.exports = { handle, groupFor, buildSheet, monthOf };
