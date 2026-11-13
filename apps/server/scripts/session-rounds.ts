// Counts how often the user had to come back to a Session, per project, from the live SQLite file opened read-only.
//
//   pnpm --filter @manor/server exec tsx scripts/session-rounds.ts [--days 30] [--project Manor] [--db path] [--labels labels.json]
//
// Columns:
//   raw        every user_message in the Session chat, the kickoff and background wakes included (the 2026-10-18 baseline counted this way)
//   follow-ups messages the user sent after the kickoff, forwarded project-thread messages included; the kickoff, background wakes
//              and Manor's own prompts (the commit request after Confirm: `instruction`, or "[Manor] …" in older rows) are left out
//   defects    only with --labels: follow-ups whose label is not new-wish or non-defect (a JSON array of {chat_id, event_id, label})
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const NOT_DEFECTS = new Set(['new-wish', 'non-defect'])

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const days = Number(option('days') ?? 30)
const projectFilter = option('project')
const filename = option('db') ?? path.join(homedir(), '.manor', 'sqlite', 'manor.db')
const labelsFile = option('labels')
const since = Date.now() - days * 86_400_000

const labels = new Map<string, string>()
if (labelsFile) {
  for (const row of JSON.parse(readFileSync(labelsFile, 'utf8')) as { chat_id: string; event_id: string; label: string }[]) {
    labels.set(`${row.chat_id}/${row.event_id}`, row.label)
  }
}

const db = new DatabaseSync(filename, { readOnly: true })

const handoffs = db
  .prepare(
    `select json_extract(value, '$.workChatId') as chatId, json_extract(value, '$.projectName') as project
       from records
      where collection = 'workHandoffs'
        and json_extract(value, '$.workChatId') is not null
        and json_extract(value, '$.createdAt') >= ?`,
  )
  .all(since) as { chatId: string; project: string | null }[]

const messages = db.prepare(
  `select event_id as eventId, json_extract(payload, '$.source') as source, substr(json_extract(payload, '$.text'), 1, 7) as head,
          json_extract(payload, '$.instruction') is not null as instructed
     from events
    where chat_id = ? and json_extract(payload, '$.type') = 'user_message'`,
)

type Tally = { sessions: number; raw: number[]; followUps: number[]; defects: number[] }
const byProject = new Map<string, Tally>()

for (const { chatId, project } of handoffs) {
  const name = project ?? '(no project)'
  if (projectFilter && name !== projectFilter) continue
  const rows = messages.all(chatId) as { eventId: string; source: string | null; head: string | null; instructed: number }[]
  const followUps = rows.filter(
    (row) => row.source !== 'work_handoff' && row.source !== 'background_wake' && row.head !== '[Manor]' && !row.instructed,
  )
  const defects = followUps.filter((row) => {
    const label = labels.get(`${chatId}/${row.eventId}`)
    return label !== undefined && !NOT_DEFECTS.has(label)
  })
  const tally = byProject.get(name) ?? { sessions: 0, raw: [], followUps: [], defects: [] }
  tally.sessions += 1
  tally.raw.push(rows.length)
  tally.followUps.push(followUps.length)
  tally.defects.push(defects.length)
  byProject.set(name, tally)
}

db.close()

const average = (values: number[]) => (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)
const shareAtLeast4 = (values: number[]) => {
  const hits = values.filter((value) => value >= 4).length
  return `${((100 * hits) / values.length).toFixed(1)}% (${hits})`
}

console.log(`Sessions created in the last ${days} days, from ${filename} (read-only)\n`)
const table = [...byProject.entries()]
  .sort((a, b) => b[1].sessions - a[1].sessions)
  .map(([project, tally]) => ({
    project,
    sessions: tally.sessions,
    'raw avg': average(tally.raw),
    'raw ≥4': shareAtLeast4(tally.raw),
    'follow-ups avg': average(tally.followUps),
    'follow-ups ≥4': shareAtLeast4(tally.followUps),
    ...(labelsFile ? { 'defects avg': average(tally.defects), 'defects ≥4': shareAtLeast4(tally.defects) } : {}),
  }))
console.table(table)
