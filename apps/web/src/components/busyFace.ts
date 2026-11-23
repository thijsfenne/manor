import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import {
  DOT,
  DOTS_RATE,
  GOO,
  HOP,
  WAKE,
  WORK,
  dotsPlan,
  figure,
  figureAt,
  keyAt,
  loopPlan,
  loopSteps,
  measure,
  moveInfo,
  outline,
  sample,
  smooth,
  walk,
  type EyeKey,
  type EyeShape,
  type Figure,
  type Head,
  type HeadPart,
  type LoopPlan,
  type MoveId,
  type Pair,
  type Step,
} from '@manor/client-runtime/busy-face'

export { MOVE_IDS, moveInfo, type MoveId } from '@manor/client-runtime/busy-face'

/**
 * The working face on the web: the shared loop (see the client runtime's `busyFace`)
 * played with the Web Animations API, because a stop has to know where the face is and
 * walk it home from there, and a CSS animation cannot be asked that.
 *
 * The library's own nodes stay where they are. The head's group takes the body's lean,
 * slide and scale, and its outline is redrawn while the head pitches through its top
 * view, in the library's clip as well, so the clay finish follows. The library's eyes
 * are hidden while the face works; a pair of rounded rects beside them plays the eyes,
 * moving with the body and cut off at the edge of the head.
 */

/** What a busy face plays: the shuffled loop, one of its moves, or the dots she writes behind. */
export interface BusyLook {
  play: 'loop' | 'dots' | MoveId
  /** A single move plays once and the face goes home, instead of again and again. */
  once?: boolean
  /** Playback rate: 1 is as measured. */
  speed: number
  /** Fixes the order of the loop. Absent, every start takes an order of its own. */
  seed?: number
  /**
   * Faces that share a beat play the loop on one schedule, so the same persona in the
   * transcript and in the sidebar makes the same move at the same moment, and writes on
   * all of them when one of them writes. Ignored with a `seed`.
   */
  beat?: string
}

export const BUSY_LOOK: BusyLook = { play: 'loop', speed: 1 }
export const DOTS_LOOK: BusyLook = { play: 'dots', speed: 1 }

const SVG = 'http://www.w3.org/2000/svg'
const node = <K extends keyof SVGElementTagNameMap>(tag: K) => document.createElementNS(SVG, tag)
const still = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const SETTLE: KeyframeAnimationOptions = { duration: 450, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }
/** How long a move that is cut short takes into the next one, and a last small step home, in seconds. */
const HANDOVER = 0.18
const NUDGE = 0.12
let made = 0

/** The controls of one face at work. */
export interface BusyRun {
  setSpeed: (next: number) => void
  /** Hands over to something else to play: the dots when she starts to write, the loop again when she stops. */
  setPlay: (next: BusyLook['play']) => void
  /** What the face is doing now: a move, the dots, or a breath between two moves. */
  playing: () => MoveId | 'dots' | undefined
  /** Walks the face home from wherever it is, then hands it back to the library. */
  stop: () => void
  /** Hands the face back to the library at once, for a face that is leaving the page. */
  off: () => void
}

/** What a face that is rigged for work was drawn from, and how to pick it up again while it walks home. */
interface Rigged {
  parts: HeadPart[]
  middle: Pair
  resume: (look: BusyLook) => BusyRun
}
const rigged = new WeakMap<Element, Rigged>()
/** The rig that holds each slot's face, so a face drawn anew can take the slot from one still walking home on the old nodes. */
const holding = new WeakMap<Element, () => void>()
/** A rate a walk home can end at: a face played at no speed would never get there. */
const rate = (speed: number) => (Number.isFinite(speed) && speed > 0 ? speed : 1)

const shapesOf = (body: Element) => [...body.querySelectorAll<SVGGraphicsElement>(':scope > path, :scope > circle')]
const partOf = (shape: Element): HeadPart =>
  shape.tagName === 'circle' ? { cx: Number(shape.getAttribute('cx')), cy: Number(shape.getAttribute('cy')), r: Number(shape.getAttribute('r')) } : (shape.getAttribute('d') ?? '')

