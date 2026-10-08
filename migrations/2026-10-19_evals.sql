-- Evaluations (Oct 2026). An eval is a one-time appointment booked from the
-- patient chart, flagged is_eval: billing shows it as E. Safe to run more
-- than once.
ALTER TABLE "Appointments" ADD COLUMN IF NOT EXISTS is_eval BOOLEAN NOT NULL DEFAULT false;
