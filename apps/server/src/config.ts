import path from 'node:path'
import os from 'node:os'
import { readlinkSync, realpathSync } from 'node:fs'
export type StoreConfig = { kind: 'memory' } | { kind: 'sqlite'; filename: string }

export type StoreConfigResult = { ok: true; config: StoreConfig } | { ok: false; message: string }

/**
 * How far agents may act outside the chat (the browser, the Mac, connector writes)
 * without asking. Unset is `auto`: an independent model allows what is clearly low
 * impact and the user is asked about the rest. `confirm` asks every time, and
 * `full-access` never asks, which is a choice somebody makes for their own Mac and
 * not what a new install starts with.
 */
export function resolveEffectMode(env: NodeJS.ProcessEnv): 'full-access' | 'auto' | 'confirm' {
  const setting = env.MANOR_EFFECT_MODE ?? 'auto'
  if (setting === 'full-access' || setting === 'auto' || setting === 'confirm') return setting
  throw new Error('MANOR_EFFECT_MODE must be "full-access", "auto" or "confirm".')
}

/**
 * The database the user's own Manor runs on, from the account's home rather than HOME,
 * which a spike may point elsewhere.
 */
const liveSqlitePath = () => path.join(os.userInfo().homedir, '.manor', 'sqlite', 'manor.db')

/**
 * A symlink or a `..` path to the live file is still the live file, and so is a link
 * to it before it exists, since SQLite would create it through the link.
 */
const realPath = (filename: string): string => {
  try {
    return realpathSync(filename)
  } catch {
    try {
      return path.resolve(path.dirname(filename), readlinkSync(filename))
    } catch {
      return path.resolve(filename)
    }
  }
}

/**
 * A mock server on the live database answers real chats with mock turns and saves
 * their `mock-…` session ids, after which every real resume of those chats fails
 * (2026-10-12, a verify run that left MANOR_SQLITE_PATH unset).
 */
const MOCK_ON_LIVE =
  'MANOR_DRIVER=mock refuses the live SQLite database: set MANOR_STORE=memory, or MANOR_SQLITE_PATH to a copy outside ~/.manor/sqlite.'

const storeUnknown = (value: string) =>
  `MANOR_STORE=${value} is not a store: use "sqlite" or "memory", or leave it unset (sqlite).`

/**
 * Decides which store the server runs on, before anything is opened. Unset is the
 * live local SQLite database. A typo is fatal rather than a different store: a
 * half-started server that accepts chats and drops them is worse than no server.
 * `MANOR_STORE=memory` is the run on an ephemeral in-memory SQLite database.
 */
export function resolveStoreConfig(env: NodeJS.ProcessEnv): StoreConfigResult {
  const setting = env['MANOR_STORE'] ?? ''
  if (setting === '' || setting === 'sqlite') {
    const filename = env['MANOR_SQLITE_PATH'] || path.join(env['MANOR_DATA_DIR'] || path.join(os.homedir(), '.manor'), 'sqlite', 'manor.db')
    if (env['MANOR_DRIVER'] === 'mock' && realPath(filename) === realPath(liveSqlitePath())) return { ok: false, message: MOCK_ON_LIVE }
    return { ok: true, config: { kind: 'sqlite', filename } }
  }
  if (setting === 'memory') return { ok: true, config: { kind: 'memory' } }
  return { ok: false, message: storeUnknown(setting) }
}

/**
 * How many delegated turns one un-mentioned message may cost. This is the budget
 * cap the briefing calls required rather than optional: a chief of staff that
 * mentions four specialists spends four turns of the weekly cap on one sentence.
 * Five lets the chief of staff reach the whole household once.
 */
export const DEFAULT_DELEGATION_CAP = 5

/**
 * How many times a summoner↔summoned pair may run again after the first summon.
 * Separate from the first-summon budget so a cheap hand-off stays cheap: the
 * extra turns only exist when someone writes the @ back. Three is the review
 * loop (review, fix, recheck, last fix). Two died after the recheck found leftover issues.
 */
export const DEFAULT_REVIEW_HOPS = 3

export type DelegationCapResult = { ok: true; cap: number } | { ok: false; message: string }

const capUnusable = (value: string) =>
  `MANOR_DELEGATION_CAP=${value} is not a budget: use a whole number of delegated turns per message (0 disables delegation, the default is ${DEFAULT_DELEGATION_CAP}).`

/**
 * Reads the per-message delegation budget. Fatal rather than silently defaulted: a
 * typo'd cap that quietly becomes 3 is the failure mode this guard exists to
 * prevent, since nothing about the running server would show the setting was
 * ignored. Zero is a real setting, it turns delegation off without unconfiguring
 * the chief of staff.
 */
