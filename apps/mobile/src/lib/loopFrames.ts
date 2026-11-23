import {
  WORK,
  dotsPlan,
  figure,
  loopPlan,
  measure,
  type DotsPlan,
  type Dot,
  type EyePose,
  type Figure,
  type Head,
  type HeadPart,
  type LoopPlan,
  type MoveId,
  type Pair,
} from '@manor/client-runtime/busy-face'

/**
 * The shared working loop (see the client runtime's `busyFace`) in the form the phone
 * plays it.
 *
 * The Mac asks a running animation where it is, so it can cut a move short and walk the
 * face on from there. Declared keyframes cannot be asked that. So the loop is not
 * declared here: one clock runs on the UI thread, and the body, each eye and the outline
 * read their place off the plan's keys at that clock, every frame, without the JS
 * thread. Cutting a move short is then a walk that starts from what the keys say right
 * now, on the same thread and in the same frame.
 *
 * This file is the part of that with no views in it: a plan as flat numbers a worklet
 * can read, the walk, the steps of the outline's change of shape, and where the dots
 * melt is at a moment.
 */

/** A plan's keys as flat numbers. Each key leads with its time in seconds. */
export interface Keys {
  seconds: number
  /** Six a key: time, fit, slide across, slide down, lean in degrees, scale. */
  body: number[]
  /** Per eye, six a key: time, middle across and down, half width, half height, roundness. */
  eyes: [number[], number[]]
  /** Two a key: time, and how far the outline is into the top view. */
  top: number[]
}

const BODY = 6
const EYE = 6
const TOP = 2

/**
 * One drawing of a face as sixteen numbers: fit, slide across and down, lean, scale and
 * top view, then each eye's middle, half width, half height and roundness.
 */
export const flat = (drawn: Figure): number[] => [
  drawn.fit, drawn.x, drawn.y, drawn.lean, drawn.scale, drawn.top,
  ...drawn.eyes.flatMap((eye) => [eye.x, eye.y, eye.a, eye.b, eye.round]),
]

/** Where the first eye starts in a flat drawing, and how many numbers an eye takes. */
const EYES_AT = 6
const EYE_SIZE = 5

export const packed = (plan: LoopPlan): Keys => ({
  seconds: plan.seconds,
  body: plan.body.flatMap((key) => [key.t, key.fit, key.x, key.y, key.lean, key.scale]),
  eyes: [plan.eyes[0], plan.eyes[1]].map((keys) => keys.flatMap((key) => [key.t, key.x, key.y, key.a, key.b, key.round])) as [number[], number[]],
  top: plan.top.flatMap((key) => [key.t, key.top]),
})

/**
 * A track's values at `t`, straight between the two keys around it, without the time.
 * Before the first key it is the first, after the last the last.
 */
export function at(track: readonly number[], size: number, t: number): number[] {
  'worklet'
  const count = track.length / size
  let low = 0
  let high = count - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (track[middle * size]! <= t) low = middle
    else high = middle - 1
  }
  const a = low * size
  const b = Math.min(low + 1, count - 1) * size
  const span = track[b]! - track[a]!
  const u = span > 0 ? Math.min(Math.max((t - track[a]!) / span, 0), 1) : 0
  const values: number[] = []
  for (let field = 1; field < size; field += 1) values.push(track[a + field]! + (track[b + field]! - track[a + field]!) * u)
  return values
}

type Five = [number, number, number, number, number]

/** The body at `t`: fit, slide across and down, lean, scale. */
export function bodyAt(keys: Keys, t: number) {
  'worklet'
  return at(keys.body, BODY, t) as Five
}

/** One eye at `t`: middle across and down, half width, half height, roundness. */
function eyeAt(keys: Keys, side: 0 | 1, t: number) {
  'worklet'
  return at(keys.eyes[side], EYE, t) as Five
}

/** The slot's side in the face's own units. */
const BOX = 100

/**
 * The body at `t` as a view places it: its slide in points, its lean in degrees and
 * its scale. The shared figure leans and scales the body about the middle of the head
 * `c`, slides it, and draws the whole in about the middle of the slot. A view turns
 * about its own middle, which is the slot's, so the slide here carries the difference.
 * `unit` is points per box unit.
 */
