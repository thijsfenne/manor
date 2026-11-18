import { noteAge, type ThreadEvent, type WorkHandoff } from '@manor/contracts'
import { noteHandoff, noteStamp, noteText, shortNoteId, sourceNote } from './noteMarkers.js'
import type { Store } from './store.js'
import { landedNoteCommit, currentSessionCommits, observeWorkCompletion } from './workCompletion.js'
import { autoBranchName } from './worktree.js'

export { noteHandoff, noteText, sourceNote } from './noteMarkers.js'

/**
 * Confirm checks a Notes row only once nothing is left to land: a result with nothing
 * to commit, or one Git shows on its branch. A commit or merge still running or
 * blocked leaves the row open, so it never claims work that is not on main.
 */
export const confirmedAndLanded = (handoff: Pick<WorkHandoff, 'goalConfirmedAt' | 'goalCompletion'>): boolean =>
  handoff.goalConfirmedAt !== undefined && (handoff.goalCompletion === undefined ||
    handoff.goalCompletion.operation === 'none' || handoff.goalCompletion.status === 'complete')

/** A title or status as one Notes line, the way a Session row writes it. */
export const asLine = (text: string): string => text.replace(/\s+/g, ' ').trim().replace(/^-\s+/, '')

/** The row `start_work` writes for a thread's proposal, before the Session has a status of its own. */
export const proposedNote = (title: string): string => `[ ] ${asLine(title)}: proposed`

/** An open row no Session owns, unchanged this long, is flagged for the thread to check or close. */
export const UNLINKED_STALE_MS = 7 * 86_400_000

export interface NoteSession {
  handoff: WorkHandoff
  settled: boolean
}

export interface NotesGit {
  now: number
  /** Ancestors of main with no observed revert. */
  landed: ReadonlyMap<string, readonly string[]>
}

/** No I/O or title matching. Unknown provenance and uncertain Git evidence leave rows open. */
export function reconcileNotes(rows: readonly string[], handoffs: readonly NoteSession[], git: NotesGit): string[] {
  const sessions = new Map<string, NoteSession>()
  const shared = new Set<string>()
  for (const session of handoffs) {
    const id = shortNoteId(session.handoff.id)
    if (sessions.has(id)) shared.add(id)
    sessions.set(id, session)
  }
  // Two Sessions behind one short id prove nothing about either row.
  for (const id of shared) sessions.delete(id)
  return rows.map((row) => {
    if (!/^- \[[ xX]\] /.test(row)) return row
    const id = noteHandoff(row)
    const session = id === undefined ? undefined : sessions.get(id)
    const stamp = noteStamp(row)
    let updatedAt = stamp?.current === true ? stamp.updatedAt : git.now
    if (session === undefined) return sourceNote(row, id ?? '-', updatedAt)
    const { handoff, settled } = session
    let text = noteText(row)
    if (handoff.acceptedAt === null) {
      // A proposal that never ran: Reject or a newer version closes its row with the reason.
      // Only a stored Reject or replacement closes it; an old Session settled before Accept existed stays open.
      const reason = handoff.supersededById !== undefined ? 'Replaced by a newer proposal'
        : /^Rejected(?: before work started)?\.$/.test(handoff.result ?? '') ? handoff.result!.slice(0, -1) : undefined
      if (handoff.state === 'active' || reason === undefined || !text.startsWith('- [ ] ')) return sourceNote(text, handoff.id, updatedAt)
      const at = new Date(handoff.resultAt ?? git.now).toISOString().slice(0, 10)
      return sourceNote(`${text.replace(/^- \[ \]/, '- [x]')} [${reason}, ${at}]`, handoff.id, git.now)
    }
    if (text === `- ${proposedNote(handoff.title)}`) {
      text = `- [ ] ${asLine(handoff.title)}: accepted`
      updatedAt = git.now
    }
    if (handoff.unsettledAt !== undefined) return sourceNote(text, handoff.id, updatedAt)
    const commits = git.landed.get(handoff.id) ?? []
    const reportedAt = handoff.goalReachedAt ?? handoff.resultAt
    const noCode = reportedAt != null &&
      /(?:^|[.!?;]\s+)no code changes?(?:[.!?;](?:\s|$)|\s*$)/i.test(handoff.goalReport?.result ?? handoff.result ?? '') &&
      (handoff.goalChangedFiles?.length ?? 0) === 0
    const evidence = confirmedAndLanded(handoff)
      ? `Confirmed ${new Date(handoff.goalConfirmedAt!).toISOString().slice(0, 10)}`
      : noCode ? `No code change, reported ${new Date(reportedAt!).toISOString().slice(0, 10)}`
        : settled && commits.length > 0 ? `Landed ${commits.map((hash) => hash.slice(0, 12)).join(', ')}` : undefined
    if (evidence !== undefined && !text.includes(`[${evidence}`)) {
      // Keep the useful report, remove claims the server now disproves.
      text = text.replace(/^- \[ \]/, '- [x]')
        .replace(/(?<!foreign )\buncommitted\b[,:;]?\s*/gi, '')
        .replace(/\bawaiting Confirm\b[.!]?/gi, '')
        .replace(/\b(?:result |report )?awaits Confirm\b[.!]?/gi, '')
        .replace(/\bno stored result or confirmation, so it still needs reconciling with that Session\b/gi, 'landed in main')
        .replace(/[;,]\s*\.?\s*$/, '.')
        .trimEnd()
      text += ` [${evidence}${commits.length > 0 && !evidence.startsWith('Landed ') ? `; ${commits.map((hash) => hash.slice(0, 12)).join(', ')}` : ''}]`
      updatedAt = git.now
    }
    return sourceNote(text, handoff.id, updatedAt)
  })
}

