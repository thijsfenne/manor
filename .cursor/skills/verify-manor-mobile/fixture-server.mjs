#!/usr/bin/env node
/**
 * Isolated WebSocket fixture for Manor mobile verification.
 * Not the live house (43179), not the desktop spike (43180), not the maintainer's Tailscale host.
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { CONTEXT_CLEARED_NOTE, ServerMessageSchema, chatCommandOf } from '../../../packages/contracts/src/index.ts'
import { WebSocketServer } from 'ws'

/**
 * Exportknop's question in the Manor thread: two questions with descriptions, so the
 * answer card runs past its height and its scroll fade shows.
 */
const EXPORT_QUESTIONS = [
  { id: 'corners', question: 'Ronde of vierkante hoeken?', options: [{ label: 'Rond' }, { label: 'Vierkant' }] },
  {
    id: 'format',
    question: 'Welk bestandsformaat levert de export?',
    options: [
      { label: 'Markdown', description: 'Leesbaar in elke editor en in de vault.' },
      { label: 'PDF', description: 'Vast opgemaakt, goed om te delen.' },
      { label: 'HTML', description: 'Opent in de browser met de opmaak van Manor.' },
    ],
  },
  { id: 'placement', question: 'Waar komt de knop?', options: [{ label: 'In het chatmenu' }, { label: 'In de kopbalk' }] },
]

const PORT = Number(process.env.MANOR_MOBILE_VERIFY_PORT ?? 43182)
const HOST = process.env.MANOR_MOBILE_VERIFY_HOST ?? '127.0.0.1'

if (PORT === 43179) {
  console.error('Refusing port 43179 (live Manor).')
  process.exit(1)
}

const now = Date.now()

const projects = [
  {
    id: 'project-manor',
    name: 'Manor',
    icon: 'home',
    color: '#B7C9B1',
    repoPaths: ['/tmp/manor-mobile-verify/Manor'],
    // Set on the Mac; the phone never sends it, so a phone save must leave it standing.
    memoryScope: 'knowledge',
    // The project's curated thread: the phone pins it above the sessions.
    threadChatId: 'chat-thread-manor',
  },
  {
    id: 'project-notes',
    name: 'Notities',
    icon: 'book',
    color: '#C77DBB',
    repoPaths: [],
    // A quiet thread with no open question, so its composer is on screen.
    threadChatId: 'chat-thread-notes',
  },
]

function chat({ id, projectId, title, preview, minutesAgo, settledMinutesAgo = null, kind = 'project', memberIds = [] }) {
  const lastMessageAt = now - minutesAgo * 60_000
  return {
    id,
    projectId,
    kind,
    routineId: null,
    parentChatId: null,
    memberIds,
    sideModel: null,
    sideEffort: null,
    lastMessagePreview: preview,
    title,
    createdAt: lastMessageAt - 3_600_000,
    lastMessageAt,
    settledAt: settledMinutesAgo === null ? null : now - settledMinutesAgo * 60_000,
    archivedAt: null,
    agentIds: memberIds,
    checkout: { mode: 'current', branch: 'verify' },
  }
}

const directory = {
  type: 'directory',
  projects,
  chats: [
    // A Single Session whose reads show picture thumbnails, and one picture the user attached.
    // First in the list, so it is on the Sessions tab without scrolling.
    { ...chat({
      id: 'chat-trace-images',
      projectId: 'project-manor',
      title: 'Schermafbeeldingen',
      preview: 'De schermen kloppen.',
      minutesAgo: 0,
    }), mode: 'single' },
    { ...chat({
      id: 'chat-inline-steer', projectId: 'project-manor',
      title: 'Bijsturen in de stream', preview: 'One turn with an inline addition.', minutesAgo: 0,
    }), mode: 'single' },
    // A committed Confirm drawn as its tasks card, then a turn working through a plan.
    chat({
      id: 'chat-tasks-card', projectId: 'project-manor',
      title: 'Takenkaart', preview: 'Working through the plan.', minutesAgo: 0, memberIds: ['agent-marlow'],
    }),
    chat({
      id: 'chat-mobile-inbox',
      projectId: 'project-manor',
      title: 'Mobiele inbox voor Manor',
      preview: 'Fixture preview. Not the live household.',
      minutesAgo: 8,
    }),
    chat({
      id: 'chat-settled-pwa',
      projectId: 'project-manor',
      title: 'PWA navigatie afmaken',
      preview: 'Settled fixture thread.',
      minutesAgo: 4_260,
      settledMinutesAgo: 4_200,
    }),
    chat({
      id: 'chat-dm-marlow',
      projectId: null,
      kind: 'dm',
      title: 'Marlow',
      preview: 'Direct fixture.',
      minutesAgo: 40,
      memberIds: ['agent-marlow'],
    }),
    chat({
      id: 'chat-dm-smith',
      projectId: null,
      kind: 'dm',
      title: 'Smith',
      preview: 'Export a chat as Markdown',
      minutesAgo: 2,
      memberIds: ['agent-smith'],
    }),
    chat({
      id: 'chat-session-export',
      projectId: 'project-manor',
      title: 'Export a chat as Markdown',
      preview: 'Wren marked the goal reached.',
      minutesAgo: 3,
      memberIds: [],
    }),
    // A turn that answered and now waits on two helpers and a build it left running.
    chat({
      id: 'chat-background-wait',
      projectId: 'project-manor',
      title: 'Achtergrondwerk',
      preview: 'Started two helpers and a build in the background.',
      minutesAgo: 1,
      memberIds: ['agent-marlow'],
    }),
    // One helper came back and woke Marlow; the other still runs after the turn ended.
    chat({
      id: 'chat-background-wake',
      projectId: 'project-manor',
      title: 'Wekken',
      preview: 'Count the files finished: 4 files.',
      minutesAgo: 0,
      memberIds: ['agent-marlow'],
    }),
    // A live session: the turn answered, its agent came back and woke Marlow, its build still runs.
    chat({
      id: 'chat-live-session',
      projectId: 'project-manor',
      title: 'Live sessie',
      preview: 'The audit is back; the tests still run.',
      minutesAgo: 0,
      memberIds: ['agent-marlow'],
    }),
    // A Codex live session: its rows became background work only at the answer.
    chat({
      id: 'chat-codex-live',
      projectId: 'project-manor',
      title: 'Codex live sessie',
      preview: 'The dev server runs in the background.',
      minutesAgo: 0,
      memberIds: ['agent-marlow'],
    }),
    // A DM whose last turn is still running, under one that finished with a trace.
    chat({
      id: 'chat-dm-sage',
      projectId: null,
      kind: 'dm',
      title: 'Sage',
      preview: 'Sage is working.',
      minutesAgo: 0,
      memberIds: ['agent-sage'],
    }),
    // The project thread (a Single chat) and the session it started, which asks a question.
    { ...chat({
      id: 'chat-thread-manor',
      projectId: 'project-manor',
      title: 'Manor',
      preview: 'Exportknop wacht op een keuze.',
      minutesAgo: 2,
    }), mode: 'single' },
    { ...chat({
      id: 'chat-thread-notes',
      projectId: 'project-notes',
      title: 'Notities',
      preview: 'Alles staat klaar.',
      minutesAgo: 4,
    }), mode: 'single' },
    // An ordinary Single Session: it live-compacts, so its composer keeps the context ring.
    { ...chat({
      id: 'chat-single-notes',
      projectId: 'project-manor',
      title: 'Losse notities',
      preview: 'De notities staan klaar.',
      minutesAgo: 1,
    }), mode: 'single' },
    // A finished Single Session that changed several files, for the changed-files sheet.
    { ...chat({
      id: 'chat-diff-files',
      projectId: 'project-manor',
      title: 'Wijzigingen bekijken',
      preview: 'Vier bestanden aangepast.',
      minutesAgo: 3,
    }), mode: 'single' },
    // Outbound mail cards: one sent with its confirmation, one discarded, one open.
    { ...chat({
      id: 'chat-mail-drafts',
      projectId: 'project-manor',
      title: 'Mail klaarzetten',
      preview: 'Here is the mail. Check it and send it when it reads right.',
      minutesAgo: 2,
    }), mode: 'single' },
    // A Single Session the Notities thread started; the thread sent one of the user's messages on to it.
    { ...chat({
      id: 'chat-notes-session',
      projectId: 'project-notes',
      title: 'Weekmenu',
      preview: 'Pasta staat op donderdag.',
      minutesAgo: 2,
    }), mode: 'single' },
    chat({
      id: 'chat-thread-session',
      projectId: 'project-manor',
      title: 'Exportknop',
      preview: 'Ronde of vierkante hoeken?',
      minutesAgo: 1,
      memberIds: [],
    }),
    // History from before Wren moved to Sessions: readable, no composer.
    chat({
      id: 'chat-dm-wren',
      projectId: null,
      kind: 'dm',
      title: 'Wren',
      preview: 'An old direct message.',
      minutesAgo: 600,
      memberIds: ['agent-wren'],
    }),
    // The standing pair behind the answered consultation in Marlow's DM; view-only.
    chat({
      id: 'pair-marlow-agent-sage',
      projectId: null,
      kind: 'pair',
      title: 'Marlow and Sage',
      preview: 'Ja, ze zijn klaar.',
      minutesAgo: 1.5,
      memberIds: ['agent-marlow', 'agent-sage'],
    }),
  ],
  workHandoffs: [],
  awaitingInput: { 'chat-thread-session': ['request-thread-1'], 'chat-secret-token': ['request-secret-1'] },
}

// Three screenshots on the ready result, served below the socket the way the Mac serves
// signed media. Tracked app images stand in for screenshots, so the fixture needs no files.
// MANOR_MOBILE_VERIFY_EVIDENCE=1..5 gives the result that many instead, for the thumbnail row.
const EVIDENCE_NAMES = ['icon', 'splash-icon', 'favicon', 'icon-dark', 'icon-tinted']
const evidenceCount = Math.min(EVIDENCE_NAMES.length, Math.max(1, Number(process.env.MANOR_MOBILE_VERIFY_EVIDENCE ?? 3) || 3))
const evidence = EVIDENCE_NAMES.slice(0, evidenceCount).map((name, index) => {
  const bytes = readFileSync(new URL(`../../../apps/mobile/assets/images/${name}.png`, import.meta.url))
  return { id: `evidence-${index + 1}`, name: `${name}.png`, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), src: `/media/evidence/${index + 1}/fixture`, bytes }
})

// What `get_dm_files` answers for Marlow's DM, newest first: the picture and the note his
// transcript holds, then files only the library lists. Seven fall in this week, so Show
// more appears, and the oldest has lost its bytes. Every other DM answers with no files.
const dmFileBytes = new Map()
function dmFile(index, { name, mime, daysAgo, body, agentId, messageId }) {
  const bytes = body === undefined ? undefined : Buffer.from(body)
  const src = `/media/dm-files/${index}/fixture`
  if (bytes !== undefined) dmFileBytes.set(src, { bytes, type: mime.startsWith('text/') ? 'text/plain; charset=utf-8' : mime })
  return {
    id: `dm-file-${index}`, name, mime, ts: now - daysAgo * 86_400_000 - index * 60_000,
    kind: mime.startsWith('image/') ? 'image' : mime === 'application/pdf' ? 'pdf' : 'file',
    size: bytes?.byteLength ?? 48_210,
    ...(agentId === undefined ? {} : { agentId }), ...(messageId === undefined ? {} : { messageId }), ...(bytes === undefined ? {} : { src }),
  }
}
const appImage = (name) => readFileSync(new URL(`../../../apps/mobile/assets/images/${name}.png`, import.meta.url))
const dmFiles = [
  { name: 'icon.png', mime: 'image/png', daysAgo: 0, body: appImage('icon'), messageId: 'mc-image' },
  { name: 'notities.md', mime: 'text/markdown', daysAgo: 0, body: '# Notities\n\nDatumlabels nakijken.\n', messageId: 'mc-reply' },
  { name: 'splash-icon.png', mime: 'image/png', daysAgo: 1, body: appImage('splash-icon'), agentId: 'agent-marlow', messageId: 'mc-return' },
  { name: 'release-note.md', mime: 'text/markdown', daysAgo: 2, agentId: 'agent-marlow',
    body: '# Release note\n\nThe export names the file after the chat title.\n\n## Changed\n\n- Date labels follow the phone’s region.\n- A long title no longer pushes the menu off screen.\n\n## Known\n\nAn empty chat exports an empty file.\n' },
  { name: 'planning.pdf', mime: 'application/pdf', daysAgo: 3, body: '%PDF-1.4\n%%EOF\n', agentId: 'agent-marlow' },
  { name: 'icon-dark.png', mime: 'image/png', daysAgo: 4, body: appImage('icon-dark'), agentId: 'agent-marlow' },
  { name: 'budget.csv', mime: 'text/csv', daysAgo: 5, body: 'post,amount\nfronts,2400\nworktop,1150\n' },
  { name: 'favicon.png', mime: 'image/png', daysAgo: 10, body: appImage('favicon') },
  { name: 'icon-tinted.png', mime: 'image/png', daysAgo: 12, body: appImage('icon-tinted'), agentId: 'agent-marlow' },
  { name: 'contract.pdf', mime: 'application/pdf', daysAgo: 20 },
].map((file, index) => dmFile(index + 1, file))

/** A `deliver_file` result in Marlow's DM, reusing the bytes his library serves. */
function delivered(id, ts, turnId, name) {
  const file = dmFiles.find((entry) => entry.name === name)
  return { id, ts, type: 'file_delivery', agentId: 'agent-marlow', turnId, file: { id: `${id}-doc`, name, mime: file.mime, size: file.size, src: file.src } }
}

// Pictures the `Schermafbeeldingen` reads link to, as the Mac links what a tool call read.
// Picture 0 is the user's own attachment: its bubble shows it, and its read gets no link.
const TRACE_PICTURES = ['icon-tinted', 'icon', 'splash-icon', 'favicon', 'icon-dark', 'icon-tinted']
const tracePictures = new Map(TRACE_PICTURES.map((name, index) => [`/media/trace/${index}/fixture`, appImage(name)]))

// A Session briefed from Smith's DM, led by Wren, whose second result waits for Accept.
const handoff = {
  id: 'handoff-export', sourceChatId: 'chat-dm-smith', sourceTurnId: 'turn-brief', workChatId: 'chat-session-export',
  projectId: 'project-manor', projectName: 'Manor', title: 'Export a chat as Markdown',
  authorAgentId: 'agent-smith', leadAgentId: 'agent-wren', leadAgentName: 'Wren',
  supportingAgentIds: [], supportingAgentNames: [], state: 'active', result: null, resultAt: null,
  version: 4, createdAt: now - 600_000, acceptedAt: now - 590_000, goalReachedAt: now - 60_000,
  goalReport: {
    result: 'Export now names the file after the chat title.', limitations: 'There is no test for an empty chat yet.',
    // Confirm waits until both have a pick; only `noChange` picks free it, the other options open Follow up.
    choices: [
      { title: 'Empty chats', question: 'An empty chat exports as an empty file. Should that stay?', options: ['Skip empty chats', 'Keep it as is'], recommended: 'Keep it as is', noChange: 'Keep it as is' },
      { title: 'File name', question: 'Should the file name also carry the date?', options: ['Add the date', 'Title only'], noChange: 'Title only' },
    ],
    evidence: evidence.map(({ bytes, ...item }) => item),
  },
  goalCompletion: { status: 'ready', operation: 'commit', repos: [] },
}
directory.workHandoffs.push(handoff)

// A confirmed Single result whose merge Git does not show landing: Merge blocked and why.
const blockedMerge = {
  id: 'handoff-shortcut', sourceChatId: 'chat-dm-smith', sourceTurnId: 'turn-shortcut', workChatId: 'chat-session-export',
  projectId: 'project-manor', projectName: 'Manor', title: 'Export shortcut',
  authorAgentId: 'agent-smith', leadAgentId: 'agent-wren', leadAgentName: 'Wren',
  supportingAgentIds: [], supportingAgentNames: [], state: 'active', result: null, resultAt: null,
  version: 2, createdAt: now - 500_000, acceptedAt: now - 490_000, goalReachedAt: now - 120_000, goalConfirmedAt: now - 100_000,
  goalReport: { result: 'Cmd+E exports the open chat.' },
  goalCompletion: { status: 'blocked', operation: 'merge', message: 'main has uncommitted edits in export.ts in the linked folder.', repos: [] },
}
directory.workHandoffs.push(blockedMerge)

// A Session the Manor project thread started: its question is answered in the thread.
directory.workHandoffs.push({
  id: 'handoff-thread-export', sourceChatId: 'chat-thread-manor', sourceTurnId: 'turn-thread-brief', workChatId: 'chat-thread-session',
  projectId: 'project-manor', projectName: 'Manor', title: 'Exportknop',
  authorAgentId: 'agent-wren', leadAgentId: 'agent-wren', leadAgentName: 'Wren',
  supportingAgentIds: [], supportingAgentNames: [], state: 'active', result: null, resultAt: null,
  version: 1, createdAt: now - 300_000, acceptedAt: now - 290_000,
})

// The Session the Notities thread started, to which it sent the user's message on (`send_to_session`).
directory.workHandoffs.push({
  id: 'handoff-notes-menu', sourceChatId: 'chat-thread-notes', sourceTurnId: 'turn-tn', workChatId: 'chat-notes-session',
  projectId: 'project-notes', projectName: 'Notities', title: 'Weekmenu',
  authorAgentId: '__single__', leadAgentId: '__single__', leadAgentName: 'Single',
  supportingAgentIds: [], supportingAgentNames: [], state: 'active', result: null, resultAt: null,
  version: 1, createdAt: now - 4 * 60_000, acceptedAt: now - 4 * 60_000,
})

// Two proposals in Marlow's DM that wait for Accept, so the bar above the composer
// holds several rows. Accept creates the Session the way the server acknowledges it.
const proposal = (id, title, minutesAgo) => ({
  id, sourceChatId: 'chat-dm-marlow', sourceTurnId: `turn-${id}`, workChatId: null,
  projectId: 'project-manor', projectName: 'Manor', title, task: `${title}.`,
  authorAgentId: 'agent-marlow', leadAgentId: 'agent-marlow', leadAgentName: 'Marlow',
  supportingAgentIds: ['agent-sage'], supportingAgentNames: ['Sage'], state: 'active', result: null, resultAt: null,
  version: 1, createdAt: now - minutesAgo * 60_000, acceptedAt: null,
})
const proposals = [proposal('handoff-labels', 'Fix the date labels', 6), { ...proposal('handoff-notes', 'Draft the release note with the changelog', 4), revision: 2 }]
// The release note was revised in a later turn: its first version is replaced by v2.
const replaced = {
  ...proposal('handoff-notes-v1', 'Draft the release note', 5),
  state: 'settled', version: 2, result: 'Replaced by v2.', resultAt: now - 4 * 60_000, supersededById: 'handoff-notes',
}
directory.workHandoffs.push(...proposals, replaced)

