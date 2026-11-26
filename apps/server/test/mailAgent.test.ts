import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mailNewRecipients, type Driver, type MailThread, type ServerMessage, type TurnInput } from '@manor/contracts'
import { mockComposio } from '../src/composioMarketplacePorts.js'
import { buildArgs as buildClaudeArgs } from '../src/drivers/claudeDriver.js'
import { buildCodexAppServerArgs, buildCodexThreadRequest } from '../src/drivers/codexDriver.js'
import { buildCursorArgs } from '../src/drivers/cursorDriver.js'
import { buildGrokArgs } from '../src/drivers/grokDriver.js'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import { FIXTURE_THREAD, MailFixtureSource } from '../src/mailFixtureSource.js'
import { MAIL_DRAFT_TURN_MS } from '../src/mailDraft.js'
import { MailModule } from '../src/mailModule.js'
import { MAIL_REVISION_MARK, MAIL_UNTRUSTED_CLOSE, MAIL_UNTRUSTED_OPEN } from '../src/mailPrompt.js'
import type { MailInbox } from '../src/mailSource.js'
import { MAIL_TRIAGE_CLAIM_STALE_MS, mailTriageDue } from '../src/mailTriage.js'
import { McpHttpHost } from '../src/mcp/httpHost.js'
import { MAIL_TRIAGE_MCP_NAME, MAIL_TRIAGE_TOOL } from '../src/mcp/mailTriageServer.js'
import { createMockOutboundSendPort, RecordingOutboundSend, type OutboundSendPort, type OutboundSendRequest, type OutboundSendResult } from '../src/outboundSend.js'
import { marlow } from './helpers.js'

type MailState = Extract<ServerMessage, { type: 'mail_state' }>
type MailDraftFrame = Extract<ServerMessage, { type: 'mail_draft' }>

const dirs: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

/** The server's own MCP HTTP host on a loopback port, so the triage tool is called over real HTTP. */
async function toolHost(): Promise<McpHttpHost> {
  let host: McpHttpHost | undefined
  const server = createServer((request, response) => { void host!.handle(request, response) })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  host = new McpHttpHost(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  return host
}

/** The mock driver behind a recorder: every `TurnInput` it was handed, and every Stop. */
function recordingDriver(deltaDelayMs = 0) {
  const inner = createMockDriver({ deltaDelayMs })
  const inputs: TurnInput[] = []
  let stops = 0
  const driver: Driver = {
    startTurn(input) {
      inputs.push(input)
      const handle = inner.startTurn(input)
      return { events: handle.events, stop: () => { stops += 1; handle.stop() } }
    },
  }
  return { driver, inputs, stops: () => stops }
}

class SilentPort implements OutboundSendPort {
  readonly sent: OutboundSendRequest[] = []
  constructor(private readonly answer: (request: OutboundSendRequest) => Promise<OutboundSendResult>) {}
  send(request: OutboundSendRequest): Promise<OutboundSendResult> {
    this.sent.push(request)
    return this.answer(request)
  }
}

/** A mailbox that numbers no threads itself, so no message carries a Gmail thread id. */
class PlainImapSource extends MailFixtureSource {
  override async listInbox(limit: number): Promise<MailInbox> {
    const inbox = await super.listInbox(limit)
    return { ...inbox, messages: inbox.messages.map(({ gmailThreadId: _gone, ...message }) => message) }
  }
}

async function setup(options: {
  source?: MailFixtureSource
  send?: OutboundSendPort
  cacheFile?: string
  now?: () => number
  deltaDelayMs?: number
} = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'manor-mail-agent-'))
  dirs.push(dir)
  const source = options.source ?? new MailFixtureSource({ now: Date.UTC(2026, 10, 26, 12) })
  const recorder = recordingDriver(options.deltaDelayMs)
  const broadcasts: ServerMessage[] = []
  const send = options.send ?? new RecordingOutboundSend()
  const module = new MailModule({
    source,
    cacheFile: options.cacheFile ?? path.join(dir, 'mail-cache.db'),
    projectIds: async () => [],
    broadcast: (message) => broadcasts.push(message),
    ...(options.now === undefined ? {} : { now: options.now }),
    runtime: { agents: () => [marlow], resolveDriver: () => recorder.driver, ensureScratchDir: async (id) => path.join(dir, id) },
    send,
    toolHost: await toolHost(),
  })
  await module.refresh()
  const socket = (name: string) => {
    const replies: ServerMessage[] = []
    const reply = (message: ServerMessage) => replies.push(message)
    return {
      name,
      replies,
      reply,
      send: (message: Parameters<MailModule['handle']>[0]) => module.handle(message, reply),
      frames: () => replies.filter((message): message is MailDraftFrame => message.type === 'mail_draft'),
    }
  }
  const lastState = () => broadcasts.filter((message): message is MailState => message.type === 'mail_state').at(-1)!
  const card = (threadId: string) => lastState().cards.find((entry) => entry.threadId === threadId)
  return { module, source, recorder, broadcasts, send, socket, lastState, card, dir }
}

