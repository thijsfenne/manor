import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAIL_INBOX_WINDOW, mailNewRecipients, type AgentConfig, type Driver, type MailThread, type ServerMessage, type TurnInput } from '@manor/contracts'
import { mockComposio } from '../src/composioMarketplacePorts.js'
import { buildArgs as buildClaudeArgs } from '../src/drivers/claudeDriver.js'
import { buildCodexAppServerArgs, buildCodexThreadRequest } from '../src/drivers/codexDriver.js'
import { buildCursorArgs } from '../src/drivers/cursorDriver.js'
import { buildGrokArgs } from '../src/drivers/grokDriver.js'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import { FIXTURE_THREAD, MailFixtureSource } from '../src/mailFixtureSource.js'
import { MAIL_CALENDAR_WAIT_MS, MAIL_DRAFT_TURN_MS, type MailAgentRuntime } from '../src/mailDraft.js'
import { MailModule } from '../src/mailModule.js'
import {
  MAIL_CALENDAR_OPEN,
  MAIL_MEMORY_OPEN,
  MAIL_REVISION_MARK,
  MAIL_UNTRUSTED_CLOSE,
  MAIL_UNTRUSTED_OPEN,
  untrustedMailPayload,
} from '../src/mailPrompt.js'
import type { MailInbox } from '../src/mailSource.js'
import { MAIL_TRIAGE_BATCHES, MAIL_TRIAGE_CLAIM_STALE_MS, mailTriageDue } from '../src/mailTriage.js'
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
function recordingDriver(deltaDelayMs = 0, inner: Driver = createMockDriver({ deltaDelayMs })) {
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
  /** Stands in for the mock driver behind the recorder. */
  driver?: Driver
  /** Stands in for Marlow as the default agent. */
  agent?: AgentConfig
  /** The draft's calendar, memory folder and model. */
  extras?: Pick<MailAgentRuntime, 'calendar' | 'memoryTarget' | 'draftModel'>
} = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'manor-mail-agent-'))
  dirs.push(dir)
  const source = options.source ?? new MailFixtureSource({ now: Date.UTC(2026, 10, 26, 12) })
  const recorder = recordingDriver(options.deltaDelayMs, options.driver)
  const resolved: AgentConfig['driver'][] = []
  const broadcasts: ServerMessage[] = []
  const send = options.send ?? new RecordingOutboundSend()
  const module = new MailModule({
    source,
    cacheFile: options.cacheFile ?? path.join(dir, 'mail-cache.db'),
    projectIds: async () => [],
    broadcast: (message) => broadcasts.push(message),
    ...(options.now === undefined ? {} : { now: options.now }),
    runtime: {
      agents: () => [options.agent ?? marlow],
      resolveDriver: (agent) => {
        resolved.push(agent.driver)
        return recorder.driver
      },
      ensureScratchDir: async (id) => path.join(dir, id),
      ...options.extras,
    },
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
  return { module, source, recorder, resolved, broadcasts, send, socket, lastState, card, dir }
}

const promptOf = (input: TurnInput) => {
  const first = input.catchUp[0]
  return first?.type === 'user_message' ? first.text : ''
}

/** More unlabelled Inbox threads than one triage batch holds. */
function deliverMany(source: MailFixtureSource, count: number) {
  for (let index = 1; index <= count; index += 1) {
    source.deliver({
      threadId: String(1791000000000000000n + BigInt(index)),
      subject: `Order ${index} has shipped`,
      from: { name: 'Shop', address: 'orders@shop.example' },
      text: 'Your order is on its way.',
      at: Date.UTC(2026, 10, 25, 12) - index * 60_000,
    })
  }
}

/**
 * A provider that labels, over the run's real endpoint, the ids `choose` picks from each
 * batch's prompt; answering a string instead ends the turn with that error.
 */
function choosingDriver(choose: (ids: string[], batch: number) => string[] | string): Driver {
  let batch = 0
  return {
    startTurn: (input) => ({
      events: (async function* () {
        batch += 1
        const ids = (untrustedMailPayload(promptOf(input)) as { id: string }[]).map((entry) => entry.id)
        const chosen = choose(ids, batch)
        if (typeof chosen === 'string') {
          yield { type: 'error' as const, message: chosen }
          return
        }
        const tool = input.mcpServers![0]!
        const header = tool.server.httpHeaders![0]!
        for (const id of chosen) {
          await fetch(tool.server.url!, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [header.name]: tool.runtimeEnv![header.envKey]! },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: MAIL_TRIAGE_TOOL, arguments: { id, label: 'fyi', reason: 'Read.' } } }),
          })
        }
        yield { type: 'result' as const, text: 'Done.' }
      })(),
      stop: () => undefined,
    }),
  }
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
    expect(block).toContain(JSON.stringify('Hi,\n\nThursday at 10:00 works for the team lead. Would that suit you? The interview takes about an hour, at our office.\n\nThe route and parking are on our visitor page: https://talent.example/visit\n\nKind regards,\nNora Example'))
    // The newest message has an HTML part; only its text reaches the model.
    expect(initial).not.toMatch(/<div|<a href/)
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