// The Notities thread started six Sessions, one per card shape: a proposal, a line that
// says Working (a build left running) or Needs you, a Ready result that keeps the full
// card, and finished ones folded to Done or Confirmed (never the branch it merged into).
const notesSession = (id, title, minutesAgo, extra = {}) => ({
  id, sourceChatId: 'chat-thread-notes', sourceTurnId: `turn-${id}`, workChatId: `chat-${id}`,
  projectId: 'project-notes', projectName: 'Notities', title, task: `${title}.`,
  // A project thread writes its cards as the Single voice, which keeps them Single only.
  authorAgentId: '__single__', leadAgentId: 'agent-wren', leadAgentName: 'Wren',
  supportingAgentIds: [], supportingAgentNames: [], state: 'active', result: null, resultAt: null,
  version: 1, createdAt: now - minutesAgo * 60_000, acceptedAt: now - minutesAgo * 60_000 + 10_000, ...extra,
})
const notesSessions = [
  notesSession('notes-release', 'Write the release notes', 30, { state: 'settled', result: 'The 0.9 notes are written. They cover export.', resultAt: now - 25 * 60_000 }),
  notesSession('notes-csv', 'Ship the CSV export', 28, {
    state: 'settled', goalReachedAt: now - 22 * 60_000, goalConfirmedAt: now - 21 * 60_000,
    goalReport: { result: 'CSV export works from the toolbar. Tested on two chats.' },
    goalCompletion: { status: 'complete', operation: 'merge', completedAt: now - 21 * 60_000,
      repos: [{ path: '/tmp/manor-mobile-verify/Notities', files: ['export.ts'], before: 'a1', branch: 'manor/notes-csv', tree: 't1', mergeInto: 'release-branch-0-9' }] },
  }),
  notesSession('notes-build', 'Run the nightly build', 20),
  notesSession('notes-tests', 'Run the test suite', 18),
  notesSession('notes-package', 'Package the desktop build', 16),
  notesSession('notes-colour', 'Pick the button colour', 15),
  notesSession('notes-pdf', 'Ship the PDF export', 12, {
    goalReachedAt: now - 9 * 60_000, goalReport: { result: 'PDF export renders every page.', limitations: 'Fonts fall back to the system font.' },
    goalCompletion: { status: 'ready', operation: 'commit', repos: [] },
  }),
  notesSession('notes-tidy', 'Tidy the settings copy', 8, { workChatId: null, acceptedAt: null }),
]
directory.workHandoffs.push(...notesSessions)
for (const session of notesSessions) {
  if (session.workChatId === null) continue
  directory.chats.push(chat({ id: session.workChatId, projectId: 'project-notes', title: session.title, preview: session.task,
    minutesAgo: (now - session.createdAt) / 60_000 - 1, settledMinutesAgo: session.state === 'settled' ? 20 : null }))
}
// Two Working Sessions: the test run published a tasks card (2 of 7 done), the packaging turn has none yet.
directory.chats.find((entry) => entry.id === 'chat-notes-tests').planProgress = { done: 2, total: 7 }
// The build's shell keeps running after its turn, so the overview files it under Waiting
// with the shell's title, and its line in the thread says Waiting.
directory.backgroundChatIds = [...(directory.backgroundChatIds ?? []), 'chat-notes-build']
directory.backgroundWork = { ...directory.backgroundWork, 'chat-notes-build': [{ title: 'Build the nightly release', kind: 'command' }] }

// The two children of `chat-background-wake` and the one the running child started itself.
// One helper with a role and a task long enough to fold, which a child's card shows above a divider.
const LOGS_ROLE = 'You are a skeptical, read-only log reader. Do not edit files, do not start subagents.'
const LOGS_TASK = 'Read the logs of the last seven days in the git worktree at /tmp/manor-mobile-verify/worktree. Group the errors by service, count each group, and report the three most frequent ones with one example line each. Then compare each count with the week before and note anything that is new. List every file you read so the lead can check your sources, keep each example line to one sentence, and mark any group you could not read completely. Do not modify any file.'
const childOf = (id, toolCallId, title, parentChatId, turnId, depth, rest) => ({
  id, parentChatId, title, toolCallId, turnId, depth, agentId: 'agent-marlow', driver: 'codex', model: 'gpt-6.1-sol', effort: 'high', startedAt: Date.now() - 89_000, ...rest,
})
directory.subagents = [
  childOf('child-count', 'subagent_count', 'Count the files', 'chat-background-wake', 'turn-k1', 1, { state: 'done', endedAt: Date.now() - 40_000 }),
  childOf('child-logs', 'subagent_logs', 'Read the logs', 'chat-background-wake', 'turn-k1', 1, {
    state: 'running',
    ask: { requestId: 'request-child-logs', questions: [{ id: 'range', question: 'Which logs should I read?', options: [{ label: 'Today', description: 'Only the logs of today' }, { label: 'This week', description: 'The last seven days' }] }] },
  }),
  childOf('child-grep', 'subagent_grep', 'Search the errors', 'child-logs', 'turn-logs', 2, { state: 'failed', reason: 'The provider dropped the connection.', endedAt: Date.now() - 60_000 }),
]

