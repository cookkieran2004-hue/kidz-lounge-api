const crypto = require('crypto');
const { json } = require('../lib/http');

// Help desk / support tickets (migrations/2026-09-30_support_tickets.sql).
//
// POST /support/tickets is the one route besides login that works WITHOUT
// signing in (index.js lets it through), so someone who can't sign in can
// still report it. When a valid sign-in is present, the ticket records who
// sent it. Every ticket goes to the Support tickets inbox (the menu item
// with the green count), which only Developers can see -- not to anyone's
// tasks. Same rule as the frontend's supportCount.js.
const canSeeTickets = (user) => user?.role === 'developer';
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

// Random, letters-only ticket references, e.g. "KL-QMZRTA"
// (migrations/2026-10-06_support_ticket_reference.sql). No I or O, so a
// code read over the phone can't be mistaken for 1 or 0. 24^6 is about
// 190 million codes; a clash is retried.
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newTicketReference() {
  let code = '';
  for (let i = 0; i < 6; i++) code += REFERENCE_ALPHABET[crypto.randomInt(REFERENCE_ALPHABET.length)];
  return `KL-${code}`;
}
// Only a "yes" is remembered, so tickets get references as soon as the
// migration has run.
let referenceColumnExists = false;
async function hasReferenceColumn(db) {
  if (referenceColumnExists) return true;
  const r = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'SupportTickets' AND column_name = 'reference'`
  ).catch(() => ({ rows: [] }));
  referenceColumnExists = r.rows.length > 0;
  return referenceColumnExists;
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

  const values = [currentUser?.username || null, contactName, contactInfo, urgency, issue, page];
  if (!(await hasReferenceColumn(db))) {
    const t = await db.query(
      `INSERT INTO "SupportTickets" (submitted_by, contact_name, contact_info, urgency, issue, page)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      values
    );
    return json(201, { id: t.rows[0].id, reference: null });
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const t = await db.query(
        `INSERT INTO "SupportTickets" (submitted_by, contact_name, contact_info, urgency, issue, page, reference)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, reference`,
        [...values, newTicketReference()]
      );
      return json(201, { id: t.rows[0].id, reference: t.rows[0].reference });
    } catch (err) {
      if (err.code !== '23505' || attempt >= 4) throw err; // 23505: that code is taken -- try another
    }
  }
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
      `SELECT * FROM "SupportTickets"
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
    if (!canSeeTickets(currentUser) || !(await hasTable(db))) return json(200, { open: 0 });
    const res = await db.query(`SELECT COUNT(*)::int AS open FROM "SupportTickets" WHERE status = 'open'`);
    return json(200, { open: res.rows[0].open });
  }

  const listRoute = path === '/support/tickets';
  const idRoute = path.match(/^\/support\/tickets\/([^/]+)$/);
  if (!listRoute && !idRoute) return null;
  if (!canSeeTickets(currentUser)) return json(403, { error: 'Only Developers can see support tickets.' });
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
  // Permanently, e.g. spam or a test ticket. Resolving keeps the record;
  // this doesn't (the sender's resolved popup goes with it).
  if (idRoute && method === 'DELETE') {
    const res = await db.query('DELETE FROM "SupportTickets" WHERE id::text = $1 RETURNING id', [idRoute[1]]);
    if (!res.rows[0]) return json(404, { error: 'Ticket not found.' });
    return json(200, { deleted: true });
  }
  return null;
}

module.exports = { handle, submitTicket, newTicketReference };
