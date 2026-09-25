-- Indexes for the Schedule page's reads (lib/recurring.js): every day or
-- range view looks up real rows by date, and exception rows by the series
-- they belong to. Without these, each of those is a full table scan that
-- gets slower as the appointment history grows. Safe to run more than once.
CREATE INDEX IF NOT EXISTS appointments_date ON "Appointments" (appointment_date);
CREATE INDEX IF NOT EXISTS appointments_series_exception ON "Appointments" (exception_of_series_id, exception_occurrence_date);
CREATE INDEX IF NOT EXISTS out_of_office_date ON "Out_of_Office" (ooo_date);
CREATE INDEX IF NOT EXISTS out_of_office_series_exception ON "Out_of_Office" (exception_of_series_id, exception_occurrence_date);
