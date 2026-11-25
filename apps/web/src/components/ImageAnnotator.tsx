import { Cancel01Icon, CircleIcon, Pen01Icon, PinLocation01Icon, SquareIcon, Undo02Icon } from '@hugeicons/core-free-icons'
import { MAX_IMAGE_COMMENT_CHARS, MAX_IMAGE_PINS, MAX_IMAGE_STROKES, MAX_STROKE_POINTS, numberedMarks } from '@manor/contracts'
import { motion, useReducedMotion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { markAnchor, type ImageMarks, type ImageShape } from '../imageMarks'
import { INSTANT, POPOVER_IN, POPOVER_OUT, POPOVER_PRE_SCALE } from '../motion'
import { Icon } from './Icon'
import { Button } from './ui/Button'

type Tool = 'pin' | 'frame' | 'circle' | 'pen'
type Selection = { kind: 'pin' | 'shape'; index: number } | null
/** A comment row, named by its mark: `pin:0`, `shape:2`. */
type RowKey = `${'pin' | 'shape'}:${number}`
const rowKey = (kind: 'pin' | 'shape', index: number): RowKey => `${kind}:${index}`

const TOOLS: readonly { tool: Tool; label: string; icon: typeof PinLocation01Icon }[] = [
  { tool: 'pin', label: 'Pin', icon: PinLocation01Icon },
  { tool: 'frame', label: 'Frame', icon: SquareIcon },
  { tool: 'circle', label: 'Circle', icon: CircleIcon },
  { tool: 'pen', label: 'Pen', icon: Pen01Icon },
]

/** What a click with a shape tool draws when it is not dragged open. */
const DEFAULT_SHAPE = { w: 0.24, h: 0.14 }
/** A drag smaller than this is a click. */
const MIN_SHAPE = 0.015
/** The pen keeps a point only once the pointer has moved this far, as a share of the picture. */
const MIN_STROKE_STEP = 0.003
/** Four decimals place a point within a pixel on any picture Manor sends, at a third of the bytes. */
const share = (value: number) => Math.round(value * 10_000) / 10_000
/** What the window keeps above the editor: the top bar and a margin. */
const TOP_CLEARANCE = 56
/** Room above the composer the editor needs before it stands there instead of over it. */
const ROOM_ABOVE = 380
/** The editor's own chrome around the picture: padding and the tool row. */
const CHROME = 72
const MAX_PICTURE_HEIGHT = 420
/** Below this width the comments go under the picture instead of beside it. */
const SIDE_BY_SIDE = 560
/** The comments, hint and actions when they sit under the picture. */
const STACKED_COMMENTS = 200

/**
 * Where the editor stands and how tall its picture may be. Above the composer when
 * there is room, as in a chat whose composer sits at the bottom; over it when the
 * composer sits high, as on the new-Session stage, so the picture never leaves the window.
 */
function useFit(rootRef: RefObject<HTMLDivElement | null>) {
  const [fit, setFit] = useState({ over: false, stacked: false, picture: MAX_PICTURE_HEIGHT })
  useLayoutEffect(() => {
    const parent = rootRef.current?.offsetParent
    if (!parent) return
    const measure = () => {
      const host = parent.getBoundingClientRect()
      const stacked = host.width < SIDE_BY_SIDE
      const above = host.top - TOP_CLEARANCE - 8
      const over = above < ROOM_ABOVE
      const room = (over ? host.bottom - TOP_CLEARANCE : above) - CHROME - (stacked ? STACKED_COMMENTS : 0)
      setFit({ over, stacked, picture: Math.max(160, Math.min(MAX_PICTURE_HEIGHT, room)) })
    }
    measure()
    // A side panel opening narrows the composer without resizing the window.
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [rootRef])
  return fit
}

const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value))

/** How far from a shape's line, in screen pixels, a press still grabs the shape. */
const OUTLINE_REACH = 10

