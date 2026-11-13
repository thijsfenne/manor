-- Per-run usage now records the provider and the cache split, which the Usage view
-- prices from. The derived rows are dropped here and refolded from the transcript by
-- `openSqlite` in the same transaction; the events themselves are not touched.
DELETE FROM records WHERE collection = 'usageRuns';

PRAGMA user_version = 9;
