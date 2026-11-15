import { Clock01Icon, PlusSignIcon } from '@hugeicons/core-free-icons'
import type { Chat, ChatMode } from '@manor/contracts'
import { IconButton } from './ui/IconButton'
import { Menu, useMenu } from './ui/Menu'

const ROW = 'flex w-full items-center justify-between gap-3 rounded-button-sm border-0 bg-transparent px-3 py-2 text-left text-label text-text hover:bg-user-bg disabled:cursor-default disabled:opacity-40'

/** Past this the list stops being recent and becomes an archive nobody asked for. */
export const RECENT_BROWSER_SESSIONS = 8

/** The Browser place's own sessions, newest first. Archived ones are put away. */
export function recentBrowserSessions(chats: readonly Chat[], limit = RECENT_BROWSER_SESSIONS): Chat[] {
  return chats
    .filter((chat) => chat.kind === 'browser' && chat.archivedAt === null)
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
    .slice(0, limit)
}

/** Single first: browsing is mostly quick questions, and Single is the default. */
const MODES: { mode: ChatMode; label: string; detail: string }[] = [
  { mode: 'single', label: 'Single', detail: 'One model' },
  { mode: 'house', label: 'Multiple', detail: 'Every agent' },
]

const SIZE = { maxHeight: 420, minHeight: 120, minWidth: 240 }

function ModeItems({ disabled, onNew, close }: { disabled: boolean; onNew(mode: ChatMode): void; close(): void }) {
  return <>{MODES.map((option) => (
    <button key={option.mode} type="button" role="menuitem" className={ROW} disabled={disabled}
      onClick={() => { close(); onNew(option.mode) }}>
      {option.label}
      <span className="text-meta text-muted">{option.detail}</span>
    </button>
  ))}</>
}

/**
 * New session and the recent list, in the pane header beside the Browser stage.
 * The mode is picked here because it is fixed for the session's whole life.
 */
export function BrowserSessionMenu({ sessions, currentId, disabled, onNew, onOpen }: {
  sessions: readonly Chat[]
  currentId: string | null
  disabled: boolean
  onNew(mode: ChatMode): void
  onOpen(chatId: string): void
}) {
  const [fresh, freshTrigger] = useMenu(SIZE)
  const [recent, recentTrigger] = useMenu(SIZE)
  return <div className="pointer-events-auto flex flex-none items-center gap-0.5">
    <IconButton ref={freshTrigger} icon={PlusSignIcon} label="New session" aria-haspopup="menu" aria-expanded={fresh.open}
      disabled={disabled} onClick={fresh.toggle} />
    <Menu menu={fresh} label="New session">
      <ModeItems disabled={disabled} onNew={onNew} close={fresh.close} />
    </Menu>
    <IconButton ref={recentTrigger} icon={Clock01Icon} label="Recent sessions" aria-haspopup="menu" aria-expanded={recent.open}
      disabled={sessions.length === 0} onClick={recent.toggle} />
    <Menu menu={recent} label="Recent sessions">
      {sessions.map((session) => (
        <button key={session.id} type="button" role="menuitemradio" aria-checked={session.id === currentId} className={ROW}
          onClick={() => { recent.close(); if (session.id !== currentId) onOpen(session.id) }}>
          <span className="min-w-0 truncate">{session.title}</span>
          {session.id === currentId ? <span className="flex-none text-meta text-muted">Current</span> : null}
        </button>
      ))}
    </Menu>
  </div>
}

/** The pane before any session exists: the one thing to do, and nothing else. */
export function BrowserSessionEmpty({ disabled, onNew }: { disabled: boolean; onNew(mode: ChatMode): void }) {
  const [menu, trigger] = useMenu(SIZE)
  return <div className="grid min-h-0 place-items-center px-8 text-center">
    <div>
      <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={menu.open} disabled={disabled} onClick={menu.toggle}
        className="cursor-pointer rounded-button-sm border border-line bg-surface-2 px-3 py-1.5 text-label text-text hover:bg-user-bg disabled:cursor-default disabled:opacity-40">
        New session
      </button>
      <Menu menu={menu} label="New session">
        <ModeItems disabled={disabled} onNew={onNew} close={menu.close} />
      </Menu>
    </div>
  </div>
}
