/**
 * Dev-only stand-in for apps/server: a scripted Manor workspace on
 * ws://localhost:8787/ws, with project, home and agent-pair chats plus canned history.
 *
 * Run it with `node apps/web/dev/fake-server.mjs`, then `pnpm --filter @manor/web dev`.
 * It speaks the frozen ServerMessage/ClientMessage protocol so the UI can be
 * driven without burning a real subscription turn.
 *
 * Turns are queued per chat, not globally, so two chats can stream at once and
 * the client's cross-chat filtering is actually exercised.
 *
 * The WebSocket framing is hand-rolled because `ws` is not a dependency of
 * @manor/web. It handles what a browser actually
 * sends for a chat app: single-frame masked text, ping, and close. Fragmented
 * or >64KiB client frames are not supported and would need a real ws library.
 */
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Overridable so the fake can run beside a real apps/server on the default port. */
const PORT = Number(process.env.MANOR_FAKE_PORT ?? 8787)
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const DEFAULT_PROJECT_ICON = 'folder'
const DEFAULT_PROJECT_COLOR = '#8A8F98'

/** A real 1x1 PNG, so one persona in the seed has a picture and one path is not theoretical. */
const SEED_AVATAR =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * The household. Mutable, because save_agent and delete_agent edit it; the client
 * only ever learns it through a `roster` message, never through a snapshot.
 */
// Nova and Pike wear real drivers (never run here, replies stay canned) so the
// composer's runtime menu shows both provider marks and a populated model list.
const agents = [
  {
    id: 'nova',
    name: 'Nova',
    color: '#7aa2f7',
    character: 'Chief of staff. Plans, delegates, keeps the house running.',
    driver: 'claude',
    model: 'claude-fable-5-2',
    effort: 'high',
    allowedTools: [],
    memoryScope: true,
    description: 'Chief of staff. Takes anything not addressed to someone specific.',
    isCos: true,
  },
  {
    id: 'wren',
    name: 'Wren',
    color: '#e0af68',
    character: 'Researcher. Reads widely, answers with sources.',
    driver: 'mock',
    effort: 'high',
    allowedTools: ['Read'],
    memoryScope: false,
    description: 'Researcher. Reads the notes and answers with what is in them.',
    isCos: false,
    avatar: SEED_AVATAR,
  },
  {
    id: 'pike',
    name: 'Pike',
    color: '#9ece6a',
    character: 'Engineer. Terse, practical, allergic to ceremony.',
    driver: 'codex',
    effort: 'high',
    allowedTools: ['Read', 'Write', 'Bash'],
    memoryScope: false,
    description: 'Engineer. Code, systems, anything that needs a file read.',
    isCos: false,
  },
  // Five more, so the composer crosses the facepile threshold (> 3 personas) without
  // anyone having to fill the Agents form five times. Two of them are deliberately
  // awkward: Juno has no model at all and Rook wears one the curated list has never
  // heard of, which are the two model rows that only exist for real rosters.
  {
    id: 'marlow',
    name: 'Marlow',
    color: '#8B7EC8',
    character: 'Strategist. Holds the long arc and says what it costs.',
    driver: 'claude',
    model: 'claude-opus-5',
    effort: 'xhigh',
    allowedTools: [],
    memoryScope: true,
    description: 'Strategist. Long arcs, trade-offs, the shape of a decision.',
    isCos: false,
  },
  {
    id: 'sage',
    name: 'Sage',
    color: '#6FA8A0',
    character: 'Generalist thinker. Plain language, strong opinions.',
    driver: 'claude',
    model: 'claude-sonnet-5',
    effort: 'medium',
    allowedTools: [],
    memoryScope: false,
    description: 'Generalist. Planning, client tracks, half-formed ideas.',
    isCos: false,
  },
  {
    id: 'smith',
    name: 'Smith',
    color: '#D08A3E',
    character: 'Systems engineer. Reads before answering.',
    driver: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'medium',
    allowedTools: ['Read', 'Bash'],
    memoryScope: false,
    description: 'Systems. Infrastructure, deploys, anything with a shell in it.',
    isCos: false,
  },
  {
    id: 'juno',
    name: 'Juno',
    color: '#bb9af7',
    character: 'Editor. Cuts a paragraph to its load-bearing sentence.',
    // No model on purpose: a leftover from before the form named the first model.
    // The menu shows Fable 5.2 selected rather than a Default model row.
    driver: 'claude',
    effort: 'low',
    allowedTools: [],
    memoryScope: false,
    description: 'Editor. Tightens writing, kills the filler.',
    isCos: false,
  },
  {
    id: 'rook',
    name: 'Rook',
    color: '#f7768e',
    character: 'Researcher. Finds the primary source or says there is none.',
    driver: 'codex',
    // Not in the curated list on purpose: a model typed before the list existed, or
    // added to a CLI since, must still be offered as itself rather than vanish.
    model: 'gpt-5.6-nebula',
    effort: 'high',
    allowedTools: ['Read'],
    memoryScope: false,
    description: 'Researcher. Primary sources, or an honest nothing.',
    isCos: false,
  },
]

