-- Date indexes for the Schedule page's reads (lib/recurring.js): every day
-- or range view looks up real rows by date. The series-exception lookups
-- already have indexes (appointments_exception_idx, idx_ooo_exception_lookup
-- from the original recurring-series scripts). Safe to run more than once.
CREATE INDEX IF NOT EXISTS appointments_date ON "Appointments" (appointment_date);
CREATE INDEX IF NOT EXISTS out_of_office_date ON "Out_of_Office" (ooo_date);
