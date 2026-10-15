-- Authorizations entered by hand on the chart's Services tab (the "ei"
-- feature; Kieran, Oct 2026), kept with the ones imported from EI-Hub so
-- billing uses one list. source = 'hand' for those; NULL = imported. An
-- import of the same auth # replaces it and clears source (EI-Hub is the
-- record).
ALTER TABLE "EiAuthorizations" ADD COLUMN IF NOT EXISTS source TEXT;