/** The server's hard cap on a portrait, as a data URI. The client shrinks to stay under it. */
const AVATAR_MAX_CHARS = 96_000
const AVATAR_PREFIX = /^data:image\/(png|jpeg|webp);base64,/

/** Scripted replies, keyed by agent. Newlines are deliberate: the UI must preserve them. */
const REPLIES = {
  nova: 'Taking this one.\n\nThree things matter this week: the client review on Thursday, the estimate that is still open, and one evening with nothing in it. I would put the estimate first, it blocks two other people.',
  wren: 'Checked the notes. Two prior rounds of feedback point the same way, the scope question was never actually answered, only deferred. Worth closing before Thursday.',
  pike: 'Short version: it works, it is just slow. The fix is a cache, not a rewrite. Half a day, most of it testing.',
  marlow: 'The trade you are actually making is six weeks of certainty against a quarter of optionality. Pick the one you can defend in December, not the one that is cheap in August.',
  sage: 'You are solving the wrong half. The integration is not the risk, the assumption underneath it is, and nobody has written that assumption down anywhere.',
  smith: 'The deploy is fine, the migration is not. It runs in eleven seconds locally and holds a table lock the whole time; on production that table is hot.',
  juno: 'Cut the first paragraph entirely. The second sentence of the third one is the point, put it first and the rest can go.',
  rook: 'There is no primary source. Everything traces back to one 2019 blog post that cites itself through a conference slide. Treat the number as folklore.',
}

/* -- The directory --------------------------------------------------------- */

// repoPaths and lastMessageAt are not decoration: the client validates every frame
// against ServerMessageSchema and drops whatever fails, so one missing field here
// means no directory at all — an endless "Loading the house…" beside a roster that
// arrived fine. Keep these rows in step with ProjectSchema and ChatSchema.
const projects = [
  { id: 'client-work', name: 'Client work', icon: 'briefcase', color: '#7AA2F7', repoPaths: [] },
  { id: 'life-admin', name: 'Life admin', icon: 'home', color: '#C77DBB', repoPaths: [] },
]

const chats = [
  { id: 'client-estimate', projectId: 'client-work', kind: 'project', memberIds: [], title: 'Client estimate', lastMessageAt: Date.now() - 59_000 },
  { id: 'thursday-review', projectId: 'client-work', kind: 'project', memberIds: [], title: 'Thursday review', lastMessageAt: Date.now() - 30 * 60_000 },
  { id: 'week-32', projectId: 'life-admin', kind: 'project', memberIds: [], title: 'Week 32 planning', lastMessageAt: Date.now() - 58_000 },
  // One of each home kind, so the sidebar's chat list has something to sort and
  // stack before anything is created by hand.
  { id: 'dm-nova', projectId: null, kind: 'dm', memberIds: ['nova'], title: 'Nova', lastMessageAt: Date.now() - 3 * 60_000 },
  { id: 'dm-sage', projectId: null, kind: 'dm', memberIds: ['sage'], title: 'Sage', lastMessageAt: Date.now() - 3 * 60_000 },
  { id: 'grp-review', projectId: null, kind: 'group', memberIds: ['nova', 'wren'], title: 'Thursday crew', lastMessageAt: Date.now() - 4 * 60 * 60_000 },
  { id: 'pair-nova-sage', projectId: null, kind: 'pair', memberIds: ['nova', 'sage'], title: 'Agent conversation', lastMessageAt: Date.now() - 2 * 60_000 },
]

/**
 * A fixed handful rather than a real walk, and their contents with them: the `@`
 * menu and the files panel only need enough paths to filter, render and edit
 * against, and a dev server that shelled out to git would make both depend on
 * whatever repo happens to be checked out next to it. Mutable, so a save in the
 * panel is visible on the next read the way a real one would be.
 */
const repoFileContents = {
  'Manor/apps/web/src/App.tsx': "export function App() {\n  return <main>Manor</main>\n}\n",
  'Manor/apps/web/src/mentions.ts': "export const MENTION = /@([a-z-]+)/g\n",
  'Manor/apps/web/src/components/Composer.tsx': "export function Composer() {\n  return null\n}\n",
  'Manor/apps/web/src/components/MentionText.tsx': "export function MentionText() {\n  return null\n}\n",
  'Manor/apps/server/src/mentions.ts': "export const parseMentions = (text) => text.match(MENTION) ?? []\n",
  'Manor/apps/server/src/repoFiles.ts': "export async function listRepoFiles() {\n  return { files: [], truncated: false }\n}\n",
  'Manor/packages/contracts/src/index.ts': "export const VERSION = '0.0.1'\n",
  'Manor/BRIEFING.md': '# Briefing\n\nEvery decision, with the alternative it beat.\n\n## Files\n\nThe panel reads them, and now writes them back.\n',
  'Manor/README.md': '# Manor\n\nA house full of agents. This one is read only in the fake server.\n',
}

const revisionOf = (content) => createHash('sha256').update(content).digest('hex')

/** One thread per chat: the durable transcript plus cumulative usage. */
const threads = new Map()

const threadOf = (chatId) => {
  let thread = threads.get(chatId)
  if (!thread) {
    thread = { events: [], usage: {} }
    threads.set(chatId, thread)
  }
  return thread
}

