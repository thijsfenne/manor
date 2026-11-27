import { randomUUID } from 'node:crypto'
import {
  MAIL_DRAFT_BODY_MAX,
  driverForModel,
  type AgentConfig,
  type ClientMessage,
  type Driver,
  type Effort,
  type MailThread,
  type ServerMessage,
  type TurnHandle,
  type TurnInput,
} from '@manor/contracts'
import { MAIL_DRAFT_THREAD_PREFIX, mailDraftPrompt, type MailCalendar } from './mailPrompt.js'
import { CALENDAR_ENV_KEYS, addDays, dateKey, wallTime } from './mcp/calendarCreate.js'
import { fetchOccurrences } from './mcp/calendarDav.js'
import { parseRange } from './mcp/calendarRead.js'
import type { MemoryTarget } from './memoryTarget.js'
import { composeStandingContextBundle } from './standingContext.js'

/** A reply is a short text; a turn still open after this is stopped and the pane says so. */
export const MAIL_DRAFT_TURN_MS = 3 * 60_000
/**
 * A calendar read slower than this is dropped, and the draft is written without it.
 * Long enough for a first read, which signs in and finds the calendars before it fetches.
 */
export const MAIL_CALENDAR_WAIT_MS = 8_000
/** Days of calendar a draft is handed, today included. */
export const MAIL_CALENDAR_DAYS = 42

/** What the Mail door needs to run the default agent; absent in a test that runs no turn. */
export interface MailAgentRuntime {
  agents: () => readonly AgentConfig[]
  resolveDriver: (agent: AgentConfig) => Driver
  ensureScratchDir: (threadId: string) => Promise<string>
  /** The user's calendar for a draft; undefined where none is configured. Absent reads none. */
  calendar?: () => Promise<MailCalendar | undefined>
  /** Where the standing files live, read for a draft when the default agent has memory on. */
  memoryTarget?: MemoryTarget
  /** The house's model for drafts, from Settings. The triage run ignores it. */
  draftModel?: () => MailDraftModel
}

/** Null fields are the default agent's own; a model in `disabledModels` is not used. */
export interface MailDraftModel {
  model: string | null
  effort: Effort | null
  disabledModels: readonly string[]
}

/**
 * The user's iCloud calendar from today 00:00 in Amsterdam for `MAIL_CALENDAR_DAYS`
 * days, for a draft. Undefined without both credentials, before any network is touched.
 * A failed read throws a `safeCalDavError`, which quotes no CalDAV body.
 */
export async function readMailCalendar(now = Date.now()): Promise<MailCalendar | undefined> {
  if (CALENDAR_ENV_KEYS.some((key) => !process.env[key])) return undefined
  const from = dateKey(wallTime(now))
  const to = addDays(from, MAIL_CALENDAR_DAYS - 1)
  return { from, to, events: await fetchOccurrences(parseRange(from, to, MAIL_CALENDAR_DAYS)) }
}