/**
 * Context only, from working rows (`hydrateNotes`). An unchanged open row says its age inline,
 * and one no Session owns past a week asks the thread to check it; age never changes a checkbox or the file.
 */
export function notesContext(content: string, now = Date.now()): string {
  return content.split('\n').map((line) => {
    const stamp = noteStamp(line)
    const age = /^- \[ \] /.test(line) && stamp?.current === true ? noteAge(stamp.updatedAt, now) : undefined
    if (age === undefined) return noteText(line)
    const unlinked = noteHandoff(line) === undefined && now - stamp!.updatedAt >= UNLINKED_STALE_MS
    return `${noteText(line)} (${age}${unlinked ? ', unlinked: check or close' : ''})`
  }).join('\n')
}

/**
 * Old status writes had no id. Recover it only from a unique, successful status tool
 * call bracketing the exact write event. Owner rewrites and title guesses prove nothing.
 */
export function legacyNoteSources(
  threadEvents: readonly ThreadEvent[], sessions: readonly { handoff: WorkHandoff; events: readonly ThreadEvent[] }[],
): Map<string, { handoffId?: string; updatedAt: number }> {
  const calls = sessions.flatMap(({ handoff, events }) => events.flatMap((event) => {
    if (event.type !== 'tool_use' || !/(?:^|__)set_session_status$/.test(event.tool) || event.toolCallId === undefined) return []
    const end = events.find((candidate) => candidate.type === 'tool_result' && candidate.toolCallId === event.toolCallId && candidate.outcome === 'success')
    return end === undefined ? [] : [{ handoffId: handoff.id, title: handoff.title, start: event.ts, end: end.ts }]
  }))
  const sources = new Map<string, { handoffId?: string; updatedAt: number }>()
  const ambiguous = new Set<string>()
  for (const event of threadEvents) {
    if (event.type !== 'system_note' || event.projectFileWrite?.file !== 'notes.md' || event.projectFileWrite.line === undefined) continue
    const write = event.projectFileWrite
    const key = noteText(`- ${write.line}`)
    const matches = calls.filter((call) => call.title === write.by && call.start <= event.ts && event.ts <= call.end)
    const source = { handoffId: matches.length === 1 ? matches[0]!.handoffId : undefined, updatedAt: event.ts }
    if (sources.has(key) && sources.get(key)!.handoffId !== source.handoffId) ambiguous.add(key)
    sources.set(key, source)
  }
  for (const key of ambiguous) sources.set(key, { updatedAt: sources.get(key)!.updatedAt })
  return sources
}

