-- HIPAA audit log (lib/audit.js): who viewed, created, changed, deleted or
-- downloaded patient information, and every sign-in attempt. Kept forever
-- and append-only: the trigger below rejects any UPDATE, DELETE or TRUNCATE,
-- so not even the app can alter the history. Safe to run more than once.
CREATE TABLE IF NOT EXISTS "AuditLog" (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  username TEXT,                 -- who (the attempted username for a failed sign-in)
  role TEXT,
  action TEXT NOT NULL,          -- view | search | create | update | delete | download | upload | login | login_failed | logout | password_set | export
  resource TEXT NOT NULL,        -- e.g. 'patient chart', 'appointment', 'document', 'session'
  patient_id TEXT,
  patient_name TEXT,
  record_id TEXT,                -- the appointment / document / entry acted on
  method TEXT,
  path TEXT,
  status INT,                    -- HTTP status of the response (403s are attempts that were refused)
  ip TEXT,
  user_agent TEXT,
  details JSONB                  -- e.g. which fields changed (names only, never values), search text, filters
);
CREATE INDEX IF NOT EXISTS audit_log_at ON "AuditLog" (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_user ON "AuditLog" (username, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_patient ON "AuditLog" (lower(patient_name), at DESC);

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'The audit log is append-only: entries cannot be changed or deleted.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update_delete ON "AuditLog";
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
DROP TRIGGER IF EXISTS audit_log_no_truncate ON "AuditLog";
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
