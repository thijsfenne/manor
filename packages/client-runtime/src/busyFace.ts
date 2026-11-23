/**
 * The working face's choreography, shared by every client that draws it.
 *
 * While her turn works, a persona's whole face moves, body and eyes together. She leans,
 * rocks, turns her head so far that her eyes run off one edge and come back in from the
 * other, pitches over the top, shrinks away, looks aside, thinks and reads down a line.
 * Those eight moves play in a shuffled order with a short breath between, and every one
 * starts and ends in the same working pose, so any order chains without a jump.
 *
 * While she writes, the face melts into three hopping dots instead, in its own place,
 * and swells back out of them when the writing stops.
 *
 * This file only plans. A move is a set of tracks over a small pose; `figure` turns a
 * pose into what one face draws; `loopPlan` samples a run of moves into keys a client
 * can play as they are, and `dotsPlan` does the same for the melt. The web plays the
 * keys with the Web Animations API, the phone as keyframes of its own.
 */

export type Pair = [number, number]

const DEG = Math.PI / 180
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v))
const lerp = (a: number, b: number, u: number) => a + (b - a) * u
export const smooth = (u: number) => u * u * (3 - 2 * u)

// ── Pose ────────────────────────────────────────────────────────────────────────────────

/** The eye shapes a move changes between, as fractions of the head's half-width. */
const PILL = { ea: 0.17, eb: 0.39, es: 0.27, pill: 1 }
const SMALL = { ea: 0.135, eb: 0.27, es: 0.235, pill: 1 }
const DOTS = { ea: 0.2, eb: 0.2, es: 0.28, pill: 1 }
const WIDE = { ea: 0.27, eb: 0.235, es: 0.275, pill: 0 }

/**
 * The working pose, which every move starts from and returns to. Lengths are in units
 * of a head 29.6 wide from its middle to its edge and scale with the head, so a pose
 * means the same on every silhouette.
 */
export const WORK = {
  /** Degrees about the middle of the head; positive tips the top to the right. */
  lean: 0,
  /** The body's slide. */
  tx: 0,
  ty: 0,
  /** The body's scale about the middle of the head. */
  sc: 1,
  /** From 0, the front view, to 1, the top view, where the outline is a circle. */
  top: 0,
  /** The eye pair's offset from where the library drew it. */
  ex: 0,
  ey: 4,
  /** Half an eye's width and height, and half the gap between the two. */
  ...PILL,
  /** From 1, open, down to a squint line. */
  open: 1,
  /** Turns of the head sideways: the eyes leave on the left and come back from the right. */
  sx: 0,
  /** Turns over the top: the eyes leave upward and come back from below. */
  sy: 0,
}

export type Pose = typeof WORK
type PoseKey = keyof Pose

/** The share of one turn the eyes spend crossing the front, per half. The rest is behind the head. */
const FRONT = 0.35

// ── Tracks ──────────────────────────────────────────────────────────────────────────────

const EASE = {
  lin: (t: number) => t,
  in: (t: number) => t * t,
  out: (t: number) => 1 - (1 - t) ** 3,
  both: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  sine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
}
type Ease = keyof typeof EASE

type Point = readonly [t: number, v: number]
/** Keys to ease between, or measured points to draw one smooth curve through. */
type Track = Array<readonly [t: number, v: number, ease: Ease]> | { through: readonly Point[] }

/** A monotone cubic through measured points: smooth, and it never overshoots a hold. */
function through(pts: readonly Point[], t: number) {
  const n = pts.length
  if (t <= pts[0]![0]) return pts[0]![1]
  if (t >= pts[n - 1]![0]) return pts[n - 1]![1]
  let k = 0
  while (t > pts[k + 1]![0]) k += 1
  const slope = (i: number) => (pts[i + 1]![1] - pts[i]![1]) / (pts[i + 1]![0] - pts[i]![0])
  const tangent = (i: number) => {
    if (i === 0) return slope(0)
    if (i === n - 1) return slope(n - 2)
    const [a, b] = [slope(i - 1), slope(i)]
    if (a * b <= 0) return 0
    const [h0, h1] = [pts[i]![0] - pts[i - 1]![0], pts[i + 1]![0] - pts[i]![0]]
    return (3 * (h0 + h1)) / ((2 * h1 + h0) / a + (h1 + 2 * h0) / b)
  }
  const h = pts[k + 1]![0] - pts[k]![0]
  const u = (t - pts[k]![0]) / h
  const [m0, m1] = [tangent(k) * h, tangent(k + 1) * h]
  const [u2, u3] = [u * u, u * u * u]
  return (2 * u3 - 3 * u2 + 1) * pts[k]![1] + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * pts[k + 1]![1] + (u3 - u2) * m1
}

function valueAt(track: Track, t: number, base: number) {
  if (!Array.isArray(track)) return through(track.through, t)
  let [from, value] = [0, base]
  for (const [until, next, ease] of track) {
    if (t < until) return lerp(value, next, EASE[ease](clamp((t - from) / (until - from), 0, 1)))
    from = until
    value = next
  }
  return value
}

interface Move {
  label: string
  seconds: number
  tracks: Partial<Record<PoseKey, Track>>
  /** A value that follows another, set after the tracks are read. */
  follow?: (pose: Pose) => void
}

