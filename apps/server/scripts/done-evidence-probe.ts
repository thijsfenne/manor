// Red-team probe: flags a Session's Done report when nothing after its last code change proved it.
//
//   pnpm --filter @manor/server exec tsx scripts/done-evidence-probe.ts [--last 20] [--project Manor] [--db path]
//
// Replayed from the transcript alone, since old file times are gone:
//   - the last code change is the last edit tool call naming a non-prose file, or a later shell command in that turn
//     that rewrites one of its changed code files in place (`sed -i`, a Python or Perl rewrite, a redirect into it);
//     a turn whose measured changes no edit call named is placed at its last writing shell command or subagent
//     collection;
//   - evidence is a successful screenshot (a screenshot tool, the spike's `screenshot` command, or an image the agent
//     opened), or a successful test, typecheck, build or script run.
// `flagged` is a Done with no evidence at all after the last code change. `gate` is what `goal_reached` now
// refuses (src/goalEvidence.ts): a changed UI file also needs a screenshot after it, shown with the result.
// The live SQLite file is opened read-only.
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ThreadEvent } from '@manor/contracts'
import { shellMayWrite } from '../src/drivers/commands.js'
import { checkRunTimes, isUiFile, runsCheck, withoutHeredocs } from '../src/goalEvidence.js'
import { isProse } from '../src/goalReview.js'

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const last = Number(option('last') ?? 20)
const projectFilter = option('project')
const filename = option('db') ?? path.join(homedir(), '.manor', 'sqlite', 'manor.db')
const db = new DatabaseSync(filename, { readOnly: true })

const IMAGE = /\.(png|jpe?g|webp)$/i
const COLLECTS_CHILD = /(task_result|spawn_subagent|^agent$|^task$|^await$)/i

type Change = { at: number; ui: boolean; file: string }

