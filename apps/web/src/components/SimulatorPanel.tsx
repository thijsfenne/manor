import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { ArrowLeft01Icon, Cancel01Icon, Home01Icon, LoaderCircleIcon, PictureInPictureOnIcon, PowerIcon, RotateClockwiseIcon } from '@hugeicons/core-free-icons'
import type { SimulatorAction, SimulatorDevice, SimulatorState } from '@manor/contracts'
import { decodeScreenConfig, encodeInput, fittedScreen, hidUsage, INPUT_TAG, nextOrientation, screenPoint, screenTurn } from '../simulatorInput'
import { panelGroups, type SimulatorSelection } from '../simulatorDevices'
import { Icon } from './Icon'
import { Button } from './ui/Button'
import { DOCK_PANEL_SHELL, dockPanelLayoutClass } from './ui/dockPanel'
import { IconButton } from './ui/IconButton'

type Stream = NonNullable<SimulatorState['stream']>

const STALE_RETRY_MS = 60_000

const PENDING_LABEL = { booting: 'Starting…', installing: 'Downloading the screen helper…', starting: 'Opening the screen…' } as const

/**
 * What the panel and the floating card show, from the one simulator state the server
 * broadcasts. Every panel watches the same device, so the screen follows the server:
 * opening a device asks the server to switch, and every open panel switches to it.
 * Without a device on screen, or after the back button, the panel shows the list.
 */
function useSimulatorView(state: SimulatorState | null, connected: boolean, onAction: (action: SimulatorAction, udid?: string) => boolean) {
  const [browsing, setBrowsing] = useState(false)
  const stream = state?.stream
  const streamUdid = stream?.udid
  // A device came on screen, here or from another panel: show it.
  useEffect(() => { if (streamUdid !== undefined) setBrowsing(false) }, [streamUdid])
  // Opening the panel, or the connection coming back, refreshes the device list.
  useEffect(() => {
    if (connected) onAction('list')
  }, [connected, onAction])

  const devices = state?.status === 'ready' ? state.devices : []
  const shown = browsing || streamUdid === undefined ? undefined : devices.find((device) => device.udid === streamUdid)
  /** Open shows a running device, Start boots a stopped one; the server then puts it on screen. */
  const open = (device: SimulatorDevice) => {
    if (device.udid === streamUdid) setBrowsing(false)
    else onAction(device.booted ? 'watch' : 'boot', device.udid)
  }
  return { devices, shown, stream: shown === undefined ? undefined : stream, open, browse: () => setBrowsing(true) }
}

/** The room the screen has, followed as the panel resizes. */
function useRoom() {
  const room = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = room.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { room, size }
}

