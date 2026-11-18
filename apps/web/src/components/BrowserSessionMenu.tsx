import { Clock01Icon, PlusSignIcon } from '@hugeicons/core-free-icons'
import type { Chat } from '@manor/contracts'
import { IconButton } from './ui/IconButton'
import { Menu, MenuItem, useMenu } from './ui/Menu'

/** Past this the list stops being recent and becomes an archive nobody asked for. */
export const RECENT_BROWSER_SESSIONS = 8

/** The Browser place's own sessions, newest first. Archived ones are put away. */
export function recentBrowserSessions(chats: readonly Chat[], limit = RECENT_BROWSER_SESSIONS): Chat[] {
  return chats
    .filter((chat) => chat.kind === 'browser' && chat.archivedAt === null)
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
    .slice(0, limit)
}

const SIZE = { maxHeight: 420, minHeight: 120, minWidth: 240 }

/**
 * New session and the recent list, in the pane header beside the Browser stage.
 * A session is always one model, so New starts one straight away.
 */
export function BrowserSessionMenu({ sessions, currentId, disabled, onNew, onOpen }: {
  sessions: readonly Chat[]
  currentId: string | null
  disabled: boolean
  onNew(): void
  onOpen(chatId: string): void
}) {
  const [recent, recentTrigger] = useMenu(SIZE)
  return <div className="pointer-events-auto flex flex-none items-center gap-0.5">
    <IconButton icon={PlusSignIcon} label="New session" disabled={disabled} onClick={onNew} />
    <IconButton ref={recentTrigger} icon={Clock01Icon} label="Recent sessions" aria-haspopup="menu" aria-expanded={recent.open}
      disabled={sessions.length === 0} onClick={recent.toggle} />
    <Menu menu={recent} label="Recent sessions">
      {sessions.map((session) => (
        <MenuItem key={session.id} role="menuitemradio" checked={session.id === currentId}
          onClick={() => { recent.close(); if (session.id !== currentId) onOpen(session.id) }}>
          {session.title}
        </MenuItem>
      ))}
    </Menu>
  </div>
}

/** The pane before any session exists: the one thing to do, and nothing else. */
export function BrowserSessionEmpty({ disabled, onNew }: { disabled: boolean; onNew(): void }) {
  return <div className="grid min-h-0 place-items-center px-8 text-center">
    <div>
      <button type="button" disabled={disabled} onClick={onNew}
        className="cursor-pointer rounded-button-sm border border-line bg-surface-2 px-3 py-1.5 text-label text-text hover:bg-user-bg disabled:cursor-default disabled:opacity-40">
        New session
      </button>
    </div>
  </div>
}
