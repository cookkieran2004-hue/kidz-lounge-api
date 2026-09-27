-- Staff roles: staff, reception, admin, developer (lib/roles.js). The Staff
-- table only allowed 'admin' and 'staff'; replace that check. The original
-- check's name isn't fixed, so drop whichever check on "Staff" mentions
-- role. Safe to run more than once.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = '"Staff"'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE "Staff" DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE "Staff" ADD CONSTRAINT staff_role_check CHECK (role IN ('staff', 'reception', 'admin', 'developer'));
