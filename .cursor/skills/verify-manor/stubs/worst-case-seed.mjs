#!/usr/bin/env node
// Seeds a running spike with worst-case data for a UI stress test: long, one-letter,
// non-Latin and unbroken names, long paths and addresses, many rows and counts of one.
// Everything goes in through the spike's own socket and the mock driver's phrases, the
// same boundary real data uses; nothing here exists in the shipped app.
// Usage: node stubs/worst-case-seed.mjs <spike origin, e.g. http://127.0.0.1:43181>
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const origin = process.argv[2]
if (!/^http:\/\/127\.0\.0\.1:431(8\d|9\d)$/.test(origin ?? '') || origin.endsWith(':43179')) {
  console.error('Pass the spike origin printed by launch, e.g. http://127.0.0.1:43181.')
  process.exit(1)
}

const ROOT = '/tmp/manor-worst-case'
const REPO = join(ROOT, 'klanttevredenheidsonderzoek-resultaten-2026')
const FILES = join(ROOT, 'files')

export const WORST = {
  agents: [
    { key: 'long', name: 'Aleksandra Wiśniewska-Kowalczyk', role: 'Senior Product Design Engineer, Platform Infrastructure', description: 'Plans the research rounds, keeps the client tracks moving and writes the weekly summary for the steering group.', color: '#C77DBB', railPinned: true },
    { key: 'one', name: 'J', role: '', description: '', color: '#7A9CC6' },
    { key: 'cjk', name: '王秀英', role: 'Specialist', description: '季度报告审核', color: '#E0A458', pinned: true },
    { key: 'compound', name: 'Arbeidsongeschiktheidsverzekeringsadviseur', role: 'Verzekeringsspecialist', description: 'Runs insurance research Sessions.', color: '#B7C9B1', placement: 'session', railPinned: true },
  ],
  project: 'Klanttevredenheidsonderzoeksresultatenrapportage 2026',
  shortProject: 'X',
  sessionTitles: [
    'Exporteer het volledige gesprek als Markdown met alle bijlagen, screenshots en de toolactiviteit voor het klantarchief',
    'A',
    'https://example.com/workspaces/acme/projects/q3-launch/docs/9f8e7d6c5b4a?tab=comments&filter=unresolved',
    'Hypotheekrenteaftrekberekeningsspreadsheet',
    '季度报告审核',
    'Release 🚀 notes',
  ],
  runtimeReason: 'needs deep reasoning across the migration history, the review findings and the three earlier attempts that failed',
  mail: {
    to: 'bartholomew.fitzgerald@regional-logistics-holdings.example.com',
    cc: 'first.last+billing-notifications@example.com, ops@sub.department.region.example.test, a@b.test',
  },
  pictures: [
    'IMG_20250914_183022_HDR_portrait_edited_edited.png',
    'Schermafbeelding-2026-11-17-om-14.32.07-klanttevredenheidsdashboard-donker.png',
    'a.png',
  ],
  deliveries: [
    'verzekeringsvoorwaardenoverzicht-arbeidsongeschiktheid-2026-definitief.md',
    'IMG_20250914_183022_HDR_portrait_edited_edited.png',
  ],
  attachment: 'Q3 Board Deck — FINAL (revised) v12 [approved by legal].md',
  longPath: 'apps/mobile/src/components/conversation/attachments/AttachmentPreviewSheetWithAccessibilityLabels.tsx',
}

const socket = new WebSocket(`${origin.replace('http', 'ws')}/ws`)
const inbox = []
const waiters = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  inbox.push(message)
  if (message.type === 'notice' && message.kind === 'error') console.error(`notice: ${message.text}`)
  for (const waiter of [...waiters]) if (waiter.match(message)) {
    waiters.splice(waiters.indexOf(waiter), 1)
    waiter.resolve(message)
  }
})
const next = (match, ms = 20_000) => {
  const found = inbox.find(match)
  if (found !== undefined) return Promise.resolve(found)
  return new Promise((resolve, reject) => {
    const waiter = { match, resolve }
    waiters.push(waiter)
    setTimeout(() => reject(new Error('timed out waiting for the spike')), ms)
  })
}
const latest = (type) => [...inbox].reverse().find((message) => message.type === type)
let counter = 0
const request = async (message, answer) => {
  const requestId = `worst-${Date.now()}-${counter += 1}`
  socket.send(JSON.stringify({ ...message, requestId }))
  return next((reply) => reply.requestId === requestId && (answer === undefined || reply.type === answer || reply.type === 'notice'))
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})
await next((message) => message.type === 'roster')
await next((message) => message.type === 'directory')