/** The calendar for one draft, or none: a failed or slow read leaves the draft as it was before calendars. */
async function draftCalendar(read: MailAgentRuntime['calendar']): Promise<MailCalendar | undefined> {
  if (read === undefined) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read(),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), MAIL_CALENDAR_WAIT_MS) }),
    ])
  } catch {
    console.warn('[manor] the calendar could not be read for a mail draft; drafting without it')
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** The standing files for one draft, only for a default agent with memory on; empty when there are none or they cannot be read. */
async function draftMemory(agent: AgentConfig, target: MemoryTarget | undefined): Promise<string> {
  if (!agent.memoryScope || target === undefined) return ''
  return (await composeStandingContextBundle(target, []).catch(() => undefined))?.text ?? ''
}

/**
 * The default agent as a draft runs it: on the house's draft model when one is set,
 * known and not turned off in Settings, in its own character either way.
 */
export function mailDraftAgent(agent: AgentConfig, pick: MailDraftModel | undefined): AgentConfig {
  if (pick?.model == null || pick.disabledModels.includes(pick.model)) return agent
  const driver = driverForModel(pick.model)
  return driver === undefined ? agent : { ...agent, driver, model: pick.model, effort: pick.effort ?? agent.effort }
}

/**
 * The default agent as a mail turn runs it: its runtime, model and effort (a draft's
 * may come from `mailDraftAgent`) and its own character, so the text sounds like it,
 * and nothing that grants a tool or memory.
 */
export function mailTurnAgent(agent: AgentConfig): AgentConfig {
  return { ...agent, allowedTools: [], mcpServers: [], skillIds: [], memoryScope: false, mentionAllowlist: [] }
}

export const mailDefaultAgent = (runtime: MailAgentRuntime): AgentConfig | undefined => runtime.agents().find((agent) => agent.isCos)

const reason = (error: unknown, fallback: string) => (error instanceof Error && error.message !== '' ? error.message : fallback)

type DraftStart = Extract<ClientMessage, { type: 'mail_draft_start' }>

interface RunningDraft {
  draftId: string
  handle?: TurnHandle
  stopped: boolean
}

interface MailDraftsOptions {
  runtime?: MailAgentRuntime
  /** The mailbox's own address, which the reply is sent from. */
  account: () => string
  /** The plain-text thread, from the cache when it holds it. */
  thread: (threadId: string) => Promise<MailThread>
}

/**
 * Reply drafts, one per socket. A draft streams to the socket that asked and to no
 * other, as whole-text `mail_draft` frames. A stop, a new start from the same socket
 * or the socket closing ends the running turn. The turn has no tools, writes no
 * transcript and no memory, and sends nothing: the user's Send is a separate click.
 * It is handed one prompt, which may carry the user's calendar and standing files as
 * text that Manor read before the turn, never a way to read them itself.
 */
export class MailDrafts {
  /** Keyed by the socket's own reply function, the same object for every message of one socket. */
  private readonly running = new Map<object, RunningDraft>()

  constructor(private readonly options: MailDraftsOptions) {}

  async start(socket: object, message: DraftStart, reply: (message: ServerMessage) => void): Promise<void> {
    this.closeSocket(socket)
    const run: RunningDraft = { draftId: message.draftId, stopped: false }
    this.running.set(socket, run)
    const frame = (status: 'streaming' | 'done' | 'error', text: string, why?: string) => {
      if (run.stopped) return
      reply({
        type: 'mail_draft',
        draftId: message.draftId,
        threadId: message.threadId,
        status,
        text: text.slice(0, MAIL_DRAFT_BODY_MAX),
        ...(why === undefined ? {} : { message: why.slice(0, 400) }),
      })
    }
    try {
      const { runtime } = this.options
      if (runtime === undefined) throw new Error('Drafting a reply is not available on this Manor.')
      const agent = mailDefaultAgent(runtime)
      if (agent === undefined) throw new Error('There is no default agent to write the draft.')
      // Memory follows the agent's own switch, read before the turn agent clears it.
      const [thread, calendar, memory] = await Promise.all([
        this.options.thread(message.threadId),
        draftCalendar(runtime.calendar),
        draftMemory(agent, runtime.memoryTarget),
      ])
      const threadId = `${MAIL_DRAFT_THREAD_PREFIX}${randomUUID()}`
      const cwd = await runtime.ensureScratchDir(threadId)
      if (run.stopped) return
      const instruction = message.instruction?.trim() ?? ''
      const prompt = mailDraftPrompt(
        thread,
        this.options.account(),
        instruction === '' ? undefined : { instruction, current: message.current ?? '' },
        { now: Date.now(), ...(calendar === undefined ? {} : { calendar }), memory },
      )
      const input = mailDraftTurnInput(mailDraftAgent(agent, runtime.draftModel?.()), threadId, cwd, prompt)
      run.handle = runtime.resolveDriver(input.agent).startTurn(input)
      // The newest assistant message is the draft; a turn rarely has more than one.
      let messageId: string | undefined
      let streamed = ''
      let said = ''
      let result = ''
      let failure: string | undefined
      const handle = run.handle
      const timer = setTimeout(() => {
        failure ??= `${agent.name} took too long.`
        handle.stop()
      }, MAIL_DRAFT_TURN_MS)
      try {
        for await (const event of handle.events) {
          if (event.type === 'delta') {
            if (event.messageId !== messageId) streamed = ''
            messageId = event.messageId
            streamed += event.text
            frame('streaming', streamed.trimStart())
          } else if (event.type === 'message') {
            said = event.text
            frame('streaming', said.trimStart())
          } else if (event.type === 'result') result = event.text
          else if (event.type === 'error') failure ??= event.message
        }
      } finally {
        clearTimeout(timer)
      }
      const text = (result || said || streamed).trim()
      if (failure !== undefined) frame('error', text, failure)
      else if (text === '') frame('error', '', `${agent.name} wrote no draft.`)
      else frame('done', text)
    } catch (error: unknown) {
      frame('error', '', reason(error, 'The draft could not be written.'))
    } finally {
      if (this.running.get(socket) === run) this.running.delete(socket)
    }
  }

  /** The client's Stop. Only the socket that started a draft can stop it. */
  stop(socket: object, draftId: string): void {
    if (this.running.get(socket)?.draftId === draftId) this.closeSocket(socket)
  }

  /** Ends the socket's running draft, if any; nothing more is sent for it. */
  closeSocket(socket: object): void {
    const run = this.running.get(socket)
    if (run === undefined) return
    run.stopped = true
    this.running.delete(socket)
    run.handle?.stop()
  }
}

/**
 * The draft turn: a disposable thread with no folders, MCP servers, tool grants, images,
 * skills or memory scope. The prompt is the only thing it is handed; it may carry the
 * user's calendar and standing files as text. `agent` may already run on the house's
 * draft model. What is left is the driver's floor: none on Claude and Grok, a read-only
 * shell without network on Codex, read-only file tools on Cursor. Nothing on any driver
 * can send, write or reach out.
 */
export function mailDraftTurnInput(agent: AgentConfig, threadId: string, cwd: string, prompt: string): TurnInput {
  return {
    agent: mailTurnAgent(agent),
    threadId,
    cwd,
    repoPaths: [],
    mcpServers: [],
    catchUp: [{ id: 'mail_draft_input', ts: Date.now(), type: 'user_message', text: prompt, mentions: [] }],
    isFullCatchUp: true,
    // The mail is an artifact, not a chat reply: no house chat style and no language pin.
    infrastructure: true,
    promptCaching: 'off',
  }
}