const promptOf = (input: TurnInput) => {
  const first = input.catchUp[0]
  return first?.type === 'user_message' ? first.text : ''
}

/** Everything in a turn's config that could hand the model a tool. */
const toolGrants = (input: TurnInput) => ({
  allowedTools: input.agent.allowedTools,
  agentMcpServers: input.agent.mcpServers,
  skillIds: input.agent.skillIds ?? [],
  memoryScope: input.agent.memoryScope,
  repoPaths: input.repoPaths,
  imagePaths: input.imagePaths ?? [],
  singleSession: input.singleSession ?? false,
  live: input.live ?? false,
  manorFollowUp: input.manorFollowUp ?? false,
  volatileBlocks: input.volatileBlocks ?? [],
})

const NO_GRANTS = {
  allowedTools: [], agentMcpServers: [], skillIds: [], memoryScope: false, repoPaths: [], imagePaths: [],
  singleSession: false, live: false, manorFollowUp: false, volatileBlocks: [],
}

describe('the draft turn', () => {
  it('is handed no tool, folder or server, and every driver runs it in its tightest mode', async () => {
    const { socket, recorder } = await setup()
    const asker = socket('a')
    await asker.send({ type: 'mail_draft_start', draftId: 'd1', threadId: FIXTURE_THREAD.interview })
    const [input] = recorder.inputs
    expect(recorder.inputs).toHaveLength(1)
    expect(toolGrants(input!)).toEqual(NO_GRANTS)
    expect(input!.mcpServers).toEqual([])
    expect(input!.agent).toMatchObject({ id: marlow.id, driver: marlow.driver, character: marlow.character })

    const claude = buildClaudeArgs(input!)
    expect(claude.slice(-2)).toEqual(['--tools', ''])
    expect(claude).not.toContain('--mcp-config')
    expect(claude).not.toContain('--add-dir')
    expect(buildCodexAppServerArgs(input!).join(' ')).not.toContain('mcp_servers')
    expect(buildCodexThreadRequest(input!, '/tmp/x').params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never' })
    const grok = buildGrokArgs(input!)
    expect(grok).toEqual(expect.arrayContaining(['--tools', 'read_file', '--disable-web-search', '--disallowed-tools', 'read_file,search_tool,use_tool']))
    const cursor = buildCursorArgs(input!, '/tmp/x')
    expect(cursor).toEqual(expect.arrayContaining(['--mode', 'ask', '--sandbox', 'enabled']))
    expect(cursor).not.toContain('--force')
  })

  it('streams to the asker only and ends in one done', async () => {
    const { socket, broadcasts } = await setup()
    const asker = socket('a')
    const other = socket('b')
    await asker.send({ type: 'mail_draft_start', draftId: 'd1', threadId: FIXTURE_THREAD.interview })
    const frames = asker.frames()
    expect(frames.length).toBeGreaterThan(10)
    expect(frames.slice(0, -1).every((frame) => frame.status === 'streaming')).toBe(true)
    expect(frames.filter((frame) => frame.status === 'done')).toHaveLength(1)
    const done = frames.at(-1)!
    expect(done).toMatchObject({ status: 'done', draftId: 'd1', threadId: FIXTURE_THREAD.interview })
    expect(done.text.split(/\s+/).length).toBeGreaterThanOrEqual(60)
    // Every frame is the whole text so far, never a delta.
    for (const frame of frames.slice(0, -1)) expect(done.text.startsWith(frame.text.trimEnd())).toBe(true)
    expect(other.replies).toEqual([])
    expect(broadcasts.some((message) => message.type === 'mail_draft')).toBe(false)
  })

  it('quotes the mail as untrusted, and a revision carries the current text and the instruction', async () => {
    const { socket, recorder } = await setup()
    const asker = socket('a')
    await asker.send({ type: 'mail_draft_start', draftId: 'd1', threadId: FIXTURE_THREAD.interview })
    const first = asker.frames().at(-1)!.text
    const current = `${first}\n\nP.S. edited by hand`
    await asker.send({ type: 'mail_draft_start', draftId: 'd2', threadId: FIXTURE_THREAD.interview, instruction: 'Make it shorter.', current })
    const [initial, revision] = recorder.inputs.map(promptOf)
    expect(initial).not.toContain(MAIL_REVISION_MARK)
    const block = initial!.slice(initial!.indexOf(MAIL_UNTRUSTED_OPEN), initial!.indexOf(MAIL_UNTRUSTED_CLOSE))
    expect(block).toContain(JSON.stringify('Hi,\n\nThursday at 10:00 works for the team lead. Would that suit you? The interview takes about an hour, at our office.\n\nKind regards,\nNora Example'))
    expect(revision).toContain(MAIL_REVISION_MARK)
    expect(revision).toContain(JSON.stringify(current))
    // After the untrusted block: the user's words are not inside the quoted mail.
    expect(revision!.indexOf('Make it shorter.')).toBeGreaterThan(revision!.indexOf(MAIL_UNTRUSTED_CLOSE))
    const second = asker.frames().filter((frame) => frame.draftId === 'd2').at(-1)!
    expect(second.status).toBe('done')
    expect(second.text).not.toBe(first)
    expect(second.text.length).toBeLessThan(first.length)
  })

  it('a stop, a new start from the same socket, or the socket closing ends the running turn', async () => {
    const { socket, recorder, module } = await setup({ deltaDelayMs: 20 })
    const asker = socket('a')
    const firstFrame = () => vi.waitFor(() => expect(asker.frames().length).toBeGreaterThan(0))

    const stopped = asker.send({ type: 'mail_draft_start', draftId: 'd1', threadId: FIXTURE_THREAD.family })
    await firstFrame()
    await asker.send({ type: 'mail_draft_stop', draftId: 'd1' })
    await stopped
    expect(recorder.stops()).toBe(1)
    expect(asker.frames().some((frame) => frame.status === 'done')).toBe(false)

    asker.replies.length = 0
    const replaced = asker.send({ type: 'mail_draft_start', draftId: 'd2', threadId: FIXTURE_THREAD.family })
    await firstFrame()
    const next = asker.send({ type: 'mail_draft_start', draftId: 'd3', threadId: FIXTURE_THREAD.family, instruction: 'Shorter.', current: 'x' })
    await replaced
    expect(recorder.stops()).toBe(2)
    await next
    expect(asker.frames().filter((frame) => frame.status === 'done').map((frame) => frame.draftId)).toEqual(['d3'])

    asker.replies.length = 0
    const closed = asker.send({ type: 'mail_draft_start', draftId: 'd4', threadId: FIXTURE_THREAD.family })
    await firstFrame()
    module.closeSocket(asker.reply)
    await closed
    expect(recorder.stops()).toBe(3)
    expect(asker.frames().some((frame) => frame.status === 'done')).toBe(false)
  })

  it('stops a turn that outlives its time cap and says so', async () => {
    const { socket, recorder } = await setup({ deltaDelayMs: 10 * MAIL_DRAFT_TURN_MS })
    const asker = socket('a')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const drafted = asker.send({ type: 'mail_draft_start', draftId: 'd1', threadId: FIXTURE_THREAD.family })
      await vi.waitFor(() => expect(recorder.inputs).toHaveLength(1))
      await vi.advanceTimersByTimeAsync(MAIL_DRAFT_TURN_MS)
      await drafted
    } finally {
      vi.useRealTimers()
    }
    expect(recorder.stops()).toBe(1)
    expect(asker.frames().at(-1)).toMatchObject({ status: 'error', message: 'Marlow took too long.' })
  })

  it('another socket cannot stop a draft it did not start', async () => {
    const { socket, recorder } = await setup({ deltaDelayMs: 5 })
    const asker = socket('a')
    const other = socket('b')
    const running = asker.send({ type: 'mail_draft_start', draftId: 'd1', threadId: FIXTURE_THREAD.parking })
    await vi.waitFor(() => expect(asker.frames().length).toBeGreaterThan(0))
    await other.send({ type: 'mail_draft_stop', draftId: 'd1' })
    await running
    expect(recorder.stops()).toBe(0)
    expect(asker.frames().at(-1)?.status).toBe('done')
  })
})

