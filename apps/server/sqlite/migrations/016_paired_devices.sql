-- Phones and browsers pair with the Mac through a one-time link from Settings → Phone
-- and keep a device token. Only a SHA-256 hash of the token's secret is stored, so a
-- copy of the database cannot open the house. Revoking a device deletes its row, and
-- the push address it registered goes with it, so a removed phone hears nothing more.
CREATE TABLE IF NOT EXISTS paired_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  paired_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  push_token TEXT
) STRICT;

-- Pairing replaces the password account. Its owner row, password hash and device
-- sessions go, so no old credential keeps working; each device pairs once again. The
-- push addresses go too: none is tied to a paired device yet, and a phone that pairs
-- again registers its own.
DELETE FROM records WHERE collection IN ('authOwner', 'authSessions', 'pushTokens');

PRAGMA user_version = 16;
