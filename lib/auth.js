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

// Sign-in lockout (HIPAA: guard against password guessing). Counted from
// the audit log's failed sign-ins, so it needs that table; until the
// migration has run there's no lockout. A successful sign-in resets the
// username's count.
const LOCKOUT_MINUTES = 15;
const MAX_FAILURES_PER_USER = 5;
const MAX_FAILURES_PER_IP = 20;
async function lockedOut(db, username, ip) {
  try {
    const { hasTable } = require('./audit');
    if (!(await hasTable(db))) return null;
    const r = await db.query(
      `SELECT
         (SELECT count(*) FROM "AuditLog" f
           WHERE f.action = 'login_failed' AND lower(f.username) = lower($1)
             AND f.at > now() - make_interval(mins => $3) AND coalesce(f.details->>'reason', '') NOT LIKE 'locked%'
             AND f.at > coalesce((SELECT max(s.at) FROM "AuditLog" s WHERE s.action = 'login' AND lower(s.username) = lower($1)), '-infinity'))::int AS by_user,
         (SELECT count(*) FROM "AuditLog" f
           WHERE f.action = 'login_failed' AND $2::text IS NOT NULL AND f.ip = $2
             AND f.at > now() - make_interval(mins => $3) AND coalesce(f.details->>'reason', '') NOT LIKE 'locked%')::int AS by_ip`,
      [username, ip || null, LOCKOUT_MINUTES]
    );
    const { by_user: byUser, by_ip: byIp } = r.rows[0];
    if (byUser >= MAX_FAILURES_PER_USER) return 'username';
    if (byIp >= MAX_FAILURES_PER_IP) return 'address';
    return null;
  } catch (err) {
    console.error('Lockout check failed:', err.message);
    return null;
  }
}

// Every attempt goes in the HIPAA audit log, failures included (with the
// username that was tried and why it failed -- never the password).
async function handleLogin(db, body, meta = {}) {
  const { username, password } = body;
  if (!username || !password) return json(400, { error: 'Username and password are required.' });
  const { record } = require('./audit');
  const logAttempt = (action, status, extra) => record(db, { username: String(username).trim().slice(0, 80), action, resource: 'session', method: 'POST', path: '/auth/login', status, ...meta, ...extra });

  // Lockout: refuse before checking the password once there have been too
  // many recent failures for this username or from this address. Refusals
  // themselves ('locked') don't count, so the lock lifts on time.
  const locked = await lockedOut(db, String(username).trim(), meta.ip);
  if (locked) {
    await logAttempt('login_failed', 429, { details: { reason: `locked (${locked})` } });
    return json(429, { error: `Too many failed sign-in attempts. Wait ${LOCKOUT_MINUTES} minutes and try again, or ask an admin to reset your password.` });
  }

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