const note = (id, minutesAgo, text, extra) => ({ id, ts: now - minutesAgo * 60_000, type: 'system_note', kind: 'info', text, ...extra })
// Plain back and forth after the cards, so they sit above the screen when the chat opens.
const chatter = (prefix, agentId, minutesAgo, count) => Array.from({ length: count }, (_, index) => {
  const ts = now - minutesAgo * 60_000 + index * 1_000
  return [
    { id: `${prefix}-u${index}`, ts, type: 'user_message', text: `Nog een vraag tussendoor, nummer ${index + 1}.`, mentions: [] },
    { id: `${prefix}-a${index}`, ts: ts + 1, type: 'agent_message', turnId: `turn-${prefix}-${index}`, agentId, messageId: `${prefix}-m${index}`,
      text: 'Helder, dat pak ik mee. Verder geen nieuws.' },
    { id: `${prefix}-r${index}`, ts: ts + 2, type: 'turn_result', turnId: `turn-${prefix}-${index}`, agentId },
  ]
}).flat()
// One message_agent turn, in Wren's DM unless `agentId` says otherwise; without `ack` it ends
// silent, the way a model sometimes does. `memory` is a line the turn wrote to memory, which
// the long-press sheet of its reply reaches.
const consultation = (prefix, minutesAgo, peerAgentId, question, ack, { memory, agentId = 'agent-wren' } = {}) => {
  const ts = now - minutesAgo * 60_000
  const turnId = `turn-${prefix}`
  const pairChatId = `pair-${agentId.replace('agent-', '')}-${peerAgentId}`
  return [
    { id: `${prefix}-u`, ts, type: 'user_message', text: question, mentions: [] },
    ...(ack === undefined ? [] : [{ id: `${prefix}-ack`, ts: ts + 1, type: 'agent_message', agentId, turnId, messageId: `${prefix}-m1`, text: ack }]),
    { id: `${prefix}-tool`, ts: ts + 2, type: 'tool_use', agentId, turnId, toolCallId: `${prefix}-call`, tool: 'message_agent' },
    { id: `${prefix}-sent`, ts: ts + 3, type: 'agent_relay', agentId, peerAgentId, pairChatId,
      turnId, relayId: `relay-${prefix}`, phase: 'sent', preview: question },
    { id: `${prefix}-done`, ts: ts + 4, type: 'tool_result', agentId, turnId, toolCallId: `${prefix}-call`, outcome: 'success' },
    { id: `${prefix}-result`, ts: ts + 5, type: 'turn_result', agentId, turnId,
      ...(memory === undefined ? {} : { memoryChanges: [{ path: `/fixture/notes/memory/agents/${agentId}.md`, lines: [{ kind: 'added', text: memory }] }] }) },
  ]
}
const snapshots = {
  // A settled turn with a long mixed tool run: grouped reads, searches and helper polls,
  // a failed command with its reason, and enough rows that the opened run folds its oldest.
  'chat-mobile-inbox': (() => {
    const t = now - 30 * 60_000
    const a = { turnId: 'turn-trace', agentId: '__single__' }
    const calls = [
      ['Read', { detail: 'apps/server/src/drivers/codexDriver.ts', targets: ['apps/server/src/drivers/codexDriver.ts'] }],
      ['Read', { detail: 'apps/server/src/drivers/edits.ts', targets: ['apps/server/src/drivers/edits.ts'] }],
      ['Read', { detail: 'apps/server/src/workCompletion.ts', targets: ['apps/server/src/workCompletion.ts'], subject: 'workCompletion.ts, lines 350–365' }],
      ['Grep', { subject: '“fileChange|editsFromCodex” in drivers', targets: ['apps/server/src/drivers'] }],
      ['Grep', { subject: '“editsFromApplyPatch” in src', targets: ['apps/server/src'] }],
      ['Shell', { subject: 'Run the capped-targets probe', detail: 'pnpm exec vitest run --config vitest.review.config.ts test/.review/capped.test.ts', command: 'pnpm exec vitest run --config vitest.review.config.ts test/.review/capped.test.ts' }, 'Error: Cannot find module test/.review/capped.test.ts'],
      ['Shell', { detail: 'cd /Users/me/Manor && pnpm exec vitest run test/workCompletion.test.ts 2>&1 | tail -30', command: 'cd /Users/me/Manor && pnpm exec vitest run test/workCompletion.test.ts 2>&1 | tail -30' }],
      ['Shell', { detail: "python3 - <<'PY' from pathlib import Path", command: "python3 - <<'PY'\nfrom pathlib import Path\nprint(len(Path('a').read_text()))\nPY" }],
      ['mcp__manor__task_result', {}],
      ['mcp__manor__task_result', {}],
      ['mcp__manor__task_result', {}],
      ['Shell', { detail: 'git status --short', command: 'git status --short' }],
      ['Shell', { detail: 'pnpm exec tsc --noEmit', command: 'pnpm exec tsc --noEmit' }],
      ['Shell', { subject: 'Count capped hunks per file', detail: 'node scripts/count.mjs', command: 'node scripts/count.mjs' }],
      ['Shell', { subject: 'Rebuild the web bundle', detail: 'pnpm --filter @manor/web build', command: 'pnpm --filter @manor/web build' }],
      ['Shell', { detail: 'git diff --stat', command: 'git diff --stat' }],
      ['Shell', { subject: 'List the review probes', detail: 'ls test/.review', command: 'ls test/.review' }],
      ['mcp__manor__set_session_status', {}],
      ['mcp__manor__goal_reached', {}],
    ]
    return [
      { id: 'mt-u', ts: t, type: 'user_message', text: 'Draai de review-probe.', mentions: [] },
      { id: 'mt-m1', ts: t + 1_000, type: 'agent_message', ...a, messageId: 'mt-m1', text: 'Ik draai de review-probe en kijk naar de capping.' },
      ...calls.flatMap(([tool, fields, error], index) => [
        { id: `mt-c${index}`, ts: t + 2_000 + index * 2, type: 'tool_use', ...a, toolCallId: `mt-call-${index}`, tool, ...fields },
        { id: `mt-r${index}`, ts: t + 2_001 + index * 2, type: 'tool_result', ...a, toolCallId: `mt-call-${index}`,
          outcome: error === undefined ? 'success' : 'error', ...(error === undefined ? {} : { error }) },
      ]),
      { id: 'mt-m2', ts: t + 60_000, type: 'agent_message', ...a, messageId: 'mt-m2', text: 'De probe stond nog niet op disk; de tests zijn groen.' },
      // A table wider than the screen (three capped columns), then one that fits.
      { id: 'mt-m3', ts: t + 60_002, type: 'agent_message', ...a, messageId: 'mt-m3', text: [
        '| Project | Wat het doet | Waarom relevant voor Manor |',
        '| --- | --- | --- |',
        '| Aster | Visuele editor voor Next.js en Tailwind in de browser | Koppelt elk element in de preview aan de code die het tekent |',
        '| Brandwerk | Klein project voor losse HTML bestanden | Injecteert een script om elementen te kiezen zonder build |',
        '| Cobalt | Agent in de browser voor Next.js, Astro en Vite | Je klikt een element en de agent past de bron aan |',
        '',
        'Daarna een korte tabel:',
        '',
        '| Naam | Status |',
        '| --- | --- |',
        '| Aster | Open |',
        '| Cobalt | Klaar |',
      ].join('\n') },
      { id: 'mt-r', ts: t + 60_003, type: 'turn_result', ...a },
    ]
  })(),
  'chat-dm-smith': [
    { id: 'u1', ts: now - 11 * 60_000, type: 'user_message', text: 'Laat Wren een Markdown-export bouwen.', mentions: [] },
    note('n1', 10, 'Session proposed.', { workHandoffId: handoff.id, workHandoffVersion: 1, workHandoffPhase: 'created' }),
    note('r2', 8, 'You can now export a chat as Markdown from the chat menu.\nThere is no test for an empty chat yet.', { workHandoffId: handoff.id, workHandoffVersion: 2 }),
    { id: 'u2', ts: now - 7 * 60_000, type: 'user_message', text: 'Use the chat title as the file name.', mentions: [] },
    note('n3', 7, 'Changes requested for “Export a chat as Markdown”.', { workHandoffId: handoff.id, workHandoffVersion: 3, workHandoffPhase: 'reopened' }),
    note('b1', 9, 'Session proposed.', { workHandoffId: blockedMerge.id, workHandoffVersion: 1, workHandoffPhase: 'created' }),
    note('b2', 2, 'Cmd+E exports the open chat.', { workHandoffId: blockedMerge.id, workHandoffVersion: 2 }),
    note('r4', 1, 'Export now names the file after the chat title.\nThere is no test for an empty chat yet.', { workHandoffId: handoff.id, workHandoffVersion: 4 }),
    ...chatter('s', 'agent-smith', 0.5, 3),
    // Web links read as sources: pills inline, site icons as Sources bullets, a globe where a site has none.
    { id: 'ws1', ts: now - 12_000, type: 'user_message', text: 'Welke bronnen heb je?', mentions: [] },
    { id: 'ws2', ts: now - 10_000, type: 'agent_message', agentId: 'agent-smith', turnId: 'turn-ws', messageId: 'ws-m1', text: [
      'Vooral E. coli en virussen ([Columbia-studie](https://www.cuimc.columbia.edu/news/x), [Healio](https://www.healio.com/news/x)). '
        + 'Een kapotte site ([geen icoon](https://no-icon.invalid/x)) toont de wereldbol; [mail](mailto:a@example.nl) blijft een link.',
      '',
      'Sources:',
      '',
      '- [Enteric infections in IBD flares (Columbia)](https://www.cuimc.columbia.edu/news/x)',
      '- [Healio, enteric infections and IBD flares](https://www.healio.com/news/x)',
      '- [Missing icon](https://no-icon.invalid/x)',
      '- https://pubmed.ncbi.nlm.nih.gov/123/',
    ].join('\n') },
    // Inline pills on the tinted bubble (quote, destination, code, a file path by its name) take its wash.
    { id: 'wq1', ts: now - 8_000, type: 'user_message', mentions: [], text: 'Maakt voor nu niet uit [Quote #1], open @browser en draai `pnpm test` op `apps/mobile/src/components/Markdown.tsx`.',
      quotes: [{ kind: 'message', eventId: 'ws2', agentId: 'agent-smith', text: 'controle is onvolledig' }] },
    // A table wider than the screen inside a bubble: it scrolls sideways and fades where columns hide; the rest of the bubble still swipes to reply.
    { id: 'wt1', ts: now - 6_000, type: 'agent_message', agentId: 'agent-smith', turnId: 'turn-wt', messageId: 'wt-m1', text: [
      'Drie tools in een tabel:',
      '',
      '| Project | Wat het doet | Waarom relevant voor Manor |',
      '| --- | --- | --- |',
      '| Aster | Visuele editor voor Next.js en Tailwind in de browser | Koppelt elk element in de preview aan de code die het tekent |',
      '| Brandwerk | Klein project voor losse HTML bestanden | Injecteert een script om elementen te kiezen zonder build |',
    ].join('\n') },
  ],
  // The project thread holds the session's question as a system note.
  'chat-thread-manor': [
    { id: 'th1', ts: now - 6 * 60_000, type: 'user_message', text: 'Bouw een exportknop voor de chat.', mentions: [] },
    // A DM brief handed to the thread at Accept: the phone shows its task as the kickoff card.
    { id: 'th-brief', ts: now - 5 * 60_000, type: 'user_message', source: 'project_thread', threadReason: 'brief', mentions: [],
      text: '[Manor] Smith handed this brief over from a DM, and Sam already accepted it there. Call start_work in this turn.\nTitle: Fix the date labels\nFirst executor: Smith\nTask:\n## Outcome\nThe date labels in the transcript read wrong across midnight and in other time zones, so a message sent at 23:58 shows tomorrow\'s date for a moment.\n\n## Scope\nWeb and phone transcripts, the sidebar ages and the Session overview rows. No server change.\n\n## Done when\nA test covers the midnight and DST cases, and the spike shows the right labels.' },
    { id: 'th-voice', ts: now - 4 * 60_000, type: 'agent_message', turnId: 'turn-th-voice', agentId: '__single__', messageId: 'th-voice-m1', text: 'The export Session is ready to start.' },
    { id: 'th-voice-result', ts: now - 4 * 60_000 + 1, type: 'turn_result', turnId: 'turn-th-voice', agentId: '__single__', reportedModel: 'gpt-6.1-sol' },
    note('th-write', 3, 'Manor saved 1 line to notes.md: Export is in progress.', {
      projectFileWrite: { action: 'add', file: 'notes.md', line: 'Export is in progress.', by: 'Project thread' },
    }),
    note('th-question', 2, 'Exportknop heeft een vraag.', {
      sessionQuestion: {
        sessionChatId: 'chat-thread-session',
        requestId: 'request-thread-1',
        agentId: 'agent-wren',
        title: 'Exportknop',
        questions: EXPORT_QUESTIONS,
      },
    }),
    // The thread's advice on it: no turn in the thread, a line on the question card.
    { id: 'th-wake', ts: now - 2 * 60_000 + 1, type: 'user_message', source: 'project_thread', threadReason: 'question', threadDelivered: ['th-question'], text: '[Manor] The session is waiting on a question.', mentions: [] },
    { id: 'th-advice', ts: now - 2 * 60_000 + 2, type: 'agent_message', turnId: 'turn-th-advice', agentId: '__single__', messageId: 'th-advice-m1', text: 'Ik zou de eerste optie kiezen: die sluit aan bij hoe de rest van het menu werkt.' },
    { id: 'th-advice-result', ts: now - 2 * 60_000 + 3, type: 'turn_result', turnId: 'turn-th-advice', agentId: '__single__', reportedModel: 'gpt-6.1-sol' },
  ],
  // A Single context reading on each: the thread rolls over like a DM and shows no ring,
  // the ordinary Single Session shows 88k of 400k.
  'chat-thread-notes': [
    ...notesSessions.map((session) => note(`tn-${session.id}`, (now - session.createdAt) / 60_000, 'Session proposed.',
      { workHandoffId: session.id, workHandoffVersion: 1, workHandoffPhase: 'created' })),
    // One reply that wrote three lines: the thread folds them under it as footnotes.
    { id: 'tw-u', ts: now - 6 * 60_000, type: 'user_message', text: 'Onthoud dat hoeken rond zijn en lijstrijen één scheidingslijn houden.', mentions: [] },
    { id: 'tw-a', ts: now - 6 * 60_000 + 1, type: 'agent_message', turnId: 'turn-tw', agentId: '__single__', messageId: 'tw-m1', text: 'Vastgelegd in de voorkeuren en de notities.' },
    ...[['tw-1', 'preferences.md', 'Corners are always round'], ['tw-2', 'preferences.md', 'List rows keep one hairline divider'], ['tw-3', 'notes.md', 'Export shipped in 0.9']]
      .map(([id, file, line], index) => ({ id, ts: now - 6 * 60_000 + 2 + index, type: 'system_note', kind: 'info', text: line,
        projectFileWrite: { file, action: 'add', line, by: 'Project thread', turnId: 'turn-tw' } })),
    { id: 'tw-r', ts: now - 6 * 60_000 + 10, type: 'turn_result', turnId: 'turn-tw', agentId: '__single__' },
    { id: 'tn1', ts: now - 5 * 60_000, type: 'user_message', text: 'Zet alles klaar.', mentions: [] },
    { id: 'tn2', ts: now - 4 * 60_000, type: 'agent_message', turnId: 'turn-tn', agentId: '__single__', messageId: 'tn-m1', text: 'Alles staat klaar.' },
    { id: 'tn3', ts: now - 4 * 60_000 + 1, type: 'turn_result', turnId: 'turn-tn', agentId: '__single__', contextTokens: 120_000, contextWindow: 400_000 },
    // The user's message the thread sent on to its Session: "Sent to" under their bubble, the Session under the reply.
    { id: 'tn4', ts: now - 3 * 60_000, type: 'user_message', text: 'Zet ook pasta op het weekmenu.', mentions: [] },
    note('tn5', 3 - 1 / 60_000, 'Sent to “Weekmenu”.', { hintFor: 'tn4', sessionForward: { sessionChatId: 'chat-notes-session', title: 'Weekmenu', turnId: 'turn-tn-forward', agentId: '__single__' } }),
    { id: 'tn6', ts: now - 3 * 60_000 + 2, type: 'agent_message', turnId: 'turn-tn-forward', agentId: '__single__', messageId: 'tn-m2', text: 'Doorgestuurd naar Weekmenu. Die meldt zich hier als het klaar is.' },
    { id: 'tn7', ts: now - 3 * 60_000 + 3, type: 'turn_result', turnId: 'turn-tn-forward', agentId: '__single__', contextTokens: 121_000, contextWindow: 400_000 },
    // A turn still running with a tool call: the phone shows the working face and no tool row.
    { id: 'tr-u', ts: now - 20_000, type: 'user_message', text: 'Werk de notities bij.', mentions: [] },
    { id: 'tr-tool', ts: now - 19_000, type: 'tool_use', turnId: 'turn-tr', agentId: '__single__', toolCallId: 'tr-read', tool: 'Read', subject: 'notes.md', detail: 'notes.md' },
  ],
  // The Session holds the forwarded message as the user's own, attributed to the Notities thread.
  'chat-notes-session': [
    { id: 'wm1', ts: now - 4 * 60_000, type: 'user_message', source: 'work_handoff', mentions: [],
      workAuthorAgentId: '__single__', workTargetLeadId: '__single__', text: 'Weekmenu\n\nMaak het weekmenu voor deze week.' },
    { id: 'wm2', ts: now - 3 * 60_000 + 4, type: 'user_message', text: 'Zet ook pasta op het weekmenu.', mentions: [],
      forwardedFrom: { threadChatId: 'chat-thread-notes', eventId: 'tn4' } },
    { id: 'wm3', ts: now - 2 * 60_000, type: 'agent_message', turnId: 'turn-wm', agentId: '__single__', messageId: 'wm-m1', text: 'Pasta staat op donderdag.' },
    { id: 'wm4', ts: now - 2 * 60_000 + 1, type: 'turn_result', turnId: 'turn-wm', agentId: '__single__' },
  ],
  'chat-tasks-card': [
    // A plan finished in full: its header mark is a check, not a closed ring.
    { id: 'tc0', ts: now - 6 * 60_000 - 1, type: 'todo_update', turnId: 'turn-tc1', agentId: 'agent-marlow', todos: [
      { text: 'Find the date labels', status: 'completed' },
      { text: 'Fix the date format', status: 'completed' },
      { text: 'Check the labels in the list', status: 'completed' },
    ] },
    { id: 'tc1', ts: now - 6 * 60_000, type: 'agent_message', turnId: 'turn-tc1', agentId: 'agent-marlow', messageId: 'tc-m1', text: 'Done: the date labels ship.' },
    { id: 'tc2', ts: now - 6 * 60_000 + 1, type: 'turn_result', turnId: 'turn-tc1', agentId: 'agent-marlow' },
    // An ended turn whose plan stopped before its last two steps: they read as skipped, not to do.
    { id: 'tp1', ts: now - 5.8 * 60_000, type: 'user_message', text: 'Ruim de exportcode op.', mentions: [] },
    { id: 'tp2', ts: now - 5.7 * 60_000, type: 'todo_update', turnId: 'turn-tp', agentId: 'agent-marlow', todos: [
      { text: 'Remove the old exporter', status: 'completed' },
      { text: 'Rename the export helpers', status: 'in_progress' },
      { text: 'Update the export docs', status: 'pending' },
    ] },
    { id: 'tp3', ts: now - 5.6 * 60_000, type: 'agent_message', turnId: 'turn-tp', agentId: 'agent-marlow', messageId: 'tp-m1', text: 'De oude exporter is weg.' },
    { id: 'tp4', ts: now - 5.6 * 60_000 + 1, type: 'turn_result', turnId: 'turn-tp', agentId: 'agent-marlow' },
    { id: 'tc3', ts: now - 5 * 60_000, type: 'user_message', mentions: ['agent-marlow'], confirmRequest: { variant: 'checkout', worktrees: [] },
      text: "[Manor] Sam confirmed the ready result, and that is their approval to commit. @Marlow, commit this Session's reviewed changes now: stage only the files this Session changed, leave other chats' changes out, and do not push." },
    { id: 'tc4', ts: now - 5 * 60_000 + 500, type: 'agent_message', turnId: 'turn-tc2', agentId: 'agent-marlow', messageId: 'tc-m2', text: 'Committed the result.' },
    { id: 'tc5', ts: now - 5 * 60_000 + 501, type: 'turn_result', turnId: 'turn-tc2', agentId: 'agent-marlow' },
    { id: 'tc6', ts: now - 60_000, type: 'user_message', text: 'Maak de exportknop af.', mentions: [] },
    { id: 'tc7', ts: now - 55_000, type: 'todo_update', turnId: 'turn-tc3', agentId: 'agent-marlow', todos: [
      { text: 'Reproduce the export bug', status: 'completed' },
      { text: 'Add the CSV writer', status: 'in_progress' },
      { text: 'Wire the download button', status: 'pending' },
      { text: 'Add an export test, final run', status: 'pending' },
    ] },
    { id: 'tc8', ts: now - 50_000, type: 'tool_use', turnId: 'turn-tc3', agentId: 'agent-marlow', tool: 'Read', toolCallId: 'tc-read', detail: 'exportChat.ts' },
  ],
  'chat-inline-steer': [
    { id: 'is1', ts: now - 60_000, type: 'user_message', text: 'Bekijk de bestanden.', mentions: [] },
    { id: 'is2', ts: now - 55_000, type: 'reasoning', turnId: 'turn-inline', agentId: '__single__', text: 'I will inspect the files.' },
    { id: 'is3', ts: now - 40_000, type: 'user_message', text: 'Waar kijk je allemaal naar?', mentions: [], steersTurnId: 'turn-inline',
      steerAfter: { messageId: 'inline-message', textOffset: 'Ik bekijk de bestanden. '.length } },
    { id: 'is4', ts: now - 30_000, type: 'agent_message', turnId: 'turn-inline', agentId: '__single__', messageId: 'inline-message', text: 'Ik bekijk de bestanden. Ik controleer ook de berichtvolgorde.' },
    { id: 'is5', ts: now - 20_000, type: 'tool_use', turnId: 'turn-inline', agentId: '__single__', tool: 'Read', toolCallId: 'inline-read', detail: 'transcriptState.ts' },
    { id: 'is6', ts: now - 19_000, type: 'tool_result', turnId: 'turn-inline', agentId: '__single__', toolCallId: 'inline-read', outcome: 'success' },
    { id: 'is7', ts: now - 10_000, type: 'agent_message', turnId: 'turn-inline', agentId: '__single__', text: 'De volgorde klopt. Je toevoeging staat tussen het eerdere en latere werk.' },
    { id: 'is8', ts: now - 9_000, type: 'turn_result', turnId: 'turn-inline', agentId: '__single__' },
  ],
  // Four files: a two-hunk edit with a long line, a new file on a long home path, a
  // deletion and a one-line edit. The pill above the composer opens the sheet on them.
  'chat-diff-files': (() => {
    const turnId = 'turn-diff'
    const agentId = '__single__'
    const sheet = 'apps/mobile/src/components/DiffSheet.tsx'
    const files = [
      { id: 'df-sheet', tool: 'Edit', edits: [
        { path: `/tmp/manor-mobile-verify/Manor/${sheet}`, panelPath: sheet, offset: { before: 14, after: 14 },
          before: '/**\n * How many rows one hunk renders.\n */\nconst MAX_HUNK_ROWS = 400\n\nconst OPEN_UP_TO_FILES = 5\n',
          after: '/**\n * How many rows one hunk renders.\n */\nconst MAX_HUNK_ROWS = 400\n\n/** How much of one line a row draws; lines scroll sideways instead of wrapping into a paragraph. */\nconst MAX_LINE_CHARS = 400\n\nconst ROW_HEIGHT = 18\n' },
        { path: `/tmp/manor-mobile-verify/Manor/${sheet}`, panelPath: sheet, offset: { before: 96, after: 99 },
          before: 'function Hunk({ edit, startOpen }: { edit: FileEdit; startOpen: boolean }) {\n  const [open, setOpen] = useState(startOpen)\n  const stat = editStat(edit)\n',
          after: 'function Hunk({ edit, labelled }: { edit: FileEdit; labelled: boolean }) {\n  const rows = useMemo(() => numberedDiff(collapseContext(editLines(edit)), edit.offset), [edit])\n' },
      ] },
      { id: 'df-brief', tool: 'Write', edits: [
        { path: '/Users/sam/.manor/scratch/example-briefs/research/slices/desktop-workspace-and-persistent-agents/common-instructions.txt', created: true,
          after: 'You are reading one slice of the open-source project "Example", a local-first Electron desktop workspace for persistent AI agents.\n\nPurpose: a research report for a designer who builds a similar app.\n\nHard rules:\n- Read only. Do not install, build, run, or execute anything from the repo.\n- Every claim needs file:line evidence (path relative to the repo root, plus line number or range).\n' },
      ] },
      { id: 'df-old', tool: 'Bash', edits: [
        { path: '/tmp/manor-mobile-verify/Manor/apps/mobile/src/components/OldDiffRows.tsx', panelPath: 'apps/mobile/src/components/OldDiffRows.tsx', kind: 'delete',
          before: "export function OldDiffRows() {\n  return null\n}\n" },
      ] },
      { id: 'df-runtime', tool: 'Edit', edits: [
        { path: '/tmp/manor-mobile-verify/Manor/packages/client-runtime/src/changedFiles.ts', panelPath: 'packages/client-runtime/src/changedFiles.ts', offset: { before: 40, after: 40 },
          before: '  const key = panelPath ?? origin ?? edit.path\n', after: '  const key = panelPath ?? origin ?? normalizedAbsolute(edit.path) ?? edit.path\n' },
      ] },
    ]
    const ts = now - 3 * 60_000
    return [
      { id: 'df0', ts: ts - 60_000, type: 'user_message', text: 'Maak het wijzigingenoverzicht op de telefoon rustiger.', mentions: [] },
      ...files.flatMap((file, index) => [
        { id: `${file.id}-u`, ts: ts - 50_000 + index * 2, type: 'tool_use', turnId, agentId, toolCallId: file.id, tool: file.tool, detail: file.edits[0].path, edits: file.edits },
        { id: `${file.id}-r`, ts: ts - 50_000 + index * 2 + 1, type: 'tool_result', turnId, agentId, toolCallId: file.id, outcome: 'success' },
      ]),
      { id: 'df1', ts, type: 'agent_message', turnId, agentId, messageId: 'df-m1', text: 'Vier bestanden aangepast.' },
      { id: 'df2', ts: ts + 1, type: 'turn_result', turnId, agentId },
    ]
  })(),
  // Three runs of reads: one picture, four pictures (two thumbnails and +2), then a turn
  // that reads the picture the user attached, which carries no link, beside one that does.
  'chat-trace-images': (() => {
    const agentId = '__single__'
    const dir = '/tmp/manor-mobile-verify/Manor/.cursor/skills/verify-manor/evidence/trace'
    const picture = (index) => ({ target: `${dir}/shot-${index}.png`, src: `/media/trace/${index}/fixture` })
    const step = (id, ts, turnId, use) => [
      { id: `${id}-u`, ts, type: 'tool_use', turnId, agentId, toolCallId: id, ...use },
      { id: `${id}-r`, ts: ts + 1, type: 'tool_result', turnId, agentId, toolCallId: id, outcome: 'success' },
    ]
    const shoot = (id, ts, turnId) => step(id, ts, turnId, { tool: 'Bash', command: 'node shoot.mjs', detail: 'Capture the screenshots' })
    const read = (id, ts, turnId, image, target = image.target) =>
      step(id, ts, turnId, { tool: 'Read', detail: target, targets: [target], ...(image.src === undefined ? {} : { images: [image] }) })
    const ts = now - 2 * 60_000
    const attached = '/tmp/manor-mobile-verify/scratch/chat-trace-images/attachments/ti-u2-0.png'
    return [
      { id: 'ti-u1', ts: ts - 60_000, type: 'user_message', text: 'Controleer de schermen.', mentions: [] },
      { id: 'ti-n1', ts: ts - 59_000, type: 'agent_message', turnId: 'turn-ti1', agentId, messageId: 'ti-m1', text: 'Eerst het werkscherm.' },
      ...shoot('ti-c1', ts - 58_000, 'turn-ti1'),
      ...read('ti-r1', ts - 57_000, 'turn-ti1', picture(1)),
      { id: 'ti-n2', ts: ts - 56_000, type: 'agent_message', turnId: 'turn-ti1', agentId, messageId: 'ti-m2', text: 'Dan de vier afgeronde schermen.' },
      ...shoot('ti-c2', ts - 55_000, 'turn-ti1'),
      ...[2, 3, 4, 5].flatMap((index) => read(`ti-r${index}`, ts - 54_000 + index * 2, 'turn-ti1', picture(index))),
      { id: 'ti-n3', ts: ts - 50_000, type: 'agent_message', turnId: 'turn-ti1', agentId, messageId: 'ti-m3', text: 'De schermen kloppen.' },
      { id: 'ti-e1', ts: ts - 49_999, type: 'turn_result', turnId: 'turn-ti1', agentId },
      { id: 'ti-u2', ts: ts - 40_000, type: 'user_message', text: 'Zo ziet [Image #1] er nu uit.', mentions: [], images: [{ name: 'scherm.png', src: '/media/trace/0/fixture', width: 1024, height: 1024 }] },
      ...shoot('ti-c3', ts - 39_000, 'turn-ti2'),
      ...read('ti-r6', ts - 38_000, 'turn-ti2', {}, attached),
      ...read('ti-r7', ts - 37_000, 'turn-ti2', picture(1)),
      { id: 'ti-n4', ts: ts - 36_000, type: 'agent_message', turnId: 'turn-ti2', agentId, messageId: 'ti-m4', text: 'Jouw scherm en het werkscherm komen overeen.' },
      { id: 'ti-e2', ts: ts - 35_999, type: 'turn_result', turnId: 'turn-ti2', agentId },
      // Two marked pictures from the Mac; their unmarked originals ride at the end and the bubble hides them.
      { id: 'ti-u3', ts: ts - 30_000, type: 'user_message', text: 'Kijk naar [Image #1] en [Image #2].', mentions: [], images: [
        { name: 'werk.png', src: '/media/trace/1/fixture', width: 1024, height: 1024, annotation: { original: 2, pins: [{ x: 0.5, y: 0.4, comment: 'Te druk' }], shapes: [] } },
        { name: 'klaar.png', src: '/media/trace/2/fixture', width: 1024, height: 1024, annotation: { original: 3, pins: [], shapes: [], strokes: [[[0.2, 0.2], [0.8, 0.6]]] } },
        { name: 'werk.png', src: '/media/trace/3/fixture', width: 1024, height: 1024 },
        { name: 'klaar.png', src: '/media/trace/4/fixture', width: 1024, height: 1024 },
      ] },
      { id: 'ti-n5', ts: ts - 29_000, type: 'agent_message', turnId: 'turn-ti3', agentId, messageId: 'ti-m5', text: 'Gezien.' },
      { id: 'ti-e3', ts: ts - 28_999, type: 'turn_result', turnId: 'turn-ti3', agentId },
    ]
  })(),
  // Three mail cards in three turns: an open draft with a Cc line, Sent with the
  // persona's confirmation below it, and Discarded last, so the folds fill the first screen. Send and Discard are only acked here.
  'chat-mail-drafts': (() => {
    const agentId = '__single__'
    const mail = (id, extra) => ({ draftId: id, channel: 'gmail', to: 'info@example.com', from: 'you@example.com', subject: 'Portfolio', body: 'Hi, here is the portfolio link you asked for.', ...extra })
    const turn = (n, minutesAgo, ask, draft, after) => {
      const ts = now - minutesAgo * 60_000
      const turnId = `turn-mail-${n}`
      return [
        { id: `md${n}-u`, ts, type: 'user_message', text: ask, mentions: [] },
        { id: `md${n}-d`, ts: ts + 1, type: 'outbound_draft', turnId, agentId, ...draft },
        { id: `md${n}-m`, ts: ts + 2, type: 'agent_message', turnId, agentId, messageId: `md${n}-m`, text: 'Here is the mail. Check it and send it when it reads right.' },
        { id: `md${n}-r`, ts: ts + 3, type: 'turn_result', turnId, agentId },
        ...after(ts, turnId),
      ]
    }
    const closed = (id, ts, turnId, draft, extra) => ({ id, ts, type: 'outbound_draft_closed', turnId, agentId, draftId: draft.draftId, channel: 'gmail', to: draft.to, subject: draft.subject, body: draft.body, ...extra })
    const sent = mail('draft-sent', { cc: 'sam@example.com' })
    const dropped = mail('draft-dropped', { subject: 'Thursday', body: 'Can we move Thursday to ten?' })
    return [
      ...turn(1, 8, 'Draft a thank-you to info@example.com, cc Sam.', mail('draft-open', { subject: 'Thank you', cc: 'sam@example.com', body: 'Thanks for the call today. I will send the case study by Friday.' }), () => []),
      ...turn(2, 5, 'Mail info@example.com the portfolio link, cc Sam.', sent, (ts, turnId) => [
        closed('md2-c', ts + 30_000, turnId, sent, { outcome: 'submitted', delivery: 'delivered', cc: sent.cc }),
        { id: 'md2-s', ts: ts + 30_001, type: 'agent_message', turnId, agentId, messageId: 'md2-s', text: 'Sent to info@example.com.' },
      ]),
      ...turn(3, 2, 'Ask info@example.com to move Thursday.', dropped, (ts, turnId) => [closed('md3-c', ts + 20_000, turnId, dropped, { outcome: 'discarded' })]),
    ]
  })(),
  'chat-single-notes': [
    { id: 'sn1', ts: now - 2 * 60_000, type: 'user_message', text: 'Zet de notities klaar.', mentions: [] },
    { id: 'sn2', ts: now - 60_000, type: 'agent_message', turnId: 'turn-sn', agentId: '__single__', messageId: 'sn-m1', text: 'De notities staan klaar.' },
    { id: 'sn3', ts: now - 60_000 + 1, type: 'turn_result', turnId: 'turn-sn', agentId: '__single__', contextTokens: 88_000, contextWindow: 400_000 },
    // The same pills on a plain Session bubble, where the quote stays blue.
    { id: 'sn4', ts: now - 30_000, type: 'user_message', mentions: [], text: 'Maakt voor nu niet uit [Quote #1], open @browser en draai `pnpm test` op `apps/mobile/src/components/Markdown.tsx`.',
      quotes: [{ kind: 'message', eventId: 'sn2', agentId: '__single__', text: 'controle is onvolledig' }] },
  ],
  // Blocked on a secret card. The fixture counts a submitted value and never keeps it.
  'chat-secret-token': [
    { id: 'sc1', ts: now - 3 * 60_000, type: 'user_message', text: 'Deploy de site.', mentions: [] },
    { id: 'sc2', ts: now - 2 * 60_000, type: 'user_input_request', turnId: 'turn-secret-1', agentId: '__single__', requestId: 'request-secret-1', questions: [{
      id: 'secret', header: 'Vercel token', question: 'Needed to deploy the site.', options: [{ label: 'Enter it' }, { label: 'Decline' }],
      optionsOnly: true, desktopOnly: true, secret: { target: 'command', command: 'vercel deploy --token "$VERCEL_TOKEN"', env: 'VERCEL_TOKEN' },
    }] },
  ],
  // The session's turn runs and is blocked on the same question (see activeTurns).
  'chat-thread-session': [
    { id: 'ts1', ts: now - 290_000, type: 'user_message', source: 'work_handoff', mentions: [],
      workProjectName: 'Manor', workAuthorAgentId: 'agent-wren', workTargetLeadId: 'agent-wren', text: 'Exportknop\n\nVoeg een exportknop toe aan het chatmenu.' },
    { id: 'ts2', ts: now - 2 * 60_000, type: 'user_input_request', turnId: 'turn-thread-1', agentId: 'agent-wren', requestId: 'request-thread-1',
      questions: EXPORT_QUESTIONS },
  ],
  'chat-dm-marlow': [
    // A day ago, then hours of a relay line and a system line with no message between them:
    // no time line of their own, one time line above the next bubble.
    { id: 'y1', ts: now - 26 * 60 * 60_000, type: 'user_message', text: 'Wat staat er morgen op de planning?', mentions: [] },
    { id: 'y2', ts: now - 26 * 60 * 60_000 + 1, type: 'agent_message', turnId: 'turn-y', agentId: 'agent-marlow', messageId: 'y-m', text: 'Twee afspraken en de release.' },
    { id: 'y3', ts: now - 26 * 60 * 60_000 + 2, type: 'turn_result', turnId: 'turn-y', agentId: 'agent-marlow' },
    { id: 'y-relay', ts: now - 24 * 60 * 60_000, type: 'agent_relay', agentId: 'agent-marlow', peerAgentId: 'agent-sage', pairChatId: 'pair-marlow-agent-sage',
      turnId: 'turn-y-sage', relayId: 'relay-y', phase: 'received', preview: 'Even ter info.' },
    note('y-note', 20 * 60, 'Marlow stopped.'),
    { id: 'p1', ts: now - 7 * 60_000, type: 'user_message', text: 'Zet de datumlabels en de release note klaar.', mentions: [] },
    note('p-handoff-labels', 6, 'Session proposed.', { workHandoffId: 'handoff-labels', workHandoffVersion: 1, workHandoffPhase: 'created' }),
    note('p-handoff-notes-v1', 5, 'Session proposed.', { workHandoffId: 'handoff-notes-v1', workHandoffVersion: 1, workHandoffPhase: 'created' }),
    { id: 'p5', ts: now - 4.5 * 60_000, type: 'user_message', text: 'Neem de changelog mee in de release note.', mentions: [] },
    note('p-handoff-notes', 4, 'Session proposed.', { workHandoffId: 'handoff-notes', workHandoffVersion: 1, workHandoffPhase: 'created' }),
    note('p-handoff-notes-v1-settled', 4, 'Session proposal “Draft the release note” was replaced by v2.', { workHandoffId: 'handoff-notes-v1', workHandoffVersion: 2, workHandoffPhase: 'settled' }),
    { id: 'p2', ts: now - 3.5 * 60_000, type: 'user_message', text: 'Hoe staat het met de rest?', mentions: [] },
    { id: 'p3', ts: now - 3.5 * 60_000 + 1, type: 'agent_message', turnId: 'turn-p3', agentId: 'agent-marlow', messageId: 'p-m3', text: 'Beide voorstellen wachten op je Accept. Verder loopt alles.' },
    { id: 'p4', ts: now - 3.5 * 60_000 + 2, type: 'turn_result', turnId: 'turn-p3', agentId: 'agent-marlow' },
    ...chatter('m', 'agent-marlow', 3, 3),
    // A consultation that also wrote memory: the mark is in the reply's long-press sheet, never a row.
    // Its send and reply merge into one "2 messages with Sage" line that opens the pair.
    ...consultation('mc', 2, 'agent-sage', 'Vraag Sage of de datumlabels klaar zijn.', 'Ik vraag het Sage; haar antwoord volgt.',
      { memory: '- Date labels go past Sage first.', agentId: 'agent-marlow' }),
    { id: 'mc-received', ts: now - 1.5 * 60_000, type: 'agent_relay', agentId: 'agent-marlow', peerAgentId: 'agent-sage', pairChatId: 'pair-marlow-agent-sage',
      turnId: 'turn-mc', relayId: 'relay-mc', phase: 'received', preview: 'Ja, ze zijn klaar.' },
    { id: 'mc-return', ts: now - 1.5 * 60_000 + 1, type: 'agent_message', agentId: 'agent-marlow', turnId: 'turn-mc-return', messageId: 'mc-m2', text: 'Sage zegt dat de datumlabels klaar zijn.' },
    { id: 'mc-return-result', ts: now - 1.5 * 60_000 + 2, type: 'turn_result', agentId: 'agent-marlow', turnId: 'turn-mc-return' },
    // A send still waiting on its reply keeps its own "Messaged" line.
    ...consultation('ms', 1.3, 'agent-smith', 'Vraag Smith naar de review.', 'Ik vraag het Smith; zijn antwoord volgt.', { agentId: 'agent-marlow' }),
    // Bubble chips: a reply row plus a file, and a picture with text. The picture sits above the bubble.
    { id: 'mc-reply', ts: now - 60_000, type: 'user_message', mentions: [], text: 'Dit moeten wij dus ook hebben?',
      replyTo: { turnId: 'turn-mc-return', agentId: 'agent-marlow', text: 'Sage zegt dat de datumlabels klaar zijn.' },
      files: [{ name: 'notities.md', mime: 'text/markdown', content: '# Notities\n\nDatumlabels nakijken.\n' }] },
    { id: 'mc-image', ts: now - 30_000, type: 'user_message', mentions: [], text: 'Zo ziet [Image #1] er nu uit.',
      images: [{ name: evidence[0].name, src: evidence[0].src, width: evidence[0].width, height: evidence[0].height }] },
    // Two turns that handed files over: two pictures, then a picture and a PDF. Pictures
    // show as pictures without a row, and a press opens the viewer over that message's.
    { id: 'wd-ask', ts: now - 25_000, type: 'user_message', text: 'Stuur de twee icoonvarianten.', mentions: [] },
    { id: 'wd-say', ts: now - 25_000 + 1, type: 'agent_message', agentId: 'agent-marlow', turnId: 'turn-wd', text: 'Hier zijn ze, donker en getint.' },
    ...['icon-dark.png', 'icon-tinted.png'].map((name, index) => delivered(`wd-f${index}`, now - 25_000 + 2 + index, 'turn-wd', name)),
    { id: 'wd-result', ts: now - 25_000 + 5, type: 'turn_result', agentId: 'agent-marlow', turnId: 'turn-wd' },
    { id: 'we-ask', ts: now - 20_000, type: 'user_message', text: 'En het splash-icoon met de planning?', mentions: [] },
    { id: 'we-say', ts: now - 20_000 + 1, type: 'agent_message', agentId: 'agent-marlow', turnId: 'turn-we', text: 'Het icoon en de planning als PDF.' },
    ...['splash-icon.png', 'planning.pdf'].map((name, index) => delivered(`we-f${index}`, now - 20_000 + 2 + index, 'turn-we', name)),
    { id: 'we-result', ts: now - 20_000 + 5, type: 'turn_result', agentId: 'agent-marlow', turnId: 'turn-we' },
  ],
  'chat-background-wait': [
    { id: 'b1', ts: now - 60_000, type: 'user_message', text: 'Run background helpers, please.', mentions: [] },
    { id: 'b2', ts: now - 58_000, type: 'tool_use', turnId: 'turn-bg', agentId: 'agent-marlow', toolCallId: 'bg-figure', tool: 'Agent',
      subject: 'Build the trust figure', background: true, subagent: { title: 'Build the trust figure', prompt: 'Build the trust figure.' } },
    { id: 'b3', ts: now - 57_000, type: 'tool_use', turnId: 'turn-bg', agentId: 'agent-marlow', toolCallId: 'bg-receipt', tool: 'Agent',
      subject: 'Check the receipt', background: true, subagent: { title: 'Check the receipt', prompt: 'Check the receipt.' } },
    { id: 'b4', ts: now - 56_000, type: 'tool_use', turnId: 'turn-bg', agentId: 'agent-marlow', toolCallId: 'bg-build', tool: 'Bash',
      command: 'pnpm build', detail: 'pnpm build', background: true },
    { id: 'b5', ts: now - 55_000, type: 'agent_message', turnId: 'turn-bg', agentId: 'agent-marlow', messageId: 'bg-m1',
      text: 'Started two helpers and a build in the background. I will report back.' },
  ],
  'child-count': [
    { id: 'cc1', ts: now - 89_000, type: 'user_message', source: 'subagent_task', authorAgentId: 'agent-marlow', mentions: [], text: 'Count the files.' },
    { id: 'cc2', ts: now - 60_000, type: 'tool_use', turnId: 'turn-count', agentId: 'agent-marlow', toolCallId: 'count-ls', tool: 'Bash', command: 'ls | wc -l', detail: 'ls | wc -l' },
    { id: 'cc3', ts: now - 59_000, type: 'tool_result', turnId: 'turn-count', agentId: 'agent-marlow', toolCallId: 'count-ls', outcome: 'success', output: '4' },
    { id: 'cc4', ts: now - 41_000, type: 'agent_message', turnId: 'turn-count', agentId: 'agent-marlow', messageId: 'cc-m1', text: 'There are 4 files.' },
    { id: 'cc5', ts: now - 40_000, type: 'turn_result', turnId: 'turn-count', agentId: 'agent-marlow' },
  ],
  'child-logs': [
    { id: 'cl1', ts: now - 88_000, type: 'user_message', source: 'subagent_task', authorAgentId: 'agent-marlow', mentions: [], text: LOGS_TASK },
    { id: 'cl2', ts: now - 80_000, type: 'tool_use', turnId: 'turn-logs', agentId: 'agent-marlow', toolCallId: 'subagent_grep', tool: 'spawn_subagent',
      subject: 'Search the errors', subagent: { title: 'Search the errors', prompt: 'Search the errors.', model: 'gpt-6.1-sol', effort: 'high', driver: 'codex', childChatId: 'child-grep' } },
    { id: 'cl3', ts: now - 60_000, type: 'tool_result', turnId: 'turn-logs', agentId: 'agent-marlow', toolCallId: 'subagent_grep', outcome: 'error', output: 'The provider dropped the connection.' },
    { id: 'cl4', ts: now - 50_000, type: 'agent_message', turnId: 'turn-logs', agentId: 'agent-marlow', messageId: 'cl-m1', text: 'The search failed, so I will read them myself. Which range do you want?' },
    { id: 'cl5', ts: now - 49_000, type: 'turn_result', turnId: 'turn-logs', agentId: 'agent-marlow' },
  ],
  'child-grep': [
    { id: 'cg1', ts: now - 80_000, type: 'user_message', source: 'subagent_task', authorAgentId: 'agent-marlow', mentions: [], text: 'Search the errors.' },
    { id: 'cg2', ts: now - 60_000, type: 'system_note', kind: 'error', text: 'The subagent failed: The provider dropped the connection.' },
  ],
  'chat-background-wake': [
    { id: 'k1', ts: now - 90_000, type: 'user_message', text: 'Count the files and read the logs in the background.', mentions: [] },
    { id: 'k2', ts: now - 89_000, type: 'tool_use', turnId: 'turn-k1', agentId: 'agent-marlow', toolCallId: 'subagent_count', tool: 'spawn_subagent',
      subject: 'Count the files', subagent: { title: 'Count the files', prompt: 'Count the files.', model: 'gpt-6.1-sol', effort: 'high', driver: 'codex', childChatId: 'child-count' } },
    { id: 'k3', ts: now - 88_000, type: 'tool_use', turnId: 'turn-k1', agentId: 'agent-marlow', toolCallId: 'subagent_logs', tool: 'spawn_subagent',
      subject: 'Read the logs', subagent: { title: 'Read the logs', prompt: LOGS_TASK, role: LOGS_ROLE, model: 'gpt-6.1-sol', effort: 'high', driver: 'codex', childChatId: 'child-logs' } },
    { id: 'k4', ts: now - 87_000, type: 'agent_message', turnId: 'turn-k1', agentId: 'agent-marlow', messageId: 'k-m1', text: 'Started two helpers in the background.' },
    { id: 'k5', ts: now - 87_000, type: 'turn_result', turnId: 'turn-k1', agentId: 'agent-marlow' },
    { id: 'k6', ts: now - 40_000, type: 'tool_result', turnId: 'turn-k1', agentId: 'agent-marlow', toolCallId: 'subagent_count', outcome: 'success', output: 'There are 4 files.' },
    { id: 'k7', ts: now - 40_000, type: 'user_message', source: 'background_wake', mentions: [],
      text: 'Background work you started has ended. Sam has not sent anything new.',
      wakeItems: [
        { toolCallId: 'subagent_count', taskId: 'child-count', title: 'Count the files', state: 'done', driver: 'codex', model: 'gpt-6.1-sol' },
        // Background shell commands with no launch row: one named by its description, one by a raw loop.
        { toolCallId: 'bash-retry', title: 'Retry the phone launch until the port is free', state: 'done' },
        { toolCallId: 'bash-loop', title: 'for i in $(seq 1 360); do out=$(node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs launch 2>&1); if echo "$out" | grep -q "is held"; then sleep 5; fi; done', state: 'done' },
      ] },
    { id: 'k8', ts: now - 38_000, type: 'agent_message', turnId: 'turn-k2', agentId: 'agent-marlow', messageId: 'k-m2', text: 'Count the files finished: 4 files. The logs are still being read.' },
    { id: 'k9', ts: now - 38_000, type: 'turn_result', turnId: 'turn-k2', agentId: 'agent-marlow' },
  ],
  'chat-live-session': [
    { id: 'l1', ts: now - 120_000, type: 'user_message', text: 'Audit the repo and run the tests in the background.', mentions: [] },
    { id: 'l2', ts: now - 119_000, type: 'tool_use', turnId: 'turn-l1', agentId: 'agent-marlow', toolCallId: 'native-audit', tool: 'Agent',
      subject: 'Audit the repo', agentType: 'general-purpose', background: true, subagent: { title: 'Audit the repo', prompt: 'Audit the repo.' } },
    { id: 'l3', ts: now - 118_000, type: 'tool_use', turnId: 'turn-l1', agentId: 'agent-marlow', toolCallId: 'native-tests', tool: 'Bash',
      command: 'pnpm test', detail: 'pnpm test', background: true },
    { id: 'l4', ts: now - 117_000, type: 'agent_message', turnId: 'turn-l1', agentId: 'agent-marlow', messageId: 'l-m1', text: 'The audit and the tests run in the background.' },
    { id: 'l5', ts: now - 117_000, type: 'turn_result', turnId: 'turn-l1', agentId: 'agent-marlow' },
    { id: 'l6', ts: now - 50_000, type: 'tool_result', turnId: 'turn-l1', agentId: 'agent-marlow', toolCallId: 'native-audit', outcome: 'success', output: 'Nothing surprising.' },
    { id: 'l7', ts: now - 50_000, type: 'user_message', source: 'background_wake', mentions: [],
      text: 'Background work you started has ended. Sam has not sent anything new.\n- \u201cAudit the repo\u201d finished.',
      wakeItems: [{ toolCallId: 'native-audit', title: 'Audit the repo', state: 'done', driver: 'claude', model: 'claude-opus-4-6' }] },
    { id: 'l8', ts: now - 48_000, type: 'agent_message', turnId: 'turn-l2', agentId: 'agent-marlow', messageId: 'l-m2', text: 'The audit is back: nothing surprising. The tests still run.' },
    { id: 'l9', ts: now - 48_000, type: 'turn_result', turnId: 'turn-l2', agentId: 'agent-marlow' },
  ],
  // Codex announces a row as background at its turn's answer. The dev server still runs;
  // the lint run ended before that announcement reached the store and stays ended.
  'chat-codex-live': [
    { id: 'x1', ts: now - 90_000, type: 'user_message', text: 'Start the dev server and lint in the background.', mentions: [] },
    { id: 'x2', ts: now - 89_000, type: 'tool_use', turnId: 'turn-x1', agentId: 'agent-marlow', toolCallId: 'shell-dev', tool: 'Bash',
      command: 'pnpm dev', detail: 'pnpm dev' },
    { id: 'x3', ts: now - 89_000, type: 'tool_use', turnId: 'turn-x1', agentId: 'agent-marlow', toolCallId: 'shell-lint', tool: 'Bash',
      command: 'pnpm lint', detail: 'pnpm lint' },
    { id: 'x4', ts: now - 88_000, type: 'agent_message', turnId: 'turn-x1', agentId: 'agent-marlow', messageId: 'x-m1', text: 'The dev server and lint run in the background.' },
    { id: 'x5', ts: now - 88_000, type: 'tool_result', turnId: 'turn-x1', agentId: 'agent-marlow', toolCallId: 'shell-lint', outcome: 'success' },
    { id: 'x6', ts: now - 88_000, type: 'tool_use', turnId: 'turn-x1', agentId: 'agent-marlow', toolCallId: 'shell-dev', tool: 'Bash',
      command: 'pnpm dev', detail: 'pnpm dev', background: true },
    { id: 'x7', ts: now - 88_000, type: 'tool_use', turnId: 'turn-x1', agentId: 'agent-marlow', toolCallId: 'shell-lint', tool: 'Bash',
      command: 'pnpm lint', detail: 'pnpm lint', background: true },
    { id: 'x8', ts: now - 88_000, type: 'turn_result', turnId: 'turn-x1', agentId: 'agent-marlow' },
  ],
  'chat-dm-sage': [
    { id: 'g1', ts: now - 5 * 60_000, type: 'user_message', text: 'Lees de release note even na.', mentions: [] },
    { id: 'g2', ts: now - 5 * 60_000 + 1, type: 'tool_use', turnId: 'turn-g1', agentId: 'agent-sage', toolCallId: 'g-read', tool: 'Read',
      subject: 'release-notes.md', detail: 'release-notes.md' },
    { id: 'g3', ts: now - 5 * 60_000 + 2, type: 'tool_result', turnId: 'turn-g1', agentId: 'agent-sage', toolCallId: 'g-read', outcome: 'success' },
    { id: 'g4', ts: now - 5 * 60_000 + 3, type: 'agent_message', turnId: 'turn-g1', agentId: 'agent-sage', messageId: 'g-m1', text: 'Gelezen. De changelog mist nog een regel over de datumlabels.' },
    { id: 'g5', ts: now - 5 * 60_000 + 4_000, type: 'turn_result', turnId: 'turn-g1', agentId: 'agent-sage' },
    // Sent messages written in markdown, in a DM with no proposal dock in front of
    // them: a heading, bold, a list, a mention, a destination pill and two
    // typed lines in the tinted bubble, then a code fence and a table.
    { id: 'w-md', ts: now - 4 * 60_000, type: 'user_message', mentions: [],
      text: '## Plan\n\nMaak de bubbel **vet** en `code` leesbaar, vraag @Sage en open @browser.\n\n- eerste punt\n- tweede punt\n\nregel een\nregel twee' },
    { id: 'w-md-blocks', ts: now - 3 * 60_000, type: 'user_message', mentions: [],
      text: '```\npnpm verify\n```\n\n| Kolom | Waarde |\n| --- | --- |\n| inkt | bubbel |' },
    { id: 'g-quote', ts: now - 2 * 60_000, type: 'user_message', mentions: [], text: 'Maakt voor nu niet uit [Quote #1], open @browser en draai `pnpm test` op `apps/mobile/src/components/Markdown.tsx`.',
      quotes: [{ kind: 'message', eventId: 'g4', agentId: 'agent-sage', text: 'controle is onvolledig' }] },
    { id: 'g6', ts: now - 30_000, type: 'user_message', text: 'Voeg die regel dan toe.', mentions: [] },
    { id: 'g7', ts: now - 29_000, type: 'tool_use', turnId: 'turn-g2', agentId: 'agent-sage', toolCallId: 'g-edit', tool: 'Edit',
      subject: 'release-notes.md', detail: 'release-notes.md' },
  ],
  'chat-dm-wren': [
    { id: 'w1', ts: now - 600 * 60_000, type: 'user_message', text: 'Hoi Wren, dit is een oud DM-bericht.', mentions: [] },
    { id: 'w2', ts: now - 599 * 60_000, type: 'agent_message', agentId: 'agent-wren', turnId: 'turn-old', text: 'Oud antwoord van Wren.' },
    // Two consultations: one the turn announced and Sage answered, then one that ended
    // silent with its reply still out, which draws its marker alone.
    ...consultation('wa', 598, 'agent-sage', 'Klopt de release note met de changelog?', 'Ik vraag Sage of de release note klopt; haar antwoord volgt.'),
    { id: 'wa-received', ts: now - 597 * 60_000, type: 'agent_relay', agentId: 'agent-wren', peerAgentId: 'agent-sage', pairChatId: 'pair-wren-agent-sage',
      turnId: 'turn-wa', relayId: 'relay-wa', phase: 'received', preview: 'Ja, op de datumlabels na.' },
    { id: 'wa-return', ts: now - 597 * 60_000 + 1, type: 'agent_message', agentId: 'agent-wren', turnId: 'turn-wa-return', messageId: 'wa-m2', text: 'Sage zegt dat hij klopt, op de datumlabels na.' },
    { id: 'wa-return-result', ts: now - 597 * 60_000 + 2, type: 'turn_result', agentId: 'agent-wren', turnId: 'turn-wa-return' },
    ...consultation('wb', 596, 'agent-smith', 'Welke spacing krijgen de consultatieregels in het transcript?'),
  ],
  'pair-marlow-agent-sage': [
    { id: 'pm-ask', ts: now - 2 * 60_000 + 3, type: 'agent_message', agentId: 'agent-marlow', turnId: 'turn-mc', messageId: 'pm-m1', text: 'Vraag Sage of de datumlabels klaar zijn.' },
    { id: 'pm-answer', ts: now - 1.5 * 60_000 - 1, type: 'agent_message', agentId: 'agent-sage', turnId: 'turn-pm-sage', messageId: 'pm-m2', text: 'Ja, ze zijn klaar.' },
    { id: 'pm-result', ts: now - 1.5 * 60_000, type: 'turn_result', agentId: 'agent-sage', turnId: 'turn-pm-sage' },
  ],
}