const clients = new Set()
const stopped = new Set()
/** The turn each chat has in flight, so a snapshot can re-announce it. */
const active = new Map()
/** Session-only model/effort pins, chatId → { agentId: override }. */
const chatOverrides = new Map()

const now = () => Date.now()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Canned history, so a snapshot is chat-specific rather than three empty rooms. */
function seed(chatId, agentId, ask, answer) {
  const thread = threadOf(chatId)
  const turnId = randomUUID()
  thread.events.push(
    { id: randomUUID(), ts: now() - 60_000, type: 'user_message', text: ask, mentions: [agentId] },
    { id: randomUUID(), ts: now() - 59_000, type: 'agent_message', agentId, turnId, text: answer },
  )
  thread.usage[agentId] = { inputTokens: 1200, outputTokens: 260, costUsd: 0.009 }
}

seed(
  'client-estimate',
  'nova',
  '@Nova where did the estimate land last week?',
  'At 46 days, with the integration still a guess. That guess is the whole risk.',
)
seed(
  'week-32',
  'wren',
  '@Wren what is still open for week 32?',
  'The dentist, the tyres, and one unanswered mail from the accountant.',
)

// One complete relay in the DM and a standing cross-day pair transcript exercise
// the three surfaces without making the fake driver understand MCP tool calls.
seed('dm-nova', 'nova', 'Is the current plan small enough?', 'I will ask Sage for a second opinion.')
const relayTurn = randomUUID()
threadOf('dm-nova').events.push(
  {
    id: randomUUID(), ts: now() - 4 * 60_000, type: 'agent_relay', agentId: 'nova', peerAgentId: 'sage',
    pairChatId: 'pair-nova-sage', turnId: relayTurn, relayId: 'relay-fixture', phase: 'sent',
  },
  {
    id: randomUUID(), ts: now() - 3 * 60_000, type: 'agent_relay', agentId: 'nova', peerAgentId: 'sage',
    pairChatId: 'pair-nova-sage', turnId: relayTurn, relayId: 'relay-fixture', phase: 'received',
    preview: 'Keep the guardrails, cut the compatibility layer.',
  },
  {
    id: randomUUID(), ts: now() - 2 * 60_000, type: 'agent_message', agentId: 'nova', turnId: randomUUID(),
    text: 'Sage agrees with the direction: keep the guardrails, cut the compatibility layer.',
  },
)
threadOf('dm-sage').events.push(
  {
    id: randomUUID(), ts: now() - 4 * 60_000, type: 'agent_relay', agentId: 'sage', peerAgentId: 'nova',
    pairChatId: 'pair-nova-sage', turnId: relayTurn, relayId: 'relay-fixture', phase: 'received',
  },
  {
    id: randomUUID(), ts: now() - 3 * 60_000, type: 'agent_relay', agentId: 'sage', peerAgentId: 'nova',
    pairChatId: 'pair-nova-sage', turnId: relayTurn, relayId: 'relay-fixture', phase: 'sent',
  },
)
const pairThread = threadOf('pair-nova-sage')
for (const exchange of [
  { at: now() - 25 * 60 * 60_000, relayId: 'relay-yesterday', ask: 'Which assumption should we test first?', answer: 'Test whether the handoff is actually the slow part. Right now that is only intuition.' },
  { at: now() - 5 * 60_000, relayId: 'relay-today', ask: 'Does the revised scope answer that?', answer: 'Yes. It isolates the relay and leaves group summons alone, which is the right boundary.' },
]) {
  const turnId = randomUUID()
  pairThread.events.push(
    {
      id: randomUUID(), ts: exchange.at, type: 'user_message', source: 'agent_relay', text: exchange.ask,
      mentions: [], authorAgentId: 'nova', originChatId: 'dm-nova', originTurnId: turnId,
      relayId: exchange.relayId, relayDepth: 1,
    },
    { id: randomUUID(), ts: exchange.at + 30_000, type: 'agent_message', agentId: 'sage', turnId, text: exchange.answer },
    { id: randomUUID(), ts: exchange.at + 31_000, type: 'turn_result', agentId: 'sage', turnId },
  )
}

/* -- Sending --------------------------------------------------------------- */

function broadcast(message) {
  const frame = encodeText(JSON.stringify(message))
  for (const socket of clients) socket.write(frame)
}

const sendTo = (socket, message) => socket.write(encodeText(JSON.stringify(message)))

/** Durable events go into their chat first, then out to every client. */
function appendEvent(chatId, event) {
  threadOf(chatId).events.push(event)
  // The real server bumps this when it stores the event; the sidebar orders on it,
  // so without it a chat that just spoke would sink instead of rising.
  const chat = chats.find((candidate) => candidate.id === chatId)
  if (chat !== undefined) chat.lastMessageAt = event.ts
  broadcast({ type: 'event', chatId, event })
}

/**
 * The two fields the real server derives per listing rather than storing: the one
 * line the sidebar previews, and who is in the chat. Invited beats spoken, so a dm
 * or a group answers with its members and a project chat with whoever has talked.
 */