/**
 * The head's own shapes as the library drew them, in its order. Read off the body group,
 * except while a face works: then its shapes are redrawn, wrapped and joined by three
 * dots, and what it was rigged from is the answer.
 */
export const headParts = (body: SVGGElement): HeadPart[] => rigged.get(body)?.parts ?? shapesOf(body).map(partOf)

/**
 * The middle of the head's own shapes. The group's box would also count the clay
 * finish, whose full-box rects only show through the silhouette's clip.
 */
export function bodyMiddle(body: SVGGElement): Pair {
  const known = rigged.get(body)
  if (known) return known.middle
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const shape of shapesOf(body)) {
    const box = shape.getBBox()
    left = Math.min(left, box.x)
    top = Math.min(top, box.y)
    right = Math.max(right, box.x + box.width)
    bottom = Math.max(bottom, box.y + box.height)
  }
  return left === Infinity ? [50, 50] : [(left + right) / 2, (top + bottom) / 2]
}

/** Measuring a face takes a few milliseconds and every face of one silhouette measures the same. */
const measured = new Map<string, Head | undefined>()
function headFor(parts: HeadPart[], eyes: string[]) {
  const key = JSON.stringify([parts, eyes])
  if (!measured.has(key)) {
    if (measured.size >= 64) measured.clear()
    measured.set(key, measure(parts, eyes))
  }
  return measured.get(key)
}

const fixed = (value: number) => value.toFixed(3)

/** The body's place as one transform. Every key writes the same functions, so each is eased by itself. */
const placed = ([cx, cy]: Pair, key: Pick<Figure, 'fit' | 'x' | 'y' | 'lean' | 'scale'>) =>
  `translate(50px, 50px) scale(${key.fit.toFixed(4)}) translate(${fixed(cx + key.x - 50)}px, ${fixed(cy + key.y - 50)}px) rotate(${fixed(key.lean)}deg) scale(${key.scale.toFixed(4)}) translate(${fixed(-cx)}px, ${fixed(-cy)}px)`

/** One eye as a rect's geometry: an ellipse at no roundness, a pill with round ends at full. `lower` is the lip's drop. */
function eyeBox(eye: EyeShape, lower: number) {
  const least = Math.min(eye.a, eye.b)
  return {
    x: `${fixed(eye.x - eye.a)}px`,
    y: `${fixed(eye.y + lower - eye.b)}px`,
    width: `${fixed(2 * eye.a)}px`,
    height: `${fixed(2 * eye.b)}px`,
    rx: `${fixed(eye.a + (least - eye.a) * eye.round)}px`,
    ry: `${fixed(eye.b + (least - eye.b) * eye.round)}px`,
  }
}

/** How far into the melt a face may start to land on a beat's hops, in the plan's seconds, rather than wait a round. */
const CATCH_UP = 0.25

/**
 * The dots she writes behind. The body's shapes are wrapped so they shrink as one,
 * three dots wait beside them in the head colour, and a goo filter on the body group
 * runs whatever touches together. The filter is on only while it blurs, and its
 * contrast follows the blur, so turning it on or off draws nothing different. The
 * working eyes sink into the middle of the body ahead of it.
 */
