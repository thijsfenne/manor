import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Cancel01Icon, SidebarRightIcon, StopIcon } from '@hugeicons/core-free-icons'
import { IconButton } from './ui/IconButton'
import type { BrowserPreviewUpdate, DesktopBrowserBridge } from '@manor/contracts'
import { useBrowserSlot } from '../useBrowserSlot'
import type { BrowserActivity } from '../desktopBrowser'

type Frame = Extract<BrowserPreviewUpdate, { status: 'frame' }>

/** Frames stay in this component, never in the transcript or persistent state. */
export function BrowserPreview({ chatId, bridge, activity, sidebarOpen, manual = false, dismissed = false, turns, onOpen, onStop, onDismiss }: {
  chatId: string
  bridge: DesktopBrowserBridge | undefined
  activity: BrowserActivity | undefined
  sidebarOpen: boolean
  manual?: boolean
  dismissed?: boolean
  onDismiss(): void
  onOpen(): void
  turns: readonly { agentId: string; turnId: string }[]
  onStop(turnId: string): void
}) {
  const [frame, setFrame] = useState<Frame>()
  const [state, setState] = useState<'waiting' | 'live' | 'unavailable' | 'stopped'>('waiting')
  const [stopping, setStopping] = useState(false)
  const currentSubscription = useRef<string>()
  const mounted = useRef(true)
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const supported = !!(bridge?.webviews && bridge.startPreview && bridge.stopPreview && bridge.onPreview)
  const owner = activity?.agentId
  const previewOwner = manual ? 'manual' : owner
  const slot = useRef<HTMLButtonElement>(null)
  const liveSurface = supported && !dismissed && !sidebarOpen && !!previewOwner && state !== 'stopped' && state !== 'unavailable'
  useBrowserSlot({ bridge, chatId, frame: slot, active: liveSurface, presentation: 'floating',
    onError: () => setState('unavailable') })
  const ownedTurns = turns.filter((turn) => turn.agentId === owner)

  useEffect(() => { setStopping(false) }, [owner])
  useEffect(() => {
    if (dismissed || !previewOwner || sidebarOpen || !supported || !bridge) return
    let disposed = false
    const subscriptionId = crypto.randomUUID()
    currentSubscription.current = subscriptionId
    setState('waiting')
    const unsubscribe = bridge.onPreview!((update) => {
      if (!mounted.current || currentSubscription.current !== subscriptionId || update.chatId !== chatId || update.subscriptionId !== subscriptionId) return
      if (update.status === 'frame') {
        setFrame(update)
        setState('live')
      } else setState(update.status)
    })
    void (manual ? bridge.startPreview!(chatId, subscriptionId, 'manual')
      : bridge.startPreview!(chatId, subscriptionId)).catch(() => {
      if (!disposed) setState('unavailable')
    })
    return () => {
      disposed = true
      // The host can send its final frame before stopPreview resolves. A newer
      // subscription or an unmounted chat refuses that late frame.
      void bridge.stopPreview!(subscriptionId).catch(() => {}).finally(() => {
        unsubscribe()
        if (currentSubscription.current === subscriptionId) currentSubscription.current = undefined
      })
    }
  }, [bridge, chatId, previewOwner, manual, dismissed, sidebarOpen, supported])

  if (dismissed || sidebarOpen || (!manual && !activity && !frame)) return null
  const live = !!activity
  const label = !manual && !live ? 'Last browser view'
    : stopping ? 'Stopping browser…'
      : !supported ? 'Live preview needs the updated desktop app'
      : state === 'unavailable' ? 'Browser preview unavailable'
        : state === 'stopped' ? 'Browser preview paused'
          : state === 'waiting' ? 'Waiting for the browser…'
            : activity ? `${activity.agentName} is using the browser` : 'Live browser preview'

  return (
    <section aria-label="Browser preview" className={`group/browser-preview pointer-events-auto relative w-96 max-w-full overflow-hidden rounded-panel border border-line shadow-popover ${liveSurface ? 'bg-transparent' : 'bg-surface'}`}>
      <span role="status" className={state === 'live' && (liveSurface || frame) ? 'sr-only' : 'pointer-events-none absolute inset-x-0 bottom-0 z-[1] bg-media-scrim px-3 py-2 text-meta text-on-media'}>{label}</span>
      <button ref={slot} data-browser-slot="floating" type="button" aria-label="Open browser" onClick={onOpen} disabled={!bridge}
        className={`relative block aspect-video w-full cursor-pointer border-0 p-0 disabled:cursor-default ${liveSurface ? 'bg-transparent' : 'bg-surface-2'}`}>
        {!liveSurface && frame ? <img src={frame.screenshot} alt="Last captured browser page" width={frame.width} height={frame.height}
          className="absolute inset-0 h-full w-full object-contain" />
          : <span className="block aspect-video" />}
      </button>
      <div role="group" aria-label="Browser preview controls" className="pointer-events-none absolute top-2 right-2 flex items-center gap-1 rounded-panel border border-line bg-surface/90 p-1 opacity-0 shadow-pill backdrop-blur-md motion-safe:transition-opacity duration-150 group-hover/browser-preview:pointer-events-auto group-hover/browser-preview:opacity-100 group-focus-within/browser-preview:pointer-events-auto group-focus-within/browser-preview:opacity-100">
        <IconButton icon={SidebarRightIcon} label="Open browser sidebar" disabled={!bridge} onClick={onOpen} />
        {live && ownedTurns.length > 0 ? (
          <IconButton icon={StopIcon} label={stopping ? 'Stopping browser' : 'Stop browser agent'} disabled={stopping} onClick={() => {
            setStopping(true)
            for (const turn of ownedTurns) onStop(turn.turnId)
            void bridge?.endAgentUse?.(chatId).catch(() => {})
          }} />
        ) : null}
        <IconButton icon={Cancel01Icon} label="Hide browser preview" onClick={onDismiss} />
      </div>
    </section>
  )
}
