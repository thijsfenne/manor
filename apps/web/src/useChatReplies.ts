import { useCallback, useState } from 'react'
import type { MessageReply } from '@manor/contracts'

/**
 * The reply a chat's composer carries beside the typed text. Held per chat above the
 * panes, so a pane that remounts (a split closing, the Browser place) keeps it.
 */
export function useChatReplies() {
  const [byChat, setByChat] = useState<Record<string, MessageReply>>({})
  const of = (chatId: string): MessageReply | undefined => byChat[chatId]
  const set = useCallback((chatId: string, reply: MessageReply) => {
    setByChat((current) => ({ ...current, [chatId]: reply }))
  }, [])
  /** A send clears what rode along with it. */
  const clear = useCallback((chatId: string) => {
    setByChat((current) => {
      if (current[chatId] === undefined) return current
      const { [chatId]: _sent, ...rest } = current
      return rest
    })
  }, [])
  return { of, set, clear }
}
