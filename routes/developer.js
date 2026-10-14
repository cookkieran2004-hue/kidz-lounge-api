const fs = require('fs');
const path = require('path');
const { json } = require('../lib/http');
const { migrationFiles } = require('../lib/migrations');
const audit = require('../lib/audit');

// Central view (Oct 2026): the PedsDesk Demo site's /central page asks every
// practice's API for its health, its open support tickets, the developer's
// chats and the developer's tasks. Tickets, chats and tasks use the routes
// they always have; this file only adds the health check. Each practice
// answers for itself -- nothing is stored centrally.
//
//   GET /developer/health   (Developers only)
const isDeveloper = (user) => user?.role === 'developer';

// Written into the package by .github/workflows/lambda-deploy.yml: the commit
// this practice runs and when it was deployed. Missing on code deployed by
// hand, which the page shows as "unknown".
let buildInfo;
function readBuildInfo() {
  if (buildInfo === undefined) {
    try { buildInfo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'build.json'), 'utf8')); } catch { buildInfo = null; }
  }
  return buildInfo;
}

// Each check stands alone: a missing table or a failed query shows as null
// on the page instead of hiding the whole health card.
const tryQuery = (db, sql, params) => db.query(sql, params).then(r => r.rows).catch(() => null);

async function handle({ path: p, method, db, currentUser }) {
  if (p !== '/developer/health' || method !== 'GET') return null;
  if (!isDeveloper(currentUser)) return json(403, { error: 'Only Developers can see practice health.' });

  const started = Date.now();
  await db.query('SELECT 1');
  const dbMs = Date.now() - started;

  const files = migrationFiles();
  const [applied, staff, failed, tickets] = await Promise.all([
    tryQuery(db, 'SELECT filename, applied_at FROM "SchemaMigrations" ORDER BY filename'),
    tryQuery(db, `SELECT count(*) FILTER (WHERE NOT archived)::int AS active,
                         count(*) FILTER (WHERE NOT archived AND last_login > now() - interval '24 hours')::int AS signed_in_24h,
                         max(last_login) AS last_sign_in
                  FROM "Staff"`),
    audit.hasTable(db).then(ok => ok
      ? tryQuery(db, `SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'login_failed' AND at > now() - interval '24 hours'`)
      : null),
    tryQuery(db, `SELECT count(*) FILTER (WHERE status = 'open')::int AS open FROM "SupportTickets"`),
  ]);
  const appliedNames = applied ? new Set(applied.map(r => r.filename)) : null;
  const lastRan = applied?.length ? applied.reduce((a, b) => (new Date(b.applied_at) > new Date(a.applied_at) ? b : a)) : null;

  return json(200, {
    checked_at: new Date().toISOString(),
    db_ms: dbMs,
    node: process.version,
    build: readBuildInfo(),
    migrations: {
      newest_in_code: files[files.length - 1] || null,
      // Files in this deploy the database hasn't had: the pipeline runs them
      // right after deploying, so anything here means that step failed.
      pending: appliedNames ? files.filter(f => !appliedNames.has(f)) : null,
      last_applied: lastRan ? { filename: lastRan.filename, at: lastRan.applied_at } : null,
    },
    staff: staff?.[0] || null,
    failed_sign_ins_24h: failed?.[0]?.n ?? null,
    open_tickets: tickets?.[0]?.open ?? null,
  });
}

module.exports = { handle };
