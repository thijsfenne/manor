import { useEffect, useRef } from 'react'

interface SideChatInput {
  /** The chat the panel hangs off, or null when no chat is on the stage. */
  parentChatId: string | null
  /** Whether the panel is actually on screen. A closed panel asks for nothing. */
  shown: boolean
  /** The socket. Asking while it is down would be a dropped send and a dark panel. */
  live: boolean
  /** What the last `side_chat` reply said, keyed by the chat it hangs off. */
  sideChats: Record<string, string>
  openSideChat: (parentChatId: string) => boolean
}

/**
 * Which thread the side panel is showing, and the one request that gets it there.
 *
 * The panel's thread is created on the server the first time it is asked for and is in
 * no directory afterwards, so this is the only place that asks. Once it exists it stays
 * live on its own — every chat's events are reduced into its thread whether or not
 * anything is showing it — so re-opening the panel or coming back to the chat asks for
 * nothing. A dropped socket is the exception, and the only one: a thread that was on
 * screen through a reconnect missed whatever was said while the socket was down.
 *
 * Hence once per chat per connection, tracked here rather than derived from the
 * workspace: "have I asked on this socket" is this hook's own business, and the
 * workspace cannot tell an answer from a thread that simply has not moved.
 *
 * Null while a first ask is in flight, which the panel shows as opening.
 */
export function useSideChat({ parentChatId, shown, live, sideChats, openSideChat }: SideChatInput) {
  /** How many times the socket has come up. A reconnect is what makes an ask due again. */
  const connection = useRef(0)
  const wasLive = useRef(false)
  if (live && !wasLive.current) connection.current += 1
  wasLive.current = live

  /** The connection each chat's panel was last asked for on. */
  const asked = useRef(new Map<string, number>())
  const generation = connection.current

  useEffect(() => {
    if (!shown || !live || parentChatId === null) return
    if (asked.current.get(parentChatId) === generation) return
    asked.current.set(parentChatId, generation)
    openSideChat(parentChatId)
  }, [shown, live, parentChatId, generation, openSideChat])

  return parentChatId === null ? null : (sideChats[parentChatId] ?? null)
}
