/**
 * The memory folder's open-loops ledger (`memory/open-loops.md`), read and edited one line at a
 * time for the Reminders sync in `openLoopsSync.ts`.
 *
 * Dream and the personas edit the same file, so nothing here rewrites it whole: every
 * edit is a pure function of the file as it is right now, which `editLedger` rereads
 * and writes back only when nobody changed it in between. A line this module cannot
 * read is reported and left exactly as it was.
 *
 * A ledger line looks like
 * `- [clinic-booking] Owner: the user; Next: Book …; Source: …; History: none; Checked: …;
 * Status: open; Deadline: 2026-11-03; Reminder: none; Deadline notice: none.`
 * Values may hold `; ` themselves, so a field starts only at a known key.
 */

import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'

const KEYS = ['Owner', 'Next', 'Source', 'History', 'Checked', 'Status', 'Deadline notice', 'Deadline', 'Reminder'] as const
type Key = (typeof KEYS)[number]
// `Deadline notice` before `Deadline`, so the longer key wins at the same position.
const FIELD = new RegExp(`(?:^|; )(${KEYS.join('|')}): `, 'g')
const ITEM = /^- \[([^\]\s]+)\] (.*)$/
/** Anything that still names an id, so a mistyped line is skipped rather than read as gone. */
const LOOSE_ITEM = /^\s*[-*+]\s*\[([^\]\s]+)\]/
const ACTIVE_STATUSES = new Set(['open', 'needs-check'])
const DAY = /^\d{4}-\d{2}-\d{2}$/

type Fields = [Key, string][]

/** The fields of one item in order, or why they cannot be read. */
export function parseFields(body: string): { fields: Fields; period: boolean } | { error: string } {
  const matches = [...body.matchAll(FIELD)]
  if (matches.length === 0 || matches[0]!.index !== 0) return { error: 'does not start with a known field' }
  const fields: Fields = []
  for (const [position, match] of matches.entries()) {
    const key = match[1] as Key
    if (fields.some(([seen]) => seen === key)) return { error: `has ${key} twice` }
    const end = matches[position + 1]?.index ?? body.length
    fields.push([key, body.slice(match.index + match[0].length, end)])
  }
  const last = fields[fields.length - 1]!
  const period = last[1].endsWith('.')
  if (period) last[1] = last[1].slice(0, -1)
  return { fields, period }
}

const field = (fields: Fields, key: Key): string | undefined => fields.find(([name]) => name === key)?.[1]

export interface LedgerItem {
  id: string
  /** Line number in the content it was read from, from 0. */
  index: number
  raw: string
  /** Status open or needs-check, in an active section. */
  active: boolean
  next: string
  /** A confirmed deadline, YYYY-MM-DD; `unconfirmed` and anything else is none. */
  deadline: string | undefined
  /** Checked as written, the ledger's evidence for the line's current state. */
  checked: string
  /** The day it was last checked, the first YYYY-MM-DD in Checked. */
  checkedDay: string | undefined
}

export interface Ledger {
  /** Readable items in the active sections, whatever their status. */
  items: LedgerItem[]
  /** Ids of every item in Suppressed. */
  suppressed: Set<string>
  /** Items in an active section that could not be read; the sync leaves their ids alone. */
  skipped: { id: string; index: number; reason: string }[]
}

type Section = 'active' | 'suppressed' | 'other'

const sectionOf = (heading: string): Section =>
  heading === 'Suppressed' ? 'suppressed'
    : heading === 'Maintenance rules' || heading === 'Migration provenance' ? 'other'
      : 'active'

/**
 * Every item, by section. Throws when the file does not look like the ledger (no
 * active section before `## Suppressed`), because a torn or emptied read would
 * otherwise read as "every loop closed".
 */
