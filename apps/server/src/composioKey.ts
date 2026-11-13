import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ClientMessage, ComposioApp, ComposioKeySource, ServerMessage } from '@manor/contracts'
import { COMPOSIO_API_KEY_ENV, LEGACY_COMPOSIO_API_KEY_ENV, composioApiKeyEnv } from './mcp/composioAttachment.js'

const KEY_NAMES = [COMPOSIO_API_KEY_ENV, LEGACY_COMPOSIO_API_KEY_ENV] as const
/** One line of letters, digits and `_ - .`, so it can never break out of its `.env` line. */
const KEY_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.-]{7,255}$/
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/

/** The save worked but Composio did not come up. Carries no key and no Composio error text. */
export const COMPOSIO_NOT_STARTED = 'The key is saved, but Composio did not start. Press Test on the Composio row, or try again later.'

export const BAD_KEY_SHAPE = 'That does not look like a Composio API key. Paste the key as one line, without spaces or quotes.'

/** The key's shape before it goes anywhere near a request or the file; null when it passes. */
export function composioKeyShapeError(key: string): string | null {
  return KEY_SHAPE.test(key) ? null : BAD_KEY_SHAPE
}

/** Splits into lines that keep their own line ending, so a rewrite keeps every other byte. */
const lines = (text: string): string[] => text.length === 0 ? [] : text.split(/(?<=\n)/)
const nameOf = (line: string): string | undefined => ENV_LINE.exec(line)?.[1]

/** Writes through a temporary file in the same folder, then renames, owner-only throughout. */
async function writePrivate(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
  } catch (error: unknown) {
    await rm(temporary, { force: true })
    throw error
  }
  await chmod(file, 0o600)
}

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/** Sets `name=value` in a `.env` file: replaces its line or appends one, and keeps every other line as it was. */
export async function setEnvFileValue(file: string, name: string, value: string): Promise<void> {
  const before = lines(await readOrEmpty(file))
  let found = false
  const after = before.flatMap((line) => {
    if (nameOf(line) !== name) return [line]
    if (found) return []
    found = true
    return [`${name}=${value}${line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''}`]
  })
  if (!found) {
    const last = after.at(-1)
    if (last !== undefined && !last.endsWith('\n')) after[after.length - 1] = `${last}\n`
    after.push(`${name}=${value}\n`)
  }
  await writePrivate(file, after.join(''))
}

/** Drops the lines that set any of `names`; answers whether there were any. */
export async function removeEnvFileValues(file: string, names: readonly string[]): Promise<boolean> {
  const before = lines(await readOrEmpty(file))
  const after = before.filter((line) => {
    const name = nameOf(line)
    return name === undefined || !names.includes(name)
  })
  if (after.length === before.length) return false
  await writePrivate(file, after.join(''))
  return true
}

type KeyMessage = Extract<ClientMessage, { type: 'set_composio_key' | 'remove_composio_key' }>

export interface ComposioKeyDeps {
  /** The environment the Composio ports and the connector read the key from. */
  env: NodeJS.ProcessEnv
  /** Where a variable came from at startup, when not from the data folder's file. */
  origin: (name: string) => 'environment' | 'checkout' | undefined
  /** The data folder's `.env`. Undefined keeps the key in `env` alone (the mock spike). */
  file?: string
  /** Asks Composio whether the key works; answers its catalogue, or throws in plain words. */
  validate: (key: string) => Promise<ComposioApp[]>
  /** Brings Composio up after a new key, the way startup does with one. */
  started: (apps: ComposioApp[]) => Promise<void>
  /** Takes Composio down after the key went. */
  stopped: () => Promise<void>
  broadcast: (message: ServerMessage) => void
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : 'Composio did not answer.'

/** Composio's answer, in words for the page. Never contains the key. */
export function composioKeyRejection(error: unknown, key: string): string {
  const text = errorText(error).replaceAll(key, '[redacted]')
  if (/HTTP (401|403)\b/.test(text)) return 'Composio did not accept this key. Check that you copied the whole project API key.'
  return `Composio could not check the key: ${text}`
}

/**
 * The Composio key the Connectors page sets. It is checked with Composio first, then
 * kept in the data folder's `.env` and this process's environment, and nothing that
 * leaves here ever carries it: clients learn only where a key comes from.
 */
export class ComposioKey {
  /** One change at a time, so two quick saves cannot interleave their file writes. */
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: ComposioKeyDeps) {}

