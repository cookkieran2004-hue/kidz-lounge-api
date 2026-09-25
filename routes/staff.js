const bcrypt = require('bcryptjs');
const { json } = require('../lib/http');
const { HttpError, syncLinkedProvider, assertProviderNotLinkedElsewhere } = require('../lib/providerNames');
const { verifyAdminPassword } = require('../lib/auth');
const { displayNameFor } = require('../lib/utils');

async function handle({ path, method, body, db, currentUser }) {
  // Lightweight, non-admin-gated staff list -- any staff member can edit a
  // patient's Case Manager, so the dropdown that populates it needs to be
  // available to everyone, not just admins (unlike /auth/users below, which
  // is full account management and stays admin-only).
  if (path === '/staff/directory' && method === 'GET') {
    const result = await db.query(
      `SELECT username, first_name, middle_name, last_name, preferred_name FROM "Staff" WHERE archived = false ORDER BY username`
    );
    const directory = result.rows.map(s => ({ username: s.username, display_name: displayNameFor(s) }));
    return json(200, directory);
  }

  // ---------- Self-service: a staff member's own personal page ----------
  // Deliberately separate from /auth/users -- that's full account
  // management (role, position, archiving) and stays admin-only. This is
  // just the handful of fields someone should be able to update about
  // themselves without asking an admin.
  if (path === '/staff/me' && method === 'GET') {
    const result = await db.query(
      `SELECT username, role, provider_name, first_name, middle_name, last_name, preferred_name, position, phone, email, hire_date
       FROM "Staff" WHERE username=$1`,
      [currentUser.username]
    );
    return json(200, result.rows[0] || null);
  }

  if (path === '/staff/me' && method === 'PUT') {
    const { phone, email, preferred_name } = body;
    const result = await db.query(
      `UPDATE "Staff" SET phone=$1, email=$2, preferred_name=$3 WHERE username=$4
       RETURNING username, role, provider_name, first_name, middle_name, last_name, preferred_name, position, phone, email, hire_date`,
      [phone || null, email || null, preferred_name || null, currentUser.username]
    );
    return json(200, result.rows[0]);
  }

  if (path === '/staff/credentials' && method === 'GET') {
    const result = await db.query(
      `SELECT * FROM "StaffCredentials" WHERE username=$1 ORDER BY expiration_date ASC`,
      [currentUser.username]
    );
    return json(200, result.rows);
  }

  if (path === '/staff/credentials' && method === 'POST') {
    const { credential_name, expiration_date, notes } = body;
    if (!credential_name || !credential_name.trim()) return json(400, { error: 'Credential name is required.' });
    if (!expiration_date) return json(400, { error: 'Expiration date is required.' });
    const result = await db.query(
      `INSERT INTO "StaffCredentials" (username, credential_name, expiration_date, notes) VALUES ($1,$2,$3,$4) RETURNING *`,
      [currentUser.username, credential_name.trim(), expiration_date, notes || null]
    );
    return json(201, result.rows[0]);
  }

  if (path.match(/^\/staff\/credentials\/[^/]+$/) && method === 'PUT') {
    const id = path.split('/').pop();
    const existing = await db.query('SELECT username FROM "StaffCredentials" WHERE id=$1', [id]);
    if (!existing.rows[0]) return json(404, { error: 'Credential not found.' });
    if (existing.rows[0].username !== currentUser.username && currentUser.role !== 'admin') {
      return json(403, { error: 'You can only edit your own credentials.' });
    }
    const { credential_name, expiration_date, notes } = body;
    const result = await db.query(
      `UPDATE "StaffCredentials" SET
         credential_name = COALESCE($1, credential_name),
         expiration_date = COALESCE($2, expiration_date),
         notes = COALESCE($3, notes),
         updated_at = now()
       WHERE id=$4 RETURNING *`,
      [credential_name || null, expiration_date || null, notes ?? null, id]
    );
    return json(200, result.rows[0]);
  }

  if (path.match(/^\/staff\/credentials\/[^/]+$/) && method === 'DELETE') {
    const id = path.split('/').pop();
    const existing = await db.query('SELECT username FROM "StaffCredentials" WHERE id=$1', [id]);
    if (!existing.rows[0]) return json(404, { error: 'Credential not found.' });
    if (existing.rows[0].username !== currentUser.username && currentUser.role !== 'admin') {
      return json(403, { error: 'You can only delete your own credentials.' });
    }
    await db.query('DELETE FROM "StaffCredentials" WHERE id=$1', [id]);
    return json(200, { deleted: true });
  }

  if (path === '/auth/users' && method === 'GET') {
    if (currentUser.role !== 'admin') return json(403, { error: 'Admin access required.' });
    const result = await db.query(
      `SELECT id, username, role, provider_name, must_reset_password, created_at, last_login,
              first_name, middle_name, last_name, preferred_name, position, archived, hire_date
       FROM "Staff" ORDER BY archived, username`
    );
    return json(200, result.rows);
  }

  if (path === '/auth/users' && method === 'POST') {
    if (currentUser.role !== 'admin') return json(403, { error: 'Admin access required.' });
    const { first_name, middle_name, last_name, preferred_name, position, temporary_password, role, provider_name, admin_password, hire_date } = body;
    if (!(await verifyAdminPassword(db, currentUser, admin_password))) {
      return json(401, { error: 'Incorrect password. Please re-enter your password to confirm this change.' });
    }
    if (!first_name?.trim() || !middle_name?.trim() || !last_name?.trim() || !position?.trim() || !temporary_password) {
      return json(400, { error: 'First name, middle name, last name, position, and a temporary password are all required.' });
    }

    // Username is generated by the system, never typed in: first + middle +
    // last initial, uppercase, plus 3 random digits (e.g. KJC135). Retries
    // on the rare chance of a collision with an existing username.
    const initials = (first_name.trim()[0] + middle_name.trim()[0] + last_name.trim()[0]).toUpperCase();
    let username;
    let attempts = 0;
    while (attempts < 20) {
      const digits = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
      const candidate = initials + digits;
      const existing = await db.query('SELECT id FROM "Staff" WHERE username=$1', [candidate]);
      if (!existing.rows[0]) { username = candidate; break; }
      attempts++;
    }
    if (!username) return json(500, { error: 'Could not generate a unique username. Please try again.' });

    const passwordHash = await bcrypt.hash(temporary_password, 10);
    // One transaction: create the account, then rename the linked provider
    // to match the person (see lib/providerNames.js). A name clash or a
    // provider that already belongs to someone rolls the whole thing back.
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await assertProviderNotLinkedElsewhere(client, provider_name || null);
      const result = await client.query(
        `INSERT INTO "Staff" (username, password_hash, role, must_reset_password, provider_name, first_name, middle_name, last_name, preferred_name, position, hire_date)
         VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, username, role, provider_name, must_reset_password, created_at, first_name, middle_name, last_name, preferred_name, position, archived, hire_date`,
        [username, passwordHash, role === 'admin' ? 'admin' : 'staff', provider_name || null, first_name.trim(), middle_name.trim(), last_name.trim(), preferred_name?.trim() || null, position.trim(), hire_date || null]
      );
      const created = result.rows[0];
      const syncedName = await syncLinkedProvider(client, created);
      if (syncedName) created.provider_name = syncedName;
      await client.query('COMMIT');
      return json(201, created);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err instanceof HttpError) return json(err.status, { error: err.message, ...err.extra });
      throw err;
    } finally {
      client.release();
    }
  }

  if (path.match(/^\/auth\/users\/[^/]+$/) && method === 'PUT') {
    if (currentUser.role !== 'admin') return json(403, { error: 'Admin access required.' });
    const id = path.split('/').pop();
    const { role, reset_temporary_password, provider_name, admin_password, first_name, middle_name, last_name, preferred_name, position, archived, hire_date } = body;
    if (!(await verifyAdminPassword(db, currentUser, admin_password))) {
      return json(401, { error: 'Incorrect password. Please re-enter your password to confirm this change.' });
    }
    // provider_name and hire_date are only touched when the key is actually
    // present in the request -- this lets a password-reset-only call leave
    // both alone, while a full edit-form save (which always sends both
    // keys, even as empty, to clear) can still explicitly clear either.
    const hasProviderNameField = Object.prototype.hasOwnProperty.call(body, 'provider_name');
    const hasHireDateField = Object.prototype.hasOwnProperty.call(body, 'hire_date');
    // Same rule for preferred_name: present-but-empty clears it (so the
    // person goes back to their first name, on the schedule too); absent
    // leaves it alone. Previously an empty value could never clear it.
    const hasPreferredNameField = Object.prototype.hasOwnProperty.call(body, 'preferred_name');

    let passwordHash = null;
    let mustReset = null;
    if (reset_temporary_password) {
      passwordHash = await bcrypt.hash(reset_temporary_password, 10);
      mustReset = true;
    }

    const client = await db.connect();
    try {
    await client.query('BEGIN');
    if (hasProviderNameField && provider_name) await assertProviderNotLinkedElsewhere(client, provider_name, Number(id));
    const result = await client.query(
      `UPDATE "Staff" SET
         role = COALESCE($1, role),
         password_hash = COALESCE($2, password_hash),
         must_reset_password = COALESCE($3, must_reset_password),
         provider_name = CASE WHEN $4 THEN $5 ELSE provider_name END,
         first_name = COALESCE($6, first_name),
         middle_name = COALESCE($7, middle_name),
         last_name = COALESCE($8, last_name),
         preferred_name = CASE WHEN $15 THEN $9 ELSE preferred_name END,
         position = COALESCE($10, position),
         archived = COALESCE($11, archived),
         hire_date = CASE WHEN $13 THEN $14 ELSE hire_date END
       WHERE id = $12
       RETURNING id, username, role, provider_name, must_reset_password, first_name, middle_name, last_name, preferred_name, position, archived, hire_date`,
      [role || null, passwordHash, mustReset, hasProviderNameField, provider_name || null,
       first_name || null, middle_name || null, last_name || null, preferred_name?.trim() || null, position || null,
       typeof archived === 'boolean' ? archived : null, id, hasHireDateField, hire_date || null, hasPreferredNameField]
    );
    const updated = result.rows[0];
    if (!updated) { await client.query('ROLLBACK'); return json(404, { error: 'Staff account not found.' }); }
    const syncedName = await syncLinkedProvider(client, updated);
    if (syncedName) updated.provider_name = syncedName;
    await client.query('COMMIT');
    return json(200, updated);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err instanceof HttpError) return json(err.status, { error: err.message, ...err.extra });
      throw err;
    } finally {
      client.release();
    }
  }

  return null;
}

module.exports = { handle };
