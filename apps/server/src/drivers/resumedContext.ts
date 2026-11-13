import { createHash } from 'node:crypto'
import { VOLATILE_BLOCK_KEYS, type TurnHandle, type TurnInput, type VolatileBlockKey } from '@manor/contracts'

/** A hash no block text produces: the block went out and its delivery is not confirmed. */
const UNCONFIRMED = 'unconfirmed'

interface Delivered {
  /** Hash of the persona, for CLIs that retain startup instructions. */
  character?: string
  blocks: Map<VolatileBlockKey, string>
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

export const blockHeader = (key: VolatileBlockKey): string =>
  `[Manor context: ${key}] This replaces any earlier "${key}" block in this conversation.`
export const blockWithdrawal = (key: VolatileBlockKey): string =>
  `[Manor context: ${key}] Withdrawn. Any earlier "${key}" block in this conversation no longer applies.`

/** One turn's delivery: the text to put before the catch-up, and its confirmation. */
export interface PreparedContext {
  contextBlock: string | undefined
  /** The CLI answered this turn in `sessionId`: what was sent is now in its history. */
  confirm(sessionId: string | undefined): void
  /** No prompt was written this turn (a live session's own wake run): nothing to confirm. */
  skip(): void
  /** The CLI compacted its history this turn: earlier deliveries may be gone. */
  invalidate(): void
  /**
   * Confirms on the turn's result and forgets on a compaction, for drivers whose turn
   * ends in one stream. A stopped or failed turn confirms nothing, so whatever it tried
   * to deliver goes out again next turn: it may or may not be in native history.
   */
  track(handle: TurnHandle, sessionId: string | undefined): TurnHandle
}

/**
 * Per provider session, what of a turn's changing context the CLI already holds, as
 * hashes. Volatile blocks (`TurnInput.volatileBlocks`) go out in the turn's message
 * only when changed since the last confirmed delivery, and a delivered block that is
 * gone this turn is withdrawn by name. A fresh session gets every block; a compaction
 * forgets the session so the next turn resends them all.
 *
 * `retainsCharacter` is for CLIs that keep their startup instructions across a resume
 * (Cursor, Grok): a changed persona goes out whole as an update in the message. Claude
 * and Codex receive the persona natively every turn, so only the blocks travel.
 */
export function createResumedContext(options: { retainsCharacter: boolean }) {
  const delivered = new Map<string, Delivered>()

  const remember = (sessionId: string, next: Delivered) => {
    delivered.delete(sessionId)
    delivered.set(sessionId, next)
    // Only hashes are retained. Eviction or a restart causes one safe resend.
    if (delivered.size > 256) {
      const oldest = delivered.keys().next().value
      if (oldest !== undefined) delivered.delete(oldest)
    }
  }
  const forget = (sessionId: string | undefined) => {
    if (sessionId !== undefined) delivered.delete(sessionId)
  }

  const prepare = (input: TurnInput): PreparedContext => {
    const sessionId = input.sessionId
    const prior = sessionId === undefined ? undefined : delivered.get(sessionId)
    const character = options.retainsCharacter
      ? digest(JSON.stringify([input.agent.id, input.agent.model, input.agent.character]))
      : undefined
    const refresh = character !== undefined && sessionId !== undefined && prior?.character !== character
    const blocks = (input.volatileBlocks ?? []).filter((block) => block.text.trim().length > 0)
    const hashes = new Map(blocks.map((block) => [block.key, digest(block.text)]))
    // A resent persona replaces the instructions the blocks were correcting, so they all follow it.
    const sent = prior === undefined || refresh ? blocks : blocks.filter((block) => prior.blocks.get(block.key) !== hashes.get(block.key))
    // A resumed session Manor holds no record of (a restart, an eviction, a compaction)
    // may carry any block from before, so every absent key is withdrawn by name.
    const withdrawn = sessionId === undefined ? []
      : prior === undefined ? VOLATILE_BLOCK_KEYS.filter((key) => !hashes.has(key))
        : [...prior.blocks.keys()].filter((key) => !hashes.has(key))
    // A failed or stopped turn may still have put its update into native history.
    // Until confirmed, a sent or withdrawn block counts as unknown: it goes out again
    // if present next turn, or is withdrawn again if absent.
    if (prior !== undefined) {
      for (const key of [...sent.map((block) => block.key), ...withdrawn]) prior.blocks.set(key, UNCONFIRMED)
      if (refresh) delete prior.character
    }

    const contextBlock = [
      ...(refresh
        ? [
            '[Manor] Updated persona and working context for this turn. This replaces the previous persona instructions, standing memory and available capabilities. Keep the conversation and completed tool results; apply the current context below.',
            input.agent.character,
            '[Manor] End of updated context.',
          ]
        : []),
      ...withdrawn.map(blockWithdrawal),
      ...sent.map((block) => `${blockHeader(block.key)}\n${block.text}`),
      input.contextBlock ?? '',
    ].filter(Boolean).join('\n\n')

    let skipped = false
    let compacted = false
    const prepared: PreparedContext = {
      contextBlock: contextBlock.length === 0 ? undefined : contextBlock,
      confirm(answered) {
        if (answered === undefined || skipped) return
        if (compacted) {
          forget(answered)
          return
        }
        remember(answered, { ...(character === undefined ? {} : { character }), blocks: new Map(hashes) })
      },
      skip() {
        skipped = true
      },
      invalidate() {
        compacted = true
        forget(sessionId)
      },
      track(handle, resumed) {
        let stopped = false
        const events = async function* () {
          let answered: string | undefined
          let sawResult = false
          for await (const event of handle.events) {
            if (event.type === 'result') {
              sawResult = true
              answered = event.sessionId ?? resumed
            }
            yield event
          }
          if (sawResult && !stopped) prepared.confirm(answered)
        }
        return {
          ...handle,
          events: events(),
          stop() {
            stopped = true
            handle.stop()
          },
        }
      },
    }
    return prepared
  }

  return Object.assign(prepare, { forget })
}
