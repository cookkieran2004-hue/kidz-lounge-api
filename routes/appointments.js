const { json } = require('../lib/http');
const { mergedField, displayNameFor } = require('../lib/utils');
const { getMergedAppointments } = require('../lib/recurring');

async function handle({ path, method, qs, body, db, currentUser }) {
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

  if (path === '/appointments/range' && method === 'GET') {
    let { provider, start, end } = qs;
    // Non-admins can only ever see their own linked provider's schedule,
    // regardless of what they pass in the query string.
    if (currentUser.role !== 'admin') {
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
    const result = await db.query(
      `INSERT INTO "Appointments"
        (patient_name, provider, appointment_date, appointment_time, duration, treatment_area, appointment_status, fin, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING *`,
      [patient_name, provider, appointment_date, appointment_time, duration || 30, treatment_area || null, appointment_status || 'Scheduled', fin || null]
    );
    return json(201, result.rows[0]);
  }

  if (path.match(/^\/appointments\/[^/]+$/) && method === 'PUT') {
    const id = path.split('/').pop();
    const existingRes = await db.query('SELECT * FROM "Appointments" WHERE id=$1', [id]);
    if (!existingRes.rows[0]) return json(404, { error: 'Appointment not found.' });
    const existing = existingRes.rows[0];
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
        mergedField(body, 'treatment_area', existing),
        mergedField(body, 'appointment_status', existing),
        body.comments ?? null,
        id,
      ]
    );
    return json(200, result.rows[0]);
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
      if (target.author_username !== currentUser.username && currentUser.role !== 'admin') {
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
    return json(201, result.rows[0]);
  }

  // Ends a series at a given date (used for "edit this and all future" --
  // the caller creates a NEW series starting from that date with the
  // changed pattern, and this call ends the OLD one the day before).
  if (path.match(/^\/recurring-series\/[^/]+\/end$/) && method === 'PUT') {
    const seriesId = path.split('/')[2];
    const { end_date } = body;
    if (!end_date) return json(400, { error: 'end_date is required.' });
    const result = await db.query('UPDATE "RecurringSeries" SET end_date=$1, updated_at=now() WHERE id=$2 RETURNING *', [end_date, seriesId]);
    if (!result.rows[0]) return json(404, { error: 'Series not found.' });
    return json(200, result.rows[0]);
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
        treatment_area !== undefined ? treatment_area : series.treatment_area,
        appointment_status || series.appointment_status,
        seriesId,
        occurrence_date, // always the ORIGINAL slot -- this is what excludes it from future virtual generation
        deleted || false,
      ]
    );
    return json(201, result.rows[0]);
  }

  // Marks an existing real exception row as deleted, rather than removing
  // it outright -- removing it would delete the exclusion that's keeping
  // this date from regenerating the series' default virtual pattern on the
  // next load.
  if (path.match(/^\/appointments\/[^/]+\/mark-deleted$/) && method === 'PUT') {
    const id = path.split('/')[2];
    const result = await db.query('UPDATE "Appointments" SET deleted=true WHERE id=$1 RETURNING *', [id]);
    if (!result.rows[0]) return json(404, { error: 'Appointment not found.' });
    return json(200, result.rows[0]);
  }

  return null;
}

module.exports = { handle };
