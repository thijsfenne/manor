import { COMPLETION_NOTICE_FLOOR_MS, type AgentConfig, type Chat, type ThreadEvent, type UserInputQuestion } from '@manor/contracts'
import { z } from 'zod'
import { NEW_CHAT_TITLE } from './chatTitle.js'
import type { DesktopPresence } from './desktopPresence.js'
import type { Store } from './store.js'

export const PUSH_NOTICE_FLOOR_MS = COMPLETION_NOTICE_FLOOR_MS
const PUSH_BATCH_SIZE = 100
const PUSH_PREVIEW_LINES = 3
const PUSH_PREVIEW_CHARS = 240
const RECEIPT_DELAY_MS = 15 * 60_000
const SEND_URL = 'https://exp.host/--/api/v2/push/send'
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts'

const PushResultSchema = z.object({
  data: z.array(z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), id: z.string() }),
    z.object({
      status: z.literal('error'),
      message: z.string(),
      details: z.object({ error: z.string().optional() }).optional(),
    }),
  ])),
})

const ReceiptResultSchema = z.object({
  data: z.record(z.string(), z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok') }),
    z.object({
      status: z.literal('error'),
      message: z.string().optional(),
      details: z.object({ error: z.string().optional() }).optional(),
    }),
  ])),
})

type Fetch = typeof fetch
type Schedule = (run: () => void, delay: number) => void

export interface PushNotifierOptions {
  store: Store
  agents: () => readonly AgentConfig[]
  fetch?: Fetch
  now?: () => number
  schedule?: Schedule
  onError?: (error: unknown) => void
  /** While the Mac reports the user at it, the desktop banner is enough and the phone stays quiet. */
  presence?: Pick<DesktopPresence, 'status'>
  /** One line per push decision, sent or held back; the trace for checking it on a real phone. */
  log?: (line: string) => void
}

export interface PushNotifier {
  /**
   * `alert` skips the completion floor: a one-time routine's result is news however
   * quickly it came, because nobody watched it start.
   */
  notifyChatFinished(chatId: string, startedAt: number, options?: { alert?: boolean }): Promise<void>
  /**
   * A persona is blocked on the user: an ask card or a permission card. No floor, since
   * the turn cannot go on without them, however quickly it got there.
   */
  notifyAwaitingInput(chatId: string, agentId: string, questions: readonly UserInputQuestion[]): Promise<void>
  /** A host problem with no chat behind it; tapping it opens Manor on its home. */
  notifyHost(title: string, body: string): Promise<void>
}

interface PushNotice {
  chatId?: string
  title: string
  body: string
}

/**
 * Server-owned native completion notices.
 *
 * Unlike the desktop banner, a push cannot depend on a renderer having witnessed
 * the start: the phone may be suspended or closed, which is exactly when it needs
 * the server to speak. The shared rules remain the same — one completed exchange,
 * no settled chat, and no fast answer that was over before the user could leave it.
 */
export function createPushNotifier(options: PushNotifierOptions): PushNotifier {
  const request = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? ((run, delay) => {
    const timer = setTimeout(run, delay)
    timer.unref?.()
  })
  const report = options.onError ?? ((error: unknown) => console.warn('manor: mobile push failed', error))
  const log = options.log ?? ((line: string) => console.info(line))

  /**
   * The gate every phone push passes: once before the transcript is read, so a quiet
   * Mac costs nothing, and once more just before the request, because the Mac can start
   * reporting while the notice loads. Held back only on a fresh `active` report; never
   * reported, away and stale all send, so the phone is the default and the Mac has to
   * keep earning the silence. The final pass logs the decision before Expo is asked, so
   * a failed request still leaves its line.
   */
  const allowed = (kind: string, target: string, devices: number, final: boolean): boolean => {
    const status = options.presence?.status() ?? { active: false, why: 'never reported' as const }
    const base = `[manor] push kind=${kind} ${target} devices=${devices}`
    if (status.active) {
      log(`${base} skipped: mac active, last beat ${Math.round(status.ageMs / 1000)}s ago`)
      return false
    }
    if (final) log(`${base} sending: mac ${status.why}`)
    return true
  }

  const remove = async (token: string) => {
    try {
      await options.store.deletePushToken(token)
    } catch (error) {
      report(error)
    }
  }

  const receipts = async (tickets: Map<string, string>) => {
    const response = await request(RECEIPTS_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...tickets.keys()] }),
    })
    if (!response.ok) throw new Error(`Expo receipts answered ${response.status}`)
    const result = ReceiptResultSchema.parse(await response.json())
    for (const [id, receipt] of Object.entries(result.data)) {
      if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
        const token = tickets.get(id)
        if (token !== undefined) await remove(token)
      } else if (receipt.status === 'error') {
        report(new Error(receipt.message ?? receipt.details?.error ?? 'Expo rejected a push receipt'))
      }
    }
  }

  const deliver = async (notice: PushNotice, tokens: readonly string[]) => {
    for (let at = 0; at < tokens.length; at += PUSH_BATCH_SIZE) {
      const batch = tokens.slice(at, at + PUSH_BATCH_SIZE)
      const response = await request(SEND_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(batch.map((token) => ({
          to: token,
          sound: 'default',
          title: notice.title,
          body: notice.body,
          data: notice.chatId === undefined ? {} : { chatId: notice.chatId },
          threadId: notice.chatId,
        }))),
      })
      if (!response.ok) throw new Error(`Expo push answered ${response.status}`)
      const result = PushResultSchema.parse(await response.json())
      const pending = new Map<string, string>()
      for (const [index, ticket] of result.data.entries()) {
        const token = batch[index]
        if (token === undefined) continue
        if (ticket.status === 'ok') pending.set(ticket.id, token)
        else if (ticket.details?.error === 'DeviceNotRegistered') await remove(token)
        else report(new Error(ticket.message))
      }
      if (pending.size > 0) {
        schedule(() => {
          void receipts(pending).catch(report)
        }, RECEIPT_DELAY_MS)
      }
    }
  }

  return {
    async notifyChatFinished(chatId, startedAt, finish) {
      if (finish?.alert !== true && now() - startedAt < PUSH_NOTICE_FLOOR_MS) return
      const tokens = await options.store.listPushTokens()
      // Until a phone opts in, completion adds no transcript read to every turn.
      if (tokens.length === 0) return
      const target = `chat=${chatId}`
      if (!allowed('chat-finished', target, tokens.length, false)) return
      const notice = await completionNotice(options.store, options.agents(), chatId, startedAt)
      if (notice === null || !allowed('chat-finished', target, tokens.length, true)) return
      await deliver(notice, tokens)
    },
    async notifyAwaitingInput(chatId, agentId, questions) {
      const tokens = await options.store.listPushTokens()
      if (tokens.length === 0) return
      const target = `chat=${chatId}`
      if (!allowed('awaiting-input', target, tokens.length, false)) return
      const notice = await awaitingInputNotice(options.store, options.agents(), chatId, agentId, questions)
      if (notice === null || !allowed('awaiting-input', target, tokens.length, true)) return
      await deliver(notice, tokens)
    },
    async notifyHost(title, body) {
      const tokens = await options.store.listPushTokens()
      if (tokens.length === 0) return
      if (!allowed('host-notice', 'chat=-', tokens.length, true)) return
      await deliver({ title, body }, tokens)
    },
  }
}

