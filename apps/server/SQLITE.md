# SQLite storage and recovery

Manor runs on SQLite and stores its database at `~/.manor/sqlite/manor.db` unless `MANOR_SQLITE_PATH` overrides it. `MANOR_STORE` accepts `sqlite` or `memory`; unset means `sqlite`, and any other value stops startup. Node 22.13 or newer supplies SQLite. The app requires no Docker or Colima service.

The existing launchd service starts the Manor server, which opens SQLite itself. The phone uses `EXPO_PUBLIC_MANOR_WS` and authenticates against that same Mac over HTTPS. A development client needs to reload the updated JavaScript bundle; a packaged phone build needs a new build.

## Storage model

Schema versions live in `sqlite/migrations/` and are applied transactionally before the store opens. Newer database versions are refused rather than rewritten.

Small domain objects live as typed JSON records. Transcript payloads have individual ordered rows and an index per chat. Sidebar metadata and per-turn usage are maintained in the same transaction as each append. Cached transcripts are limited to 32 entries and an estimated 32 MiB. Skill bundle bytes live in SQLite BLOB rows, so the database backup also contains the source skill files.

All store operations complete inside a synchronous SQLite transaction before the runtime receives their result. Mutations and routine claims take `BEGIN IMMEDIATE`; the explicit list of pure reads in `sqliteStore.ts` runs in a deferred, `query_only` snapshot, so another connection holding the write lock never stalls a read. WAL serializes writes while reads proceed. The in-memory test store uses this same implementation. Out-of-process record changes are detected through SQLite's data version, allowing the household to refresh when another process writes.

The desktop shell on the same Mac needs no account; it reads the local access key. A password account, when one exists, is for other devices. Manor issues random device credentials, stores sessions privately, and accepts only that owner. Access expires after an hour, refresh credentials after 30 days, and sign-out revokes the device session. Browsers must use an allowed origin; the phone authenticates without relying on an Origin header. No signup endpoint exists. The account is created or changed on the Mac with `pnpm --filter @manor/server account you@example.com`, which asks for the password, and a running server finds it on the next sign-in. Changing it ends every device session, so no device connects or refreshes again without the new password. A connection that is already open is checked only at its handshake and lasts until it drops or Manor restarts. `account --remove` deletes the account and its sessions.

## Where an older database came from

Manor ran on Postgres until 2026-09-07. The importer that moved that data into SQLite was deleted on 2026-11-10; the git history before that date holds it, with the Postgres schema. A database it produced carries a `verified` mark and opens as before. A database Manor creates itself carries a `fresh` mark. A file with neither is refused, because it is a copy that was never finished.