export function placeAt(keys: Keys, t: number, c: readonly [number, number], unit: number) {
  'worklet'
  const [fit, x, y, lean, scale] = bodyAt(keys, t)
  const [dx, dy] = [c[0] - BOX / 2, c[1] - BOX / 2]
  const turn = (lean * Math.PI) / 180
  const [cos, sin] = [Math.cos(turn) * fit * scale, Math.sin(turn) * fit * scale]
  return {
    x: (fit * (dx + x) - (dx * cos - dy * sin)) * unit,
    y: (fit * (dy + y) - (dx * sin + dy * cos)) * unit,
    lean,
    scale: fit * scale,
  }
}

/** The least an eye's box measures. An eye behind the head has no size, and a box of none has no sheen to place. */
const SPECK = 0.01

/**
 * One eye at `t` as a rect's geometry in box units: an ellipse at no roundness, a pill
 * with fully round ends at full.
 */
export function eyeBoxAt(keys: Keys, side: 0 | 1, t: number) {
  'worklet'
  const [x, y, a, b, round] = eyeAt(keys, side, t)
  const least = Math.min(a, b)
  return {
    x: x - a,
    y: y - b,
    width: Math.max(2 * a, SPECK),
    height: Math.max(2 * b, SPECK),
    rx: a + (least - a) * round,
    ry: b + (least - b) * round,
  }
}

/** How far the outline is into the top view at `t`. */
export function topAt(keys: Keys, t: number) {
  'worklet'
  return at(keys.top, TOP, t)[0]!
}

/** What the keys draw at `t`, as a flat drawing: where a walk away from here starts. */
export function drawnAt(keys: Keys, t: number): number[] {
  'worklet'
  return bodyAt(keys, t).concat([topAt(keys, t)], eyeAt(keys, 0, t), eyeAt(keys, 1, t))
}

/** A drawing that stands still, as keys. */
export function held(drawn: readonly number[]): Keys {
  'worklet'
  const eye = (side: number) => [0].concat(drawn.slice(EYES_AT + side * EYE_SIZE, EYES_AT + (side + 1) * EYE_SIZE))
  return { seconds: 0, body: [0].concat(drawn.slice(0, 5)), eyes: [eye(0), eye(1)], top: [0, drawn[5]!] }
}

/** How many keys a walk is read into; its curve is in where they lie. */
const WALK_KEYS = 8

/**
 * The shared `walk`, for the UI thread: a straight walk from one flat drawing to
 * another, eased at both ends. An eye that is behind the head at one end grows or
 * shrinks where the other end has it instead of sliding in.
 */
export function walkTo(from: readonly number[], to: readonly number[], seconds: number): Keys {
  'worklet'
  const keys: Keys = { seconds, body: [], eyes: [[], []], top: [] }
  const ends = [0, 1].map((side) => {
    const first = EYES_AT + side * EYE_SIZE
    const a = from.slice(first, first + EYE_SIZE)
    const b = to.slice(first, first + EYE_SIZE)
    const gone = (eye: readonly number[]) => eye[2] === 0 && eye[3] === 0
    return [gone(a) ? [b[0]!, b[1]!, 0, 0, b[4]!] : a, gone(b) ? [a[0]!, a[1]!, 0, 0, a[4]!] : b] as const
  })
  for (let i = 0; i <= WALK_KEYS; i += 1) {
    const t = (seconds * i) / WALK_KEYS
    const part = i / WALK_KEYS
    const u = part < 0.5 ? 4 * part * part * part : 1 - (-2 * part + 2) ** 3 / 2
    keys.body.push(t)
    for (let field = 0; field < 5; field += 1) keys.body.push(from[field]! + (to[field]! - from[field]!) * u)
    keys.top.push(t, from[5]! + (to[5]! - from[5]!) * u)
    ends.forEach(([a, b], side) => {
      keys.eyes[side]!.push(t)
      for (let field = 0; field < EYE_SIZE; field += 1) keys.eyes[side]!.push(a[field]! + (b[field]! - a[field]!) * u)
    })
  }
  return keys
}

