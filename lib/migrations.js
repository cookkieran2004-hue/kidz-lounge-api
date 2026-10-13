// Runs the files in migrations/ that this database hasn't had yet, in
// filename (= date) order, and records each one in "SchemaMigrations" so it
// never runs twice. Invoked by the deploy pipeline (and by hand) with
//   aws lambda invoke --function-name kidz-lounge-api \
//     --payload '{"source":"deploy","job":"migrate"}' --cli-binary-format raw-in-base64-out out.json
// Add "dryRun": true to only list what would run.
//
// A database that has never been through the runner has an empty
// SchemaMigrations, and running everything there would re-run one-time data
// fixes (2026-10-05_clear_salaried_pto.sql zeroes salaried PTO). So the
// runner refuses until the files already in effect are recorded once,
// without running them:
//   {"source":"deploy","job":"migrate","markExistingUpTo":"2026-10-31_staff_dob.sql"}
// Production: up to the newest file it already has. A new clinic: up to
// the file its baseline schema was taken after (clinic-platform/schema).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const FILE_PATTERN = /^\d{4}-\d{2}-\d{2}_[a-z0-9_]+\.sql$/;
// Any fixed number works; it only has to be the same for every run, so two
// runs (a deploy and a manual invoke) can't apply the same file at once.
const LOCK_KEY = 72064;

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS "SchemaMigrations" (
    filename   TEXT PRIMARY KEY,
    checksum   TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    how        TEXT NOT NULL CHECK (how IN ('ran', 'marked'))
  )`;

function migrationFiles(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter(f => FILE_PATTERN.test(f)).sort();
}

const checksumOf = (sql) => crypto.createHash('sha256').update(sql).digest('hex');

// The runner wraps each file in its own transaction, so a file must not
// open or close one itself: its COMMIT would end ours early and leave the
// file half-recorded. (BEGIN inside a DO $$ ... $$ block is fine: it has no
// semicolon after it.)
const hasOwnTransaction = (sql) => /^\s*(BEGIN|START TRANSACTION|COMMIT|ROLLBACK)\s*;/im.test(sql);

async function runMigrations(db, { dryRun = false, markExistingUpTo = null, dir = MIGRATIONS_DIR } = {}) {
  const client = await db.connect();
  try {
    const { rows: [lock] } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (!lock.ok) return { ok: false, error: 'Another migration run is in progress. Try again in a minute.' };
    try {
      await client.query(TABLE_SQL);
      const { rows } = await client.query('SELECT filename, checksum FROM "SchemaMigrations"');
      const applied = new Map(rows.map(r => [r.filename, r.checksum]));
      const files = migrationFiles(dir);
      const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

      if (markExistingUpTo) {
        if (applied.size) return { ok: false, error: 'Existing migrations are already recorded; marking is only for a database the runner has never seen.' };
        if (!files.includes(markExistingUpTo)) return { ok: false, error: `${markExistingUpTo} isn't in migrations/.` };
        const toMark = files.filter(f => f <= markExistingUpTo);
        if (!dryRun) {
          await client.query('BEGIN');
          for (const f of toMark) {
            await client.query('INSERT INTO "SchemaMigrations" (filename, checksum, how) VALUES ($1, $2, $3)', [f, checksumOf(read(f)), 'marked']);
          }
          await client.query('COMMIT');
        }
        return { ok: true, dryRun, marked: toMark, pending: files.filter(f => f > markExistingUpTo) };
      }

      if (!applied.size) {
        return { ok: false, error: 'This database has no migrations recorded yet. Record the ones already in effect first (markExistingUpTo); see lib/migrations.js.' };
      }

      // A recorded file whose text has changed since: reported, never re-run.
      const changed = files.filter(f => applied.has(f) && applied.get(f) !== checksumOf(read(f)));
      const pending = files.filter(f => !applied.has(f));
      if (dryRun) return { ok: true, dryRun, pending, changed };

      const ran = [];
      for (const f of pending) {
        const sql = read(f);
        if (hasOwnTransaction(sql)) {
          return { ok: false, ran, changed, failed: f, error: `${f} has its own BEGIN/COMMIT. Remove them: the runner wraps each file in a transaction.` };
        }
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('INSERT INTO "SchemaMigrations" (filename, checksum, how) VALUES ($1, $2, $3)', [f, checksumOf(sql), 'ran']);
          await client.query('COMMIT');
          ran.push(f);
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          // Stop here: later files may depend on this one.
          return { ok: false, ran, changed, failed: f, error: err.message };
        }
      }
      return { ok: true, ran, changed };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

module.exports = { runMigrations, migrationFiles, hasOwnTransaction, checksumOf };