/** The live screen: the helper's JPEG stream as a picture, with touch and keys over its input socket. */
function SimulatorScreen({ stream, onStale, compact = false }: {
  stream: Stream
  /** The stream or its socket dropped, which is most often an expired path: ask for a fresh one. */
  onStale: () => void
  compact?: boolean
}) {
  const socket = useRef<WebSocket | null>(null)
  const [orientation, setOrientation] = useState<string>()
  // The framebuffer's own size, from the helper or else from the first picture.
  const [frame, setFrame] = useState<{ width: number; height: number }>()
  const touching = useRef(false)
  const image = useRef<HTMLImageElement>(null)
  const { room, size } = useRoom()
  const helper = `${stream.base}/helper/${stream.udid}`
  // A streaming picture taken out of the page keeps its connection open in Chromium, so
  // the source is set and emptied here: emptying it is what ends the stream on close.
  const source = `${helper}/stream.mjpeg`
  useEffect(() => {
    const element = image.current
    if (!element) return
    element.src = source
    return () => { element.removeAttribute('src') }
  }, [source])

  useEffect(() => {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${scheme}://${window.location.host}${helper}/ws`)
    ws.binaryType = 'arraybuffer'
    socket.current = ws
    ws.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return
      const config = decodeScreenConfig(event.data)
      if (config) {
        setOrientation(config.orientation)
        if (config.width > 0 && config.height > 0) setFrame({ width: config.width, height: config.height })
      }
    }
    ws.onclose = () => {
      if (socket.current !== ws) return
      socket.current = null
      onStale()
    }
    return () => {
      socket.current = null
      ws.close()
    }
  }, [helper, onStale])

  const send = (tag: number, body: object) => {
    const ws = socket.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(encodeInput(tag, body))
  }

  const turn = frame === undefined ? 0 : screenTurn(orientation, frame)
  const drawn = frame === undefined ? undefined : fittedScreen(size, frame, turn)
  const sideways = turn === 90 || turn === -90
  const point = (event: PointerEvent<HTMLDivElement>, clamp: boolean) =>
    drawn === undefined ? null : screenPoint(event.currentTarget.getBoundingClientRect(), turn, event.clientX, event.clientY, clamp)
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const at = point(event, false)
    if (at === null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.focus()
    touching.current = true
    send(INPUT_TAG.touch, { type: 'begin', ...at })
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!touching.current) return
    const at = point(event, true)
    if (at !== null) send(INPUT_TAG.touch, { type: 'move', ...at })
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!touching.current) return
    touching.current = false
    const at = point(event, true)
    if (at !== null) send(INPUT_TAG.touch, { type: 'end', ...at })
  }
  // Typing goes to the device while the screen has focus; ⌘ shortcuts stay with Manor.
  const onKey = (type: 'down' | 'up') => (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey) return
    const usage = hidUsage(event.code)
    if (usage === undefined) return
    event.preventDefault()
    send(INPUT_TAG.key, { type, usage })
  }

  return (
    <div className={`flex min-h-0 flex-1 flex-col items-center gap-2 ${compact ? 'h-[440px]' : ''}`}>
      <div ref={room} className="flex min-h-0 w-full flex-1 items-center justify-center">
        <div
          tabIndex={0}
          role="application"
          aria-label="Simulator screen. Click to tap, drag to swipe, type while focused."
          onKeyDown={onKey('down')}
          onKeyUp={onKey('up')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={drawn === undefined ? undefined : { width: drawn.width, height: drawn.height }}
          className="relative touch-none select-none overflow-hidden rounded-[18px] outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <img
            ref={image}
            alt="Simulator screen"
            draggable={false}
            onError={onStale}
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget
              if (width > 0 && height > 0) setFrame((current) => current ?? { width, height })
            }}
            style={drawn === undefined ? undefined : {
              width: sideways ? drawn.height : drawn.width,
              height: sideways ? drawn.width : drawn.height,
              transform: `translate(-50%, -50%) rotate(${turn}deg)`,
            }}
            className={drawn === undefined ? 'block max-h-full max-w-full' : 'absolute left-1/2 top-1/2 block max-w-none'}
          />
        </div>
      </div>
      <div className="flex items-center gap-1">
        <IconButton icon={Home01Icon} label="Home" onClick={() => send(INPUT_TAG.button, { button: 'home' })} />
        <IconButton icon={RotateClockwiseIcon} label="Rotate" onClick={() => send(INPUT_TAG.orientation, { orientation: nextOrientation(orientation) })} />
      </div>
    </div>
  )
}

/**
 * The body both surfaces share: what is missing, the device list, or the live screen.
 */
function SimulatorBody({ state, view, selection, connected, onAction, compact = false }: {
  state: SimulatorState | null
  view: ReturnType<typeof useSimulatorView>
  selection: SimulatorSelection
  connected: boolean
  onAction: (action: SimulatorAction, udid?: string) => boolean
  compact?: boolean
}) {
  const { shown, stream } = view
  // A dropped stream asks for a fresh path at most once a minute; a drop sooner than that
  // stays dropped, with Try again, so a helper that keeps failing is not asked forever.
  const lastRetry = useRef(0)
  const [dropped, setDropped] = useState(false)
  useEffect(() => { setDropped(false) }, [stream?.base, stream?.udid])
  const onStale = useCallback(() => {
    if (stream === undefined) return
    if (Date.now() - lastRetry.current < STALE_RETRY_MS || !onAction('watch', stream.udid)) {
      setDropped(true)
      return
    }
    lastRetry.current = Date.now()
  }, [stream, onAction])

  const note = (text: string, action?: { label: string; run: () => void }) => (
    <div className="flex flex-col items-start gap-2 px-3.5 py-6">
      <span className="text-dim">{text}</span>
      {action ? <Button variant="secondary" size="compact" disabled={!connected} onClick={action.run}>{action.label}</Button> : null}
    </div>
  )

  if (state === null) return note('Looking for simulators…')
  if (state.status === 'off') return note('Turn on the iOS Simulator in Settings, Browser & Simulator.')
  if (state.status === 'unavailable') return note(state.detail ?? 'The iOS Simulator is not available on this Mac.')
  if (shown === undefined || stream === undefined) return <DeviceList state={state} view={view} selection={selection} connected={connected} compact={compact} />
  if (dropped) return note('The screen stopped.', { label: 'Try again', run: () => onAction('watch', shown.udid) })
  return <div className={`min-h-0 p-3 ${compact ? '' : 'flex flex-col'}`}><SimulatorScreen stream={stream} onStale={onStale} compact={compact} /></div>
}