// Files: a git folder for the project, pictures under long names, a markdown delivery.
mkdirSync(FILES, { recursive: true })
execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'dm-files-fixture.mjs'), FILES], { stdio: 'pipe' })
const sample = readdirSync(FILES).find((name) => name.endsWith('.png'))
for (const name of WORST.pictures) copyFileSync(join(FILES, sample), join(FILES, name))
writeFileSync(join(FILES, WORST.deliveries[0]), '# Verzekeringsvoorwaarden\n\nArbeidsongeschiktheid, overzicht 2026.\n')
const freshRepo = !existsSync(join(REPO, '.git'))
if (freshRepo) {
  mkdirSync(REPO, { recursive: true })
  git(REPO, ['init', '-q', '-b', 'main'])
  git(REPO, ['config', 'user.name', 'Fixture'])
  git(REPO, ['config', 'user.email', 'fixture@example.com'])
  writeFileSync(join(REPO, 'README.md'), '# Fixture\n')
  git(REPO, ['add', '.'])
  git(REPO, ['commit', '-q', '-m', 'Start'])
}

// Agents, from an existing persona so every required field is real.
const template = latest('roster').agents.find((agent) => !agent.isCos) ?? latest('roster').agents[0]
const { id: _id, allowedTools: _tools, avatar: _avatar, avatarShape: _shape, mentionAllowlist: _allow, pinned: _pin, railPinned: _rail, ...base } = template
for (const agent of WORST.agents) {
  const { key: _key, ...fields } = agent
  if (latest('roster').agents.some((existing) => existing.name === agent.name)) continue
  await request({ type: 'save_agent', agent: { ...base, ...fields, isCos: false, character: `You are ${agent.name}.` } })
  await next((message) => message.type === 'roster' && message.agents.some((existing) => existing.name === agent.name))
}
const roster = latest('roster').agents
const idOf = (key) => roster.find((agent) => agent.name === WORST.agents.find((entry) => entry.key === key).name).id
const cos = roster.find((agent) => agent.isCos)

// Projects: the long one linked to the git folder with a thread, and a one-letter one with nothing in it.
const projectId = async (name, repoPaths) => {
  const existing = latest('directory').projects.find((project) => project.name === name)
  if (existing !== undefined) return existing.id
  const created = await request({ type: 'create_project', name, repoPaths }, 'project_created')
  await request({ type: 'create_project_thread', projectId: created.projectId })
  return created.projectId
}
const longProject = await projectId(WORST.project, [REPO])
// A new fixture folder leaves an earlier run's worktree folders pointing at nothing; Manor refuses to reuse them.
const port = new URL(origin).port
if (freshRepo) rmSync(join(port === '43180' ? '/tmp/manor-electron-spike' : `/tmp/manor-electron-spike-${port}`, 'worktrees', longProject), { recursive: true, force: true })
await projectId(WORST.shortProject, [])

const create = async (fields) => (await request({ type: 'create_chat', ...fields }, 'chat_created')).chatId
const settle = () => sleep(4_000)

// Sessions with long, short, URL, compound, CJK and emoji titles, each on a phrase that fills one surface.
const openings = [
  `mock read images: ${WORST.pictures.map((name) => join(FILES, name)).join(',')},${join(FILES, WORST.pictures[0])},${join(FILES, WORST.pictures[1])} | ${join(REPO, WORST.longPath)}`,
  'draft gmail to ' + WORST.mail.to + ' cc ' + WORST.mail.cc + ': Beste Bartholomew, hierbij de aangepaste planning voor de verbouwing, inclusief het meerwerk en de definitieve materiaalkeuze.',
  `mock report: Het klanttevredenheidsonderzoek is verwerkt tot een rapportage met alle deelresultaten per regio, segment en kwartaal, inclusief de verbeterpunten die uit de open antwoorden naar voren kwamen | De open antwoorden uit Vlaanderen zijn nog niet vertaald en ontbreken daarom in de regionale vergelijking points: Hypotheekrenteaftrekberekeningsspreadsheet bijgewerkt met de nieuwe tarieven / AttachmentPreviewSheetWithAccessibilityLabelsAndKeyboardNavigation.tsx / Eén regel choices: Rapportagevorm {Moet de rapportage als één lang document of als losse hoofdstukken per regio worden aangeleverd aan de stuurgroep?} = Eén document met alle regio's en bijlagen / Losse hoofdstukken per regio*; X = Ja / Nee`,
  'mock code edit: export const x = 1',
  'Hoi',
  'long reply',
]
const sessionIds = []
for (const [index, title] of WORST.sessionTitles.entries()) {
  if (latest('directory').chats.some((chat) => chat.title === title)) continue
  sessionIds.push(await create({ mode: 'single', projectId: longProject, title, openingMessage: { text: openings[index] } }))
  await settle()
}

