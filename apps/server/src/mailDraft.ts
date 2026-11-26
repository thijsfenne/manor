import { randomUUID } from 'node:crypto'
import {
  MAIL_DRAFT_BODY_MAX,
  type AgentConfig,
  type ClientMessage,
  type Driver,
  type MailThread,
  type ServerMessage,
  type TurnHandle,
  type TurnInput,
} from '@manor/contracts'
import { MAIL_DRAFT_THREAD_PREFIX, mailDraftPrompt } from './mailPrompt.js'

/** A reply is a short text; a turn still open after this is stopped and the pane says so. */
export const MAIL_DRAFT_TURN_MS = 3 * 60_000

/** What the Mail door needs to run the default agent; absent in a test that runs no turn. */
export interface MailAgentRuntime {
  agents: () => readonly AgentConfig[]
  resolveDriver: (agent: AgentConfig) => Driver
  ensureScratchDir: (threadId: string) => Promise<string>
}

/**
 * The default agent as a mail turn runs it: its own runtime, model, effort and
 * character, so the text sounds like it, and nothing that grants a tool or memory.
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
      const thread = await this.options.thread(message.threadId)
      const threadId = `${MAIL_DRAFT_THREAD_PREFIX}${randomUUID()}`
      const cwd = await runtime.ensureScratchDir(threadId)
      if (run.stopped) return
      const instruction = message.instruction?.trim() ?? ''
      const prompt = mailDraftPrompt(thread, this.options.account(), instruction === '' ? undefined : { instruction, current: message.current ?? '' })
      const input = mailDraftTurnInput(agent, threadId, cwd, prompt)
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
 * skills or memory. The prompt is the only thing it is handed. What is left is the
 * driver's floor: none on Claude and Grok, a read-only shell without network on Codex,
 * read-only file tools on Cursor. Nothing on any driver can send, write or reach out.
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