/** A provider that answers at once, so a test on fake timers never waits on the mock's own pacing. */
const instantDriver: Driver = {
  startTurn: () => ({
    events: (async function* () { yield { type: 'result' as const, text: 'Thank you, that works.' } })(),
    stop: () => undefined,
  }),
}

/** A memory folder whose standing files hold one line. */
function memoryFolder(dir: string) {
  mkdirSync(path.join(dir, 'memory', 'daily'), { recursive: true })
  writeFileSync(path.join(dir, 'soul.md'), 'The user signs every mail with a single initial.\n')
  return { dailyDir: path.join(dir, 'memory', 'daily') }
}

const MEETING = {
  from: '2026-11-27',
  to: '2027-01-07',
  events: [{
    title: 'Dentist', calendar: 'Home', allDay: false, start: '2026-12-01T10:00', end: '2026-12-01T11:00',
    startsAt: Date.UTC(2026, 11, 1, 9), endsAt: Date.UTC(2026, 11, 1, 10), reserved: false, transparent: false,
  }],
}

describe('what the draft turn knows about the user', () => {
  const draft = async (options: Parameters<typeof setup>[0]) => {
    const context = await setup(options)
    const asker = context.socket('a')
    await asker.send({ type: 'mail_draft_start', draftId: 'd1', threadId: FIXTURE_THREAD.interview })
    return { ...context, asker, prompt: promptOf(context.recorder.inputs[0]!), done: asker.frames().at(-1)! }
  }

  it('carries the standing files only when the default agent has memory on, and the turn still gets no memory', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'manor-mail-memory-'))
    dirs.push(dir)
    const memoryTarget = memoryFolder(dir)
    const off = await draft({ extras: { memoryTarget } })
    expect(off.prompt).not.toContain(MAIL_MEMORY_OPEN)
    expect(off.prompt).not.toContain('single initial')
    const on = await draft({ agent: { ...marlow, memoryScope: true }, extras: { memoryTarget } })
    expect(on.prompt).toContain(MAIL_MEMORY_OPEN)
    expect(on.prompt).toContain('The user signs every mail with a single initial.')
    expect(on.prompt.indexOf('single initial')).toBeLessThan(on.prompt.indexOf(MAIL_UNTRUSTED_OPEN))
    expect(toolGrants(on.recorder.inputs[0]!)).toEqual(NO_GRANTS)
    expect(on.done.status).toBe('done')
  })

  it('carries the calendar the reader returns', async () => {
    const { prompt, done } = await draft({ extras: { calendar: async () => MEETING } })
    expect(prompt).toContain(MAIL_CALENDAR_OPEN)
    expect(prompt).toContain('"title":"Dentist"')
    expect(done.status).toBe('done')
  })

  it('writes the draft without a calendar when the reader fails, has none or never answers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      for (const calendar of [() => Promise.reject(new Error('HTTP 401 body')), async () => undefined]) {
        const { prompt, done } = await draft({ extras: { calendar } })
        expect(prompt).not.toContain(MAIL_CALENDAR_OPEN)
        expect(done.status).toBe('done')
      }
      expect(warn.mock.calls.flat().join(' ')).not.toContain('401')
    } finally {
      warn.mockRestore()
    }

    const { socket, recorder } = await setup({ driver: instantDriver, extras: { calendar: () => new Promise(() => undefined) } })
    const asker = socket('a')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const drafted = asker.send({ type: 'mail_draft_start', draftId: 'd1', threadId: FIXTURE_THREAD.interview })
      await vi.advanceTimersByTimeAsync(MAIL_CALENDAR_WAIT_MS - 1)
      expect(recorder.inputs).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      await drafted
    } finally {
      vi.useRealTimers()
    }
    expect(promptOf(recorder.inputs[0]!)).not.toContain(MAIL_CALENDAR_OPEN)
    expect(asker.frames().at(-1)).toMatchObject({ status: 'done', text: 'Thank you, that works.' })
  })

  it('runs on the house\'s draft model in the default agent\'s character, and falls back to its own runtime', async () => {
    const chosen = await draft({ extras: { draftModel: () => ({ model: 'claude-sonnet-5-5', effort: 'low', disabledModels: [] }) } })
    expect(chosen.recorder.inputs[0]!.agent).toMatchObject({ driver: 'claude', model: 'claude-sonnet-5-5', effort: 'low', character: marlow.character })
    expect(chosen.resolved).toEqual(['claude'])

    const ownEffort = await draft({ extras: { draftModel: () => ({ model: 'gpt-6-sol', effort: null, disabledModels: [] }) } })
    expect(ownEffort.recorder.inputs[0]!.agent).toMatchObject({ driver: 'codex', model: 'gpt-6-sol', effort: marlow.effort })

    for (const pick of [
      { model: 'no-such-model', effort: 'low' as const, disabledModels: [] },
      { model: 'claude-sonnet-5-5', effort: 'low' as const, disabledModels: ['claude-sonnet-5-5'] },
      { model: null, effort: 'low' as const, disabledModels: [] },
    ]) {
      const fallback = await draft({ extras: { draftModel: () => pick } })
      const { agent } = fallback.recorder.inputs[0]!
      expect([agent.driver, agent.model, agent.effort]).toEqual([marlow.driver, marlow.model, marlow.effort])
      expect(fallback.resolved).toEqual([marlow.driver])
    }
  })

  it('leaves the triage run on the default agent\'s own model, without calendar or memory', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'manor-mail-memory-'))
    dirs.push(dir)
    const calendar = vi.fn(async () => MEETING)
    const { socket, recorder } = await setup({
      agent: { ...marlow, memoryScope: true },
      extras: { calendar, memoryTarget: memoryFolder(dir), draftModel: () => ({ model: 'claude-sonnet-5-5', effort: 'low', disabledModels: [] }) },
    })
    await socket('a').send({ type: 'mail_triage_run' })
    const [input] = recorder.inputs
    expect([input!.agent.driver, input!.agent.model, input!.agent.effort]).toEqual([marlow.driver, marlow.model, marlow.effort])
    expect(promptOf(input!)).not.toContain(MAIL_CALENDAR_OPEN)
    expect(promptOf(input!)).not.toContain(MAIL_MEMORY_OPEN)
    expect(calendar).not.toHaveBeenCalled()
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
    expect(card(FIXTURE_THREAD.digest)).toMatchObject({ label: 'other', reason: 'A newsletter or notification; nothing needs your attention.' })
    expect(card(FIXTURE_THREAD.newsletter)).toMatchObject({ label: 'other' })
    expect(card(FIXTURE_THREAD.application)).toMatchObject({ label: 'fyi' })
    expect(card(FIXTURE_THREAD.result)).toMatchObject({ label: 'reply' })
    expect(card(FIXTURE_THREAD.receipt)).toMatchObject({ label: 'fyi' })
    expect(card(FIXTURE_THREAD.signUp)).toMatchObject({ label: 'fyi' })
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

  it('works through batch after batch until nothing is unlabelled, polling once, each batch with its own tool mount', async () => {
    const { socket, source, recorder, lastState } = await setup()
    deliverMany(source, 60)
    const list = vi.spyOn(source, 'listInbox')
    await socket('a').send({ type: 'mail_triage_run' })
    expect(recorder.inputs).toHaveLength(3)
    expect(list).toHaveBeenCalledTimes(1)
    expect(lastState().cards).toHaveLength(70)
    expect(lastState().cards.every((entry) => entry.label !== undefined)).toBe(true)
    expect(lastState().triage.error).toBeUndefined()
    // A fresh capability per batch: a turn's capability is unmounted before the next turn starts.
    expect(new Set(recorder.inputs.map((input) => JSON.stringify(input.mcpServers![0]!.runtimeEnv))).size).toBe(3)
  })

  it('offers each thread once per run, so skipped threads never crowd out older ones', async () => {
    const { socket, source, recorder, lastState } = await setup({ driver: choosingDriver((ids) => ids.slice(0, 1)) })
    deliverMany(source, 60)
    await socket('a').send({ type: 'mail_triage_run' })
    expect(MAIL_TRIAGE_BATCHES).toBe(Math.ceil(MAIL_INBOX_WINDOW / 30))
    // 67 threads in batches of 30, one label each: the third batch reaches the oldest.
    expect(recorder.inputs).toHaveLength(3)
    expect(lastState().cards.filter((entry) => entry.label !== undefined)).toHaveLength(3)
    expect(lastState().triage.error).toBeUndefined()
  })

  it('labels new mail when the Mail view looks, and never repeats a run for what one left behind', async () => {
    // The agent labels all but the first thread it is offered.
    const { socket, source, recorder, lastState } = await setup({ driver: choosingDriver((ids) => ids.slice(1)) })
    const look = () => socket('a').send({ type: 'mail_load', refresh: true })
    await look()
    expect(recorder.inputs).toHaveLength(1)
    expect(lastState().cards.filter((entry) => entry.label === undefined)).toHaveLength(1)
    expect(lastState().triage.running).toBe(false)

    // The skipped thread alone starts nothing, however often the view looks.
    await look()
    await look()
    expect(recorder.inputs).toHaveLength(1)

    // New mail does, and the run offers the skipped thread again with it.
    deliverMany(source, 1)
    await look()
    expect(recorder.inputs).toHaveLength(2)
    await look()
    expect(recorder.inputs).toHaveLength(2)

    // A plain load without a poll never starts a run.
    deliverMany(source, 1)
    await socket('a').send({ type: 'mail_load' })
    expect(recorder.inputs).toHaveLength(2)
  })

  it('starts no run on a look whose poll failed', async () => {
    const { socket, source, recorder } = await setup()
    const list = vi.spyOn(source, 'listInbox').mockRejectedValueOnce(new Error('The mail server did not answer.'))
    await socket('a').send({ type: 'mail_load', refresh: true })
    expect(list).toHaveBeenCalledTimes(1)
    expect(recorder.inputs).toHaveLength(0)
    await socket('a').send({ type: 'mail_load', refresh: true })
    expect(recorder.inputs).toHaveLength(1)
  })

  it('does not retry a failed run on the next look', async () => {
    const { socket, recorder, lastState } = await setup({ driver: choosingDriver(() => 'The provider is out of quota.') })
    await socket('a').send({ type: 'mail_load', refresh: true })
    await socket('a').send({ type: 'mail_load', refresh: true })
    expect(recorder.inputs).toHaveLength(1)
    expect(lastState().triage.error).toBe('The provider is out of quota.')
    // The user's own click still runs.
    await socket('a').send({ type: 'mail_triage_run' })
    expect(recorder.inputs).toHaveLength(2)
  })

  it('stops at the first batch that fails or sets no label, and says why', async () => {
    const failing = await setup({ driver: choosingDriver((ids, batch) => (batch === 1 ? ids : 'The provider is out of quota.')) })
    deliverMany(failing.source, 60)
    await failing.socket('a').send({ type: 'mail_triage_run' })
    expect(failing.recorder.inputs).toHaveLength(2)
    expect(failing.lastState().triage.error).toBe('The provider is out of quota.')

    const silent = await setup({ driver: choosingDriver(() => []) })
    await silent.socket('a').send({ type: 'mail_triage_run' })
    expect(silent.recorder.inputs).toHaveLength(1)
    expect(silent.lastState().triage.error).toBe('Marlow set no labels in this run.')
  })

  it('stops at a batch that runs out of time', async () => {
    let started!: () => void
    const running = new Promise<void>((resolve) => { started = resolve })
    const hanging: Driver = {
      startTurn: () => {
        let end!: () => void
        const ended = new Promise<void>((resolve) => { end = resolve })
        return { events: (async function* () { started(); await ended })(), stop: () => end() }
      },
    }
    const { socket, source, recorder, lastState } = await setup({ driver: hanging })
    deliverMany(source, 60)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const run = socket('a').send({ type: 'mail_triage_run' })
      await running
      await vi.advanceTimersByTimeAsync(MAIL_TRIAGE_CLAIM_STALE_MS)
      await run
    } finally {
      vi.useRealTimers()
    }
    expect(recorder.inputs).toHaveLength(1)
    expect(recorder.stops()).toBe(1)
    expect(lastState().triage.error).toBe('Marlow took too long; 0 of 30 mails in the last batch were labelled.')
  })

  it('renews its claim before every batch, so a run longer than the stale time is not taken over', async () => {
    let now = Date.UTC(2026, 10, 26, 12)
    const start = now
    const claims: number[] = []
    const mock = createMockDriver({ deltaDelayMs: 0 })
    let cache: MailModule['cache']
    const slow: Driver = {
      startTurn(input) {
        claims.push((JSON.parse(cache!.getMeta('triageClaim')!) as { at: number }).at)
        now += 6 * 60_000
        return mock.startTurn(input)
      },
    }
    const { socket, source, module, lastState } = await setup({ now: () => now, driver: slow })
    cache = module.cache
    deliverMany(source, 60)
    await socket('a').send({ type: 'mail_triage_run' })
    expect(claims).toEqual([start, start + 6 * 60_000, start + 12 * 60_000])
    expect(now - start).toBeGreaterThan(MAIL_TRIAGE_CLAIM_STALE_MS)
    expect(lastState().cards.every((entry) => entry.label !== undefined)).toBe(true)
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