export function resolveDelegationCap(env: NodeJS.ProcessEnv): DelegationCapResult {
  const setting = env['MANOR_DELEGATION_CAP'] ?? ''
  if (setting === '') return { ok: true, cap: DEFAULT_DELEGATION_CAP }
  const cap = Number(setting)
  if (!Number.isInteger(cap) || cap < 0) return { ok: false, message: capUnusable(setting) }
  return { ok: true, cap }
}

/**
 * Wakes a chat may run since the user last started a chain there: turns nobody asked for,
 * started when background work ends. Each one may start more background work, so this
 * is what keeps a chain of wakes finite. Goal Sessions do not count them.
 */
export const DEFAULT_WAKE_CAP = 10

/**
 * How long an ended delegate_task child waits for its still-running siblings, counted
 * from the first end, before its persona wakes with what came back so far.
 */
export const WAKE_HOLD_MAX_MS = 10 * 60_000

/** Reads `MANOR_WAKE_CAP`, fatal on a value that is not a whole number; zero turns wakes off. */
export function resolveWakeCap(env: NodeJS.ProcessEnv): DelegationCapResult {
  const setting = env['MANOR_WAKE_CAP'] ?? ''
  if (setting === '') return { ok: true, cap: DEFAULT_WAKE_CAP }
  const cap = Number(setting)
  if (!Number.isInteger(cap) || cap < 0) {
    return { ok: false, message: `MANOR_WAKE_CAP=${setting} is not a cap: use a whole number of wakes per message (0 turns wakes off, the default is ${DEFAULT_WAKE_CAP}).` }
  }
  return { ok: true, cap }
}

export const DEFAULT_RELAY_DEPTH = 2
export const DEFAULT_RELAY_CAP = 4

export type RelayLimitsResult =
  | { ok: true; depth: number; cap: number }
  | { ok: false; message: string }

/** Two independent hard ceilings for one user-originated agent relay chain. */
export function resolveRelayLimits(env: NodeJS.ProcessEnv): RelayLimitsResult {
  const depthSetting = env['MANOR_RELAY_DEPTH'] ?? ''
  const capSetting = env['MANOR_RELAY_CAP'] ?? ''
  const depth = depthSetting === '' ? DEFAULT_RELAY_DEPTH : Number(depthSetting)
  const cap = capSetting === '' ? DEFAULT_RELAY_CAP : Number(capSetting)
  if (!Number.isInteger(depth) || depth < 0) {
    return { ok: false, message: `MANOR_RELAY_DEPTH=${depthSetting} is not a whole non-negative depth.` }
  }
  if (!Number.isInteger(cap) || cap < 0) {
    return { ok: false, message: `MANOR_RELAY_CAP=${capSetting} is not a whole non-negative turn budget.` }
  }
  return { ok: true, depth, cap }
}

export type RoutinesModeResult = { ok: true; on: boolean } | { ok: false; message: string }

const routinesUnknown = (value: string) =>
  `MANOR_ROUTINES=${value} is not a setting: use "on" to make this the server that runs routines, "off", or leave it unset (off).`

/**
 * Whether this server ticks the routine scheduler. Off unless it says otherwise,
 * because two servers hit the same SQLite database on this machine — `pnpm dev` on 8787 and
 * the stable one on 43179 — and a bare interval on both fires every routine twice.
 * The database claim is the other half of that guard, and this flag is the half that
 * keeps a dev server with half-edited code in the tree from ever winning the claim
 * and running the user's real morning routine on it. A typo is fatal for the reason
 * every other setting here is: nothing about the running server would show that
 * `MANOR_ROUTINES=yes` silently meant off.
 */
export function resolveRoutinesMode(env: NodeJS.ProcessEnv): RoutinesModeResult {
  const setting = env['MANOR_ROUTINES'] ?? ''
  if (setting !== '' && setting !== 'on' && setting !== 'off') return { ok: false, message: routinesUnknown(setting) }
  return { ok: true, on: setting === 'on' }
}

/**
 * Whether Apple Reminders is part of this Manor. Off unless asked for: a Reminders
 * command line tool that was installed for something else must not open the user's
 * lists to agents. A mock run only ever sees a tool in its own home folder, so there
 * the integration follows the tool, which is what the UI proofs need.
 */
export function resolveRemindersMode(env: NodeJS.ProcessEnv, mock: boolean): RoutinesModeResult {
  const setting = (env['MANOR_REMINDERS'] ?? '').trim()
  if (setting !== '' && setting !== 'on' && setting !== 'off') {
    return { ok: false, message: `MANOR_REMINDERS=${setting} is not a setting: use "on" to let Manor read and write Apple Reminders, "off", or leave it unset (off).` }
  }
  return { ok: true, on: setting === 'on' || (setting === '' && mock) }
}

