-- Staff date of birth (Kieran, Oct 2026): on My profile (editable by the
-- person and by Admins on their staff profile), shown as month and day in
-- the Provider directory. Safe to run more than once.
ALTER TABLE "Staff" ADD COLUMN IF NOT EXISTS date_of_birth DATE;
