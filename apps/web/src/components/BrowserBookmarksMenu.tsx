import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bookmark01Icon } from '@hugeicons/core-free-icons'
import type { BrowserBookmark } from '@manor/contracts'
import { IconButton } from './ui/IconButton'
import { Popover } from './ui/Popover'
import { useDismiss } from './ui/useDismiss'
import { usePopupPlacement } from './ui/usePopupPlacement'

export function BrowserBookmarksMenu({ bookmarks, loading, error, disabled, onRetry, onOpen }: {
  bookmarks: BrowserBookmark[] | null
  loading: boolean
  error: string | null
  disabled: boolean
  onRetry(): void
  onOpen(url: string): void
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const close = (refocus = true) => { setOpen(false); if (refocus) trigger.current?.focus() }
  const placement = usePopupPlacement({ open, triggerRef: trigger, maxHeight: 360, minHeight: 180, minWidth: 320, align: 'end' })
  // Pressing away hands focus to whatever was pressed, a page field included; only Escape returns it here.
  useDismiss(open, () => close(false), { within: [trigger, popup], onEscape: close, layoutMoved: true })
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])

  useEffect(() => {
    if (open && placement) popup.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [open, placement])

  return <>
    <IconButton ref={trigger} icon={Bookmark01Icon} label="Bookmarks"
      aria-haspopup="menu" aria-expanded={open} disabled={disabled}
      onClick={() => setOpen((value) => !value)} />
    {typeof document === 'undefined' ? null : createPortal(
      <Popover open={open} ref={popup} origin="top-right"
        className="fixed z-40 overflow-y-auto rounded-panel border border-line surface-floating p-1 shadow-menu"
        style={placement ?? { visibility: 'hidden' }} role="menu" aria-label="Bookmarks">
        <div onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          const buttons = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
          if (buttons.length === 0) return
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
          event.preventDefault()
          buttons[next]?.focus()
        }}>
          <p className="m-0 px-3 py-2 text-label font-medium text-text">Bookmarks</p>
          {error === null ? null : (
            <div className="px-3 py-2 text-meta text-danger" role="alert">
              <p className="m-0">{error}</p>
              <button type="button" role="menuitem" className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-meta text-text underline-offset-2 hover:underline"
                onClick={onRetry}>Try again</button>
            </div>
          )}
          {bookmarks === null ? (
            error === null ? <p role="status" className="m-0 px-3 py-2 text-meta text-dim">
              {loading ? 'Loading bookmarks…' : 'No bookmarks available.'}
            </p> : null
          ) : bookmarks.length === 0 ? (
            <p className="m-0 px-3 py-2 text-meta text-dim">No bookmarks yet. Save a page with the star beside the address.</p>
          ) : bookmarks.map((bookmark) => (
            <button key={bookmark.url} type="button" role="menuitem"
              className="flex w-full min-w-0 flex-col rounded-button-sm border-0 bg-transparent px-3 py-2 text-left hover:bg-user-bg"
              onClick={() => { close(); onOpen(bookmark.url) }}>
              <span className="w-full truncate text-label text-text">{bookmark.title || bookmark.url}</span>
              <span className="w-full truncate text-meta text-muted">{bookmark.url}</span>
            </button>
          ))}
        </div>
      </Popover>, document.body)}
  </>
}