export function parseLedger(content: string): Ledger {
  const lines = content.split('\n')
  let section: Section = 'other'
  let sawActive = false
  let sawSuppressed = false
  const found: { id: string; index: number; raw: string; body: string | undefined }[] = []
  const suppressed = new Set<string>()
  for (const [index, line] of lines.entries()) {
    const heading = /^## (.+?)\s*$/.exec(line)
    if (heading !== null) {
      section = sectionOf(heading[1]!)
      if (section === 'active' && !sawSuppressed) sawActive = true
      if (section === 'suppressed') sawSuppressed = true
      continue
    }
    const loose = LOOSE_ITEM.exec(line)
    if (loose === null) continue
    const item = ITEM.exec(line)
    if (section === 'suppressed') suppressed.add(loose[1]!)
    else if (section === 'active') found.push({ id: loose[1]!, index, raw: line, body: item?.[2] })
  }
  if (!sawActive || !sawSuppressed) throw new Error('open-loops.md has no active section before ## Suppressed')
  const items: LedgerItem[] = []
  const skipped: Ledger['skipped'] = []
  for (const entry of found) {
    if (found.filter((other) => other.id === entry.id).length > 1) {
      skipped.push({ id: entry.id, index: entry.index, reason: 'the id appears on more than one active line' })
      continue
    }
    if (entry.body === undefined) {
      skipped.push({ id: entry.id, index: entry.index, reason: 'the line is not written as `- [id] Field: …`' })
      continue
    }
    const parsed = parseFields(entry.body)
    if ('error' in parsed) {
      skipped.push({ id: entry.id, index: entry.index, reason: `the line ${parsed.error}` })
      continue
    }
    const next = field(parsed.fields, 'Next')?.trim()
    const status = field(parsed.fields, 'Status')?.trim()
    if (next === undefined || next === '' || status === undefined || status === '') {
      skipped.push({ id: entry.id, index: entry.index, reason: 'the line has no Next or no Status' })
      continue
    }
    // `open (waiting)` would otherwise read as inactive and complete its reminder.
    if (!ACTIVE_STATUSES.has(status) && /^(open|needs-check)\b/.test(status)) {
      skipped.push({ id: entry.id, index: entry.index, reason: `the Status "${status}" is not open or needs-check exactly` })
      continue
    }
    const deadline = field(parsed.fields, 'Deadline')?.trim()
    const checked = field(parsed.fields, 'Checked')?.trim() ?? ''
    items.push({
      id: entry.id,
      index: entry.index,
      raw: entry.raw,
      active: ACTIVE_STATUSES.has(status),
      next,
      deadline: deadline !== undefined && DAY.test(deadline) ? deadline : undefined,
      checked,
      checkedDay: /\d{4}-\d{2}-\d{2}/.exec(checked)?.[0],
    })
  }
  return { items, suppressed, skipped }
}

const TITLE_MAX = 80

/**
 * A reminder title from a Next action: parentheticals and everything after the first
 * `; ` or sentence end dropped, then cut at a word near 80 characters.
 */
