import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { SecretDestinationSchema, type UserInputQuestion } from '@manor/contracts'
import { z } from 'zod'
import { childProcessEnv } from './childEnv.js'
import { isSignallableGroupPid, terminateCliTree } from './drivers/childTermination.js'
import type { InteractionBroker } from './interactionBroker.js'
import type { UserInputContext } from './interactionCapability.js'

/** How long a card waits for the user. Nothing is held meanwhile; this only frees the turn. */
export const SECRET_REQUEST_TIMEOUT_MS = 10 * 60_000
/** A command that still runs after this is stopped, value and all. */
const SECRET_COMMAND_TIMEOUT_MS = 5 * 60_000
const SECRET_OUTPUT_CHARS = 20_000
const HIDDEN = '[secret hidden]'

export const POSTED_SECRET_NOTE =
  'Your request is on the card. End your turn now with one short line saying you are waiting. The result arrives as your next message. Never ask for this value in chat.'

const SEALED_NOTE = 'The field is filled. You can click on this page, but cannot read it or any page it leads to. To read again, use browser_navigate to a new address on the site.'

const DECLINED = {
  status: 'declined',
  note: "The user declined. Do not ask for it in chat or any other way. Say what is blocked and go on without it.",
}
const TIMED_OUT = {
  status: 'timed_out',
  note: 'No answer in time, so the card closed. Do not ask in chat. Call request_secret again only if it is still needed.',
}

export const SecretRequestInputSchema = z.object({
  label: z.string().trim().min(1).max(80),
  reason: z.string().trim().min(1).max(1_000),
  target: z.enum(['command', 'browser']),
  command: z.string().min(1).max(4_000).optional(),
  env: z.string().optional(),
})
export type SecretRequestInput = z.infer<typeof SecretRequestInputSchema>

/** What the agent hears and the outcome label the transcript keeps. Neither ever holds the value. */
interface Delivered {
  outcome: string
  result: Record<string, unknown>
}

type Delivery = (value: string, signal: AbortSignal) => Promise<Delivered>

interface OpenSecret {
  turnId: string
  deliver: Delivery
  timer: ReturnType<typeof setTimeout>
  /** Set while the value is at its destination, so Stop can end that too. */
  abort?: AbortController
}

/** The page a browser card fills; bound when the card goes up, checked again at the fill. */
export interface SecretPage {
  site: string
  fill: (value: string) => Promise<void>
}

export interface SecretRequestDeps {
  interactions: Pick<InteractionBroker, 'ask' | 'post' | 'claimSecret' | 'closeSecret'>
  /** The password step open in this turn's browser. Throws a line the agent can act on. */
  passwordPage: (context: UserInputContext) => Promise<SecretPage>
  timeoutMs?: number
  commandTimeoutMs?: number
}

/**
 * Secret cards. The value crosses this class once, from the user's submit to the destination
 * the card showed them: nothing stores it, so a restart, a decline or a closed turn leaves
 * nothing to clean. The agent names the destination up front and gets only the outcome,
 * which is why there is no ref or file for it to hold on to.
 */
export class SecretRequests {
  private readonly open = new Map<string, OpenSecret>()

  constructor(private readonly deps: SecretRequestDeps) {}

  /** Puts the card up. Held, this returns the result; posted, the result reaches the next attempt. */
  async request(context: UserInputContext, input: SecretRequestInput, posted: boolean): Promise<string> {
    if (context.canApprove === false) throw new Error('Nobody is here to enter a secret in this turn.')
    const { secret, deliver } = await this.prepare(context, input)
    const requestId = randomUUID()
    const question: UserInputQuestion = {
      id: 'secret',
      header: input.label,
      question: input.reason,
      options: [{ label: 'Enter it' }, { label: 'Decline' }],
      optionsOnly: true,
      desktopOnly: true,
      secret,
    }
    const timer = setTimeout(() => void this.expire(requestId), this.deps.timeoutMs ?? SECRET_REQUEST_TIMEOUT_MS)
    timer.unref?.()
    this.open.set(requestId, { turnId: context.turnId, deliver, timer })
    try {
      if (posted) {
        await this.deps.interactions.post(context, [question], requestId)
        return POSTED_SECRET_NOTE
      }
      return (await this.deps.interactions.ask(context, [question], requestId)).toolResult ?? JSON.stringify({ status: 'failed' })
    } catch (error: unknown) {
      this.drop(requestId)
      throw error
    } finally {
      if (!posted) this.drop(requestId)
    }
  }

  /**
   * The user's answer: a value goes to its destination, no value declines. False when this
   * card is gone, which after a restart is every card. Returns before the work ends: a
   * five-minute command must not hold the socket that delivered it.
   */
  answer(chatId: string, requestId: string, value: string | undefined): boolean {
    const open = this.open.get(requestId)
    if (open === undefined || !this.deps.interactions.claimSecret(chatId, requestId)) return false
    clearTimeout(open.timer)
    void this.finish(requestId, open, value)
    return true
  }

