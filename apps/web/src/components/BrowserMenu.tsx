import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight01Icon, CleanIcon, Settings01Icon, MinusSignIcon, MoreVerticalIcon, PlusSignIcon, RefreshIcon } from '@hugeicons/core-free-icons'
import type { BrowserPageSettings, DesktopBrowserBridge } from '@manor/contracts'
import type { CrossingTarget } from '../browserCrossing'
import { Icon } from './Icon'
import { IconButton } from './ui/IconButton'
import { Popover } from './ui/Popover'
import { useDismiss } from './ui/useDismiss'
import { usePopupPlacement } from './ui/usePopupPlacement'

const ROW = 'flex w-full items-center justify-between rounded-button-sm border-0 bg-transparent px-3 py-2 text-left text-label text-text hover:bg-user-bg disabled:cursor-default disabled:opacity-40'

/** One page-zoom step, 10% at a time between 25% and 500%; the menu and ⌘+ / ⌘− share it. */
export function nextZoom(zoom: number, direction: 1 | -1): number {
  return Math.min(5, Math.max(0.25, Math.round((zoom + direction * 0.1) * 100) / 100))
}

export function BrowserMenu({ bridge, chatId, settings, disabled, pageDisabled, profile, settingsOpen, settingsDisabled, clearDisabled, onSettings, onClearData, onError, onStart, onOpenExternal, onSendToBrowser, openInChat, onFind }: {
  bridge: DesktopBrowserBridge
  chatId: string
  settings: BrowserPageSettings | undefined
  disabled: boolean
  pageDisabled: boolean
  profile: string
  settingsOpen: boolean
  settingsDisabled: boolean
  clearDisabled: boolean
  onSettings(): void
  onClearData(): void
  onError(reason: unknown): void
  onStart(): void
  /** Hands the page to the Mac's default browser. Absent without a page to hand over. */
  onOpenExternal?: () => void
  /** A chat's browser copies its page into the Browser tab set. Absent on Browser itself. */
  onSendToBrowser?: () => Promise<unknown>
  /** Browser copies its page into a recent chat's own browser. Absent inside a chat. */
  openInChat?: { targets: readonly CrossingTarget[]; onOpen(chatId: string): Promise<unknown> }
  /** Opens the find bar, the same as ⌘F. Absent in shells without find. */
  onFind?: () => void
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [appearance, setAppearance] = useState(false)
  const [chats, setChats] = useState(false)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const close = (refocus = true) => { setOpen(false); setAppearance(false); setChats(false); if (refocus) trigger.current?.focus() }
  const placement = usePopupPlacement({ open, triggerRef: trigger, maxHeight: 560, minHeight: 200, minWidth: 288, align: 'end' })
  // Pressing away hands focus to whatever was pressed, a page field included; only Escape returns it here.
  useDismiss(open, () => close(false), { within: [trigger, popup], onEscape: close, layoutMoved: true })
  const focusMenu = useCallback(() => {
    if (open && placement) popup.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [open, placement])
  const perform = (action: () => Promise<unknown>, keepOpen = false) => {
    if (busy) return
    onStart()
    if (!keepOpen) close()
    setBusy(true)
    void action().catch((reason: unknown) => { if (mounted.current) onError(reason) }).finally(() => {
      if (mounted.current) setBusy(false)
    })
  }
  const configure = (patch: Partial<BrowserPageSettings>) => {
    if (bridge.configure) perform(() => bridge.configure!(chatId, patch), true)
  }
  const action = (label: string, call: (() => Promise<unknown>) | undefined, needsPage = true) => (
    <button type="button" role="menuitem" className={ROW} disabled={disabled || busy || (needsPage && pageDisabled) || !call}
      title={!call ? 'Update the desktop app to use this option' : undefined}
      onClick={() => { if (call) perform(call) }}>{label}</button>
  )
  const zoom = settings?.zoomFactor ?? 1
  return <>
    <IconButton ref={trigger} icon={MoreVerticalIcon} label="Browser menu" aria-haspopup="menu" aria-expanded={open}
      disabled={disabled} onClick={() => { setOpen((value) => !value); setAppearance(false); setChats(false) }} />
    {typeof document === 'undefined' ? null : createPortal(
      <Popover open={open} onReady={focusMenu} ref={popup} origin="top-right" className="fixed z-40 overflow-y-auto rounded-panel border border-line surface-floating p-1 shadow-menu"
        style={placement ?? { visibility: 'hidden' }} role="menu" aria-label="Browser actions">
        <div onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          const buttons = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
          if (buttons.length === 0) return
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
          event.preventDefault(); buttons[next]?.focus()
        }}>
          {onOpenExternal === undefined && onSendToBrowser === undefined && openInChat === undefined ? null
            : <div className="mb-1 border-b border-line pb-1">
            {onOpenExternal === undefined ? null : action('Open in default browser', async () => onOpenExternal())}
            {onSendToBrowser === undefined ? null : action('Send to Browser', onSendToBrowser)}
            {openInChat === undefined ? null : <>
            <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={chats} className={ROW}
              disabled={disabled || pageDisabled || busy} onClick={() => setChats((value) => !value)}>
              Open in chat <Icon icon={ArrowRight01Icon} size={14} />
            </button>
            {!chats ? null : <div role="menu" aria-label="Recent chats" className="ml-3 border-l border-line pl-1">
              {openInChat.targets.length === 0
                ? <p className="m-0 px-3 py-2 text-meta text-muted">No recent chats yet.</p>
                : openInChat.targets.map((target) => <button key={target.chatId} type="button" role="menuitem"
                  className={ROW} disabled={busy || disabled || pageDisabled}
                  onClick={() => perform(() => openInChat.onOpen(target.chatId))}>
                  <span className="min-w-0 truncate">{target.title}</span>
                  {target.detail === undefined ? null
                    : <span className="ml-3 max-w-[45%] flex-none truncate text-meta text-muted">{target.detail}</span>}
                </button>)}
            </div>}
            </>}
          </div>}
          {onFind === undefined ? null : (
            <button type="button" role="menuitem" className={ROW} disabled={disabled || pageDisabled || busy}
              onClick={() => { close(false); onFind() }}>
              Find on page <span className="text-meta text-muted">⌘F</span>
            </button>
          )}
          {action('Hard reload', bridge.hardReload && (() => bridge.hardReload!(chatId)))}
          {action('Open DevTools', bridge.openDevTools && (() => bridge.openDevTools!(chatId)))}
          {action('Open separate preview window', bridge.openPreviewWindow && (() => bridge.openPreviewWindow!(chatId)))}
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={appearance} className={ROW}
            disabled={disabled || pageDisabled || busy || !bridge.configure} onClick={() => setAppearance((value) => !value)}>
            Appearance <Icon icon={ArrowRight01Icon} size={14} />
          </button>
          {!appearance ? null : <div role="menu" aria-label="Website appearance" className="ml-3 border-l border-line pl-1">
            {(['system', 'light', 'dark'] as const).map((value) => <button key={value} type="button" role="menuitemradio"
              aria-checked={(settings?.appearance ?? 'system') === value} className={ROW} disabled={busy || disabled || pageDisabled}
              onClick={() => configure({ appearance: value })}>
              {value === 'system' ? 'System' : value === 'light' ? 'Light' : 'Dark'}
              {(settings?.appearance ?? 'system') === value ? <span className="text-meta text-muted">Selected</span> : null}
            </button>)}
          </div>}
          <div className="my-1 flex items-center gap-1 border-y border-line px-3 py-2 text-label text-text">
            <span className="flex-1">Zoom</span>
            <IconButton icon={MinusSignIcon} label="Zoom out" disabled={disabled || pageDisabled || busy || !bridge.configure || zoom <= 0.25}
              onClick={() => configure({ zoomFactor: nextZoom(zoom, -1) })} />
            <span className="w-12 text-center text-meta text-muted">{Math.round(zoom * 100)}%</span>
            <IconButton icon={PlusSignIcon} label="Zoom in" disabled={disabled || pageDisabled || busy || !bridge.configure || zoom >= 5}
              onClick={() => configure({ zoomFactor: nextZoom(zoom, 1) })} />
            <IconButton icon={RefreshIcon} label="Reset zoom" disabled={disabled || pageDisabled || busy || !bridge.configure || zoom === 1}
              onClick={() => configure({ zoomFactor: 1 })} />
          </div>
          <p className="m-0 px-3 py-2 text-meta text-muted">Profile: {profile}</p>
          {action('Clear cookies', bridge.clearCookies && (() => bridge.clearCookies!()), false)}
          {action('Clear cache', bridge.clearCache && (() => bridge.clearCache!()), false)}
          <div className="mt-1 border-t border-line pt-1">
            <button type="button" role="menuitem" className={ROW} aria-expanded={settingsOpen}
              disabled={disabled || busy || settingsDisabled} onClick={() => { close(); onSettings() }}>
              <span className="flex items-center gap-2"><Icon icon={Settings01Icon} />Browser settings</span>
            </button>
            <button type="button" role="menuitem" className={ROW}
              disabled={disabled || busy || clearDisabled} onClick={() => { close(); onClearData() }}>
              <span className="flex items-center gap-2"><Icon icon={CleanIcon} />Clear browser data</span>
            </button>
          </div>
          {!bridge.configure ? <p className="m-0 px-3 py-2 text-meta text-muted">Update the desktop app for all browser options.</p> : null}
          {busy ? <p role="status" className="m-0 px-3 py-2 text-meta text-muted">Applying…</p> : null}
        </div>
      </Popover>, document.body)}
  </>
}