/** Builds a move. `to(from, until, values)` holds each value until `from`, then eases to it by `until`. */
function move(label: string) {
  const tracks: Partial<Record<PoseKey, Track>> = {}
  let follow: Move['follow']
  const api = {
    to(from: number, until: number, values: Partial<Pose>, ease: Ease = 'out') {
      for (const key of Object.keys(values) as PoseKey[]) {
        const track = (tracks[key] ??= [])
        if (!Array.isArray(track)) continue
        const last = track.at(-1) ?? ([0, WORK[key], 'lin'] as const)
        if (last[0] < from) track.push([from, last[1], 'lin'])
        track.push([until, values[key]!, ease])
      }
      return api
    },
    through(key: PoseKey, pts: readonly Point[]) {
      tracks[key] = { through: pts }
      return api
    },
    follow(rule: NonNullable<Move['follow']>) {
      follow = rule
      return api
    },
    done: (seconds: number): Move => ({ label, seconds, tracks, ...(follow === undefined ? {} : { follow }) }),
  }
  return api
}

// ── Moves. Times are in seconds and angles in degrees, as measured. ─────────────────────

const rockCycle = (c: number): Point[] => [
  [c, 34], [c + 0.25, 32], [c + 0.45, 28], [c + 0.65, 17], [c + 0.85, 4], [c + 1.05, -11], [c + 1.25, -29], [c + 1.45, -44],
  [c + 1.5, -42], [c + 1.55, -12], [c + 1.6, -3], [c + 1.65, 15], [c + 1.7, 27], [c + 1.75, 31], [c + 1.8, 34],
]
/** When the head turn starts to spin, and when the eyes start to rise over the top. */
const TURN = 0.85
const FLIP = 1.05

const MOVES = {
  /** The everyday lean: tip one way, body and eyes the other, hold, swing across. */
  lean: move('Lean')
    .to(0, 0.33, { lean: 14, tx: -7, ex: -8, ey: 1 })
    // A blink as the lean lands.
    .to(0.33, 0.4, { open: 0.13 }, 'in')
    .to(0.45, 0.55, { open: 1 })
    .to(0.97, 1.27, { lean: -6, tx: 2.5, ex: 6 }, 'both')
    .to(1.27, 1.55, { lean: -9, ex: 7 })
    .to(2.05, 2.25, { lean: 0, tx: 0, ex: 0, ey: 4 }, 'both')
    .done(2.5),

  /** The big rock: snap to one side, sweep slowly to the other, snap back. */
  rock: move('Rock')
    .through('lean', [[0, 0], [0.05, 10], [0.1, 24], [0.2, 33], ...rockCycle(0.3), ...rockCycle(2.1).slice(1), [3.95, 34], [4.0, 28], [4.05, 15], [4.1, 7], [4.2, 1], [4.3, 0]])
    .follow((pose) => {
      pose.tx = -0.16 * pose.lean
    })
    .to(0, 0.2, { ey: 13 })
    .to(3.95, 4.25, { ey: 4 }, 'both')
    .done(4.6),

  /** Head turn: look aside, then the eyes run off one edge and come back in from the other, twice. */
  turn: move('Head turn')
    .through('sx', [
      [0, 0], [0.1, -0.06], [0.27, -0.107], [TURN, -0.107],
      [TURN + 0.06, -0.088], [TURN + 0.11, -0.07], [TURN + 0.16, -0.043], [TURN + 0.2, -0.017], [TURN + 0.23, 0.017],
      [TURN + 0.26, 0.07], [TURN + 0.28, 0.1], [TURN + 0.31, 0.21], [TURN + 0.33, 0.35],
      [TURN + 0.35, 0.65], [TURN + 0.43, 1.35], [TURN + 0.48, 1.65],
      [TURN + 0.53, 1.84], [TURN + 0.63, 1.893], [TURN + 0.73, 1.95], [TURN + 0.83, 1.965], [TURN + 0.93, 1.983], [TURN + 1.1, 2],
    ])
    .to(0, 0.27, { lean: -22, tx: 5, sc: 1.03 })
    .to(TURN + 0.2, TURN + 0.5, { lean: 0, tx: 0 }, 'both')
    .to(TURN + 0.2, TURN + 0.65, { sc: 1 }, 'both')
    .to(TURN + 0.36, TURN + 0.46, SMALL, 'lin')
    .to(2.35, 2.47, PILL)
    .done(2.8),

  /** Over the top: eyes up, duck, then the head pitches through its top view, twice, with a hop. */
  top: move('Over the top')
    .to(0, 0.3, { ey: -7, ty: -2 })
    .to(0.55, 0.78, { ty: 8 }, 'both')
    .to(0.72, 0.87, { ey: 10 }, 'both')
    .through('sy', [
      [0, 0], [FLIP, 0], [FLIP + 0.1, 0.066], [FLIP + 0.15, 0.1], [FLIP + 0.2, 0.155], [FLIP + 0.25, 0.23], [FLIP + 0.28, 0.35],
      [FLIP + 0.31, 0.65], [FLIP + 0.36, 1.35], [FLIP + 0.38, 1.65],
      [FLIP + 0.4, 1.76], [FLIP + 0.42, 1.84], [FLIP + 0.45, 1.9], [FLIP + 0.48, 1.92], [FLIP + 0.52, 1.94],
      [FLIP + 0.57, 1.967], [FLIP + 0.63, 1.984], [FLIP + 0.7, 1.992], [FLIP + 0.85, 2],
    ])
    .to(FLIP + 0.12, FLIP + 0.23, { top: 1 }, 'both')
    .to(FLIP + 0.4, FLIP + 0.62, { top: 0 })
    .to(FLIP + 0.13, FLIP + 0.33, { ty: -5 }, 'both')
    .to(FLIP + 0.33, FLIP + 0.47, { ty: 0 }, 'both')
    .to(FLIP + 0.29, FLIP + 0.37, { ey: 4 }, 'lin')
    .done(2.2),

  /** Shrink away: small, tilted, dot eyes; then back out the other way. */
  shrink: move('Shrink away')
    .to(0, 0.2, { sc: 0.96 }, 'in')
    .to(0.2, 0.5, { sc: 0.72 })
    .to(0.5, 1.1, { sc: 0.7 }, 'lin')
    .to(0.1, 0.5, { lean: 34, tx: -5, ex: -3 }, 'both')
    .to(0.15, 0.4, DOTS, 'both')
    .to(1.1, 1.75, { sc: 0.88, lean: -20, tx: 3, ex: 7 }, 'both')
    .to(1.15, 1.45, SMALL, 'both')
    .to(1.75, 2.05, { sc: 0.9 }, 'lin')
    .to(2.05, 2.3, { sc: 1.03 })
    .to(2.05, 2.2, PILL)
    .to(2.6, 2.9, { lean: 0, tx: 0, ex: 0, sc: 1 }, 'both')
    .done(3.1),

  /** Looking away: eyes go small, drift, then dart to the far side as dots; the body follows. */
  away: move('Look away')
    .to(0, 0.2, SMALL)
    .to(0, 0.25, { ex: 6 })
    .to(0.25, 0.75, { ex: 9 }, 'lin')
    .to(0.75, 1.05, { ex: -12, tx: -9, lean: 4 }, 'both')
    .to(0.75, 0.9, DOTS, 'both')
    .to(1.65, 1.95, { ex: 0, tx: 0, lean: 0 }, 'both')
    .to(1.65, 1.85, SMALL, 'both')
    .to(2.35, 2.45, PILL)
    .done(2.7),

  /** Thinking: small slanted eyes up and to the side, then the other side. */
  think: move('Thinking')
    .to(0, 0.15, SMALL)
    .to(0.3, 0.57, { lean: -26, tx: 2, ex: 11, ey: -6 })
    .to(1.47, 1.8, { lean: 2, tx: -5, ex: -11, ey: 4 }, 'both')
    .to(2.3, 2.55, { lean: -24, tx: -4, ex: -6, ey: -7 }, 'both')
    .to(2.9, 3.0, PILL)
    .to(3.0, 3.3, { lean: 0, tx: 0, ex: 0, ey: 4 }, 'both')
    .done(3.5),

  /** Looking down: a wide pair of ovals low in the face, reading along a line. */
  down: move('Look down')
    .to(0, 0.17, WIDE)
    .to(0, 0.3, { ex: -9, ey: 6 })
    .to(0.45, 0.95, { ey: 16, lean: -23, tx: 2, ex: -4 }, 'both')
    .to(1.25, 1.6, { lean: 7, ey: 10, ex: -9, tx: -2 }, 'both')
    .to(1.8, 2.8, { ex: 9, lean: -10, tx: 0 }, 'sine')
    .to(3.15, 3.5, { ex: -8, lean: -3 }, 'both')
    .to(3.75, 3.9, PILL)
    .to(3.75, 4.0, { ex: 0, ey: 4, lean: 0, tx: 0 }, 'both')
    .done(4.2),
} satisfies Record<string, Move>