function melt(body: SVGGElement, [cx, cy]: Pair, eyes: readonly SVGGElement[], pulls: [Pair, Pair], speed: number, follow?: Animation) {
  const wrap = node('g')
  wrap.append(...body.childNodes)
  wrap.style.transformBox = 'view-box'
  wrap.style.transformOrigin = `${cx}px ${cy}px`
  const dots = [0, 1, 2].map(() => {
    const dot = node('circle')
    dot.setAttribute('cx', String(cx))
    dot.setAttribute('cy', String(cy))
    dot.setAttribute('r', String(DOT.r))
    dot.style.transformBox = 'fill-box'
    dot.style.transformOrigin = 'center'
    dot.style.scale = '0'
    return dot
  })
  const id = `busy-goo-${++made}`
  const defs = node('defs')
  defs.innerHTML = `<filter id="${id}" filterUnits="userSpaceOnUse" x="-20" y="-20" width="140" height="140" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="0"/><feColorMatrix type="matrix"/></filter>`
  const [blurNode, matrix] = [...defs.querySelectorAll('feGaussianBlur, feColorMatrix')]
  body.append(wrap, ...dots, defs)

  let shown = 0
  const setBlur = (value: number) => {
    const next = value < 0.02 ? 0 : Math.round(value * 100) / 100
    if (next === shown) return
    shown = next
    if (next === 0) return body.removeAttribute('filter')
    // The edge sits where the blurred alpha crosses `edge`. Below a half it keeps a small dot
    // from thinning under the blur; at no blur it is a half and the matrix changes nothing.
    const contrast = Math.max(1, 4 * next)
    const edge = 0.5 - 0.15 * Math.min(1, next / GOO)
    blurNode?.setAttribute('stdDeviation', String(next))
    matrix?.setAttribute('values', `1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 ${contrast} ${0.5 - contrast * edge}`)
    body.setAttribute('filter', `url(#${id})`)
  }

  const plan = dotsPlan(pulls)
  const options = { id: 'busy-dots', duration: plan.seconds * 1000, iterations: Infinity }
  const offset = (t: number) => t / plan.seconds
  const loops = [
    wrap.animate(
      plan.body.map((key) => ({ offset: offset(key.t), easing: key.ease, scale: String(key.v) })),
      options,
    ),
    ...dots.map((dot, index) =>
      dot.animate(
        plan.dots[index]!.map((key) => ({ offset: offset(key.t), easing: key.ease, translate: `${key.v.x}px ${key.v.y}px`, scale: String(key.v.s) })),
        options,
      ),
    ),
    ...eyes.map((eye, index) =>
      eye.animate(
        plan.eyes[index]!.map((stop) => ({ offset: offset(stop.t), easing: stop.ease, translate: `${stop.pose.x}px ${stop.pose.y}px`, scale: `${stop.pose.sx} ${stop.pose.sy}` })),
        options,
      ),
    ),
  ]
  const lead = loops[0]!
  for (const loop of loops) loop.playbackRate = speed * DOTS_RATE
  let frame = 0
  let timer = 0
  const halt = () => {
    cancelAnimationFrame(frame)
    window.clearTimeout(timer)
  }
  const tick = () => {
    const t = (lead.effect?.getComputedTiming().progress ?? 0) * plan.seconds
    setBlur(sample(plan.blur, t))
    // The blur only moves around the dots, so between them the tick sleeps instead of
    // waking every frame. Capped, so a speed change is caught within half a second.
    const next = plan.blur.findIndex((key) => key.t > t)
    if (next > 0 && plan.blur[next - 1]!.v === plan.blur[next]!.v) {
      timer = window.setTimeout(tick, Math.min(500, ((plan.blur[next]!.t - t) / Math.abs(lead.playbackRate || 1)) * 1000))
    } else frame = requestAnimationFrame(tick)
  }
  tick()

  // With dots that already hop it lands on their hops: a little into the melt to catch up, or
  // held back for the next round. Once its own dots are out it takes the other face's place in
  // the pass, whole hops on, so the two also swell back and melt again together. It reads the
  // other face once it runs itself, because its first frame can come late while a reply starts.
  const seek = (t: number) => {
    for (const loop of loops) loop.currentTime = t * 1000
    halt()
    tick()
  }
  const there = () => (follow === undefined || follow.playState === 'idle' || lead.playState === 'idle' ? undefined : Number(follow.currentTime) / 1000)
  if (follow) {
    void lead.ready.then(() => {
      const t = there()
      if (t === undefined) return
      const lag = (((t % plan.seconds) % HOP) + HOP) % HOP
      const from = lag <= CATCH_UP ? lag : lag - HOP
      seek(from)
      window.setTimeout(() => {
        const now = there()
        if (now !== undefined) seek(now % plan.seconds)
      }, ((plan.hops - from) / Math.abs(lead.playbackRate || 1)) * 1000)
    }, () => undefined)
  }

  let gone = false
  let leaving: Promise<void> | undefined
  const off = () => {
    if (gone) return
    gone = true
    halt()
    for (const part of [wrap, ...dots, ...eyes]) for (const animation of part.getAnimations()) if (animation.id.startsWith('busy-dots')) animation.cancel()
    wrap.replaceWith(...wrap.childNodes)
    for (const part of [...dots, defs]) part.remove()
    body.removeAttribute('filter')
  }

  return {
    lead,
    setSpeed: (next: number) => {
      for (const loop of loops) loop.updatePlaybackRate(next * DOTS_RATE)
    },
    /** Takes the dots off at once. */
    off,
    /** Swells the body back out of wherever the dots are and pops the eyes back, then takes the dots off. */
    stop: (): Promise<void> => {
      if (leaving) return leaving
      halt()
      if (gone || !body.isConnected) return Promise.resolve(off())
      const read = (part: Element) => {
        const style = getComputedStyle(part)
        return { translate: style.translate === 'none' ? '0px 0px' : style.translate, scale: style.scale === 'none' ? '1' : style.scale }
      }
      const now = [wrap, ...dots, ...eyes].map(read)
      for (const loop of loops) loop.cancel()
      const home = { ...SETTLE, id: 'busy-dots-home' }
      const walks = [
        wrap.animate([{ scale: now[0]!.scale }, { scale: '1' }], home),
        ...dots.map((dot, index) => dot.animate([now[index + 1]!, { translate: '0px 0px', scale: '0' }], home)),
        ...eyes.map((eye, index) => eye.animate([now[index + 4]!, { translate: '0px 0px', scale: '1' }], home)),
      ]
      const from = shown
      const began = performance.now()
      const fade = () => {
        const u = Math.min(1, (performance.now() - began) / 450)
        setBlur(from * (1 - smooth(u)))
        if (u < 1) frame = requestAnimationFrame(fade)
      }
      fade()
      leaving = Promise.all(walks.map((each) => each.finished)).then(off, () => undefined)
      return leaving
    },
  }
}