  /** The turn ended: its cards close, and a value still at work stops there. */
  closeTurn(turnId: string): void {
    for (const [requestId, open] of this.open) {
      if (open.turnId !== turnId) continue
      open.abort?.abort()
      this.drop(requestId)
    }
  }

  private async prepare(context: UserInputContext, input: SecretRequestInput): Promise<{ secret: UserInputQuestion['secret']; deliver: Delivery }> {
    if (input.target === 'browser') {
      const page = await this.deps.passwordPage(context)
      return {
        secret: { target: 'browser', site: page.site },
        deliver: async (value) => {
          await page.fill(value)
          return { outcome: 'Used once', result: { status: 'used', site: page.site, note: SEALED_NOTE } }
        },
      }
    }
    if (context.commandCwd === undefined) throw new Error('This turn has no shell, so a secret cannot go to a command here.')
    const destination = SecretDestinationSchema.safeParse({ target: 'command', command: input.command, env: input.env })
    if (!destination.success || destination.data.target !== 'command') {
      throw new Error('A command secret needs the command and an env name in capitals, such as GH_TOKEN.')
    }
    const { command, env } = destination.data
    const cwd = context.commandCwd
    return {
      secret: destination.data,
      deliver: async (value, signal) => {
        const ran = await runWithSecret({ command, env, cwd, value, signal, timeoutMs: this.deps.commandTimeoutMs ?? SECRET_COMMAND_TIMEOUT_MS })
        return { outcome: 'Used once', result: { status: 'used', ...ran } }
      },
    }
  }

  private async finish(requestId: string, open: OpenSecret, value: string | undefined): Promise<void> {
    let delivered: Delivered = { outcome: 'Declined', result: DECLINED }
    if (value !== undefined) {
      const abort = new AbortController()
      open.abort = abort
      try {
        delivered = await open.deliver(value, abort.signal)
      } catch (error: unknown) {
        delivered = {
          outcome: 'Not delivered',
          result: {
            status: 'failed',
            // Every thrower here writes a fixed line, but this one still crosses to the model.
            reason: secretScrubber(value)(error instanceof Error ? error.message : 'The value could not be delivered.'),
            note: 'Manor kept nothing, so the user would have to enter it again on a new card.',
          },
        }
      }
    }
    await this.deps.interactions.closeSecret(requestId, delivered.outcome, JSON.stringify(delivered.result))
    if (this.open.get(requestId) === open) this.open.delete(requestId)
  }

  private async expire(requestId: string): Promise<void> {
    const open = this.open.get(requestId)
    if (open === undefined) return
    this.open.delete(requestId)
    await this.deps.interactions.closeSecret(requestId, 'Timed out', JSON.stringify(TIMED_OUT))
  }

  private drop(requestId: string): void {
    const open = this.open.get(requestId)
    if (open === undefined) return
    clearTimeout(open.timer)
    this.open.delete(requestId)
  }
}

/** Blanks the value from text the agent will read: as is, and in the common encodings a tool prints. */
export function secretScrubber(value: string): (text: string) => string {
  const forms = secretForms(value)
  return (text) => forms.reduce((scrubbed, form) => scrubbed.replaceAll(form, HIDDEN), text)
}

/** Longest first, so a shorter form inside a longer one cannot break its match. */
function secretForms(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8')
  return [...new Set([value, encodeURIComponent(value), bytes.toString('base64'), bytes.toString('base64url')])]
    .sort((left, right) => right.length - left.length)
}

/**
 * Runs one command with the value in one environment variable of that child alone, which
 * neither `ps` arguments nor a temp file would give. Output reaches the agent scrubbed, and
 * whatever the command left running in its process group dies with it, value and all.
 */
export function runWithSecret({ command, env, cwd, value, signal, timeoutMs }: {
  command: string
  env: string
  cwd: string
  value: string
  signal: AbortSignal
  timeoutMs: number
}): Promise<{ exitCode: number | null; output: string; timedOut?: true }> {
  const scrub = secretScrubber(value)
  // Blanked text only: the last stretch waits for the next chunk, which may finish a form.
  const undecided = (secretForms(value)[0]?.length ?? 1) - 1
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: childProcessEnv(process.env, [], { [env]: value }),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let output = ''
    let open = ''
    let timedOut = false
    const collect = (chunk: string) => {
      const text = scrub(open + chunk)
      const settled = Math.max(0, text.length - undecided)
      output = (output + text.slice(0, settled)).slice(-SECRET_OUTPUT_CHARS)
      open = text.slice(settled)
    }
    child.stdout.setEncoding('utf8').on('data', collect)
    child.stderr.setEncoding('utf8').on('data', collect)
    const stop = () => void terminateCliTree(child)
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    timer.unref?.()
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
    }
    child.on('error', (error) => {
      done()
      reject(error)
    })
    child.on('close', (exitCode) => {
      done()
      if (isSignallableGroupPid(child.pid)) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* Nothing was left running. */ }
      }
      resolve({ exitCode, output: (output + open).slice(-SECRET_OUTPUT_CHARS), ...(timedOut ? { timedOut: true as const } : {}) })
    })
  })
}