export function reminderTitle(next: string): string {
  let title = next
  for (let before = ''; before !== title;) {
    before = title
    title = title.replace(/\s*\([^()]*\)/g, '')
  }
  title = title.split(/; |\. /)[0]!.trim().replace(/[.;,:]+$/, '')
  if (title === '') title = next.trim()
  if (title.length <= TITLE_MAX) return title
  const cut = title.slice(0, TITLE_MAX - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[.;,:]+$/, '')}…`
}

/** The ledger id a reminder's notes carry on their first line, bare or in brackets. */
export function noteId(notes: string | undefined): string | undefined {
  const first = notes?.split('\n')[0]?.trim().replace(/^\[(.*)\]$/, '$1')
  return first !== undefined && /^[^\s[\]]+$/.test(first) ? first : undefined
}

export interface Closure {
  how: 'completed' | 'deleted'
  /** Amsterdam wall time, YYYY-MM-DDTHH:MM: when it was completed, or when the deletion was seen. */
  at: string
}

/** The Suppressed form of an active line: Next becomes `none. Was: …`, every other marker stays. */
export function closedLine(raw: string, closure: Closure): string | undefined {
  const item = ITEM.exec(raw)
  if (item === null) return undefined
  const parsed = parseFields(item[2]!)
  if ('error' in parsed) return undefined
  const { fields, period } = parsed
  const day = closure.at.slice(0, 10)
  const event = closure.how === 'completed'
    ? `completed ${closure.at.replace('T', ' ')}`
    : `reminder deleted, seen ${closure.at.replace('T', ' ')}`
  const set = (key: Key, value: string) => {
    const existing = fields.find(([name]) => name === key)
    if (existing !== undefined) {
      existing[1] = value
      return
    }
    // A missing marker goes in front of Status, where the ledger keeps it.
    const status = fields.findIndex(([name]) => name === 'Status')
    fields.splice(status < 0 ? fields.length : status, 0, [key, value])
  }
  const next = field(fields, 'Next')?.trim().replace(/\.$/, '')
  const source = field(fields, 'Source')
  set('Next', `none. Was: ${next ?? 'unknown'}`)
  set('Source', `Reminders list Open loops, ${event}${source === undefined ? '' : `; ${source}`}`)
  set('Checked', `${day} (Reminders, ${closure.how} by the user)`)
  set('Status', 'closed')
  return `- [${item[1]}] ${fields.map(([key, value]) => `${key}: ${value}`).join('; ')}${period ? '.' : ''}`
}

export type LineEdit =
  /** `line` is what the edit wrote, `previous` the line it replaced. */
  | { outcome: 'edited'; content: string; line: string; previous: string }
  /** Nothing left to do: the line is already in Suppressed, or gone. */
  | { outcome: 'gone' }
  /** The line is there but could not be read or is ambiguous; try again later. */
  | { outcome: 'skipped'; reason: string }

/** After the last item of a section, or after its last line of text when it has none. */
function endOfSection(lines: readonly string[], section: (heading: string) => boolean): number | undefined {
  let inside = false
  let end: number | undefined
  let lastItem: number | undefined
  for (const [index, line] of lines.entries()) {
    const heading = /^## (.+?)\s*$/.exec(line)
    if (heading !== null) {
      if (inside) break
      inside = section(heading[1]!)
      if (inside) end = index + 1
      continue
    }
    if (!inside) continue
    if (ITEM.test(line)) lastItem = index + 1
    else if (line.trim() !== '' && lastItem === undefined) end = index + 1
  }
  return lastItem ?? end
}

/** Moves one active line to the end of Suppressed, closed. Pure; reads `content` afresh. */
export function closeItem(content: string, id: string, closure: Closure): LineEdit {
  const ledger = parseLedger(content)
  const skip = ledger.skipped.find((entry) => entry.id === id)
  if (skip !== undefined) return { outcome: 'skipped', reason: skip.reason }
  // A line someone already marked done or closed in place is theirs to move.
  const item = ledger.items.find((entry) => entry.id === id && entry.active)
  if (item === undefined) return { outcome: 'gone' }
  const written = closedLine(item.raw, closure)
  if (written === undefined) return { outcome: 'skipped', reason: 'the line could not be rewritten' }
  const lines = content.split('\n')
  lines.splice(item.index, 1)
  const at = endOfSection(lines, (heading) => sectionOf(heading) === 'suppressed')
  if (at === undefined) return { outcome: 'skipped', reason: 'there is no Suppressed section' }
  lines.splice(at, 0, written)
  return { outcome: 'edited', content: lines.join('\n'), line: written, previous: item.raw }
}

/**
 * Undoes `closeItem` when its reminder is open again: the Suppressed line, only if it
 * is still exactly what the sync wrote, goes back to the end of the last active section.
 */
export function reopenItem(content: string, id: string, written: string, original: string): LineEdit {
  const ledger = parseLedger(content)
  if (ledger.items.some((entry) => entry.id === id) || ledger.skipped.some((entry) => entry.id === id)) {
    return { outcome: 'gone' }
  }
  const lines = content.split('\n')
  const index = lines.indexOf(written)
  if (index < 0) return { outcome: 'skipped', reason: 'its Suppressed line changed since the sync closed it' }
  lines.splice(index, 1)
  const suppressedAt = lines.findIndex((line) => /^## Suppressed\s*$/.test(line))
  let at: number | undefined
  for (let line = suppressedAt - 1; line >= 0 && at === undefined; line -= 1) {
    if (ITEM.test(lines[line]!)) at = line + 1
  }
  if (at === undefined) return { outcome: 'skipped', reason: 'there is no active section to return it to' }
  lines.splice(at, 0, original)
  return { outcome: 'edited', content: lines.join('\n'), line: original, previous: written }
}

/**
 * Applies a pure edit to the file as it is now. The result is staged in a temporary
 * file first, then the ledger is read once more right before the rename replaces it,
 * and the edit is redone on the fresh file when anyone changed it in between. Dream and
 * the personas take no lock, so what is left is the moment between that last read and
 * the rename. A concurrent reader never sees half a ledger.
 */
export async function editLedger(
  path: string,
  edit: (content: string) => string,
  attempts = 3,
): Promise<'written' | 'unchanged' | 'conflict'> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = await readFile(path, 'utf8')
    const after = edit(before)
    if (after === before) return 'unchanged'
    const { mode } = await stat(path)
    const temporary = `${path}.manor-${process.pid}.tmp`
    await writeFile(temporary, after, { mode })
    if (await readFile(path, 'utf8') !== before) {
      await rm(temporary, { force: true })
      continue
    }
    await rename(temporary, path)
    return 'written'
  }
  return 'conflict'
}