export type MoveId = keyof typeof MOVES
export const MOVE_IDS = Object.keys(MOVES) as MoveId[]

/** A move's name for a reader and its length in seconds. */
export const moveInfo = (id: MoveId): Pick<Move, 'label' | 'seconds'> => MOVES[id]

/** The pose a move holds `t` seconds in. */
export function poseAt(id: MoveId, t: number): Pose {
  const { tracks, follow }: Move = MOVES[id]
  const pose = { ...WORK }
  for (const key of Object.keys(tracks) as PoseKey[]) pose[key] = valueAt(tracks[key]!, t, WORK[key])
  follow?.(pose)
  return pose
}

// ── The order ───────────────────────────────────────────────────────────────────────────

/** One move of a run, and the breath in the working pose after it, in seconds. */
export interface Step {
  move: MoveId
  rest: number
}

/**
 * One round of the loop: all eight moves, shuffled by `seed`, each with a breath of its
 * own length after it. The same seed gives the same round. `after` is the move the
 * round before ended on, which this one then does not open with, so a client that plays
 * round after round with a seed that counts up never shows a move twice in a row.
 */
export function loopSteps(seed: number, after?: MoveId): Step[] {
  let state = (Math.imul(seed | 0, 0x9e3779b1) ^ 0x1351d0f3) >>> 0
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32
  random()
  const ids = [...MOVE_IDS]
  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[ids[i], ids[j]] = [ids[j]!, ids[i]!]
  }
  if (ids[0] === after) ids.push(ids.shift()!)
  return ids.map((id) => ({ move: id, rest: 0.25 + random() * 0.5 }))
}

// ── The face a pose is drawn on ─────────────────────────────────────────────────────────

/** One shape of a head as the library wrote it: path data, or a circle. */
export type HeadPart = string | { cx: number; cy: number; r: number }

/** An eye as it is drawn: its middle, half its width, half its height. */
interface EyeBox {
  x: number
  y: number
  a: number
  b: number
}

