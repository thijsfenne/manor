import { z } from 'zod'

/**
 * Emoji reactions in a DM (2026-11-26). The user reacts to an agent's message, the agent
 * reacts to the user's message that started its turn. Each message holds at most one
 * reaction, from the one other party, stored on the message itself and rewritten in place.
 */

/** The quick row offered first on every surface; the fuller picker reaches any emoji. */
export const QUICK_REACTIONS = ['👍', '👎', '❤️', '😂', '🎉'] as const

/**
 * Changing or removing a reaction within this long of placing it starts no turn of its
 * own: only the reaction standing when it runs out is delivered.
 */
export const REACTION_SETTLE_MS = 2_000

/** How much of the reacted message the model is quoted, so it knows which one. */
export const REACTION_EXCERPT_CHARS = 80

// One emoji sequence: a flag pair, a keycap, or a pictograph with its presentation mark
// (a skin tone only on a base that takes one) and tag letters, joined to more of the same
// by zero-width joiners.
const PART = '(?:\\p{Emoji_Modifier_Base}\\p{Emoji_Modifier}|\\p{Extended_Pictographic}\\uFE0F?)[\\u{E0020}-\\u{E007E}]*\\u{E007F}?'
const ONE_EMOJI = new RegExp(`^(?:\\p{Regional_Indicator}{2}|[#*0-9]\\uFE0F?\\u20E3|${PART}(?:\\u200D${PART})*)$`, 'u')

// The longest real sequences (families, subdivision flags) stay well under this.
const MAX_EMOJI_LENGTH = 32

/**
 * Exactly one emoji, joiners, skin tones and flags included; never two, words or digits.
 * The shape is checked, not Unicode's list of defined sequences, so an undefined join
 * passes and renders as its parts.
 */
export const isReactionEmoji = (value: string): boolean => value.length <= MAX_EMOJI_LENGTH && ONE_EMOJI.test(value)

export const ReactionEmojiSchema = z.string().refine(isReactionEmoji, 'a reaction is one emoji')

export const MessageReactionSchema = z.object({
  emoji: ReactionEmojiSchema,
  at: z.number(),
  /** On a user message: the agent that reacted. Absent on an agent message, where the user reacted. */
  agentId: z.string().optional(),
  /** A user reaction the model has been told of, by its own turn, a steer or a context line. */
  seen: z.literal(true).optional(),
})
export type MessageReaction = z.infer<typeof MessageReactionSchema>

/** The user's reaction that a model-only message reports to the agent. */
export const ReactionPromptSchema = z.object({ eventId: z.string(), emoji: ReactionEmojiSchema })

/** The first characters of a message, on one line, for the model's reaction notice. */
export function reactionExcerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= REACTION_EXCERPT_CHARS ? flat : `${flat.slice(0, REACTION_EXCERPT_CHARS - 1).trimEnd()}…`
}
