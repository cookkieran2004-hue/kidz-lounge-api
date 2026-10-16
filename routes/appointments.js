const { json } = require('../lib/http');
const { canManage } = require('../lib/roles');
const { mergedField, displayNameFor } = require('../lib/utils');
const { getMergedAppointments, hasMakeupColumn, MISSED_STATUSES } = require('../lib/recurring');
const { isHold } = require('../lib/caseload');
const { applyCancelReason, isOffsiteArea } = require('../lib/cancelReason');
const { applyOutsideHours } = require('../lib/outsideHours');
const { applyAbsenceReason } = require('../lib/absenceReason');
const { signedRecordsFor } = require('../lib/sessionNotes');

// PedsDesk's EI records (the "ei" feature): a session with a signed session
// note or evaluation report is part of the child's record (kept six years,
// and the service log must match it), so it can't be deleted, cut off or
// moved. Empty everywhere else.
const keyOfRow = (row) => (row.exception_of_series_id
  ? `series:${row.exception_of_series_id}:${String(row.exception_occurrence_date).slice(0, 10)}` : `appt:${row.id}`);
async function signedLock(db, row) {
  const found = await signedRecordsFor(db, [keyOfRow(row)]);
  return found[0] ? json(409, { error: `This session has a signed ${found[0].kind}, so it can't be deleted, moved or re-timed. Correct the record with an addendum instead.`, locked: true }) : null;
}
// Signed records for a weekly series' occurrences on or after a date.
async function signedSeriesFrom(db, seriesId, fromDate) {
  const { featureOn } = require('../lib/features');
  if (!featureOn('ei')) return null;
  const t = (await db.query(`SELECT to_regclass('"EiSessionNotes"') AS n`)).rows[0];
  if (!t.n) return null;
  const r = (await db.query(
    `SELECT session_key FROM "EiSessionNotes" WHERE session_key LIKE $1 AND split_part(session_key, ':', 3) >= $2
       AND (provider_signed_at IS NOT NULL OR parent_signed_at IS NOT NULL) ORDER BY session_key LIMIT 1`, [`series:${seriesId}:%`, fromDate]
  )).rows[0];
  return r ? json(409, { error: `Sessions of this series from ${r.session_key.split(':')[2]} on have signed session notes, so they can't be removed. End the series after the last signed session instead.`, locked: true }) : null;
}

// The per-session details, after any appointment row is written. The
// absence reason comes after the cancel reason: a closure reason clears it.
// Canceled or No Show at the center keeps "Center" but frees the room
// (Oct 16 2026), whatever the caller sent; School / Home stay as they are.
// Mirrors the frontend's appointmentSetting.js areaAfterStatus.
const areaAfterStatus = (status, area) => (MISSED_STATUSES.includes(status) && area && !isOffsiteArea(area) ? 'Center' : (area || null));
const applySessionDetails = async (db, row, body, opts) => applyOutsideHours(db, await applyAbsenceReason(db, await applyCancelReason(db, row, body), body), body, opts);