/** Each start without a seed of its own takes the next order, from somewhere new on every load. */
let turns = Math.floor(Math.random() * 0x10000)

/** A face on a beat: whether it was asked to write, and how to tell it the others changed. */
interface Beater {
  writing: boolean
  sync: () => void
  /** What plays the dots it shows now, if it shows them. */
  melting: () => Animation | undefined
}

/**
 * One schedule of the loop for the faces that share a beat. It starts with the first of
 * them to wake and ends when the last one is home, so the next turn takes a new order.
 */
interface Beat {
  /** When the schedule was at its start, on the page's clock. */
  epoch: number
  seed: number
  rounds: number
  /** The steps planned so far, each with when it starts in the schedule, in seconds. */
  steps: Array<Step & { at: number }>
  faces: Set<Beater>
}
const beats = new Map<string, Beat>()

const beatOf = (key: string) => {
  const known = beats.get(key)
  if (known) return known
  const beat: Beat = { epoch: performance.now(), seed: turns++, rounds: 0, steps: [], faces: new Set() }
  beats.set(key, beat)
  return beat
}

/** The step a beat is in `t` seconds into its schedule, and how far into that step. */
function stepAt(beat: Beat, t: number): { step: Step; into: number } {
  const span = (step: Step) => moveInfo(step.move).seconds + step.rest
  const end = () => {
    const tail = beat.steps[beat.steps.length - 1]
    return tail === undefined ? 0 : tail.at + span(tail)
  }
  while (end() <= t) {
    let at = end()
    for (const step of loopSteps(beat.seed + beat.rounds, beat.steps[beat.steps.length - 1]?.move)) {
      beat.steps.push({ ...step, at })
      at += span(step)
    }
    beat.rounds += 1
  }
  // Steps long past go; a face may still ask a little behind one that looked ahead.
  while (beat.steps.length > 1 && beat.steps[0]!.at + span(beat.steps[0]!) < t - 5) beat.steps.shift()
  let index = beat.steps.length - 1
  while (index > 0 && beat.steps[index]!.at > t) index -= 1
  const { at, ...step } = beat.steps[index]!
  return { step, into: Math.max(0, t - at) }
}

