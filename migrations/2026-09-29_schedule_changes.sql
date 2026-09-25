-- Scheduled changes to a provider's contracted (usual) weekly hours.
-- ProviderUsualSchedule stays as the provider's STANDING hours. Each change
-- here has a start date, an optional end date (temporary, e.g. summer
-- hours), and its own weekly hours (a change with no days = not contracted
-- at all during it). On any date, the change that started most recently
-- among those covering that date applies; with none, the standing hours do.
-- Safe to run more than once.
CREATE TABLE IF NOT EXISTS "ProviderScheduleChanges" (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS provider_schedule_changes_provider ON "ProviderScheduleChanges" (provider, start_date);

CREATE TABLE IF NOT EXISTS "ProviderScheduleChangeDays" (
  change_id BIGINT NOT NULL REFERENCES "ProviderScheduleChanges"(id) ON DELETE CASCADE,
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  PRIMARY KEY (change_id, weekday)
);