export type VaultDirResult =
  | { ok: true; dir: string; source: 'env' | 'setting' | 'default' }
  | { ok: false; message: string }

/** The folder inside the data directory that holds Knowledge notes unless a setting points elsewhere. */
export const DEFAULT_KNOWLEDGE_FOLDER = 'knowledge'

const vaultNotAbsolute = (value: string) =>
  `MANOR_VAULT_DIR=${value} is not a usable path: give the folder's absolute path (a leading ~ is expanded), or leave it unset to use the default Knowledge folder.`

/** Whether the environment decides the Knowledge folder, which Settings then cannot change. */
export const vaultDirPinned = (env: NodeJS.ProcessEnv): boolean => (env['MANOR_VAULT_DIR'] ?? '').trim() !== ''

/**
 * Where the Knowledge notes live: `MANOR_VAULT_DIR`, else the folder picked in Settings
 * (`saved`), else a folder beside the database. Any folder of markdown works, an
 * Obsidian vault included. Parsing only: the folder is stat'd at boot in `main.ts`,
 * and an unreachable one is loud rather than fatal, because a missing folder costs
 * one tab while a dead server costs everything.
 */
export function resolveVaultDir(env: NodeJS.ProcessEnv, home: string, saved: string | null = null): VaultDirResult {
  const pinned = (env['MANOR_VAULT_DIR'] ?? '').trim()
  const setting = pinned !== '' ? pinned : (saved ?? '').trim()
  if (setting === '') {
    const dataDir = (env['MANOR_DATA_DIR'] || `${home}/.manor`).replace(/\/+$/, '')
    return { ok: true, dir: `${dataDir}/${DEFAULT_KNOWLEDGE_FOLDER}`, source: 'default' }
  }
  const expanded = setting === '~' ? home : setting.startsWith('~/') ? `${home}${setting.slice(1)}` : setting
  if (!expanded.startsWith('/')) return { ok: false, message: vaultNotAbsolute(setting) }
  return { ok: true, dir: expanded.length > 1 ? expanded.replace(/\/+$/, '') : expanded, source: pinned !== '' ? 'env' : 'setting' }
}

export interface MyMindConfig {
  keyId: string
  secret: string
}

export type MyMindConfigResult =
  | { ok: true; config: MyMindConfig | undefined }
  | { ok: false; message: string }

const MYMIND_PAIR_ERROR =
  'mymind needs both MANOR_MYMIND_KEY_ID and MANOR_MYMIND_SECRET, or neither to run without Artifacts.'

/**
 * The mymind Extensions page calls the second value a private key. Their API
 * contract calls it a base64-encoded secret; both names mean the same one-time
 * value. Their docs still say 128-bit while the Extensions page also issues
 * 256-bit values, so validity is base64 plus a 128-bit floor, not one exact size.
 */
export function resolveMyMindConfig(env: NodeJS.ProcessEnv): MyMindConfigResult {
  const keyId = (env['MANOR_MYMIND_KEY_ID'] ?? '').trim()
  const secret = (env['MANOR_MYMIND_SECRET'] ?? '').trim()
  if (keyId.length === 0 && secret.length === 0) return { ok: true, config: undefined }
  if (keyId.length === 0 || secret.length === 0) return { ok: false, message: MYMIND_PAIR_ERROR }

  const compact = secret.replace(/\s/g, '')
  const decoded = Buffer.from(compact, 'base64')
  const canonical = decoded.toString('base64').replace(/=+$/, '')
  const supplied = compact.replace(/=+$/, '')
  if (decoded.length < 16 || canonical !== supplied) {
    return {
      ok: false,
      message:
        'MANOR_MYMIND_SECRET is not the base64 private key mymind issued. Copy the value exactly from the Extensions page.',
    }
  }
  return { ok: true, config: { keyId, secret } }
}

export type AuthConfig =
  | { mode: 'off' }
  | { mode: 'on'; filename: string; ownerUserId?: string }

export type AuthConfigResult = { ok: true; config: AuthConfig } | { ok: false; message: string }

export const DEFAULT_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://[::1]:5173',
] as const

export type AllowedOriginsResult = { ok: true; origins: string[] } | { ok: false; message: string }

/**
 * Extra browser origins that may connect across ports. Same-origin connections
 * are always accepted by the upgrade guard, so the stable app and the VPS need no
 * entry. The defaults are the one deliberate cross-origin shape, Vite on 5173
 * talking to the stable backend on 43179.
 */
