// Core engine for the new recurring model: given a RecurringSeries row and
// a date range, computes the "virtual" occurrences that fall within it --
// dates that follow the weekly pattern but have no real Appointments row
// of their own. Any date with a real exception row is excluded here, since
// that real row already represents the occurrence and is returned by the
// normal Appointments query instead -- callers merge both lists together.
function expandSeriesOccurrences(series, rangeStartStr, rangeEndStr, exceptionDatesSet) {
  const occurrences = [];
  const rangeStart = new Date(rangeStartStr + 'T00:00:00');
  const rangeEnd = new Date(rangeEndStr + 'T00:00:00');
  const seriesStart = new Date(series.start_date + 'T00:00:00');
  const seriesEnd = series.end_date ? new Date(series.end_date + 'T00:00:00') : null;

  const effectiveStart = rangeStart > seriesStart ? rangeStart : seriesStart;
  if (seriesEnd && effectiveStart > seriesEnd) return occurrences;
  if (effectiveStart > rangeEnd) return occurrences;

  const daysUntilWeekday = (series.weekday - effectiveStart.getDay() + 7) % 7;
  let cursor = new Date(effectiveStart.getTime() + daysUntilWeekday * 24 * 60 * 60 * 1000);

  while (cursor <= rangeEnd) {
    if (seriesEnd && cursor > seriesEnd) break;
    const dateStr = cursor.toISOString().slice(0, 10);
    if (!exceptionDatesSet.has(dateStr)) {
      occurrences.push({
        id: `virtual-${series.id}-${dateStr}`,
        is_virtual: true,
        series_id: series.id,
        patient_name: series.patient_name,
        provider: series.provider,
        appointment_date: dateStr,
        appointment_time: series.appointment_time,
        duration: series.duration,
        treatment_area: series.treatment_area,
        appointment_status: series.appointment_status,
        comments: null,
      });
    }
    cursor = new Date(cursor.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  return occurrences;
}

// Exception dates for every series at once, as { seriesId: Set(dates) }.
// This used to be one query per series, run one after another, so a day
// view with a few hundred active series made a few hundred round-trips to
// the database -- the main reason the Schedule page was slow to load.
// Only exceptions inside the range matter: expansion never produces a
// date outside it. Deliberately ignores the `deleted` flag -- a deleted
// occurrence still needs to keep its date from regenerating.
async function loadExceptionDates(db, table, seriesIds, startDate, endDate) {
  const bySeries = {};
  if (seriesIds.length === 0) return bySeries;
  const res = await db.query(
    `SELECT exception_of_series_id, exception_occurrence_date FROM "${table}"
     WHERE exception_of_series_id = ANY($1) AND exception_occurrence_date BETWEEN $2 AND $3`,
    [seriesIds, startDate, endDate]
  );
  for (const r of res.rows) {
    const key = String(r.exception_of_series_id);
    (bySeries[key] = bySeries[key] || new Set()).add(r.exception_occurrence_date);
  }
  return bySeries;
}

// Shared by every appointment-fetching endpoint: returns real Appointments
// rows for the range PLUS virtual occurrences from any RecurringSeries
// whose pattern falls in that range, merged and sorted together. This is
// the actual fix for "recurring series stop generating" -- there's no
// window to run out of, since nothing needs to be pre-generated at all.
// Real rows marked `deleted` are excluded here -- they exist only to keep
// their date out of future virtual generation and are never shown.
async function getMergedAppointments(db, { startDate, endDate, provider = null, patientName = null }) {
  let realQuery = 'SELECT * FROM "Appointments" WHERE appointment_date BETWEEN $1 AND $2 AND deleted = false';
  const realParams = [startDate, endDate];
  if (provider) { realParams.push(provider); realQuery += ` AND provider = $${realParams.length}`; }
  if (patientName) { realParams.push(patientName); realQuery += ` AND patient_name = $${realParams.length}`; }

  let seriesQuery = 'SELECT * FROM "RecurringSeries" WHERE start_date <= $2 AND (end_date IS NULL OR end_date >= $1)';
  const seriesParams = [startDate, endDate];
  if (provider) { seriesParams.push(provider); seriesQuery += ` AND provider = $${seriesParams.length}`; }
  if (patientName) { seriesParams.push(patientName); seriesQuery += ` AND patient_name = $${seriesParams.length}`; }

  const [realRes, seriesRes] = await Promise.all([db.query(realQuery, realParams), db.query(seriesQuery, seriesParams)]);
  const exceptionsBySeries = await loadExceptionDates(db, 'Appointments', seriesRes.rows.map(s => s.id), startDate, endDate);

  const virtualRows = [];
  const noExceptions = new Set();
  for (const series of seriesRes.rows) {
    virtualRows.push(...expandSeriesOccurrences(series, startDate, endDate, exceptionsBySeries[String(series.id)] || noExceptions));
  }

  return [...realRes.rows, ...virtualRows].sort((a, b) => (a.appointment_date + a.appointment_time).localeCompare(b.appointment_date + b.appointment_time));
}

// Same idea as expandSeriesOccurrences, for Out-of-Office. OOO has no status
// field the way Appointments does, so there's no "Canceled" to fall back on
// for a deleted single occurrence -- that's handled instead by the caller
// checking the `deleted` flag on any real exception row before including it.
function expandOOOSeriesOccurrences(series, rangeStartStr, rangeEndStr, exceptionDatesSet) {
  const occurrences = [];
  const rangeStart = new Date(rangeStartStr + 'T00:00:00');
  const rangeEnd = new Date(rangeEndStr + 'T00:00:00');
  const seriesStart = new Date(series.start_date + 'T00:00:00');
  const seriesEnd = series.end_date ? new Date(series.end_date + 'T00:00:00') : null;

  const effectiveStart = rangeStart > seriesStart ? rangeStart : seriesStart;
  if (seriesEnd && effectiveStart > seriesEnd) return occurrences;
  if (effectiveStart > rangeEnd) return occurrences;

  const daysUntilWeekday = (series.weekday - effectiveStart.getDay() + 7) % 7;
  let cursor = new Date(effectiveStart.getTime() + daysUntilWeekday * 24 * 60 * 60 * 1000);

  while (cursor <= rangeEnd) {
    if (seriesEnd && cursor > seriesEnd) break;
    const dateStr = cursor.toISOString().slice(0, 10);
    if (!exceptionDatesSet.has(dateStr)) {
      occurrences.push({
        id: `virtual-${series.id}-${dateStr}`,
        is_virtual: true,
        series_id: series.id,
        provider: series.provider,
        ooo_date: dateStr,
        start_time: series.start_time,
        end_time: series.end_time,
        type: series.type,
        comments: null,
        // Which time-off entry made this series (shared meetings etc.)
        time_off_request_id: series.time_off_request_id ?? null,
      });
    }
    cursor = new Date(cursor.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  return occurrences;
}

// Shared by every OOO-fetching endpoint: real rows for the range (excluding
// any marked `deleted`, which exist only to keep their date out of future
// virtual generation and are never shown) plus virtual occurrences from any
// OOO_RecurringSeries whose pattern falls in that range.
async function getMergedOOO(db, { startDate, endDate, provider = null }) {
  let realQuery = 'SELECT * FROM "Out_of_Office" WHERE ooo_date BETWEEN $1 AND $2 AND deleted = false';
  const realParams = [startDate, endDate];
  if (provider) { realParams.push(provider); realQuery += ` AND provider = $${realParams.length}`; }

  let seriesQuery = 'SELECT * FROM "OOO_RecurringSeries" WHERE start_date <= $2 AND (end_date IS NULL OR end_date >= $1)';
  const seriesParams = [startDate, endDate];
  if (provider) { seriesParams.push(provider); seriesQuery += ` AND provider = $${seriesParams.length}`; }

  const [realRes, seriesRes] = await Promise.all([db.query(realQuery, realParams), db.query(seriesQuery, seriesParams)]);
  const exceptionsBySeries = await loadExceptionDates(db, 'Out_of_Office', seriesRes.rows.map(s => s.id), startDate, endDate);

  const virtualRows = [];
  const noExceptions = new Set();
  for (const series of seriesRes.rows) {
    virtualRows.push(...expandOOOSeriesOccurrences(series, startDate, endDate, exceptionsBySeries[String(series.id)] || noExceptions));
  }

  return [...realRes.rows, ...virtualRows].sort((a, b) => (a.ooo_date + a.start_time).localeCompare(b.ooo_date + b.start_time));
}

module.exports = { expandSeriesOccurrences, getMergedAppointments, expandOOOSeriesOccurrences, getMergedOOO };
