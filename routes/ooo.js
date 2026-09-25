const { json } = require('../lib/http');
const { displayNameFor } = require('../lib/utils');
const { getMergedOOO } = require('../lib/recurring');

// Direct OOO mutation is now scoped to an admin, or the staff member whose
// own linked provider the entry belongs to -- anyone else has no business
// touching another provider's calendar directly. This does NOT apply to
// *creating* a new entry, which stays admin-only everywhere below: the
// whole point of the Time Off request/approval system is that a real OOO
// row only ever gets created via an admin's approval, never by a direct
// call to these endpoints -- otherwise approval would be trivially
// bypassable.
function canManage(currentUser, providerName) {
  return currentUser.role === 'admin' || (!!currentUser.providerName && currentUser.providerName === providerName);
}

async function handle({ path, method, qs, body, db, currentUser }) {
  if (path === '/ooo/window' && method === 'GET') {
    const { start, end } = qs;
    if (!start || !end) return json(400, { error: 'start and end are required.' });
    const merged = await getMergedOOO(db, { startDate: start, endDate: end });
    return json(200, merged);
  }

  if (path === '/ooo/range' && method === 'GET') {
    let { provider, start, end } = qs;
    if (currentUser.role !== 'admin') {
      if (!currentUser.providerName) return json(403, { error: 'No provider is linked to your account.' });
      provider = currentUser.providerName;
    }
    if (!provider || !start || !end) return json(400, { error: 'provider, start, and end are required.' });
    const merged = await getMergedOOO(db, { startDate: start, endDate: end, provider });
    return json(200, merged);
  }

  if (path === '/ooo' && method === 'GET') {
    const date = qs.date;
    const merged = await getMergedOOO(db, { startDate: date, endDate: date });
    return json(200, merged);
  }

  if (path === '/ooo' && method === 'POST') {
    if (currentUser.role !== 'admin') return json(403, { error: 'Admin access required. Submit a Time Off request instead.' });
    const { provider, ooo_date, start_time, end_time, type, fin } = body;
    const result = await db.query(
      `INSERT INTO "Out_of_Office" (provider, ooo_date, start_time, end_time, type, fin)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [provider, ooo_date, start_time, end_time, type || 'Other', fin || null]
    );
    return json(201, result.rows[0]);
  }

  if (path === '/ooo/series-matches' && method === 'GET') {
    const { provider, type, start_time, end_time, after } = qs;
    const result = await db.query(
      `SELECT * FROM "Out_of_Office"
       WHERE provider = $1 AND type = $2 AND start_time = $3 AND end_time = $4 AND ooo_date > $5`,
      [provider, type, start_time, end_time, after]
    );
    return json(200, result.rows);
  }

  // Same fix as Appointments' fin-matches: finds siblings of a bounded OOO
  // set by their shared fin, which survives an occurrence being
  // rescheduled to a different time, unlike series-matches above.
  if (path === '/ooo/fin-matches' && method === 'GET') {
    const { fin, after } = qs;
    if (!fin) return json(400, { error: 'fin is required.' });
    const result = await db.query(
      `SELECT * FROM "Out_of_Office" WHERE fin = $1 AND ooo_date > $2`,
      [fin, after]
    );
    return json(200, result.rows);
  }

  if (path.match(/^\/ooo\/[^/]+\/comments$/) && method === 'PUT') {
    const id = path.split('/')[2];
    const existingRes = await db.query('SELECT comments FROM "Out_of_Office" WHERE id=$1', [id]);
    if (!existingRes.rows[0]) return json(404, { error: 'Out-of-office entry not found.' });

    let commentsList = [];
    const raw = existingRes.rows[0].comments;
    if (raw) {
      try {
        commentsList = JSON.parse(raw);
      } catch (err) {
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
      'UPDATE "Out_of_Office" SET comments=$1 WHERE id=$2 RETURNING *',
      [storedValue, id]
    );
    return json(200, result.rows[0]);
  }

  if (path.match(/^\/ooo\/[^/]+$/) && method === 'PUT') {
    const id = path.split('/').pop();
    const existingRes = await db.query('SELECT provider FROM "Out_of_Office" WHERE id=$1', [id]);
    if (!existingRes.rows[0]) return json(404, { error: 'Out-of-office entry not found.' });
    if (!canManage(currentUser, existingRes.rows[0].provider)) {
      return json(403, { error: 'You can only manage your own out-of-office entries.' });
    }
    const { provider, ooo_date, start_time, end_time, type, comments } = body;
    // Same fix as the Appointments update: don't blank out comments just
    // because this particular caller's payload doesn't include them.
    const result = await db.query(
      `UPDATE "Out_of_Office" SET provider=$1, ooo_date=$2, start_time=$3, end_time=$4, type=$5, comments=COALESCE($6, comments)
       WHERE id=$7 RETURNING *`,
      [provider, ooo_date, start_time, end_time, type, comments ?? null, id]
    );
    return json(200, result.rows[0]);
  }

  if (path.match(/^\/ooo\/[^/]+\/mark-deleted$/) && method === 'PUT') {
    const id = path.split('/')[2];
    const existingRes = await db.query('SELECT provider FROM "Out_of_Office" WHERE id=$1', [id]);
    if (!existingRes.rows[0]) return json(404, { error: 'Out-of-office entry not found.' });
    if (!canManage(currentUser, existingRes.rows[0].provider)) {
      return json(403, { error: 'You can only manage your own out-of-office entries.' });
    }
    const result = await db.query('UPDATE "Out_of_Office" SET deleted=true WHERE id=$1 RETURNING *', [id]);
    return json(200, result.rows[0]);
  }

  if (path.match(/^\/ooo\/[^/]+$/) && method === 'DELETE') {
    const id = path.split('/').pop();
    const existingRes = await db.query('SELECT provider FROM "Out_of_Office" WHERE id=$1', [id]);
    if (!existingRes.rows[0]) return json(404, { error: 'Out-of-office entry not found.' });
    if (!canManage(currentUser, existingRes.rows[0].provider)) {
      return json(403, { error: 'You can only manage your own out-of-office entries.' });
    }
    await db.query('DELETE FROM "Out_of_Office" WHERE id=$1', [id]);
    return json(200, { deleted: true });
  }

  if (path === '/ooo-series' && method === 'POST') {
    if (currentUser.role !== 'admin') return json(403, { error: 'Admin access required. Submit a Time Off request instead.' });
    const { provider, weekday, start_time, end_time, type, start_date } = body;
    if (provider == null || weekday == null || !start_time || !end_time || !type || !start_date) {
      return json(400, { error: 'provider, weekday, start_time, end_time, type, and start_date are required.' });
    }
    const result = await db.query(
      `INSERT INTO "OOO_RecurringSeries" (provider, weekday, start_time, end_time, type, start_date)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [provider, weekday, start_time, end_time, type, start_date]
    );
    return json(201, result.rows[0]);
  }

  if (path.match(/^\/ooo-series\/[^/]+\/end$/) && method === 'PUT') {
    const seriesId = path.split('/')[2];
    const seriesRes = await db.query('SELECT provider FROM "OOO_RecurringSeries" WHERE id=$1', [seriesId]);
    if (!seriesRes.rows[0]) return json(404, { error: 'Series not found.' });
    if (!canManage(currentUser, seriesRes.rows[0].provider)) {
      return json(403, { error: 'You can only manage your own out-of-office entries.' });
    }
    const { end_date } = body;
    if (!end_date) return json(400, { error: 'end_date is required.' });
    const result = await db.query('UPDATE "OOO_RecurringSeries" SET end_date=$1, updated_at=now() WHERE id=$2 RETURNING *', [end_date, seriesId]);
    return json(200, result.rows[0]);
  }

  // Same purpose as the Appointments version: ending a series only stops
  // NEW virtual occurrences past that date -- any occurrence already
  // touched before the delete (a prior edit or reschedule) already exists
  // as a real row and keeps showing up otherwise. Used only by "delete this
  // and all future," never by the edit-and-split flow.
  if (path.match(/^\/ooo-series\/[^/]+\/purge-future-exceptions$/) && method === 'PUT') {
    const seriesId = path.split('/')[2];
    const seriesRes = await db.query('SELECT provider FROM "OOO_RecurringSeries" WHERE id=$1', [seriesId]);
    if (!seriesRes.rows[0]) return json(404, { error: 'Series not found.' });
    if (!canManage(currentUser, seriesRes.rows[0].provider)) {
      return json(403, { error: 'You can only manage your own out-of-office entries.' });
    }
    const { from_date } = body;
    if (!from_date) return json(400, { error: 'from_date is required.' });
    const result = await db.query(
      `UPDATE "Out_of_Office" SET deleted=true
       WHERE exception_of_series_id=$1 AND exception_occurrence_date >= $2 RETURNING id`,
      [seriesId, from_date]
    );
    return json(200, { purged: result.rowCount });
  }

  // Materializes a single virtual OOO occurrence into a real row -- same
  // purpose as the Appointments version: called whenever someone edits or
  // removes one specific date rather than the whole series. `deleted`
  // marks a row that exists purely to exclude its date going forward and
  // is filtered out of every normal GET.
  if (path.match(/^\/ooo-series\/[^/]+\/exceptions$/) && method === 'POST') {
    const seriesId = path.split('/')[2];
    const { occurrence_date, ooo_date, provider, start_time, end_time, type, deleted } = body;
    if (!occurrence_date) return json(400, { error: 'occurrence_date is required.' });

    const seriesRes = await db.query('SELECT * FROM "OOO_RecurringSeries" WHERE id=$1', [seriesId]);
    const series = seriesRes.rows[0];
    if (!series) return json(404, { error: 'Series not found.' });
    if (!canManage(currentUser, series.provider)) {
      return json(403, { error: 'You can only manage your own out-of-office entries.' });
    }

    const result = await db.query(
      `INSERT INTO "Out_of_Office"
         (provider, ooo_date, start_time, end_time, type, exception_of_series_id, exception_occurrence_date, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        provider || series.provider,
        ooo_date || occurrence_date, // supports rescheduling this one occurrence to a different date
        start_time || series.start_time,
        end_time || series.end_time,
        type || series.type,
        seriesId,
        occurrence_date, // always the ORIGINAL slot -- this is what excludes it from future virtual generation
        deleted || false,
      ]
    );
    return json(201, result.rows[0]);
  }

  return null;
}

module.exports = { handle };
