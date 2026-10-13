-- Why a canceled OFFSITE session didn't happen (Kieran, Oct 2026): the
-- school or home was closed for a holiday or an emergency, or something
-- else (see the comments). Optional. The billing sheet shows a holiday as H
-- and an emergency closure as Z, like an office closure; other / none = A.
-- Set only while the session is Canceled and offsite (lib/cancelReason.js).
ALTER TABLE "Appointments" ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_cancel_reason_check') THEN
    ALTER TABLE "Appointments" ADD CONSTRAINT appointments_cancel_reason_check
      CHECK (cancel_reason IS NULL OR cancel_reason IN ('holiday', 'emergency', 'other'));
  END IF;
END $$;
