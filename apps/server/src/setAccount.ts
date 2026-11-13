// First, on purpose: the settings files name the database this account goes into.
import './envFiles.js'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { resolveStoreConfig } from './config.js'
import { accountEmail, MIN_PASSWORD_LENGTH, removeOwnerAccounts, setOwnerAccount } from './localAuth.js'

/**
 * Creates or changes the password account that a device other than this Mac signs in
 * with, such as the phone companion. The desktop app needs none.
 *
 *   pnpm --filter @manor/server account you@example.com
 *   pnpm --filter @manor/server account --remove
 *
 * The password is asked for and never echoed, taken as an argument or logged. Piped
 * input is read as one line, for a password manager. Safe while the server runs: it
 * opens the database Manor already made, touches only the account rows and never
 * migrates, and the next sign-in finds the account.
 */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin
    let value = ''
    const finish = () => {
      input.setRawMode(false)
      input.pause()
      input.off('data', onData)
      process.stdout.write('\n')
    }
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') { finish(); resolve(value); return }
        if (char === '\u0003' || char === '\u0004') { finish(); reject(new Error('cancelled, nothing was changed')); return }
        // An arrow or Delete key arrives as one chunk that starts with Escape: none of it is the password.
        if (char === '\u001b') return
        // By code point, so deleting an emoji does not leave half of it behind.
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('')
        else if (char >= ' ') value += char
      }
    }
    process.stdout.write(prompt)
    input.setRawMode(true)
    input.setEncoding('utf8')
    input.resume()
    input.on('data', onData)
  })
}

async function readPiped(): Promise<string> {
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) text += String(chunk)
  return text.split(/\r?\n/)[0] ?? ''
}

async function askPassword(): Promise<string> {
  if (!process.stdin.isTTY) return readPiped()
  const first = await readHidden(`Password (at least ${MIN_PASSWORD_LENGTH} characters): `)
  const second = await readHidden('Once more: ')
  if (first !== second) throw new Error('the two passwords differ, nothing was changed')
  return first
}

/**
 * The database the server uses, opened as it is. A path that holds no Manor database
 * is refused: making one here would report an account the running server never sees.
 */
function openExisting(): { db: DatabaseSync; filename: string } {
  const resolved = resolveStoreConfig(process.env)
  if (!resolved.ok) throw new Error(resolved.message)
  if (resolved.config.kind !== 'sqlite') throw new Error('the memory store keeps no account: unset MANOR_STORE')
  const { filename } = resolved.config
  if (!existsSync(filename)) throw new Error(`no Manor database at ${filename}. Start Manor once first, or check MANOR_SQLITE_PATH and MANOR_DATA_DIR.`)
  const db = new DatabaseSync(filename)
  db.exec('PRAGMA busy_timeout = 5000')
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'records'").get() === undefined) {
    db.close()
    throw new Error(`${filename} is not a Manor database`)
  }
  return { db, filename }
}

async function main(): Promise<void> {
  const argument = process.argv.slice(2).find((value) => value !== '--')
  if (argument === undefined) throw new Error('usage: pnpm --filter @manor/server account you@example.com | --remove')
  const pinned = (process.env['MANOR_OWNER_USER_ID'] ?? '').trim()

  if (argument === '--remove') {
    const { db, filename } = openExisting()
    const removed = removeOwnerAccounts(db)
    process.stdout.write(removed === 0
      ? `no account in ${filename}, nothing was changed.\n`
      : `removed the account and its device sessions from ${filename}. Only this Mac opens Manor now.\n`)
    if (removed > 0 && pinned !== '') process.stdout.write('MANOR_OWNER_USER_ID still names it: remove that setting, or Manor will not start.\n')
    return
  }

  // Before the prompts, so a typo is not found after the password was typed twice.
  const email = accountEmail(argument)
  const { db, filename } = openExisting()
  const password = await askPassword()
  const { created } = await setOwnerAccount(db, { email, password, ...(pinned === '' ? {} : { ownerId: pinned }) })
  process.stdout.write(created
    ? `created the account for ${email} in ${filename}. Sign in on the other device with this email and password.\n`
    : `changed the account to ${email} in ${filename}. No device connects again without the new password; restart Manor to close a connection that is open now.\n`)
}

void main().catch((error: unknown) => {
  process.stderr.write(`[manor-account] ${error instanceof Error ? error.message : 'failed'}\n`)
  process.exitCode = 1
})