/** Whether this shell command rewrites one of these files in place, as an agent's shell edit does. */
const rewrites = (command: string, files: readonly string[]) => files.some((file) => {
  const name = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${name}\\b`).test(command) &&
    (/\bsed\s+(-\S+\s+)*-i|\bperl\s+-\S*i|\bpython3?\b|\bnode\s+-e\b/.test(command) || new RegExp(`>>?\\s*\\S*${name}\\b`).test(command))
})

function lastChanges(events: readonly ThreadEvent[]): { code?: Change; ui?: Change } {
  const changes: Change[] = []
  const named = new Set<string>()
  for (const event of events) {
    if (event.type !== 'tool_use' && event.type !== 'tool_result') continue
    for (const edit of event.edits ?? []) {
      if (isProse(edit.path) || event.ts === undefined) continue
      changes.push({ at: event.ts, ui: isUiFile(edit.path), file: edit.path })
      if (event.turnId !== undefined) named.add(event.turnId)
    }
  }
  for (const event of events) {
    if (event.type !== 'turn_result') continue
    const files = (event.fileChanges ?? []).map((file) => file.path).filter((file) => !isProse(file))
    if (files.length === 0) continue
    const writer = events.filter((row) => row.type === 'tool_use' && row.turnId === event.turnId && row.ts !== undefined &&
      (row.command === undefined || ((row.edits ?? []).length === 0 && !runsCheck(row))) && (named.has(event.turnId)
        ? row.command !== undefined && rewrites(row.command, files)
        : (row.command !== undefined && shellMayWrite(row.command)) || COLLECTS_CHILD.test(row.tool))).at(-1)
    if (writer?.type !== 'tool_use' || writer.ts === undefined) continue
    const file = named.has(event.turnId) ? files.find((name) => rewrites(writer.command ?? '', [name]))! : files[0]!
    changes.push({ at: writer.ts, ui: named.has(event.turnId) ? isUiFile(file) : files.some(isUiFile), file })
  }
  const latest = (rows: Change[]) => rows.reduce<Change | undefined>((best, row) => best === undefined || row.at > best.at ? row : best, undefined)
  return { code: latest(changes), ui: latest(changes.filter((change) => change.ui)) }
}

/** When each screenshot that succeeded was taken: a screenshot tool, the spike's `screenshot` command, or an image the agent opened. */
function screenshotTimes(events: readonly ThreadEvent[]): number[] {
  const shots = new Map<string, number>()
  const times: number[] = []
  for (const event of events) {
    if (event.type === 'tool_use' && event.ts !== undefined && event.toolCallId !== undefined && (/screenshot/i.test(event.tool) ||
      (event.command !== undefined && /\b(screenshot|screencapture)\b/i.test(withoutHeredocs(event.command))) ||
      (/^(read|read_file|view_image)$/i.test(event.tool) && [...event.targets ?? [], event.detail ?? ''].some((target) => IMAGE.test(target))))) {
      shots.set(event.toolCallId, event.ts)
    }
    const taken = event.type === 'tool_result' && event.outcome === 'success' ? shots.get(event.toolCallId) : undefined
    if (taken !== undefined) times.push(taken)
  }
  return times
}

const reports = db.prepare(
  `select e.chat_id as chatId, e.seq as seq, e.event_id as eventId, e.payload as payload
     from events e
    where json_extract(e.payload, '$.type') = 'system_note' and json_extract(e.payload, '$.workGoalHandoffId') is not null
    order by e.seq desc`,
).all() as { chatId: string; seq: number; eventId: string; payload: string }[]
const handoff = db.prepare(`select value from records where collection = 'workHandoffs' and json_extract(value, '$.id') = ?`)
const eventsUpTo = db.prepare(`select payload from events where chat_id = ? and seq <= ? order by seq`)
const chatEvents = db.prepare(`select payload from events where chat_id = ? order by seq`)

/** Checks that subagents finished in their own chats by `until`, followed through nested subagents, as the gate counts them. */
function childCheckTimes(events: readonly ThreadEvent[], until: number): number[] {
  const children = (from: readonly ThreadEvent[]) =>
    from.flatMap((event) => event.type === 'tool_use' && event.subagent?.childChatId !== undefined ? [event.subagent.childChatId] : [])
  const seen = new Set<string>()
  const times: number[] = []
  for (const queue = children(events); queue.length > 0;) {
    const chatId = queue.shift()!
    if (seen.has(chatId)) continue
    seen.add(chatId)
    const child = (chatEvents.all(chatId) as { payload: string }[]).map((row) => JSON.parse(row.payload) as ThreadEvent)
      .filter((event) => (event.ts ?? Infinity) <= until)
    times.push(...checkRunTimes(child))
    queue.push(...children(child))
  }
  return times
}

const rows = []
for (const report of reports) {
  if (rows.length >= last) break
  const note = JSON.parse(report.payload) as Extract<ThreadEvent, { type: 'system_note' }>
  const work = handoff.get(note.workGoalHandoffId!) as { value: string } | undefined
  const record = work === undefined ? undefined : JSON.parse(work.value) as { title?: string; projectName?: string }
  if (projectFilter && record?.projectName !== projectFilter) continue
  const events = (eventsUpTo.all(report.chatId, report.seq) as { payload: string }[]).map((row) => JSON.parse(row.payload) as ThreadEvent)
  const { code, ui } = lastChanges(events)
  const shots = screenshotTimes(events)
  const reportedAt = events.at(-1)?.ts ?? Infinity
  const checks = [...checkRunTimes(events), ...childCheckTimes(events, reportedAt)]
  const shown = (note.goalReport?.evidence?.length ?? 0) > 0 || events.some((event) => event.type === 'tool_use' &&
    /deliver_file$/.test(event.tool) && IMAGE.test(event.detail ?? event.targets?.[0] ?? '') && (ui === undefined || (event.ts ?? 0) >= ui.at))
  const after = (times: number[], change: Change | undefined) => change === undefined || times.some((time) => time >= change.at)
  const flag = after([...checks, ...shots], code) ? '-' : `nothing after ${path.basename(code!.file)} changed`
  const gate = flag !== '-' ? 'refuse'
    : ui !== undefined && !after(shots, ui) ? `refuse: no screenshot after ${path.basename(ui.file)}`
      : ui !== undefined && !shown ? 'refuse: no screenshot shown' : '-'
  rows.push({
    session: (record?.title ?? '?').slice(0, 58),
    report: `${report.chatId.slice(0, 8)}/${report.eventId}`,
    changed: code === undefined ? 'no code' : ui === undefined ? 'code' : 'UI',
    flagged: flag,
    gate,
  })
}
db.close()

console.log(`Last ${rows.length} Done reports from ${filename} (read-only)\n`)
console.table(rows)
console.log(`\n${rows.filter((row) => row.flagged !== '-').length} of ${rows.length} flagged.`)
