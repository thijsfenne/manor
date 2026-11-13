import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** The file's name in the data directory; `apps/desktop/src/localAccess.ts` reads the same one. */
export const LOCAL_ACCESS_FILE = 'local-access-token'

const usable = (value: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(value)

/**
 * The key for whoever sits at this Mac. It lives in the data directory, readable by
 * the same macOS user who can already read the database beside it, so the desktop
 * shell opens the house without a password. It stays the same across restarts, and
 * deleting the file is how to change the lock. A client on another device cannot
 * read it and uses the password account instead.
 */
export function ensureLocalAccessToken(file: string): string {
  try {
    const held = readFileSync(file, 'utf8').trim()
    if (usable(held)) {
      chmodSync(file, 0o600)
      return held
    }
  } catch {
    // No file yet, or an unreadable one: write a new key below.
  }
  const token = randomBytes(32).toString('base64url')
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  return token
}

/** Compares in constant time, so a wrong guess learns nothing from how fast it failed. */
export function isLocalAccessToken(candidate: string, token: string): boolean {
  const given = Buffer.from(candidate)
  const held = Buffer.from(token)
  return given.length === held.length && timingSafeEqual(given, held)
}