// The Ready PDF Session changed three files and wrote enough to scroll, so its footer shows
// the changes pill and the jump in one row above the result card.
snapshots['chat-notes-pdf'] = (() => {
  const turnId = 'turn-pdf'
  const agentId = 'agent-wren'
  const ts = now - 10 * 60_000
  const edit = (id, file, before, after, index) => [
    { id: `${id}-u`, ts: ts + index * 2, type: 'tool_use', turnId, agentId, toolCallId: id, tool: 'Edit', detail: file,
      edits: [{ path: `/tmp/manor-mobile-verify/Notities/${file}`, panelPath: file, offset: { before: 10, after: 10 }, before, after }] },
    { id: `${id}-r`, ts: ts + index * 2 + 1, type: 'tool_result', turnId, agentId, toolCallId: id, outcome: 'success' },
  ]
  const paragraph = 'Every page now renders through the same layout pass as the screen, so headings, lists and tables keep their spacing in the file.'
  return [
    { id: 'pdf-u', ts: ts - 60_000, type: 'user_message', text: 'Ship the PDF export.', mentions: [] },
    ...edit('pdf-e1', 'src/export/pdf.ts', 'export function toPdf() {\n  return null\n}\n', 'export function toPdf(chat: Chat) {\n  return renderPages(chat)\n}\n', 0),
    ...edit('pdf-e2', 'src/export/pages.ts', 'const PAGE = 800\n', 'const PAGE = 842\nconst MARGIN = 48\n', 1),
    ...edit('pdf-e3', 'src/export/menu.ts', "items: ['Markdown']\n", "items: ['Markdown', 'PDF']\n", 2),
    { id: 'pdf-m', ts: ts + 10, type: 'agent_message', turnId, agentId, messageId: 'pdf-m1',
      text: Array.from({ length: 6 }, (_, index) => `${index + 1}. ${paragraph}`).join('\n\n') },
    { id: 'pdf-end', ts: ts + 11, type: 'turn_result', turnId, agentId },
  ]
})()