/** What a face is measured by before it can play the loop; see `measure`. */
export interface Head {
  /** The middle of the core's area: what the body leans and scales about. */
  c: Pair
  /** The radius of the circle with the core's area, which is the head seen from above. */
  r: number
  /** Half the core's width and height. */
  hw: number
  hh: number
  /** The core outline, and the top view's circle point for point. */
  core: Pair[]
  ball: Pair[]
  /** Every other shape of the head, and where each of its points settles on the ball. */
  extras: Array<{ from: Pair[]; to: Pair[] }>
  /** Points the body can reach, for keeping it inside the slot. */
  hull: Pair[]
  eyes: [EyeBox, EyeBox]
  /**
   * How far the working eyes are drawn in about the middle of the head, sizes and
   * travel alike, so that they stay inside the core on every move; see `snug`.
   */
  snug: number
}

/** How many points a core outline and any other shape are sampled into. */
const CORE_POINTS = 160
const EXTRA_POINTS = 96

/** A path as a fine closed polyline. Reads the absolute commands the face library writes. */
function flatten(d: string): Pair[] {
  const pts: Pair[] = []
  let at: Pair = [0, 0]
  for (const [, command, args = ''] of d.matchAll(/([MLCQHV])([^MLCQHVZ]*)/g)) {
    const v = args.trim().split(/[\s,]+/).filter(Boolean).map(Number)
    const size = command === 'C' ? 6 : command === 'Q' ? 4 : command === 'H' || command === 'V' ? 1 : 2
    for (let i = 0; i + size <= v.length; i += size) {
      const ends: Pair[] = []
      for (let j = 0; j + 1 < size; j += 2) ends.push([v[i + j]!, v[i + j + 1]!])
      if (command === 'H') ends.push([v[i]!, at[1]])
      if (command === 'V') ends.push([at[0], v[i]!])
      if (ends.length > 1) {
        for (let step = 1; step < 24; step += 1) {
          let line: Pair[] = [at, ...ends]
          while (line.length > 1) line = line.slice(1).map((p, k): Pair => [lerp(line[k]![0], p[0], step / 24), lerp(line[k]![1], p[1], step / 24)])
          pts.push(line[0]!)
        }
      }
      at = ends[ends.length - 1]!
      pts.push(at)
    }
  }
  return pts
}

/** `count` points along a closed outline, evenly spaced by length from its start. */
function along(part: HeadPart, count: number): Pair[] {
  if (typeof part !== 'string') {
    return Array.from({ length: count }, (_, i): Pair => [part.cx - part.r * Math.cos((2 * Math.PI * i) / count), part.cy + part.r * Math.sin((2 * Math.PI * i) / count)])
  }
  const line = flatten(part)
  if (line.length === 0) return []
  line.push(line[0]!)
  const lengths = [0]
  for (let i = 1; i < line.length; i += 1) lengths.push(lengths[i - 1]! + Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]))
  const total = lengths[lengths.length - 1]!
  let k = 0
  return Array.from({ length: count }, (_, i): Pair => {
    const want = (total * i) / count
    while (k < line.length - 2 && lengths[k + 1]! < want) k += 1
    const span = lengths[k + 1]! - lengths[k]!
    const u = span === 0 ? 0 : (want - lengths[k]!) / span
    return [lerp(line[k]![0], line[k + 1]![0], u), lerp(line[k]![1], line[k + 1]![1], u)]
  })
}

function boxOf(pts: readonly Pair[]): EyeBox {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  return { x: (left + right) / 2, y: (top + bottom) / 2, a: (right - left) / 2, b: (bottom - top) / 2 }
}

/**
 * Measures a face for the loop. `parts` are the head's own shapes in the order the
 * library draws them, the core outline last; `eyes` is the path of the left eye and of
 * the right one. Nothing when the face has no core or no pair of eyes to move.
 */
export function measure(parts: readonly HeadPart[], eyes: readonly string[]): Head | undefined {
  const last = parts[parts.length - 1]
  const [left, right] = eyes.map((d) => flatten(d))
  if (typeof last !== 'string' || left === undefined || right === undefined || left.length === 0 || right.length === 0) return undefined
  const core = along(last, CORE_POINTS)
  if (core.length === 0) return undefined
  let [area, cx, cy] = [0, 0, 0]
  core.forEach(([x0, y0], i) => {
    const [x1, y1] = core[(i + 1) % core.length]!
    const w = x0 * y1 - x1 * y0
    area += w
    cx += (x0 + x1) * w
    cy += (y0 + y1) * w
  })
  if (area === 0) return undefined
  const c: Pair = [cx / (3 * area), cy / (3 * area)]
  const r = Math.sqrt(Math.abs(area / 2) / Math.PI)
  // The top view starts at the same angle and runs the same way round, so no point crosses another.
  const start = Math.atan2(core[0]![1] - c[1], core[0]![0] - c[0])
  const way = Math.sign(area)
  const ball = core.map((_, i): Pair => {
    const angle = start + (way * 2 * Math.PI * i) / core.length
    return [c[0] + r * Math.cos(angle), c[1] + r * Math.sin(angle)]
  })
  const box = boxOf(core)
  // A droplet's tip or a clover's petals settle onto the ball as the head pitches toward its
  // top view: each point outside the circle travels straight in to just under its edge.
  const under = 0.97 * r
  const extras = parts.slice(0, -1).map((part) => {
    const from = along(part, EXTRA_POINTS)
    const to = from.map(([x, y]): Pair => {
      const far = Math.hypot(x - c[0], y - c[1])
      return far <= under ? [x, y] : [c[0] + ((x - c[0]) * under) / far, c[1] + ((y - c[1]) * under) / far]
    })
    return { from, to }
  })
  const head: Head = {
    c,
    r,
    hw: box.a,
    hh: box.b,
    core,
    ball,
    extras,
    hull: [...core.filter((_, i) => i % 4 === 0), ...ball.filter((_, i) => i % 4 === 0), ...extras.flatMap((extra) => extra.from.filter((_, i) => i % 3 === 0))],
    eyes: [boxOf(left), boxOf(right)],
    snug: 1,
  }
  head.snug = snug(head)
  return head
}

