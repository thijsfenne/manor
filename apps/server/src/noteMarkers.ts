import { createHash } from 'node:crypto'
import { NOTE_MARKER, noteAge, type ServerMessage } from '@manor/contracts'

/**
 * A Notes row in two forms. On disk a Session-owned row ends in a short id of its
 * Session and every other row carries nothing. While the server reconciles, each task
 * row also carries when its text last changed and a fingerprint of that text; those two
 * live in the store between passes (`NoteAges`), so losing them only resets a row's age.
 * The working form is also how rows were stored before 2026-11-17, which is why reading
 * an old file needs no conversion step.
 */
const WORKING = /\s*<!-- manor-note handoff=([^\s]+) updated=(\d+) text=([a-f0-9]+) -->$/
const ON_DISK = /\s*<!-- manor-note ([A-Za-z0-9_-]+) -->$/
const TASK_ROW = /^- \[[ xX]\] /

export interface NoteAge {
  updatedAt: number
  fingerprint: string
}
/** Per project: a Session row by its short id, any other task row by `t:<fingerprint>`. */
export type NoteAges = Record<string, NoteAge>

export const noteFingerprint = (text: string): string =>
  createHash('sha256').update(text.replace(/^- /, '')).digest('hex').slice(0, 16)

/**
 * Enough of a handoff id to tell one thread's Sessions apart; two that collide match no
 * row. A stored id is a UUID; the memory store counts (`handoff_3`), and such a short id
 * is kept whole, since its first characters are the same for every Session.
 */
export const shortNoteId = (handoffId: string): string => handoffId.length <= 12 ? handoffId : handoffId.slice(0, 8)

export const noteText = (line: string): string => line.replace(NOTE_MARKER, '')

/** The short id of the Session that owns the row, in either form. */
export const noteHandoff = (line: string): string | undefined => {
  const working = WORKING.exec(line)?.[1]
  if (working !== undefined) return working === '-' ? undefined : shortNoteId(working)
  return ON_DISK.exec(line)?.[1]
}

/** When the working row's text last changed, and whether it still reads as it did then. */
export const noteStamp = (line: string): { updatedAt: number; current: boolean } | undefined => {
  const marker = WORKING.exec(line)
  return marker === null ? undefined : { updatedAt: Number(marker[2]), current: marker[3] === noteFingerprint(noteText(line)) }
}

/** The working form of a row. Identity survives title changes; the fingerprint dates a hand edit on first sight. */
export function sourceNote(line: string, handoffId: string, updatedAt: number): string {
  const text = noteText(line)
  return `${text} <!-- manor-note handoff=${handoffId === '-' ? '-' : shortNoteId(handoffId)} updated=${updatedAt} text=${noteFingerprint(text)} -->`
}

/** A row as it is stored: its text, and the owning Session's short id when it has one. */
export const diskNote = (line: string, handoffId = noteHandoff(line)): string =>
  handoffId === undefined ? noteText(line) : `${noteText(line)} <!-- manor-note ${shortNoteId(handoffId)} -->`

const ageKey = (line: string): string => noteHandoff(line) ?? `t:${noteFingerprint(noteText(line))}`

/**
 * The file as stored, with each known task row given its date back. A row the store
 * knows nothing about and no Session owns stays bare, so its Session can still be found.
 */
export function hydrateNotes(content: string, ages: NoteAges, now: number): string {
  return content.split('\n').map((line) => {
    if (!TASK_ROW.test(line) || WORKING.test(line)) return line
    const id = noteHandoff(line)
    const age = ages[ageKey(line)]
    if (id === undefined && age === undefined) return line
    const text = noteText(line)
    return `${text} <!-- manor-note handoff=${id ?? '-'} updated=${age?.updatedAt ?? now} text=${age?.fingerprint ?? noteFingerprint(text)} -->`
  }).join('\n')
}

/** Working rows back to their stored form, and the dates to keep for the next pass. */
export function dehydrateNotes(content: string): { content: string; ages: NoteAges } {
  const ages: NoteAges = {}
  const stored = content.split('\n').map((line) => {
    const marker = WORKING.exec(line)
    if (marker === null) return line
    const row = diskNote(line)
    ages[ageKey(row)] = { updatedAt: Number(marker[2]), fingerprint: marker[3]! }
    return row
  })
  return { content: stored.join('\n'), ages }
}

type NoteRow = NonNullable<Extract<ServerMessage, { type: 'project_memory' }>['noteRows']>[number]

/**
 * notes.md as the project memory panel shows it: one row per top-level line, without
 * frontmatter, headings or markers, a wrapped bullet joined to its row. `sessions` names
 * a Session by its short id; an open task row unchanged for three days gets its age.
 */
export function notesRows(content: string, ages: NoteAges, sessions: ReadonlyMap<string, NoteRow['session']>, now: number): NoteRow[] {
  const rows: NoteRow[] = []
  for (const raw of content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').split(/\r?\n/)) {
    if (raw.trim() === '' || /^#{1,6}\s/.test(raw)) continue
    const bullet = /^[-*+]\s+(.*\S)\s*$/.exec(raw)?.[1]
    if (bullet === undefined) {
      if (/^\s+\S/.test(raw) && rows.length > 0) rows[rows.length - 1]!.text += ` ${noteText(raw.trim())}`
      else rows.push({ text: noteText(raw.trim()) })
      continue
    }
    const box = /^\[([ xX])\]\s+/.exec(noteText(bullet))
    if (box === null) {
      rows.push({ text: noteText(bullet) })
      continue
    }
    const done = box[1] !== ' '
    const id = noteHandoff(raw)
    const session = id === undefined ? undefined : sessions.get(id)
    const stored = ages[ageKey(raw)]
    const stamp = noteStamp(raw)
    const updatedAt = stored?.fingerprint === noteFingerprint(noteText(raw)) ? stored.updatedAt : stamp?.current === true ? stamp.updatedAt : undefined
    const age = done || updatedAt === undefined ? undefined : noteAge(updatedAt, now)
    const text = noteText(bullet).slice(box[0].length)
    rows.push({
      // A Session's row leads with its title in the file; its chip already says it.
      text: session !== undefined && text.startsWith(`${session.title}: `) ? text.slice(session.title.length + 2) : text,
      done,
      ...(age === undefined ? {} : { age }),
      ...(session === undefined ? {} : { session }),
    })
  }
  return rows
}
