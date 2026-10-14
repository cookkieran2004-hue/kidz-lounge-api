-- Why a child missed a session (Oct 2026; lib/absenceReason.js). Asked when
-- an EI session is Canceled or No Show: NYS's make-up policy lets missed EI
-- sessions be made up for illness and other reasons, but not for a family
-- vacation, so the mandates view needs to tell them apart. NULL = not asked
-- or not known (treated as eligible for a make-up). Safe to run twice.
ALTER TABLE "Appointments" ADD COLUMN IF NOT EXISTS absence_reason TEXT;
DO $$ BEGIN
  ALTER TABLE "Appointments" ADD CONSTRAINT appointments_absence_reason_check
    CHECK (absence_reason IS NULL OR absence_reason IN ('illness', 'vacation', 'other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