/**
 * Wakes one face into the working pose and plays `look` on it, and returns its controls,
 * or nothing when there is no animated face to move.
 */
function start(host: HTMLElement, first: BusyLook): BusyRun | undefined {
  const bob = host.querySelector<SVGGElement>('.mo-bob')
  const body = host.querySelector<SVGGElement>('.mo-bob > g:not(.mo-eyes)')
  const drawn = host.querySelector<SVGGElement>('.mo-eyes')
  if (bob === null || body === null || drawn === null || typeof body.animate !== 'function' || still()) return undefined
  // A face still on its way home from the last time turns round where it is.
  const known = rigged.get(body)
  if (known) return known.resume(first)
  // One that was walking home on nodes this slot no longer shows has nowhere left to go.
  holding.get(host)?.()

  // Each eye is one shape, drawn up to three times under the clay finish: a lit lip a little lower, the eye, a sheen.
  const pairs = [...drawn.querySelectorAll<SVGGElement>('.mo-eye')].map((eye) => {
    const paths = [...eye.querySelectorAll<SVGPathElement>('path')]
    return { paths, main: paths.find((path) => !path.hasAttribute('fill') && !path.hasAttribute('style')) ?? paths[0] }
  })
  const [left, right] = pairs
  const shapes = shapesOf(body)
  const core = shapes[shapes.length - 1]
  if (left?.main === undefined || right?.main === undefined || core === undefined) return undefined
  const parts = shapes.map(partOf)
  const head = headFor(parts, [left.main.getAttribute('d') ?? '', right.main.getAttribute('d') ?? ''])
  if (head === undefined) return undefined
  const middle = bodyMiddle(body)

  // The eyes she works with: rects in the head's own space, cut off at its core outline.
  const id = `busy-eyes-${++made}`
  const eyes = node('g')
  eyes.setAttribute('data-busy-eyes', '')
  eyes.setAttribute('clip-path', `url(#${id})`)
  eyes.style.fill = 'var(--mo-eye)'
  const defs = node('defs')
  const clip = node('clipPath')
  clip.id = id
  const edge = node('path')
  clip.append(edge)
  defs.append(clip)
  const lids = [left, right].map((pair) => {
    const lid = node('g')
    lid.style.transformBox = 'fill-box'
    lid.style.transformOrigin = 'center'
    const centre = (path: SVGPathElement) => {
      const box = path.getBBox()
      return box.y + box.height / 2
    }
    const rects = pair.paths.map((path) => {
      const rect = node('rect')
      for (const name of ['style', 'fill', 'opacity']) if (path.hasAttribute(name)) rect.setAttribute(name, path.getAttribute(name)!)
      lid.append(rect)
      return { rect, lower: centre(path) - centre(pair.main!) }
    })
    return { lid, rects }
  })
  eyes.append(defs, ...lids.map((each) => each.lid))

  // Everything that follows the outline: the head's shapes, the library's clip that repeats
  // them for the clay finish, and the clip of the eyes. A petal is a circle; while the face
  // works it is the same circle as a path, so it can change shape.
  const finish = [...(host.querySelector('.mo-root > defs > clipPath')?.children ?? [])]
  const swapped: Array<[Element, Element]> = []
  const redrawn = (shape: Element | undefined) => {
    if (shape?.tagName !== 'circle') return shape
    const { cx, cy, r } = partOf(shape) as Exclude<HeadPart, string>
    const path = node('path')
    path.setAttribute('d', `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`)
    shape.replaceWith(path)
    swapped.push([shape, path])
    return path
  }
  const outlines = shapes.map((shape, index) => {
    const twins = [redrawn(shape), redrawn(finish.length === shapes.length ? finish[index] : undefined)].flatMap((each) => each ?? [])
    return { twins, d: twins[0]!.getAttribute('d') ?? '' }
  })
  const cores = outlines.pop()!
  cores.twins.push(edge)
  edge.setAttribute('d', cores.d)

  let top = 0
  const setTop = (value: number) => {
    const next = value < 0.001 ? 0 : value
    if (next === top) return
    top = next
    const now = next === 0 ? undefined : outline(head, next)
    for (const twin of cores.twins) twin.setAttribute('d', now?.core ?? cores.d)
    outlines.forEach((each, index) => each.twins.forEach((twin) => twin.setAttribute('d', now?.extras[index] ?? each.d)))
  }

  for (const part of [body, eyes]) {
    part.style.transformBox = 'view-box'
    part.style.transformOrigin = '0px 0px'
  }
  drawn.style.visibility = 'hidden'
  drawn.after(eyes)
  // The working body is fitted to its slot, so the library's lift on hover is off for as long as the face is rigged.
  host.setAttribute('data-busy', '')

  /** An eye of the library as it shows right now, pose, blink and all, in the space the working eyes are drawn in. */
  const shown = (path: SVGPathElement, fallback: EyeShape): EyeShape => {
    const [to, from] = [bob.getScreenCTM(), path.getScreenCTM()]
    if (to === null || from === null) return fallback
    const box = path.getBBox()
    const m = to.inverse().multiply(from)
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2]
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f, a: (box.width / 2) * Math.hypot(m.a, m.b), b: (box.height / 2) * Math.hypot(m.c, m.d), round: 0 }
  }
  /** The library's own drawing of this face as it stands: what a face wakes from and walks home to. */
  const home = (): Figure => {
    const rest = figure(head, WORK, 0)
    return { ...rest, fit: 1, eyes: [shown(left.main!, rest.eyes[0]), shown(right.main!, rest.eyes[1])] }
  }
  const work = figure(head, WORK)

  let plan: LoopPlan | undefined
  let lead: Animation | undefined
  let running: Animation[] = []
  let frame = 0
  let look = first
  let speed = rate(look.speed)
  const seconds = () => Number(lead?.currentTime ?? 0) / 1000
  /** What the face shows at this moment. */
  const now = () => (plan === undefined ? home() : figureAt(plan, seconds()))
  const follow = () => {
    cancelAnimationFrame(frame)
    if (plan === undefined || lead === undefined) return
    setTop(keyAt(plan.top, seconds()).top)
    // Only a plan that pitches the head redraws its outline, and only until it has played out.
    if (lead.playState !== 'finished' && plan.top.some((key) => key.top > 0)) frame = requestAnimationFrame(follow)
  }
  /** Plays a plan from where the last one is cut off, and calls `then` when it has played out. */
  const play = (next: LoopPlan, then?: () => void, from = 0) => {
    const before = running
    const timing = { id: 'busy', duration: next.seconds * 1000, fill: 'forwards' as const }
    const at = (key: { t: number }) => Math.min(1, key.t / next.seconds)
    const frames = next.body.map((key) => ({ offset: at(key), transform: placed(head.c, key) }))
    const eye = (keys: readonly EyeKey[], lower: number) => keys.map((key) => ({ offset: at(key), ...eyeBox(key, lower) }))
    running = [
      body.animate(frames, timing),
      eyes.animate(frames, timing),
      ...lids.flatMap((each, index) => each.rects.map(({ rect, lower }) => rect.animate(eye(next.eyes[index]!, lower), timing))),
    ]
    for (const each of running) {
      each.playbackRate = speed
      if (from > 0) each.currentTime = Math.min(from, next.seconds) * 1000
    }
    // The new ones are on before the old ones go, so no frame shows the face without either.
    for (const each of before) each.cancel()
    plan = next
    const mine = running[0]!
    lead = mine
    if (then) mine.onfinish = () => lead === mine && then()
    follow()
  }

  let ended = false
  /** What this face was asked to play; `playing` is what it plays, the dots too when another face on its beat writes. */
  let told: BusyLook['play'] = look.play
  let playing: BusyLook['play'] = look.play
  let moving: MoveId | undefined
  let queue: Step[] = []
  let last: MoveId | undefined
  let round = look.seed ?? turns++
  let melting: ReturnType<typeof melt> | undefined

  // A face without a fixed order keeps time with the other faces on its beat.
  const key = look.seed === undefined ? look.beat : undefined
  const beat = key === undefined ? undefined : beatOf(key)
  const beater: Beater = { writing: told === 'dots', sync: () => apply(wanted()), melting: () => (playing === 'dots' && melting?.lead.playState !== 'idle' ? melting?.lead : undefined) }
  const wanted = (): BusyLook['play'] => (told === 'loop' && beat !== undefined && [...beat.faces].some((face) => face !== beater && face.writing) ? 'dots' : told)
  const tell = (writing: boolean) => {
    if (beat === undefined || beater.writing === writing) return
    beater.writing = writing
    for (const face of beat.faces) if (face !== beater) face.sync()
  }
  /** How far the beat's schedule is, in the seconds a plan is timed in. */
  const clock = () => (beat === undefined ? 0 : ((performance.now() - beat.epoch) / 1000) * speed)
  /** Where the beat's schedule will have the face `ahead` seconds from now. */
  const due = (ahead: number) => {
    const { step, into } = stepAt(beat!, clock() + ahead)
    return figureAt(loopPlan(head, [step]), into)
  }
  const onBeat = () => beat !== undefined && playing === 'loop'

  let gone = false
  const off = () => {
    if (gone) return
    gone = true
    ended = true
    if (beat !== undefined) {
      tell(false)
      beat.faces.delete(beater)
      if (beat.faces.size === 0 && beats.get(key!) === beat) beats.delete(key!)
    }
    cancelAnimationFrame(frame)
    melting?.off()
    for (const each of running) each.cancel()
    setTop(0)
    for (const [shape, path] of swapped) path.replaceWith(shape)
    eyes.remove()
    drawn.style.removeProperty('visibility')
    for (const name of ['transform-box', 'transform-origin']) body.style.removeProperty(name)
    for (const part of [body, drawn]) if (part.getAttribute('style') === '') part.removeAttribute('style')
    rigged.delete(body)
    if (holding.get(host) !== off) return
    holding.delete(host)
    host.removeAttribute('data-busy')
  }
  holding.set(host, off)

  /** Counts what the face was last asked to do, so what an earlier request still had coming is dropped. */
  let asked = 0

  /**
   * Walks home to the library's drawing and hands the face back to it. The library's
   * eyes may still be on their way into a pose under the working ones, so the walk ends
   * where they are by then, in one or two small steps more if it has to.
   */
  const settle = (legs = 3, swelled: Promise<void> = Promise.resolve(), mine = ++asked) => {
    const [from, to] = [now(), home()]
    const there = from.fit === to.fit && from.lean === 0 && from.top === 0 && from.eyes.every((eye, index) => (['x', 'y', 'a', 'b'] as const).every((field) => Math.abs(eye[field] - to.eyes[index]![field]) < 0.2))
    if (legs === 0 || (legs < 3 && there)) return void swelled.then(() => asked === mine && off())
    play(walk(from, to, legs === 3 ? WAKE : NUDGE), () => settle(legs - 1, swelled, mine))
  }

  const advance = () => {
    if (ended || playing === 'dots') return
    if (onBeat()) {
      const { step, into } = stepAt(beat!, clock())
      last = step.move
      moving = step.move
      play(loopPlan(head, [step]), advance, into)
      return
    }
    if (playing === 'loop' && queue.length === 0) queue = loopSteps(round++, last)
    const step = playing === 'loop' ? queue.shift()! : { move: playing, rest: 0.5 }
    last = step.move
    moving = step.move
    play(loopPlan(head, [step]), () => {
      if (look.once && playing !== 'loop') {
        ended = true
        settle()
      } else advance()
    })
  }

  const write = () => {
    const pulls = work.eyes.map((eye): Pair => [middle[0] - eye.x, middle[1] - eye.y]) as [Pair, Pair]
    melting?.off()
    // A face on a beat hops in step with one of its faces that already shows the dots.
    const ahead = beat === undefined ? undefined : [...beat.faces].map((face) => (face === beater ? undefined : face.melting())).find(Boolean)
    melting = melt(body, middle, lids.map((each) => each.lid), pulls, speed, ahead)
  }

  /**
   * Goes to the working pose from wherever the face is and plays what was asked from
   * there. Dots that are on, or on their way out, swell back into the body first. Dots
   * that start do not wait for the walk: the eyes sink while the body comes home, so a
   * move that is cut short runs straight into the melt.
   */
  const begin = (seconds = WAKE) => {
    const mine = ++asked
    const leaving = melting
    if (leaving === undefined) {
      // On a beat the face walks to where the schedule will be when it gets there, and joins it.
      play(walk(now(), onBeat() ? due(seconds) : work, seconds), advance)
      if (playing === 'dots') write()
      return
    }
    play(walk(now(), work, seconds))
    // Both the walk and the swell have to be over; a walk that is cut off belongs to an older request.
    const walked = lead?.finished.then(() => undefined, () => undefined)
    void Promise.all([leaving.stop(), walked]).then(() => {
      if (melting === leaving) melting = undefined
      if (asked !== mine || gone) return
      if (playing === 'dots') write()
      else if (onBeat()) play(walk(now(), due(WAKE), WAKE), advance)
      else advance()
    })
  }

  /** Hands over to what the face should play now, unless it already plays it. */
  const apply = (next: BusyLook['play']) => {
    if (ended || next === playing) return
    // A move is cut short for another one in less time than a face takes to wake.
    const short = next !== 'dots' && playing !== 'dots'
    playing = next
    moving = undefined
    begin(short ? HANDOVER : WAKE)
  }

  const run: BusyRun = {
    setSpeed: (next) => {
      speed = rate(next)
      for (const each of running) each.updatePlaybackRate(speed)
      melting?.setSpeed(speed)
    },
    setPlay: (next) => {
      if (ended) return
      told = next
      tell(next === 'dots')
      apply(wanted())
    },
    playing: () => {
      if (ended) return undefined
      if (playing === 'dots') return 'dots'
      return moving !== undefined && plan?.marks.length && seconds() < moveInfo(moving).seconds ? moving : undefined
    },
    stop: () => {
      if (gone) return
      // Gone with its face: nothing left to walk home.
      if (!body.isConnected) return off()
      const once = ended
      ended = true
      tell(false)
      // A single move that has played out is already on its way home.
      if (!once) settle(3, melting?.stop())
    },
    off,
  }

  rigged.set(body, {
    parts,
    middle,
    resume: (next) => {
      // A loop picks up its round where it was, unless it was asked for another order.
      if (next.seed !== look.seed) {
        queue = []
        round = next.seed ?? turns++
      }
      look = next
      speed = rate(next.speed)
      told = next.play
      ended = false
      tell(told === 'dots')
      playing = wanted()
      moving = undefined
      begin()
      return run
    },
  })

  if (beat !== undefined) {
    beat.faces.add(beater)
    for (const face of beat.faces) if (face !== beater && beater.writing) face.sync()
    playing = wanted()
  }
  begin()
  return run
}

/**
 * Plays `look` on the face inside `slot` while `active`. `face` names what the face was
 * drawn from; a change there means fresh nodes, so it starts again on them. A change of
 * what plays is handed over on the running face, and a speed change retimes it; neither
 * starts over. The returned ref holds the run, for a caller that wants to ask it what
 * it is playing.
 */
export function useBusyFace(slot: RefObject<HTMLElement | null>, active: boolean, look: BusyLook, face: string) {
  const { play, once, seed } = look
  const latest = useRef(look)
  latest.current = look
  const run = useRef<BusyRun>(undefined)
  const leaving = useRef<BusyRun>(undefined)

  useLayoutEffect(() => {
    const host = slot.current
    if (!active || host === null) return
    const started = start(host, latest.current)
    run.current = started
    return () => {
      started?.stop()
      leaving.current = started
      run.current = undefined
    }
  }, [slot, active, once, seed, face])

  // A face that leaves the page has nowhere to walk home on: its nodes are on their way out.
  useLayoutEffect(() => () => leaving.current?.off(), [])

  useLayoutEffect(() => {
    run.current?.setPlay(play)
  }, [play])

  useEffect(() => {
    run.current?.setSpeed(look.speed)
  }, [look.speed])

  return run
}
