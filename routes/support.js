const { json } = require('../lib/http');

// Help desk / support tickets (migrations/2026-09-30_support_tickets.sql).
//
// POST /support/tickets is the one route besides login that works WITHOUT
// signing in (index.js lets it through), so someone who can't sign in can
// still report it. When a valid sign-in is present, the ticket records who
// sent it. Every ticket goes to SUPPORT_OWNER's Support tickets inbox (the
// menu item with the green count) -- not to their tasks.
const SUPPORT_OWNER = 'KJC135';
const URGENCIES = ['Low', 'Medium', 'High', 'Urgent'];
const LIMITS = { issue: 5000, contact_name: 120, contact_info: 300, page: 300 };

// Basic protection for a public form: an invisible "website" field that
// only bots fill in, and at most 5 tickets per 10 minutes from one address
// (per running server instance -- light, not a firewall).
const recent = new Map();
function tooMany(ip) {
  if (!ip) return false;
  const now = Date.now();
  const list = (recent.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  if (list.length >= 5) { recent.set(ip, list); return true; }
  list.push(now);
  recent.set(ip, list);
  return false;
}

// notice_seen_at (migrations/2026-10-01_support_ticket_notices.sql).
let noticeColumnPromise = null;
function hasNoticeColumn(db) {
  if (!noticeColumnPromise) {
    noticeColumnPromise = db.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'SupportTickets' AND column_name = 'notice_seen_at'`
    ).then(r => r.rows.length > 0).catch(() => false);
  }
  return noticeColumnPromise;
}

let tablePromise = null;
function hasTable(db) {
  if (!tablePromise) {
    tablePromise = db.query(`SELECT to_regclass('"SupportTickets"') IS NOT NULL AS ok`)
      .then(r => !!r.rows[0]?.ok).catch(() => false);
  }
  return tablePromise;
}

async function submitTicket({ db, body, currentUser, ip }) {
  if (!(await hasTable(db))) return json(503, { error: 'The help desk is not set up yet. Please contact the office directly.' });
  if (body.website) return json(201, { id: null }); // bot: pretend it worked
  if (tooMany(ip)) return json(429, { error: 'Too many tickets sent from here in a short time. Please wait a few minutes and try again.' });

  const clean = (v, max) => String(v ?? '').trim().slice(0, max);
  const issue = clean(body.issue, LIMITS.issue);
  const urgency = URGENCIES.includes(body.urgency) ? body.urgency : null;
  const contactName = clean(body.contact_name, LIMITS.contact_name);
  const contactInfo = clean(body.contact_info, LIMITS.contact_info);
  const page = clean(body.page, LIMITS.page) || null;
  if (!issue) return json(400, { error: 'Please describe the issue.' });
  if (!urgency) return json(400, { error: 'Please choose an urgency level.' });
  if (!contactName) return json(400, { error: 'Please enter your name.' });
  if (!contactInfo) return json(400, { error: 'Please enter an email or phone number so we can reach you.' });

  const t = await db.query(
    `INSERT INTO "SupportTickets" (submitted_by, contact_name, contact_info, urgency, issue, page)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [currentUser?.username || null, contactName, contactInfo, urgency, issue, page]
  );
  return json(201, { id: t.rows[0].id });
}

// Signed-in routes.
// Anyone: their own "your ticket was resolved" popups --
//   GET /support/my-notices             -> resolved tickets they sent and haven't dismissed
//   PUT /support/my-notices/:id/seen    -> dismiss one
// The support owner only: the inbox --
//   GET /support/tickets/open-count     -> { open } for the green menu badge
//   GET /support/tickets?status=open|resolved|all
//   PUT /support/tickets/:id   <- { status: 'open'|'resolved', resolution_note? }
async function handle({ path, method, qs, body, db, currentUser }) {
  if (path === '/support/my-notices' && method === 'GET') {
    if (!(await hasTable(db)) || !(await hasNoticeColumn(db))) return json(200, []);
    const res = await db.query(
      `SELECT id, issue, urgency, created_at, resolved_at, resolution_note FROM "SupportTickets"
       WHERE submitted_by = $1 AND status = 'resolved' AND notice_seen_at IS NULL
         AND resolved_by IS DISTINCT FROM $1
       ORDER BY resolved_at`,
      [currentUser.username]
    );
    return json(200, res.rows);
  }
  const seenRoute = path.match(/^\/support\/my-notices\/([^/]+)\/seen$/);
  if (seenRoute && method === 'PUT') {
    if (!(await hasTable(db)) || !(await hasNoticeColumn(db))) return json(200, { ok: true });
    await db.query(
      'UPDATE "SupportTickets" SET notice_seen_at = now() WHERE id::text = $1 AND submitted_by = $2',
      [seenRoute[1], currentUser.username]
    );
    return json(200, { ok: true });
  }

  if (path === '/support/tickets/open-count' && method === 'GET') {
    if (currentUser.username !== SUPPORT_OWNER || !(await hasTable(db))) return json(200, { open: 0 });
    const res = await db.query(`SELECT COUNT(*)::int AS open FROM "SupportTickets" WHERE status = 'open'`);
    return json(200, { open: res.rows[0].open });
  }

  const listRoute = path === '/support/tickets';
  const idRoute = path.match(/^\/support\/tickets\/([^/]+)$/);
  if (!listRoute && !idRoute) return null;
  if (currentUser.username !== SUPPORT_OWNER) return json(403, { error: 'Only the support desk can see tickets.' });
  if (!(await hasTable(db))) return listRoute && method === 'GET' ? json(200, []) : json(503, { error: 'Run migrations/2026-09-30_support_tickets.sql first.' });

  if (listRoute && method === 'GET') {
    const status = ['open', 'resolved'].includes(qs.status) ? qs.status : null;
    const res = await db.query(
      `SELECT * FROM "SupportTickets" ${status ? 'WHERE status=$1' : ''}
       ORDER BY (status='open') DESC,
                CASE urgency WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
                created_at DESC`,
      status ? [status] : []
    );
    return json(200, res.rows);
  }
  if (idRoute && method === 'PUT') {
    const status = body.status;
    if (!['open', 'resolved'].includes(status)) return json(400, { error: 'status must be open or resolved.' });
    const res = await db.query(
      `UPDATE "SupportTickets" SET status=$1,
         resolved_at = CASE WHEN $1 = 'resolved' THEN now() ELSE NULL END,
         resolved_by = CASE WHEN $1 = 'resolved' THEN $2 ELSE NULL END,
         resolution_note = CASE WHEN $1 = 'resolved' THEN $3 ELSE NULL END
       WHERE id::text = $4 RETURNING *`,
      [status, currentUser.username, (body.resolution_note || '').trim() || null, idRoute[1]]
    );
    if (!res.rows[0]) return json(404, { error: 'Ticket not found.' });
    // Each resolve shows the sender a fresh popup (if they were signed in).
    if (status === 'resolved' && await hasNoticeColumn(db)) {
      await db.query('UPDATE "SupportTickets" SET notice_seen_at = NULL WHERE id = $1', [res.rows[0].id]);
    }
    return json(200, res.rows[0]);
  }
  return null;
}

module.exports = { handle, submitTicket, SUPPORT_OWNER };