// A worktree Session whose hand-written files have long paths, for the Changes row and the diff.
const worktreeTitle = 'Wijzigingen met lange paden'
if (!latest('directory').chats.some((chat) => chat.title === worktreeTitle)) {
  await create({ mode: 'single', projectId: longProject, title: worktreeTitle, checkout: { mode: 'worktree' }, openingMessage: { text: 'Hoi' } })
  await settle()
  const worktrees = git(REPO, ['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9)).slice(1)
  for (const tree of worktrees) {
    for (const file of [WORST.longPath, 'docs/verzekeringsvoorwaardenoverzicht-arbeidsongeschiktheid-2026-definitief.md', 'a']) {
      mkdirSync(dirname(join(tree, file)), { recursive: true })
      writeFileSync(join(tree, file), `export const label = '${'Arbeidsongeschiktheidsverzekeringsadviseur'.repeat(4)}'\n`)
    }
  }
}

// DMs: the long-named agent, the one-letter one, and the chief of staff carrying the proposal, files and consultations.
const dm = async (agentId, text) => {
  const existing = latest('directory').chats.find((chat) => chat.kind === 'dm' && chat.memberIds?.length === 1 && chat.memberIds[0] === agentId)
  if (existing !== undefined) {
    socket.send(JSON.stringify({ type: 'send_message', chatId: existing.id, text }))
    return existing.id
  }
  return create({ kind: 'dm', memberIds: [agentId], openingMessage: { text } })
}
await dm(idOf('long'), 'Kun je de rapportage van het klanttevredenheidsonderzoek voor de stuurgroep klaarzetten?')
await settle()
await dm(idOf('one'), 'Hoi')
await settle()
const cosDm = await dm(cos.id, `mock start work Smith in ${WORST.project}: Verwerk de open antwoorden van het klanttevredenheidsonderzoek tot een rapportage per regio, segment en kwartaal. Done when de stuurgroep elke regio kan vergelijken.`)
await settle()
for (const name of WORST.deliveries) {
  socket.send(JSON.stringify({ type: 'send_message', chatId: cosDm, text: `mock deliver: ${join(FILES, name)}` }))
  await settle()
}
socket.send(JSON.stringify({ type: 'send_message', chatId: cosDm, text: 'Voor het dossier.', files: [{ name: WORST.attachment, mime: 'text/markdown', content: '# Q3\n' }] }))
await settle()
socket.send(JSON.stringify({ type: 'send_message', chatId: cosDm, text: `Ask ${WORST.agents[0].name} wat de stand van de rapportage is.` }))
await settle()

// A quote chip: the chief of staff's last reply, quoted whole.
socket.send(JSON.stringify({ type: 'open_chat', chatId: cosDm }))
const snapshot = await next((message) => message.type === 'snapshot' && message.chatId === cosDm)
const reply = [...(snapshot.events ?? [])].reverse().find((event) => event.type === 'agent_message' && event.text.length > 20)
if (reply !== undefined) {
  const text = reply.text.slice(0, 280)
  socket.send(JSON.stringify({ type: 'send_message', chatId: cosDm, text: '[Quote #1] Klopt dit nog?', quotes: [{ kind: 'message', eventId: reply.id, agentId: reply.agentId, text }] }))
  await settle()
}

// The project thread proposes with a long runtime reason; one proposal is accepted and its Session reports.
const thread = latest('directory').projects.find((project) => project.id === longProject)?.threadChatId
if (thread) {
  const task = 'Verwerk de open antwoorden van het klanttevredenheidsonderzoek tot een rapportage per regio, segment en kwartaal, met de verbeterpunten per klantsegment. Done when de stuurgroep elke regio kan vergelijken.'
  socket.send(JSON.stringify({ type: 'send_message', chatId: thread, text: `mock start work ${WORST.agents[3].name} in ${WORST.project} key wc-open on claude/claude-opus-5-5/high for ${WORST.runtimeReason}: ${task}` }))
  await settle()
  socket.send(JSON.stringify({ type: 'send_message', chatId: thread, text: `mock start work ${WORST.agents[3].name} in ${WORST.project} key wc-report: Schrijf de managementsamenvatting van het klanttevredenheidsonderzoek. Done when hij op één pagina past.` }))
  await settle()
  const handoff = latest('directory').workHandoffs.find((entry) => entry.assignmentKey === 'wc-report' && entry.state === 'active')
  if (handoff !== undefined) {
    await request({ type: 'accept_work_handoff', handoffId: handoff.id, mode: 'single', checkout: { mode: 'current' } })
    await settle()
    const session = latest('directory').workHandoffs.find((entry) => entry.id === handoff.id)?.workChatId
    if (session) {
      socket.send(JSON.stringify({ type: 'send_message', chatId: session, text: openings[2] }))
      await sleep(8_000)
    }
  }
}

// Many rows: thirty more Sessions in the long project for list length and Show more.
const filler = ['Offerte keuken', 'Planning Q1', 'Belastingaangifte 2025', 'Vakantie Portugal', 'Nieuwsbrief december', 'Contract verlengen']
const existingTitles = new Set(latest('directory').chats.map((chat) => chat.title))
for (let index = 0; index < 30; index += 1) {
  const title = `${filler[index % filler.length]} ${index + 1}`
  if (existingTitles.has(title)) continue
  await create({ mode: 'single', projectId: longProject, title })
}

await sleep(1_000)
console.log(JSON.stringify({ ok: true, project: longProject, sessions: sessionIds.length, agents: WORST.agents.map((agent) => agent.name), files: FILES, repo: REPO }))
socket.close()
process.exit(0)