// A quiet project thread (2026-10-12): the notes Manor writes between messages (a relayed
// Session question, its answer, the wake labels, a report, a settled note) stay in the
// transcript but never on screen. What shows is the user, the thread's replies and the cards:
// an Accept card and two Confirmed rows that follow each other, then their next message.
// A linked folder, so the Stilte proposal shows its Worktree checkbox beside Reject.
projects.push({ id: 'project-stilte', name: 'Stilte', icon: 'book', color: '#7A9CC6', repoPaths: ['/tmp/manor-mobile-verify/Stilte'], threadChatId: 'chat-thread-stilte' })
directory.chats.push(chat({ id: 'chat-secret-token', projectId: 'project-manor', title: 'Token nodig', preview: 'Deploy de site.', minutesAgo: 2 }))
directory.chats.push({ ...chat({ id: 'chat-thread-stilte', projectId: 'project-stilte', title: 'Stilte', preview: 'Staat klaar.', minutesAgo: 1 }), mode: 'single' })
const stilteSession = (id, title, minutesAgo, extra = {}) => notesSession(id, title, minutesAgo, {
  sourceChatId: 'chat-thread-stilte', projectId: 'project-stilte', projectName: 'Stilte', ...extra,
})
const confirmed = (id, title, minutesAgo, result) => stilteSession(id, title, minutesAgo, {
  state: 'settled', result, resultAt: now - 4 * 60_000, goalReachedAt: now - 5 * 60_000, goalConfirmedAt: now - 4 * 60_000,
  goalReport: { result },
  goalCompletion: { status: 'complete', operation: 'commit', completedAt: now - 4 * 60_000, repos: [{ path: '/tmp/manor-mobile-verify/Stilte', files: ['export.ts'], before: 'a1', branch: 'main', tree: 't1' }] },
})
const stilteSessions = [
  confirmed('stilte-export', 'Exportknop toevoegen', 30, 'De exportknop werkt.'),
  confirmed('stilte-colour', 'Kleurkiezer bouwen', 25, 'De kleurkiezer werkt.'),
  // One pasted picture goes along, which the card counts on its runtime line.
  stilteSession('stilte-tidy', 'Instellingen opruimen', 8, { workChatId: null, acceptedAt: null, attachments: [{ name: 'pasted-image.jpg', kind: 'image', chatId: 'chat-thread-stilte', eventId: 'sx-u1', index: 0 }] }),
]
directory.workHandoffs.push(...stilteSessions)
for (const session of stilteSessions.slice(0, 2)) {
  directory.chats.push(chat({ id: session.workChatId, projectId: 'project-stilte', title: session.title, preview: session.task, minutesAgo: 4, settledMinutesAgo: 4 }))
}
const quiet = (id, minutesAgo, text) => ({ id, ts: now - minutesAgo * 60_000, type: 'user_message', source: 'project_thread', threadReason: 'question', text, mentions: [] })
const spoken = (id, minutesAgo, text) => [
  { id: `${id}-a`, ts: now - minutesAgo * 60_000, type: 'agent_message', turnId: `turn-${id}`, agentId: '__single__', messageId: `${id}-m`, text },
  { id: `${id}-r`, ts: now - minutesAgo * 60_000 + 1, type: 'turn_result', turnId: `turn-${id}`, agentId: '__single__', reportedModel: 'gpt-6.1-sol' },
]
snapshots['chat-thread-stilte'] = [
  { id: 'sx-u1', ts: now - 14 * 60_000, type: 'user_message', text: 'Hoeken zijn altijd rond. Onthoud dat.', mentions: [] },
  ...spoken('sx1', 14, 'Vastgelegd in de voorkeuren.'),
  note('sx-q1', 12, 'Exportknop toevoegen asks Stilte: Ronde of vierkante hoeken?', {
    sessionQuestion: { sessionChatId: 'chat-stilte-export', requestId: 'request-stilte-1', agentId: 'agent-wren', title: 'Exportknop toevoegen', questions: [{ id: 'corners', question: 'Ronde of vierkante hoeken?', options: [{ label: 'Rond' }, { label: 'Vierkant' }] }] },
  }),
  // Its advice stands under the question's line in the bundle, not as a reply of its own.
  { ...quiet('sx-w1', 12, '[Manor] The session is waiting on a question.'), threadDelivered: ['sx-q1'] },
  ...spoken('sx2', 12 - 1 / 60, 'Ik zou kiezen voor “Rond”: dat past bij de voorkeur voor ronde hoeken.'),
  note('sx-a1', 11, 'Answered: Rond', {
    sessionAnswer: { sessionChatId: 'chat-stilte-export', requestId: 'request-stilte-1', answers: { corners: 'Rond' }, by: 'user' },
  }),
  { ...quiet('sx-w2', 10, '[Manor] A report came in.'), threadReason: 'report' },
  ...spoken('sx3', 10 - 1 / 60, 'De rapportage staat in de notities.'),
  note('sx-s1', 9, 'Session “Kleurkiezer bouwen” settled: De kleurkiezer werkt.', { workHandoffId: 'stilte-colour', workHandoffVersion: 1, workHandoffPhase: 'settled' }),
  { id: 'sx-u2', ts: now - 8 * 60_000, type: 'user_message', text: 'Stel een opruiming van de instellingen voor.', mentions: [] },
  ...spoken('sx4', 8 - 1 / 60, 'Voorgesteld, wacht op je Accept.'),
  // The two results land after the proposal, so the three cards stand together.
  note('sx-p3', 7, 'Session proposed.', { workHandoffId: 'stilte-tidy', workHandoffVersion: 1, workHandoffPhase: 'created' }),
  note('sx-c1', 5, 'De exportknop werkt.', { workHandoffId: 'stilte-export', workHandoffVersion: 2 }),
  note('sx-c2', 4.5, 'De kleurkiezer werkt.', { workHandoffId: 'stilte-colour', workHandoffVersion: 2 }),
  // A note in the same bundle, long enough that opening it wraps to a second line.
  note('sx-n1', 4, 'Stilte saved 1 line to notes.md: Export ships as Markdown first, PDF follows once the fonts embed.', {
    projectFileWrite: { action: 'add', file: 'notes.md', line: 'Export ships as Markdown first, PDF follows once the fonts embed.', by: 'Project thread' },
  }),
  { id: 'sx-u3', ts: now - 3 * 60_000, type: 'user_message', text: 'Top, bedankt. Wat staat er nog open?', mentions: [] },
  ...spoken('sx5', 3 - 1 / 60, 'Alleen de opruiming van de instellingen wacht nog op je Accept.'),
  { id: 'sx-u4', ts: now - 1 * 60_000, type: 'user_message', text: 'Prima, ik kijk er straks naar.', mentions: [] },
]

// A thread with one quiet Session and no card waiting, so the dot on its Sessions button
// starts empty. `kill -USR1` below drives the Session through working and finished.
projects.push({ id: 'project-punt', name: 'Punt', icon: 'book', color: '#E0A458', repoPaths: [], threadChatId: 'chat-thread-punt' })
directory.chats.push({ ...chat({ id: 'chat-thread-punt', projectId: 'project-punt', title: 'Punt', preview: 'Ik kijk mee.', minutesAgo: 2 }), mode: 'single' })
directory.chats.push(chat({ id: 'chat-punt-session', projectId: 'project-punt', title: 'Stipproef', preview: 'Staat klaar.', minutesAgo: 3 }))
directory.workHandoffs.push(notesSession('punt-proef', 'Stipproef', 3, {
  sourceChatId: 'chat-thread-punt', projectId: 'project-punt', projectName: 'Punt', workChatId: 'chat-punt-session',
}))
snapshots['chat-thread-punt'] = [
  { id: 'pt-u1', ts: now - 4 * 60_000, type: 'user_message', text: 'Houd de stipproef in de gaten.', mentions: [] },
  ...spoken('pt1', 4 - 1 / 60, 'Ik kijk mee.'),
]

// A group chat, so a send and its reply can be proven in every room kind.
directory.chats.push(chat({ id: 'chat-group-huis', projectId: null, kind: 'group', title: 'Huishouden', preview: 'Sage: Dat regel ik.', minutesAgo: 6, memberIds: ['agent-marlow', 'agent-sage'] }))
snapshots['chat-group-huis'] = [
  { id: 'gh1', ts: now - 7 * 60_000, type: 'user_message', text: 'Wie pakt de release note op?', mentions: [] },
  ...chatter('gh', 'agent-sage', 6, 4),
]

/**
 * The rooms that answer a message, as a real turn does: the message lands as a durable
 * event, a turn starts, reads a file, streams for a moment and settles on a long reply.
 * Everything else only acks. The send lands and the turn starts as fast as the real
 * server answers, while the list is still settling the send; the reply then waits long
 * enough for a Maestro tap (about 15s) to return and a screenshot to catch the working
 * indicator before it.
 */
const REPLIES = {
  'chat-dm-marlow': 'agent-marlow',
  'chat-group-huis': 'agent-sage',
  'chat-thread-stilte': '__single__',
  'chat-single-notes': '__single__',
}
const REPLY_TEXT = [
  'Nagelopen. De datumlabels kloppen nu ook rond middernacht.',
  'Wat ik heb gecontroleerd:\n\n- De labels in het transcript\n- De leeftijden in de zijbalk\n- De rijen in het Session-overzicht',
  'De changelog mist nog één regel over de tijdzones. Die zet ik erbij zodra je akkoord geeft, dan is de release note compleet.',
].join('\n\n')
let replies = 0

/** A composer command leaves a line, never a bubble. The server's real paths are proved on the desktop spike. */
function runCommand(chatId, command) {
  const fields = {
    compact: { text: 'Compacted the live session.' },
    clear: { text: CONTEXT_CLEARED_NOTE, contextBoundary: { keepEventIds: [] } },
    goal_show: { text: 'Goal: Ship the release' },
    goal_clear: { text: 'Goal removed.' },
    goal_set: { text: 'Goal set.' },
  }[command.name]
  const event = { id: `command-${++replies}`, ts: Date.now(), type: 'system_note', kind: 'info', ...fields }
  snapshots[chatId] = [...(snapshots[chatId] ?? []), event]
  broadcast({ type: 'event', chatId, event })
}

function reply(chatId, agentId, text, images = [], quotes = []) {
  const id = `reply-${++replies}`
  const turnId = `turn-${id}`
  const messageId = `${id}-m`
  const record = (event) => {
    snapshots[chatId] = [...(snapshots[chatId] ?? []), event]
    broadcast({ type: 'event', chatId, event })
  }
  const at = (ms, run) => setTimeout(run, ms)
  // The message lands queued and moves through the server's dispatch states, so the
  // phone sees the same rows a real send gives it between the send and the turn's start.
  let message
  const dispatch = (dispatchState) => {
    message = { ...message, dispatchState }
    snapshots[chatId] = (snapshots[chatId] ?? []).map((event) => event.id === message.id ? message : event)
    broadcast({ type: 'event', chatId, event: message })
  }
  at(40, () => {
    message = { id: `${id}-u`, ts: Date.now(), type: 'user_message', text, mentions: [], dispatchState: 'pending', ...(images.length > 0 ? { images } : {}), ...(quotes.length > 0 ? { quotes } : {}) }
    record(message)
  })
  at(100, () => dispatch('started'))
  at(120, () => broadcast({ type: 'turn_state', chatId, turnId, agentId, state: 'running', startedAt: Date.now() }))
  // A message that names a reaction gets the agent's 🎉 on it, as the `react` tool puts one there.
  if (/\breact\b/i.test(text)) at(1_200, () => {
    message = { ...message, reaction: { emoji: '🎉', at: Date.now(), agentId } }
    snapshots[chatId] = (snapshots[chatId] ?? []).map((event) => event.id === message.id ? message : event)
    broadcast({ type: 'event', chatId, event: message })
  })
  at(400, () => record({ id: `${id}-tool`, ts: Date.now(), type: 'tool_use', turnId, agentId, toolCallId: `${id}-read`, tool: 'Read', subject: 'CHANGELOG.md', detail: 'CHANGELOG.md' }))
  at(900, () => record({ id: `${id}-tool-r`, ts: Date.now(), type: 'tool_result', turnId, agentId, toolCallId: `${id}-read`, outcome: 'success' }))
  // The thread and the Single Session both edit a file, so a changed-files pill would show
  // in either: the Session keeps it, the project thread never states one.
  if (chatId === 'chat-thread-stilte' || chatId === 'chat-single-notes') {
    at(1_000, () => record({ id: `${id}-edit`, ts: Date.now(), type: 'tool_use', turnId, agentId, toolCallId: `${id}-edit`, tool: 'Edit', subject: 'CHANGELOG.md', detail: 'CHANGELOG.md',
      edits: [{ path: '/tmp/manor-mobile-verify/Stilte/CHANGELOG.md', before: '# Changelog\n', after: '# Changelog\n\n- Tijdzones toegevoegd\n- Datumlabels rond middernacht\n' }] }))
    at(1_300, () => record({ id: `${id}-edit-r`, ts: Date.now(), type: 'tool_result', turnId, agentId, toolCallId: `${id}-edit`, outcome: 'success' }))
  }
  // The Single Session's ring follows the turn: it climbs, compacts and drops.
  const live = chatId === 'chat-single-notes'
  if (live) {
    const context = (ms, state) => at(ms, () => broadcast({ type: 'turn_context', chatId, turnId, agentId, context: { contextWindow: 400_000, ...state } }))
    context(1_500, { contextTokens: 150_000, compacting: false })
    context(3_500, { contextTokens: 230_000, compacting: false })
    context(5_500, { contextTokens: 230_000, compacting: true })
    context(9_500, { contextTokens: 40_000, compacting: false, compacted: true })
    context(11_000, { contextTokens: 52_000, compacting: false, compacted: true })
  }
  // Deltas append, so the reply streams in six chunks.
  const words = REPLY_TEXT.split(' ')
  const cut = (step) => Math.ceil((words.length * step) / 6)
  for (let step = 1; step <= 6; step += 1) {
    const chunk = `${step === 1 ? '' : ' '}${words.slice(cut(step - 1), cut(step)).join(' ')}`
    at(12_000 + step * 300, () => broadcast({ type: 'delta', chatId, turnId, agentId, messageId, text: chunk }))
  }
  at(14_500, () => {
    record({ id: `${id}-a`, ts: Date.now(), type: 'agent_message', turnId, agentId, messageId, text: REPLY_TEXT })
    record({ id: `${id}-r`, ts: Date.now(), type: 'turn_result', turnId, agentId, ...(live ? { contextTokens: 52_000, contextWindow: 400_000 } : {}) })
    broadcast({ type: 'turn_state', chatId, turnId, agentId, state: 'done' })
    dispatch('completed')
  })
  // "mock rule: <line>" in Marlow's DM saves the line to the persona's notes, with the Undo a real `update_notes` carries.
  const rule = /^mock rule:\s*(.+)/i.exec(text)?.[1]?.trim()
  if (rule !== undefined && chatId === 'chat-dm-marlow') {
    at(14_600, () => record({ id: `${id}-memory`, ts: Date.now(), type: 'system_note', kind: 'info', text: rule,
      projectFileWrite: { file: `${agentId}.md`, action: 'add', line: rule, by: 'Marlow', turnId, agentId, writeId: `${id}-write` } }))
  }
  // A reply in the Stilte thread proposes a Session, the way a real thread does, so a card
  // arrives while the user sits at the bottom. `kill -HUP` moves it on (see below).
  if (chatId === 'chat-thread-stilte') at(15_000, () => proposeLive(id, record))
}

