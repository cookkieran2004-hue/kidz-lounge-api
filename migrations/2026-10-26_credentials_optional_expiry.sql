-- Staff credentials may have no expiration date (Kieran, Oct 2026: some
-- never expire). Safe to run more than once.
ALTER TABLE "StaffCredentials" ALTER COLUMN expiration_date DROP NOT NULL;