/** Whether a press on a shape lands on its drawn line rather than the area inside. */
function onOutline(event: ReactPointerEvent<HTMLElement>, kind: ImageShape['kind']): boolean {
  const box = event.currentTarget.getBoundingClientRect()
  const x = event.clientX - box.left
  const y = event.clientY - box.top
  if (kind === 'frame') return Math.min(x, y, box.width - x, box.height - y) <= OUTLINE_REACH
  const rx = box.width / 2
  const ry = box.height / 2
  // A shape this thin is all outline.
  if (Math.min(rx, ry) <= OUTLINE_REACH) return true
  const dx = x - rx
  const dy = y - ry
  const share = Math.hypot(dx / Math.max(1, rx), dy / Math.max(1, ry))
  if (share === 0) return false
  // Pixels to the line along the ray from the centre: exact on a circle, close on an ellipse.
  return Math.hypot(dx, dy) * Math.abs(1 - 1 / share) <= OUTLINE_REACH
}

type Drag =
  | { kind: 'pin'; index: number; dx: number; dy: number; before: ImageMarks; moved: boolean }
  | { kind: 'shape'; index: number; dx: number; dy: number; before: ImageMarks; moved: boolean }
  | { kind: 'create'; index: number; ax: number; ay: number; before: ImageMarks; moved: boolean }
  | { kind: 'stroke'; index: number; before: ImageMarks; moved: boolean }

/**
 * The editor over the composer where the user points at a picture: numbered pins with
 * a comment each, frames or circles around an area, and freehand lines. Positions are shares of the
 * picture, so they mean the same at any size it is drawn or read at. It holds the marks
 * until Done hands them back; Cancel drops every change.
 */
