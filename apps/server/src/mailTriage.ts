import { randomBytes, randomUUID } from 'node:crypto'
import { MAIL_INBOX_WINDOW, type AgentConfig, type AttachedMcpServer, type TurnInput } from '@manor/contracts'
import { mailDefaultAgent, mailTurnAgent, type MailAgentRuntime } from './mailDraft.js'
import type { MailCache } from './mailCache.js'
import type { MailModule } from './mailModule.js'
import { MAIL_TRIAGE_THREAD_PREFIX, mailTriagePrompt, type MailTriageEntry } from './mailPrompt.js'
import type { McpHttpHost } from './mcp/httpHost.js'
import { toolEndpoint } from './mcp/httpHost.js'
import { MAIL_TRIAGE_CAPABILITY_ENV, mailTriageAttachment, mailTriageToolServer } from './mcp/mailTriageServer.js'

/** The daily run, in host time. */
export const MAIL_TRIAGE_AT = { hour: 7, minute: 30 } as const
/** A claim older than this was left by a server that died mid-run. */
export const MAIL_TRIAGE_CLAIM_STALE_MS = 10 * 60_000
/**
 * One batch's turn. Shorter than the claim, which each batch renews, so a run that is
 * still going never looks abandoned.
 */
const MAIL_TRIAGE_TURN_MS = 8 * 60_000
const MAIL_TRIAGE_BATCH = 30
/** Enough batches for a whole Inbox window: a run offers each thread once. */
export const MAIL_TRIAGE_BATCHES = Math.ceil(MAIL_INBOX_WINDOW / MAIL_TRIAGE_BATCH)
const CLAIM_KEY = 'triageClaim'

/** Where the tool is served: the server's own MCP HTTP host. */
export type MailToolHost = Pick<McpHttpHost, 'serve' | 'unmount'>

/** Today's run time in host time, as milliseconds since the epoch. */
export function mailTriageSlot(now: number): number {
  const slot = new Date(now)
  slot.setHours(MAIL_TRIAGE_AT.hour, MAIL_TRIAGE_AT.minute, 0, 0)
  return slot.getTime()
}

/**
 * Whether the scheduled run is owed: today's 07:30 has passed and no run finished
 * since. A Mac that slept through 07:30 therefore runs on its first tick after waking.
 */
export function mailTriageDue(now: number, lastRunAt: number | null): boolean {
  const slot = mailTriageSlot(now)
  return now >= slot && (lastRunAt === null || lastRunAt < slot)
}

const reason = (error: unknown, fallback: string) => (error instanceof Error && error.message !== '' ? error.message : fallback)

function parseClaim(value: string | undefined): { owner: string; at: number } | undefined {
  if (value === undefined) return undefined
  try {
    const parsed = JSON.parse(value) as { owner?: unknown; at?: unknown }
    return typeof parsed.owner === 'string' && typeof parsed.at === 'number' ? { owner: parsed.owner, at: parsed.at } : undefined
  } catch {
    return undefined
  }
}

interface MailTriageOptions {
  module: Pick<MailModule, 'cache' | 'available' | 'state' | 'refresh' | 'unlabelled' | 'setAgentLabel' | 'setTriageRunning' | 'recordTriageRun' | 'broadcastState'>
  runtime?: MailAgentRuntime
  toolHost?: MailToolHost
  account: () => string
  now: () => number
}

/**
 * The triage run: turns of the default agent over the unlabelled threads, a batch of
 * the newest at a time, each turn with exactly one tool, `mail_set_label`. Daily at
 * 07:30 on the server that runs routines, on demand on any server, and when the open
 * Mail view looks at the mailbox and finds new mail. It labels in
 * Manor's cache only: it sends nothing, archives nothing and changes nothing on the
 * mail server.
 *
 * It is not a routine: a routine turn runs through the orchestrator with the persona's
 * full toolset, which this run must never have.
 */
export class MailTriage {
  /** Names this process in the claim, so two servers on one data folder never both run. */
  private readonly owner = randomUUID()
  private running = false
  /** The threads the last run in this process ended without a label for. */
  private left: ReadonlySet<string> = new Set()

  constructor(private readonly options: MailTriageOptions) {}

  /**
   * The open Mail view just polled the mailbox: runs when that left a thread unlabelled
   * that no run here has ended on. A thread the agent skipped and a run that failed
   * wait for a click or the daily run, so looking again never repeats a turn.
   */
  async look(): Promise<void> {
    const { runtime, toolHost } = this.options
    if (this.running || runtime === undefined || toolHost === undefined || mailDefaultAgent(runtime) === undefined) return
    const waiting = await this.unlabelledThreads()
    if ([...waiting].some((threadId) => !this.left.has(threadId))) await this.run()
  }

  private async unlabelledThreads(): Promise<Set<string>> {
    const { cards } = await this.options.module.state()
    return new Set(cards.filter((card) => card.label === undefined).map((card) => card.threadId))
  }

  /** The schedule's tick: runs when today's run is owed. */
  async tick(): Promise<void> {
    const { cache } = this.options.module
    if (cache === undefined || this.running) return
    if (mailTriageDue(this.options.now(), cache.meta().triageLastRunAt)) await this.run()
  }

