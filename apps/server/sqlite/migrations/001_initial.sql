-- Domain records, canonical event rows, private skill files and owner sessions.
CREATE TABLE IF NOT EXISTS records (
  ordinal INTEGER PRIMARY KEY,
  collection TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL CHECK(json_valid(value)),
  UNIQUE(collection, key)
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE INDEX IF NOT EXISTS events_chat_seq ON events(chat_id, seq);
CREATE INDEX IF NOT EXISTS events_chat_number ON events(chat_id, CAST(substr(event_id, 5) AS INTEGER));
CREATE TABLE IF NOT EXISTS skill_files (
  skill_id TEXT NOT NULL,
  path TEXT NOT NULL,
  bytes BLOB NOT NULL,
  sha256 TEXT NOT NULL,
  mode INTEGER NOT NULL,
  PRIMARY KEY(skill_id, path)
);
CREATE INDEX IF NOT EXISTS auth_access ON records(json_extract(value, '$.accessHash')) WHERE collection = 'authSessions';
PRAGMA user_version = 1;