export function resolveAllowedOrigins(env: NodeJS.ProcessEnv): AllowedOriginsResult {
  const configured = (env['MANOR_ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  const origins: string[] = [...DEFAULT_DEV_ORIGINS]

  for (const value of configured) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return { ok: false, message: `MANOR_ALLOWED_ORIGINS contains ${value}, which is not an origin.` }
    }
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== '/' ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return { ok: false, message: `MANOR_ALLOWED_ORIGINS contains ${value}, which is not an http(s) origin.` }
    }
    origins.push(url.origin)
  }

  return { ok: true, origins: [...new Set(origins)] }
}

const AUTH_NEEDS_SQLITE =
  'Auth is on but MANOR_STORE=memory has no account to check tokens against: use the SQLite store, or start with MANOR_AUTH=off for a local run.'

const authUnknown = (value: string) =>
  `MANOR_AUTH=${value} is not a setting: use "on", "off", or leave it unset (on unless MANOR_STORE=memory).`

const ownerUnusable = (value: string) =>
  `MANOR_OWNER_USER_ID=${value} is not a user id: paste the UUID of the one Manor account.`

const OWNER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Decides whether connections must prove who they are. Auth follows the store by
 * default, because the two answer the same question: a server holding the user's real
 * chats is reachable from the internet, an in-memory one is a scratch process on a
 * laptop. `MANOR_AUTH=off` is the deliberate way out for local dev and the tests;
 * `on` without credentials is fatal rather than degraded, since a server that
 * silently stopped checking tokens looks exactly like one that is checking them.
 * `MANOR_OWNER_USER_ID` pins the password account when one exists. Without it the
 * house has whichever single account its database holds, or none: then only the
 * local access token on this Mac opens the door.
 */
export function resolveAuthConfig(env: NodeJS.ProcessEnv, store: StoreConfig): AuthConfigResult {
  const setting = env['MANOR_AUTH'] ?? ''
  if (setting !== '' && setting !== 'on' && setting !== 'off') return { ok: false, message: authUnknown(setting) }
  const wanted = setting === '' ? store.kind !== 'memory' : setting === 'on'
  if (!wanted) return { ok: true, config: { mode: 'off' } }

  // LocalAuth keeps its accounts in the SQLite file; the memory store has none.
  if (store.kind !== 'sqlite') return { ok: false, message: AUTH_NEEDS_SQLITE }
  // Optional: a house without a password account is reached with the local access token only.
  const ownerUserId = (env['MANOR_OWNER_USER_ID'] ?? '').trim()
  if (ownerUserId === '') return { ok: true, config: { mode: 'on', filename: store.filename } }
  if (!OWNER_ID.test(ownerUserId)) return { ok: false, message: ownerUnusable(ownerUserId) }
  return { ok: true, config: { mode: 'on', filename: store.filename, ownerUserId } }
}

export const DEFAULT_LISTEN_HOST = '127.0.0.1'

/**
 * Where the HTTP/WebSocket server binds. Loopback is the default because an
 * unauthenticated memory store on `0.0.0.0` is a LAN-open house, and the VPS
 * already sets `MANOR_HOST` to its tailnet address on purpose.
 */
export function resolveListenHost(env: NodeJS.ProcessEnv): string {
  const setting = (env['MANOR_HOST'] ?? '').trim()
  return setting === '' ? DEFAULT_LISTEN_HOST : setting
}

export const isLoopbackHost = (host: string): boolean =>
  host === '127.0.0.1' || host === '::1' || host === 'localhost'

export type BindGuardResult = { ok: true } | { ok: false; message: string }

const unauthNetwork = (host: string) =>
  `Auth is off and MANOR_HOST=${host} is reachable beyond this machine: bind to 127.0.0.1, turn auth on, or set MANOR_ALLOW_UNAUTHENTICATED_NETWORK=true.`

const allowUnknown = (value: string) =>
  `MANOR_ALLOW_UNAUTHENTICATED_NETWORK=${value} is not a setting: use "true" to bind an unauthenticated server beyond loopback, or leave it unset.`

/**
 * Refuses the one combination that made the default host dangerous: auth off
 * and a non-loopback bind. The flag is the deliberate way out for a LAN test;
 * anything else is a typo, and a typo must not open the port.
 */
export function resolveUnauthenticatedBind(
  env: NodeJS.ProcessEnv,
  auth: AuthConfig,
  host: string,
): BindGuardResult {
  if (auth.mode === 'on' || isLoopbackHost(host)) return { ok: true }
  const setting = env['MANOR_ALLOW_UNAUTHENTICATED_NETWORK'] ?? ''
  if (setting === 'true') return { ok: true }
  if (setting !== '') return { ok: false, message: allowUnknown(setting) }
  return { ok: false, message: unauthNetwork(host) }
}
