// Meeting agendas and shared comment threads.
// Both belong to the MEETING -- the organizer's time-off entry (request id)
// -- not to any one person's calendar block, so the organizer and every
// attendee see and edit the same thing. (Migrations 2026-09-26 and
// 2026-09-27.) Ids are compared as text, so ints or uuids both work.
//
// MeetingAgendas.kind:
//   'series' -> recurring agenda, same every week        (ref_id = request id)
//   'week'   -> "this week only" notes for one date       (ref_id = request id + date)
//   'single' -> the agenda of a one-time meeting          (ref_id = request id)
// MeetingComments: one thread per meeting, per week for a recurring one.

const tableChecks = {};
function hasTable(db, name) {
  if (!tableChecks[name]) {
    tableChecks[name] = db.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`"${name}"`])
      .then(r => !!r.rows[0]?.ok)
      .catch(() => false);
  }
  return tableChecks[name];
}
const hasAgendaTable = (db) => hasTable(db, 'MeetingAgendas');
const hasCommentsTable = (db) => hasTable(db, 'MeetingComments');

async function getAgenda(q, kind, refId, occurrenceDate = null) {
  const res = await q.query(
    `SELECT agenda FROM "MeetingAgendas" WHERE kind=$1 AND ref_id=$2 AND occurrence_date IS NOT DISTINCT FROM $3`,
    [kind, String(refId), occurrenceDate]
  );
  return res.rows[0]?.agenda || '';
}

async function setAgenda(q, kind, refId, occurrenceDate, agenda, updatedBy) {
  const text = (agenda || '').replace(/\s+$/, '');
  if (!text) {
    await q.query(
      `DELETE FROM "MeetingAgendas" WHERE kind=$1 AND ref_id=$2 AND occurrence_date IS NOT DISTINCT FROM $3`,
      [kind, String(refId), occurrenceDate]
    );
    return '';
  }
  await q.query(
    `INSERT INTO "MeetingAgendas" (kind, ref_id, occurrence_date, agenda, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (kind, ref_id, COALESCE(occurrence_date, DATE '1900-01-01'))
     DO UPDATE SET agenda = EXCLUDED.agenda, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [kind, String(refId), occurrenceDate, text, updatedBy || null]
  );
  return text;
}

async function getMeetingComments(q, requestRef, occurrenceDate = null) {
  const res = await q.query(
    `SELECT comments FROM "MeetingComments" WHERE request_ref=$1 AND occurrence_date IS NOT DISTINCT FROM $2`,
    [String(requestRef), occurrenceDate]
  );
  return res.rows[0]?.comments || null;
}

async function setMeetingComments(q, requestRef, occurrenceDate, comments) {
  await q.query(
    `INSERT INTO "MeetingComments" (request_ref, occurrence_date, comments, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (request_ref, COALESCE(occurrence_date, DATE '1900-01-01'))
     DO UPDATE SET comments = EXCLUDED.comments, updated_at = now()`,
    [String(requestRef), occurrenceDate, comments]
  );
}

module.exports = { hasAgendaTable, hasCommentsTable, getAgenda, setAgenda, getMeetingComments, setMeetingComments };
