import { createContext, useContext, useState, type ReactNode } from 'react'
import { Book02Icon, File01Icon } from '@hugeicons/core-free-icons'
import type { NotesUpdate } from '@manor/contracts'
import { openAgentPage } from '../agentSettingsIntent'
import { useRequest, type RequestEvents } from '../useRequest'
import { Icon } from './Icon'

/** What a turn's notes line can do from inside a chat. Absent where the chat cannot, as in a read-only view. */
export interface NotesActions {
  requestEvents: RequestEvents
  connected: boolean
  undo: (turnId: string, requestId: string) => boolean
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
 * Under a reply: "Updated its notes +1 line, View, Undo", or a memory-off agent's
 * offer, "Add to instructions". Undo is the server's to refuse, when the notes changed
 * since or the agent is mid-turn; its answer shows beside the button and nothing is written.
 */
export function NotesLine({ turnId, agentId, update, offer }: {
  turnId: string
  agentId: string
  update?: NotesUpdate | undefined
  offer?: string | undefined
}) {
  const actions = useContext(NotesActionsContext)
  const { pending, start } = useRequest(actions?.requestEvents ?? NO_EVENTS)
  const [refusal, setRefusal] = useState<string | null>(null)
  if (actions === undefined || (update === undefined && offer === undefined)) return null
  const open = (page: 'notes' | 'instructions', line?: string) => {
    openAgentPage({ agentId, page, ...(line === undefined ? {} : { line }) })
    actions.editAgent(agentId)
  }
  const undo = () => {
    setRefusal(null)
    start((requestId) => actions.undo(turnId, requestId), {
      onNotice: (notice) => setRefusal(notice.text),
      noticeInPlace: true,
    })
  }
  return (
    <div data-chrome="" className="flex min-w-0 flex-col gap-1">
      {update === undefined ? null : (
        <Line icon={Book02Icon}>
          <span>{update.undone === true ? 'Undid its notes change' : `Updated its notes ${notesCountLabel(update)}`}</span>
          <button type="button" className={LINK} onClick={() => open('notes')}>View</button>
          {update.undone === true ? null : (
            <button type="button" className={LINK} disabled={pending || !actions.connected} onClick={undo}>
              {pending ? 'Undoing…' : 'Undo'}
            </button>
          )}
          {refusal === null ? null : <span role="status" className="text-warn">{refusal}</span>}
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

const NO_EVENTS: RequestEvents = { subscribe: () => () => undefined }
