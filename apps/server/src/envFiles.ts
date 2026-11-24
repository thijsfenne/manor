import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { serverFile } from './serverRoot.js'

/**
 * Local runtime configuration, from two optional files, read before anything else.
 * `main.ts` imports this module first, because other modules read the environment
 * while they load and would miss a value that arrived later.
 *
 * `apps/server/.env` is the file a checkout uses. `<data dir>/.env` (`~/.manor/.env`)
 * is the one the desktop app's own server can have, because nothing may be written
 * inside the app. A variable that is already set is never replaced, so the real
 * environment wins over the first file and the first file over the second. Nothing
 * from either file is ever printed.
 */

/** The data folder's file. Manor itself writes it, for the Composio key the Connectors page saves. */
export const DATA_ENV_FILE = path.join(process.env.MANOR_DATA_DIR ?? path.join(homedir(), '.manor'), '.env')

/**
 * The file Settings points the user to for keys: the checkout's file when there is one (it
 * is read first and wins), else the data folder's, which is where the desktop app's server
 * looks. A setting one variable decides names that variable's own file, see `pinState`.
 */
export const ENV_FILE = existsSync(serverFile('.env')) ? serverFile('.env') : DATA_ENV_FILE

/** Both files by where `envOrigin` says a value came from. */
export const ENV_FILES = { checkout: serverFile('.env'), data: DATA_ENV_FILE }

const filled = () => new Set(Object.entries(process.env).flatMap(([name, value]) => value ? [name] : []))
const load = (file: string) => {
  try {
    process.loadEnvFile(file)
  } catch {
    // No file, or an unreadable one; the settings that are required say so themselves.
  }
}

const fromEnvironment = filled()
load(serverFile('.env'))
const fromCheckout = new Set([...filled()].filter((name) => !fromEnvironment.has(name)))
load(DATA_ENV_FILE)

/**
 * Where a variable that had a value at startup came from, when that was outside the
 * data folder's file. Undefined means the data folder's file, or not set at startup.
 */
export function envOrigin(name: string): 'environment' | 'checkout' | undefined {
  if (fromEnvironment.has(name)) return 'environment'
  if (fromCheckout.has(name)) return 'checkout'
  return undefined
}