// Positive-only cache, so booking works before the evals migration (the
// appointment just isn't flagged).
let evalColumnSeen = false;
async function hasEvalColumn(db) {
  if (evalColumnSeen) return true;
  const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'Appointments' AND column_name = 'is_eval'`);
  if (r.rows.length) evalColumnSeen = true;
  return evalColumnSeen;
}

async function handle(ctx) {
  const { path, method, qs, body, db, currentUser } = ctx;

  // Unrestricted, all-providers, date-range window -- used for the 4-week
  // scheduling-conflict lookahead on the main Schedule page. Unlike
  // /appointments/range, this is not provider-scoped or access-restricted,
  // matching the existing daily grid's behavior (which already shows every
  // provider's appointments to any logged-in staff member).
  if (path === '/appointments/window' && method === 'GET') {
    const { start, end, patient_name } = qs;
    if (!start || !end) return json(400, { error: 'start and end are required.' });
    // Optional patient_name: one patient's appointments in the window,
    // weekly recurring ones included (the patient chart's "Next 2 weeks").
    const merged = await getMergedAppointments(db, { startDate: start, endDate: end, patientName: patient_name || null });
    return json(200, merged);
  }

  // The setting (Center / School / Home) last used with each offsite
  // location, e.g. { "sunnyside elementary": "School" }, so picking a
  // location fills its setting in (the frontend's offsite picker). Keys are
  // lower-cased, trimmed locations; the most recently saved one wins.
  if (path === '/appointments/offsite-settings' && method === 'GET') {
    const res = await db.query(
      `SELECT treatment_area, updated_at FROM (
         SELECT treatment_area, updated_at FROM "Appointments" WHERE deleted = false AND treatment_area ~ '^Offsite \\((Center|School|Home)\\): '
         UNION ALL
         SELECT treatment_area, updated_at FROM "RecurringSeries" WHERE treatment_area ~ '^Offsite \\((Center|School|Home)\\): '
       ) x ORDER BY updated_at ASC NULLS FIRST`
    );
    const out = {};
    for (const r of res.rows) {
      const m = String(r.treatment_area).match(/^Offsite \((Center|School|Home)\):\s*(.+)$/);
      if (m) out[m[2].trim().replace(/\s+/g, ' ').toLowerCase()] = m[1];
    }
    return json(200, out);
  }

  // A provider's outside-hours sessions in a month (My time): how many and
  // how long. Canceled, No Show and HOLD don't count. Staff: their own
  // linked provider only; Reception/Admin/Developer may pass ?provider=.
  if (path === '/appointments/outside-hours' && method === 'GET') {
    let provider = qs.provider;
    if (!canManage(currentUser) || !provider) provider = currentUser.providerName;
    if (!provider) return json(200, { provider: null, sessions: 0, hours: 0 });
    const month = /^\d{4}-\d{2}$/.test(qs.month || '') ? qs.month : null;
    if (!month) return json(400, { error: 'month (YYYY-MM) is required.' });
    const [y, m] = month.split('-').map(Number);
    const end = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
    const merged = await getMergedAppointments(db, { startDate: `${month}-01`, endDate: end, provider });
    const counted = merged.filter(a => a.outside_hours && !['Canceled', 'No Show', '*HOLD*'].includes(a.appointment_status) && !isHold(a.patient_name));
    const minutes = counted.reduce((t, a) => t + (Number(a.duration) || 30), 0);
    return json(200, { provider, sessions: counted.length, hours: Math.round(minutes / 6) / 10 });
  }

  if (path === '/appointments/range' && method === 'GET') {
    let { provider, start, end } = qs;
    // Non-admins can only ever see their own linked provider's schedule,
    // regardless of what they pass in the query string.
    if (!canManage(currentUser)) {
      if (!currentUser.providerName) return json(403, { error: 'No provider is linked to your account.' });
      provider = currentUser.providerName;
    }
    if (!provider || !start || !end) return json(400, { error: 'provider, start, and end are required.' });
    const merged = await getMergedAppointments(db, { startDate: start, endDate: end, provider });
    return json(200, merged);
  }

  if (path === '/appointments/series-matches' && method === 'GET') {
    const { patient_name, provider, time, after } = qs;
    const result = await db.query(
      `SELECT * FROM "Appointments"
       WHERE patient_name = $1 AND provider = $2 AND appointment_time = $3 AND appointment_date > $4`,
      [patient_name, provider, time, after]
    );
    return json(200, result.rows);
  }

  // Finds siblings of a bounded ("repeat N weeks") recurring set by their
  // shared fin, rather than by matching patient/provider/time -- this is
  // what survives an occurrence being rescheduled to a different time,
  // unlike series-matches above. Only appointments created after this fix
  // shipped have a fin; older bounded sets still fall back to series-matches.
  if (path === '/appointments/fin-matches' && method === 'GET') {
    const { fin, after } = qs;
    if (!fin) return json(400, { error: 'fin is required.' });
    const result = await db.query(
      `SELECT * FROM "Appointments" WHERE fin = $1 AND appointment_date > $2`,
      [fin, after]
    );
    return json(200, result.rows);
  }

  if (path === '/appointments' && method === 'GET') {
    const date = qs.date;
    const merged = await getMergedAppointments(db, { startDate: date, endDate: date });
    return json(200, merged);
  }

  if (path === '/appointments' && method === 'POST') {
    const { patient_name, provider, appointment_date, appointment_time, duration, treatment_area, appointment_status, fin } = body;
    // A make-up for a Canceled / No Show appointment (migrations/2026-10-17_makeups.sql).
    let makeupFor = null;
    if (body.makeup_for !== undefined && body.makeup_for !== null && body.makeup_for !== '') {
      if (!(await hasMakeupColumn(db))) return json(409, { error: 'Make-ups need the 2026-10-17 migration. Ask an admin to run it.' });
      const orig = (await db.query('SELECT * FROM "Appointments" WHERE id=$1 AND deleted = false', [body.makeup_for])).rows[0];
      if (!orig) return json(404, { error: 'The canceled appointment this makes up for was not found. It may have been deleted.' });
      if (!MISSED_STATUSES.includes(orig.appointment_status)) return json(400, { error: 'Only a canceled or no-show appointment can get a make-up.' });
      // HOLD is a placeholder, not a patient: there's no missed session to make up.
      if (isHold(orig.patient_name)) return json(400, { error: 'A HOLD placeholder can\'t get a make-up.' });
      const already = (await db.query(
        `SELECT 1 FROM "Appointments" WHERE makeup_for=$1 AND deleted = false AND appointment_status <> ALL($2) LIMIT 1`,
        [orig.id, MISSED_STATUSES]
      )).rows[0];
      if (already) return json(409, { error: 'That appointment already has a make-up scheduled.' });
      makeupFor = orig.id;
    }
    const result = await db.query(
      `INSERT INTO "Appointments"
        (patient_name, provider, appointment_date, appointment_time, duration, treatment_area, appointment_status, fin, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING *`,
      [patient_name, provider, appointment_date, appointment_time, duration || 30, areaAfterStatus(appointment_status, treatment_area), appointment_status || 'Scheduled', fin || null]
    );
    if (makeupFor !== null) {
      const marked = await db.query('UPDATE "Appointments" SET makeup_for=$1, is_makeup=true WHERE id=$2 RETURNING *', [makeupFor, result.rows[0].id]);
      return json(201, await applySessionDetails(db, marked.rows[0], body));
    }
    // An eval (booked from the patient chart; migrations/2026-10-19_evals.sql).
    if (body.is_eval === true) {
      if (!(await hasEvalColumn(db))) return json(201, await applySessionDetails(db, result.rows[0], body));
      const marked = await db.query('UPDATE "Appointments" SET is_eval=true WHERE id=$1 RETURNING *', [result.rows[0].id]);
      return json(201, await applySessionDetails(db, marked.rows[0], body));
    }
    return json(201, await applySessionDetails(db, result.rows[0], body));
  }

  if (path.match(/^\/appointments\/[^/]+$/) && method === 'PUT') {
    const id = path.split('/').pop();
    const existingRes = await db.query('SELECT * FROM "Appointments" WHERE id=$1', [id]);
    if (!existingRes.rows[0]) return json(404, { error: 'Appointment not found.' });
    const existing = existingRes.rows[0];
    // A signed EI record: the session's facts stay as signed (room and
    // comments may still change).
    const day = (v) => (v ? String(v).slice(0, 10) : v);
    const missed = (st) => MISSED_STATUSES.includes(st);
    const norm = (k, v) => (k === 'appointment_time' ? String(v ?? '').slice(0, 5) : String(v ?? ''));
    const moved = ['patient_name', 'provider', 'appointment_time', 'duration']
      .some(k => norm(k, mergedField(body, k, existing)) !== norm(k, existing[k]))
      || day(mergedField(body, 'appointment_date', existing)) !== day(existing.appointment_date)
      || missed(mergedField(body, 'appointment_status', existing)) !== missed(existing.appointment_status);
    if (moved) { const lock = await signedLock(db, existing); if (lock) return lock; }
    // Any field omitted from the body keeps its current value instead of
    // being wiped -- this is what makes it safe for a caller like "cancel
    // just this occurrence" to send only { appointment_status: 'Canceled' }
    // without silently blanking out the patient, provider, date, and time.
    const result = await db.query(
      `UPDATE "Appointments" SET
         patient_name=$1, provider=$2, appointment_date=$3, appointment_time=$4,
         duration=$5, treatment_area=$6, appointment_status=$7, comments=COALESCE($8, comments), updated_at=now()
       WHERE id=$9 RETURNING *`,
      [
        mergedField(body, 'patient_name', existing),
        mergedField(body, 'provider', existing),
        mergedField(body, 'appointment_date', existing),
        mergedField(body, 'appointment_time', existing),
        mergedField(body, 'duration', existing),
        areaAfterStatus(mergedField(body, 'appointment_status', existing), mergedField(body, 'treatment_area', existing)),
        mergedField(body, 'appointment_status', existing),
        body.comments ?? null,
        id,
      ]
    );
    return json(200, await applySessionDetails(db, result.rows[0], body));
  }

  if (path.match(/^\/appointments\/[^/]+\/comments$/) && method === 'PUT') {
    const id = path.split('/')[2];
    const existingRes = await db.query('SELECT comments FROM "Appointments" WHERE id=$1', [id]);
    if (!existingRes.rows[0]) return json(404, { error: 'Appointment not found.' });

    // Comments are a JSON array (stored in the same TEXT column) so each
    // one has its own id/author/timestamp -- needed to delete a single
    // comment rather than only ever appending to one big blob.
    let commentsList = [];
    const raw = existingRes.rows[0].comments;
    if (raw) {
      try {
        commentsList = JSON.parse(raw);
      } catch (err) {
        // Pre-existing flat-text comment(s) from before this format
        // existed -- preserve as a single read-only legacy entry.
        commentsList = [{ id: 0, author_username: null, author_display: null, timestamp: null, text: raw, legacy: true }];
      }
    }

    const { action, text, commentId } = body;

    if (action === 'append') {
      if (!text || !text.trim()) return json(400, { error: 'Comment text is required.' });
      const nextId = commentsList.reduce((max, c) => Math.max(max, c.id || 0), 0) + 1;
      commentsList.push({
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
      const target = commentsList.find(c => c.id === commentId);
      if (!target) return json(404, { error: 'Comment not found.' });
      if (target.author_username !== currentUser.username && !canManage(currentUser)) {
        return json(403, { error: 'You can only delete your own comments.' });
      }
      commentsList = commentsList.filter(c => c.id !== commentId);
    } else {
      return json(400, { error: 'Unknown comment action.' });
    }

    const storedValue = commentsList.length > 0 ? JSON.stringify(commentsList) : null;
    const result = await db.query(
      'UPDATE "Appointments" SET comments=$1, updated_at=now() WHERE id=$2 RETURNING *',
      [storedValue, id]
    );
    return json(200, result.rows[0]);
  }

  if (path.match(/^\/appointments\/[^/]+$/) && method === 'DELETE') {
    const id = path.split('/').pop();
    const row = (await db.query('SELECT * FROM "Appointments" WHERE id::text=$1', [id])).rows[0];
    if (row) { const lock = await signedLock(db, row); if (lock) return lock; }
    await db.query('DELETE FROM "Appointments" WHERE id=$1', [id]);
    return json(200, { deleted: true });
  }

  // ---------- Recurring Series (new rule-based recurring model) ----------
  if (path === '/recurring-series' && method === 'POST') {
    const { patient_name, provider, weekday, appointment_time, duration, treatment_area, appointment_status, start_date, end_date } = body;
    if (!patient_name || !provider || weekday === undefined || weekday === null || !appointment_time || !start_date) {
      return json(400, { error: 'patient_name, provider, weekday, appointment_time, and start_date are required.' });
    }
    const result = await db.query(
      `INSERT INTO "RecurringSeries" (patient_name, provider, weekday, appointment_time, duration, treatment_area, appointment_status, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [patient_name, provider, weekday, appointment_time, duration || 30, treatment_area || null, appointment_status || 'Scheduled', start_date, end_date || null]
    );
    return json(201, await applyOutsideHours(db, result.rows[0], body, { table: 'RecurringSeries' }));
  }

  // Ends a series at a given date (used for "edit this and all future" --
  // the caller creates a NEW series starting from that date with the
  // changed pattern, and this call ends the OLD one the day before).
  if (path.match(/^\/recurring-series\/[^/]+\/end$/) && method === 'PUT') {
    const seriesId = path.split('/')[2];
    const { end_date } = body;
    if (!end_date) return json(400, { error: 'end_date is required.' });
    { const next = new Date(`${String(end_date).slice(0, 10)}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
      const lock = await signedSeriesFrom(db, seriesId, next.toISOString().slice(0, 10)); if (lock) return lock; }
    const result = await db.query('UPDATE "RecurringSeries" SET end_date=$1, updated_at=now() WHERE id=$2 RETURNING *', [end_date, seriesId]);
    if (!result.rows[0]) return json(404, { error: 'Series not found.' });
    return json(200, result.rows[0]);
  }

  // A new setting (treatment_area) for a series from one occurrence on
  // (Kieran, Oct 15 2026: Center / School / Home "this and all future"). The
  // series ends the day before and a copy starts on from_date with the new
  // area; its later one-off rows (exceptions) move to the copy, so they
  // neither duplicate nor lose their deleted markers, and the ones that had
  // the series' old area take the new one (a deliberate one-off room keeps
  // its own). from_date on the series' first day just changes it in place.
  // Refused when sessions from that date on are signed or already in EI-Hub
  // (their records are keyed by this series).
  if (path.match(/^\/recurring-series\/[^/]+\/split$/) && method === 'POST') {
    const seriesId = path.split('/')[2];
    const from = String(body.from_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return json(400, { error: 'from_date is required.' });
    const area = body.treatment_area ? String(body.treatment_area).slice(0, 200) : null;
    const series = (await db.query('SELECT * FROM "RecurringSeries" WHERE id::text=$1', [seriesId])).rows[0];
    if (!series) return json(404, { error: 'Series not found.' });
    const start = String(series.start_date).slice(0, 10);
    const end = series.end_date ? String(series.end_date).slice(0, 10) : null;
    if (from < start || (end && from > end)) return json(400, { error: 'That date is outside the series.' });
    const inPlace = from === start;
    if (!inPlace) {
      const lock = await signedSeriesFrom(db, series.id, from);
      if (lock) {
        const on = (JSON.parse(lock.body).error.match(/from (\d{4}-\d{2}-\d{2})/) || [])[1] || from;
        return json(409, { error: `Sessions of this series from ${on} on have signed session notes, so the change can't start before them. Change it from a later session, or just this one.`, locked: true });
      }
      if ((await db.query(`SELECT to_regclass('"EiHubEntries"') AS t`)).rows[0]?.t) {
        const entered = (await db.query(`SELECT session_key FROM "EiHubEntries" WHERE session_key LIKE $1 AND split_part(session_key, ':', 3) >= $2 LIMIT 1`, [`series:${series.id}:%`, from])).rows[0];
        if (entered) return json(409, { error: `The session on ${entered.session_key.split(':')[2]} is already entered in EI-Hub, so the series can't be split from ${from}. Change it from a later session, or just this one.` });
      }
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      let target = series;
      if (inPlace) {
        target = (await client.query('UPDATE "RecurringSeries" SET treatment_area=$1, updated_at=now() WHERE id=$2 RETURNING *', [area, series.id])).rows[0];
      } else {
        const dayBefore = (() => { const d = new Date(`${from}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
        await client.query('UPDATE "RecurringSeries" SET end_date=$1, updated_at=now() WHERE id=$2', [dayBefore, series.id]);
        // Every column of the series, so newer ones (outside_hours...) come along.
        const cols = Object.keys(series).filter(c => !['id', 'created_at', 'updated_at', 'start_date', 'treatment_area'].includes(c));
        const values = cols.map(c => series[c]);
        target = (await client.query(
          `INSERT INTO "RecurringSeries" (${[...cols, 'start_date', 'treatment_area'].map(c => `"${c}"`).join(', ')})
           VALUES (${[...cols, 'x', 'y'].map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
          [...values, from, area]
        )).rows[0];
      }
      const moved = await client.query(
        `UPDATE "Appointments" SET exception_of_series_id=$1,
           treatment_area = CASE WHEN NOT deleted AND COALESCE(treatment_area, '') = COALESCE($4, '') THEN $5 ELSE treatment_area END,
           updated_at=now()
         WHERE exception_of_series_id=$2 AND exception_occurrence_date >= $3 RETURNING id`,
        [target.id, series.id, from, series.treatment_area, area]
      );
      // The occurrence being edited takes the new area whatever it had.
      if (body.occurrence_date) {
        await client.query(
          `UPDATE "Appointments" SET treatment_area=$1, updated_at=now()
           WHERE exception_of_series_id=$2 AND exception_occurrence_date=$3 AND NOT deleted AND appointment_status NOT IN ('Canceled', 'No Show')`,
          [area, target.id, String(body.occurrence_date).slice(0, 10)]
        );
      }
      await client.query('COMMIT');
      return json(200, { series: target, moved: moved.rowCount, split: !inPlace });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // Used only by "delete this and all future" -- ending a series (above)
  // only stops NEW virtual occurrences from generating past that date. Any
  // occurrence that was already touched before the delete (a room change,
  // a status change, a prior reschedule) already exists as a real row, and
  // ending the series alone does nothing to it -- it would keep showing up
  // forever. This finds every real exception of the series from the given
  // date forward and marks them deleted too, so "all future" actually means
  // all future, not just "every date nobody had touched yet." Deliberately
  // a separate endpoint from /end: the edit flow calls /end when splitting
  // a series for a pattern change, and there future exceptions are meant to
  // survive under the new series, not be wiped out.
  if (path.match(/^\/recurring-series\/[^/]+\/purge-future-exceptions$/) && method === 'PUT') {
    const seriesId = path.split('/')[2];
    const { from_date } = body;
    if (!from_date) return json(400, { error: 'from_date is required.' });
    { const lock = await signedSeriesFrom(db, seriesId, String(from_date).slice(0, 10)); if (lock) return lock; }
    const result = await db.query(
      `UPDATE "Appointments" SET deleted=true, updated_at=now()
       WHERE exception_of_series_id=$1 AND exception_occurrence_date >= $2 RETURNING id`,
      [seriesId, from_date]
    );
    return json(200, { purged: result.rowCount });
  }

  // Materializes a single virtual occurrence into a real row -- called the
  // moment someone edits, comments on, cancels, or deletes one specific date
  // rather than the whole series. Any field not overridden falls back to the
  // series' own pattern. `deleted` marks a row that exists purely to
  // exclude its date going forward and is filtered out of every normal GET
  // -- distinct from setting appointment_status to 'Canceled', which is a
  // real, visible record that a visit didn't happen.
  if (path.match(/^\/recurring-series\/[^/]+\/exceptions$/) && method === 'POST') {
    const seriesId = path.split('/')[2];
    const { occurrence_date, appointment_date, patient_name, provider, appointment_time, duration, treatment_area, appointment_status, deleted } = body;
    if (!occurrence_date) return json(400, { error: 'occurrence_date is required.' });

    const seriesRes = await db.query('SELECT * FROM "RecurringSeries" WHERE id=$1', [seriesId]);
    const series = seriesRes.rows[0];
    if (!series) return json(404, { error: 'Series not found.' });
    // Deleting or moving one occurrence that already has a signed EI record.
    if (deleted || (appointment_date && appointment_date !== occurrence_date) || (appointment_time && String(appointment_time).slice(0, 5) !== String(series.appointment_time).slice(0, 5))
      || (provider && provider !== series.provider) || (patient_name && patient_name !== series.patient_name)) {
      const lock = await signedLock(db, { exception_of_series_id: seriesId, exception_occurrence_date: occurrence_date });
      if (lock) return lock;
    }

    const result = await db.query(
      `INSERT INTO "Appointments"
         (patient_name, provider, appointment_date, appointment_time, duration, treatment_area, appointment_status, exception_of_series_id, exception_occurrence_date, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        patient_name || series.patient_name,
        provider || series.provider,
        appointment_date || occurrence_date, // supports rescheduling this one occurrence to a different date
        appointment_time || series.appointment_time,
        duration !== undefined ? duration : series.duration,
        areaAfterStatus(appointment_status || series.appointment_status, treatment_area !== undefined ? treatment_area : series.treatment_area),
        appointment_status || series.appointment_status,
        seriesId,
        occurrence_date, // always the ORIGINAL slot -- this is what excludes it from future virtual generation
        deleted || false,
      ]
    );
    // An occurrence of an outside-hours series stays outside hours unless told otherwise.
    return json(201, await applySessionDetails(db, result.rows[0], body, { fallback: !!series.outside_hours }));
  }

  // Marks an existing real exception row as deleted, rather than removing
  // it outright -- removing it would delete the exclusion that's keeping
  // this date from regenerating the series' default virtual pattern on the
  // next load.
  if (path.match(/^\/appointments\/[^/]+\/mark-deleted$/) && method === 'PUT') {
    const id = path.split('/')[2];
    const row = (await db.query('SELECT * FROM "Appointments" WHERE id::text=$1', [id])).rows[0];
    if (row) { const lock = await signedLock(db, row); if (lock) return lock; }
    const result = await db.query('UPDATE "Appointments" SET deleted=true WHERE id=$1 RETURNING *', [id]);
    if (!result.rows[0]) return json(404, { error: 'Appointment not found.' });
    return json(200, result.rows[0]);
  }

  return null;
}

module.exports = { handle };