export function ImageAnnotator({ src, name, initial, onCancel, onDone, note }: {
  /** The picture without marks. */
  src: string
  name: string
  initial: ImageMarks
  onCancel: () => void
  onDone: (marks: ImageMarks) => void
  /** Why Done did not go through, shown beside the actions. */
  note?: string | null
}) {
  const reduceMotion = useReducedMotion()
  const [marks, setMarks] = useState(initial)
  const [history, setHistory] = useState<readonly ImageMarks[]>([])
  const [tool, setTool] = useState<Tool>('pin')
  const [selected, setSelected] = useState<Selection>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputs = useRef(new Map<RowKey, HTMLInputElement>())
  const drag = useRef<Drag | null>(null)
  // The row whose field takes the caret after the render that adds its mark.
  const focusRow = useRef<RowKey | null>(null)
  // The row being typed in since its last Undo step, so a run of typing undoes as one.
  const typedRow = useRef<RowKey | null>(null)
  const numbered = numberedMarks(marks)
  const numbers = new Map(numbered.map((mark) => [rowKey(mark.kind === 'pin' ? 'pin' : 'shape', mark.index), mark.number]))
  const rows = [
    ...marks.pins.map((_, index) => ({ key: rowKey('pin', index), kind: 'pin' as const, index })),
    ...marks.shapes.map((_, index) => ({ key: rowKey('shape', index), kind: 'shape' as const, index })),
  ]

  const focusInput = (key: RowKey) => {
    const row = inputs.current.get(key)
    row?.focus({ preventScroll: true })
    row?.scrollIntoView({ block: 'nearest' })
  }
  const fit = useFit(rootRef)

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  useLayoutEffect(() => {
    if (focusRow.current === null) return
    focusInput(focusRow.current)
    focusRow.current = null
  })

  const commit = (before: ImageMarks, next: ImageMarks) => {
    typedRow.current = null
    setHistory((past) => [...past, before])
    setMarks(next)
  }

  const undo = () => {
    const previous = history.at(-1)
    if (previous === undefined) return
    typedRow.current = null
    setHistory((past) => past.slice(0, -1))
    setMarks(previous)
    setSelected(null)
    // The focused row may be the one undone, so focus stays in the editor for the next ⌘Z.
    rootRef.current?.focus({ preventScroll: true })
  }

  const removePin = (index: number) => {
    commit(marks, { ...marks, pins: marks.pins.filter((_, at) => at !== index) })
    setSelected(null)
  }

  const removeShape = (index: number) => {
    commit(marks, { ...marks, shapes: marks.shapes.filter((_, at) => at !== index) })
    setSelected(null)
  }

  const pointAt = (event: { clientX: number; clientY: number }) => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (rect === undefined || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 }
    return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) }
  }

  const startOnStage = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const { x, y } = pointAt(event)
    stageRef.current?.setPointerCapture(event.pointerId)
    if (tool === 'pen') {
      if (marks.strokes.length >= MAX_IMAGE_STROKES) return
      drag.current = { kind: 'stroke', index: marks.strokes.length, before: marks, moved: false }
      setMarks({ ...marks, strokes: [...marks.strokes, [[share(x), share(y)]]] })
      setSelected(null)
      return
    }
    if (tool === 'pin') {
      if (marks.pins.length >= MAX_IMAGE_PINS) return
      const index = marks.pins.length
      commit(marks, { ...marks, pins: [...marks.pins, { x, y, comment: '' }] })
      setSelected({ kind: 'pin', index })
      focusRow.current = rowKey('pin', index)
      return
    }
    if (marks.shapes.length >= MAX_IMAGE_PINS) return
    const index = marks.shapes.length
    drag.current = { kind: 'create', index, ax: x, ay: y, before: marks, moved: false }
    setMarks({ ...marks, shapes: [...marks.shapes, { kind: tool, x, y, w: 0, h: 0 }] })
    setSelected({ kind: 'shape', index })
  }

  const startOnMark = (event: ReactPointerEvent<HTMLElement>, kind: 'pin' | 'shape', index: number) => {
    // The pen draws over every mark; only the other tools pick one up.
    if (event.button !== 0 || tool === 'pen') return
    // Only a shape's outline takes hold of it; inside it the stage places and draws as usual.
    if (kind === 'shape' && !onOutline(event, marks.shapes[index]?.kind ?? 'frame')) return
    event.preventDefault()
    event.stopPropagation()
    const { x, y } = pointAt(event)
    const mark = kind === 'pin' ? marks.pins[index] : marks.shapes[index]
    if (mark === undefined) return
    stageRef.current?.setPointerCapture(event.pointerId)
    drag.current = { kind, index, dx: x - mark.x, dy: y - mark.y, before: marks, moved: false }
    setSelected({ kind, index })
  }

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (current === null) return
    const { x, y } = pointAt(event)
    current.moved = true
    if (current.kind === 'stroke') {
      setMarks((value) => ({
        ...value,
        strokes: value.strokes.map((stroke, at) => {
          const last = stroke.at(-1)
          if (at !== current.index || stroke.length >= MAX_STROKE_POINTS) return stroke
          if (last !== undefined && Math.hypot(x - last[0], y - last[1]) < MIN_STROKE_STEP) return stroke
          return [...stroke, [share(x), share(y)]]
        }),
      }))
    } else if (current.kind === 'pin') {
      setMarks((value) => ({ ...value, pins: value.pins.map((pin, at) => (at === current.index ? { ...pin, x: clamp(x - current.dx), y: clamp(y - current.dy) } : pin)) }))
    } else if (current.kind === 'shape') {
      setMarks((value) => ({
        ...value,
        shapes: value.shapes.map((shape, at) => (at === current.index
          ? { ...shape, x: clamp(x - current.dx, 0, 1 - shape.w), y: clamp(y - current.dy, 0, 1 - shape.h) }
          : shape)),
      }))
    } else {
      const shape: Pick<ImageShape, 'x' | 'y' | 'w' | 'h'> = {
        x: Math.min(current.ax, x), y: Math.min(current.ay, y), w: Math.abs(x - current.ax), h: Math.abs(y - current.ay),
      }
      setMarks((value) => ({ ...value, shapes: value.shapes.map((each, at) => (at === current.index ? { ...each, ...shape } : each)) }))
    }
  }

  const end = () => {
    const current = drag.current
    drag.current = null
    if (current === null) return
    if (current.kind === 'stroke') {
      typedRow.current = null
      setHistory((past) => [...past, current.before])
      return
    }
    if (current.kind === 'create') {
      // A click without a drag draws the default size around the point.
      setMarks((value) => ({
        ...value,
        shapes: value.shapes.map((shape, at) => {
          if (at !== current.index || (shape.w >= MIN_SHAPE && shape.h >= MIN_SHAPE)) return shape
          const w = DEFAULT_SHAPE.w
          const h = DEFAULT_SHAPE.h
          return { ...shape, x: clamp(current.ax - w / 2, 0, 1 - w), y: clamp(current.ay - h / 2, 0, 1 - h), w, h }
        }),
      }))
      typedRow.current = null
      setHistory((past) => [...past, current.before])
      focusRow.current = rowKey('shape', current.index)
      return
    }
    if (current.moved) {
      typedRow.current = null
      setHistory((past) => [...past, current.before])
    } else focusInput(rowKey(current.kind, current.index))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const typing = event.target instanceof HTMLInputElement
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      event.stopPropagation()
      onDone(marks)
    } else if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
      // Undo is the editor's in a comment field too: a typing run is one of its steps,
      // and a field that was only focused (a mark just placed) undoes that mark.
      event.preventDefault()
      undo()
    } else if (!typing && (event.key === 'Backspace' || event.key === 'Delete') && selected !== null) {
      event.preventDefault()
      if (selected.kind === 'pin') removePin(selected.index)
      else removeShape(selected.index)
    }
  }

  const setComment = (kind: 'pin' | 'shape', index: number, comment: string) => {
    const key = rowKey(kind, index)
    if (typedRow.current !== key) {
      typedRow.current = key
      setHistory((past) => [...past, marks])
    }
    setMarks((value) => (kind === 'pin'
      ? { ...value, pins: value.pins.map((pin, each) => (each === index ? { ...pin, comment } : pin)) }
      : { ...value, shapes: value.shapes.map((shape, each) => (each === index ? { ...shape, comment } : shape)) }))
  }

  return (
    <motion.div
      ref={rootRef}
      role="dialog"
      aria-label={`Mark up ${name}`}
      tabIndex={-1}
      data-image-annotator=""
      className={`absolute right-0 left-0 z-[6] rounded-panel border border-line surface-floating p-3 shadow-popover outline-none ${fit.over ? 'bottom-0' : 'bottom-[calc(100%+8px)]'}`}
      style={{ transformOrigin: 'bottom center' }}
      initial={reduceMotion ? false : { opacity: 0, scale: POPOVER_PRE_SCALE }}
      animate={{ opacity: 1, scale: 1, transition: reduceMotion ? INSTANT : POPOVER_IN }}
      exit={{ opacity: 0, scale: reduceMotion ? 1 : POPOVER_PRE_SCALE, transition: reduceMotion ? INSTANT : POPOVER_OUT }}
      onKeyDown={onKeyDown}
    >
      <div className={`flex gap-4 ${fit.stacked ? 'flex-col' : ''}`}>
        {/* Side by side, the picture's column hugs the picture and the comments take the rest. */}
        <div className={`flex min-w-0 flex-col gap-2 ${fit.stacked ? '' : 'flex-[0_1_auto]'}`}>
          <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Marks">
            {TOOLS.map((each) => (
              <Button
                key={each.tool}
                size="compact"
                variant={tool === each.tool ? 'primary' : 'ghost'}
                aria-pressed={tool === each.tool}
                className="flex items-center gap-1.5"
                onClick={() => setTool(each.tool)}
              >
                <Icon icon={each.icon} size={14} />
                {each.label}
              </Button>
            ))}
            <Button size="compact" variant="ghost" className="ml-auto flex items-center gap-1.5" disabled={history.length === 0} onClick={undo} aria-label="Undo">
              <Icon icon={Undo02Icon} size={14} />
            </Button>
          </div>
          <div className="flex justify-center overflow-hidden rounded-lg bg-bg">
            <div
              ref={stageRef}
              data-annotator-stage=""
              className={`relative inline-block touch-none select-none ${tool === 'pin' || tool === 'pen' ? 'cursor-crosshair' : 'cursor-cell'}`}
              onPointerDown={startOnStage}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
            >
              <img src={src} alt={name} draggable={false} className="block max-w-full" style={{ maxHeight: fit.picture }} />
              {marks.strokes.length === 0 ? null : (
                // Drawn in shares of the picture; the line keeps its width however the picture is scaled.
                <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 1 1" preserveAspectRatio="none" data-annotator-strokes={marks.strokes.length}>
                  {marks.strokes.map((stroke, index) => (
                    <path
                      key={`stroke-${index}`}
                      d={`M${stroke.map(([x, y]) => `${x} ${y}`).join('L')}${stroke.length === 1 ? 'h0' : ''}`}
                      className="fill-none stroke-mark"
                      strokeWidth={3}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </svg>
              )}
              {marks.shapes.map((shape, index) => {
                const isSelected = selected?.kind === 'shape' && selected.index === index
                const number = numbers.get(rowKey('shape', index))
                return (
                  <div
                    key={`shape-${index}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${shape.kind === 'frame' ? 'Frame' : 'Circle'} ${index + 1}${number === undefined ? '' : `, number ${number}`}`}
                    aria-pressed={isSelected}
                    onFocus={() => setSelected({ kind: 'shape', index })}
                    data-annotator-shape={shape.kind}
                    className={`absolute cursor-move border-[2.5px] border-mark ${shape.kind === 'circle' ? 'rounded-[50%]' : 'rounded-md'} ${isSelected ? 'outline-2 outline-offset-2 outline-mark/50' : ''}`}
                    style={{ left: `${shape.x * 100}%`, top: `${shape.y * 100}%`, width: `${shape.w * 100}%`, height: `${shape.h * 100}%` }}
                    onPointerDown={(event) => startOnMark(event, 'shape', index)}
                  >
                    {isSelected ? (
                      <button
                        type="button"
                        aria-label={`Remove ${shape.kind}`}
                        className="absolute -top-2.5 -right-2.5 grid h-5 w-5 cursor-pointer place-items-center rounded-full border-0 bg-media-scrim p-0 text-on-media"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => removeShape(index)}
                      >
                        <Icon icon={Cancel01Icon} size={11} />
                      </button>
                    ) : null}
                  </div>
                )
              })}
              {numbered.flatMap((mark) => {
                if (mark.kind === 'pin') return []
                const anchor = markAnchor(mark)
                return [
                  <span
                    key={`shape-number-${mark.index}`}
                    aria-hidden
                    className="pointer-events-none absolute grid h-[22px] w-[22px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-on-media bg-mark text-[12px] leading-none font-medium text-on-media"
                    // Kept whole inside the picture when the shape touches its edge.
                    style={{ left: `clamp(11px, ${anchor.x * 100}%, calc(100% - 11px))`, top: `clamp(11px, ${anchor.y * 100}%, calc(100% - 11px))` }}
                  >
                    {mark.number}
                  </span>,
                ]
              })}
              {marks.pins.map((pin, index) => {
                const isSelected = selected?.kind === 'pin' && selected.index === index
                return (
                  <button
                    key={`pin-${index}`}
                    type="button"
                    data-annotator-pin={index + 1}
                    aria-label={`Pin ${index + 1}`}
                    onFocus={() => setSelected({ kind: 'pin', index })}
                    className={`absolute grid h-[22px] w-[22px] -translate-x-1/2 -translate-y-1/2 cursor-move place-items-center rounded-full border-2 border-on-media bg-mark p-0 text-[12px] leading-none font-medium text-on-media ${isSelected ? 'outline-2 outline-offset-1 outline-mark' : ''}`}
                    style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
                    onPointerDown={(event) => startOnMark(event, 'pin', index)}
                  >
                    {index + 1}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
        <div className={`flex flex-col ${fit.stacked ? 'w-full' : 'min-w-[240px] flex-1'}`}>
          <h4 className="m-0 mb-2 text-[13px] font-medium text-text">Comments</h4>
          <ol className="m-0 flex list-none flex-col gap-0.5 overflow-y-auto p-0" style={{ maxHeight: fit.stacked ? 96 : fit.picture - 40 }}>
            {rows.map(({ key, kind, index }, at) => {
              const shape = kind === 'shape' ? marks.shapes[index] : undefined
              const comment = (kind === 'pin' ? marks.pins[index]?.comment : shape?.comment) ?? ''
              const number = numbers.get(key)
              const label = shape === undefined ? `pin ${index + 1}` : `${shape.kind} ${index + 1}${number === undefined ? '' : `, number ${number}`}`
              const isSelected = selected?.kind === kind && selected.index === index
              return (
                <li key={key} className={`group/row flex items-center gap-2 rounded-lg p-1.5 ${isSelected ? 'bg-surface-2' : ''}`}>
                  {number === undefined ? (
                    <span className="grid h-[22px] w-[22px] flex-none place-items-center rounded-full border border-mark text-mark">
                      <Icon icon={shape?.kind === 'circle' ? CircleIcon : SquareIcon} size={11} />
                    </span>
                  ) : (
                    <span className="grid h-[22px] w-[22px] flex-none place-items-center rounded-full bg-mark text-[12px] leading-none font-medium text-on-media">{number}</span>
                  )}
                  <input
                    ref={(element) => {
                      if (element === null) inputs.current.delete(key)
                      else inputs.current.set(key, element)
                    }}
                    value={comment}
                    maxLength={MAX_IMAGE_COMMENT_CHARS}
                    placeholder={kind === 'pin' ? 'Add a comment' : 'Optional comment'}
                    aria-label={`Comment for ${label}`}
                    className="min-w-0 flex-1 rounded-md border border-line bg-transparent px-2 py-1 text-[13px] text-text outline-none placeholder:text-dim focus:border-mark"
                    onFocus={() => setSelected({ kind, index })}
                    onBlur={() => {
                      typedRow.current = null
                    }}
                    onChange={(event) => setComment(kind, index, event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' || event.metaKey || event.ctrlKey) return
                      event.preventDefault()
                      const next = rows[at + 1]
                      if (next !== undefined) inputs.current.get(next.key)?.focus()
                    }}
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${label}`}
                    className="grid h-6 w-6 flex-none cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0 text-dim opacity-0 group-hover/row:opacity-100 hover:text-text focus-visible:opacity-100"
                    onClick={() => (kind === 'pin' ? removePin(index) : removeShape(index))}
                  >
                    <Icon icon={Cancel01Icon} size={12} />
                  </button>
                </li>
              )
            })}
          </ol>
          <p className="m-0 mt-2 px-1.5 text-[12px] leading-snug text-dim">
            {marks.pins.length >= MAX_IMAGE_PINS
              ? `Up to ${MAX_IMAGE_PINS} pins per picture.`
              : tool === 'pin'
                ? 'Click the picture to place a pin. Drag a mark to move it.'
                : tool === 'pen'
                  ? 'Draw on the picture. Undo takes back the last line.'
                  : `Drag on the picture to draw a ${tool}. A comment gives it a number.`}
          </p>
          <div className="mt-auto flex flex-col gap-2 pt-3">
            {note ? <p className="m-0 text-[12px] text-danger">{note}</p> : null}
            <div className="flex justify-end gap-2">
              <Button size="small" variant="secondary" onClick={onCancel}>Cancel</Button>
              <Button size="small" variant="primary" onClick={() => onDone(marks)}>Done</Button>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
