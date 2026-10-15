-- When a staff account was archived (Kieran, Oct 2026): the provider
-- directory keeps an archived provider for 60 days after
-- (routes/providers.js ARCHIVED_DIRECTORY_DAYS). Set by a trigger, so every
-- way an account gets archived records it; un-archiving clears it.
ALTER TABLE "Staff" ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Accounts already archived: counted from today (Kieran: they show for 60
-- days from when this goes live). A new clinic's database has none.
UPDATE "Staff" SET archived_at = now() WHERE archived = true AND archived_at IS NULL;

CREATE OR REPLACE FUNCTION staff_archived_at() RETURNS trigger AS $$
BEGIN
  IF NEW.archived IS TRUE AND (TG_OP = 'INSERT' OR OLD.archived IS DISTINCT FROM TRUE) THEN
    NEW.archived_at := now();
  ELSIF NEW.archived IS NOT TRUE THEN
    NEW.archived_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS staff_archived_at ON "Staff";
CREATE TRIGGER staff_archived_at BEFORE INSERT OR UPDATE OF archived ON "Staff"
  FOR EACH ROW EXECUTE FUNCTION staff_archived_at();