  source(): ComposioKeySource {
    // Only the variable that is actually in use decides, the same one the connector reads.
    const active = composioApiKeyEnv(this.deps.env)
    if (active === undefined) return 'none'
    return this.deps.origin(active) ?? 'manor'
  }

  status(): ServerMessage {
    return { type: 'composio_key', source: this.source() }
  }

  handle(message: KeyMessage, reply: (message: ServerMessage) => void, ack: () => void): Promise<void> {
    const run = this.queue.then(() => message.type === 'set_composio_key'
      ? this.set(message.key.trim(), reply, ack)
      : this.remove(reply, ack))
    this.queue = run.catch(() => undefined)
    return run
  }

  private refusal(source: ComposioKeySource): string | undefined {
    if (source === 'environment') return 'The Composio key is set in the environment Manor starts with. Change it there.'
    if (source === 'checkout') return 'The Composio key is set in apps/server/.env. Change it there.'
    return undefined
  }

  private async set(key: string, reply: (message: ServerMessage) => void, ack: () => void): Promise<void> {
    const source = this.source()
    const refused = this.refusal(source) ?? (source === 'manor' ? 'Remove the current Composio key first.' : composioKeyShapeError(key) ?? undefined)
    if (refused !== undefined) {
      reply({ type: 'notice', kind: 'error', text: refused })
      return
    }
    let apps: ComposioApp[]
    try {
      apps = await this.deps.validate(key)
    } catch (error: unknown) {
      reply({ type: 'notice', kind: 'error', text: composioKeyRejection(error, key) })
      return
    }
    try {
      if (this.deps.file !== undefined) await setEnvFileValue(this.deps.file, COMPOSIO_API_KEY_ENV, key)
    } catch (error: unknown) {
      console.warn(`[manor] could not write the Composio key to the data folder: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`)
      reply({ type: 'notice', kind: 'error', text: 'Manor could not save the key in its data folder.' })
      return
    }
    this.deps.env[COMPOSIO_API_KEY_ENV] = key
    this.deps.broadcast(this.status())
    try {
      await this.deps.started(apps)
    } catch (error: unknown) {
      console.warn(`[manor] Composio did not start after its key was saved: ${errorText(error).replaceAll(key, '[redacted]')}`)
      reply({ type: 'notice', kind: 'info', text: COMPOSIO_NOT_STARTED })
      return
    }
    ack()
  }

  private async remove(reply: (message: ServerMessage) => void, ack: () => void): Promise<void> {
    const source = this.source()
    const refused = this.refusal(source) ?? (source === 'none' ? 'There is no Composio key to remove.' : undefined)
    if (refused !== undefined) {
      reply({ type: 'notice', kind: 'error', text: refused })
      return
    }
    try {
      if (this.deps.file !== undefined) await removeEnvFileValues(this.deps.file, KEY_NAMES)
    } catch (error: unknown) {
      console.warn(`[manor] could not remove the Composio key from the data folder: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`)
      reply({ type: 'notice', kind: 'error', text: 'Manor could not remove the key from its data folder.' })
      return
    }
    // A legacy key from the checkout or the environment stays: Manor did not set it, and it is back after a restart anyway.
    for (const name of KEY_NAMES) if (this.deps.origin(name) === undefined) delete this.deps.env[name]
    try {
      await this.deps.stopped()
    } catch (error: unknown) {
      console.warn(`[manor] Composio did not settle after its key was removed: ${errorText(error)}`)
    }
    this.deps.broadcast(this.status())
    ack()
  }
}