// ── The outline's change of shape ───────────────────────────────────────────────────────

/** How many steps the outline takes from the front view to the top view. */
export const MORPH_STEPS = 24

/** Which step of the outline a top view amount draws. */
export function morphStep(top: number) {
  'worklet'
  return Math.round(Math.min(Math.max(top, 0), 1) * MORPH_STEPS)
}

/** Twice a closed outline's area, signed by the way round it runs. */
const turnOf = (points: readonly Pair[]) => points.reduce((sum, [x, y], index) => {
  const [nx, ny] = points[(index + 1) % points.length]!
  return sum + x * ny - nx * y
}, 0)

const closed = (points: readonly Pair[]) => `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L')}Z`

/**
 * Each of the head's shapes as path data per step of the way into the top view: the
 * shapes in the library's order with the core last, and for each one `MORPH_STEPS + 1`
 * outlines. Step 0 is `still`, the shapes exactly as the face draws them at rest; the
 * rest are sampled once here, so playback only picks one.
 *
 * Every outline of a step runs the same way round. A native clip merges its shapes into
 * one path filled by winding, and a petal that ran against the core would cut its
 * overlap out of the shading.
 */
export function morphShapes(head: Head, still: readonly string[]): string[][] {
  const way = Math.sign(turnOf(head.core))
  const shapes = [
    ...head.extras.map(({ from, to }) => (Math.sign(turnOf(from)) === way ? { from, to } : { from: [...from].reverse(), to: [...to].reverse() })),
    { from: head.core, to: head.ball },
  ]
  return shapes.map(({ from, to }, index) => [
    still[index] ?? closed(from),
    ...Array.from({ length: MORPH_STEPS }, (_, step) => {
      const top = (step + 1) / MORPH_STEPS
      return closed(from.map(([x, y], point): Pair => [x + (to[point]![0] - x) * top, y + (to[point]![1] - y) * top]))
    }),
  ])
}

// ── A face rigged for the loop ──────────────────────────────────────────────────────────

/** What one silhouette needs to play the loop, measured and sampled once. */
export interface Rig {
  head: Head
  /** See `morphShapes`. */
  shapes: string[][]
  /** The library's own drawing of the face, and the working pose: what a face walks between. */
  home: number[]
  work: number[]
  /** Where the working eyes sit, which the dots melt pulls into the middle of the body. */
  eyes: [Pair, Pair]
  /** The middle of the body's drawn box, where the dots gather. */
  middle: Pair
}

/** The middle of the box around the head's shapes. Curve handles count, which barely moves a blob's middle. */
function middleOf(parts: readonly HeadPart[]): Pair {
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity]
  const add = (x: number, y: number) => {
    left = Math.min(left, x)
    right = Math.max(right, x)
    top = Math.min(top, y)
    bottom = Math.max(bottom, y)
  }
  for (const part of parts) {
    if (typeof part !== 'string') {
      add(part.cx - part.r, part.cy - part.r)
      add(part.cx + part.r, part.cy + part.r)
      continue
    }
    let [x, y] = [0, 0]
    for (const [, command, args = ''] of part.matchAll(/([MLCQHVZ])([^MLCQHVZ]*)/g)) {
      const values = args.trim().split(/[\s,]+/).filter(Boolean).map(Number)
      if (command === 'H') for (const value of values) add((x = value), y)
      else if (command === 'V') for (const value of values) add(x, (y = value))
      else for (let index = 0; index + 1 < values.length; index += 2) add((x = values[index]!), (y = values[index + 1]!))
    }
  }
  return left === Infinity ? [50, 50] : [(left + right) / 2, (top + bottom) / 2]
}

const rigs = new Map<string, Rig | undefined>()

/**
 * The rig for a face, or nothing when it has no core or no pair of eyes to move.
 * `parts` are the head's shapes in the library's order with the core last, `eyes` the
 * path of the left eye and of the right one, and `still` the shapes as the face draws
 * them at rest. Faces of one silhouette share a rig, and with it every move read for it.
 */
