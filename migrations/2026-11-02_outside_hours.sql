-- "Outside hours" (Kieran, Oct 2026): a provider's extra offsite session
-- (home, school or center) outside contracted and office hours, on a
-- random schedule. Any time, any day; shown in an "Outside hours" strip
-- rather than on the 8-6 grid. Only ever true for an offsite session
-- (lib/outsideHours.js). On the series too, so a weekly one keeps it.
ALTER TABLE "Appointments" ADD COLUMN IF NOT EXISTS outside_hours BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RecurringSeries" ADD COLUMN IF NOT EXISTS outside_hours BOOLEAN NOT NULL DEFAULT false;
