-- Support tickets get a random, letters-only reference ("KL-QMZRTA") instead
-- of showing their sequential id. New tickets get one from the API
-- (newTicketReference in routes/support.js); this backfills existing ones
-- with the same alphabet -- no I or O, so a code read over the phone can't
-- be mistaken for 1 or 0. Safe to run more than once.
ALTER TABLE "SupportTickets" ADD COLUMN IF NOT EXISTS reference TEXT;

DO $$
DECLARE
  alphabet CONSTANT TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  t RECORD;
  code TEXT;
BEGIN
  FOR t IN SELECT id FROM "SupportTickets" WHERE reference IS NULL LOOP
    LOOP
      code := 'KL-';
      FOR i IN 1..6 LOOP
        code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
      END LOOP;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "SupportTickets" WHERE reference = code);
    END LOOP;
    UPDATE "SupportTickets" SET reference = code WHERE id = t.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_reference ON "SupportTickets" (reference);