  /** One run, unless this process or another server on the same cache file is already running one. */
  async run(): Promise<void> {
    const { module } = this.options
    const { cache } = module
    if (cache === undefined || this.running || !this.claim(cache)) return
    this.running = true
    let error: string | undefined
    try {
      await module.setTriageRunning(true)
      error = await this.label()
    } catch (failure: unknown) {
      error = reason(failure, 'The triage run failed.')
    } finally {
      this.release(module.cache ?? cache)
      // Read before another run may start, so a look right after this one finds nothing new.
      this.left = await this.unlabelledThreads().catch(() => this.left)
      this.running = false
    }
    await module.recordTriageRun(error)
  }

  /** The claim lives in the cache file, which every server on the data folder shares. */
  private claim(cache: MailCache): boolean {
    const now = this.options.now()
    const held = parseClaim(cache.getMeta(CLAIM_KEY))
    if (held !== undefined && held.owner !== this.owner && now - held.at < MAIL_TRIAGE_CLAIM_STALE_MS) return false
    cache.setMeta(CLAIM_KEY, JSON.stringify({ owner: this.owner, at: now }))
    // Read back: of two servers that wrote at once, only the later writer runs.
    return parseClaim(cache.getMeta(CLAIM_KEY))?.owner === this.owner
  }

  private release(cache: MailCache): void {
    try {
      if (parseClaim(cache.getMeta(CLAIM_KEY))?.owner === this.owner) cache.setMeta(CLAIM_KEY, undefined)
    } catch {
      // A cache replaced mid-run holds no claim; a stale one expires on its own.
    }
  }

  /**
   * Polls once, then labels batch after batch, one turn each, until no unlabelled thread
   * is left. Answers why it stopped early, or undefined.
   */
  private async label(): Promise<string | undefined> {
    const { module, runtime, toolHost } = this.options
    if (runtime === undefined || toolHost === undefined) return 'Labelling mail is not available on this Manor.'
    const agent = mailDefaultAgent(runtime)
    if (agent === undefined) return 'There is no default agent to label mail.'
    await module.refresh()
    // A thread the model skips waits for the next run, so it never crowds out an older one.
    const offered = new Set<string>()
    for (let batch = 0; batch < MAIL_TRIAGE_BATCHES; batch += 1) {
      const { cache } = module
      if (cache === undefined) return undefined
      // Each batch renews the claim, so a long run never looks abandoned to another server.
      if (!this.claim(cache)) return 'Another Manor server took over the triage run.'
      const entries: MailTriageEntry[] = (await module.unlabelled(MAIL_TRIAGE_BATCH, offered)).map((entry, index) => ({ id: `m${index + 1}`, ...entry }))
      if (entries.length === 0) return undefined
      for (const entry of entries) offered.add(entry.card.threadId)
      const threads = new Map(entries.map((entry) => [entry.id, entry.card.threadId]))
      const answered = new Set<string>()
      const labeller = (id: string, label: Parameters<MailModule['setAgentLabel']>[1], why: string) => {
        const threadId = threads.get(id)
        if (threadId === undefined) throw new Error(`${id} is not a mail of this run.`)
        answered.add(id)
        if (module.cache?.inboxThread(threadId) === undefined) return `${id} has left the Inbox; nothing was set.`
        if (!module.setAgentLabel(threadId, label, why)) return `The user already labelled ${id}; that label stays.`
        void module.broadcastState().catch(() => undefined)
        return `${id} is labelled ${label}.`
      }
      const capability = randomBytes(32).toString('hex')
      const attached = toolHost.serve(
        mailTriageAttachment(capability),
        MAIL_TRIAGE_CAPABILITY_ENV,
        toolEndpoint(mailTriageToolServer(labeller, entries.length * 2)),
      )
      try {
        const threadId = `${MAIL_TRIAGE_THREAD_PREFIX}${randomUUID()}`
        const cwd = await runtime.ensureScratchDir(threadId)
        const input = mailTriageTurnInput(agent, threadId, cwd, mailTriagePrompt(entries, this.options.account()), attached)
        const handle = runtime.resolveDriver(input.agent).startTurn(input)
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          handle.stop()
        }, MAIL_TRIAGE_TURN_MS)
        let failure: string | undefined
        try {
          for await (const event of handle.events) {
            if (event.type === 'error') failure ??= event.message
          }
        } finally {
          clearTimeout(timer)
        }
        if (timedOut) return `${agent.name} took too long; ${answered.size} of ${entries.length} mails in the last batch were labelled.`
        if (failure !== undefined) return failure
        // A provider that cannot reach the tool ends quietly; that is a failed run, not an empty one.
        if (answered.size === 0) return `${agent.name} set no labels in this run.`
      } finally {
        toolHost.unmount(capability)
      }
    }
    return undefined
  }
}

/**
 * The triage turn: a disposable thread whose only tool is the run's `mail_set_label`
 * endpoint. No folders, no other MCP server, no built-in tools, no skills, no memory.
 */
export function mailTriageTurnInput(agent: AgentConfig, threadId: string, cwd: string, prompt: string, tool: AttachedMcpServer): TurnInput {
  return {
    agent: mailTurnAgent(agent),
    threadId,
    cwd,
    repoPaths: [],
    mcpServers: [tool],
    catchUp: [{ id: 'mail_triage_input', ts: Date.now(), type: 'user_message', text: prompt, mentions: [] }],
    isFullCatchUp: true,
    infrastructure: true,
    promptCaching: 'off',
  }
}
