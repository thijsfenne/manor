import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { FileEdit } from '@manor/contracts'
import { editsFromApplyPatch } from './edits.js'

/**
 * How far back from the end of a rollout the scan looks for the turn's last
 * `token_count`. Codex writes that line second-to-last, right before
 * `task_complete`, so this only has to survive the final response items. A tail
 * this size covers a 235 KB rollout whole; a turn that ends with a megabyte of
 * tool output falls through to the driver's own estimate rather than reading a
 * whole session history into memory.
 */
const TAIL_BYTES = 1_000_000
const CONTEXT_LINE_MAX = 1_000_000
const MAX_CACHED_ROLLOUT_PATHS = 128

/** Small process-local index. A resumed thread keeps writing to the same file. */
const rolloutPaths = new Map<string, string>()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const asNumber = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)

/**
 * Rollouts live in `sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl`,
 * one file per thread: a resumed thread appends to the file it already had. The
 * walk goes newest name first, so a live thread is found after a handful of
 * readdirs instead of a full-history sweep.
 */
async function findRollout(root: string, suffix: string): Promise<string | undefined> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of [...entries].sort((left, right) => right.name.localeCompare(left.name))) {
    const target = path.join(root, entry.name)
    if (entry.isFile()) {
      if (entry.name.endsWith(suffix)) return target
      continue
    }
    if (!entry.isDirectory()) continue
    const found = await findRollout(target, suffix)
    if (found !== undefined) return found
  }
  return undefined
}

/** The tail as text, plus whether that tail is the whole file. */
async function readTail(file: string): Promise<{ text: string; whole: boolean } | undefined> {
  const handle = await open(file, 'r').catch(() => undefined)
  if (handle === undefined) return undefined
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return { text: buffer.toString('utf8'), whole: length === size }
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** `last_token_usage.input_tokens` and `model_context_window` off one rollout line. */
function tokenCountLine(line: string): { tokens: number; window?: number; writtenMs: number } | undefined {
  // Cheap pre-filter: response items in the same tail can be megabytes of text and
  // parsing every one of them to find a small event would be the expensive part.
  if (!line.includes('"token_count"')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || parsed['type'] !== 'event_msg') return undefined
  const payload = parsed['payload']
  if (!isRecord(payload) || payload['type'] !== 'token_count') return undefined
  const info = payload['info']
  if (!isRecord(info)) return undefined
  const last = info['last_token_usage']
  if (!isRecord(last)) return undefined
  const tokens = asNumber(last['input_tokens'])
  if (tokens === undefined || tokens <= 0) return undefined
  const window = asNumber(info['model_context_window'])
  return {
    tokens,
    writtenMs: Date.parse(asString(parsed['timestamp']) ?? ''),
    ...(window !== undefined && window > 0 ? { window } : {}),
  }
}

/** The effective model and effort recorded for this turn, or nothing. */
function turnContextLine(line: string): { model?: string; effort?: string; writtenMs: number } | undefined {
  // Same pre-filter reasoning as `tokenCountLine`: most lines in the tail are large
  // response items and parsing them all to find a small record is the expensive part.
  if (!line.includes('"turn_context"')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || parsed['type'] !== 'turn_context') return undefined
  const payload = parsed['payload']
  if (!isRecord(payload)) return undefined
  const model = asString(payload['model'])
  const effort = asString(payload['effort']) ?? asString(payload['reasoning_effort'])
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    writtenMs: Date.parse(asString(parsed['timestamp']) ?? ''),
  }
}