const closed = (pts: readonly Pair[]) => `M${pts.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L')}Z`

/**
 * The head's shapes `top` of the way into the top view, as path data: the core, then
 * every other shape in the order `measure` was given them.
 */
export function outline(head: Head, top: number) {
  const mix = (from: readonly Pair[], to: readonly Pair[]) => closed(from.map((p, i): Pair => [lerp(p[0], to[i]![0], top), lerp(p[1], to[i]![1], top)]))
  return { core: mix(head.core, head.ball), extras: head.extras.map((extra) => mix(extra.from, extra.to)) }
}

// ── A pose on a face ────────────────────────────────────────────────────────────────────

/** The slot's side in the face's own units, and how close the leaning body may come to its edge. */
const BOX = 100
const CLEAR = 3
/** The head's half-width that a pose's lengths are stated for. */
const UNIT = 29.6
/** How far past the core the eyes ride, so a turning eye has left the silhouette by the time it faces away. */
const RIDE = 1.03
/** An eye never closes further than this half-height. */
const SQUINT = 0.5
/** The room an eye keeps to the edge of its core, and the most a head's eyes are drawn in to find it. */
const SNUG_ROOM = 0.3
const SNUGGEST = 0.5

/** One eye as a client draws it, in the head's own space: it leans, slides and scales with the body. */
export interface EyeShape {
  x: number
  y: number
  /** Half its width and half its height. Both zero while the eye is behind the head. */
  a: number
  b: number
  /** From 0, an ellipse, to 1, a pill with fully round ends. */
  round: number
}

/** What one face draws for one pose. */
export interface Figure {
  /** The whole figure drawn in about the middle of the slot, just far enough to stay inside it. */
  fit: number
  /** The body's slide, its lean in degrees and its scale, the last two about `head.c`. */
  x: number
  y: number
  lean: number
  scale: number
  /** How far the outline is into the top view; see `outline`. */
  top: number
  eyes: [EyeShape, EyeShape]
}

/**
 * Where one turn value has the eyes: an angle in degrees across the front of the head,
 * and round the back of it between the two edges, where they are out of sight.
 */
function facing(turns: number) {
  const part = ((turns % 1) + 1) % 1
  if (part <= FRONT) return { angle: (-90 * part) / FRONT, behind: false }
  if (part >= 1 - FRONT) return { angle: 90 * (1 - (part - (1 - FRONT)) / FRONT), behind: false }
  return { angle: -90 - (180 * (part - FRONT)) / (1 - 2 * FRONT), behind: true }
}

/**
 * Both eyes for a pose. They ride on the head as on a ball: an offset is an angle, the
 * edge foreshortens them, and past the edge they are behind the head. Clipping to the
 * core does the rest.
 */
function eyesAt(head: Head, pose: Pose, work: number, snugness = head.snug): [EyeShape, EyeShape] {
  const unit = head.hw / UNIT
  const [cx, cy] = head.c
  const [left, right] = head.eyes
  const middle = (left.x + right.x) / 2
  const apart = lerp((right.x - left.x) / 2, pose.es * head.hw, work)
  const [rx, ry] = [head.hw * RIDE, head.hh * RIDE]
  const [yaw, pitch] = [facing(pose.sx), facing(pose.sy)]
  const drawn = lerp(1, snugness, work)
  const eye = (box: EyeBox, side: -1 | 1): EyeShape => {
    const u = drawn * (middle - cx + work * pose.ex * unit + side * apart)
    const v = drawn * (box.y - cy + work * pose.ey * unit)
    const alpha = Math.asin(clamp(u / rx, -1, 1)) + yaw.angle * DEG
    const beta = Math.asin(clamp(v / ry, -1, 1)) + pitch.angle * DEG
    const [across, down] = [Math.cos(alpha), Math.cos(beta)]
    const shown = !yaw.behind && !pitch.behind && across > 0.02 && down > 0.02
    return {
      x: cx + rx * Math.sin(alpha),
      y: cy + ry * Math.sin(beta),
      a: shown ? drawn * lerp(box.a, pose.ea * head.hw, work) * across ** 0.8 : 0,
      b: shown ? Math.max(drawn * lerp(box.b, pose.eb * head.hw, work) * pose.open * down ** 0.5, SQUINT) : 0,
      round: pose.pill * work,
    }
  }
  return [eye(left, -1), eye(right, 1)]
}

/** The points of an eye that leave a silhouette first: the ends of its two axes and of its straight sides. */
export function eyeReach({ x, y, a, b, round }: EyeShape): Pair[] {
  const r = Math.min(a, b) * round
  const [fx, fy] = a <= b ? [a, b - r] : [a - r, b]
  return [[x - a, y], [x + a, y], [x, y - b], [x, y + b], ...(round === 0 ? [] : ([[x - fx, y - fy], [x + fx, y - fy], [x - fx, y + fy], [x + fx, y + fy]] as Pair[]))]
}

