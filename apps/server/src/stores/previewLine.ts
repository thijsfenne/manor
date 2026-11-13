import { isModelOnlyMessage, splitUserMessage, withQuoteExcerpts, type ThreadEvent } from '@manor/contracts'
import { previewOf } from '../store.js'

/**
 * What an arriving event makes the chat's line, or undefined when it leaves the line
 * as it was. A wake row or Manor's instruction to the model is not something anyone
 * said, so the reply it starts is the preview. Text a stop or failure cut off is no
 * line to remember the chat by; a DM never shows it.
 */
export function previewLine(event: ThreadEvent): string | null | undefined {
  if (event.type === 'agent_message') return event.interrupted === true ? undefined : previewOf(event.text) || null
  if (event.type !== 'user_message' || event.source === 'background_wake' || isModelOnlyMessage(event)) return undefined
  return previewOf(withQuoteExcerpts(splitUserMessage(event).visible, event.quotes)) || null
}