const listedChats = () =>
  chats.map((chat) => {
    const events = threads.get(chat.id)?.events ?? []
    const said = [...events].reverse().find((event) => event.type === 'user_message' || event.type === 'agent_message')
    const spoke = []
    for (const event of [...events].reverse()) {
      if (typeof event.agentId === 'string' && !spoke.includes(event.agentId)) spoke.push(event.agentId)
    }
    return {
      ...chat,
      // Required by ChatSchema and never set here: the whole directory is dropped
      // by the client when one field is missing, which reads as an endless
      // "Loading the house…" beside a roster that arrived fine.
      settledAt: chat.settledAt ?? null,
      archivedAt: chat.archivedAt ?? null,
      createdAt: chat.createdAt ?? chat.lastMessageAt,
      lastMessagePreview: said === undefined ? null : said.text.replace(/\s+/g, ' ').trim().slice(0, 120),
      ...(said === undefined || (said.type === 'user_message' && said.source !== undefined) ? {} : { lastMessageFromUser: said.type === 'user_message' }),
      agentIds: chat.kind === 'project' ? spoke : chat.memberIds,
    }
  })

const broadcastDirectory = () => broadcast({ type: 'directory', projects, chats: listedChats() })

/** One roster for the whole house, so every open client changes at the same moment. */
const broadcastRoster = () => broadcast({ type: 'roster', agents })

function snapshotTo(socket, chatId) {
  const thread = threadOf(chatId)
  const running = active.get(chatId)
  const overrides = chatOverrides.get(chatId)
  // No agents here on purpose: the roster is workspace state and rides its own message.
  // The running turn does ride along: `running` is announced once, so without it a
  // client that arrives mid-turn shows an idle chat while the persona keeps working.
  sendTo(socket, {
    type: 'snapshot',
    chatId,
    events: thread.events,
    usage: thread.usage,
    ...(running === undefined ? {} : { activeTurn: running }),
    ...(overrides === undefined || Object.keys(overrides).length === 0 ? {} : { overrides }),
  })
}

/** Names come from a form now, so anything regex-special in one is literal here. */
const escapeName = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function mentionedIds(text) {
  const ids = []
  for (const agent of agents) {
    const pattern = new RegExp(`@${escapeName(agent.name)}\\b`, 'i')
    const at = text.search(pattern)
    if (at !== -1) ids.push({ id: agent.id, at })
  }
  return ids.sort((a, b) => a.at - b.at).map((hit) => hit.id)
}

/**
 * The server's follow-up rule: the sole persona that answered since the user last
 * spoke, or undefined when a silent stretch or several answerers make it ambiguous.
 */
function lastSoloSpeaker(chatId) {
  const repliers = new Set()
  for (const event of [...threadOf(chatId).events].reverse()) {
    if (event.type === 'user_message') break
    if (event.type === 'agent_message') repliers.add(event.agentId)
  }
  if (repliers.size !== 1) return undefined
  const [only] = repliers
  return agents.some((agent) => agent.id === only) ? only : undefined
}

function addUsage(chatId, agentId, input, output, cost) {
  const thread = threadOf(chatId)
  const prior = thread.usage[agentId] ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 }
  thread.usage[agentId] = {
    inputTokens: prior.inputTokens + input,
    outputTokens: prior.outputTokens + output,
    costUsd: Number(((prior.costUsd ?? 0) + cost).toFixed(4)),
  }
  broadcast({ type: 'usage', chatId, perAgent: thread.usage })
}

// paceMs is per streamed word; a message containing "[slow]" streams slowly enough
// for a stop to land deterministically.
async function runTurn(chatId, agentId, paceMs = 40) {
  const agent = agents.find((candidate) => candidate.id === agentId)
  if (!agent || !chats.some((chat) => chat.id === chatId)) return
  const turnId = randomUUID()
  const messageId = `${turnId}:message-1`
  const startedAt = now()
  active.set(chatId, { turnId, agentId, startedAt })
  broadcast({ type: 'turn_state', chatId, turnId, agentId, state: 'running', startedAt })

  // The chat's pin beats the persona's own model, the way the orchestrator merges them.
  const ranOnModel = chatOverrides.get(chatId)?.[agentId]?.model ?? agent.model
  const words = (REPLIES[agentId] ?? 'No script for this persona.').split(' ')
  let streamed = ''
  for (let index = 0; index < words.length; index += 1) {
    await sleep(paceMs)
    if (stopped.has(turnId)) {
      stopped.delete(turnId)
      appendEvent(chatId, {
        id: randomUUID(),
        ts: now(),
        type: 'system_note',
        kind: 'aborted',
        text: `${agent.name} was stopped mid-turn.`,
        agentId,
        turnId,
      })
      active.delete(chatId)
      broadcast({ type: 'turn_state', chatId, turnId, agentId, state: 'aborted' })
      return
    }
    // A tool call partway through, so the toolbelt-leak line is exercised.
    if (index === 3 && agent.allowedTools.length > 0) {
      const toolCallId = `${turnId}:tool`
      appendEvent(chatId, {
        id: randomUUID(),
        ts: now(),
        type: 'tool_use',
        agentId,
        turnId,
        toolCallId,
        tool: agent.allowedTools[0],
        detail: 'notes/week-32.md',
        targets: ['notes/week-32.md'],
      })
      await sleep(paceMs * 2)
      appendEvent(chatId, {
        id: randomUUID(),
        ts: now(),
        type: 'tool_result',
        agentId,
        turnId,
        toolCallId,
        outcome: 'success',
      })
    }
    const chunk = index === words.length - 1 ? words[index] : `${words[index]} `
    streamed += chunk
    broadcast({ type: 'delta', chatId, turnId, agentId, messageId, text: chunk })
  }

  const usage = { inputTokens: 900 + words.length * 3, outputTokens: words.length * 4, costUsd: 0.012 }
  appendEvent(chatId, {
    id: randomUUID(),
    ts: now(),
    type: 'agent_message',
    agentId,
    turnId,
    messageId,
    text: streamed,
  })
  appendEvent(chatId, {
    id: randomUUID(),
    ts: now(),
    type: 'turn_result',
    agentId,
    turnId,
    usage,
    // Here the fake server IS the provider, so what it would have run is what it
    // reports. Absent for a persona on the provider default, the same as a real
    // driver whose stream never names a model.
    ...(ranOnModel === undefined ? {} : { reportedModel: ranOnModel }),
  })
  active.delete(chatId)
  broadcast({ type: 'turn_state', chatId, turnId, agentId, state: 'done' })
  addUsage(chatId, agentId, usage.inputTokens, usage.outputTokens, usage.costUsd)
}

