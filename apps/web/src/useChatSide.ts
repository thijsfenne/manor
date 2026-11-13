import { useCallback, useState } from 'react'
import { MAX_PAGE_CONTEXT_ATTACHMENTS, type Effort, type ImageAttachment, type InlineQuote, type PageContextAttachment } from '@manor/contracts'
import { insertQuoteIntoDraft } from './composerDrafts'
import type { WorkspaceShape } from './state'
import { useSideChat } from './useSideChat'

interface ChatSideInput {
  parentChatId: string | null
  /** Whether the side panel is actually on screen. A closed panel asks for nothing. */
  shown: boolean
  live: boolean
  workspace: WorkspaceShape
  openSideChat: (parentChatId: string, fresh?: boolean) => boolean
  setSideRuntimeOnServer: (chatId: string, model: string, effort: Effort) => boolean
  sendSideMessageOnServer: (
    chatId: string,
    text: string,
    images: { name: string; dataUrl: string }[],
    quotes?: InlineQuote[],
  ) => boolean
}

/**
 * The side panel's own thread and runtime, scoped to its parent conversation.
 */
export function useChatSide({
  parentChatId,
  shown,
  live,
  workspace,
  openSideChat,
  setSideRuntimeOnServer,
  sendSideMessageOnServer,
}: ChatSideInput) {
  /**
   * The panel's own thread, asked for while the chat it is about stays on the stage.
   * Null while that round trip is in flight, which the panel shows as opening.
   */
  const sideChatId = useSideChat({
    parentChatId,
    shown,
    live,
    sideChats: workspace.sideChats,
    openSideChat,
  })
  /** What the panel runs on, as the server resolved it. Absent until the thread lands. */
  const sideRuntime = sideChatId === null ? undefined : workspace.sideRuntimes[sideChatId]
  const setSideRuntime = useCallback(
    (model: string, effort: Effort) => {
      if (sideChatId !== null) setSideRuntimeOnServer(sideChatId, model, effort)
    },
    [sideChatId, setSideRuntimeOnServer],
  )
  // The panel takes no attachments at all, so what the composer hands over is
  // deliberately narrowed here rather than passed on: its promise is a voice with no
  // tools, and a file it cannot read is not a file it should carry.
  const sendSideMessage = useCallback(
    (text: string, attachments: { images: ImageAttachment[] }, quotes?: InlineQuote[]) =>
      sideChatId !== null && sendSideMessageOnServer(sideChatId, text, attachments.images, quotes),
    [sideChatId, sendSideMessageOnServer],
  )

  /** Deletes the panel's thread and opens a new one; the reply swaps the id in. */
  const clearSideChat = useCallback(() => {
    if (parentChatId !== null) openSideChat(parentChatId, true)
  }, [parentChatId, openSideChat])

  return {
    sideChatId,
    clearSideChat,
    sideRuntime,
    setSideRuntime,
    sendSideMessage,
  }
}

/** Draft source attachments are shared by the workspace, independently of panel focus. */
export function usePageContexts() {
  /** Source attachments are draft state. They become durable only when this chat sends. */
  const [pageContextsByChat, setPageContextsByChat] = useState<Record<string, PageContextAttachment[]>>({})

  const addPageContext = useCallback((chatId: string, context: PageContextAttachment) => {
    // A selection is a quote and takes its place in the sentence. Only a whole artifact
    // has no words to put there, and stays a source above the text.
    if (context.kind !== 'artifact') {
      insertQuoteIntoDraft(chatId, { kind: 'page', context })
      return
    }
    setPageContextsByChat((current) => {
      const contexts = current[chatId] ?? []
      // The same source twice is one slot spent on nothing, and now that a source can
      // be aimed at a chat it is not open in, sending the same one again is easy.
      if (contexts.some((staged) => staged.id === context.id)) return current
      if (contexts.length >= MAX_PAGE_CONTEXT_ATTACHMENTS) return current
      return { ...current, [chatId]: [...contexts, context] }
    })
  }, [])

  const removePageContext = useCallback((chatId: string, contextId: string) => {
    setPageContextsByChat((current) => {
      const contexts = current[chatId]?.filter((context) => context.id !== contextId) ?? []
      if (contexts.length === 0) {
        const { [chatId]: _removed, ...rest } = current
        return rest
      }
      return { ...current, [chatId]: contexts }
    })
  }, [])

  const consumePageContexts = useCallback((chatId: string) => {
    setPageContextsByChat((current) => {
      const { [chatId]: _sent, ...rest } = current
      return rest
    })
  }, [])

  return { pageContextsByChat, addPageContext, removePageContext, consumePageContexts }
}