/**
 * The accepted `Fix the date labels` Session starts its turn when the phone first opens it,
 * and says nothing for 12s, about as long as a Maestro tap takes to return, so the short
 * start is still on screen. Then it writes a line and a read every 3s for 72s and outgrows
 * the screen after about four of them.
 */
const workOnOpen = new Map()
function workUntilOverflow(chatId, agentId) {
  const turnId = `turn-${chatId}`
  const record = (event) => {
    snapshots[chatId] = [...(snapshots[chatId] ?? []), event]
    broadcast({ type: 'event', chatId, event })
  }
  const steps = 24
  // Listed while it runs, so a phone that opens the chat again still sees it working.
  setTimeout(() => {
    const startedAt = Date.now()
    activeTurns[chatId] = { activeTurn: { turnId, agentId, startedAt } }
    broadcast({ type: 'turn_state', chatId, turnId, agentId, state: 'running', startedAt })
  }, 300)
  for (let step = 1; step <= steps; step += 1) {
    setTimeout(() => {
      const id = `${turnId}-${step}`
      record({ id: `${id}-m`, ts: Date.now(), type: 'agent_message', turnId, agentId, messageId: `${id}-m`, text: `Step ${step}. Checking the labels in dateLabels${step}.ts around midnight.` })
      record({ id: `${id}-t`, ts: Date.now(), type: 'tool_use', turnId, agentId, toolCallId: `${id}-c`, tool: 'Read', subject: `dateLabels${step}.ts`, detail: `dateLabels${step}.ts` })
      setTimeout(() => record({ id: `${id}-r`, ts: Date.now(), type: 'tool_result', turnId, agentId, toolCallId: `${id}-c`, outcome: 'success' }), 400)
    }, 12_000 + step * 3_000)
  }
  setTimeout(() => {
    record({ id: `${turnId}-reply`, ts: Date.now(), type: 'agent_message', turnId, agentId, messageId: `${turnId}-reply`, text: 'The labels hold across midnight in every file.' })
    record({ id: `${turnId}-done`, ts: Date.now(), type: 'turn_result', turnId, agentId })
    delete activeTurns[chatId]
    broadcast({ type: 'turn_state', chatId, turnId, agentId, state: 'done' })
  }, 12_000 + (steps + 1) * 3_000)
}

// Sessions the Stilte thread proposed during this run, newest last.
const liveProposals = []
function proposeLive(id, record) {
  const session = stilteSession(`stilte-live-${id}`, 'Datumlabels nalopen', 0, { workChatId: null, acceptedAt: null, createdAt: Date.now() })
  liveProposals.push(session)
  directory.workHandoffs.push(session)
  broadcast(directory)
  record(note(`${id}-proposed`, 0, 'Session proposed.', { ts: Date.now(), workHandoffId: session.id, workHandoffVersion: 1, workHandoffPhase: 'created' }))
}
// The newest accepted live Session reports a result, so its card turns into a Ready card.
process.on('SIGHUP', () => {
  const session = liveProposals.findLast((record) => record.acceptedAt !== null && record.goalReachedAt === undefined)
  if (session === undefined) return
  session.goalReachedAt = Date.now()
  session.goalReport = { result: 'De datumlabels kloppen rond middernacht.' }
  session.goalCompletion = { status: 'ready', operation: 'commit', repos: [] }
  broadcast(directory)
  const event = note(`${session.id}-ready`, 0, 'De datumlabels kloppen rond middernacht.', { ts: Date.now(), workHandoffId: session.id, workHandoffVersion: 2 })
  snapshots['chat-thread-stilte'] = [...snapshots['chat-thread-stilte'], event]
  broadcast({ type: 'event', chatId: 'chat-thread-stilte', event })
})


// Turns in flight when a chat opens, the way a reconnecting phone receives them.
const activeTurns = {
  'chat-tasks-card': {
    activeTurn: { turnId: 'turn-tc3', agentId: 'agent-marlow', startedAt: now - 60_000 },
  },
  'chat-dm-sage': {
    activeTurn: { turnId: 'turn-g2', agentId: 'agent-sage', startedAt: now - 30_000 },
  },
  'chat-thread-notes': {
    activeTurn: { turnId: 'turn-tr', agentId: '__single__', startedAt: now - 19_000 },
  },
  'chat-secret-token': {
    activeTurn: { turnId: 'turn-secret-1', agentId: '__single__', startedAt: now - 2 * 60_000 },
  },
  'chat-thread-session': {
    activeTurn: { turnId: 'turn-thread-1', agentId: 'agent-wren', startedAt: now - 290_000 },
  },
  'chat-background-wait': {
    activeTurn: { turnId: 'turn-bg', agentId: 'agent-marlow', startedAt: now - 60_000, background: { agents: 2, commands: 1 } },
  },
  // Mid-turn on tool calls, so no delta or turn_state reaches a phone that connects now:
  // only the directory's runningTurns says it works.
  'chat-notes-tests': {
    activeTurn: { turnId: 'turn-notes-tests', agentId: 'agent-wren', startedAt: now - 3 * 60_000 },
  },
  'chat-notes-package': {
    activeTurn: { turnId: 'turn-notes-package', agentId: 'agent-wren', startedAt: now - 2 * 60_000 },
  },
}
// Every turn in flight, as the Mac lists them for a client that connects or reconnects.
const runningTurns = () => Object.fromEntries(Object.entries(activeTurns).map(([chatId, { activeTurn }]) => [chatId, [activeTurn.turnId]]))
Object.defineProperty(directory, 'runningTurns', { enumerable: true, get: runningTurns })

// The same limits the desktop spike's mock driver reports (`mockProviderUsage`), plus a
// third reporting provider for the header's "+N" and an unavailable one, so a phone and a
// desktop screenshot compare bar for bar.
const usageWindow = (label, minutes, usedPercent, resetsIn) => ({
  label, minutes, usedPercent, resetsAt: now + resetsIn, startsAt: now + resetsIn - minutes * 60_000,
})
const providerUsage = {
  type: 'provider_usage',
  perProvider: [
    { provider: 'claude', status: 'ok', plan: 'max', fetchedAt: now, windows: [
      usageWindow('5-hour limit', 300, 62, 2 * 3_600_000 + 13 * 60_000),
      usageWindow('Weekly', 10_080, 31, 3 * 86_400_000 + 4 * 3_600_000),
    ] },
    { provider: 'codex', status: 'ok', plan: 'plus', fetchedAt: now, windows: [
      usageWindow('5-hour limit', 300, 8, 4 * 3_600_000 + 20 * 60_000),
      usageWindow('Weekly', 10_080, 71, 2 * 86_400_000 + 6 * 3_600_000),
    ] },
    { provider: 'cursor', status: 'ok', plan: 'pro', fetchedAt: now, windows: [
      usageWindow('Weekly', 10_080, 9, 4 * 86_400_000 + 2 * 3_600_000),
    ] },
    { provider: 'grok', status: 'unavailable', fetchedAt: now, windows: [] },
  ],
}

// One of each row state the Plugins tabs draw: a working and an unavailable server, a
// skill with and without usage, and a suggestion in each Suggestions group.
const plugins = {
  servers: { type: 'mcp_servers', servers: [
    { id: 'mcp-linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', description: 'Issues and projects for the Manor roadmap', tools: ['search_issues', 'create_issue'] },
    { id: 'mcp-figma', name: 'Figma', command: 'figma-mcp', description: 'Read frames and design tokens', tools: ['get_frame'], unavailable: 'The server did not answer on startup.' },
  ] },
  skills: { type: 'skills', skills: [
    { id: 'humanizer', name: 'Humanizer', description: 'Strip AI-isms from a draft and add a real voice.', instructions: '# Humanizer', sources: ['claude'], usageCount: 12 },
    { id: 'retro', name: 'Retro', description: 'Run a retrospective on a coding session.', instructions: '# Retro', sources: ['claude', 'codex'] },
  ] },
  suggestions: { type: 'workflow_suggestions', available: true, suggestions: [
    { id: 's-offer', name: 'Offer review', description: 'Review a **client offer** against the agency template before it goes out.', occurrences: '4 across 3 projects: 06-04; 06-05; 07-02.', corrections: '', existingCoverage: '', status: 'ready', statusDetail: '' },
    { id: 's-standup', name: 'Standup digest', description: 'Turn the Slack standup thread into a short digest.', occurrences: '2: 07-10; 07-14.', corrections: '', existingCoverage: '', status: 'watching', statusDetail: '' },
    { id: 's-invoice', name: 'Invoice chase', description: 'Draft a polite reminder for an open invoice.', occurrences: '3: 05-01; 05-20; 06-02.', corrections: '', existingCoverage: '', status: 'shipped', statusDetail: 'shipped 2026-08-12' },
  ] },
}

const roster = {
  type: 'roster',
  agents: [
    {
      id: 'agent-marlow',
      name: 'Marlow',
      color: '#8AA4B8',
      character: 'Fixture chief of staff for mobile verification.',
      driver: 'claude',
      model: 'claude-opus-4-6',
      effort: 'high',
      allowedTools: [],
      // One skill and one connector, so the overview's read-only lists have a row each.
      mcpServers: [{ serverId: 'mcp-linear', disabledTools: [] }],
      skillIds: ['humanizer'],
      memoryScope: false,
      description: 'Receives un-mentioned messages in the fixture.',
      role: 'Chief of staff',
      isCos: true,
      mentionAllowlist: ['agent-sage'],
      avatarShape: 'round',
      // One persona per face finish, Smith on the default clay; Marlow answers, so his fur also works.
      avatarFinish: 'fluffy',
      dmOnly: false,
    },
    {
      id: 'agent-sage',
      name: 'Sage',
      color: '#B7C9B1',
      character: 'Fixture specialist.',
      driver: 'claude',
      model: 'claude-sonnet-4-6',
      effort: 'high',
      allowedTools: [],
      mcpServers: [],
      memoryScope: false,
      description: 'Read-only fixture persona.',
      role: 'Specialist',
      isCos: false,
      mentionAllowlist: [],
      avatarShape: 'sun',
      avatarFinish: 'flat',
      dmOnly: false,
    },
    {
      id: 'agent-smith',
      name: 'Smith',
      color: '#C9A86A',
      character: 'Fixture reviewer.',
      driver: 'codex',
      model: 'gpt-5.4',
      effort: 'high',
      allowedTools: [],
      mcpServers: [],
      memoryScope: false,
      description: 'Read-only fixture reviewer.',
      role: 'Reviewer',
      isCos: false,
      mentionAllowlist: [],
      avatarShape: 'round',
      dmOnly: false,
      placement: 'chat',
    },
    {
      id: 'agent-wren',
      name: 'Wren',
      color: '#7AA2F7',
      character: 'Fixture Session engineer.',
      driver: 'claude',
      model: 'claude-opus-4-6',
      effort: 'high',
      allowedTools: [],
      mcpServers: [],
      memoryScope: false,
      description: 'Builds in Sessions.',
      role: 'Engineer',
      isCos: false,
      mentionAllowlist: [],
      avatarShape: 'boxy',
      dmOnly: false,
      placement: 'session',
    },
  ],
}

const routines = {
  type: 'routines',
  routines: [
    {
      id: 'routine-morning',
      projectId: 'project-manor',
      chatId: null,
      agentId: 'agent-marlow',
      name: 'Ochtendbriefing',
      description: 'Fixture routine. Do not run against a live Mac.',
      prompt: 'List open work for today.',
      cron: '0 7 * * *',
      timezone: 'Europe/Amsterdam',
      enabled: true,
      notify: false,
      model: null,
      effort: null,
      nextRunAt: now + 86_400_000,
      lastRunAt: null,
      lastSkippedAt: null,
      consecutiveFailures: 0,
      disabledReason: null,
      runningSince: null,
      lastContextTokens: null,
      createdAt: now - 86_400_000,
    },
  ],
}

const listings = new Map([
  [
    '/tmp/manor-mobile-verify',
    {
      type: 'dir_listing',
      path: '/tmp/manor-mobile-verify',
      parent: '/tmp',
      entries: [{ name: 'Manor', path: '/tmp/manor-mobile-verify/Manor' }],
    },
  ],
])

// ───────────────────────────────────────────────────────────────────────────────────────
// DATA VARIANTS (MANOR_MOBILE_VERIFY_DATA) — the only place the fixture's data is varied.
//   unset  the house above, untouched.
//   worst  the same house with worst-case strings (long, one-character, CJK, emoji, empty,
//          unbreakable compounds, newlines) plus extra rows for long lists and counts.
//   empty  no projects, chats, agents, routines, DM files, plugins or skills: empty states.
// Record ids never change, so transcripts, reactions and handles keep working. Everything
// is applied in place to the data built above, before the server starts, and what it sends
// still passes `ServerMessageSchema.parse` in `send()`.
// ───────────────────────────────────────────────────────────────────────────────────────
const DATA_VARIANT = process.env.MANOR_MOBILE_VERIFY_DATA ?? ''
if (!['', 'worst', 'empty'].includes(DATA_VARIANT)) {
  console.error(`MANOR_MOBILE_VERIFY_DATA must be unset, "worst" or "empty", not "${DATA_VARIANT}".`)
  process.exit(1)
}

/** Rewrites every string below `node` in place (keeps object identity; skips getters such as `runningTurns`). */
function mapStrings(node, rewrite) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      if (typeof item === 'string') node[index] = rewrite(item)
      else mapStrings(item, rewrite)
    })
  } else if (node !== null && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      if (Object.getOwnPropertyDescriptor(node, key).get !== undefined) continue
      if (typeof node[key] === 'string') node[key] = rewrite(node[key])
      else mapStrings(node[key], rewrite)
    }
  }
}

function applyEmptyData() {
  projects.length = 0
  directory.chats.length = 0
  directory.workHandoffs.length = 0
  directory.subagents = []
  directory.backgroundChatIds = []
  directory.backgroundWork = {}
  directory.awaitingInput = {}
  for (const chatId of Object.keys(snapshots)) delete snapshots[chatId]
  for (const chatId of Object.keys(activeTurns)) delete activeTurns[chatId]
  dmFiles.length = 0
  roster.agents.length = 0
  routines.routines.length = 0
  plugins.servers.servers.length = 0
  plugins.skills.skills.length = 0
  plugins.suggestions.suggestions.length = 0
}