/** One queue per chat: personas take turns inside a chat, chats run in parallel. */
const queues = new Map()

function enqueue(chatId, task) {
  const chain = (queues.get(chatId) ?? Promise.resolve()).then(task, task)
  queues.set(chatId, chain)
}

/* -- Client messages ------------------------------------------------------- */

const slug = (name) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'}-${randomUUID().slice(0, 4)}`

/** The sentence the client shows, or '' when the folder is usable. */
function repoProblem(path) {
  if (typeof path !== 'string' || path.trim() === '') return 'A folder path is required.'
  if (!isAbsolute(path)) return `Not an absolute path: ${path}`
  let stats
  try {
    stats = statSync(path)
  } catch {
    return `No folder at ${path}`
  }
  return stats.isDirectory() ? '' : `Not a folder: ${path}`
}

/**
 * The sentence the client shows, or '' when the draft is storable. A stand-in for
 * the real server's checks, close enough to exercise every branch the dialog has:
 * a refused save answers with a notice to the socket that asked and changes NOTHING.
 */
function agentProblem(draft) {
  if (typeof draft !== 'object' || draft === null) return 'That is not a persona.'
  if (typeof draft.name !== 'string' || draft.name.trim() === '') return 'A persona needs a name.'
  // A persona with no character is the bare harness prompt wearing a name.
  if (typeof draft.character !== 'string' || draft.character.trim() === '') {
    return 'A persona needs a character.'
  }
  if (!['claude', 'codex', 'mock'].includes(draft.driver)) return `Unknown runtime: ${draft.driver}`
  if (typeof draft.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(draft.color)) {
    return `Not a colour: ${draft.color}. Use a hex like #8B7EC8.`
  }
  if (!Array.isArray(draft.allowedTools)) return 'The toolset must be a list.'
  if (draft.id !== undefined && !agents.some((agent) => agent.id === draft.id)) {
    return `No persona with id ${draft.id}.`
  }
  const clash = agents.find(
    (agent) => agent.id !== draft.id && agent.name.toLowerCase() === draft.name.trim().toLowerCase(),
  )
  if (clash) return `${clash.name} already lives here. Pick another name.`
  // '' is how the form says "no picture", not a picture that failed to be one.
  if (draft.avatar !== undefined && draft.avatar !== '') {
    if (typeof draft.avatar !== 'string' || !AVATAR_PREFIX.test(draft.avatar)) {
      return 'A picture has to be a png, jpeg or webp data URI.'
    }
    if (draft.avatar.length > AVATAR_MAX_CHARS) {
      return `That picture is ${draft.avatar.length} characters; the cap is ${AVATAR_MAX_CHARS}.`
    }
  }
  return ''
}

/**
 * The id a new persona gets from her name: lowercased, anything not a letter or
 * digit collapsed to a dash, numbered when the name is already taken. An id is
 * minted once and never changes, so a rename leaves it exactly where it was.
 */
function agentIdFor(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'
  if (!agents.some((agent) => agent.id === base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!agents.some((agent) => agent.id === candidate)) return candidate
  }
}

