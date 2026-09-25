const { json } = require('../lib/http');
const { displayNameFor } = require('../lib/utils');
const { hasAgendaTable, hasCommentsTable, getAgenda, setAgenda, getMeetingComments, setMeetingComments } = require('../lib/meetingAgendas');

const BALANCE_TYPES = new Set(['PTO', 'UPTO']);
const BALANCE_NEUTRAL_TYPES = new Set(['Lunch', 'Meeting', 'Unavailable', 'Other']);
const ALL_TYPES = new Set([...BALANCE_TYPES, ...BALANCE_NEUTRAL_TYPES]);

// Straightforward duration in hours between two exact datetimes -- not a
// business-hours calculation. A multi-day span counts every hour in
// between, nights and weekends included. If overnight/non-work hours
// should be excluded from a multi-day request, that's a different, bigger
// calculation this does not attempt.
function hoursBetween(startDate, startTime, endDate, endTime) {
  const start = new Date(`${startDate}T${startTime}`);
  const end = new Date(`${endDate}T${endTime}`);
  return Math.round(((end - start) / (1000 * 60 * 60)) * 100) / 100;
}

// Breaks a start/end datetime span into the individual calendar-day OOO
// blocks it covers: the first day runs from the start time to end of day,
// any full days in between are all-day, and the last day runs from start
// of day to the end time. A same-day request collapses to one block using
// the exact times, same as it always did for a single day.
function splitIntoDailyBlocks(startDate, startTime, endDate, endTime) {
  if (startDate === endDate) {
    return [{ date: startDate, start_time: startTime, end_time: endTime }];
  }
  const blocks = [];
  let cursor = new Date(startDate + 'T00:00:00');
  const last = new Date(endDate + 'T00:00:00');
  while (cursor <= last) {
    const dateStr = cursor.toISOString().slice(0, 10);
    if (dateStr === startDate) {
      blocks.push({ date: dateStr, start_time: startTime, end_time: '23:59:00' });
    } else if (dateStr === endDate) {
      blocks.push({ date: dateStr, start_time: '00:00:00', end_time: endTime });
    } else {
      blocks.push({ date: dateStr, start_time: '00:00:00', end_time: '23:59:00' });
    }
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return blocks;
}

class TimeOffError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// "Added by" needs a created_by column (see migrations/2026-09-25_time_off_created_by.sql).
// Checked once per cold start so a deploy that lands before the migration
// still works -- it just can't record who added the entry until then.
// ---------- Which optional columns exist ----------
// Each feature's column comes from a migration; checked once per cold start
// so a deploy that lands before a migration keeps working without it.
const columnPromises = {};
function hasColumn(db, table, column) {
  const key = `${table}.${column}`;
  if (!columnPromises[key]) {
    columnPromises[key] = db.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [table, column]
    ).then(r => r.rows.length > 0).catch(() => false);
  }
  return columnPromises[key];
}
const hasCreatedByColumn = (db) => hasColumn(db, 'TimeOffRequests', 'created_by');
// 2026-09-26: changes to approved entries.
const hasReplacesColumn = (db) => hasColumn(db, 'TimeOffRequests', 'replaces_request_id');
// 2026-09-27: shared meetings + calendar blocks remembering their entry.
const hasAttendeesColumn = (db) => hasColumn(db, 'TimeOffRequests', 'attendees');
const hasBlockLinkColumn = (db) => hasColumn(db, 'Out_of_Office', 'time_off_request_id');
const SHARED_MEETINGS_MIGRATION = 'migrations/2026-09-27_shared_meetings.sql';

// extra: { replaces_request_id, attendees } -- included only when given.
async function insertRequest(q, withCreatedBy, username, createdBy, f, extra = {}) {
  const cols = ['username', 'request_type', 'is_balance_type', 'is_recurring', 'ooo_date', 'start_time', 'end_time',
    'start_date', 'end_date', 'weekday', 'recurring_start_date', 'notes'];
  const vals = [
    username, f.request_type, f.isBalanceType, f.is_recurring || false,
    f.ooo_date || null, f.start_time || null, f.end_time || null,
    f.start_date || null, f.end_date || null,
    f.weekday ?? null, f.recurring_start_date || null, f.notes || null,
  ];
  if (withCreatedBy) { cols.push('created_by'); vals.push(createdBy); }
  if (extra.replaces_request_id !== null && extra.replaces_request_id !== undefined) { cols.push('replaces_request_id'); vals.push(String(extra.replaces_request_id)); }
  if (extra.attendees !== undefined) { cols.push('attendees'); vals.push(extra.attendees); }
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(',');
  const result = await q.query(`INSERT INTO "TimeOffRequests" (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`, vals);
  return result.rows[0];
}