function applyWorstData() {
  const A = {
    marlow: { name: 'Aleksandra Wiśniewska-Kowalczyk', role: 'Senior Product Design Engineer, Platform Infrastructure' },
    sage: { name: 'J', role: '' },
    smith: { name: '王秀英' },
    wren: { name: 'Arbeidsongeschiktheidsverzekeringsadviseur' },
  }
  const P = {
    manor: 'Klanttevredenheidsonderzoeksresultatenrapportage 2026',
    notes: 'X',
    stilte: 'Verbouwing benedenwoning, keuken en badkamer (fase 2 van 3, inclusief meerwerk)',
  }
  const T = {
    long: 'Exporteer het volledige gesprek als Markdown met alle bijlagen, screenshots en de toolactiviteit voor het klantarchief',
    one: 'A',
    url: 'https://example.com/workspaces/acme/projects/q3-launch/docs/9f8e7d6c5b4a?tab=comments&filter=unresolved',
    compound: 'Hypotheekrenteaftrekberekeningsspreadsheet',
    cjk: '季度报告审核',
    emoji: 'Release 🚀 notes',
  }
  const LONG_REASON = 'Needs deep reasoning across the migration history, the review findings and the three earlier attempts that failed'
  const LONG_TO = 'bartholomew.fitzgerald@regional-logistics-holdings.example.com'
  const LONG_CC = 'charlotte.vandenbroek-oosterhuis@regional-logistics-holdings.example.com, maximiliaan.de-wit-van-der-heijden@meridian-logistics-international.example.org, annelies.vermeulen-jansen@kantoor-inrichting-groothandel.example.net'
  const LONG_SUBJECT = 'Re: Re: Fwd: Offerte verbouwing keuken en badkamer benedenwoning — aangepaste planning, meerwerk en de definitieve materiaalkeuze'
  const LONG_PATH_ROOT = '/Users/aleksandra.wisniewska-kowalczyk/Ontwikkeling/klanttevredenheidsonderzoek'
  const LONG_QUOTE = [
    'Dank voor je bericht. Hierbij de samenvatting van de afspraken zoals we die donderdag hebben besproken: de keuken wordt in week 38 geplaatst, de badkamer volgt direct daarna, en het meerwerk aan de leidingen en de elektra wordt apart gefactureerd zodra de definitieve materiaalkeuze door beide partijen is goedgekeurd.',
    'Let op: de levertijd van het werkblad is nog niet bevestigd. Als die langer dan vier weken blijkt te zijn, schuift de oplevering van fase 2 op naar eind oktober, en moeten we met de aannemer opnieuw naar de planning van fase 3 kijken, inclusief de verbouwing van de bijkeuken en de nieuwe vloer in de gang.',
    'Verder heb ik drie open punten genoteerd: de afvoer van de oude keukenkastjes, de afspraak met de gemeente over de omgevingsvergunning voor de dakkapel, en de vraag of de klant de vloerverwarming ook in de badkamer wil laten aanleggen. Laat me weten welke van deze punten voor vrijdag duidelijk moeten zijn, dan zet ik ze bovenaan de lijst voor het overleg.',
  ].join('\n\n')

  const chatById = (id) => directory.chats.find((candidate) => candidate.id === id)
  const events = (chatId) => snapshots[chatId]
  const eventById = (chatId, id) => events(chatId).find((event) => event.id === id)
  /** Replaces a phrase wherever the house names it (titles, task text, notes, previews), so a renamed Session reads the same everywhere. */
  const rename = (from, to) => {
    const rewrite = (text) => text.split(from).join(to)
    mapStrings(directory.chats, rewrite)
    mapStrings(directory.workHandoffs, rewrite)
    mapStrings(snapshots, rewrite)
  }

  // Agent names: wherever a text names a persona (notes, previews, DM and pair titles, handoff lead names, routine owner).
  const agentNames = { Marlow: A.marlow.name, Sage: A.sage.name, Smith: A.smith.name, Wren: A.wren.name }
  const nameAgents = (text) => text.replace(/\b(Marlow|Sage|Smith|Wren)\b/g, (name) => agentNames[name])
  for (const data of [directory.chats, directory.workHandoffs, directory.subagents, snapshots, roster, routines, plugins]) mapStrings(data, nameAgents)
  const agent = (id) => roster.agents.find((candidate) => candidate.id === `agent-${id}`)
  for (const id of Object.keys(A)) Object.assign(agent(id), A[id])

  // Projects. The project thread's chat is titled like its project; `Punt` stays.
  const projectNames = { 'project-manor': P.manor, 'project-notes': P.notes, 'project-stilte': P.stilte }
  for (const project of projects) if (projectNames[project.id] !== undefined) project.name = projectNames[project.id]
  for (const handoffRecord of directory.workHandoffs) if (projectNames[handoffRecord.projectId] !== undefined) handoffRecord.projectName = projectNames[handoffRecord.projectId]
  chatById('chat-thread-manor').title = P.manor
  chatById('chat-thread-notes').title = P.notes
  chatById('chat-thread-stilte').title = P.stilte
  eventById('chat-thread-session', 'ts1').workProjectName = P.manor
  eventById('chat-thread-manor', 'th-write').text = `${P.manor} saved 1 line to notes.md: Export is in progress.`
  eventById('chat-thread-stilte', 'sx-n1').text = nameProject(eventById('chat-thread-stilte', 'sx-n1').text, 'Stilte', P.stilte)
  eventById('chat-thread-stilte', 'sx-q1').text = nameProject(eventById('chat-thread-stilte', 'sx-q1').text, 'Stilte', P.stilte)
  function nameProject(text, from, to) { return text.replace(`asks ${from}:`, `asks ${to}:`).replace(`${from} saved`, `${to} saved`) }

  // Chat titles, spread over the first rows of each list. Session titles follow into their handoffs and notes.
  chatById('chat-trace-images').title = T.long
  chatById('chat-inline-steer').title = T.one
  chatById('chat-tasks-card').title = T.url
  chatById('chat-mobile-inbox').title = T.compound
  chatById('chat-settled-pwa').title = T.cjk
  rename('Export a chat as Markdown', T.emoji)
  rename('Weekmenu', 'Weekmenu voor het hele gezin, inclusief boodschappenlijst, allergieën en de kookplanning voor het weekend')
  rename('Write the release notes', 'Q')

  // Previews: long and multi-sentence, one with a newline, one empty.
  chatById('chat-mobile-inbox').lastMessagePreview = 'De mobiele inbox toont nu alle ongelezen berichten van de afgelopen week, gegroepeerd per project. Daarna heb ik de lege toestand nagelopen, de laadindicator vervangen en de sorteervolgorde vergeleken met de desktopversie. Er staan nog twee open vragen over meldingen en over archiveren; die wil ik met je doornemen voordat ik verder ga.'
  chatById('chat-trace-images').lastMessagePreview = 'De schermen kloppen.\nDe vier afgeronde schermen zijn vergeleken met het werkscherm en komen overeen op marges, kleur en afkapping.'
  chatById('chat-live-session').lastMessagePreview = ''
  chatById('chat-dm-smith').lastMessagePreview = 'I went through the export flow end to end. The file name now follows the chat title, long titles are cut at 120 characters, and an empty chat still exports an empty file. One thing is left: the share sheet on older phones ignores the suggested name, so please check that on the oldest device you have before we merge.'
  chatById('chat-dm-marlow').lastMessagePreview = 'Ik heb het overleg met de klant voorbereid: de agenda staat klaar, de offerte is nagelopen en de drie openstaande vragen over de planning staan bovenaan. Zeg maar of ik ook de conceptmail moet klaarzetten.'
  chatById('chat-diff-files').lastMessagePreview = 'Zeven bestanden aangepast.\nDe voorbeeldweergave van bijlagen, de diff-sheet en de pad-normalisatie zijn bijgewerkt en de tests draaien groen.'

  // Proposals and handoffs: long titles and task text, supporting agents with the long names, a long runtime reason.
  const proposalText = {
    'handoff-labels': ['Datumlabels in transcript, zijbalk en sessie-overzicht corrigeren rond middernacht, bij zomertijd en in andere tijdzones',
      'De datumlabels in het transcript, de leeftijden in de zijbalk en de rijen in het Session-overzicht lopen rond middernacht en bij de overgang naar zomertijd een uur uit de pas. Zorg dat elke plek dezelfde regels volgt, voeg een test toe voor de randgevallen en controleer het resultaat op de telefoon en op de desktop.'],
    'handoff-notes': ['Release note opstellen met de changelog, de bekende beperkingen en de migratiestappen voor bestaande installaties',
      'Schrijf de release note voor versie 0.9: neem de changelog van de afgelopen twee weken over, noem de bekende beperkingen zonder ze te bagatelliseren en beschrijf stap voor stap hoe bestaande installaties migreren. Houd de toon neutraal en laat de samenvatting bovenaan binnen vijf regels passen.'],
    'handoff-notes-v1': ['Release note opstellen met de changelog en de bekende beperkingen',
      'Schrijf de release note voor versie 0.9 met de changelog van de afgelopen twee weken en de bekende beperkingen. Houd de samenvatting bovenaan binnen vijf regels.'],
  }
  const supporting = {
    'handoff-labels': [['agent-sage', A.sage.name], ['agent-wren', A.wren.name]],
    'handoff-notes': [['agent-smith', A.smith.name], ['agent-wren', A.wren.name]],
    'handoff-notes-v1': [['agent-smith', A.smith.name], ['agent-wren', A.wren.name]],
  }
  for (const record of proposals.concat(replaced)) {
    const [title, task] = proposalText[record.id]
    Object.assign(record, {
      title, task,
      supportingAgentIds: supporting[record.id].map(([id]) => id),
      supportingAgentNames: supporting[record.id].map(([, name]) => name),
      proposedRuntime: { runtime: { driver: 'claude', model: 'claude-opus-5-5', effort: 'high' }, reason: LONG_REASON },
    })
  }
  eventById('chat-dm-marlow', 'p-handoff-notes-v1-settled').text = `Session proposal “${proposalText['handoff-notes-v1'][0]}” was replaced by v2.`
  const tidyTitle = 'Instellingen opruimen: kopieerbare teksten, lege toestanden en de volgorde van de secties in het scherm Instellingen'
  const tidyTask = 'Loop alle schermen onder Instellingen langs. Maak de teksten kopieerbaar, geef elke lege toestand een korte uitleg met een duidelijke vervolgactie en zet de secties in dezelfde volgorde als op de desktop. Laat bestaande voorkeuren ongemoeid.'
  for (const record of directory.workHandoffs.filter((candidate) => candidate.id === 'notes-tidy' || candidate.id === 'stilte-tidy')) Object.assign(record, { title: tidyTitle, task: tidyTask })

  // DM files: same mime and bytes per row, other names.
  const fileNames = {
    'dm-file-1': 'IMG_20250914_183022_HDR_portrait_edited_edited.png',
    'dm-file-2': 'verzekeringsvoorwaardenoverzicht-arbeidsongeschiktheid-2026-definitief.md',
    'dm-file-5': 'Q3 Board Deck — FINAL (revised) v12 [approved by legal].pdf',
    'dm-file-7': 'a.csv',
  }
  for (const file of dmFiles) if (fileNames[file.id] !== undefined) file.name = fileNames[file.id]
  eventById('chat-dm-marlow', 'mc-reply').files[0].name = fileNames['dm-file-2']
  eventById('chat-dm-marlow', 'mc-image').images[0].name = fileNames['dm-file-1']

  // Quote chips: the reply row's quote gets long, and one user message carries a long inline quote.
  eventById('chat-dm-marlow', 'mc-reply').replyTo.text = LONG_QUOTE
  events('chat-dm-marlow').push({
    id: 'mq-u', ts: now - 20_000, type: 'user_message', mentions: [],
    text: 'Kun je dit voor de klant terugbrengen tot vijf regels?',
    quotes: [{ kind: 'message', eventId: 'p3', agentId: 'agent-marlow', text: LONG_QUOTE }],
  })

  // Changed files: long paths, plus three more files so the pill and sheet count past four.
  const root = `${LONG_PATH_ROOT}/apps/mobile/src/components/conversation/attachments`
  const longPaths = new Map([
    ['/tmp/manor-mobile-verify/Manor/apps/mobile/src/components/DiffSheet.tsx', [`${root}/AttachmentPreviewSheetWithAccessibilityLabels.tsx`, 'apps/mobile/src/components/conversation/attachments/AttachmentPreviewSheetWithAccessibilityLabels.tsx']],
    ['/Users/sam/.manor/scratch/example-briefs/research/slices/desktop-workspace-and-persistent-agents/common-instructions.txt', [`${LONG_PATH_ROOT}/.manor/scratch/klanttevredenheidsonderzoek-resultatenrapportage-2026/research/slices/desktop-workspace-and-persistent-agents/common-instructions-for-every-research-slice-reader.txt`]],
    ['/tmp/manor-mobile-verify/Manor/apps/mobile/src/components/OldDiffRows.tsx', [`${root}/DeprecatedLegacyDiffRowsWithoutVirtualization.tsx`, 'apps/mobile/src/components/conversation/attachments/DeprecatedLegacyDiffRowsWithoutVirtualization.tsx']],
    ['/tmp/manor-mobile-verify/Manor/packages/client-runtime/src/changedFiles.ts', [`${LONG_PATH_ROOT}/packages/client-runtime/src/changedFiles/normalizeAbsolutePathsAcrossWorkspaceRoots.ts`, 'packages/client-runtime/src/changedFiles/normalizeAbsolutePathsAcrossWorkspaceRoots.ts']],
  ])
  for (const event of events('chat-diff-files')) {
    if (event.type !== 'tool_use') continue
    const [path, panelPath] = longPaths.get(event.edits[0].path)
    for (const edit of event.edits) {
      edit.path = path
      if (panelPath !== undefined) edit.panelPath = panelPath
    }
    event.detail = path
  }
  const diffTs = eventById('chat-diff-files', 'df1').ts
  const extraFiles = [
    { id: 'df-x1', path: `${root}/__tests__/AttachmentPreviewSheetWithAccessibilityLabels.snapshot.test.tsx`, panelPath: 'apps/mobile/src/components/conversation/attachments/__tests__/AttachmentPreviewSheetWithAccessibilityLabels.snapshot.test.tsx' },
    { id: 'df-x2', path: '/tmp/manor-mobile-verify/Manor/a.ts', panelPath: 'a.ts' },
    { id: 'df-x3', path: '/tmp/manor-mobile-verify/Manor/package.json', panelPath: 'package.json' },
  ]
  const diffIndex = events('chat-diff-files').findIndex((event) => event.id === 'df1')
  events('chat-diff-files').splice(diffIndex, 0, ...extraFiles.flatMap((file, index) => {
    const edit = { path: file.path, panelPath: file.panelPath, offset: { before: 3, after: 3 }, before: 'export const ready = false\n', after: 'export const ready = true\n' }
    return [
      { id: `${file.id}-u`, ts: diffTs - 900 + index * 2, type: 'tool_use', turnId: 'turn-diff', agentId: '__single__', toolCallId: file.id, tool: 'Edit', detail: file.path, edits: [edit] },
      { id: `${file.id}-r`, ts: diffTs - 900 + index * 2 + 1, type: 'tool_result', turnId: 'turn-diff', agentId: '__single__', toolCallId: file.id, outcome: 'success' },
    ]
  }))
  eventById('chat-diff-files', 'df1').text = 'Zeven bestanden aangepast.'

  // Trace thumbnails: long picture file names in the read rows and on the user's own picture.
  const shotName = (text) => text
    .replace(/shot-(\d)\.png/g, (_, index) => `2026-11-16-klanttevredenheidsonderzoek-resultatenrapportage-dashboard-donkere-modus-grote-tekst-iphone-17-pro-max-${index}.png`)
    .replace('ti-u2-0.png', 'Schermafbeelding 2026-11-16 om 09.41.27 (2) klantportaal offerte definitief kopie.png')
    .replace('scherm.png', 'Schermafbeelding 2026-11-16 om 09.41.27 (2) klantportaal offerte definitief kopie.png')
  mapStrings(snapshots['chat-trace-images'], shotName)

  // Mail cards: the long recipient, a cc of three long addresses, the long subject, in the folds too.
  for (const event of events('chat-mail-drafts')) {
    if (event.type === 'outbound_draft' || event.type === 'outbound_draft_closed') {
      event.to = LONG_TO
      event.subject = LONG_SUBJECT
      if (event.cc !== undefined) event.cc = LONG_CC
    } else if (typeof event.text === 'string') event.text = event.text.split('info@example.com').join(LONG_TO)
  }

  // Plugins: a long MCP server and a long skill (used exactly once, so "1 use" shows), and a long routine name.
  plugins.servers.servers.unshift({
    id: 'mcp-klantportaal', name: 'Klantportaal-Integratie (productie, alleen-lezen)', url: 'https://mcp.example.com/klantportaal/productie',
    description: 'Leest klantdossiers, offertes, facturen en de volledige correspondentiegeschiedenis uit het klantportaal van de productieomgeving. Alleen-lezen: er wordt nooit iets aangemaakt, gewijzigd of verwijderd, en elke aanroep wordt gelogd voor de auditdienst.',
    tools: ['zoek_klantdossier_op_postcode_en_huisnummer', 'lees_offerte_met_alle_revisies', 'lijst_openstaande_facturen'],
  })
  plugins.skills.skills.unshift({
    id: 'gespreksverslag', name: 'Hypotheekadvies-gespreksverslag omzetten naar klantbrief (inclusief juridische controle en samenvatting)',
    description: 'Zet het verslag van een adviesgesprek om in een duidelijke klantbrief, controleert de verplichte vermeldingen en eindigt met een samenvatting van drie regels voor het dossier.',
    instructions: '# Gespreksverslag', sources: ['claude', 'codex'], usageCount: 1,
  })
  routines.routines[0].name = 'Ochtendbriefing met agenda, open mails en de reminders van vandaag'

  // Counts: thirty more plain Sessions in the project, so lists run long and "N more" rows appear.
  const extraTitles = [
    'Offerte benedenwoning nalopen', 'Inbox opruimen', 'Review van de migratie naar Expo 56', 'Q4 planning', 'Fix: lege staat bij zoeken',
    'Waarom crasht de upload op iOS 17?', 'Changelog 0.9', 'Onboarding teksten herschrijven', 'Notificaties groeperen per project', 'Dark mode contrast',
    'VPN-verbinding stabiliseren', 'Reminders synchroniseren', 'Feedback van de pilotgebruikers', 'Sprint retro voorbereiden', 'Factuur 2026-0418 controleren',
    'Spacing in de tabbalk', 'Agent geheugen opschonen', 'Bestandsbrowser sorteren op datum', 'Exportknop voor PDF', 'Privacyverklaring bijwerken',
    'Offerte voor de website van de bakker', 'Taalkeuze in instellingen', 'Slack-draft met bijlage', 'Mijn week in vogelvlucht', 'Dubbele meldingen uitzoeken',
    'Prototype voor de agenda-widget', 'Testplan voor release', 'Beheerders uitnodigen', 'Kleurenpalet checken', 'Laatste puntjes op de i',
  ]
  const extraReplies = ['Staat klaar.', 'Ik heb het nagelopen en het klopt.', 'Dit wacht nog op jouw akkoord.', 'Klaar. De tests draaien groen.', 'Ik kom hier morgen op terug.']
  extraTitles.forEach((title, index) => {
    const id = `chat-extra-${String(index + 1).padStart(2, '0')}`
    const minutesAgo = 12 + index * index * 11 + index * 90
    const preview = extraReplies[index % extraReplies.length]
    directory.chats.push(chat({ id, projectId: 'project-manor', title, preview, minutesAgo, settledMinutesAgo: index % 3 === 0 ? minutesAgo - 1 : null }))
    // Started by the Manor thread, so its Sessions overview overflows the screen.
    directory.workHandoffs.push({
      id: `handoff-${id}`, sourceChatId: 'chat-thread-manor', sourceTurnId: 'turn-thread-brief', workChatId: id,
      projectId: 'project-manor', projectName: 'Manor', title,
      authorAgentId: 'agent-wren', leadAgentId: 'agent-wren', leadAgentName: 'Wren',
      supportingAgentIds: [], supportingAgentNames: [], state: 'active', result: null, resultAt: null,
      version: 1, createdAt: now - minutesAgo * 60_000, acceptedAt: now - minutesAgo * 60_000,
    })
    const ts = now - minutesAgo * 60_000
    snapshots[id] = [
      { id: `${id}-u`, ts, type: 'user_message', text: title, mentions: [] },
      { id: `${id}-a`, ts: ts + 1_000, type: 'agent_message', turnId: `turn-${id}`, agentId: '__single__', messageId: `${id}-m`, text: preview },
      { id: `${id}-r`, ts: ts + 1_001, type: 'turn_result', turnId: `turn-${id}`, agentId: '__single__' },
    ]
  })
}

if (DATA_VARIANT === 'worst') applyWorstData()
if (DATA_VARIANT === 'empty') applyEmptyData()

function send(socket, message) {
  socket.send(JSON.stringify(ServerMessageSchema.parse(message)))
}

function broadcast(message) {
  for (const client of server.clients) {
    if (client.readyState === client.OPEN) send(client, message)
  }
}

// The Mac's vault and mymind, which decide whether Knowledge and Artifacts sit in the
// menu. `kill -USR2 $(lsof -tiTCP:43182 -sTCP:LISTEN)` flips both and pushes the change to every open app,
// so one run proves the rows leaving and coming back.
let hostsAvailable = true
function hostStatuses() {
  return [
    { type: 'vault_status', available: hostsAvailable, name: hostsAvailable ? 'Notes' : null, root: hostsAvailable ? '/tmp/manor-mobile-verify/Notes' : null },
    { type: 'mymind_status', available: hostsAvailable, env: [], problem: null, check: null },
  ]
}

/** The public sites the sources message in Smith's DM cites; `no-icon.invalid` never answers. */
const ICON_SITES = new Set(['https://www.cuimc.columbia.edu', 'https://www.healio.com', 'https://no-icon.invalid', 'https://pubmed.ncbi.nlm.nih.gov'])

/**
 * Pairing as the Mac answers it, for the Connect screen: one fixed code that works
 * until a device holds it, and is free again once that device forgets the Mac. The
 * link is printed by `launch` under MANOR_MOBILE_VERIFY_PAIR=on. The socket itself
 * takes any token, as the fixture has no door.
 */
const FIXTURE_PAIRING_CODE = 'F'.repeat(43)
const FIXTURE_DEVICE_ID = '00000000-0000-4000-8000-000000000001'
const FIXTURE_DEVICE_TOKEN = `${FIXTURE_DEVICE_ID}.${'f'.repeat(43)}`
let fixturePaired = false

function answerPairing(request, response) {
  const json = (status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  if (request.url === '/pair/device') {
    if (request.headers.authorization !== `Bearer ${FIXTURE_DEVICE_TOKEN}` || !fixturePaired) return json(401, { error: 'Not paired' })
    if (request.method === 'DELETE') fixturePaired = false
    return json(200, request.method === 'DELETE' ? { ok: true } : { deviceId: FIXTURE_DEVICE_ID, name: 'Simulator' })
  }
  let body = ''
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    let code
    try { code = JSON.parse(body).code } catch { return json(400, { error: 'Invalid pairing request' }) }
    if (code !== FIXTURE_PAIRING_CODE || fixturePaired) return json(410, { error: 'This pairing link has expired or was already used.' })
    fixturePaired = true
    json(200, { token: FIXTURE_DEVICE_TOKEN, deviceId: FIXTURE_DEVICE_ID })
  })
}

