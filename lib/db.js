// Shared Postgres connection. Every route module imports getPool() from
// here rather than creating its own -- the pool is created once and reused
// across invocations (Lambda keeps the process warm between calls), which
// keeps this fast and cheap.

const { Pool, types } = require('pg');

// By default node-postgres converts Postgres "date" columns into JS Date
// objects, which then serialize to full ISO timestamps (e.g.
// "2026-08-27T00:00:00.000Z") when returned as JSON. Every date field in
// this app (appointment_date, ooo_date, patient DOB, IFSP/RX dates) is
// treated as a plain "YYYY-MM-DD" string on the frontend, so leaving the
// default behavior in place corrupts every date the API returns. OID 1082
// is Postgres's "date" type -- this tells the driver to hand back the raw
// string as stored, with no Date-object conversion. This is a process-wide
// setting on the pg module itself, so it only needs to run once here.
types.setTypeParser(1082, (val) => val);

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
  }
  return pool;
}

module.exports = { getPool };