function handleClientMessage(socket, raw) {
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }

  switch (msg?.type) {
    case 'open_chat': {
      if (!chats.some((chat) => chat.id === msg.chatId)) return
      snapshotTo(socket, msg.chatId)
      return
    }

    case 'stop': {
      stopped.add(msg.turnId)
      return
    }

    // The pin sent replaces the one held; an empty one clears it. Chat state, so
    // the whole set goes back out to every client, exactly like the real server.
    case 'set_chat_override': {
      if (!agents.some((agent) => agent.id === msg.agentId)) {
        sendTo(socket, { type: 'notice', kind: 'error', text: `There is no persona ${msg.agentId} to pin a model for.` })
        return
      }
      const overrides = chatOverrides.get(msg.chatId) ?? {}
      const trimmed = {
        ...(typeof msg.override?.model === 'string' ? { model: msg.override.model } : {}),
        ...(typeof msg.override?.effort === 'string' ? { effort: msg.override.effort } : {}),
      }
      if (Object.keys(trimmed).length === 0) delete overrides[msg.agentId]
      else overrides[msg.agentId] = trimmed
      chatOverrides.set(msg.chatId, overrides)
      broadcast({ type: 'chat_overrides', chatId: msg.chatId, perAgent: overrides })
      return
    }

    case 'send_message': {
      const chat = chats.find((candidate) => candidate.id === msg.chatId)
      if (chat === undefined) return
      if (chat.kind === 'pair') {
        sendTo(socket, { type: 'notice', kind: 'error', text: 'Agent pair chats are view-only.' })
        return
      }
      const mentions = mentionedIds(msg.text)
      // Read before the append: "since the user last spoke" must not count the
      // message being routed right now.
      const followUp = mentions.length === 0 ? lastSoloSpeaker(msg.chatId) : undefined
      appendEvent(msg.chatId, {
        id: randomUUID(),
        ts: now(),
        type: 'user_message',
        text: msg.text,
        mentions,
        ...(Array.isArray(msg.images) && msg.images.length > 0 ? { images: msg.images } : {}),
      })
      // Un-mentioned messages continue the exchange with the one persona that just
      // answered, else go to the chief of staff. With nobody holding the flag they
      // just land in the thread, which is the reverse state of one.
      const cos = agents.find((agent) => agent.isCos)
      const speakers = mentions.length > 0 ? mentions : followUp !== undefined ? [followUp] : cos ? [cos.id] : []
      // Sequential within the chat, because each persona sees the previous reply.
      const paceMs = msg.text.includes('[slow]') ? 200 : 40
      for (const agentId of speakers) enqueue(msg.chatId, () => runTurn(msg.chatId, agentId, paceMs))
      return
    }

    // Folders are optional. One bad path refuses the whole create, like the real service.
    case 'create_project': {
      const name = typeof msg.name === 'string' ? msg.name.trim() : ''
      if (name === '') {
        sendTo(socket, { type: 'notice', kind: 'error', text: 'A project needs a name.' })
        return
      }
      const repoPaths = Array.isArray(msg.repoPaths) ? [...new Set(msg.repoPaths)] : []
      for (const path of repoPaths) {
        const problem = repoProblem(path)
        if (problem) {
          sendTo(socket, { type: 'notice', kind: 'error', text: problem })
          return
        }
      }
      projects.push({
        id: slug(name),
        name,
        icon: msg.icon ?? DEFAULT_PROJECT_ICON,
        color: msg.color ?? DEFAULT_PROJECT_COLOR,
        repoPaths,
      })
      broadcastDirectory()
      return
    }

    case 'update_project': {
      const project = projects.find((candidate) => candidate.id === msg.projectId)
      if (!project) return
      const name = typeof msg.name === 'string' ? msg.name.trim() : ''
      if (name === '') {
        sendTo(socket, { type: 'notice', kind: 'error', text: 'A project needs a name.' })
        return
      }
      const repoPaths = Array.isArray(msg.repoPaths) ? [...new Set(msg.repoPaths)] : []
      for (const path of repoPaths) {
        const problem = repoProblem(path)
        if (problem) {
          sendTo(socket, { type: 'notice', kind: 'error', text: problem })
          return
        }
      }
      Object.assign(project, {
        name,
        icon: msg.icon ?? project.icon,
        color: msg.color ?? project.color,
        repoPaths,
      })
      broadcastDirectory()
      return
    }

    // The picker browses THIS machine, because the browser cannot produce an
    // absolute path and the folder has to exist where the personas run. No path
    // means home, which is where a picker opens.
    case 'list_dirs': {
      const target = typeof msg.path === 'string' && msg.path.trim() !== '' ? msg.path : homedir()
      const path = resolve(target)
      let entries
      try {
        entries = readdirSync(path, { withFileTypes: true })
      } catch {
        sendTo(socket, { type: 'notice', kind: 'error', text: `Cannot read ${path}` })
        return
      }
      const parent = dirname(path)
      sendTo(socket, {
        type: 'dir_listing',
        path,
        // dirname('/') is '/', and that is what stops the up control at the root.
        parent: parent === path ? null : parent,
        entries: entries
          // Folders only, and no dotfolders: the picker points a project at a
          // working tree, not at ~/.ssh.
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
          .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      })
      return
    }

    // A fixed handful rather than a real walk. The composer's `@` menu only needs
    // enough paths to filter, sort and render against, and a dev server that shelled
    // out to git would make the menu depend on whatever repo happens to be checked
    // out next to it.
    case 'list_repo_files': {
      sendTo(socket, {
        type: 'repo_files',
        projectId: msg.projectId,
        files: Object.keys(repoFileContents),
        truncated: false,
      })
      return
    }

    // Reading and saving those files, in memory. Enough to drive the panel's whole
    // edit flow: a file it has never heard of is unavailable, a save with the wrong
    // precondition comes back stale, and `Manor/README.md` is deliberately read only
    // so the disabled Edit button has something to be disabled about.
    case 'read_repo_file': {
      const content = repoFileContents[msg.path]
      sendTo(socket, {
        type: 'repo_file',
        projectId: msg.projectId,
        path: msg.path,
        result:
          content === undefined
            ? { status: 'unavailable', message: 'This file is not available to preview.' }
            : {
                status: 'ready',
                content,
                ...(msg.path === 'Manor/README.md' ? {} : { revision: revisionOf(content) }),
              },
      })
      return
    }

    case 'write_repo_file': {
      const content = repoFileContents[msg.path]
      const result =
        content === undefined
          ? { status: 'rejected', message: 'That file is not one of this project’s linked files.' }
          : revisionOf(content) !== msg.baseRevision
            ? { status: 'stale', revision: revisionOf(content), content }
            : { status: 'saved', revision: revisionOf(msg.content) }
      if (result.status === 'saved') repoFileContents[msg.path] = msg.content
      sendTo(socket, { type: 'repo_write', projectId: msg.projectId, path: msg.path, result })
      return
    }

    case 'create_chat': {
      const kind = msg.kind ?? 'project'
      const memberIds = msg.memberIds ?? []
      if (kind === 'pair') {
        sendTo(socket, { type: 'notice', kind: 'error', text: 'Agent pair chats are created by message_agent.' })
        return
      }
      if (kind === 'project' && !projects.some((project) => project.id === msg.projectId)) return
      if (memberIds.some((agentId) => !agents.some((agent) => agent.id === agentId))) {
        sendTo(socket, { type: 'notice', kind: 'error', text: 'No such persona.' })
        return
      }
      if ((kind === 'dm' && memberIds.length !== 1) || (kind === 'group' && memberIds.length < 2)) {
        sendTo(socket, { type: 'notice', kind: 'error', text: 'A dm is with one persona, a group with two or more.' })
        return
      }
      // One DM per persona, like the real store's unique index: creating a second
      // one hands back the first rather than splitting the conversation in two.
      const existingDm =
        kind === 'dm' ? chats.find((chat) => chat.kind === 'dm' && chat.memberIds[0] === memberIds[0]) : undefined
      if (existingDm !== undefined) {
        sendTo(socket, { type: 'chat_created', chatId: existingDm.id })
        if (msg.openingMessage !== undefined) {
          handleClientMessage(
            socket,
            JSON.stringify({ type: 'send_message', chatId: existingDm.id, ...msg.openingMessage }),
          )
        }
        return
      }
      // A DM is named after the persona it is with; a group left unnamed is named
      // after everyone in it.
      const named =
        kind === 'dm'
          ? agents.find((agent) => agent.id === memberIds[0])?.name
          : kind === 'group'
            ? memberIds.map((agentId) => agents.find((agent) => agent.id === agentId)?.name ?? agentId).join(', ')
            : undefined
      const chat = {
        id: randomUUID(),
        projectId: kind === 'project' ? msg.projectId : null,
        kind,
        memberIds,
        title: msg.title ?? named ?? 'New chat',
        // Creation time for a chat with no events yet, so it sorts to the top.
        lastMessageAt: now(),
      }
      chats.push(chat)
      // Pins picked on the new-chat stage, before the chat had an id. Applied
      // before the opening message runs; a pin for a persona who is gone is
      // dropped rather than costing the chat.
      const pins = {}
      for (const [agentId, override] of Object.entries(msg.overrides ?? {})) {
        if (agents.some((agent) => agent.id === agentId)) pins[agentId] = override
      }
      if (Object.keys(pins).length > 0) chatOverrides.set(chat.id, pins)
      broadcastDirectory()
      sendTo(socket, { type: 'chat_created', chatId: chat.id })
      if (msg.openingMessage !== undefined) {
        handleClientMessage(
          socket,
          JSON.stringify({ type: 'send_message', chatId: chat.id, ...msg.openingMessage }),
        )
      }
      return
    }

    // The whole desired membership, add and remove in one write, exactly as the
    // real service takes it. Groups only: a DM's single member is what the DM is.
    case 'set_chat_members': {
      const chat = chats.find((candidate) => candidate.id === msg.chatId)
      if (chat === undefined) return
      if (chat.kind !== 'group') {
        sendTo(socket, { type: 'notice', kind: 'error', text: 'Only a group has members to change.' })
        return
      }
      if (msg.memberIds.length < 2 || msg.memberIds.some((id) => !agents.some((agent) => agent.id === id))) {
        sendTo(socket, { type: 'notice', kind: 'error', text: 'A group needs two or more personas of the house.' })
        return
      }
      chat.memberIds = [...msg.memberIds]
      broadcastDirectory()
      return
    }

    case 'delete_chat': {
      const at = chats.findIndex((chat) => chat.id === msg.chatId)
      if (at === -1) return
      chats.splice(at, 1)
      threads.delete(msg.chatId)
      queues.delete(msg.chatId)
      chatOverrides.delete(msg.chatId)
      broadcastDirectory()
      return
    }

    // A stand-in for the real check, close enough to exercise the client: a bad
    // path answers with a notice to the one socket that asked and changes nothing.
    case 'attach_repo': {
      const project = projects.find((candidate) => candidate.id === msg.projectId)
      if (!project) return
      const problem = repoProblem(msg.path)
      if (problem) {
        sendTo(socket, { type: 'notice', kind: 'error', text: problem })
        return
      }
      project.repoPath = msg.path
      broadcastDirectory()
      return
    }

    case 'detach_repo': {
      const project = projects.find((candidate) => candidate.id === msg.projectId)
      if (!project) return
      delete project.repoPath
      broadcastDirectory()
      return
    }

    // One message for both halves of the form: a draft with an id edits that
    // persona, a draft without one is a new persona and the server mints the id.
    case 'save_agent': {
      const draft = msg.agent
      const problem = agentProblem(draft)
      if (problem) {
        sendTo(socket, { type: 'notice', kind: 'error', text: problem })
        return
      }
      const saved = {
        // Minted from the name once, then hers for good; a rename never moves it.
        id: draft.id ?? agentIdFor(draft.name),
        name: draft.name.trim(),
        color: draft.color,
        character: draft.character.trim(),
        driver: draft.driver,
        // Always echoed, never left to the client's schema default: matchesDraft is
        // how the dialog learns a save landed, and a field the roster omits reads
        // back as 'high' and disagrees with every other choice forever.
        effort: typeof draft.effort === 'string' ? draft.effort : 'high',
        allowedTools: [...draft.allowedTools],
        memoryScope: draft.memoryScope === true,
        description: typeof draft.description === 'string' ? draft.description : '',
        isCos: draft.isCos === true,
      }
      if (typeof draft.model === 'string' && draft.model !== '') saved.model = draft.model
      if (typeof draft.avatar === 'string' && draft.avatar !== '') saved.avatar = draft.avatar
      // At most one chief of staff, enforced here rather than asked of the client:
      // flagging one takes the flag off whoever held it.
      if (saved.isCos) {
        for (const agent of agents) if (agent.id !== saved.id) agent.isCos = false
      }
      const at = agents.findIndex((agent) => agent.id === saved.id)
      if (at === -1) agents.push(saved)
      else agents[at] = saved
      broadcastRoster()
      return
    }

    // The way out. Old messages keep the id of a persona who is gone; the client
    // renders those by id, which is what makes this reversible enough to allow.
    case 'delete_agent': {
      const at = agents.findIndex((agent) => agent.id === msg.agentId)
      if (at === -1) {
        sendTo(socket, { type: 'notice', kind: 'error', text: `No persona with id ${msg.agentId}.` })
        return
      }
      agents.splice(at, 1)
      broadcastRoster()
      return
    }

    case 'delete_project': {
      const at = projects.findIndex((project) => project.id === msg.projectId)
      if (at === -1) return
      projects.splice(at, 1)
      // The cascade: a project takes its chats and their transcripts with it.
      for (let index = chats.length - 1; index >= 0; index -= 1) {
        if (chats[index].projectId !== msg.projectId) continue
        threads.delete(chats[index].id)
        queues.delete(chats[index].id)
        chatOverrides.delete(chats[index].id)
        chats.splice(index, 1)
      }
      broadcastDirectory()
      return
    }

    default:
      return
  }
}