/** Whether a point lies inside a closed outline. */
export function inside(outline: ReadonlyArray<readonly [number, number]>, [x, y]: readonly [number, number]) {
  let hit = false
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i, i += 1) {
    const [xi, yi] = outline[i]!
    const [xj, yj] = outline[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/** Whether a pose has the head turned or pitched, with the eyes on their way round it. */
export const turned = (pose: Pose) => Math.abs(pose.sx - Math.round(pose.sx)) > 1e-6 || Math.abs(pose.sy - Math.round(pose.sy)) > 1e-6

/**
 * How far the eyes of this head have to be drawn in to stay inside its core through
 * every move. The moves are measured on a head that is about as tall as it is wide;
 * a capsule, a triangle or a star has less room somewhere, and its eyes play the same
 * moves a little smaller rather than being cut off by the edge. A turned head is left
 * out: there the eyes are meant to reach the edge.
 */
function snug(head: Head) {
  const poses = MOVE_IDS.flatMap((id) => {
    const { seconds } = moveInfo(id)
    return Array.from({ length: Math.ceil(seconds * 20) + 1 }, (_, i) => poseAt(id, Math.min(seconds, i / 20))).filter((pose) => !turned(pose))
  })
  const fits = (drawn: number) => poses.every((pose) => eyesAt(head, pose, 1, drawn).every((eye) => eyeReach({ ...eye, a: eye.a + SNUG_ROOM, b: eye.b + SNUG_ROOM }).every((point) => inside(head.core, point))))
  for (let step = 20; step > SNUGGEST * 20; step -= 1) if (fits(step / 20)) return step / 20
  return SNUGGEST
}

/**
 * Draws a pose on a face. `work` runs from 0, the eyes as the library drew them, to 1,
 * the eyes the pose asks for: a face wakes into the working pose along it and settles
 * out of it the same way.
 */
export function figure(head: Head, pose: Pose, work = 1): Figure {
  const unit = head.hw / UNIT
  const [x, y] = [pose.tx * unit, pose.ty * unit]
  const [cx, cy] = head.c
  const cos = Math.cos(pose.lean * DEG) * pose.sc
  const sin = Math.sin(pose.lean * DEG) * pose.sc
  let reach = 0
  for (const [px, py] of head.hull) {
    const [dx, dy] = [px - cx, py - cy]
    reach = Math.max(reach, Math.abs(cx + dx * cos - dy * sin + x - BOX / 2), Math.abs(cy + dx * sin + dy * cos + y - BOX / 2))
  }

  return {
    fit: Math.min(1, (BOX / 2 - CLEAR) / reach),
    x,
    y,
    lean: pose.lean,
    scale: pose.sc,
    top: clamp(pose.top, 0, 1),
    eyes: eyesAt(head, pose, work),
  }
}

// ── The loop as keys ────────────────────────────────────────────────────────────────────

export type BodyKey = Pick<Figure, 'fit' | 'x' | 'y' | 'lean' | 'scale'> & { t: number }
export type EyeKey = EyeShape & { t: number }
export type TopKey = Pick<Figure, 'top'> & { t: number }

/** How finely a run is read before the keys that say nothing new are dropped, in keys a second. */
const RATE = 120
/** How far a dropped key may have been from the line between its neighbours, per value. */
const BODY_SLACK = { fit: 0.001, x: 0.04, y: 0.04, lean: 0.12, scale: 0.001 }
const EYE_SLACK = { x: 0.04, y: 0.04, a: 0.03, b: 0.03, round: 0.02 }
const TOP_SLACK = { top: 0.004 }

/** Drops every key that the straight line between the keys kept around it already says. */
function thin<K extends { t: number }>(keys: readonly K[], slack: { [F in keyof K]?: number }): K[] {
  const fields = Object.keys(slack) as Array<keyof K & string>
  const said = (from: K, to: K, between: K) => {
    const u = (between.t - from.t) / (to.t - from.t)
    return fields.every((field) => Math.abs((between[field] as number) - lerp(from[field] as number, to[field] as number, u)) <= slack[field]!)
  }
  const kept = [keys[0]!]
  let from = 0
  while (from < keys.length - 1) {
    let to = from + 1
    // Half a second at most, so a long hold is not read again and again from its start.
    while (to + 1 < keys.length && to - from < RATE / 2 && keys.slice(from + 1, to + 1).every((between) => said(keys[from]!, keys[to + 1]!, between))) to += 1
    kept.push(keys[to]!)
    from = to
  }
  return kept
}

/** One stretch of a face's motion as keys: the body, each eye, and how far the outline is into the top view. */
interface Tracks {
  body: BodyKey[]
  eyes: [EyeKey[], EyeKey[]]
  top: TopKey[]
}

/** A run of moves, or a walk between two drawings, as a client plays it. `marks` say when each move starts. */
export interface LoopPlan extends Tracks {
  seconds: number
  marks: Array<{ t: number; move: MoveId }>
}

/**
 * One move on one head, from the working pose and back, as keys from 0 to its length.
 * Reading a move takes some milliseconds and comes out the same every time, so each is
 * read once per head and every plan after that only places the keys in time.
 */
const read = new WeakMap<Head, Map<MoveId, Tracks>>()
function moveTracks(head: Head, move: MoveId): Tracks {
  const known = read.get(head) ?? new Map<MoveId, Tracks>()
  read.set(head, known)
  const before = known.get(move)
  if (before) return before
  const body: BodyKey[] = []
  const eyes: [EyeKey[], EyeKey[]] = [[], []]
  const top: TopKey[] = []
  const { seconds } = moveInfo(move)
  const count = Math.round(seconds * RATE)
  for (let i = 0; i <= count; i += 1) {
    const t = (seconds * i) / count
    const drawn = figure(head, poseAt(move, t))
    body.push({ t, fit: drawn.fit, x: drawn.x, y: drawn.y, lean: drawn.lean, scale: drawn.scale })
    drawn.eyes.forEach((eye, index) => eyes[index]!.push({ t, ...eye }))
    top.push({ t, top: drawn.top })
  }
  const tracks: Tracks = { body: thin(body, BODY_SLACK), eyes: [thin(eyes[0], EYE_SLACK), thin(eyes[1], EYE_SLACK)], top: thin(top, TOP_SLACK) }
  known.set(move, tracks)
  return tracks
}

/**
 * A run of moves on one face, as keys to play straight from one to the next: the body
 * (see `Figure`), each eye in the head's own space, and how far the outline is into the
 * top view. It starts and ends in the working pose, and holds it for each step's rest.
 */
export function loopPlan(head: Head, steps: readonly Step[]): LoopPlan {
  const home = figure(head, WORK)
  const plan: LoopPlan = {
    seconds: 0,
    body: [{ t: 0, fit: home.fit, x: home.x, y: home.y, lean: home.lean, scale: home.scale }],
    eyes: [[{ t: 0, ...home.eyes[0] }], [{ t: 0, ...home.eyes[1] }]],
    top: [{ t: 0, top: home.top }],
    marks: [],
  }
  for (const step of steps) {
    const from = plan.seconds
    const tracks = moveTracks(head, step.move)
    plan.marks.push({ t: from, move: step.move })
    plan.seconds = from + moveInfo(step.move).seconds + step.rest
    // A move starts where the run already is, so its first key is left out; its last one is held through the rest.
    const join = <K extends { t: number }>(to: K[], keys: readonly K[]) => {
      for (const key of keys.slice(1)) to.push({ ...key, t: from + key.t })
      if (step.rest > 0) to.push({ ...keys[keys.length - 1]!, t: plan.seconds })
    }
    join(plan.body, tracks.body)
    join(plan.eyes[0], tracks.eyes[0])
    join(plan.eyes[1], tracks.eyes[1])
    join(plan.top, tracks.top)
  }
  return plan
}

/** A track's key at `t`, straight between the keys around it, as a client plays them. */
export function keyAt<K extends { t: number }>(keys: readonly K[], t: number): K {
  const next = keys.findIndex((key) => key.t > t)
  if (next <= 0) return keys[next === 0 ? 0 : keys.length - 1]!
  const [a, b] = [keys[next - 1]!, keys[next]!] as [Record<string, number>, Record<string, number>]
  const u = (t - a.t!) / (b.t! - a.t!)
  return Object.fromEntries(Object.keys(a).map((field) => [field, field === 't' ? t : lerp(a[field]!, b[field]!, u)])) as unknown as K
}

/** What a plan draws `t` seconds in: where a client that stops there walks on from. */
export function figureAt(plan: LoopPlan, t: number): Figure {
  const { t: _body, ...body } = keyAt(plan.body, t)
  const eye = (keys: readonly EyeKey[]): EyeShape => {
    const { t: _eye, ...shape } = keyAt(keys, t)
    return shape
  }
  return { ...body, top: keyAt(plan.top, t).top, eyes: [eye(plan.eyes[0]), eye(plan.eyes[1])] }
}

/** How long a face takes from the library's drawing into the working pose, and from anywhere back out. */
export const WAKE = 0.25
/** How many keys a walk is read into; its curve is in where they lie. */
const WALK_KEYS = 8

/**
 * A straight walk from one drawing of a face to another, eased at both ends, as a plan
 * like any other. It is how a face wakes into the working pose (from `figure` at no
 * work to `figure` at full work), how it goes home from the middle of a move, and how
 * it gets to the working pose before it melts into dots. An eye that is behind the head
 * at one end grows or shrinks where the other end has it instead of sliding in.
 */
export function walk(from: Figure, to: Figure, seconds = WAKE): LoopPlan {
  const body: BodyKey[] = []
  const eyes: [EyeKey[], EyeKey[]] = [[], []]
  const top: TopKey[] = []
  const gone = (eye: EyeShape) => eye.a === 0 && eye.b === 0
  const ends = from.eyes.map((eye, index): [EyeShape, EyeShape] => {
    const other = to.eyes[index]!
    return [gone(eye) ? { ...other, a: 0, b: 0 } : eye, gone(other) ? { ...eye, a: 0, b: 0 } : other]
  })
  for (let i = 0; i <= WALK_KEYS; i += 1) {
    const t = (seconds * i) / WALK_KEYS
    const u = EASE.both(i / WALK_KEYS)
    body.push({ t, fit: lerp(from.fit, to.fit, u), x: lerp(from.x, to.x, u), y: lerp(from.y, to.y, u), lean: lerp(from.lean, to.lean, u), scale: lerp(from.scale, to.scale, u) })
    ends.forEach(([a, b], index) => eyes[index]!.push({ t, x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), a: lerp(a.a, b.a, u), b: lerp(a.b, b.b, u), round: lerp(a.round, b.round, u) }))
    top.push({ t, top: lerp(from.top, to.top, u) })
  }
  return { seconds, body, eyes, top, marks: [] }
}

// ── The dots she writes behind ──────────────────────────────────────────────────────────

/** One eye's offset from its place and its scale there, in the face's 100-unit box. */
export interface EyePose {
  x: number
  y: number
  sx: number
  sy: number
}

export interface Stop {
  t: number
  pose: EyePose
  /** The curve into the next stop. */
  ease: string
}

/** One value over the melt, for the parts of the face that are not the eyes. */
export interface Key<V> {
  t: number
  v: V
  /** The curve into the next key. */
  ease: string
}

export interface Dot {
  x: number
  y: number
  s: number
}

/** The dots in the face's 100-unit box: radius, the step between centres, and how high each hops. */
export const DOT = { r: 8, step: 22, hop: 5 }
/** The goo filter's blur while shapes melt together, in the same units. */
export const GOO = 3.5
/** How much faster than authored the melt plays. */
export const DOTS_RATE = 1.6

const SWAY = 'cubic-bezier(0.45, 0, 0.55, 1)'
const LEAVE = 'cubic-bezier(0.55, 0, 1, 0.45)'
const ARRIVE = 'cubic-bezier(0.1, 0.6, 0.3, 1)'
const POP = 'cubic-bezier(0.3, 1.5, 0.5, 1)'
const SPRING = 'cubic-bezier(0.3, 1.3, 0.5, 1)'
const SINK = 'cubic-bezier(0.5, 0, 0.75, 0)'
/** One round of hops, how many rounds a pass holds, and the rest before the next pass. */
export const HOP = 1.4
const HOPS = 24
const REST = 0.7
/** How far toward the middle of the body an eye sinks before it is gone. */
const GATHER = 0.6

function track<V>(home: V): Array<Key<V>> {
  return [{ t: 0, v: home, ease: 'linear' }]
}

function to<V>(keys: Array<Key<V>>, t: number, v: V, ease = SWAY) {
  keys[keys.length - 1]!.ease = ease
  keys.push({ t, v, ease: 'linear' })
}

function wait<V>(keys: Array<Key<V>>, t: number) {
  const last = keys[keys.length - 1]!
  if (t > last.t) to(keys, t, last.v, 'linear')
}

/** A number track's value at `t`, eased in and out between keys. */
export function sample(keys: ReadonlyArray<Key<number>>, t: number) {
  const next = keys.findIndex((key) => key.t > t)
  if (next <= 0) return keys[next === 0 ? 0 : keys.length - 1]!.v
  const a = keys[next - 1]!
  const b = keys[next]!
  return a.v + (b.v - a.v) * smooth((t - a.t) / (b.t - a.t))
}

/**
 * One pass of the melt and its length in seconds: the eyes sink into the middle of the
 * body, the body shrinks after them into three dots in its own colour, the dots hop in
 * turn for as long as a pass holds, and the face swells back out of them. A pass is
 * long, so an answer rarely outlasts it. `pulls` runs from each eye to the middle of
 * the body.
 */
export function dotsPlan(pulls: readonly [Pair, Pair]) {
  const home: EyePose = { x: 0, y: 0, sx: 1, sy: 1 }
  const body = track(1)
  const blur = track(0)
  const dots = [0, 1, 2].map(() => track<Dot>({ x: 0, y: 0, s: 0 }))
  // The eyes sink into the middle, the body shrinks after them, and three drops bud out of it as it goes.
  wait(body, 0.2)
  to(body, 1.0, 0)
  wait(blur, 0.2)
  to(blur, 0.7, GOO)
  dots.forEach((keys, index) => {
    wait(keys, 0.45)
    to(keys, 0.75, { x: 0, y: 0, s: 1 }, ARRIVE)
    if (index !== 1) to(keys, 1.35, { x: (index - 1) * DOT.step, y: 0, s: 1 }, SPRING)
  })
  wait(blur, 1.35)
  to(blur, 1.85, 0)
  // Writing: each dot hops in turn, round after round.
  const wave = 1.6
  dots.forEach((keys, index) => {
    const x = (index - 1) * DOT.step
    for (let round = 0; round < HOPS; round += 1) {
      const go = wave + round * HOP + index * 0.16
      wait(keys, go)
      to(keys, go + 0.32, { x, y: -DOT.hop, s: 1.06 })
      to(keys, go + 0.64, { x, y: 0, s: 1 })
    }
  })
  // And back: the drops run together, the body swells out of them, and the eyes pop out of the middle.
  const back = wave + HOPS * HOP
  wait(blur, back - 0.35)
  to(blur, back + 0.05, GOO)
  wait(blur, back + 0.7)
  to(blur, back + 1.2, 0)
  dots.forEach((keys) => {
    wait(keys, back)
    to(keys, back + 0.5, { x: 0, y: 0, s: 1 }, LEAVE)
    to(keys, back + 0.95, { x: 0, y: 0, s: 0 })
  })
  wait(body, back + 0.3)
  to(body, back + 1.2, 1, ARRIVE)
  const seconds = back + 1.4 + REST
  wait(body, seconds)
  wait(blur, seconds)
  for (const keys of dots) wait(keys, seconds)
  const eyes = pulls.map(([px, py]): Stop[] => {
    const gone: EyePose = { x: GATHER * px, y: GATHER * py, sx: 0, sy: 0 }
    return [
      { t: 0, pose: home, ease: SINK },
      { t: 0.4, pose: gone, ease: 'linear' },
      { t: back + 0.9, pose: gone, ease: POP },
      { t: back + 1.3, pose: home, ease: 'linear' },
      { t: seconds, pose: home, ease: 'linear' },
    ]
  }) as [Stop[], Stop[]]
  // `hops` is when the dots are out and the first round of hops begins.
  return { eyes, body, blur, dots, seconds, hops: wave }
}

export type DotsPlan = ReturnType<typeof dotsPlan>
