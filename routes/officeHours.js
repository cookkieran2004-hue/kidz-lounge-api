const { json } = require('../lib/http');
const { hasChangesTable, loadChangesByProvider, scheduleForDate } = require('../lib/scheduleChanges');

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// "09:00" (from a browser time input) and "09:00:00" (from a Postgres TIME
// column) represent the same instant, but as plain strings "09:00" sorts
// as LESS than "09:00:00" (a shorter string that's a prefix of a longer
// one always does) -- so comparing times as raw strings was silently
// producing a spurious gap every time a provider's hours exactly matched
// the office's, at exactly the boundary. Converting both to minutes
// past midnight first makes the comparison actually correct.
function toMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

// The schedule grids show 8:00 AM - 6:00 PM (TIME_SLOTS in the frontend's
// SchedulePage.jsx). Non-contracted time is measured across that whole
// visible day -- widened if the office opens earlier or closes later --
// NOT just within office hours. Measuring only within office hours meant
// that on a short office day (e.g. Friday 9-12) nothing outside it was
// ever shaded or flagged, even for a provider not contracted at all.
const GRID_START_MINUTES = 8 * 60;
const GRID_END_MINUTES = 18 * 60;

function minutesToTime(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

// Computes the gap(s) in a day that fall outside a provider's contracted
// hours. A day the office is closed entirely (no OfficeHours row) has no
// gaps -- that's reported separately by /office-hours/closed-dates. A
// provider with no contracted hours that weekday has the whole day as a
// gap. Returns an array so a contracted block in the middle of the day
// (leaving both a before- and after-gap) is handled correctly.
function computeGaps(officeHours, providerHours) {
  if (!officeHours) return [];
  const dayStart = Math.min(GRID_START_MINUTES, toMinutes(officeHours.open_time));
  const dayEnd = Math.max(GRID_END_MINUTES, toMinutes(officeHours.close_time));
  if (!providerHours) {
    return [{ start_time: minutesToTime(dayStart), end_time: minutesToTime(dayEnd) }];
  }
  const gaps = [];
  const contractStart = Math.max(dayStart, toMinutes(providerHours.start_time));
  const contractEnd = Math.min(dayEnd, toMinutes(providerHours.end_time));
  if (contractStart >= contractEnd) {
    return [{ start_time: minutesToTime(dayStart), end_time: minutesToTime(dayEnd) }];
  }
  if (contractStart > dayStart) gaps.push({ start_time: minutesToTime(dayStart), end_time: minutesToTime(contractStart) });
  if (contractEnd < dayEnd) gaps.push({ start_time: minutesToTime(contractEnd), end_time: minutesToTime(dayEnd) });
  return gaps;
}

async function handle({ path, method, qs, body, db, currentUser }) {
  // ---------- Office hours ----------
  if (path === '/office-hours' && method === 'GET') {
    const result = await db.query('SELECT * FROM "OfficeHours" ORDER BY weekday');
    return json(200, result.rows);
  }

  // Given a date range, returns which specific dates the office is closed
  // -- either because that weekday has no OfficeHours row at all, or
  // because of a specific OfficeClosures date. This is the single source
  // of truth the schedule views check directly, rather than every closure
  // needing to be materialized as a real row for every provider.
  if (path === '/office-hours/closed-dates' && method === 'GET') {
    const { start, end } = qs;
    if (!start || !end) return json(400, { error: 'start and end are required.' });

    const officeHoursRes = await db.query('SELECT weekday FROM "OfficeHours"');
    const openWeekdays = new Set(officeHoursRes.rows.map(r => r.weekday));
    const closuresRes = await db.query('SELECT closure_date, reason FROM "OfficeClosures" WHERE closure_date BETWEEN $1 AND $2', [start, end]);
    const closureByDate = Object.fromEntries(closuresRes.rows.map(r => [r.closure_date, r.reason]));

    const closedDates = [];
    let cursor = new Date(start + 'T00:00:00');
    const last = new Date(end + 'T00:00:00');
    while (cursor <= last) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const weekday = cursor.getDay();
      if (closureByDate[dateStr] !== undefined) {
        closedDates.push({ date: dateStr, reason: closureByDate[dateStr] || 'Office closed' });
      } else if (!openWeekdays.has(weekday)) {
        closedDates.push({ date: dateStr, reason: 'Office closed' });
      }
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
    return json(200, closedDates);
  }

  // Sets (or clears, to mean "closed") one weekday's hours at a time --
  // simpler than requiring the whole week to be sent together. Marking a
  // day closed here is purely a change to this one table -- nothing gets
  // materialized into per-provider Out_of_Office rows for it. The
  // schedule views check /office-hours/closed-dates directly instead,
  // which is a single source of truth rather than needing to keep N
  // duplicated rows (one per provider) in sync with it.
  if (path === '/office-hours' && method === 'PUT') {
    if (currentUser.role !== 'admin') return json(403, { error: 'Admin access required.' });
    const { weekday, open_time, close_time, closed } = body;
    if (weekday === undefined || weekday === null || weekday < 0 || weekday > 6) {
      return json(400, { error: 'weekday (0-6) is required.' });
    }
    if (closed) {
      await db.query('DELETE FROM "OfficeHours" WHERE weekday=$1', [weekday]);
      return json(200, { weekday, closed: true });
    }
    if (!open_time || !close_time) return json(400, { error: 'open_time and close_time are required unless closed is true.' });
    const result = await db.query(
      `INSERT INTO "OfficeHours" (weekday, open_time, close_time) VALUES ($1,$2,$3)
       ON CONFLICT (weekday) DO UPDATE SET open_time=$2, close_time=$3
       RETURNING *`,
      [weekday, open_time, close_time]
    );
    return json(200, result.rows[0]);
  }

  // ---------- Office closures (specific dates) ----------
  if (path === '/office-closures' && method === 'GET') {
    const result = await db.query('SELECT * FROM "OfficeClosures" ORDER BY closure_date');
    return json(200, result.rows);
  }

  // Same as marking a weekday closed above -- just records the closure.
  // The schedule views pick it up via /office-hours/closed-dates, no
  // per-provider rows needed.
  if (path === '/office-closures' && method === 'POST') {
    if (currentUser.role !== 'admin') return json(403, { error: 'Admin access required.' });
    const { closure_date, reason } = body;
    if (!closure_date) return json(400, { error: 'closure_date is required.' });
    const closureRes = await db.query(
      'INSERT INTO "OfficeClosures" (closure_date, reason) VALUES ($1,$2) RETURNING *',
      [closure_date, reason || null]
    );
    return json(201, closureRes.rows[0]);
  }

  if (path.match(/^\/office-closures\/[^/]+$/) && method === 'DELETE') {
    if (currentUser.role !== 'admin') return json(403, { error: 'Admin access required.' });
    const id = path.split('/').pop();
    const result = await db.query('DELETE FROM "OfficeClosures" WHERE id=$1 RETURNING id', [id]);
    if (!result.rows[0]) return json(404, { error: 'Closure not found.' });
    return json(200, { deleted: true });
  }

  // ---------- Provider usual (contracted) schedule ----------
  if (path.match(/^\/providers\/[^/]+\/usual-schedule$/) && method === 'GET') {
    const providerName = decodeURIComponent(path.split('/')[2]);
    const result = await db.query('SELECT * FROM "ProviderUsualSchedule" WHERE provider=$1 ORDER BY weekday', [providerName]);
    return json(200, result.rows);
  }

  // Body is the full week: { schedule: [{ weekday, start_time, end_time }, ...] }
  // -- only the days included are considered "worked"; any weekday left out
  // means the provider doesn't work that day. This is the ONLY thing this
  // endpoint does -- no OOO rows get created or touched here. Rebuilt this
  // way deliberately: the previous version tried to materialize the gap
  // between office hours and contracted hours into real recurring OOO
  // blocks, which meant keeping a second copy of the same fact in sync
  // forever after, and every bug so far came from that copy drifting from
  // the truth. Now there's only one copy -- this table -- and the gap is
  // computed fresh, live, every time it's needed (see
  // GET /providers/:name/contracted-gaps below), so there's nothing that
  // can go stale.
  if (path.match(/^\/providers\/[^/]+\/usual-schedule$/) && method === 'PUT') {
    if (currentUser.role !== 'admin') return json(403, { error: 'Admin access required.' });
    const providerName = decodeURIComponent(path.split('/')[2]);
    const { schedule } = body;
    if (!Array.isArray(schedule)) return json(400, { error: 'schedule must be an array.' });

    await db.query('DELETE FROM "ProviderUsualSchedule" WHERE provider=$1', [providerName]);
    for (const day of schedule) {
      if (day.weekday === undefined || !day.start_time || !day.end_time) continue;
      await db.query(
        'INSERT INTO "ProviderUsualSchedule" (provider, weekday, start_time, end_time) VALUES ($1,$2,$3,$4)',
        [providerName, day.weekday, day.start_time, day.end_time]
      );
    }

    const finalSchedule = await db.query('SELECT * FROM "ProviderUsualSchedule" WHERE provider=$1 ORDER BY weekday', [providerName]);
    return json(200, { schedule: finalSchedule.rows });
  }

  // ---------- Scheduled changes to contracted hours ----------
  // GET    /providers/:name/schedule-changes      -> all changes, oldest first
  // POST   /providers/:name/schedule-changes      <- { start_date, end_date?, schedule: [{ weekday, start_time, end_time }] }
  // PUT    /schedule-changes/:id                  <- same body
  // DELETE /schedule-changes/:id
  // Admin-only to change. `schedule` lists only the days worked; a day
  // left out means not contracted that day while the change applies.
  const changesRoute = path.match(/^\/providers\/([^/]+)\/schedule-changes$/);
  const changeIdRoute = path.match(/^\/schedule-changes\/([^/]+)$/);
  if (changesRoute || changeIdRoute) {
    if (!(await hasChangesTable(db))) {
      if (changesRoute && method === 'GET') return json(200, []);
      return json(503, { error: 'Scheduling hour changes needs the database update (migrations/2026-09-29_schedule_changes.sql) to be run first.' });
    }
    const listFor = async (providerName) => {
      const changes = (await db.query('SELECT * FROM "ProviderScheduleChanges" WHERE provider=$1 ORDER BY start_date, id', [providerName])).rows;
      if (!changes.length) return [];
      const days = (await db.query('SELECT change_id, weekday, start_time, end_time FROM "ProviderScheduleChangeDays" WHERE change_id::text = ANY($1) ORDER BY weekday', [changes.map(c => String(c.id))])).rows;
      return changes.map(c => ({ ...c, schedule: days.filter(d => String(d.change_id) === String(c.id)).map(({ weekday, start_time, end_time }) => ({ weekday: Number(weekday), start_time, end_time })) }));
    };
    if (changesRoute && method === 'GET') return json(200, await listFor(decodeURIComponent(changesRoute[1])));
    if (currentUser.role !== 'admin') return json(403, { error: 'Admin access required.' });

    const validate = () => {
      const { start_date, end_date, schedule } = body;
      const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
      if (!isDate(start_date)) return 'A start date is required.';
      if (end_date && !isDate(end_date)) return 'The end date is not a valid date.';
      if (end_date && end_date < start_date) return 'The end date is before the start date.';
      if (!Array.isArray(schedule)) return 'schedule must be an array.';
      const seen = new Set();
      for (const d of schedule) {
        const wd = Number(d.weekday);
        if (!Number.isInteger(wd) || wd < 0 || wd > 6) return 'Each day needs a weekday (0-6).';
        if (seen.has(wd)) return 'Each weekday can only appear once.';
        seen.add(wd);
        if (!d.start_time || !d.end_time || toMinutes(d.end_time) <= toMinutes(d.start_time)) return `${WEEKDAY_NAMES[wd]}: the end time must be after the start time.`;
      }
      return null;
    };
    const saveDays = async (client, changeId) => {
      await client.query('DELETE FROM "ProviderScheduleChangeDays" WHERE change_id=$1', [changeId]);
      for (const d of body.schedule) {
        await client.query('INSERT INTO "ProviderScheduleChangeDays" (change_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4)', [changeId, Number(d.weekday), d.start_time, d.end_time]);
      }
    };
    const inTx = async (fn) => {
      const client = await db.connect();
      try { await client.query('BEGIN'); const r = await fn(client); await client.query('COMMIT'); return r; }
      catch (err) { await client.query('ROLLBACK'); throw err; }
      finally { client.release(); }
    };

    if (changesRoute && method === 'POST') {
      const problem = validate();
      if (problem) return json(400, { error: problem });
      const providerName = decodeURIComponent(changesRoute[1]);
      const created = await inTx(async (client) => {
        const res = await client.query(
          'INSERT INTO "ProviderScheduleChanges" (provider, start_date, end_date, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
          [providerName, body.start_date, body.end_date || null, currentUser.username]
        );
        await saveDays(client, res.rows[0].id);
        return res.rows[0].id;
      });
      return json(201, { id: created, changes: await listFor(providerName) });
    }
    if (changeIdRoute && (method === 'PUT' || method === 'DELETE')) {
      const id = changeIdRoute[1];
      const existing = (await db.query('SELECT provider FROM "ProviderScheduleChanges" WHERE id::text = $1', [String(id)])).rows[0];
      if (!existing) return json(404, { error: 'Scheduled change not found.' });
      if (method === 'DELETE') {
        await db.query('DELETE FROM "ProviderScheduleChanges" WHERE id::text = $1', [String(id)]);
        return json(200, { deleted: true, changes: await listFor(existing.provider) });
      }
      const problem = validate();
      if (problem) return json(400, { error: problem });
      await inTx(async (client) => {
        await client.query('UPDATE "ProviderScheduleChanges" SET start_date=$1, end_date=$2 WHERE id::text = $3', [body.start_date, body.end_date || null, String(id)]);
        await saveDays(client, id);
      });
      return json(200, { changes: await listFor(existing.provider) });
    }
    return null;
  }

  // Same computation as the single-provider endpoint above, but for every
  // provider at once in a single request. The daily Schedule grid shows
  // every provider as a column, and was firing one of these requests per
  // provider in parallel to build that view -- with enough providers that
  // burst of simultaneous requests was large enough to get randomly
  // throttled by the backend (intermittent 503s/CORS failures, different
  // provider each time), which looked like the banner randomly vanishing
  // for whoever's request happened to get throttled. One request instead
  // of N removes the burst entirely.
  if (path === '/providers/contracted-gaps-batch' && method === 'GET') {
    const { start, end } = qs;
    if (!start || !end) return json(400, { error: 'start and end are required.' });

    const [providersRes, scheduleRes, officeHoursRes] = await Promise.all([
      db.query('SELECT "Name" FROM "Providers"'),
      db.query('SELECT provider, weekday, start_time, end_time FROM "ProviderUsualSchedule"'),
      db.query('SELECT * FROM "OfficeHours"'),
    ]);
    const officeByWeekday = Object.fromEntries(officeHoursRes.rows.map(r => [r.weekday, r]));
    const scheduleByProvider = {};
    scheduleRes.rows.forEach(r => {
      if (!scheduleByProvider[r.provider]) scheduleByProvider[r.provider] = {};
      scheduleByProvider[r.provider][r.weekday] = r;
    });

    const changesByProvider = await loadChangesByProvider(db, { start, end });
    const byProvider = {};
    for (const p of providersRes.rows) {
      const scheduleByWeekday = scheduleByProvider[p.Name] || {};
      const result = [];
      let cursor = new Date(start + 'T00:00:00');
      const last = new Date(end + 'T00:00:00');
      while (cursor <= last) {
        const weekday = cursor.getDay();
        const hoursThatDay = scheduleForDate(scheduleByWeekday, changesByProvider[p.Name], cursor.toISOString().slice(0, 10));
        const gaps = computeGaps(officeByWeekday[weekday], hoursThatDay[weekday]);
        if (gaps.length > 0) {
          result.push({ date: cursor.toISOString().slice(0, 10), gaps });
        }
        cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
      }
      byProvider[p.Name] = result;
    }
    return json(200, byProvider);
  }

  // Given a provider and a date range, returns which hours on which dates
  // they're NOT contracted for -- computed live from ProviderUsualSchedule
  // and OfficeHours every time, never stored. A date the office is closed
  // entirely is left out here (that's what /office-hours/closed-dates is
  // for) -- this only covers days the office is open but the provider
  // isn't contracted for all of it.
  if (path.match(/^\/providers\/[^/]+\/contracted-gaps$/) && method === 'GET') {
    const providerName = decodeURIComponent(path.split('/')[2]);
    const { start, end } = qs;
    if (!start || !end) return json(400, { error: 'start and end are required.' });

    const [scheduleRes, officeHoursRes] = await Promise.all([
      db.query('SELECT weekday, start_time, end_time FROM "ProviderUsualSchedule" WHERE provider=$1', [providerName]),
      db.query('SELECT * FROM "OfficeHours"'),
    ]);
    const scheduleByWeekday = Object.fromEntries(scheduleRes.rows.map(r => [r.weekday, r]));
    const officeByWeekday = Object.fromEntries(officeHoursRes.rows.map(r => [r.weekday, r]));
    const changes = (await loadChangesByProvider(db, { start, end, provider: providerName }))[providerName];

    const result = [];
    let cursor = new Date(start + 'T00:00:00');
    const last = new Date(end + 'T00:00:00');
    while (cursor <= last) {
      const weekday = cursor.getDay();
      const hoursThatDay = scheduleForDate(scheduleByWeekday, changes, cursor.toISOString().slice(0, 10));
      const gaps = computeGaps(officeByWeekday[weekday], hoursThatDay[weekday]);
      if (gaps.length > 0) {
        result.push({ date: cursor.toISOString().slice(0, 10), gaps });
      }
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
    return json(200, result);
  }

  return null;
}

module.exports = { handle, computeGaps, WEEKDAY_NAMES };