/**
 * Every simulator the user picked in Settings, plus any that runs: one row each with
 * its state and one button, Open for a running device and Start for a stopped one.
 */
function DeviceList({ state, view, selection, connected, compact }: {
  state: SimulatorState
  view: ReturnType<typeof useSimulatorView>
  selection: SimulatorSelection
  connected: boolean
  /** The floating card has no panel height to fill, so its list scrolls at the screen's height. */
  compact: boolean
}) {
  const groups = panelGroups(view.devices, selection)
  const grouped = groups.length > 1
  // An error about no device, or about one without a row here, shows above the list.
  const rowError = groups.some((group) => group.devices.some((device) => device.udid === state.errorUdid))
  const failure = state.error !== undefined && !rowError ? <p className="m-0 px-0.5 text-label text-danger" role="status">{state.error}</p> : null
  const note = (text: string) => <div className="flex flex-col gap-3 px-3.5 py-6">{failure}<p className="m-0 text-dim">{text}</p></div>
  if (view.devices.length === 0) return note('No iOS simulators found. Add one in Xcode, under Window, Devices and Simulators.')
  if (groups.length === 0) return note('No simulators are picked for this list. Pick them in Settings, Browser & Simulator.')
  const pending = state.pending
  return (
    <div className={`flex min-h-0 flex-col gap-4 overflow-y-auto p-3 ${compact ? 'max-h-[440px]' : ''}`}>
      {failure}
      {groups.map((group) => (
        <section key={group.runtime} aria-label={group.runtime} className="flex flex-col gap-1.5">
          {grouped ? <h3 className="m-0 pl-0.5 text-meta font-medium text-dim">{group.runtime}</h3> : null}
          {/* The same card as the switches in an agent's settings: one surface, a hairline between rows. */}
          <ul className="m-0 list-none overflow-hidden rounded-lg border border-line bg-surface-2 p-0 [&>*+*]:border-t [&>*+*]:border-line">
            {group.devices.map((device) => {
              const step = pending?.udid === device.udid ? pending.step : undefined
              const error = state.errorUdid === device.udid ? state.error : undefined
              return (
                <li key={device.udid} className="flex items-center gap-3 px-3.5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-card text-text">{device.name}</div>
                    <div className="flex min-w-0 items-center gap-1.5 text-meta text-dim">
                      {step === undefined ? null : <Icon icon={LoaderCircleIcon} size={12} className="shrink-0 motion-safe:animate-spin-calm" />}
                      <span className="truncate">
                        {grouped ? '' : `${device.runtime} · `}
                        {step === undefined ? (device.booted ? 'Running' : 'Stopped') : PENDING_LABEL[step]}
                      </span>
                    </div>
                    {error === undefined ? null : <p className="m-0 mt-0.5 break-words text-meta text-danger" role="status">{error}</p>}
                  </div>
                  <Button
                    variant="secondary"
                    size="compact"
                    aria-label={`${device.booted ? 'Open' : 'Start'} ${device.name}, ${device.runtime}`}
                    disabled={!connected || pending !== undefined}
                    onClick={() => view.open(device)}
                  >
                    {device.booted ? 'Open' : 'Start'}
                  </Button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

interface SimulatorPanelProps {
  state: SimulatorState | null
  /** Settings → Simulator's pick of devices for the list. */
  selection: SimulatorSelection
  connected: boolean
  onAction: (action: SimulatorAction, udid?: string) => boolean
  width: number
  overlay?: boolean
  revealed?: boolean
  resizing: boolean
  resizeProps: ComponentPropsWithoutRef<'div'>
  /** Absent where the screen cannot float, such as a split stage. */
  onFloat?: () => void
  onClose: () => void
}

/**
 * The iOS Simulator beside a Session. One simulator on the Mac, and every panel views
 * the same device. Closing the panel ends its stream; the device keeps running.
 */
export function SimulatorPanel({ state, selection, connected, onAction, width, overlay = false, revealed = true, resizing, resizeProps, onFloat, onClose }: SimulatorPanelProps) {
  const view = useSimulatorView(state, connected, onAction)
  const shown = view.shown
  return (
    <aside
      style={{ '--side-width': `${width}px` } as CSSProperties}
      data-open={overlay ? revealed : undefined}
      className={`grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] ${DOCK_PANEL_SHELL} ${dockPanelLayoutClass('w-[calc(var(--side-width)-8px)]', false, overlay)}`}
      aria-label="Simulator"
    >
      <div
        {...resizeProps}
        className="group absolute inset-y-0 left-0 z-30 w-2 touch-none cursor-col-resize outline-none max-[760px]:hidden"
      >
        <div
          className={`pointer-events-none absolute inset-y-0 left-[3px] w-0.5 bg-primary transition-opacity duration-150 group-hover:opacity-40 group-focus-visible:opacity-60 ${
            resizing ? 'opacity-60' : 'opacity-0'
          }`}
        />
      </div>
      <div className="flex h-11 min-w-0 items-center justify-between gap-2 border-b border-line px-3.5 pr-2">
        {shown === undefined ? (
          <h2 className="m-0 text-label font-medium text-muted">Simulator</h2>
        ) : (
          <div className="-ml-2 flex min-w-0 items-center gap-1">
            <IconButton icon={ArrowLeft01Icon} label="All simulators" onClick={view.browse} />
            <h2 className="m-0 truncate text-label font-medium text-muted">{shown.name}</h2>
          </div>
        )}
        <div className="flex shrink-0 items-center">
          {shown === undefined ? null : (
            <IconButton icon={PowerIcon} label={`Turn off ${shown.name}`} disabled={!connected} onClick={() => onAction('shutdown', shown.udid)} />
          )}
          {view.stream !== undefined && onFloat ? <IconButton icon={PictureInPictureOnIcon} label="Float over chat" onClick={onFloat} /> : null}
          <IconButton icon={Cancel01Icon} label="Hide simulator" onClick={onClose} />
        </div>
      </div>
      <SimulatorBody state={state} view={view} selection={selection} connected={connected} onAction={onAction} />
    </aside>
  )
}

/**
 * The same screen floated over the chat, only ever by the panel's Float. Docking it
 * again opens the panel; closing it ends the stream and leaves the device running.
 */
export function SimulatorFloat({ state, selection, connected, onAction, onDock, onClose }: {
  state: SimulatorState | null
  selection: SimulatorSelection
  connected: boolean
  onAction: (action: SimulatorAction, udid?: string) => boolean
  onDock: () => void
  onClose: () => void
}) {
  const view = useSimulatorView(state, connected, onAction)
  return (
    <div className={`pointer-events-auto w-[280px] ${DOCK_PANEL_SHELL} shadow-lg`} aria-label="Floating simulator">
      <div className="flex h-10 items-center justify-between gap-2 border-b border-line pl-3 pr-1.5">
        <span className="min-w-0 truncate text-label font-medium text-muted">{view.shown?.name ?? 'Simulator'}</span>
        <div className="flex shrink-0 items-center">
          <IconButton icon={PictureInPictureOnIcon} label="Dock simulator" onClick={onDock} />
          <IconButton icon={Cancel01Icon} label="Close floating simulator" onClick={onClose} />
        </div>
      </div>
      <SimulatorBody state={state} view={view} selection={selection} connected={connected} onAction={onAction} compact />
    </div>
  )
}
