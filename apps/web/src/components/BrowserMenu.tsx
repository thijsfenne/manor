import { useEffect, useRef, useState } from 'react'
import {
  ArrowRight01Icon, BrowserIcon, BubbleChatIcon, CleanIcon, CodeIcon, ComputerIcon, CookieIcon, Eraser01Icon, Globe02Icon, LinkSquare02Icon,
  MinusSignIcon, Moon02Icon, MoreVerticalIcon, PaintBoardIcon, PlusSignIcon, RefreshIcon, ReloadIcon, Search01Icon, SearchAddIcon,
  Settings01Icon, Sun03Icon,
} from '@hugeicons/core-free-icons'
import type { BrowserPageSettings, DesktopBrowserBridge } from '@manor/contracts'
import type { ComponentProps } from 'react'
import type { CrossingTarget } from '../browserCrossing'
import { Icon } from './Icon'
import { IconButton } from './ui/IconButton'
import { Menu, MenuItem, useMenu } from './ui/Menu'

const APPEARANCES = [
  { value: 'system', label: 'System', icon: ComputerIcon },
  { value: 'light', label: 'Light', icon: Sun03Icon },
  { value: 'dark', label: 'Dark', icon: Moon02Icon },
] as const

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
  const [appearance, setAppearance] = useState(false)
  const [chats, setChats] = useState(false)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const fold = () => { setAppearance(false); setChats(false) }
  const [menu, trigger] = useMenu({ maxHeight: 560, minHeight: 200, minWidth: 288, onClose: fold })
  const close = menu.close
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
  const action = (icon: ComponentProps<typeof MenuItem>['icon'], label: string, call: (() => Promise<unknown>) | undefined, needsPage = true) => (
    <MenuItem icon={icon} disabled={disabled || busy || (needsPage && pageDisabled) || !call}
      title={!call ? 'Update the desktop app to use this option' : undefined}
      onClick={() => { if (call) perform(call) }}>{label}</MenuItem>
  )
  const zoom = settings?.zoomFactor ?? 1
  return <>
    <IconButton ref={trigger} icon={MoreVerticalIcon} label="Browser menu" aria-haspopup="menu" aria-expanded={menu.open}
      disabled={disabled} onClick={menu.toggle} />
    <Menu menu={menu} label="Browser actions">
      {onOpenExternal === undefined && onSendToBrowser === undefined && openInChat === undefined ? null
        : <div className="mb-1 border-b border-line pb-1">
        {onOpenExternal === undefined ? null : action(LinkSquare02Icon, 'Open in default browser', async () => onOpenExternal())}
        {onSendToBrowser === undefined ? null : action(Globe02Icon, 'Send to Browser', onSendToBrowser)}
        {openInChat === undefined ? null : <>
        <MenuItem icon={BubbleChatIcon} trailing={<Icon icon={ArrowRight01Icon} size={14} className="flex-none" />}
          aria-haspopup="menu" aria-expanded={chats}
          disabled={disabled || pageDisabled || busy} onClick={() => setChats((value) => !value)}>
          Open in chat
        </MenuItem>
        {!chats ? null : <div role="menu" aria-label="Recent chats" className="ml-3 border-l border-line pl-1">
          {openInChat.targets.length === 0
            ? <p className="m-0 px-3 py-2 text-meta text-muted">No recent chats yet.</p>
            : openInChat.targets.map((target) => <MenuItem key={target.chatId} disabled={busy || disabled || pageDisabled}
              trailing={target.detail === undefined ? undefined
                : <span className="ml-1 max-w-[45%] flex-none truncate text-meta text-muted">{target.detail}</span>}
              onClick={() => perform(() => openInChat.onOpen(target.chatId))}>
              {target.title}
            </MenuItem>)}
        </div>}
        </>}
      </div>}
      {onFind === undefined ? null : (
        <MenuItem icon={Search01Icon} trailing="⌘F" disabled={disabled || pageDisabled || busy}
          onClick={() => { close(false); onFind() }}>
          Find on page
        </MenuItem>
      )}
      {action(ReloadIcon, 'Hard reload', bridge.hardReload && (() => bridge.hardReload!(chatId)))}
      {action(CodeIcon, 'Open DevTools', bridge.openDevTools && (() => bridge.openDevTools!(chatId)))}
      {action(BrowserIcon, 'Open separate preview window', bridge.openPreviewWindow && (() => bridge.openPreviewWindow!(chatId)))}
      <MenuItem icon={PaintBoardIcon} trailing={<Icon icon={ArrowRight01Icon} size={14} className="flex-none" />}
        aria-haspopup="menu" aria-expanded={appearance}
        disabled={disabled || pageDisabled || busy || !bridge.configure} onClick={() => setAppearance((value) => !value)}>
        Appearance
      </MenuItem>
      {!appearance ? null : <div role="menu" aria-label="Website appearance" className="ml-3 border-l border-line pl-1">
        {APPEARANCES.map((option) => <MenuItem key={option.value} role="menuitemradio" icon={option.icon}
          checked={(settings?.appearance ?? 'system') === option.value} disabled={busy || disabled || pageDisabled}
          onClick={() => configure({ appearance: option.value })}>
          {option.label}
        </MenuItem>)}
      </div>}
      <div className="my-1 flex items-center gap-1 border-y border-line px-3 py-2 text-label text-text">
        <Icon icon={SearchAddIcon} size={15} className="mr-1 flex-none text-muted" />
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
      {action(CookieIcon, 'Clear cookies', bridge.clearCookies && (() => bridge.clearCookies!()), false)}
      {action(Eraser01Icon, 'Clear cache', bridge.clearCache && (() => bridge.clearCache!()), false)}
      <div className="mt-1 border-t border-line pt-1">
        <MenuItem icon={Settings01Icon} aria-expanded={settingsOpen}
          disabled={disabled || busy || settingsDisabled} onClick={() => { close(); onSettings() }}>
          Browser settings
        </MenuItem>
        <MenuItem icon={CleanIcon} disabled={disabled || busy || clearDisabled} onClick={() => { close(); onClearData() }}>
          Clear browser data
        </MenuItem>
      </div>
      {!bridge.configure ? <p className="m-0 px-3 py-2 text-meta text-muted">Update the desktop app for all browser options.</p> : null}
      {busy ? <p role="status" className="m-0 px-3 py-2 text-meta text-muted">Applying…</p> : null}
    </Menu>
  </>
}
