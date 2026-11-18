# SQLite storage and recovery

Manor runs on SQLite and stores its database at `~/.manor/sqlite/manor.db` unless `MANOR_SQLITE_PATH` overrides it. `MANOR_STORE` accepts `sqlite` or `memory`; unset means `sqlite`, and any other value stops startup. Node 22.13 or newer supplies SQLite. The app requires no Docker or Colima service.

The existing launchd service starts the Manor server, which opens SQLite itself. The phone pairs with that same Mac through Settings → Phone and reaches it over Tailscale HTTPS. A development client needs to reload the updated JavaScript bundle; a packaged phone build needs a new build.

## Storage model

Schema versions live in `sqlite/migrations/` and are applied transactionally before the store opens. Newer database versions are refused rather than rewritten.

Small domain objects live as typed JSON records. Transcript payloads have individual ordered rows and an index per chat. Sidebar metadata and per-turn usage are maintained in the same transaction as each append. Cached transcripts are limited to 32 entries and an estimated 32 MiB. Skill bundle bytes live in SQLite BLOB rows, so the database backup also contains the source skill files.

All store operations complete inside a synchronous SQLite transaction before the runtime receives their result. Mutations and routine claims take `BEGIN IMMEDIATE`; the explicit list of pure reads in `sqliteStore.ts` runs in a deferred, `query_only` snapshot, so another connection holding the write lock never stalls a read. WAL serializes writes while reads proceed. The in-memory test store uses this same implementation. Out-of-process record changes are detected through SQLite's data version, allowing the household to refresh when another process writes.

The desktop shell on the same Mac needs no pairing; it reads the local access key. Every other device, a phone app or a browser, pairs once through a one-time link from Settings → Phone. The link holds a random code in its fragment, so it never reaches a request log; the server keeps only the code's hash, in memory, for 10 minutes and one use. Redeeming it at `POST /pair` returns a device token `<device id>.<secret>`, and `paired_devices` stores only a SHA-256 hash of the secret, compared in constant time. The token opens the WebSocket and `GET /pair/device`, which tells a device whether the Mac still knows it. Revoking a device in Settings deletes its row, drops the push address it registered and closes its open connection at once; `DELETE /pair/device` does the same from the device. Browsers must use an allowed origin; the phone sends none. Migration 016 removed the earlier password account and its sessions, so each device pairs once again.

## Where an older database came from

Manor ran on Postgres until 2026-09-07. The importer that moved that data into SQLite was deleted on 2026-11-10; the git history before that date holds it, with the Postgres schema. A database it produced carries a `verified` mark and opens as before. A database Manor creates itself carries a `fresh` mark. A file with neither is refused, because it is a copy that was never finished.