/** A long helper may push its turn context out of the tail. Read back only to this turn's start. */
async function latestTurnContext(file: string, sinceMs: number): Promise<ReturnType<typeof turnContextLine>> {
  const handle = await open(file, 'r').catch(() => undefined)
  if (handle === undefined) return undefined
  let carry = Buffer.alloc(0)
  let skippingLine = false
  try {
    let position = (await handle.stat()).size
    while (position > 0) {
      const length = Math.min(position, 64 * 1024)
      position -= length
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead !== length) return undefined
      let end = length
      while (end > 0) {
        const newline = buffer.lastIndexOf(10, end - 1)
        const fragment = buffer.subarray(newline + 1, end)
        if (newline < 0) {
          if (!skippingLine) {
            if (fragment.length + carry.length > CONTEXT_LINE_MAX) {
              carry = Buffer.alloc(0)
              skippingLine = true
            } else {
              carry = Buffer.concat([fragment, carry])
            }
          }
          break
        }
        if (!skippingLine && fragment.length + carry.length <= CONTEXT_LINE_MAX) {
          const line = Buffer.concat([fragment, carry]).toString('utf8')
          const context = turnContextLine(line)
          if (context !== undefined) return context
          const timestamp = /"timestamp":"([^"]+)"/.exec(line.slice(0, 128))?.[1]
          if (timestamp !== undefined && Date.parse(timestamp) < sinceMs - 1_000) return undefined
        }
        carry = Buffer.alloc(0)
        skippingLine = false
        end = newline
      }
    }
    return skippingLine ? undefined : turnContextLine(carry.toString('utf8'))
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** What one turn of a Codex thread can be learned from its own rollout file. */
export interface RolloutReading {
  /** Prompt size of the turn's final request; see `TurnResultEventSchema`. */
  contextTokens?: number
  /** `model_context_window` from the same `token_count` as `contextTokens`. */
  contextWindow?: number
  /** The model Codex recorded for this turn; see `TurnResultEventSchema`. */
  model?: string
  /** The reasoning effort Codex recorded for this turn. */
  effort?: string
}

export interface RolloutPatch {
  /** Stable within a rollout, so repeated tail reads cannot claim one patch twice. */
  id: string
  edits: FileEdit[]
}

/** Every JSON-compatible string literal embedded in a larger source string. */
function embeddedStrings(value: string): string[] {
  const found: string[] = []
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== '"') continue
    let escaped = false
    for (let end = start + 1; end < value.length; end += 1) {
      const character = value[end]
      if (escaped) {
        escaped = false
        continue
      }
      if (character === '\\') {
        escaped = true
        continue
      }
      if (character !== '"') continue
      try {
        const decoded: unknown = JSON.parse(value.slice(start, end + 1))
        if (typeof decoded === 'string') found.push(decoded)
      } catch {
        // JavaScript source may contain a string JSON does not accept. Keep looking;
        // executing provider-written source to recover a patch is never an option.
      }
      start = end
      break
    }
  }
  return found
}

/** Finds patch text inside Codex's custom-tool input without executing that input. */
function patchText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    try {
      const decoded: unknown = JSON.parse(value)
      if (decoded !== value) return patchText(decoded)
    } catch {
      // A command is ordinary text, not JSON; inspect it directly below.
    }
    // Older Codex versions stored a JSON command envelope or the patch itself.
    // Current versions store the JavaScript passed to functions.exec, with the
    // patch as a JSON-escaped string literal inside it. Returning the whole source
    // sees the marker but no real newlines, so the patch parser finds no headers.
    if (editsFromApplyPatch(value) !== undefined) return value
    for (const embedded of embeddedStrings(value)) {
      const found = patchText(embedded)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = patchText(entry)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  for (const entry of Object.values(value)) {
    const found = patchText(entry)
    if (found !== undefined) return found
  }
  return undefined
}

/** One apply_patch call recorded before Codex executes it, or nothing. */
function patchLine(line: string, sinceMs: number): RolloutPatch | undefined {
  if (!line.includes('*** Begin Patch')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || parsed['type'] !== 'response_item') return undefined
  const writtenMs = Date.parse(asString(parsed['timestamp']) ?? '')
  if (!Number.isFinite(writtenMs) || writtenMs < sinceMs - 1_000) return undefined
  const payload = parsed['payload']
  if (!isRecord(payload) || payload['type'] !== 'custom_tool_call') return undefined
  const id = asString(payload['call_id']) ?? asString(payload['id'])
  const input = patchText(payload['input'])
  if (id === undefined || input === undefined) return undefined
  const edits = editsFromApplyPatch(input)
  return edits === undefined ? undefined : { id, edits }
}

/**
 * Full patches for this turn, from the isolated rollout Manor already owns.
 * `codex exec --json` strips these down to path and operation; the rollout is the
 * only provider-scoped source that cannot absorb another chat's worktree changes.
 * A format change fails closed to an empty list.
 */