/**
 * Who is waiting and on what, for a card that blocks a turn. The same rooms stay quiet
 * as for a finished turn: a settled chat and a side chat. A permission card reads as a
 * request for approval, because Allow or Deny is the whole answer.
 */
export async function awaitingInputNotice(
  store: Store,
  agents: readonly AgentConfig[],
  chatId: string,
  agentId: string,
  questions: readonly UserInputQuestion[],
): Promise<PushNotice | null> {
  const chat = await store.getChat(chatId)
  const first = questions[0]
  if (chat === undefined || first === undefined || chat.kind === 'side' || chat.settledAt !== null) return null
  const name = agents.find((agent) => agent.id === agentId)?.name ?? 'Manor'
  // Only that one waits: what it is for stays on the card.
  if (first.secret !== undefined) return { chatId, title: speakerIsPlace(chat) ? name : chat.title, body: 'A secret request is waiting' }
  const verb = first.optionsOnly === true ? 'is waiting for your approval' : 'asks'
  const ask = pushPreview(first.question)
  // A child's question is answered in the chat that started it, so the notice opens there.
  if (chat.kind === 'subagent') {
    let root = chat
    while (root.kind === 'subagent' && root.parentChatId !== null) {
      const parent = await store.getChat(root.parentChatId)
      if (parent === undefined) return null
      root = parent
    }
    return root.settledAt !== null ? null : { chatId: root.id, title: root.title, body: `${chat.title} ${verb}: ${ask}` }
  }
  return speakerIsPlace(chat)
    ? { chatId, title: name, body: `${verb[0]!.toUpperCase()}${verb.slice(1)}: ${ask}` }
    : { chatId, title: chat.title, body: `${name} ${verb}: ${ask}` }
}

/** A dm, or a chat still without a real title, is named by who speaks rather than where. */
const speakerIsPlace = (chat: Chat) =>
  chat.kind === 'dm' || (chat.kind !== 'run' && (chat.title.trim() === '' || chat.title === NEW_CHAT_TITLE))

/** The latest speaker and enough of their answer to judge whether to open Manor. */
export async function completionNotice(
  store: Store,
  agents: readonly AgentConfig[],
  chatId: string,
  startedAt: number,
): Promise<PushNotice | null> {
  const chat = await store.getChat(chatId)
  if (chat === undefined || chat.kind === 'side' || chat.settledAt !== null) return null

  const events = await store.loadEvents(chatId)
  const result = events.filter((event) => event.type === 'turn_result' && event.ts >= startedAt).at(-1)
  if (result?.type === 'turn_result' && (result.routineOutcome === 'quiet' || result.quiet === true)) return null
  const latest = latestReply(events, startedAt)
  const nameOf = (agentId: string | undefined) =>
    agentId === undefined ? undefined : agents.find((agent) => agent.id === agentId)?.name
  const speaker = nameOf(latest?.agentId) ?? (chat.kind === 'dm' ? nameOf(chat.memberIds[0]) : undefined)
  const name = speaker ?? 'Manor'
  const preview = latest === undefined
    ? chat.kind === 'run' ? 'Tap to open the result.' : 'The turn has ended.'
    : pushPreview(latest.text)
  return speakerIsPlace(chat)
    ? { chatId, title: name, body: preview }
    : { chatId, title: chat.title, body: `${name}: ${preview}` }
}

/** Push providers render plain text; keep at most three source lines and 240 chars. */
export function pushPreview(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const selected = lines.slice(0, PUSH_PREVIEW_LINES).join('\n')
  if (selected === '') return 'Replied.'
  const truncated = lines.length > PUSH_PREVIEW_LINES || selected.length > PUSH_PREVIEW_CHARS
  if (!truncated) return selected
  return `${selected.slice(0, PUSH_PREVIEW_CHARS - 1).trimEnd()}…`
}

function latestReply(events: readonly ThreadEvent[], startedAt: number) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.ts !== undefined && event.ts < startedAt) break
    if (event?.type === 'agent_message') return event
  }
  return undefined
}
