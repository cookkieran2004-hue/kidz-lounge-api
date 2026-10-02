const { json, CORS_HEADERS } = require('../lib/http');
const { canViewAuditLog } = require('../lib/roles');
const { hasTable } = require('../lib/audit');

// The HIPAA audit log viewer (lib/audit.js writes it). Developers only.
//   GET /audit-log?user=&patient=&action=&from=YYYY-MM-DD&to=YYYY-MM-DD&before=<id>&limit=
//       newest first; `before` pages back through older entries
//   GET /audit-log?format=csv&...   the same filters as a CSV download

const COLUMNS = ['at', 'username', 'role', 'action', 'resource', 'patient_name', 'patient_id', 'record_id', 'status', 'ip', 'method', 'path', 'user_agent', 'details'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function handle({ path, method, qs, db, currentUser, event }) {
  if (path !== '/audit-log' || method !== 'GET') return null;
  if (!canViewAuditLog(currentUser)) return json(403, { error: 'Only Developers can view the audit log.' });
  if (!(await hasTable(db))) return json(200, { setup_needed: true, entries: [] });

  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (qs.user) add('username ILIKE ?', `%${qs.user.trim()}%`);
  if (qs.patient) add('patient_name ILIKE ?', `%${qs.patient.trim()}%`);
  if (qs.action) add('action = ?', qs.action);
  if (qs.from && DATE_RE.test(qs.from)) add('at >= ?::date', qs.from);
  if (qs.to && DATE_RE.test(qs.to)) add(`at < (?::date + interval '1 day')`, qs.to);
  const csv = qs.format === 'csv';
  if (!csv && qs.before && /^\d+$/.test(qs.before)) add('id < ?', qs.before);
  const limit = csv ? 50000 : Math.min(Number(qs.limit) || 100, 500);
  params.push(limit);
  const res = await db.query(
    `SELECT id, ${COLUMNS.join(', ')} FROM "AuditLog" ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY id DESC LIMIT $${params.length}`,
    params
  );

  if (csv) {
    const lines = [COLUMNS.join(','), ...res.rows.map(r => COLUMNS.map(c => csvCell(c === 'at' ? new Date(r.at).toISOString() : r[c])).join(','))];
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="audit-log.csv"' },
      body: lines.join('\n'),
    };
  }
  return json(200, { entries: res.rows, more: res.rows.length === limit });
}

module.exports = { handle };
