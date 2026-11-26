import type { MessageReaction } from '@manor/contracts'

/** The reaction a pick leaves: the same emoji again takes it off, another replaces it. */
export const reactionAfterPick = (current: MessageReaction | undefined, picked: string): string | null =>
  current?.emoji === picked ? null : picked

/**
 * The fuller picker behind the quick row, the same on desktop and phone. A fixed set kept
 * in the app, so it needs no network and no emoji library, grouped the way people look.
 */
export const REACTION_PALETTE: readonly { name: string; emoji: readonly string[] }[] = [
  {
    name: 'Faces',
    emoji: ['😀', '😄', '😁', '😅', '🤣', '😊', '🙂', '😉', '😍', '🥰', '😘', '😎', '🤩', '🥳', '🤔', '🤨', '😐', '😑', '🙄', '😏', '😬', '😮', '😯', '😲', '🥺', '😢', '😭', '😤', '😡', '🤯', '😱', '🫠', '😴', '🤤', '🤗', '🫡', '🤫', '🤭', '😇', '🤓'],
  },
  {
    name: 'Hands',
    emoji: ['👍', '👎', '👌', '🤌', '✌️', '🤞', '🤝', '🙏', '👏', '🙌', '👋', '💪', '🫶', '👀', '🫵', '☝️'],
  },
  {
    name: 'Hearts',
    emoji: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '❤️‍🔥', '💯', '✨'],
  },
  {
    name: 'Things',
    emoji: ['🎉', '🎊', '🔥', '⭐', '🌟', '⚡', '🚀', '🏆', '🎯', '💡', '📌', '📎', '✅', '❌', '⚠️', '❓', '❗', '⏰', '☕', '🍕', '🍻', '🌈', '☀️', '🌙'],
  },
]
