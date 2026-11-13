import type { AgentConfig, Driver } from '@manor/contracts'
import { INFRASTRUCTURE_COLOR } from './agents.js'

export const NEW_CHAT_TITLE = 'New chat'
/**
 * Haiku 5.5 first: faster than Luna on this short job, on a fraction of the input
 * tokens (measured 2026-10-14). Pinned by id, not by the CLI's `haiku` alias: an
 * unresolvable name is silently swapped for the session default, which would quietly
 * name chats with Opus.
 */
export const CHAT_TITLE_MODEL = 'claude-haiku-5-5'
/** Second choice when Claude cannot answer. */
export const CHAT_TITLE_FALLBACK_MODEL = 'gpt-6-luna'
const TITLE_LIMIT = 64
const WORD_LIMIT = 8

const TITLE_CHARACTER = [
  'Name a chat from its opening user message.',
  'Return only a short subject in the same language as the user.',
  'Use sentence case and three to seven words.',
  'Do not add quotes, labels, markdown, or terminal punctuation.',
].join(' ')

const titleAgent = (runtime: AgentConfig['driver'], model: string): AgentConfig => ({
  id: 'manor-title-writer',
  name: 'Title writer',
  color: INFRASTRUCTURE_COLOR,
  character: TITLE_CHARACTER,
  driver: runtime,
  model,
  allowedTools: [],
  mcpServers: [],
  // Codex pins its own invocation effort; on Claude this is the effort that applies.
  effort: 'low',
  memoryScope: false,
  // No role: this one never reaches a screen, and a job title is only for a screen.
  role: '',
  description: 'Invisible infrastructure for sidebar titles.',
  isCos: false,
})

export type GenerateChatTitle = (chatId: string, openingMessage: string) => Promise<string>

/** One provider to try, in the order the generator receives them. */
export interface ChatTitleAttempt {
  driver: Driver
  runtime: AgentConfig['driver']
  model: string
}

interface ChatTitleGeneratorOptions {
  /**
   * Tried in order until one returns text. Every kind of unavailability the CLIs
   * express (a weekly cap, an overloaded provider, a missing binary, the idle
   * timeout) arrives here as a thrown error or an error event, so the list needs no
   * separate health check to know it should move on.
   */
  /** Walked on every run; `liveAttempts` hands a list that follows what is signed in. */
  attempts: Iterable<ChatTitleAttempt>
  ensureScratchDir: (threadId: string) => Promise<string>
  onError?: (error: unknown, attempt: ChatTitleAttempt) => void
}

/** Generates one disposable title turn through the normal runtime interface. */
export function createChatTitleGenerator({
  attempts,
  ensureScratchDir,
  onError,
}: ChatTitleGeneratorOptions): GenerateChatTitle {
  return async (chatId, openingMessage) => {
    const fallback = fallbackChatTitle(openingMessage)
    for (const attempt of attempts) {
      try {
        return await runTitleTurn(attempt, chatId, openingMessage, fallback, ensureScratchDir)
      } catch (error) {
        onError?.(error, attempt)
      }
    }
    return fallback
  }
}

async function runTitleTurn(
  attempt: ChatTitleAttempt,
  chatId: string,
  openingMessage: string,
  fallback: string,
  ensureScratchDir: (threadId: string) => Promise<string>,
): Promise<string> {
  const threadId = `title_${chatId}`
  const cwd = await ensureScratchDir(threadId)
  const handle = attempt.driver.startTurn({
    agent: titleAgent(attempt.runtime, attempt.model),
    threadId,
    cwd,
    // Naming a chat never touches the project's folders, whatever it has linked.
    repoPaths: [],
    catchUp: [
      {
        id: 'evt_000001',
        ts: Date.now(),
        type: 'user_message',
        text: openingMessage,
        mentions: [],
      },
    ],
    isFullCatchUp: true,
    infrastructure: true,
    promptCaching: 'off',
  })

  let streamed = ''
  let result = ''
  let failure: string | undefined
  for await (const event of handle.events) {
    if (event.type === 'delta') streamed += event.text
    else if (event.type === 'result') result = event.text
    else if (event.type === 'error') failure ??= event.message
  }
  // A silent empty answer is treated as failure too, so an unavailable provider that
  // exits cleanly hands the naming to the next attempt instead of to the fallback.
  const raw = result || streamed
  if (raw.trim().length === 0) throw new Error(failure ?? 'the title turn returned nothing')
  return cleanChatTitle(raw, fallback)
}

/** Mock mode still exercises the rename without spending subscription cap. */
export const generateFallbackChatTitle: GenerateChatTitle = (_chatId, openingMessage) =>
  Promise.resolve(fallbackChatTitle(openingMessage))

export function cleanChatTitle(raw: string, fallback: string): string {
  const line = raw
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0)
  if (line === undefined) return fallback

  const cleaned = line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^(?:chat\s+)?title\s*[:\-]\s*/i, '')
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
    .replace(/[.!?:;,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  return limitTitle(cleaned) || fallback
}

export function fallbackChatTitle(openingMessage: string): string {
  const cleaned = openingMessage
    .replace(/@[\p{L}\p{N}_-]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  return limitTitle(cleaned) || NEW_CHAT_TITLE
}

function limitTitle(value: string): string {
  const words = value.split(' ').filter(Boolean).slice(0, WORD_LIMIT)
  const byWords = words.join(' ')
  if (byWords.length <= TITLE_LIMIT) return byWords
  const clipped = byWords.slice(0, TITLE_LIMIT + 1)
  const boundary = clipped.lastIndexOf(' ')
  return (boundary > 0 ? clipped.slice(0, boundary) : clipped.slice(0, TITLE_LIMIT)).trim()
}