export function rigOf(parts: readonly HeadPart[], eyes: readonly [string, string], still: readonly string[]): Rig | undefined {
  const key = JSON.stringify([parts, eyes])
  if (!rigs.has(key)) {
    if (rigs.size >= 24) rigs.clear()
    const head = measure(parts, eyes)
    const work = head === undefined ? undefined : figure(head, WORK)
    rigs.set(key, head === undefined || work === undefined ? undefined : {
      head,
      shapes: morphShapes(head, still),
      home: flat({ ...figure(head, WORK, 0), fit: 1 }),
      work: flat(work),
      eyes: [[work.eyes[0].x, work.eyes[0].y], [work.eyes[1].x, work.eyes[1].y]],
      middle: middleOf(parts),
    })
  }
  return rigs.get(key)
}

const moves = new WeakMap<Rig, Map<MoveId, Keys>>()

/** One move on a rigged face, from the working pose and back, as keys. Read once per face. */
export function moveKeys(rig: Rig, move: MoveId): Keys {
  const known = moves.get(rig) ?? new Map<MoveId, Keys>()
  moves.set(rig, known)
  const before = known.get(move)
  if (before) return before
  const keys = packed(loopPlan(rig.head, [{ move, rest: 0 }]))
  known.set(move, keys)
  return keys
}

// ── The dots melt, at a moment ──────────────────────────────────────────────────────────

const melts = new WeakMap<Rig, DotsPlan>()

/** The dots melt for a rigged face: its working eyes sink into the middle of its body. */
export function meltPlan(rig: Rig): DotsPlan {
  const known = melts.get(rig)
  if (known) return known
  const [left, right] = rig.eyes
  const plan = dotsPlan([[rig.middle[0] - left[0], rig.middle[1] - left[1]], [rig.middle[0] - right[0], rig.middle[1] - right[1]]])
  melts.set(rig, plan)
  return plan
}

/**
 * How far along a CSS curve is at the share `u` of its time: `linear`, or a
 * `cubic-bezier(x1, y1, x2, y2)`, which may overshoot.
 */
export function eased(ease: string, u: number): number {
  const points = /^cubic-bezier\(([^)]+)\)$/.exec(ease)?.[1]?.split(',').map(Number)
  if (points?.length !== 4 || u <= 0 || u >= 1) return u
  const [x1, y1, x2, y2] = points as [number, number, number, number]
  const along = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3
  // Where on the curve its time is `u`: time only grows along it, so halving finds the place.
  let [low, high] = [0, 1]
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2
    if (along(x1, x2, mid) < u) low = mid
    else high = mid
  }
  return along(y1, y2, (low + high) / 2)
}

/** A value between the two keys around `t`, on the curve the earlier key names. */
function between<V extends object>(keys: readonly { t: number; v: V; ease: string }[], t: number): V {
  const next = keys.findIndex((key) => key.t > t)
  if (next <= 0) return keys[next === 0 ? 0 : keys.length - 1]!.v
  const [a, b] = [keys[next - 1]!, keys[next]!]
  const u = eased(a.ease, (t - a.t) / (b.t - a.t))
  const [from, to] = [a.v as Record<string, number>, b.v as Record<string, number>]
  return Object.fromEntries(Object.keys(from).map((field) => [field, from[field]! + (to[field]! - from[field]!) * u])) as V
}

/** What the melt shows at one moment: the body's scale, the three dots, each eye. */
export interface Melted {
  body: number
  dots: Dot[]
  eyes: EyePose[]
}

/**
 * Where the dots melt is `t` seconds into its plan, round after round. The melt plays
 * as declared keyframes, which cannot be asked where they are, so the face that swells
 * back out of the dots starts from where the plan says they must be by now, on the
 * plan's own curves.
 */
export function meltAt(plan: DotsPlan, t: number): Melted {
  const now = ((t % plan.seconds) + plan.seconds) % plan.seconds
  return {
    body: between(plan.body.map((key) => ({ t: key.t, v: { s: key.v }, ease: key.ease })), now).s,
    dots: plan.dots.map((keys) => between(keys, now)),
    eyes: plan.eyes.map((stops) => between(stops.map((stop) => ({ t: stop.t, v: stop.pose, ease: stop.ease })), now)),
  }
}
