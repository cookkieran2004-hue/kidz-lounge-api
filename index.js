// Lambda function: handles all data operations for the scheduling app.
// Deployed behind API Gateway (HTTP API). One function, routed by path + method.
//
// This file is deliberately thin: it owns the request lifecycle (EventBridge
// vs HTTP, auth, error handling) and dispatches everything else to the
// per-domain modules in routes/. Shared helpers (db connection, JWT/password
// logic, the recurring-series engine, small utilities) live in lib/.
//
// Environment variables needed (set in the Lambda console):
//   DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
//   JWT_SECRET  <-- long random string, used to sign/verify staff login tokens
//   S3_BUCKET_NAME  <-- bucket for patient documents (Phase 2)
//   AWS_REGION is provided automatically by the Lambda runtime, no need to set it

const jwt = require('jsonwebtoken');

const { getPool } = require('./lib/db');
const { CORS_HEADERS, json } = require('./lib/http');
const { JWT_SECRET, handleLogin, handleSetPassword } = require('./lib/auth');
const { runComplianceCheck } = require('./lib/complianceCheck');
const { runTimeOffAccrual } = require('./lib/timeOffAccrual');
const { runWeeklyPtoAccrual } = require('./lib/ptoAccrual');

const staffRoutes = require('./routes/staff');
const providerRoutes = require('./routes/providers');
const patientRoutes = require('./routes/patients');
const appointmentRoutes = require('./routes/appointments');
const oooRoutes = require('./routes/ooo');
const taskRoutes = require('./routes/tasks');
const chatRoutes = require('./routes/chat');
const documentRoutes = require('./routes/documents');
const timeOffRoutes = require('./routes/timeOff');
const officeHoursRoutes = require('./routes/officeHours');
const supportRoutes = require('./routes/support');

// Tried in this order for every authenticated request; the first module to
// return a non-null response wins. Order between modules doesn't matter for
// correctness here -- every route pattern across all of them is unique --
// but grouping stays roughly domain-by-domain for readability.
const ROUTE_MODULES = [
  staffRoutes, providerRoutes, patientRoutes, appointmentRoutes,
  oooRoutes, taskRoutes, chatRoutes, documentRoutes, timeOffRoutes, officeHoursRoutes, supportRoutes,
];

exports.handler = async (event) => {
  // EventBridge scheduled trigger for the 72-hour chat cleanup job -- not an
  // HTTP request at all, so it's handled completely separately, before any
  // of the API Gateway-shaped routing below even looks at the event.
  if (event.source === 'aws.events') {
    const db = getPool();

    if (event.job === 'compliance-check') {
      await runComplianceCheck(db);
      return { statusCode: 200 };
    }

    if (event.job === 'time-off-accrual') {
      await runTimeOffAccrual(db);
      return { statusCode: 200 };
    }

    // Sundays: PTO earned from the hours worked Monday-Friday.
    if (event.job === 'pto-weekly-accrual') {
      await runWeeklyPtoAccrual(db);
      return { statusCode: 200 };
    }

    // Default (no job field, or job === 'chat-cleanup'): the existing
    // 72-hour chat cleanup, unchanged -- so the current EventBridge rule
    // keeps working exactly as it always has, with no changes needed there.
    const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000);
    const deletedMessages = await db.query('DELETE FROM "ChatMessages" WHERE created_at < $1', [cutoff]);
    // A conversation with no messages left (all aged out) is cleaned up too,
    // so empty shells don't pile up forever -- but only once it's old, so a
    // brand-new conversation awaiting its first message is never touched.
    const deletedConversations = await db.query(
      `DELETE FROM "ChatConversations" c
       WHERE c.created_at < $1
         AND NOT EXISTS (SELECT 1 FROM "ChatMessages" m WHERE m.conversation_id = c.id)`,
      [cutoff]
    );
    console.log(`Chat cleanup: deleted ${deletedMessages.rowCount} messages, ${deletedConversations.rowCount} empty conversations.`);
    return { statusCode: 200 };
  }

  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.rawPath || event.path || '';
  const qs = event.queryStringParameters || {};
  const body = event.body ? JSON.parse(event.body) : {};

  if (method === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  const db = getPool();

  try {
    // ---------- Auth: login is the only public route ----------
    if (path === '/auth/login' && method === 'POST') {
      return await handleLogin(db, body);
    }

    // ---------- Every other route requires a valid staff token ----------
    const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    let currentUser = null;
    if (token) {
      try {
        currentUser = jwt.verify(token, JWT_SECRET);
      } catch (err) {
        currentUser = null;
      }
    }
    // Help & Support: submitting a ticket works without signing in, so
    // someone locked out can still report it (see routes/support.js).
    if (path === '/support/tickets' && method === 'POST') {
      return await supportRoutes.submitTicket({
        db, body, currentUser,
        ip: event.requestContext?.http?.sourceIp || event.requestContext?.identity?.sourceIp || null,
      });
    }

    if (!currentUser) {
      return json(401, { error: 'Unauthorized. Please log in.' });
    }

    // The token is a 12-hour snapshot. Re-read the few fields that decide
    // what someone may see, so an archive, role change, or provider rename
    // takes effect on their very next request instead of hours later
    // (a renamed provider's own schedule used to look empty until they
    // signed in again). One indexed lookup by primary key per request.
    const liveRes = await db.query(
      'SELECT role, provider_name, archived, must_reset_password FROM "Staff" WHERE id=$1',
      [currentUser.id]
    );
    const live = liveRes.rows[0];
    if (!live || live.archived) {
      return json(401, { error: 'This account has been archived and can no longer sign in. Contact an admin.' });
    }
    currentUser = {
      ...currentUser,
      role: live.role,
      providerName: live.provider_name || null,
      mustResetPassword: !!live.must_reset_password,
    };

    // A staff member who hasn't completed their forced password reset can only
    // reach /auth/me (to check their own status) and /auth/set-password.
    if (currentUser.mustResetPassword && path !== '/auth/set-password' && path !== '/auth/me') {
      return json(403, { error: 'You must set a new password before continuing.', mustResetPassword: true });
    }

    if (path === '/auth/me' && method === 'GET') {
      return json(200, {
        id: currentUser.id,
        username: currentUser.username,
        role: currentUser.role,
        mustResetPassword: currentUser.mustResetPassword,
        providerName: currentUser.providerName || null,
        firstName: currentUser.firstName || null, middleName: currentUser.middleName || null, lastName: currentUser.lastName || null,
        preferredName: currentUser.preferredName || null, position: currentUser.position || null,
      });
    }

    if (path === '/auth/set-password' && method === 'POST') {
      return await handleSetPassword(db, currentUser, body);
    }

    const ctx = { path, method, qs, body, db, currentUser, event };
    for (const routeModule of ROUTE_MODULES) {
      const result = await routeModule.handle(ctx);
      if (result) return result;
    }

    return json(404, { error: 'Not found', path, method });
  } catch (err) {
    console.error(err);
    return json(500, { error: err.message });
  }
};