// The socket and the result's screenshots share one port, as on the Mac.
const http = createServer((request, response) => {
  if ((request.url === '/pair' && request.method === 'POST') || request.url === '/pair/device') {
    answerPairing(request, response)
    return
  }
  // Site icons as the Mac's proxy serves them: the site's own /favicon.ico, or 404. Only
  // the sites the sources message cites are fetched, so this is no proxy to anything else.
  const icon = new URL(request.url ?? '/', 'http://fixture')
  if (icon.pathname === '/media/favicon') {
    const site = icon.searchParams.get('site') ?? ''
    if (!ICON_SITES.has(site)) {
      response.writeHead(404).end()
      return
    }
    void fetch(`${site}/favicon.ico`, { signal: AbortSignal.timeout(5_000) })
      .then(async (upstream) => {
        if (!upstream.ok) throw new Error(String(upstream.status))
        const bytes = Buffer.from(await upstream.arrayBuffer())
        const type = upstream.headers.get('content-type') ?? ''
        response.writeHead(200, { 'content-type': type.startsWith('image/') ? type : 'image/x-icon', 'content-length': String(bytes.byteLength), 'x-content-type-options': 'nosniff' })
        response.end(bytes)
      })
      .catch(() => response.writeHead(404).end())
    return
  }
  const traced = tracePictures.get(icon.pathname)
  if (traced !== undefined) {
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(traced.byteLength) })
    response.end(traced)
    return
  }
  const repoIcon = REPO_ICONS.find((candidate) => candidate.src.split('?')[0] === icon.pathname)
  if (repoIcon !== undefined) {
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(repoIcon.bytes.byteLength) })
    response.end(repoIcon.bytes)
    return
  }
  const vaultPicture = vaultImageBytes.get(icon.pathname)
  if (vaultPicture !== undefined) {
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(vaultPicture.byteLength) })
    response.end(vaultPicture)
    return
  }
  const listed = dmFileBytes.get(icon.pathname)
  if (listed !== undefined) {
    response.writeHead(200, { 'content-type': listed.type, 'content-length': String(listed.bytes.byteLength) })
    response.end(listed.bytes)
    return
  }
  const shot = evidence.find((item) => item.src === request.url)
  if (shot === undefined) {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(shot.bytes.byteLength) })
  response.end(shot.bytes)
})
/** The fixture vault: what Knowledge lists and what a note search finds. */
const VAULT_NOTES = {
  'Projects/Manor.md': '# Manor\n\nThe phone gets a native tab bar: Agents, Sessions, Knowledge and Search.\n\n![[icon.png|240]]\n\nOpen question: does the inbox need its own tab?',
  'Daily/2026-11-16.md': '# 2026-11-16\n\n- Tab bar spike on the simulator\n- Inbox cleanup after lunch',
}
/** Pictures in the fixture vault, by vault path, as the Mac lists them with a signed link. */
const VAULT_IMAGES = { 'Attachments/icon.png': '/media/vault/fixture/Attachments/icon.png' }
const vaultImageBytes = new Map([['/media/vault/fixture/Attachments/icon.png', appImage('icon')]])
// The repo icon a project with a linked folder offers, as the Mac finds it: Manor's app icon
// fills its square (`?tile`, drawn rounded), Stilte's macOS app icon has no background but a
// transparent margin (`?inset=`, cropped so it fills its square too).
const REPO_ICONS = [
  { projectId: 'project-manor', path: 'assets/icon.png', opaque: true, src: '/media/project-icon/fixture/icon.png?tile', bytes: appImage('icon') },
  { projectId: 'project-stilte', path: 'assets/icon.png', inset: 0.097, src: '/media/project-icon/fixture/mac-icon.png?inset=0.097', bytes: readFileSync(new URL('../../../apps/desktop/assets/icon.png', import.meta.url)) },
]
const repoIconOffer = (project) => {
  const offer = project?.repoPaths[0] === undefined ? undefined : REPO_ICONS.find((candidate) => candidate.projectId === project.id)
  return offer === undefined ? null : { folder: project.repoPaths[0], path: offer.path, ...(offer.opaque ? { opaque: true } : {}), ...(offer.inset ? { inset: offer.inset } : {}), src: offer.src }
}
/** Per-chat runtime pins set from the phone during this run. */
const overrides = new Map()
const server = new WebSocketServer({ server: http, path: '/ws' })
http.listen(PORT, HOST)

server.on('connection', (socket) => {
  send(socket, directory)
  send(socket, roster)
  send(socket, routines)
  send(socket, plugins.servers)
  send(socket, plugins.skills)
  send(socket, { type: 'host_capabilities', externalBrowser: null })
  send(socket, providerUsage)
  for (const status of hostStatuses()) send(socket, status)

  socket.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(raw.toString())
    } catch {
      return
    }
    // Search: message text from the fixture's own threads, note bodies from the small vault below.
    if (message.type === 'search' && typeof message.query === 'string') {
      const needle = message.query.trim().toLowerCase()
      const messages = Object.entries(snapshots).flatMap(([chatId, events]) => events
        .filter((event) => (event.type === 'user_message' || event.type === 'agent_message') && typeof event.text === 'string' && event.text.toLowerCase().includes(needle))
        .map((event) => ({ chatId, eventId: event.id, ...(event.agentId === undefined ? {} : { agentId: event.agentId }), ts: event.ts, snippet: event.text.slice(0, 160), phrase: true })))
        .slice(0, 20)
      const notes = Object.entries(VAULT_NOTES)
        .filter(([path, body]) => `${path}\n${body}`.toLowerCase().includes(needle))
        .map(([path, body]) => ({ path, title: path.slice(path.lastIndexOf('/') + 1, -3), snippet: body.split('\n').find((line) => line.toLowerCase().includes(needle)), phrase: true, modifiedAt: Date.now() - 3_600_000 }))
      send(socket, { type: 'search_results', requestId: message.requestId, query: message.query, messages, notes })
      return
    }
    if (message.type === 'list_vault') {
      send(socket, { type: 'vault_files', files: Object.keys(VAULT_NOTES), truncated: false, images: VAULT_IMAGES, attachmentFolder: 'Attachments' })
      return
    }
    if (message.type === 'read_vault_file') {
      const content = VAULT_NOTES[message.path]
      send(socket, { type: 'vault_file', path: message.path, result: content === undefined ? { status: 'unavailable', message: 'Not in the fixture vault.' } : { status: 'ready', content } })
      return
    }
    if (message.type === 'list_workflow_suggestions') {
      send(socket, plugins.suggestions)
      return
    }
    if (message.type === 'get_dm_files') {
      send(socket, { type: 'dm_files', chatId: message.chatId, files: message.chatId === 'chat-dm-marlow' ? dmFiles : [], requestId: message.requestId })
      return
    }
    if (message.type === 'list_dirs') {
      const path = message.path ?? '/tmp/manor-mobile-verify'
      send(
        socket,
        listings.get(path) ?? {
          type: 'dir_listing',
          path,
          parent: path === '/' ? null : '/tmp/manor-mobile-verify',
          entries: [],
        },
      )
      return
    }
    // A project with a linked folder answers like a git checkout, so a proposal card shows its Worktree checkbox.
    if (message.type === 'checkout_status') {
      const project = projects.find((candidate) => candidate.id === message.projectId)
      send(socket, {
        type: 'checkout_status',
        projectId: message.projectId,
        mode: 'current',
        branch: 'main',
        dirty: false,
        gitRoots: project?.repoPaths ?? [],
        branches: [],
      })
      return
    }
    // A project with a linked folder offers its repo icon; one without offers none.
    if (message.type === 'find_repo_icon') {
      send(socket, { type: 'repo_icon', projectId: message.projectId, requestId: message.requestId, icon: repoIconOffer(projects.find((candidate) => candidate.id === message.projectId)) })
      return
    }
    // The phone's project settings save the form whole, as the server does: rewrite, broadcast, ack.
    // A field the message leaves out keeps its stored value, as on the server.
    if (message.type === 'update_project') {
      const project = projects.find((candidate) => candidate.id === message.projectId)
      if (project !== undefined) {
        Object.assign(project, {
          name: message.name,
          icon: message.icon ?? project.icon,
          color: message.color ?? project.color,
          repoPaths: message.repoPaths,
          memoryScope: message.memoryScope ?? project.memoryScope,
        })
        // Both absent keep the choice; letters win; null drops either for the glyph; a reference sets the repo icon.
        if (message.letters === true || message.repoIcon !== undefined) delete project.letters
        if (message.letters === true || message.repoIcon === null) {
          delete project.repoIcon
          delete project.repoIconSrc
          if (message.letters === true) project.letters = true
        } else if (message.repoIcon !== undefined) {
          const { src, ...offer } = repoIconOffer(project) ?? {}
          if (src !== undefined) Object.assign(project, { repoIcon: offer, repoIconSrc: src })
        }
        console.log(`update_project ${project.id} name=${project.name} icon=${project.icon} repoIcon=${project.repoIcon?.path ?? 'none'} letters=${project.letters === true} folders=${project.repoPaths.length} memoryScope=${project.memoryScope ?? 'project'} sentMemoryScope=${message.memoryScope ?? 'none'}`)
        send(socket, directory)
      }
      send(socket, project === undefined
        ? { type: 'notice', kind: 'error', text: 'That project no longer exists.', requestId: message.requestId }
        : { type: 'ack', requestId: message.requestId })
      return
    }
    // The agent overview renames an agent or changes her title: store, broadcast the roster, ack.
    if (message.type === 'save_agent' && message.agent.id !== undefined) {
      const agent = roster.agents.find((candidate) => candidate.id === message.agent.id)
      // The server refuses a name another agent already has; the fixture does too, so a refusal can be driven.
      const taken = roster.agents.some((candidate) => candidate.id !== message.agent.id && candidate.name.toLowerCase() === message.agent.name.trim().toLowerCase())
      if (taken) {
        send(socket, { type: 'notice', kind: 'error', text: `Another agent is already called ${message.agent.name}.`, requestId: message.requestId })
        return
      }
      if (agent !== undefined) {
        Object.assign(agent, message.agent)
        broadcast(roster)
      }
      send(socket, agent === undefined
        ? { type: 'notice', kind: 'error', text: 'That agent no longer exists.', requestId: message.requestId }
        : { type: 'ack', requestId: message.requestId })
      return
    }
    // A model pick replaces that persona's pin and comes back as the chat's whole set, as the server sends it.
    if (message.type === 'set_chat_override') {
      const perAgent = { ...(overrides.get(message.chatId) ?? {}), [message.agentId]: message.override }
      overrides.set(message.chatId, perAgent)
      for (const client of server.clients) {
        if (client.readyState === client.OPEN) send(client, { type: 'chat_overrides', chatId: message.chatId, perAgent })
      }
      if (message.requestId) send(socket, { type: 'ack', requestId: message.requestId })
      return
    }
    if (message.type === 'answer_secret_request' && message.requestId === 'request-secret-1') {
      const event = { id: `sc-${Date.now()}`, ts: Date.now(), type: 'user_input_response', turnId: 'turn-secret-1', agentId: '__single__', requestId: 'request-secret-1',
        answers: { secret: message.value === undefined ? 'Declined' : 'Used once' } }
      snapshots['chat-secret-token'].push(event)
      directory.awaitingInput['chat-secret-token'] = []
      broadcast({ type: 'event', chatId: 'chat-secret-token', event })
      broadcast({ type: 'turn_state', chatId: 'chat-secret-token', turnId: 'turn-secret-1', agentId: '__single__', state: 'done' })
      delete activeTurns['chat-secret-token']
    }
    if (message.type === 'open_chat' && snapshots[message.chatId] !== undefined) {
      send(socket, { type: 'snapshot', chatId: message.chatId, events: snapshots[message.chatId], usage: {}, overrides: overrides.get(message.chatId) ?? {}, ...activeTurns[message.chatId] })
      const agentId = workOnOpen.get(message.chatId)
      if (agentId !== undefined) {
        workOnOpen.delete(message.chatId)
        workUntilOverflow(message.chatId, agentId)
      }
      return
    }
    // A subagent's question, answered from its parent: it leaves the card there.
    if (message.type === 'answer_user_input' && message.requestId === 'request-child-logs' && message.chatId === 'child-logs') {
      directory.subagents = directory.subagents.map(({ ask, ...child }) => child)
      broadcast(directory)
      return
    }
    // Confirm on a Session the Stilte thread proposed during this run.
    const liveResult = message.type === 'confirm_work_goal' ? liveProposals.find((record) => record.id === message.handoffId) : undefined
    if (liveResult !== undefined) {
      liveResult.goalConfirmedAt = Date.now()
      liveResult.goalCompletion = { status: 'pending', operation: 'commit', repos: [] }
      broadcast(directory)
      if (message.requestId) send(socket, { type: 'ack', requestId: message.requestId })
      setTimeout(() => {
        liveResult.state = 'settled'
        liveResult.goalCompletion = { status: 'complete', operation: 'commit', repos: [], completedAt: Date.now() }
        broadcast(directory)
      }, 3_000)
      return
    }
    // Accept on the result card: a stale version is refused, the current one goes
    // pending and lands as committed three seconds later, as the server would observe.
    if (message.type === 'confirm_work_goal' && message.handoffId === handoff.id) {
      if (message.version !== handoff.version) {
        send(socket, { type: 'notice', kind: 'error', text: 'This result has changed. Read the current result before accepting it.', ...(message.requestId ? { requestId: message.requestId } : {}) })
        return
      }
      handoff.goalConfirmedAt = Date.now()
      handoff.goalCompletion = { status: 'pending', operation: 'commit', repos: [] }
      send(socket, directory)
      if (message.requestId) send(socket, { type: 'ack', requestId: message.requestId })
      setTimeout(() => {
        handoff.goalCompletion = { status: 'complete', operation: 'commit', repos: [], completedAt: Date.now() }
        if (socket.readyState === socket.OPEN) send(socket, directory)
      }, 3_000)
      return
    }
    const proposed = message.type === 'accept_work_handoff'
      ? [...proposals, ...notesSessions, ...stilteSessions, ...liveProposals].find((record) => record.id === message.handoffId && record.acceptedAt === null)
      : undefined
    if (proposed !== undefined) {
      const workChatId = `chat-${proposed.id}`
      // An Accept with the Worktree box ticked isolates the Session, on a branch named after it.
      const checkout = message.checkout?.mode === 'worktree' ? { mode: 'worktree', branch: `manor/${proposed.id.slice(-8)}` } : undefined
      directory.chats.push({ ...chat({ id: workChatId, projectId: proposed.projectId, title: proposed.title, preview: 'Session started.', minutesAgo: 0 }), mode: message.mode, ...(checkout === undefined ? {} : { checkout }) })
      // The Session opens on its kickoff, written in markdown the way a brief is and long
      // enough to fold. Single stores the server's model-facing preamble first, which the
      // card must hide.
      const preamble = message.mode === 'single' ? '[Manor] Session accepted as Single with claude-opus-5-5. Complete the task below in this session.\n\n' : ''
      snapshots[workChatId] = [{
        id: `${workChatId}-kickoff`, ts: Date.now(), type: 'user_message', source: 'work_handoff', mentions: [],
        workAuthorAgentId: proposed.authorAgentId, workTargetLeadId: proposed.leadAgentId,
        text: `${preamble}${proposed.title}\n\n## Outcome\n\nRender **markdown** and \`code\` in the kickoff.\n\n- first item\n- ask @Sage to check\n- keep ~/Library/Mobile Documents/com~apple~CloudDocs/Manor as plain text\n\n## Done when\n\nThe card folds to its opening lines and Show more opens the rest.`,
      }]
      proposed.acceptedAt = Date.now()
      proposed.workChatId = workChatId
      send(socket, directory)
      send(socket, { type: 'ack', requestId: message.requestId, workChatId })
      if (proposed.id === 'handoff-labels') workOnOpen.set(workChatId, message.mode === 'single' ? '__single__' : proposed.leadAgentId)
      return
    }
    // Request changes is only acked; the log line shows what reached the Session's request.
    if (message.type === 'revise_work_goal') {
      const images = Array.isArray(message.images) ? message.images : []
      console.log(`revise_work_goal ${message.handoffId} textLength=${String(message.text ?? '').length} images=${images.map((image) => `${image?.name}:${String(image?.dataUrl ?? '').length}`).join(',') || 'none'}`)
    }
    if (message.type === 'undo_memory_write') {
      const write = typeof message.writeId === 'string' ? (snapshots[message.chatId] ?? []).find((event) => event.projectFileWrite?.writeId === message.writeId) : undefined
      // As the real server does, a line that is gone or already undone is refused rather than acknowledged.
      if (write === undefined || write.projectFileWrite.undone === true) {
        send(socket, { type: 'notice', kind: 'error', text: 'That line changed since, so it cannot be undone.', requestId: message.requestId })
        return
      }
      const undone = { ...write, projectFileWrite: { ...write.projectFileWrite, undone: true } }
      snapshots[message.chatId] = snapshots[message.chatId].map((event) => event === write ? undone : event)
      broadcast({ type: 'event', chatId: message.chatId, event: undone })
    }
    // The user's reaction on an agent message: stored on it and broadcast as its patched copy.
    if (message.type === 'set_reaction') {
      const target = (snapshots[message.chatId] ?? []).find((event) => event.id === message.eventId && event.type === 'agent_message')
      if (target === undefined) {
        send(socket, { type: 'notice', kind: 'info', text: 'You can react only to an agent message in a direct chat.', requestId: message.requestId })
        return
      }
      const { reaction: _removed, ...bare } = target
      const patched = message.emoji === null ? bare : { ...bare, reaction: { emoji: message.emoji, at: Date.now() } }
      snapshots[message.chatId] = snapshots[message.chatId].map((event) => event === target ? patched : event)
      broadcast({ type: 'event', chatId: message.chatId, event: patched })
      console.log(`set_reaction ${message.chatId} ${message.eventId} ${message.emoji ?? 'removed'}`)
    }
    const command = message.type === 'send_message' ? chatCommandOf(message) : undefined
    if (command !== undefined) runCommand(message.chatId, command)
    else if (message.type === 'send_message' && REPLIES[message.chatId] !== undefined) reply(message.chatId, REPLIES[message.chatId], message.text, message.images, message.quotes)
    if (message.requestId) {
      send(socket, { type: 'ack', requestId: message.requestId })
    }
  })
})

const heartbeat = setInterval(() => {
  for (const socket of server.clients) {
    if (socket.readyState === socket.OPEN) send(socket, { type: 'heartbeat' })
  }
}, 20_000)

function shutdown() {
  clearInterval(heartbeat)
  server.close()
  http.close()
}

process.on('SIGUSR2', () => {
  hostsAvailable = !hostsAvailable
  console.log(`Vault and mymind ${hostsAvailable ? 'available' : 'absent'}`)
  for (const socket of server.clients) {
    if (socket.readyState === socket.OPEN) for (const status of hostStatuses()) send(socket, status)
  }
})
// The Punt thread's Session, `Stipproef`, for the dot on the thread's Sessions button:
// the first `kill -USR1 $(lsof -tiTCP:43182 -sTCP:LISTEN)` starts a turn there (neutral
// pulsing dot), the second ends it while the phone is elsewhere (green until opened).
let puntTurn = null
process.on('SIGUSR1', () => {
  const turnId = puntTurn ?? `turn-punt-${Date.now()}`
  const base = { type: 'turn_state', chatId: 'chat-punt-session', turnId, agentId: 'agent-wren' }
  broadcast(puntTurn === null ? { ...base, state: 'running', startedAt: Date.now() } : { ...base, state: 'done' })
  console.log(`Stipproef turn ${puntTurn === null ? 'running' : 'done'}`)
  puntTurn = puntTurn === null ? turnId : null
})
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

console.log(`Manor mobile verify fixture listening on ws://${HOST}:${PORT}/ws`)