/* -- WebSocket framing ----------------------------------------------------- */

function encodeText(text) {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x81, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

/** Pulls whole frames off the buffer, leaving any partial tail for the next chunk. */
function readFrames(buffer) {
  const frames = []
  let rest = buffer
  for (;;) {
    if (rest.length < 2) break
    const opcode = rest[0] & 0x0f
    const masked = (rest[1] & 0x80) !== 0
    let length = rest[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (rest.length < offset + 2) break
      length = rest.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (rest.length < offset + 8) break
      length = Number(rest.readBigUInt64BE(offset))
      offset += 8
    }
    const maskKey = masked ? rest.subarray(offset, offset + 4) : null
    if (masked) offset += 4
    if (rest.length < offset + length) break
    const payload = Buffer.from(rest.subarray(offset, offset + length))
    if (maskKey) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4]
    }
    frames.push({ opcode, payload })
    rest = rest.subarray(offset + length)
  }
  return { frames, rest }
}

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('manor fake server, websocket at /ws\n')
})

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (!req.url?.startsWith('/ws') || typeof key !== 'string') {
    socket.destroy()
    return
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  socket.setNoDelay(true)
  clients.add(socket)
  // What a fresh connection gets: the rooms and the household. A snapshot answers
  // open_chat, and it carries no roster; there is only ever this one.
  sendTo(socket, { type: 'directory', projects, chats: listedChats() })
  sendTo(socket, { type: 'roster', agents })

  let pending = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk])
    const { frames, rest } = readFrames(pending)
    pending = rest
    for (const frame of frames) {
      if (frame.opcode === 0x1) handleClientMessage(socket, frame.payload.toString('utf8'))
      else if (frame.opcode === 0x8) socket.end()
      else if (frame.opcode === 0x9) socket.write(Buffer.from([0x8a, 0x00]))
    }
  })
  const drop = () => clients.delete(socket)
  socket.on('close', drop)
  socket.on('error', drop)
})

// Proof of life on a timer, the way the real server does it: it is what lets the
// client tell a quiet connection from a dead one.
setInterval(() => broadcast({ type: 'heartbeat' }), 20_000).unref()

server.listen(PORT, () => {
  console.log(`manor fake server on ws://localhost:${PORT}/ws`)
})
