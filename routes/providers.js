const { json } = require('../lib/http');
const { HttpError, assertNameAvailable, cascadeProviderRename } = require('../lib/providerNames');

async function handle({ path, method, qs, body, db, currentUser }) {
  // A provider counts as archived when their staff account is archived
  // (and no active account is linked). By default they're left out, so
  // they drop off the schedule columns and every provider dropdown.
  // ?include_archived=true returns everyone with `archived` and
  // `linked_username` -- used by the admin screens, and by the daily
  // schedule to still show an archived provider's leftover appointments.
  if (path === '/providers' && method === 'GET') {
    const includeArchived = qs.include_archived === 'true';
    const result = await db.query(
      `SELECT * FROM (
         SELECT p.id, p."Name", p.first_name, p.last_name, p.specialty, p.credentials,
                (EXISTS (SELECT 1 FROM "Staff" s WHERE s.provider_name = p."Name" AND s.archived = true)
                 AND NOT EXISTS (SELECT 1 FROM "Staff" s WHERE s.provider_name = p."Name" AND s.archived = false)) AS archived,
                (SELECT s.username FROM "Staff" s WHERE s.provider_name = p."Name" ORDER BY s.archived, s.id LIMIT 1) AS linked_username
         FROM "Providers" p
       ) x
       WHERE $1 OR NOT x.archived
       ORDER BY "Name"`,
      [includeArchived]
    );
    return json(200, result.rows);
  }

  if (path === '/providers' && method === 'POST') {
    if (currentUser.role !== 'admin') return json(403, { error: 'Admin access required.' });
    const { first_name, last_name, specialty, credentials } = body;
    if (!first_name?.trim() || !last_name?.trim()) {
      return json(400, { error: 'First name and last name are required.' });
    }
    const name = `${first_name.trim()} ${last_name.trim()}`;
    try {
      await assertNameAvailable(db, name);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message, ...err.extra });
      throw err;
    }
    const result = await db.query(
      'INSERT INTO "Providers" ("Name", first_name, last_name, specialty, credentials) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, first_name.trim(), last_name.trim(), specialty?.trim() || null, credentials?.trim() || null]
    );
    return json(201, result.rows[0]);
  }

  if (path.match(/^\/providers\/[^/]+$/) && method === 'PUT') {
    if (currentUser.role !== 'admin') return json(403, { error: 'Admin access required.' });
    const id = path.split('/').pop();
    const { first_name, last_name, specialty, credentials } = body;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const existingRes = await client.query('SELECT "Name", first_name, last_name FROM "Providers" WHERE id=$1', [id]);
      if (!existingRes.rows[0]) {
        await client.query('ROLLBACK');
        return json(404, { error: 'Provider not found' });
      }
      const existing = existingRes.rows[0];
      const oldName = existing.Name;
      // Name is derived from first+last whenever both end up populated
      // (considering both this request AND whatever was already on file)
      // -- otherwise left exactly as-is, so editing just Specialty or
      // Credentials on a provider who hasn't had their name fields filled
      // in yet never blanks out their working Name.
      const finalFirstName = first_name?.trim() || existing.first_name;
      const finalLastName = last_name?.trim() || existing.last_name;
      const newName = (finalFirstName && finalLastName) ? `${finalFirstName} ${finalLastName}` : oldName;
      if (newName !== oldName) {
        const clash = await client.query('SELECT 1 FROM "Providers" WHERE "Name"=$1 AND id<>$2', [newName, id]);
        if (clash.rows[0]) {
          await client.query('ROLLBACK');
          return json(409, { error: `Another provider is already named "${newName}".`, nameTaken: newName });
        }
      }

      const updateRes = await client.query(
        `UPDATE "Providers" SET
           "Name" = $1,
           first_name = COALESCE($2, first_name),
           last_name = COALESCE($3, last_name),
           specialty = COALESCE($4, specialty),
           credentials = COALESCE($5, credentials)
         WHERE id = $6 RETURNING *`,
        [newName, first_name?.trim() || null, last_name?.trim() || null, specialty?.trim() || null, credentials?.trim() || null, id]
      );
      // Providers are referenced by name, not id, in six tables -- see
      // lib/providerNames.js for the list (weekly hours were previously
      // missed here and got dropped on rename).
      await cascadeProviderRename(client, oldName, newName);
      await client.query('COMMIT');
      return json(200, updateRes.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  if (path.match(/^\/providers\/[^/]+$/) && method === 'DELETE') {
    if (currentUser.role !== 'admin') return json(403, { error: 'Admin access required.' });
    const id = path.split('/').pop();
    const force = qs.force === 'true';
    const providerRes = await db.query('SELECT "Name" FROM "Providers" WHERE id=$1', [id]);
    const name = providerRes.rows[0]?.Name;
    if (!name) return json(404, { error: 'Provider not found' });

    // Appointment history is a real clinical/scheduling record -- unlike the
    // staff-link check below, there is no force override here. A provider
    // who has ever seen a patient can't be deleted; there's no "Off
    // Program"-equivalent to fall back to for a provider the way there is
    // for a patient, so this is a hard stop.
    const countRes = await db.query(
      'SELECT COUNT(*)::int AS count FROM "Appointments" WHERE provider=$1',
      [name]
    );
    if (countRes.rows[0].count > 0) {
      return json(409, {
        error: 'This provider has appointment history and cannot be deleted.',
        linkedCount: countRes.rows[0].count,
        blocked: true,
      });
    }

    if (!force) {
      // A staff account being linked isn't "usage" in the same sense as an
      // appointment, but deleting the provider out from under it leaves that
      // staff member's login pointing at nothing -- their own schedule
      // access, document signing, and compliance-task routing all rely on
      // this link, so it's worth the same confirm-before-deleting treatment.
      const staffRes = await db.query(
        'SELECT username FROM "Staff" WHERE provider_name=$1 AND archived=false',
        [name]
      );
      if (staffRes.rows.length > 0) {
        return json(409, {
          error: 'This provider is linked to a staff account.',
          linkedStaff: staffRes.rows.map(r => r.username),
        });
      }
    }

    // Force-deleting still shouldn't leave a stale reference behind -- clear
    // the link on any staff account rather than leaving it pointing at a
    // provider that no longer exists.
    await db.query('UPDATE "Staff" SET provider_name=NULL WHERE provider_name=$1', [name]);
    const changesTable = await db.query(`SELECT to_regclass('"ProviderScheduleChanges"') IS NOT NULL AS ok`);
    if (changesTable.rows[0]?.ok) await db.query('DELETE FROM "ProviderScheduleChanges" WHERE provider=$1', [name]);
    await db.query('DELETE FROM "Providers" WHERE id=$1', [id]);
    return json(200, { deleted: true });
  }

  return null;
}

module.exports = { handle };
