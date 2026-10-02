const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { json } = require('./http');

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_LIFETIME = '12h';

function signToken(staff) {
  return jwt.sign(
    {
      id: staff.id, username: staff.username, role: staff.role, mustResetPassword: staff.must_reset_password,
      providerName: staff.provider_name || null,
      firstName: staff.first_name || null, middleName: staff.middle_name || null, lastName: staff.last_name || null,
      preferredName: staff.preferred_name || null, position: staff.position || null,
    },
    JWT_SECRET,
    { expiresIn: TOKEN_LIFETIME }
  );
}

// Every attempt goes in the HIPAA audit log, failures included (with the
// username that was tried and why it failed -- never the password).
async function handleLogin(db, body, meta = {}) {
  const { username, password } = body;
  if (!username || !password) return json(400, { error: 'Username and password are required.' });
  const { record } = require('./audit');
  const logAttempt = (action, status, extra) => record(db, { username: String(username).trim().slice(0, 80), action, resource: 'session', method: 'POST', path: '/auth/login', status, ...meta, ...extra });

  const result = await db.query('SELECT * FROM "Staff" WHERE username=$1', [username.trim()]);
  const staff = result.rows[0];
  // Same generic error whether the username doesn't exist or the password is
  // wrong -- don't reveal which one it was.
  if (!staff) {
    await logAttempt('login_failed', 401, { details: { reason: 'unknown username' } });
    return json(401, { error: 'Invalid username or password.' });
  }

  const valid = await bcrypt.compare(password, staff.password_hash);
  if (!valid) {
    await logAttempt('login_failed', 401, { role: staff.role, details: { reason: 'wrong password' } });
    return json(401, { error: 'Invalid username or password.' });
  }

  if (staff.archived) {
    await logAttempt('login_failed', 403, { role: staff.role, details: { reason: 'archived account' } });
    return json(403, { error: 'This account has been archived and can no longer sign in. Contact an admin.' });
  }

  await db.query('UPDATE "Staff" SET last_login=now() WHERE id=$1', [staff.id]);
  await logAttempt('login', 200, { role: staff.role });

  return json(200, {
    token: signToken(staff),
    username: staff.username,
    role: staff.role,
    mustResetPassword: staff.must_reset_password,
    providerName: staff.provider_name || null,
    firstName: staff.first_name || null, middleName: staff.middle_name || null, lastName: staff.last_name || null,
    preferredName: staff.preferred_name || null, position: staff.position || null,
  });
}

async function handleSetPassword(db, currentUser, body) {
  const { new_password } = body;
  if (!new_password || new_password.length < 8) {
    return json(400, { error: 'New password must be at least 8 characters.' });
  }
  const passwordHash = await bcrypt.hash(new_password, 10);
  await db.query(
    'UPDATE "Staff" SET password_hash=$1, must_reset_password=false WHERE id=$2',
    [passwordHash, currentUser.id]
  );
  const updated = {
    id: currentUser.id, username: currentUser.username, role: currentUser.role,
    must_reset_password: false, provider_name: currentUser.providerName || null,
    first_name: currentUser.firstName || null, middle_name: currentUser.middleName || null, last_name: currentUser.lastName || null,
    preferred_name: currentUser.preferredName || null, position: currentUser.position || null,
  };
  return json(200, {
    token: signToken(updated),
    username: updated.username,
    role: updated.role,
    mustResetPassword: false,
    providerName: updated.provider_name,
    firstName: updated.first_name, middleName: updated.middle_name, lastName: updated.last_name,
    preferredName: updated.preferred_name, position: updated.position,
  });
}

// Requires the CURRENTLY LOGGED-IN admin to re-enter their own password
// before a sensitive staff-account change (create/edit/delete another
// account) takes effect. Checked against their own stored hash, not the
// target account's -- this isn't a login, it's a re-confirmation.
async function verifyAdminPassword(db, currentUser, providedPassword) {
  if (!providedPassword) return false;
  const result = await db.query('SELECT password_hash FROM "Staff" WHERE id=$1', [currentUser.id]);
  const row = result.rows[0];
  if (!row) return false;
  return bcrypt.compare(providedPassword, row.password_hash);
}

module.exports = { JWT_SECRET, TOKEN_LIFETIME, signToken, handleLogin, handleSetPassword, verifyAdminPassword };