export async function readRolloutPatches(
  codexHome: string,
  sessionId: string,
  sinceMs: number,
): Promise<RolloutPatch[]> {
  const root = path.join(codexHome, 'sessions')
  const suffix = `-${sessionId}.jsonl`
  const cacheKey = `${root}\0${suffix}`
  const cached = rolloutPaths.get(cacheKey)
  const cachedExists =
    cached !== undefined && (await stat(cached).then((entry) => entry.isFile(), () => false))
  const file = cachedExists ? cached : await findRollout(root, suffix)
  if (file === undefined) return []
  rolloutPaths.delete(cacheKey)
  rolloutPaths.set(cacheKey, file)
  const tail = await readTail(file)
  if (tail === undefined) return []
  const lines = tail.text.split('\n')
  if (!tail.whole) lines.shift()
  return lines.flatMap((line) => {
    const patch = patchLine(line, sinceMs)
    return patch === undefined ? [] : [patch]
  })
}

/**
 * What Codex itself recorded about the turn it just ran: how full the context is, and
 * which model served it. Both come out of one tail read, because they live in the same
 * file and the read is the expensive part.
 *
 * `codex exec --json` reports only turn totals, which stack one copy of the prompt
 * per request the turn made and so cannot serve as a gauge. The CLI does record the
 * real reading, in the rollout file it keeps under the `CODEX_HOME` Manor owns:
 * `last_token_usage.input_tokens` is the prompt of the turn's final request, the
 * same number the Codex TUI divides by `model_context_window`. That window travels
 * with the reading so the ring and live compact use Codex's denominator, not ours.
 *
 * Reading another program's session file is a side channel, so every failure here
 * is silent and returns nothing: a missing file, a renamed field, a rollout format
 * that moves on. The caller keeps its own estimate for that case.
 *
 * `sinceMs` is the turn's start. A record written before it belongs to an earlier turn
 * of the same thread, which for the context would understate it and for the model would
 * name the one a resumed thread used to run on, so either is discarded instead of
 * reported. The slack allows for clocks whose timestamps have coarse precision. A
 * record that carries no readable timestamp at all is unusable rather than lenient: it
 * would silently disable this guard on exactly the format change the guard exists for.
 */
export async function readRolloutTurn(
  codexHome: string,
  sessionId: string,
  sinceMs: number,
): Promise<RolloutReading> {
  const root = path.join(codexHome, 'sessions')
  const suffix = `-${sessionId}.jsonl`
  const cacheKey = `${root}\0${suffix}`
  const cached = rolloutPaths.get(cacheKey)
  const cachedExists =
    cached !== undefined && (await stat(cached).then((entry) => entry.isFile(), () => false))
  const file = cachedExists ? cached : await findRollout(root, suffix)
  if (file === undefined) return {}
  rolloutPaths.delete(cacheKey)
  rolloutPaths.set(cacheKey, file)
  while (rolloutPaths.size > MAX_CACHED_ROLLOUT_PATHS) {
    const oldest = rolloutPaths.keys().next().value
    if (oldest === undefined) break
    rolloutPaths.delete(oldest)
  }
  const tail = await readTail(file)
  if (tail === undefined) return {}

  const lines = tail.text.split('\n')
  // The first line of a partial tail starts mid-record, and may start mid-character.
  if (!tail.whole) lines.shift()
  const fresh = (writtenMs: number) => writtenMs >= sinceMs - 1_000
  const reading: RolloutReading = {}
  // Backwards, and the NEWEST record of each kind decides, whether or not it turns out
  // to be fresh: an older one of the same kind is older still. The two kinds are looked
  // for independently because Codex writes them at different points in a turn, a
  // `turn_context` when it starts and a `token_count` near the end, so a turn that died
  // early can have one without the other.
  let sawTokens = false
  let sawContext = false
  for (let index = lines.length - 1; index >= 0 && !(sawTokens && sawContext); index -= 1) {
    const line = lines[index] ?? ''
    if (!sawTokens) {
      const tokens = tokenCountLine(line)
      if (tokens !== undefined) {
        sawTokens = true
        if (fresh(tokens.writtenMs)) {
          reading.contextTokens = tokens.tokens
          if (tokens.window !== undefined) reading.contextWindow = tokens.window
        }
      }
    }
    if (!sawContext) {
      const context = turnContextLine(line)
      if (context !== undefined) {
        sawContext = true
        if (fresh(context.writtenMs)) {
          if (context.model !== undefined) reading.model = context.model
          if (context.effort !== undefined) reading.effort = context.effort
        }
      }
    }
  }
  if (!sawContext && !tail.whole) {
    const context = await latestTurnContext(file, sinceMs)
    if (context !== undefined && fresh(context.writtenMs)) {
      if (context.model !== undefined) reading.model = context.model
      if (context.effort !== undefined) reading.effort = context.effort
    }
  }
  return reading
}
