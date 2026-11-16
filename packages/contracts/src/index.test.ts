import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isModelOnlyMessage, modelTextOf, splitUserMessage } from './userMessage.js'
import { DriverSchema, EffortSchema, EventImageSchema, GoalClaimsSchema, GoalReportSchema, GOAL_CHOICE_QUESTION_MAX, GOAL_POINT_MAX, SystemNoteEventSchema, placeQuotesAfterText, ImageAttachmentSchema, McpServerDraftSchema, SKIPPED_ANSWER, SingleRuntimeSchema, defaultSingleRuntime, isOpenRoom, isSkippedAnswer, isSoloRoom } from './index.js'

test('single mode preserves the wire choice and closes household routing', () => {
  const runtime = { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' }
  const command = ClientMessageSchema.parse({ type: 'create_chat', projectId: 'project', mode: 'single', overrides: { __single__: runtime } })
  assert.equal(command.type === 'create_chat' && command.mode, 'single')
  assert.deepEqual(SingleRuntimeSchema.parse(runtime), runtime)
  assert.equal(SingleRuntimeSchema.safeParse({}).success, false)
  for (const driver of ['claude', 'codex', 'grok', 'cursor']) {
    assert.equal(SingleRuntimeSchema.safeParse({ ...runtime, driver }).success, true)
  }
  assert.equal(SingleRuntimeSchema.safeParse({ ...runtime, driver: 'mock' }).success, false)
  assert.equal(isOpenRoom({ kind: 'project' }), true)
  assert.equal(isOpenRoom({ kind: 'project', mode: 'single' }), false)
  assert.equal(isSoloRoom({ kind: 'project', mode: 'single' }), true)
})

test('a bare Single session follows the chief of staff when that provider supports it', () => {
  const cos = {
    id: 'cos',
    name: 'Jeeves',
    color: '#000',
    character: '',
    driver: 'cursor' as const,
    model: 'cursor-grok-4.6',
    effort: 'high' as const,
    allowedTools: [],
    mcpServers: [],
    memoryScope: false,
    description: '',
    role: '',
    isCos: true,
  }
  const other = { ...cos, id: 'first', name: 'Sage', isCos: false, driver: 'claude' as const, model: 'claude-sonnet-5' }
  assert.deepEqual(defaultSingleRuntime([other, cos]), { driver: 'cursor', model: 'cursor-grok-4.6', effort: 'high' })
  assert.deepEqual(defaultSingleRuntime([]), { driver: 'claude', model: 'claude-fable-5-2', effort: 'high' })
})

test('Work acceptance retains its mode and complete runtime across the wire', () => {
  const runtime = { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' }
  const base = { type: 'accept_work_handoff', handoffId: 'handoff', requestId: 'accept_1' }
  assert.deepEqual(ClientMessageSchema.parse({ ...base, mode: 'single', runtime }), { ...base, mode: 'single', runtime })
  assert.deepEqual(ClientMessageSchema.parse(base), base)
  assert.equal(ClientMessageSchema.safeParse({ ...base, mode: 'invalid' }).success, false)
  assert.equal(ClientMessageSchema.safeParse({ ...base, mode: 'single', runtime: { driver: 'codex' } }).success, false)
})

test('effort and driver stay closed enums', () => {
  assert.equal(EffortSchema.parse('high'), 'high')
  assert.equal(DriverSchema.parse('claude'), 'claude')
  assert.equal(EffortSchema.safeParse('ludicrous').success, false)
})

test('Auto survives runtime draft and pin commands without becoming a chat provider', () => {
  const override = { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium', auto: true, autoResolved: true }
  const command = ClientMessageSchema.parse({ type: 'set_chat_override', chatId: 'chat', agentId: 'sage', override })
  assert.deepEqual(command.type === 'set_chat_override' && command.override, override)
  const draft = ClientMessageSchema.parse({ type: 'create_chat', projectId: 'project', overrides: { sage: { auto: true } } })
  assert.deepEqual(draft.type === 'create_chat' && draft.overrides, { sage: { auto: true } })
  assert.equal(DriverSchema.safeParse('jev').success, false)
})

test('an MCP draft refuses mixed stdio and HTTP transport', () => {
  const draft = {
    name: 'mail',
    command: 'node',
    args: [],
    envKeys: ['MANOR_MAIL_IMAP_PASSWORD'],
    description: 'draft',
    writes: true,
    effectPolicy: 'confirm_writes',
  }
  assert.equal(McpServerDraftSchema.safeParse(draft).success, true)
  assert.equal(McpServerDraftSchema.safeParse({ ...draft, url: 'https://example/mcp' }).success, false)
})


import { ClientMessageSchema, OutboundDraftContentSchema, SlackRichTextSchema, slackRichTextFallback, type SlackRichText } from './index.js'

const richText: SlackRichText = {
  type: 'rich_text',
  elements: [
    { type: 'rich_text_section', elements: [{ type: 'text', text: 'Styled', style: { bold: true, italic: true, strike: true, code: true } }, { type: 'link', url: 'https://example.com', text: 'Example' }] },
    { type: 'rich_text_list', style: 'ordered', offset: 3, elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Fourth' }] }] },
    { type: 'rich_text_list', style: 'bullet', indent: 1, elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Nested' }] }] },
    { type: 'rich_text_quote', elements: [{ type: 'text', text: 'Quote' }] },
    { type: 'rich_text_preformatted', elements: [{ type: 'text', text: 'const n = 1\nprint(n)' }] },
  ],
}

test('Slack formatting survives the draft and Submit wire contracts', () => {
  const draft = { channel: 'slack', to: 'Self', slackChannelId: 'D12345678', body: 'fallback', slackRichText: richText }
  assert.deepEqual(OutboundDraftContentSchema.parse(draft), draft)
  const message = { type: 'submit_outbound_draft', chatId: 'chat', draftId: 'draft', body: 'fallback', slackRichText: richText }
  assert.deepEqual(ClientMessageSchema.parse(message), message)
  assert.equal(slackRichTextFallback(richText), 'StyledExample (https://example.com)\n4. Fourth\n  • Nested\n> Quote\nconst n = 1\nprint(n)')
  assert.equal(OutboundDraftContentSchema.safeParse({ channel: 'gmail', to: 'a@example.com', body: 'Hi', slackRichText: richText }).success, false)
})

test('Slack formatting refuses unsupported nodes, empty content and oversized documents', () => {
  const document = (elements: unknown[]) => ({ type: 'rich_text', elements })
  const section = (elements: unknown[]) => ({ type: 'rich_text_section', elements })
  assert.equal(SlackRichTextSchema.safeParse(document([{ type: 'actions', elements: [] }])).success, false)
  assert.equal(SlackRichTextSchema.safeParse(document([{ type: 'rich_text_quote', elements: [{ type: 'text', text: ' ' }] }])).success, false)
  assert.equal(SlackRichTextSchema.safeParse(document([section([{ type: 'link', url: 'javascript:alert(1)' }])])).success, false)
  assert.equal(SlackRichTextSchema.safeParse(document([section([{ type: 'text', text: 'a'.repeat(10_001) }, { type: 'text', text: 'b'.repeat(10_001) }])])).success, false)
  assert.equal(SlackRichTextSchema.safeParse(document([{ type: 'rich_text_list', style: 'ordered', offset: -1, elements: [section([{ type: 'text', text: 'Hi' }])] }])).success, false)
})

test('an event image is bytes or a link, and an attachment a client sends is only ever bytes', () => {
  const dataUrl = 'data:image/png;base64,AAAA'
  assert.equal(EventImageSchema.safeParse({ name: 'a.png', dataUrl }).success, true)
  assert.equal(EventImageSchema.safeParse({ name: 'a.png', src: '/media/c/e/0/sig', width: 2, height: 1 }).success, true)
  assert.equal(EventImageSchema.safeParse({ name: 'a.png' }).success, false)
  assert.equal(EventImageSchema.safeParse({ name: 'a.png', dataUrl, src: '/media/c/e/0/sig' }).success, false)
  assert.equal(ImageAttachmentSchema.safeParse({ name: 'a.png', src: '/media/c/e/0/sig' }).success, false)
})

import { addsAgentMention } from './index.js'

test('addsAgentMention fires on a fresh persona tag, not on edits around an old one', () => {
  const agents = [{ id: 'smith', name: 'Smith' }, { id: 'nova', name: 'Nova' }]
  assert.equal(addsAgentMention('ask ', 'ask @Smith ', agents), true)
  assert.equal(addsAgentMention('ask @Smith ', 'ask @Smith about this', agents), false)
  assert.equal(addsAgentMention('ask @Smith ', 'ask @Smith and @nova', agents), true)
  assert.equal(addsAgentMention('ask ', 'ask @browser and mail me@smith.nl', agents), false)
})

test('goal claims need a ref above stated, and an old goal note without claims still parses', () => {
  assert.equal(GoalClaimsSchema.safeParse([{ claim: 'Tests pass.', level: 'stated' }]).success, true)
  assert.equal(GoalClaimsSchema.safeParse([{ claim: 'Tests pass.', level: 'ran' }]).success, false)
  assert.equal(GoalClaimsSchema.safeParse([{ claim: 'Tests pass.', level: 'ran', ref: '  ' }]).success, false)
  assert.equal(GoalClaimsSchema.safeParse([]).success, false)
  const note = { id: 'evt_000001', ts: 1, type: 'system_note', kind: 'info', text: 'Sage marked the goal reached.', workGoalHandoffId: 'h' }
  assert.equal(SystemNoteEventSchema.safeParse(note).success, true)
})

test('a session answer stored under an older word for the user reads as the user', () => {
  const note = (by: string) => ({ id: 'evt_000002', ts: 1, type: 'system_note', kind: 'info', text: 'Answered.',
    sessionAnswer: { sessionChatId: 's', requestId: 'r', answers: {}, by } })
  for (const [stored, read] of [['user', 'user'], ['thread', 'thread'], ['owner', 'user']] as const) {
    assert.equal(SystemNoteEventSchema.parse(note(stored)).sessionAnswer?.by, read)
  }
})

import { applyDirectoryPatch, diffDirectory, type Chat, type DirectoryMessage, type Project, type SubagentSummary, type WorkHandoff } from './index.js'

const listedProject: Project = { id: 'p1', name: 'Manor', icon: 'home', color: '#8A8F98', repoPaths: [], memoryScope: 'project' }
const listedChat = (id: string, extra: Partial<Chat> = {}): Chat => ({
  id, projectId: listedProject.id, kind: 'project', routineId: null, parentChatId: null, sideModel: null, sideEffort: null,
  memberIds: [], agentIds: [], title: id, createdAt: 1, lastMessageAt: 1, lastMessagePreview: null,
  settledAt: null, archivedAt: null, checkout: { mode: 'current', branch: null }, ...extra,
})
const listedHandoff = (id: string, extra: Partial<WorkHandoff> = {}): WorkHandoff => ({
  id, sourceChatId: 'a', sourceTurnId: 't', workChatId: null, projectId: listedProject.id, projectName: listedProject.name,
  title: id, leadAgentId: 'wren', leadAgentName: 'Wren', supportingAgentIds: [], supportingAgentNames: [],
  acceptedAt: 1, state: 'active', result: null, resultAt: null, version: 1, createdAt: 1, ...extra,
})
const listedChild: SubagentSummary = {
  id: 'child', parentChatId: 'a', title: 'Check', agentId: 'sage', turnId: 't', toolCallId: 'call',
  driver: 'claude', model: 'claude-sonnet-5', effort: 'high', state: 'running', startedAt: 1, depth: 1,
}
const [chatA, chatB, chatC] = [listedChat('a'), listedChat('b'), listedChat('c')]
const listing: DirectoryMessage = {
  type: 'directory',
  projects: [listedProject],
  chats: [chatA, chatB, chatC],
  workHandoffs: [listedHandoff('h1'), listedHandoff('h2')],
  subagents: [listedChild],
  runningTurns: { a: ['t'] },
}
const rebuilt = (base: DirectoryMessage, next: DirectoryMessage) => {
  const patch = diffDirectory(base, next)
  const whole = applyDirectoryPatch(base, patch)
  assert.deepEqual(whole, next)
  return { patch, whole }
}

test('a directory patch carries only changed items and keeps every unchanged one', () => {
  const { patch, whole } = rebuilt(listing, { ...listing, chats: [{ ...chatA }, { ...chatB, title: 'Renamed' }, { ...chatC }] })
  assert.deepEqual(patch.chats, { changed: [{ ...chatB, title: 'Renamed' }] })
  assert.equal(whole.chats[0], chatA)
  assert.equal(whole.chats[2], chatC)
  assert.equal(whole.projects, listing.projects)

  const settled = rebuilt(listing, { ...listing, workHandoffs: [listing.workHandoffs[0]!, listedHandoff('h2', { state: 'settled' })] })
  assert.equal(settled.patch.workHandoffs.changed.length, 1)
  assert.equal(settled.whole.chats, listing.chats)
})

test('a directory patch adds, removes and reorders by id', () => {
  const added = rebuilt(listing, { ...listing, chats: [chatA, chatB, chatC, listedChat('d')] })
  assert.deepEqual(added.patch.chats.order, ['a', 'b', 'c', 'd'])
  assert.equal(added.patch.chats.changed.length, 1)
  assert.deepEqual(rebuilt(listing, { ...listing, chats: [chatA, chatC] }).patch.chats, { changed: [], order: ['a', 'c'] })
  const moved = rebuilt(listing, { ...listing, chats: [chatC, chatA, chatB] })
  assert.equal(moved.whole.chats[0], chatC)
  assert.deepEqual(applyDirectoryPatch(listing, { ...moved.patch, chats: { changed: [], order: ['c', 'gone', 'a'] } }).chats, [chatC, chatA])
})

test('a directory patch follows subagents appearing and disappearing, and an unchanged listing keeps its lists', () => {
  const { subagents: _, ...bare } = listing
  assert.equal('subagents' in rebuilt(listing, bare).whole, false)
  assert.deepEqual(rebuilt(bare, listing).patch.subagents, { changed: [listedChild], order: ['child'] })
  const same = rebuilt(listing, JSON.parse(JSON.stringify(listing)) as DirectoryMessage)
  assert.deepEqual(same.patch, { type: 'directory_patch', projects: { changed: [] }, chats: { changed: [] }, workHandoffs: { changed: [] }, subagents: { changed: [] }, runningTurns: { a: ['t'] } })
  for (const key of ['projects', 'chats', 'workHandoffs', 'subagents'] as const) assert.equal(same.whole[key], listing[key])
})

test('only links to the public web read as sources', async () => {
  const { faviconSource, webLinkOrigin, REMOTE_FAVICON_PATH } = await import('./webLinks.js')
  assert.equal(webLinkOrigin('https://www.healio.com/news/gastroenterology/x?y=1'), 'https://www.healio.com')
  assert.equal(webLinkOrigin(' http://pubmed.ncbi.nlm.nih.gov/123/ '), 'http://pubmed.ncbi.nlm.nih.gov')
  for (const href of [
    undefined, '', 'mailto:a@b.nl', 'file:///Users/x/a.md', 'apps/web/src/App.tsx', '/media/remote', '#top',
    'http://localhost:43179/chat', 'http://manor.localhost/', 'http://mac.local/x', 'http://127.0.0.1:8080/',
    'http://[::1]/', 'https://intranet/', 'javascript:alert(1)',
  ]) assert.equal(webLinkOrigin(href), undefined, String(href))
  assert.equal(faviconSource('https://healio.com/a'), `${REMOTE_FAVICON_PATH}?site=${encodeURIComponent('https://healio.com')}`)
  assert.equal(faviconSource('mailto:a@b.nl'), undefined)
})

test('a user message keeps Manor\'s wording for the model apart from what the user reads', () => {
  const opening = '[Manor] Session accepted as Single with claude-opus-5-5. Complete the task below in this session.\n\n'
  const task = '## Problem\nThe kickoff is a wall.\n\n[Manor] stays when it is not the opening.'
  const kickoff = { source: 'work_handoff' as const }
  // New rows: the field says which part is which, and the model reads both, in order.
  assert.deepEqual(splitUserMessage({ ...kickoff, text: task, instruction: opening }), { visible: task, instruction: opening })
  assert.equal(modelTextOf({ text: task, instruction: opening }), `${opening}${task}`)
  assert.equal(isModelOnlyMessage({ text: '', instruction: '[Manor] The user confirmed the ready result.' }), true)
  assert.equal(isModelOnlyMessage({ text: task, instruction: opening }), false)
  // Rows from before the field hold it inside the text; the same split finds it.
  assert.deepEqual(splitUserMessage({ ...kickoff, text: `${opening}${task}` }), { visible: task, instruction: opening })
  assert.deepEqual(splitUserMessage({ ...kickoff, text: `[Manor] First line.\n[Manor] Second line.\n${task}` }).visible, task)
  const brief = { source: 'project_thread' as const, threadReason: 'brief' }
  const briefTask = '## Outcome\nOne card.\nTask:\nstays in the brief.'
  assert.equal(splitUserMessage({ ...brief, text: `[Manor] Smith handed this brief over.\nTitle: Card\nTask:\n${briefTask}` }).visible, briefTask)
  assert.equal(splitUserMessage({ source: 'project_thread', threadReason: 'report', text: '[Manor] Queued for this thread.' }).visible, '')
  assert.equal(splitUserMessage({ text: '[Manor] The user confirmed the ready result, and that is their approval to commit.' }).visible, '')
  assert.equal(splitUserMessage({ text: '[Manor] Manor could not merge this Session.', mergeTrouble: { kind: 'conflict' } }).visible, '')
  // Nothing else is hidden: a message the user typed may open with "[Manor]", and a plain one is untouched.
  assert.equal(splitUserMessage({ text: '[Manor] is what I call it' }).visible, '[Manor] is what I call it')
  assert.deepEqual(splitUserMessage({ text: 'Hi' }), { visible: 'Hi', instruction: '' })
  assert.equal(modelTextOf({ text: 'Hi' }), 'Hi')
})

test('quotes held beside the words are placed after them', () => {
  const quote = { eventId: 'evt_1', text: 'Chosen' }
  const noteQuote = { path: 'inbox/a.md', text: 'Noted' }
  assert.deepEqual(placeQuotesAfterText({ text: 'Why?', quote, noteQuote }), {
    text: 'Why? [Quote #1] [Quote #2]',
    quotes: [{ kind: 'message', ...quote }, { kind: 'note', ...noteQuote }],
  })
  assert.deepEqual(placeQuotesAfterText({ text: '', quote }), { text: '[Quote #1]', quotes: [{ kind: 'message', ...quote }] })
  assert.deepEqual(placeQuotesAfterText({ text: 'Plain' }), { text: 'Plain', quotes: [] })
})

test('a goal report carries up to three short points, and older reports parse without them', () => {
  assert.deepEqual(GoalReportSchema.parse({ result: 'Done.' }), { result: 'Done.' })
  const points = ['Helpers are cards', 'A Finished card per helper', 'DMs show none']
  assert.deepEqual(GoalReportSchema.parse({ result: 'Done.', points }).points, points)
  assert.equal(GoalReportSchema.safeParse({ result: 'Done.', points: [...points, 'One more'] }).success, false)
  assert.equal(GoalReportSchema.safeParse({ result: 'Done.', points: [] }).success, false)
  assert.equal(GoalReportSchema.safeParse({ result: 'Done.', points: ['x'.repeat(GOAL_POINT_MAX + 1)] }).success, false)
})

test('a choice may carry a plain question, and a choice without one parses as before', () => {
  const choice = { title: 'Stale phone checks', options: ['Clean up on its own', 'Leave them'] }
  assert.deepEqual(GoalReportSchema.parse({ result: 'Done.', choices: [choice] }).choices, [choice])
  const question = 'A phone check whose folder was deleted keeps its ports for a day. Should Manor clean those up on its own?'
  assert.equal(GoalReportSchema.parse({ result: 'Done.', choices: [{ ...choice, question }] }).choices?.[0]?.question, question)
  assert.equal(GoalReportSchema.safeParse({ result: 'Done.', choices: [{ ...choice, question: 'x'.repeat(GOAL_CHOICE_QUESTION_MAX + 1) }] }).success, false)
})

test('a question counts as skipped only when every line of its answer is the skip line', () => {
  assert.equal(isSkippedAnswer(SKIPPED_ANSWER), true)
  assert.equal(isSkippedAnswer([SKIPPED_ANSWER]), true)
  assert.equal(isSkippedAnswer('Skipped'), false)
  assert.equal(isSkippedAnswer(['Left', SKIPPED_ANSWER]), false)
})
