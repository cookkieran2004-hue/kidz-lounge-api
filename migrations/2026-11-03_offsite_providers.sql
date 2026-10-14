-- Offsite providers (Kieran, Oct 2026): providers who never work in the
-- clinic, so have no login and aren't in the Providers list, but whose
-- credentials are tracked on the Credentials page as providers. Added by
-- hand only, never from the app, e.g.:
--   INSERT INTO "OffsiteProviders" (first_name, last_name, position)
--   VALUES ('Jane', 'Smith', 'SLP');
-- The username is made up automatically (OFFSITE- plus 8 characters, so it
-- can't clash with a real one); it only ties their credentials together and
-- is never shown or used to sign in. Set archived = true to hide
-- someone (their credentials are kept). Safe to run more than once.
CREATE TABLE IF NOT EXISTS "OffsiteProviders" (
  username TEXT PRIMARY KEY DEFAULT ('OFFSITE-' || upper(substr(gen_random_uuid()::text, 1, 8))) CHECK (username LIKE 'OFFSITE-%'),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  position TEXT,
  archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP DEFAULT now()
);
