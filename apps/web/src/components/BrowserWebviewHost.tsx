import { memo, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BrowserViewportBounds, BrowserWebviewSnapshot, BrowserWebviewSurface, DesktopBrowserWebviewsBridge } from '@manor/contracts'
import { intersect, useBrowserFrame, useBrowserSidebarHidden, type BrowserFrame } from '../useBrowserSlot'

interface BrowserGuest extends HTMLElement {
  getWebContentsId(): number
}

/** One registry lives beside the workspace; panel changes only reposition its guests. */
export function BrowserWebviewHost({ bridge }: { bridge: DesktopBrowserWebviewsBridge | undefined }) {
  const [current, setCurrent] = useState<{ bridge: DesktopBrowserWebviewsBridge; snapshot: BrowserWebviewSnapshot }>()
  const [error, setError] = useState(false)
  const frame = useBrowserFrame(bridge)
  const sidebarHidden = useBrowserSidebarHidden(bridge)
  useLayoutEffect(() => {
    if (!bridge) return
    let disposed = false
    setError(false)
    let received = false
    const receive = (snapshot: BrowserWebviewSnapshot) => {
      if (disposed) return
      received = true
      setError(false)
      setCurrent((previous) => previous?.bridge === bridge && previous.snapshot.revision >= snapshot.revision
        ? previous : { bridge, snapshot })
    }
    const unsubscribe = bridge.onChange(receive)
    void bridge.list().then(receive, () => { if (!disposed && !received) setError(true) })
    return () => { disposed = true; unsubscribe() }
  }, [bridge])
  if (!bridge || typeof document === 'undefined') return null
  return createPortal(<>
    {current?.bridge === bridge ? current.snapshot.surfaces.map((surface) => (
      <BrowserWebview key={JSON.stringify([surface.id, surface.token])} bridge={bridge}
        // A sidebar page waits out a hand-over between chats hidden, never in the new panel,
        // and stays hidden under a blank tab, whose panel draws its own page.
        surface={sidebarHidden && surface.presentation === 'sidebar' ? { ...surface, presentation: 'hidden' } : surface}
        frame={surface.presentation === 'sidebar' && surface.fill ? frame : null}
        clip={surface.presentation === 'sidebar' ? frame?.clip ?? null : null} />
    )) : null}
    {error ? <p role="alert" className="fixed right-4 bottom-4 z-20 rounded-panel bg-raised p-3 text-label text-danger">Browser connection unavailable. Reopen Manor to reconnect.</p> : null}
  </>, document.body)
}

const BrowserWebview = memo(function BrowserWebview({ surface, bridge, frame, clip }: {
  surface: BrowserWebviewSurface
  bridge: DesktopBrowserWebviewsBridge
  /**
   * The slot a filling page follows, with the corners it measured. Absent, the page keeps
   * the house corner: a floating preview, or a device preview centred in the slot.
   */
  frame: BrowserFrame | null
  /** The window the panels around the sidebar frame leave open; the page keeps its size under it. */
  clip: BrowserViewportBounds | null
}) {
  const container = useRef<HTMLDivElement>(null)
  const [attached, setAttached] = useState(false)
  const [error, setError] = useState(false)
  // Partition and initial src belong to this token's lifetime, never ongoing navigation.
  const initial = useRef(surface)
  useLayoutEffect(() => {
    const parent = container.current
    if (!parent) return
    setAttached(false)
    setError(false)
    let disposed = false
    let attaching = false
    let attachedId: number | undefined
    const guest = document.createElement('webview') as BrowserGuest
    guest.setAttribute('partition', initial.current.partition)
    guest.setAttribute('allowpopups', '')
    guest.setAttribute('src', initial.current.src)
    // Transparent on purpose: the white under a page comes from the plate below.
    guest.className = 'flex h-full w-full'
    const attach = () => {
      if (disposed || attaching) return
      let webContentsId: number
      try { webContentsId = guest.getWebContentsId() } catch { return }
      if (!Number.isInteger(webContentsId) || webContentsId <= 0 || attachedId === webContentsId) return
      attaching = true
      void bridge.attach(surface.id, surface.token, webContentsId).then(() => {
        if (disposed) return
        attachedId = webContentsId
        setAttached(true)
        setError(false)
      }, () => { if (!disposed) setError(true) }).finally(() => { attaching = false })
    }
    guest.addEventListener('did-attach', attach)
    guest.addEventListener('dom-ready', attach)
    parent.appendChild(guest)
    attach()
    return () => {
      disposed = true
      guest.removeEventListener('did-attach', attach)
      guest.removeEventListener('dom-ready', attach)
      guest.remove()
    }
  }, [bridge, surface.id, surface.token])

  useLayoutEffect(() => {
    if (!attached) return
    let disposed = false
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        if (!disposed) void bridge.presented(surface.id, surface.token, surface.revision)
          .catch(() => { if (!disposed) setError(true) })
      })
    })
    return () => { disposed = true; cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [bridge, attached, surface.id, surface.token, surface.revision])

  const hidden = surface.presentation === 'hidden'
  const bounds = frame ?? surface.bounds
  // The outer box is the window onto the page, the inner one the page at its full size,
  // so a frame cut by a scrolled row clips the page the way the row clips its cards.
  const shown = hidden || clip === null ? bounds : intersect(bounds, clip)
  const interactive = surface.presentation === 'sidebar' && shown.width > 0 && shown.height > 0
  const corners = frame?.corners
  const radius = corners === undefined ? 'var(--radius-lg)' : corners.map((corner) => `${corner}px`).join(' ')
  const plateRadius = corners === undefined ? 'calc(var(--radius-lg) * 1.5)' : corners.map((corner) => `${corner * 1.5}px`).join(' ')
  return <div data-browser-webview={surface.id} data-presentation={surface.presentation}
    aria-hidden={!interactive} {...(!interactive ? { inert: '' } : {})}
    className="fixed overflow-hidden"
    style={{ left: hidden ? 0 : shown.x, top: hidden ? 0 : shown.y,
      width: shown.width, height: shown.height, borderRadius: radius,
      visibility: hidden && !surface.painting ? 'hidden' : undefined,
      zIndex: hidden ? -1 : `var(--z-browser-${surface.presentation})`, pointerEvents: interactive ? 'auto' : 'none' }}>
    {/* A guest page is transparent where it paints nothing, so this plate keeps a page
        without its own background white instead of showing Manor through it. Rounder
        than the clip, so its edge stays inside the anti-aliased corner rather than
        bleeding past a dark page as a white hairline. */}
    <div data-browser-plate aria-hidden className="absolute inset-0 bg-page" style={{ borderRadius: plateRadius }} />
    <div data-browser-page className="absolute overflow-hidden"
      style={{ left: bounds.x - shown.x, top: bounds.y - shown.y, width: bounds.width, height: bounds.height }}>
      <div ref={container} className="h-full w-full" style={surface.magnify ? { transformOrigin: '0 0',
        transform: `scale(${surface.magnify.scale}) translate(${-surface.magnify.x * 100}%, ${-surface.magnify.y * 100}%)` } : undefined} />
      {error && !hidden ? <p role="alert" className="absolute inset-x-0 bottom-0 m-0 bg-raised p-3 text-label text-danger">Browser page unavailable. Close this tab and reopen it.</p> : null}
    </div>
  </div>
})
