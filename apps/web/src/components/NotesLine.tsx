import { createContext, useContext, type ReactNode } from 'react'
import { Book02Icon, File01Icon } from '@hugeicons/core-free-icons'
import type { NotesUpdate } from '@manor/contracts'
import { openAgentPage } from '../agentSettingsIntent'
import type { RequestEvents } from '../useRequest'
import { Icon } from './Icon'

/** What a turn's notes line can do from inside a chat. Absent where the chat cannot, as in a read-only view. */
export interface NotesActions {
  requestEvents: RequestEvents
  connected: boolean
  /** Takes one memory tool write back; the server refuses when the line changed since. */
  undoWrite: (writeId: string, requestId: string) => boolean
  /** Opens the agent's settings wherever they live: its DM's panel, or Settings. */
  editAgent: (agentId: string) => void
}

export const NotesActionsContext = createContext<NotesActions | undefined>(undefined)

/** "+1 line", "−2 lines", "+1 −1 lines": what changed, headings and the capacity line left out. */
export function notesCountLabel({ added, removed }: Pick<NotesUpdate, 'added' | 'removed'>): string {
  const parts = [...(added > 0 ? [`+${added}`] : []), ...(removed > 0 ? [`−${removed}`] : [])]
  return `${parts.join(' ')} ${added + removed === 1 ? 'line' : 'lines'}`
}

const LINK = 'cursor-pointer border-0 bg-transparent p-0 text-[12px] text-muted underline-offset-2 [font-family:inherit] hover:text-text hover:underline disabled:cursor-default disabled:text-dim disabled:no-underline'

function Line({ icon, children }: { icon: Parameters<typeof Icon>[0]['icon']; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-dim">
      <Icon icon={icon} size={12} className="flex-none" />
      {children}
    </div>
  )
}

/**
 * Under a reply: "Updated its notes +1 line, View" when the agent changed its notes with
 * a file tool, or a memory-off agent's offer, "Add to instructions". The lines it wrote
 * with `update_notes` are in the footnote above instead, each with its own Undo.
 */
export function NotesLine({ agentId, update, offer }: {
  agentId: string
  update?: NotesUpdate | undefined
  offer?: string | undefined
}) {
  const actions = useContext(NotesActionsContext)
  if (actions === undefined || (update === undefined && offer === undefined)) return null
  const open = (page: 'notes' | 'instructions', line?: string) => {
    openAgentPage({ agentId, page, ...(line === undefined ? {} : { line }) })
    actions.editAgent(agentId)
  }
  return (
    <div data-chrome="" className="flex min-w-0 flex-col gap-1">
      {update === undefined ? null : (
        <Line icon={Book02Icon}>
          <span>Updated its notes {notesCountLabel(update)}</span>
          <button type="button" className={LINK} onClick={() => open('notes')}>View</button>
        </Line>
      )}
      {offer === undefined ? null : (
        <Line icon={File01Icon}>
          <span className="min-w-0 truncate" title={offer}>Not kept, memory is off: “{offer}”</span>
          <button type="button" className={LINK} onClick={() => open('instructions', offer)}>Add to instructions</button>
        </Line>
      )}
    </div>
  )
}