export async function loadNotesEvidence(
  store: Store, threadChatId: string, content: string, now = Date.now(),
  cachedSources?: ReturnType<typeof legacyNoteSources>,
) {
  // Proposals count too: their row exists from start_work on, and Reject or a newer version closes it.
  const proposals = (await store.listWorkHandoffs()).filter((handoff) => handoff.sourceChatId === threadChatId && handoff.version > 0 && handoff.state !== 'deleted')
  const handoffs = proposals.filter((handoff) => handoff.workChatId !== null && handoff.acceptedAt !== null)
  const sessions: NoteSession[] = proposals.filter((handoff) => handoff.acceptedAt === null).map((handoff) => ({ handoff, settled: false }))
  const needsSources = cachedSources === undefined && content.split('\n').some((line) => /^- \[ \] /.test(line) && noteHandoff(line) === undefined)
  const history = needsSources ? await Promise.all(handoffs.map(async (handoff) => ({
    handoff, events: await store.loadEvents(handoff.workChatId!),
  }))) : []
  const sources = cachedSources ?? (needsSources ? legacyNoteSources(await store.loadEvents(threadChatId), history) : new Map())
  const rows = content.split('\n').map((line) => {
    if (!/^- \[[ xX]\] /.test(line)) return line
    let source = sources.get(line)
    // An explicit, unique Session branch is an id reference too, never a title match.
    const branch = line.match(/^- \[[ xX]\] [^\n]+?: reported Done on (manor\/[a-f0-9]{8})\b/i)?.[1]
    if (source?.handoffId === undefined && branch !== undefined) {
      const matches = handoffs.filter((handoff) => autoBranchName(handoff.workChatId!) === branch)
      if (matches.length === 1) source = { handoffId: matches[0]!.id, updatedAt: matches[0]!.resultAt ?? matches[0]!.acceptedAt! }
    }
    return noteHandoff(line) !== undefined || source === undefined ? line : sourceNote(line, source.handoffId ?? '-', source.updatedAt)
  })
  const landed = new Map<string, string[]>()
  const checked = new Map<string, Promise<string | undefined>>()
  const prove = (root: string, hash: string) => {
    const key = `${root}\0${hash}`
    if (!checked.has(key)) checked.set(key, landedNoteCommit(root, hash))
    return checked.get(key)!
  }
  for (const handoff of handoffs) {
    const chat = await store.getChat(handoff.workChatId!)
    const settled = chat?.settledAt != null
    sessions.push({ handoff, settled })
    const ownRows = rows.filter((row) => noteHandoff(row) === shortNoteId(handoff.id) && /^- \[ \] /.test(row))
    if (ownRows.length === 0 || handoff.unsettledAt !== undefined) continue
    const candidates = [...handoff.goalCompletion?.commits ?? []]
    let complete = true
    const project = await store.getProject(handoff.projectId)
    const mappings = await store.loadChatWorktrees(handoff.workChatId!)
    if (settled) {
      // A manual commit after the report can satisfy the server's captured result without Confirm.
      const held = handoff.goalCompletion
      if (held !== undefined && held.repos.length > 0) {
        const observed = await observeWorkCompletion({ ...held, repos: held.repos.map((repo) => ({
          ...repo, branch: repo.sourcePath === undefined ? 'main' : repo.branch,
          ...(repo.sourcePath === undefined ? {} : { mergeInto: 'main' }),
        })) }, await store.loadEvents(handoff.workChatId!))
        if (observed.status === 'complete') candidates.push(...observed.commits ?? [])
        else complete = false
      }
      for (const mapping of mappings) {
        for (const hash of await currentSessionCommits(mapping.sourcePath, mapping.branch)) candidates.push({ path: mapping.sourcePath, hash })
      }
      // A server-written, source-bound status may name a manual commit without Confirm.
      for (const row of ownRows) {
        const branch = noteText(row).match(/\bmanor\/[a-f0-9]{8}\b/)?.[0]
        if (branch !== undefined && branch === autoBranchName(handoff.workChatId!)) {
          for (const root of project?.repoPaths ?? []) {
            for (const hash of await currentSessionCommits(root, branch)) candidates.push({ path: root, hash })
          }
        }
        const prefix = `- [ ] ${handoff.title.replace(/\s+/g, ' ').trim()}: `
        const status = noteText(row).startsWith(prefix) ? noteText(row).slice(prefix.length) : ''
        // Only an affirmative status sentence says this Session committed, never a mention or negation.
        const claims = status.matchAll(/(?:^|[.!?]\s+)committed(?: locally)?(?: as)?\s+([a-f0-9]{7,40}(?:(?:,\s*|\s+and\s+)[a-f0-9]{7,40})*)\b/gi)
        for (const hash of [...claims].flatMap((claim) => claim[1]!.match(/\b[a-f0-9]{7,40}\b/gi) ?? [])) {
          let found = false
          for (const root of project?.repoPaths ?? []) {
            const resolved = await prove(root, hash)
            if (resolved === undefined) continue
            candidates.push({ path: root, hash: resolved })
            found = true
            break
          }
          if (!found) complete = false
        }
      }
    }
    if (candidates.length === 0) continue
    const proved: string[] = []
    for (const candidate of candidates) {
      const root = mappings.find((mapping) => mapping.worktreePath === candidate.path)?.sourcePath ?? candidate.path
      const hash = await prove(root, candidate.hash)
      if (hash === undefined) { complete = false; break }
      proved.push(hash)
    }
    if (complete) landed.set(handoff.id, [...new Set(proved)])
  }
  return { rows, sessions, sources, git: { now, landed } }
}