describe('the triage run', () => {
  it('has exactly one tool: the run\'s mail_set_label', async () => {
    const { socket, recorder } = await setup()
    await socket('a').send({ type: 'mail_triage_run' })
    const [input] = recorder.inputs
    expect(toolGrants(input!)).toEqual(NO_GRANTS)
    expect(input!.mcpServers).toHaveLength(1)
    expect(input!.mcpServers![0]!.server).toMatchObject({ name: MAIL_TRIAGE_MCP_NAME, tools: [MAIL_TRIAGE_TOOL], writes: false, command: '', args: [] })
    // Claude: the one server plus ToolSearch, which can only load that server's deferred tool.
    expect(buildClaudeArgs(input!).slice(-2)).toEqual(['--tools', 'ToolSearch'])
    // Codex gates every MCP call on approval; the run's one tool is approved by name.
    const codex = buildCodexAppServerArgs(input!).join(' ')
    expect(codex).toContain(`enabled_tools=["${MAIL_TRIAGE_TOOL}"]`)
    expect(codex).toContain(`tools={${MAIL_TRIAGE_TOOL}={approval_mode="approve"}}`)
    expect(buildCursorArgs(input!, '/tmp/x')).toEqual(expect.arrayContaining(['--mode', 'ask']))
  })

  it('labels the fixture threads with reasons, leaves a user label alone, and leaves the mailbox untouched', async () => {
    const { socket, source, send, card, broadcasts, module } = await setup()
    const asker = socket('a')
    await asker.send({ type: 'mail_set_label', threadId: FIXTURE_THREAD.family, label: 'fyi' })
    const archive = vi.spyOn(source, 'archive')
    const restore = vi.spyOn(source, 'restore')
    const mailbox = async () => JSON.stringify({
      inbox: await source.listInbox(200),
      threads: await Promise.all(Object.values(FIXTURE_THREAD).map((threadId) => source.readThread({ threadId, uidValidity: '1', uids: [] }))),
    })
    const before = await mailbox()
    broadcasts.length = 0

    await asker.send({ type: 'mail_triage_run' })

    expect(card(FIXTURE_THREAD.interview)).toMatchObject({ label: 'reply', reason: 'Asks you to answer or act.' })
    expect(card(FIXTURE_THREAD.parking)).toMatchObject({ label: 'reply' })
    expect(card(FIXTURE_THREAD.waiting)).toMatchObject({ label: 'wait', reason: 'You wrote last and are waiting for an answer.' })
    expect(card(FIXTURE_THREAD.digest)).toMatchObject({ label: 'fyi', reason: 'An automatic message; nothing to answer.' })
    expect(card(FIXTURE_THREAD.application)).toMatchObject({ label: 'fyi' })
    expect(card(FIXTURE_THREAD.family)).toEqual(expect.objectContaining({ label: 'fyi' }))
    expect(card(FIXTURE_THREAD.family)?.reason).toBeUndefined()
    expect(module.cache!.label(FIXTURE_THREAD.family)?.by).toBe('user')

    expect(await mailbox()).toBe(before)
    expect(archive).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
    expect((send as RecordingOutboundSend).sent).toEqual([])
    // Opening for the snippets marked nothing opened here either.
    expect(card(FIXTURE_THREAD.parking)?.unread).toBe(true)

    const states = broadcasts.filter((message): message is MailState => message.type === 'mail_state')
    expect(states.some((state) => state.triage.running)).toBe(true)
    expect(states.at(-1)!.triage).toMatchObject({ running: false })
    expect(states.at(-1)!.triage.lastRunAt).toEqual(expect.any(Number))
    expect(states.at(-1)!.triage.error).toBeUndefined()
  })

  it('refuses an id that is not of this run and records a run that set nothing as failed', async () => {
    const quiet: Driver = { startTurn: () => ({ events: (async function* () { yield { type: 'result' as const, text: 'Done.' } })(), stop: () => undefined }) }
    const silent = new MailModule({
      source: new MailFixtureSource({ now: Date.UTC(2026, 10, 26, 12) }),
      cacheFile: ':memory:',
      projectIds: async () => [],
      broadcast: () => undefined,
      runtime: { agents: () => [marlow], resolveDriver: () => quiet, ensureScratchDir: async (id) => id },
      toolHost: await toolHost(),
    })
    await silent.handle({ type: 'mail_triage_run' }, () => undefined)
    expect((await silent.state()).triage.error).toBe('Marlow set no labels in this run.')

    // A forged id over the real endpoint is refused and labels nothing.
    const host = await toolHost()
    const forging: Driver = {
      startTurn: (input) => ({
        events: (async function* () {
          const tool = input.mcpServers![0]!
          const header = tool.server.httpHeaders![0]!
          const response = await fetch(tool.server.url!, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [header.name]: tool.runtimeEnv![header.envKey]! },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: MAIL_TRIAGE_TOOL, arguments: { id: FIXTURE_THREAD.parking, label: 'fyi', reason: 'x' } } }),
          })
          const answer = await response.json() as { result: { isError?: boolean; content: { text: string }[] } }
          yield { type: 'result' as const, text: `${answer.result.isError === true}:${answer.result.content[0]!.text}` }
        })(),
        stop: () => undefined,
      }),
    }
    const forged = new MailModule({
      source: new MailFixtureSource({ now: Date.UTC(2026, 10, 26, 12) }),
      cacheFile: ':memory:',
      projectIds: async () => [],
      broadcast: () => undefined,
      runtime: { agents: () => [marlow], resolveDriver: () => forging, ensureScratchDir: async (id) => id },
      toolHost: host,
    })
    await forged.handle({ type: 'mail_triage_run' }, () => undefined)
    expect((await forged.state()).cards.every((entry) => entry.label === undefined)).toBe(true)
  })

  it('a fresh claim by another server holds the run back; a stale one does not', async () => {
    let now = Date.UTC(2026, 10, 26, 12)
    const { module, recorder, socket } = await setup({ now: () => now })
    module.cache!.setMeta('triageClaim', JSON.stringify({ owner: 'other-server', at: now - 60_000 }))
    await socket('a').send({ type: 'mail_triage_run' })
    expect(recorder.inputs).toHaveLength(0)
    now += MAIL_TRIAGE_CLAIM_STALE_MS
    await socket('a').send({ type: 'mail_triage_run' })
    expect(recorder.inputs).toHaveLength(1)
    // Released when the run ends.
    expect(module.cache!.getMeta('triageClaim')).toBeUndefined()
  })

  it('is due once a day after 07:30 host time, and the tick catches up a missed one', async () => {
    const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime()
    expect(mailTriageDue(at(26, 7, 29), null)).toBe(false)
    expect(mailTriageDue(at(26, 7, 30), null)).toBe(true)
    expect(mailTriageDue(at(26, 9), at(25, 8))).toBe(true)
    expect(mailTriageDue(at(26, 9), at(26, 6))).toBe(true)
    expect(mailTriageDue(at(26, 9), at(26, 7, 45))).toBe(false)

    let now = at(26, 6)
    const { module, recorder, source } = await setup({ now: () => now })
    await module.tickTriage()
    expect(recorder.inputs).toHaveLength(0)
    // The Mac slept through 07:30 and wakes at nine.
    now = at(26, 9)
    await module.tickTriage()
    expect(recorder.inputs).toHaveLength(1)
    now = at(26, 12)
    await module.tickTriage()
    expect(recorder.inputs).toHaveLength(1)
    // Next morning, with one new mail: every older one carries a label by now.
    source.deliver({ threadId: '1790000000000000099', subject: 'Invoice 2026-114', from: { name: 'Billing', address: 'billing@shop.example' }, text: 'Your invoice is attached.', at: at(27, 7) })
    now = at(27, 7, 31)
    await module.tickTriage()
    expect(recorder.inputs).toHaveLength(2)
    expect(promptOf(recorder.inputs[1]!)).toContain('Invoice 2026-114')
    expect(promptOf(recorder.inputs[1]!)).not.toContain('Second round interview')
    expect((await module.state()).triage.lastRunAt).toBe(now)
  })
})

