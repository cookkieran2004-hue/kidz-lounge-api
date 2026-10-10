// Dated versions for what an EI-Hub claim says (Oct 2026;
// migrations/2026-10-23_ei_history.sql). EI-Hub checks every claim against
// its record as it stood on the date of service, and the agency must keep
// what it billed and when it changed -- so a change is never an overwrite:
//
//   addVersion      a change that takes effect from a date: the current
//                   version ends the day before and is kept
//   correctVersion  fixes a mistake in one version, its dates unchanged
//   deleteLatest    takes back the newest version (entered in error); the
//                   one before it becomes current again
//   versionOn       the version in effect on a date
//
// One table per kind of record, each row a version: start_date NULL = from
// the beginning, end_date NULL = current; versions of one record never
// overlap. Callers check the values and run these inside a transaction.

const KINDS = {
  child: {
    table: '"PatientEiDetails"',
    key: 'patient_id',
    fields: ['ei_child_id', 'first_name', 'last_name', 'date_of_birth', 'sex', 'address_line1', 'address_line2', 'city', 'state', 'zip', 'county', 'diagnosis_codes'],
  },
  referral: {
    table: '"EiReferralPeriods"',
    key: 'authorization_number',
    fields: ['referring_last', 'referring_first', 'referring_npi'],
  },
};

const pad = (n) => String(n).padStart(2, '0');
const day = (v) => (v ? (v instanceof Date ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` : String(v).slice(0, 10)) : null);
function addDays(s, n) {
  const d = new Date(`${s}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const fmt = (s) => new Date(`${s}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// The version in effect on `date` ('YYYY-MM-DD'), or null.
function versionOn(rows, date) {
  return (rows || []).find(r => (!r.start_date || day(r.start_date) <= date) && (!r.end_date || day(r.end_date) >= date)) || null;
}

// A record's versions, oldest first.
async function listVersions(q, kind, keyVal) {
  const k = KINDS[kind];
  return (await q.query(`SELECT * FROM ${k.table} WHERE ${k.key} = $1 ORDER BY start_date NULLS FIRST, id`, [keyVal])).rows;
}

// Every version for several records, grouped by key (for lists and claims).
async function versionsFor(q, kind, keyVals) {
  const k = KINDS[kind];
  if (!keyVals.length) return {};
  const rows = (await q.query(`SELECT * FROM ${k.table} WHERE ${k.key} = ANY($1) ORDER BY start_date NULLS FIRST, id`, [keyVals])).rows;
  const out = {};
  rows.forEach(r => { (out[r[k.key]] = out[r[k.key]] || []).push(r); });
  return out;
}

const same = (a, b) => String(a ?? '') === String(b ?? '');
const sameValues = (k, row, values) => k.fields.every(f => same(f === 'date_of_birth' ? day(row[f]) : row[f], values[f]));

// A change from `effectiveFrom` ('YYYY-MM-DD'). The first version of a record
// may have no date (it then covers everything before it, too). Returns
// { row } or { error }.
async function addVersion(q, kind, keyVal, values, effectiveFrom, username) {
  const k = KINDS[kind];
  const versions = await listVersions(q, kind, keyVal);
  const current = versions.find(v => !v.end_date) || null;
  const cols = k.fields.map(f => values[f] ?? null);
  const insert = async (start) => (await q.query(
    `INSERT INTO ${k.table} (${k.key}, start_date, ${k.fields.join(', ')}, created_by)
     VALUES ($1, $2, ${k.fields.map((_, i) => `$${i + 3}`).join(', ')}, $${k.fields.length + 3}) RETURNING *`,
    [keyVal, start, ...cols, username]
  )).rows[0];

  if (!current) {
    // Nothing current: a first version, or a record whose versions all ended.
    const lastEnd = versions.length ? day(versions[versions.length - 1].end_date) : null;
    if (lastEnd && (!effectiveFrom || effectiveFrom <= lastEnd)) {
      return { error: `Choose a date after ${fmt(lastEnd)}, when the last version ended.` };
    }
    return { row: await insert(effectiveFrom || null) };
  }
  if (sameValues(k, current, values)) return { row: current, unchanged: true };
  if (!effectiveFrom) return { error: 'Choose the date the change takes effect.' };
  const currentStart = day(current.start_date);
  if (currentStart && effectiveFrom < currentStart) {
    return { error: `The current version starts ${fmt(currentStart)}, so a change can't start earlier. To fix a mistake in it, correct that version instead.` };
  }
  if (currentStart && effectiveFrom === currentStart) {
    // Same start: it's this version that's wrong, so correct it in place.
    return correctVersion(q, kind, current.id, values, username);
  }
  await q.query(`UPDATE ${k.table} SET end_date = $1, ended_by = $2 WHERE id = $3`, [addDays(effectiveFrom, -1), username, current.id]);
  return { row: await insert(effectiveFrom) };
}

// Fixes a version's values; its dates stay.
async function correctVersion(q, kind, id, values, username) {
  const k = KINDS[kind];
  const row = (await q.query(
    `UPDATE ${k.table} SET ${k.fields.map((f, i) => `${f} = $${i + 1}`).join(', ')}, updated_by = $${k.fields.length + 1}, updated_at = now()
     WHERE id = $${k.fields.length + 2} RETURNING *`,
    [...k.fields.map(f => values[f] ?? null), username, id]
  )).rows[0];
  return row ? { row } : { error: 'That version no longer exists. Reload and try again.' };
}

// Takes back the newest version; the one it replaced becomes current again.
async function deleteLatest(q, kind, keyVal, id) {
  const k = KINDS[kind];
  const versions = await listVersions(q, kind, keyVal);
  const latest = versions[versions.length - 1];
  if (!latest || String(latest.id) !== String(id)) return { error: 'Only the newest version can be taken back. Correct an older one instead.' };
  await q.query(`DELETE FROM ${k.table} WHERE id = $1`, [latest.id]);
  const previous = versions[versions.length - 2];
  if (previous && !latest.end_date) {
    await q.query(`UPDATE ${k.table} SET end_date = NULL, ended_by = NULL WHERE id = $1`, [previous.id]);
  }
  return { ok: true };
}

module.exports = { KINDS, versionOn, listVersions, versionsFor, addVersion, correctVersion, deleteLatest, day };