// Puts one person's copy of an entry on a provider's calendar: a weekly
// series, one block per day (PTO/UPTO spans), or a single block. Returns
// { seriesId, firstOooId }. `link` stamps the blocks with the entry's id.
async function placeOnCalendar(q, reqRow, providerName, link) {
  const tag = link ? String(reqRow.id) : undefined;
  const insertBlock = async (date, start, end) => {
    const cols = ['provider', 'ooo_date', 'start_time', 'end_time', 'type'];
    const vals = [providerName, date, start, end, reqRow.request_type];
    if (tag) { cols.push('time_off_request_id'); vals.push(tag); }
    const res = await q.query(`INSERT INTO "Out_of_Office" (${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, vals);
    return res.rows[0].id;
  };
  if (reqRow.is_recurring) {
    const cols = ['provider', 'weekday', 'start_time', 'end_time', 'type', 'start_date'];
    const vals = [providerName, reqRow.weekday, reqRow.start_time, reqRow.end_time, reqRow.request_type, reqRow.recurring_start_date];
    if (tag) { cols.push('time_off_request_id'); vals.push(tag); }
    const res = await q.query(`INSERT INTO "OOO_RecurringSeries" (${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, vals);
    return { seriesId: res.rows[0].id, firstOooId: null };
  }
  if (reqRow.is_balance_type) {
    let firstOooId = null;
    for (const block of splitIntoDailyBlocks(reqRow.start_date, reqRow.start_time, reqRow.end_date, reqRow.end_time)) {
      const id = await insertBlock(block.date, block.start_time, block.end_time);
      if (!firstOooId) firstOooId = id;
    }
    return { seriesId: null, firstOooId };
  }
  return { seriesId: null, firstOooId: await insertBlock(reqRow.ooo_date, reqRow.start_time, reqRow.end_time) };
}

// Everything approving a request does, in one place, so an admin adding
// time off for someone and an admin approving a submitted request behave
// identically: put it on the provider's schedule (if they're a provider)
// -- and, for a meeting, on every attendee's schedule too -- deduct
// PTO/UPTO hours, and mark it approved. `q` is a client inside the
// caller's transaction, so a failure part-way leaves nothing behind.
async function applyApproval(q, reqRow, reviewerUsername) {
  const staffRes = await q.query('SELECT username, provider_name, first_name, last_name, preferred_name FROM "Staff" WHERE username=$1', [reqRow.username]);
  const providerName = staffRes.rows[0]?.provider_name;
  const requesterName = displayNameFor(staffRes.rows[0] || { username: reqRow.username });

  if (providerName) {
    const providerCheck = await q.query('SELECT 1 FROM "Providers" WHERE "Name"=$1', [providerName]);
    if (!providerCheck.rows[0]) {
      throw new TimeOffError(400, `${requesterName}'s account is linked to the provider name "${providerName}", but no provider record matches that name exactly. Fix the Provider Link on their Staff account, then approve again.`);
    }
  }

  // A request submitted before the PTO/UPTO redesign could still be
  // sitting here pending -- it would have is_balance_type=true stored
  // from back when Vacation/Sick/Personal were the balance types, but
  // never had start_time/end_time populated (those weren't required
  // under the old day-based model). Approving it as-is would feed NULL
  // into the hour-based math below and either crash or silently create
  // garbage data. Caught here with a clear, actionable message instead.
  if (reqRow.is_balance_type && (!reqRow.start_time || !reqRow.end_time)) {
    throw new TimeOffError(400, `This request was submitted before the PTO/UPTO redesign and is missing the exact times the new system requires. It can't be approved as-is -- deny it and ask ${requesterName} to resubmit under the current form.`);
  }

  const link = await hasBlockLinkColumn(q);
  let resultingOooId = null;
  let resultingSeriesId = null;
  if (providerName) {
    const placed = await placeOnCalendar(q, reqRow, providerName, link);
    resultingOooId = placed.firstOooId;
    resultingSeriesId = placed.seriesId;
  }

  // Attendees' copies. Only people linked to a provider have a calendar
  // column; everyone in the meeting still sees it under My time.
  const attendees = reqRow.request_type === 'Meeting' ? (reqRow.attendees || []) : [];
  if (attendees.length && link) {
    const res = await q.query(
      `SELECT s.username, s.provider_name FROM "Staff" s JOIN "Providers" p ON p."Name" = s.provider_name
       WHERE s.username = ANY($1) AND s.archived = false AND s.username <> $2`,
      [attendees, reqRow.username]
    );
    const done = new Set(providerName ? [providerName] : []);
    for (const a of res.rows) {
      if (done.has(a.provider_name)) continue;
      done.add(a.provider_name);
      await placeOnCalendar(q, reqRow, a.provider_name, true);
    }
  }

  let newBalance = null;
  if (reqRow.is_balance_type) {
    const hoursUsed = hoursBetween(reqRow.start_date, reqRow.start_time, reqRow.end_date, reqRow.end_time);
    const current = await currentBalance(q, reqRow.username, reqRow.request_type);
    newBalance = current - hoursUsed;
    await q.query(
      `INSERT INTO "TimeOffBalances" (username, balance_type, balance_hours)
       VALUES ($1, $2, $3)
       ON CONFLICT (username, balance_type) DO UPDATE SET balance_hours = $3, updated_at = now()`,
      [reqRow.username, reqRow.request_type, newBalance]
    );
  }

  const updateRes = await q.query(
    `UPDATE "TimeOffRequests" SET status='approved', reviewed_by=$1, reviewed_at=now(), resulting_ooo_id=$2, resulting_series_id=$3
     WHERE id=$4 RETURNING *`,
    [reviewerUsername, resultingOooId, resultingSeriesId, reqRow.id]
  );
  return { ...updateRes.rows[0], resultingBalance: newBalance };
}

function addDaysStr(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
// The date a request's schedule entry starts on.
function requestStartDate(r) {
  if (r.is_recurring) return r.recurring_start_date;
  return r.is_balance_type ? r.start_date : r.ooo_date;
}

// Ends (or removes) one weekly series. With `keepBefore` it's only ended
// the day before, so past weeks stay on the calendar as they happened.
async function endOrRemoveSeries(q, seriesId, keepBefore) {
  const seriesRes = await q.query('SELECT start_date FROM "OOO_RecurringSeries" WHERE id=$1', [seriesId]);
  const series = seriesRes.rows[0];
  if (!series) return;
  if (keepBefore && keepBefore > series.start_date) {
    await q.query('UPDATE "OOO_RecurringSeries" SET end_date=$1, updated_at=now() WHERE id=$2', [addDaysStr(keepBefore, -1), seriesId]);
    await q.query(
      `UPDATE "Out_of_Office" SET deleted=true WHERE exception_of_series_id=$1 AND exception_occurrence_date >= $2`,
      [seriesId, keepBefore]
    );
  } else {
    await q.query('DELETE FROM "OOO_RecurringSeries" WHERE id=$1', [seriesId]);
  }
}

// Takes an approved request back off the schedule: removes what approving
// it created -- including every attendee's copy of a meeting -- and
// refunds PTO/UPTO hours. `keepBefore` (a date) is used when the request
// is being REPLACED by a change: recurring series then only end the day
// before the change takes effect, so past weeks stay as they happened.
async function undoApproval(q, reqRow, keepBefore = null) {
  if (reqRow.status !== 'approved') return;
  const link = await hasBlockLinkColumn(q);
  if (reqRow.is_balance_type) {
    const staffRes = await q.query('SELECT provider_name FROM "Staff" WHERE username=$1', [reqRow.username]);
    const providerName = staffRes.rows[0]?.provider_name;
    if (providerName) {
      const blocks = splitIntoDailyBlocks(reqRow.start_date, reqRow.start_time, reqRow.end_date, reqRow.end_time);
      for (const block of blocks) {
        await q.query(
          `DELETE FROM "Out_of_Office"
           WHERE provider=$1 AND type=$2 AND ooo_date=$3 AND start_time=$4 AND end_time=$5`,
          [providerName, reqRow.request_type, block.date, block.start_time, block.end_time]
        );
      }
    }
    const hoursUsed = hoursBetween(reqRow.start_date, reqRow.start_time, reqRow.end_date, reqRow.end_time);
    await q.query(
      `UPDATE "TimeOffBalances" SET balance_hours = balance_hours + $1, updated_at = now()
       WHERE username=$2 AND balance_type=$3`,
      [hoursUsed, reqRow.username, reqRow.request_type]
    );
  } else if (reqRow.resulting_ooo_id) {
    await q.query('DELETE FROM "Out_of_Office" WHERE id=$1', [reqRow.resulting_ooo_id]);
  }
  const seriesIds = new Set(reqRow.resulting_series_id ? [String(reqRow.resulting_series_id)] : []);
  if (link) {
    if (!reqRow.is_recurring) {
      // One-time entries: every block made from it (attendees' copies too).
      await q.query('DELETE FROM "Out_of_Office" WHERE time_off_request_id=$1 AND exception_of_series_id IS NULL', [String(reqRow.id)]);
    }
    const linked = await q.query('SELECT id FROM "OOO_RecurringSeries" WHERE time_off_request_id=$1', [String(reqRow.id)]);
    linked.rows.forEach(r => seriesIds.add(String(r.id)));
  }
  for (const sid of seriesIds) await endOrRemoveSeries(q, sid, keepBefore);
}

// After a change is approved, everything that belonged to the old entry
// now belongs to the new one: its agendas and comment threads, and the
// past weeks still on the calendar (so they keep showing them). Then the
// old request and any other change waiting on it are removed.
async function finalizeReplacement(q, original, approved) {
  const oldId = String(original.id);
  const newId = String(approved.id);
  if (await hasAgendaTable(q)) await q.query('UPDATE "MeetingAgendas" SET ref_id=$1 WHERE ref_id=$2', [newId, oldId]);
  if (await hasCommentsTable(q)) await q.query('UPDATE "MeetingComments" SET request_ref=$1 WHERE request_ref=$2', [newId, oldId]);
  if (await hasBlockLinkColumn(q)) {
    await q.query('UPDATE "Out_of_Office" SET time_off_request_id=$1 WHERE time_off_request_id=$2', [newId, oldId]);
    await q.query('UPDATE "OOO_RecurringSeries" SET time_off_request_id=$1 WHERE time_off_request_id=$2', [newId, oldId]);
  }
  await q.query(
    `DELETE FROM "TimeOffRequests" WHERE replaces_request_id=$1 AND status='pending' AND id::text <> $2`,
    [oldId, newId]
  );
  await q.query('DELETE FROM "TimeOffRequests" WHERE id=$1', [original.id]);
}

// Approves `reqRow`; if it's a change to an approved entry, swaps it in for
// the original (all inside the caller's transaction).
async function approveWithReplacement(q, reqRow, reviewerUsername) {
  let original = null;
  if (reqRow.replaces_request_id) {
    const origRes = await q.query('SELECT * FROM "TimeOffRequests" WHERE id::text = $1 FOR UPDATE', [String(reqRow.replaces_request_id)]);
    original = origRes.rows[0] || null;
    if (original) await undoApproval(q, original, requestStartDate(reqRow));
  }
  const approved = await applyApproval(q, reqRow, reviewerUsername);
  if (original) await finalizeReplacement(q, original, approved);
  return approved;
}

// Dates of a weekly meeting around `anchor` (8 weeks back, 16 ahead), for
// the week picker when editing "this week only" notes.
function meetingDatesAround(reqRow, anchor) {
  const dates = [];
  let cursor = addDaysStr(anchor, -56);
  const last = addDaysStr(anchor, 112);
  const shift = (Number(reqRow.weekday) - new Date(cursor + 'T00:00:00Z').getUTCDay() + 7) % 7;
  cursor = addDaysStr(cursor, shift);
  while (cursor <= last) {
    if (cursor >= reqRow.recurring_start_date) dates.push(cursor);
    cursor = addDaysStr(cursor, 7);
  }
  return dates;
}

function isInMeeting(reqRow, username) {
  return reqRow.username === username || (reqRow.attendees || []).includes(username);
}

// A meeting's agenda and comments can be READ by anyone who can see the
// schedule; the agenda can be EDITED by the organizer, anyone in the
// meeting, or an admin.
async function loadMeeting(db, id, currentUser, { write = false } = {}) {
  const res = await db.query('SELECT * FROM "TimeOffRequests" WHERE id=$1', [id]);
  const row = res.rows[0];
  if (!row) throw new TimeOffError(404, 'Meeting not found.');
  if (row.request_type !== 'Meeting') throw new TimeOffError(400, 'Agendas are only for meetings.');
  if (row.status === 'denied') throw new TimeOffError(409, 'This meeting was denied.');
  if (write && !isInMeeting(row, currentUser.username) && currentUser.role !== 'admin') {
    throw new TimeOffError(403, "Only people in this meeting (or an admin) can edit its agenda.");
  }
  if (!(await hasAgendaTable(db))) throw new TimeOffError(503, 'Meeting agendas need the database update (migrations/2026-09-26_ooo_edits_and_meeting_agendas.sql) to be run first.');
  return row;
}

// Checks the "With" list for a meeting: real, active staff, not the
// organizer, no duplicates. Returns the cleaned list.
async function cleanAttendees(db, attendees, organizer) {
  if (!Array.isArray(attendees)) return [];
  const wanted = [...new Set(attendees.map(a => String(a || '').trim()).filter(a => a && a !== organizer))];
  if (!wanted.length) return [];
  const res = await db.query('SELECT username FROM "Staff" WHERE username = ANY($1) AND archived = false', [wanted]);
  const found = new Set(res.rows.map(r => r.username));
  const missing = wanted.filter(a => !found.has(a));
  if (missing.length) throw new TimeOffError(400, `Not an active staff account: ${missing.join(', ')}.`);
  return wanted;
}

async function currentBalance(q, username, balanceType) {
  const existing = await q.query(
    'SELECT balance_hours FROM "TimeOffBalances" WHERE username=$1 AND balance_type=$2',
    [username, balanceType]
  );
  return existing.rows[0] ? Number(existing.rows[0].balance_hours) : 0;
}

async function inTransaction(db, fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function handle({ path, method, qs, body, db, currentUser }) {
  // Employees submit their own requests (pending until an admin decides).
  // An admin can also add time off FOR someone by passing `username`: that
  // entry is approved on the spot -- straight onto their schedule, hours
  // deducted. If PTO/UPTO would take them below zero, the first attempt is
  // refused with 409 + `negativeBalance` details so the page can warn;
  // resending with confirm_negative_balance: true goes ahead anyway.
  if (path === '/time-off/requests' && method === 'POST') {
    const {
      request_type, is_recurring, ooo_date, start_time, end_time,
      start_date, end_date, weekday, recurring_start_date, notes,
      username: requestedUsername, confirm_negative_balance, replaces_request_id,
    } = body;

    // A change to an already-approved entry: filed as a new request that
    // points at the original. From an employee it waits for an admin (the
    // original stays on the schedule meanwhile); from an admin it applies
    // right away. Either way it's for the original's owner.
    let original = null;
    if (replaces_request_id) {
      if (!(await hasReplacesColumn(db))) {
        return json(503, { error: 'Editing approved time off needs the database update (migrations/2026-09-26_ooo_edits_and_meeting_agendas.sql) to be run first.' });
      }
      const origRes = await db.query('SELECT * FROM "TimeOffRequests" WHERE id::text = $1', [String(replaces_request_id)]);
      original = origRes.rows[0];
      if (!original) return json(404, { error: 'The entry you are changing no longer exists.' });
      if (original.status !== 'approved') return json(409, { error: 'Only approved time off can be changed this way. Pending requests can be deleted and resubmitted.' });
      if (original.username !== currentUser.username && currentUser.role !== 'admin') {
        return json(403, { error: 'You can only change your own time off.' });
      }
      if (currentUser.role !== 'admin') {
        const pendingRes = await db.query(`SELECT 1 FROM "TimeOffRequests" WHERE replaces_request_id=$1 AND status='pending'`, [String(original.id)]);
        if (pendingRes.rows[0]) return json(409, { error: 'A change to this entry is already waiting for approval. Delete that change first if you want to submit a different one.' });
      }
    }
    const targetUsername = original ? (currentUser.role === 'admin' ? original.username : null) : requestedUsername;

    const adminAdding = !!targetUsername;
    if (adminAdding) {
      if (currentUser.role !== 'admin') return json(403, { error: 'Only an admin can add time off for someone else.' });
      const target = await db.query('SELECT username, archived FROM "Staff" WHERE username=$1', [targetUsername]);
      if (!target.rows[0]) return json(404, { error: `No staff account "${targetUsername}".` });
      if (target.rows[0].archived) return json(400, { error: `${targetUsername}'s account is archived. Restore it before adding time off.` });
    }

    if (!ALL_TYPES.has(request_type)) return json(400, { error: 'Unknown request type.' });
    const isBalanceType = BALANCE_TYPES.has(request_type);

    if (isBalanceType && is_recurring) {
      return json(400, { error: `${request_type} requests can't be recurring -- they're always a one-time span.` });
    }

    if (isBalanceType) {
      if (!start_date || !start_time || !end_date || !end_time) {
        return json(400, { error: 'start_date, start_time, end_date, and end_time are required for this request type.' });
      }
      if (new Date(`${end_date}T${end_time}`) <= new Date(`${start_date}T${start_time}`)) {
        return json(400, { error: 'End must be after start.' });
      }
    } else if (is_recurring) {
      if (weekday === undefined || weekday === null || !start_time || !end_time || !recurring_start_date) {
        return json(400, { error: 'weekday, start_time, end_time, and recurring_start_date are required for a recurring request.' });
      }
    } else {
      if (!ooo_date || !start_time || !end_time) return json(400, { error: 'ooo_date, start_time, and end_time are required.' });
    }
    if (request_type === 'Other' && !(notes || '').trim()) {
      return json(400, { error: 'Please specify what "Other" is for.' });
    }

    const fields = {
      request_type, isBalanceType, is_recurring, ooo_date, start_time, end_time,
      start_date, end_date, weekday, recurring_start_date, notes,
    };
    const withCreatedBy = await hasCreatedByColumn(db);

    // "With" list for a meeting (the organizer is whoever it's for).
    const organizer = targetUsername || currentUser.username;
    const extra = { replaces_request_id: original?.id };
    if (await hasAttendeesColumn(db)) {
      try {
        extra.attendees = request_type === 'Meeting' ? await cleanAttendees(db, body.attendees, organizer) : [];
      } catch (err) {
        if (err instanceof TimeOffError) return json(err.status, { error: err.message });
        throw err;
      }
    } else if (request_type === 'Meeting' && Array.isArray(body.attendees) && body.attendees.length) {
      return json(503, { error: `Meetings with other staff need the database update (${SHARED_MEETINGS_MIGRATION}) to be run first.` });
    }

    if (!adminAdding) {
      const row = await insertRequest(db, withCreatedBy, currentUser.username, currentUser.username, fields, extra);
      return json(201, row);
    }

    if (isBalanceType && !confirm_negative_balance) {
      const hoursRequested = hoursBetween(start_date, start_time, end_date, end_time);
      // A change gives back the original's hours first (same balance type).
      const refund = original && original.is_balance_type && original.request_type === request_type
        ? hoursBetween(original.start_date, original.start_time, original.end_date, original.end_time) : 0;
      const current = await currentBalance(db, targetUsername, request_type) + refund;
      const resulting = current - hoursRequested;
      if (resulting < 0) {
        return json(409, {
          error: `This would leave ${targetUsername} at ${resulting} ${request_type} hours.`,
          negativeBalance: { username: targetUsername, balance_type: request_type, current_hours: current, hours_requested: hoursRequested, resulting_hours: resulting },
        });
      }
    }

    try {
      const approved = await inTransaction(db, async (client) => {
        const row = await insertRequest(client, withCreatedBy, targetUsername, currentUser.username, fields, extra);
        return approveWithReplacement(client, row, currentUser.username);
      });
      return json(201, approved);
    } catch (err) {
      if (err instanceof TimeOffError) return json(err.status, { error: err.message, ...err.extra });
      throw err;
    }
  }

  // A change request carries `original` (the approved entry it would
  // replace); an approved entry with a change waiting carries
  // `has_pending_change: true`.
  async function withChangeInfo(rows) {
    if (!(await hasReplacesColumn(db))) return rows;
    const originalIds = [...new Set(rows.filter(r => r.replaces_request_id).map(r => String(r.replaces_request_id)))];
    if (originalIds.length) {
      const origRes = await db.query('SELECT * FROM "TimeOffRequests" WHERE id::text = ANY($1)', [originalIds]);
      const byId = new Map(origRes.rows.map(o => [String(o.id), o]));
      rows.forEach(r => { if (r.replaces_request_id) r.original = byId.get(String(r.replaces_request_id)) || null; });
    }
    const pendingRes = await db.query(`SELECT replaces_request_id FROM "TimeOffRequests" WHERE status='pending' AND replaces_request_id IS NOT NULL`);
    const pendingFor = new Set(pendingRes.rows.map(r => String(r.replaces_request_id)));
    rows.forEach(r => { r.has_pending_change = pendingFor.has(String(r.id)); });
    return rows;
  }

  if (path === '/time-off/requests' && method === 'GET') {
    if (currentUser.role === 'admin' && qs.all === 'true') {
      let sql = `SELECT * FROM "TimeOffRequests"`;
      const params = [];
      if (qs.status) { params.push(qs.status); sql += ` WHERE status = $${params.length}`; }
      sql += ` ORDER BY requested_at DESC`;
      const result = await db.query(sql, params);
      return json(200, await withChangeInfo(result.rows));
    }
    const result = await db.query(
      `SELECT * FROM "TimeOffRequests" WHERE username=$1 ORDER BY requested_at DESC`,
      [currentUser.username]
    );
    return json(200, await withChangeInfo(result.rows));
  }

  // ---------- Which time-off entry a schedule block came from ----------
  // For the schedule's out-of-office view: the entry (its notes, who's in
  // a meeting) and what the viewer may do. Pass what the block has:
  // time_off_request_id, series_id / exception_of_series_id, ooo id, and
  // provider/type/date as a last resort for older multi-day PTO/UPTO.
  if (path === '/time-off/lookup' && method === 'GET') {
    const { time_off_request_id, ooo_id, series_id, provider, type, date } = qs;
    const link = await hasBlockLinkColumn(db);
    const byId = async (id) => (await db.query('SELECT * FROM "TimeOffRequests" WHERE id::text = $1', [String(id)])).rows[0];
    let found = null;
    if (time_off_request_id) found = await byId(time_off_request_id);
    if (!found && series_id) {
      if (link) {
        const sr = await db.query('SELECT time_off_request_id FROM "OOO_RecurringSeries" WHERE id::text = $1', [String(series_id)]);
        if (sr.rows[0]?.time_off_request_id) found = await byId(sr.rows[0].time_off_request_id);
      }
      if (!found) found = (await db.query(`SELECT * FROM "TimeOffRequests" WHERE resulting_series_id::text = $1 AND status='approved' LIMIT 1`, [String(series_id)])).rows[0];
    }
    if (!found && ooo_id && !String(ooo_id).startsWith('virtual-')) {
      found = (await db.query(`SELECT * FROM "TimeOffRequests" WHERE resulting_ooo_id::text = $1 AND status='approved' LIMIT 1`, [String(ooo_id)])).rows[0];
    }
    if (!found && provider && type && date && BALANCE_TYPES.has(type)) {
      found = (await db.query(
        `SELECT r.* FROM "TimeOffRequests" r JOIN "Staff" s ON s.username = r.username
         WHERE r.status='approved' AND r.is_balance_type AND r.request_type=$1 AND s.provider_name=$2 AND $3::date BETWEEN r.start_date AND r.end_date
         LIMIT 1`,
        [type, provider, date]
      )).rows[0];
    }
    if (!found) return json(200, { request: null });
    const isAdmin = currentUser.role === 'admin';
    return json(200, {
      request: {
        id: found.id, username: found.username, request_type: found.request_type, status: found.status,
        is_recurring: !!found.is_recurring, notes: found.notes || '', attendees: found.attendees || [],
      },
      can_change: isAdmin || found.username === currentUser.username,
      can_edit_agenda: found.request_type === 'Meeting' && (isAdmin || isInMeeting(found, currentUser.username)),
    });
  }

  // ---------- Meeting agendas ----------
  // GET  -> { kind: 'single', agenda } or
  //         { kind: 'recurring', recurring_agenda, week_date, week_agenda, dates }
  // PUT  <- { agenda } (one-time) or { recurring_agenda?, week_date?, week_agenda? }
  // Belongs to the meeting, so the organizer and every attendee share it.
  // Anyone can read it; people in the meeting (and admins) can edit it.
  // Saved straight away -- agendas never need approval.
  if (path.match(/^\/time-off\/requests\/[^/]+\/agenda$/) && (method === 'GET' || method === 'PUT')) {
    const id = path.split('/')[3];
    try {
      const reqRow = await loadMeeting(db, id, currentUser, { write: method === 'PUT' });
      const ref = String(reqRow.id);
      if (reqRow.is_recurring) {
        // Any real date is accepted for "this week only": after a change,
        // earlier weeks (from before it, maybe on another weekday) still
        // open with their own notes from the calendar.
        const isOccurrence = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(new Date(d + 'T00:00:00Z').getTime());
        if (method === 'PUT') {
          const { recurring_agenda, week_date, week_agenda } = body;
          if (week_agenda !== undefined && !isOccurrence(week_date)) throw new TimeOffError(400, 'Pick one of the dates this meeting happens on.');
          await inTransaction(db, async (client) => {
            if (recurring_agenda !== undefined) await setAgenda(client, 'series', ref, null, recurring_agenda, currentUser.username);
            if (week_agenda !== undefined) await setAgenda(client, 'week', ref, week_date, week_agenda, currentUser.username);
          });
        }
        const requested = method === 'PUT' ? body.week_date : qs.date;
        const anchor = isOccurrence(requested) ? requested : todayStr();
        const dates = meetingDatesAround(reqRow, anchor);
        if (isOccurrence(requested) && !dates.includes(requested)) { dates.push(requested); dates.sort(); }
        const weekDate = isOccurrence(requested) ? requested : (dates.find(d => d >= todayStr()) || dates[dates.length - 1] || null);
        return json(200, {
          kind: 'recurring',
          recurring_agenda: await getAgenda(db, 'series', ref),
          week_date: weekDate,
          week_agenda: weekDate ? await getAgenda(db, 'week', ref, weekDate) : '',
          dates,
        });
      }
      if (method === 'PUT' && body.agenda !== undefined) {
        await setAgenda(db, 'single', ref, null, body.agenda, currentUser.username);
      }
      return json(200, { kind: 'single', agenda: await getAgenda(db, 'single', ref), date: reqRow.ooo_date });
    } catch (err) {
      if (err instanceof TimeOffError) return json(err.status, { error: err.message, ...err.extra });
      throw err;
    }
  }

  // ---------- Agendas for older meeting blocks ----------
  // Meetings put on the calendar before My time existed aren't linked to a
  // time-off entry, but should still show (and allow) an agenda. Those are
  // kept against the calendar block itself: ref "series:<id>" (recurring
  // agenda + "this week only" per date) or "ooo:<id>" (one-time).
  // GET/PUT with { series_id, date } or { ooo_id }. Editable by an admin
  // or the provider whose calendar it is.
  if (path === '/meeting-blocks/agenda' && (method === 'GET' || method === 'PUT')) {
    const input = method === 'PUT' ? body : qs;
    const { series_id, ooo_id, date } = input;
    try {
      if (!(await hasAgendaTable(db))) throw new TimeOffError(503, 'Meeting agendas need the database update (migrations/2026-09-26_ooo_edits_and_meeting_agendas.sql) to be run first.');
      let provider = null;
      let ref = null;
      if (series_id) {
        const r = await db.query('SELECT provider FROM "OOO_RecurringSeries" WHERE id::text = $1', [String(series_id)]);
        if (!r.rows[0]) throw new TimeOffError(404, 'Meeting not found.');
        provider = r.rows[0].provider;
        ref = `series:${series_id}`;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new TimeOffError(400, 'Which week? A date is required.');
      } else if (ooo_id) {
        const r = await db.query('SELECT provider FROM "Out_of_Office" WHERE id::text = $1', [String(ooo_id)]);
        if (!r.rows[0]) throw new TimeOffError(404, 'Meeting not found.');
        provider = r.rows[0].provider;
        ref = `ooo:${ooo_id}`;
      } else {
        throw new TimeOffError(400, 'series_id or ooo_id is required.');
      }
      const canEdit = currentUser.role === 'admin' || (!!currentUser.providerName && currentUser.providerName === provider);
      if (method === 'PUT') {
        if (!canEdit) throw new TimeOffError(403, "Only this provider or an admin can edit this meeting's agenda.");
        await inTransaction(db, async (client) => {
          if (series_id) {
            if (body.recurring_agenda !== undefined) await setAgenda(client, 'series', ref, null, body.recurring_agenda, currentUser.username);
            if (body.week_agenda !== undefined) await setAgenda(client, 'week', ref, date, body.week_agenda, currentUser.username);
          } else if (body.agenda !== undefined) {
            await setAgenda(client, 'single', ref, null, body.agenda, currentUser.username);
          }
        });
      }
      if (series_id) {
        return json(200, {
          kind: 'recurring', can_edit: canEdit, dates: [date], week_date: date,
          recurring_agenda: await getAgenda(db, 'series', ref),
          week_agenda: await getAgenda(db, 'week', ref, date),
        });
      }
      return json(200, { kind: 'single', can_edit: canEdit, agenda: await getAgenda(db, 'single', ref) });
    } catch (err) {
      if (err instanceof TimeOffError) return json(err.status, { error: err.message, ...err.extra });
      throw err;
    }
  }

  // ---------- Shared meeting comments ----------
  // One thread per meeting (per week, `date`, for a recurring one), shown
  // on everyone's copy of it. Same format and rules as out-of-office
  // comments: anyone can add; authors (or admins) can delete their own.
  if (path.match(/^\/time-off\/requests\/[^/]+\/comments$/) && (method === 'GET' || method === 'PUT')) {
    const id = path.split('/')[3];
    try {
      const reqRow = await loadMeeting(db, id, currentUser);
      if (!(await hasCommentsTable(db))) throw new TimeOffError(503, `Shared meeting comments need the database update (${SHARED_MEETINGS_MIGRATION}) to be run first.`);
      const date = reqRow.is_recurring ? ((method === 'PUT' ? body.date : qs.date) || null) : null;
      if (reqRow.is_recurring && !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new TimeOffError(400, 'Which week? A date is required for a recurring meeting.');
      if (method === 'GET') return json(200, { comments: await getMeetingComments(db, reqRow.id, date) });

      const { action, text, commentId } = body;
      const comments = await inTransaction(db, async (client) => {
        const raw = await getMeetingComments(client, reqRow.id, date);
        let list = [];
        if (raw) { try { list = JSON.parse(raw); } catch (e) { list = []; } }
        if (action === 'append') {
          if (!text || !text.trim()) throw new TimeOffError(400, 'Comment text is required.');
          const nextId = list.reduce((max, c) => Math.max(max, c.id || 0), 0) + 1;
          list.push({
            id: nextId,
            author_username: currentUser.username,
            author_display: displayNameFor({
              username: currentUser.username, first_name: currentUser.firstName,
              last_name: currentUser.lastName, preferred_name: currentUser.preferredName,
            }),
            timestamp: new Date().toISOString(),
            text: text.trim(),
          });
        } else if (action === 'delete') {
          const target = list.find(c => c.id === commentId);
          if (!target) throw new TimeOffError(404, 'Comment not found.');
          if (target.author_username !== currentUser.username && currentUser.role !== 'admin') throw new TimeOffError(403, 'You can only delete your own comments.');
          list = list.filter(c => c.id !== commentId);
        } else {
          throw new TimeOffError(400, 'Unknown comment action.');
        }
        const stored = list.length ? JSON.stringify(list) : null;
        await setMeetingComments(client, reqRow.id, date, stored);
        return stored;
      });
      return json(200, { comments });
    } catch (err) {
      if (err instanceof TimeOffError) return json(err.status, { error: err.message, ...err.extra });
      throw err;
    }
  }

  // ---------- Meetings I'm in (as an attendee) ----------
  if (path === '/time-off/meetings' && method === 'GET') {
    if (!(await hasAttendeesColumn(db))) return json(200, []);
    const res = await db.query(
      `SELECT * FROM "TimeOffRequests" WHERE $1 = ANY(attendees) AND status IN ('approved', 'pending') ORDER BY requested_at DESC`,
      [currentUser.username]
    );
    return json(200, res.rows);
  }

  if (path.match(/^\/time-off\/requests\/[^/]+\/approve$/) && method === 'PUT') {
    if (currentUser.role !== 'admin') return json(403, { error: 'Admin access required.' });
    const id = path.split('/')[3];

    const reqRes = await db.query('SELECT * FROM "TimeOffRequests" WHERE id=$1', [id]);
    const reqRow = reqRes.rows[0];
    if (!reqRow) return json(404, { error: 'Request not found.' });
    if (reqRow.status !== 'pending') return json(409, { error: `This request has already been ${reqRow.status}.` });

    try {
      const approved = await inTransaction(db, (client) => approveWithReplacement(client, reqRow, currentUser.username));
      return json(200, approved);
    } catch (err) {
      if (err instanceof TimeOffError) return json(err.status, { error: err.message, ...err.extra });
      throw err;
    }
  }

  if (path.match(/^\/time-off\/requests\/[^/]+\/deny$/) && method === 'PUT') {
    if (currentUser.role !== 'admin') return json(403, { error: 'Admin access required.' });
    const id = path.split('/')[3];
    const { review_note } = body;

    const reqRes = await db.query('SELECT status FROM "TimeOffRequests" WHERE id=$1', [id]);
    if (!reqRes.rows[0]) return json(404, { error: 'Request not found.' });
    if (reqRes.rows[0].status !== 'pending') return json(409, { error: `This request has already been ${reqRes.rows[0].status}.` });

    const result = await db.query(
      `UPDATE "TimeOffRequests" SET status='denied', reviewed_by=$1, reviewed_at=now(), review_note=$2 WHERE id=$3 RETURNING *`,
      [currentUser.username, review_note || null, id]
    );
    return json(200, result.rows[0]);
  }

  if (path.match(/^\/time-off\/requests\/[^/]+$/) && method === 'PUT') {
    if (currentUser.role !== 'admin') return json(403, { error: 'Admin access required.' });
    const id = path.split('/')[3];

    const existingRes = await db.query('SELECT status, username FROM "TimeOffRequests" WHERE id=$1', [id]);
    if (!existingRes.rows[0]) return json(404, { error: 'Request not found.' });
    if (existingRes.rows[0].status !== 'pending') {
      return json(409, { error: `This request has already been ${existingRes.rows[0].status} and can no longer be edited.` });
    }

    const {
      request_type, is_recurring, ooo_date, start_time, end_time,
      start_date, end_date, weekday, recurring_start_date, notes,
    } = body;

    if (!ALL_TYPES.has(request_type)) return json(400, { error: 'Unknown request type.' });
    const isBalanceType = BALANCE_TYPES.has(request_type);
    if (isBalanceType && is_recurring) {
      return json(400, { error: `${request_type} requests can't be recurring -- they're always a one-time span.` });
    }
    if (isBalanceType) {
      if (!start_date || !start_time || !end_date || !end_time) {
        return json(400, { error: 'start_date, start_time, end_date, and end_time are required for this request type.' });
      }
      if (new Date(`${end_date}T${end_time}`) <= new Date(`${start_date}T${start_time}`)) {
        return json(400, { error: 'End must be after start.' });
      }
    } else if (is_recurring) {
      if (weekday === undefined || weekday === null || !start_time || !end_time || !recurring_start_date) {
        return json(400, { error: 'weekday, start_time, end_time, and recurring_start_date are required for a recurring request.' });
      }
    } else {
      if (!ooo_date || !start_time || !end_time) return json(400, { error: 'ooo_date, start_time, and end_time are required.' });
    }
    if (request_type === 'Other' && !(notes || '').trim()) {
      return json(400, { error: 'Please specify what "Other" is for.' });
    }
    if (await hasAttendeesColumn(db)) {
      try {
        const attendees = request_type === 'Meeting' ? await cleanAttendees(db, body.attendees, existingRes.rows[0].username) : [];
        await db.query('UPDATE "TimeOffRequests" SET attendees=$1 WHERE id=$2', [attendees, id]);
      } catch (err) {
        if (err instanceof TimeOffError) return json(err.status, { error: err.message });
        throw err;
      }
    }

    const result = await db.query(
      `UPDATE "TimeOffRequests" SET
         request_type=$1, is_balance_type=$2, is_recurring=$3, ooo_date=$4, start_time=$5, end_time=$6,
         start_date=$7, end_date=$8, weekday=$9, recurring_start_date=$10, notes=$11
       WHERE id=$12 RETURNING *`,
      [
        request_type, isBalanceType, is_recurring || false,
        ooo_date || null, start_time || null, end_time || null,
        start_date || null, end_date || null,
        weekday ?? null, recurring_start_date || null, notes || null,
        id,
      ]
    );
    return json(200, result.rows[0]);
  }

  if (path.match(/^\/time-off\/requests\/[^/]+$/) && method === 'DELETE') {
    const id = path.split('/').pop();
    const reqRes = await db.query('SELECT * FROM "TimeOffRequests" WHERE id=$1', [id]);
    const reqRow = reqRes.rows[0];
    if (!reqRow) return json(404, { error: 'Request not found.' });
    if (reqRow.username !== currentUser.username && currentUser.role !== 'admin') {
      return json(403, { error: 'You can only delete your own requests.' });
    }

    // Same undo as a replaced entry (shared with approval), in one
    // transaction; an approved entry takes any change waiting on it along.
    const withReplaces = await hasReplacesColumn(db);
    await inTransaction(db, async (client) => {
      await undoApproval(client, reqRow);
      if (withReplaces) {
        await client.query(`DELETE FROM "TimeOffRequests" WHERE replaces_request_id=$1 AND status='pending'`, [String(reqRow.id)]);
      }
      await client.query('DELETE FROM "TimeOffRequests" WHERE id=$1', [id]);
    });
    return json(200, { deleted: true });
  }

  if (path === '/time-off/balances' && method === 'GET') {
    const targetUsername = (currentUser.role === 'admin' && qs.username) ? qs.username : currentUser.username;
    const result = await db.query('SELECT balance_type, balance_hours FROM "TimeOffBalances" WHERE username=$1', [targetUsername]);
    const byType = Object.fromEntries(result.rows.map(r => [r.balance_type, Number(r.balance_hours)]));
    const balances = [...BALANCE_TYPES].map(t => ({ balance_type: t, balance_hours: byType[t] ?? 0 }));
    return json(200, balances);
  }

  if (path === '/time-off/balances' && method === 'PUT') {
    if (currentUser.role !== 'admin') return json(403, { error: 'Admin access required.' });
    const { username, balance_type, balance_hours } = body;
    if (!username || !BALANCE_TYPES.has(balance_type) || balance_hours === undefined) {
      return json(400, { error: 'username, balance_type, and balance_hours are required.' });
    }
    const result = await db.query(
      `INSERT INTO "TimeOffBalances" (username, balance_type, balance_hours)
       VALUES ($1, $2, $3)
       ON CONFLICT (username, balance_type) DO UPDATE SET balance_hours = $3, updated_at = now()
       RETURNING *`,
      [username, balance_type, balance_hours]
    );
    return json(200, result.rows[0]);
  }

  return null;
}

module.exports = { handle, BALANCE_TYPES, BALANCE_NEUTRAL_TYPES, hoursBetween, splitIntoDailyBlocks };
