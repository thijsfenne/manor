import type { MemoryRead } from '@manor/contracts'

const CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long' })
const CALENDAR = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })

const midnight = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
const DAY_MS = 86_400_000

/**
 * When a message was said, in the shortest form that cannot be misread.
 *
 * Today needs no date, and a bare weekday is only true for a week: "Wednesday 13:32"
 * on a turn from three weeks ago is a label that lies, which is the one thing a
 * timestamp under every message must never do. Past that it names the date outright.
 */
export function messageTime(ts: number, now: number): string {
  const then = new Date(ts)
  const clock = CLOCK.format(then)
  const days = Math.round((midnight(new Date(now)) - midnight(then)) / DAY_MS)
  if (days <= 0) return clock
  if (days === 1) return `Yesterday ${clock}`
  if (days < 7) return `${WEEKDAY.format(then)} ${clock}`
  return `${CALENDAR.format(then)} ${clock}`
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/**
 * What memory this turn opened, split the way the question is actually asked.
 *
 * The two halves are not the same evidence. Ring 1 and the project file are injected
 * at the start of every chat and say nothing about routing; a structured ref or a
 * daily log opened mid-turn is the whole signal that `map.md` and the indexes are
 * doing their job. A count that merges them hides the only half worth watching, so
 * this never does, and it drops the half that is zero rather than printing it.
 */
export function readsLabel(reads: readonly MemoryRead[]): string {
  const injected = reads.filter((read) => read.source === 'injected').length
  const onDemand = reads.length - injected
  const parts = [
    ...(onDemand === 0 ? [] : [`${plural(onDemand, 'file')} read on request`]),
    ...(injected === 0 ? [] : [`${plural(injected, 'file')} injected at start`]),
  ]
  return parts.length === 0 ? 'nothing read' : parts.join(', ')
}

/** Every source this turn opened, once each: a file read twice is still one file. */
export function distinctReadPaths(reads: readonly MemoryRead[]): string[] {
  return [...new Set(reads.map((read) => read.path))]
}

const STRUCTURED_MEMORY_PATH = /(?:^|\/)memory\/structured\//
const MEMORY_INDEX = /(?:^|\/)MEMORY\.md$/i

/** Injected structured files from one turn, indexes excluded. Same list on lexical fallback. */
export function selectedMemoryPaths(reads: readonly MemoryRead[]): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const read of reads) {
    if (read.source !== 'injected') continue
    if (!STRUCTURED_MEMORY_PATH.test(read.path) || MEMORY_INDEX.test(read.path)) continue
    if (seen.has(read.path)) continue
    seen.add(read.path)
    paths.push(read.path)
  }
  return paths
}

/** This user turn's injected files, every finished persona. A live turn without a trace keeps that union. */
export function lastTurnSelectedMemoryPaths(
  rows: ReadonlyArray<{
    kind: string
    live?: unknown
    memoryTrace?: { reads: readonly MemoryRead[] }
    event?: { type?: string }
  }>,
): string[] {
  const groups: string[][] = []
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row === undefined) continue
    if (row.kind === 'event' && row.event?.type === 'user_message') break
    if (row.kind !== 'turn') continue
    if (row.live !== undefined && row.memoryTrace === undefined) continue
    if (row.memoryTrace === undefined) continue
    groups.push(selectedMemoryPaths(row.memoryTrace.reads))
  }
  const paths: string[] = []
  const seen = new Set<string>()
  for (const path of groups.reverse().flat()) {
    if (seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

/**
 * Names the state of a chat's project file writes: it changes when the thread writes a
 * line and when a write is undone, which is when an open Context panel reloads.
 */
export function projectWritesKey(
  events: ReadonlyArray<{ id: string; type: string; projectFileWrite?: { undone?: true } }>,
): string {
  let last = ''
  let undone = 0
  for (const event of events) {
    if (event.type !== 'system_note' || event.projectFileWrite === undefined) continue
    last = event.id
    if (event.projectFileWrite.undone === true) undone += 1
  }
  return `${last}:${undone}`
}
