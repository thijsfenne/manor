import { actionNotice, createNoticeStore } from '@manor/client-runtime/notices'

/**
 * The window's one notice stack. Chat news is pushed by the workspace when the window
 * is focused and the chat is not on screen; anything can confirm a user's action
 * through `toast`. Rendered by `NoticeStack`.
 */
export const noticeStore = createNoticeStore()

/**
 * A short confirmation or refusal of something the user just did. Only where the UI
 * does not already show the result in place.
 */
export const toast = {
  success: (title: string) => noticeStore.push(actionNotice('success', title)),
  error: (title: string, body?: string) => noticeStore.push(actionNotice('error', title, body)),
}