describe('send', () => {
  const sendFamily = { type: 'mail_send', threadId: FIXTURE_THREAD.family, to: 'ingrid@family.example', cc: 'hiring@talent.example', body: 'Ja, graag!' } as const

  it('calls the port as a threaded reply from the account, and a confirmed send moves reply to wait', async () => {
    const { socket, send, card } = await setup()
    const asker = socket('a')
    await asker.send({ type: 'mail_set_label', threadId: FIXTURE_THREAD.family, label: 'reply' })
    await asker.send({ ...sendFamily, requestId: 's1' })
    expect((send as RecordingOutboundSend).sent).toEqual([{
      channel: 'gmail',
      submissionId: 's1',
      from: 'you@example.com',
      to: 'ingrid@family.example',
      cc: 'hiring@talent.example',
      subject: 'Re: Komen jullie zondag eten?',
      body: 'Ja, graag!',
      gmailThreadId: FIXTURE_THREAD.family,
    }])
    expect(asker.replies.at(-1)).toEqual({ type: 'mail_result', requestId: 's1', ok: true })
    expect(card(FIXTURE_THREAD.family)?.label).toBe('wait')
  })

  it('a thread the port cannot resolve is refused and its label stays', async () => {
    const port = new SilentPort(async () => ({ ok: false, certainty: 'safe', message: 'Gmail did not send this reply because the original thread could not be read: no such thread' }))
    const { socket, card } = await setup({ send: port })
    const asker = socket('a')
    await asker.send({ type: 'mail_set_label', threadId: FIXTURE_THREAD.family, label: 'reply' })
    await asker.send({ ...sendFamily, requestId: 's1' })
    expect(port.sent[0]?.gmailThreadId).toBe(FIXTURE_THREAD.family)
    expect(asker.replies.at(-1)).toEqual({ type: 'mail_result', requestId: 's1', ok: false, message: 'Gmail did not send this reply because the original thread could not be read: no such thread' })
    expect(card(FIXTURE_THREAD.family)?.label).toBe('reply')
    // A safe refusal leaves nothing to check: the next send goes to the port again.
    await asker.send({ ...sendFamily, requestId: 's2' })
    expect(port.sent).toHaveLength(2)
  })

  it('a thread without a Gmail thread id is refused before the port, never sent as new mail', async () => {
    const port = new SilentPort(async () => ({ ok: true, delivery: 'delivered' }))
    const { socket } = await setup({ source: new PlainImapSource({ now: Date.UTC(2026, 10, 26, 12) }), send: port })
    const asker = socket('a')
    await asker.send({ ...sendFamily, requestId: 's1' })
    expect(port.sent).toEqual([])
    expect(asker.replies.at(-1)).toMatchObject({ requestId: 's1', ok: false, message: expect.stringContaining('could not be filed in its thread') })
  })

  it('an uncertain outcome answers ok:false, keeps the label, and the next send asks to check Sent once', async () => {
    const answers: OutboundSendResult[] = [
      { ok: false, certainty: 'uncertain', message: 'Gmail could not send this draft: socket hang up' },
      { ok: true, delivery: 'delivered' },
    ]
    const port = new SilentPort(async () => answers.shift()!)
    const { socket, card } = await setup({ send: port })
    const asker = socket('a')
    await asker.send({ type: 'mail_set_label', threadId: FIXTURE_THREAD.family, label: 'reply' })
    await asker.send({ ...sendFamily, requestId: 's1' })
    expect(asker.replies.at(-1)).toMatchObject({ requestId: 's1', ok: false, message: 'Gmail could not send this draft: socket hang up' })
    expect(card(FIXTURE_THREAD.family)?.label).toBe('reply')
    await asker.send({ ...sendFamily, requestId: 's2' })
    expect(asker.replies.at(-1)).toMatchObject({ requestId: 's2', ok: false, message: expect.stringContaining('Check Sent') })
    expect(port.sent).toHaveLength(1)
    await asker.send({ ...sendFamily, requestId: 's3' })
    expect(asker.replies.at(-1)).toEqual({ type: 'mail_result', requestId: 's3', ok: true })
  })

  it('a send left started by a crash makes the next send refuse once', async () => {
    const first = await setup()
    first.module.cache!.recordSendClaim({ requestId: 's0', threadId: FIXTURE_THREAD.family, status: 'started', at: 1 })
    const cacheFile = path.join(first.dir, 'mail-cache.db')
    first.module.cache!.close()
    const { socket, send } = await setup({ cacheFile })
    const asker = socket('a')
    await asker.send({ ...sendFamily, requestId: 's1' })
    expect(asker.replies.at(-1)).toMatchObject({ requestId: 's1', ok: false, message: expect.stringContaining('Check Sent') })
    expect((send as RecordingOutboundSend).sent).toEqual([])
    await asker.send({ ...sendFamily, requestId: 's2' })
    expect(asker.replies.at(-1)).toMatchObject({ requestId: 's2', ok: true })
  })

  it('one send per thread at a time', async () => {
    let release = () => {}
    const port = new SilentPort(() => new Promise((resolve) => { release = () => resolve({ ok: true, delivery: 'delivered' }) }))
    const { socket } = await setup({ send: port })
    const asker = socket('a')
    const first = asker.send({ ...sendFamily, requestId: 's1' })
    await vi.waitFor(() => expect(port.sent).toHaveLength(1))
    await asker.send({ ...sendFamily, requestId: 's2' })
    expect(asker.replies.at(-1)).toMatchObject({ requestId: 's2', ok: false, message: expect.stringContaining('already on its way') })
    release()
    await first
    expect(asker.replies.at(-1)).toEqual({ type: 'mail_result', requestId: 's1', ok: true })
  })

  it('completes through the spike\'s mock Composio port: the fixture account is the one it reports', async () => {
    const { socket } = await setup({ send: createMockOutboundSendPort(mockComposio(0).outbound) })
    const asker = socket('a')
    await asker.send({ type: 'mail_send', requestId: 's1', threadId: FIXTURE_THREAD.interview, to: 'nora@talent.example', body: 'Thursday works.' })
    expect(asker.replies.at(-1)).toEqual({ type: 'mail_result', requestId: 's1', ok: true })
  })

  it('a recipient outside the thread is reported by mailNewRecipients', async () => {
    const { module } = await setup()
    const thread: MailThread = await module.openThread(FIXTURE_THREAD.interview)
    expect(mailNewRecipients(thread, thread.reply.to, thread.reply.cc)).toEqual([])
    expect(mailNewRecipients(thread, 'Nora <NORA@talent.example>, stranger@else.example', 'not an address')).toEqual(['stranger@else.example', 'not an address'])
  })
})
