import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { Cancel01Icon, Home01Icon, PictureInPictureOnIcon, PowerIcon, RotateClockwiseIcon } from '@hugeicons/core-free-icons'
import type { SimulatorAction, SimulatorState } from '@manor/contracts'
import { decodeScreenConfig, encodeInput, fittedScreen, hidUsage, INPUT_TAG, nextOrientation, screenPoint, screenTurn } from '../simulatorInput'
import { Button } from './ui/Button'
import { DOCK_PANEL_SHELL, dockPanelLayoutClass } from './ui/dockPanel'
import { IconButton } from './ui/IconButton'
import { Select } from './ui/Select'

type Stream = NonNullable<SimulatorState['stream']>

const STALE_RETRY_MS = 60_000

const PENDING_LABEL = { booting: 'Starting the simulator…', installing: 'Downloading the screen helper…', starting: 'Opening the screen…' } as const

/**
 * What the panel and the floating card show, from the one simulator state the server
 * broadcasts. Every panel watches the same device, so the screen follows the server:
 * picking another device asks the server to switch, and every open panel switches.
 * Only a device that is off is a local pick, for its Start button.
 */
function useSimulatorView(state: SimulatorState | null, connected: boolean, onAction: (action: SimulatorAction, udid?: string) => boolean) {
  const [picked, setPicked] = useState<string | null>(null)
  const streamUdid = state?.stream?.udid
  // A device came on screen, here or from another panel: follow it. A device that went
  // off stays picked, so the panel offers to start it rather than jumping to another.
  useEffect(() => { if (streamUdid !== undefined) setPicked(null) }, [streamUdid])
  // Nothing on screen yet and a device is running: watch it. One request per device and
  // connection, so a refusal stands as an error instead of being asked again forever.
  const asked = useRef<string | null>(null)
  // Opening the panel, or the connection coming back, refreshes the device list. A new
  // connection may follow a server restart that dropped the stream, so it asks afresh.
  useEffect(() => {
    if (!connected) return
    asked.current = null
    onAction('list')
  }, [connected, onAction])

  const devices = state?.status === 'ready' ? state.devices : []
  const firstBooted = devices.find((device) => device.booted)
  const shownUdid = picked ?? streamUdid ?? firstBooted?.udid ?? devices[0]?.udid
  const shown = devices.find((device) => device.udid === shownUdid)
  const pending = state?.pending
  useEffect(() => {
    if (streamUdid !== undefined || pending !== undefined || firstBooted === undefined || picked !== null) return
    if (asked.current === firstBooted.udid) return
    if (onAction('watch', firstBooted.udid)) asked.current = firstBooted.udid
  }, [streamUdid, pending, firstBooted, picked, connected, onAction])

  const pick = (udid: string) => {
    const device = devices.find((candidate) => candidate.udid === udid)
    if (device === undefined || udid === shownUdid) return
    setPicked(udid)
    if (device.booted) onAction('watch', udid)
  }
  const turnOff = (udid: string) => {
    setPicked(udid)
    onAction('shutdown', udid)
  }
  return { devices, shown, pick, turnOff, stream: state?.stream?.udid === shown?.udid ? state?.stream : undefined }
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
 * The body both surfaces share: what is missing, the device that is off, the step that
 * is running, or the live screen.
 */
function SimulatorBody({ state, view, connected, onAction, compact = false }: {
  state: SimulatorState | null
  view: ReturnType<typeof useSimulatorView>
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
  if (state.status === 'off') return note('Turn on the iOS Simulator in Settings, General.')
  if (state.status === 'unavailable') return note(state.detail ?? 'The iOS Simulator is not available on this Mac.')
  if (shown === undefined) return note('No iOS simulators found. Add one in Xcode, under Window, Devices and Simulators.')
  if (state.pending?.udid === shown.udid) return note(PENDING_LABEL[state.pending.step])
  if (!shown.booted) return note(`${shown.name} is off.`, { label: 'Start', run: () => onAction('boot', shown.udid) })
  if (state.error && stream === undefined) return note(state.error, { label: 'Try again', run: () => onAction('watch', shown.udid) })
  if (stream === undefined) return note('Opening the screen…')
  if (dropped) return note('The screen stopped.', { label: 'Try again', run: () => onAction('watch', shown.udid) })
  return <div className={`min-h-0 p-3 ${compact ? '' : 'flex flex-col'}`}><SimulatorScreen stream={stream} onStale={onStale} compact={compact} /></div>
}

function DevicePicker({ view, disabled }: { view: ReturnType<typeof useSimulatorView>; disabled: boolean }) {
  if (view.devices.length === 0) return <h2 className="m-0 text-label font-medium text-muted">Simulator</h2>
  return (
    <div className="min-w-0 max-w-[260px] flex-1">
      <Select
        label="Simulator device"
        value={view.shown?.udid ?? ''}
        options={view.devices.map((device) => ({
          value: device.udid,
          label: `${device.name} · ${device.runtime}${device.booted ? ' · On' : ''}`,
        }))}
        disabled={disabled}
        onChange={view.pick}
      />
    </div>
  )
}

interface SimulatorPanelProps {
  state: SimulatorState | null
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
export function SimulatorPanel({ state, connected, onAction, width, overlay = false, revealed = true, resizing, resizeProps, onFloat, onClose }: SimulatorPanelProps) {
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
        <DevicePicker view={view} disabled={!connected || state?.pending !== undefined} />
        <div className="flex shrink-0 items-center">
          {shown?.booted === true ? (
            <IconButton icon={PowerIcon} label={`Turn off ${shown.name}`} disabled={!connected} onClick={() => view.turnOff(shown.udid)} />
          ) : null}
          {view.stream !== undefined && onFloat ? <IconButton icon={PictureInPictureOnIcon} label="Float over chat" onClick={onFloat} /> : null}
          <IconButton icon={Cancel01Icon} label="Hide simulator" onClick={onClose} />
        </div>
      </div>
      <SimulatorBody state={state} view={view} connected={connected} onAction={onAction} />
    </aside>
  )
}

/**
 * The same screen floated over the chat, only ever by the panel's Float. Docking it
 * again opens the panel; closing it ends the stream and leaves the device running.
 */
export function SimulatorFloat({ state, connected, onAction, onDock, onClose }: {
  state: SimulatorState | null
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
      <SimulatorBody state={state} view={view} connected={connected} onAction={onAction} compact />
    </div>
  )
}
