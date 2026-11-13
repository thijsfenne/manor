import { useCallback, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Clock01Icon, PlusSignIcon } from '@hugeicons/core-free-icons'
import type { Chat, ChatMode } from '@manor/contracts'
import { IconButton } from './ui/IconButton'
import { Popover } from './ui/Popover'
import { useDismiss } from './ui/useDismiss'
import { usePopupPlacement } from './ui/usePopupPlacement'

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

function Menu({ label, trigger, children }: {
  label: string
  trigger: (props: { ref: RefObject<HTMLButtonElement>; open: boolean; toggle: () => void }) => ReactNode
  children: (close: () => void) => ReactNode
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const close = useCallback((refocus = true) => { setOpen(false); if (refocus) triggerRef.current?.focus() }, [])
  const placement = usePopupPlacement({ open, triggerRef, maxHeight: 420, minHeight: 120, minWidth: 240, align: 'end' })
  // Pressing away hands focus to whatever was pressed, a page field included; only Escape returns it here.
  useDismiss(open, () => close(false), { within: [triggerRef, popup], onEscape: close, layoutMoved: true })
  const focusMenu = useCallback(() => {
    if (open && placement) popup.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [open, placement])
  return <>
    {trigger({ ref: triggerRef, open, toggle: () => setOpen((value) => !value) })}
    {typeof document === 'undefined' ? null : createPortal(
      <Popover open={open} onReady={focusMenu} ref={popup} origin="top-right"
        className="fixed z-40 overflow-y-auto rounded-panel border border-line surface-floating p-1 shadow-menu"
        style={placement ?? { visibility: 'hidden' }} role="menu" aria-label={label}>
        {children(close)}
      </Popover>, document.body)}
  </>
}

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
  return <div className="pointer-events-auto flex flex-none items-center gap-0.5">
    <Menu label="New session" trigger={({ ref, open, toggle }) => (
      <IconButton ref={ref} icon={PlusSignIcon} label="New session" aria-haspopup="menu" aria-expanded={open}
        disabled={disabled} onClick={toggle} />
    )}>
      {(close) => <ModeItems disabled={disabled} onNew={onNew} close={close} />}
    </Menu>
    <Menu label="Recent sessions" trigger={({ ref, open, toggle }) => (
      <IconButton ref={ref} icon={Clock01Icon} label="Recent sessions" aria-haspopup="menu" aria-expanded={open}
        disabled={sessions.length === 0} onClick={toggle} />
    )}>
      {(close) => sessions.map((session) => (
        <button key={session.id} type="button" role="menuitemradio" aria-checked={session.id === currentId} className={ROW}
          onClick={() => { close(); if (session.id !== currentId) onOpen(session.id) }}>
          <span className="min-w-0 truncate">{session.title}</span>
          {session.id === currentId ? <span className="flex-none text-meta text-muted">Current</span> : null}
        </button>
      ))}
    </Menu>
  </div>
}

/** The pane before any session exists: the one thing to do, and nothing else. */
export function BrowserSessionEmpty({ disabled, onNew }: { disabled: boolean; onNew(mode: ChatMode): void }) {
  return <div className="grid min-h-0 place-items-center px-8 text-center">
    <div>
      <Menu label="New session" trigger={({ ref, open, toggle }) => (
        <button ref={ref} type="button" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={toggle}
          className="cursor-pointer rounded-button-sm border border-line bg-surface-2 px-3 py-1.5 text-label text-text hover:bg-user-bg disabled:cursor-default disabled:opacity-40">
          New session
        </button>
      )}>
        {(close) => <ModeItems disabled={disabled} onNew={onNew} close={close} />}
      </Menu>
    </div>
  </div>
}
