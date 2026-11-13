/**
 * The working face's choreography, shared by every client that draws it.
 *
 * While her turn runs, a persona's eyes run a long loop of small moves, after the
 * Grok working face the user recorded on 3 Oct. They grow and shrink, squint, hop, spin,
 * trade places, leave the shape on one side and come back on another, and circle the
 * face.
 *
 * Moves are grouped into variations so not every turn looks the same. A turn starts on
 * the variation its seed picks and runs on through the others, so a long turn keeps
 * changing too. Every move starts and ends with the eyes at home, so any order plays
 * with a short rest between. Between two variations the whole face can melt into three
 * thinking dots in its own place, and swell back out of them.
 *
 * This file only plans the loop: what each eye, the body and the dots do and when.
 * The web drives it with the Web Animations API on the library's eye nodes, the phone
 * with Reanimated keyframes on its own eye layers.
 */

/** One eye's offset from where the library put it, in the face's 100-unit box. */
export interface EyePose {
  x: number
  y: number
  sx: number
  sy: number
  /** Degrees on top of the library's own tilt. */
  r: number
}

/**
 * How a move describes an eye. `spread` and `lift` move the pair together, in halves
 * of the gap between them: `spread` along the line through both eyes (-2 lands each
 * on the other's spot), `lift` across it (the left eye up, the right one down). The
 * gap differs per face, so they are resolved once the face is known.
 */
interface Pose extends EyePose {
  spread: number
  lift: number
  /** Toward the middle of the body, where the dots form; 1 lands the eye there. */
  gather: number
}

interface Beat {
  /** Seconds at speed 1. Zero is a jump, which only ever happens out of sight. */
  d: number
  ease?: string
  /** The target for both eyes, from home. Fields left out are home. */
  both?: Partial<Pose>
  /** The right eye's differences from `both`, for a turned head. */
  right?: Partial<Pose>
  /** Stay where the last beat left both eyes. */
  hold?: true
}

export const HOME: Pose = { x: 0, y: 0, sx: 1, sy: 1, r: 0, spread: 0, lift: 0, gather: 0 }
const SWAY = 'cubic-bezier(0.45, 0, 0.55, 1)'
const LEAVE = 'cubic-bezier(0.55, 0, 1, 0.45)'
const ARRIVE = 'cubic-bezier(0.1, 0.6, 0.3, 1)'
const RISE = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)'
const FALL = 'cubic-bezier(0.55, 0.085, 0.68, 0.53)'
const DART = 'cubic-bezier(0.3, 0, 0.1, 1)'
const POP = 'cubic-bezier(0.3, 1.5, 0.5, 1)'
const SPRING = 'cubic-bezier(0.3, 1.3, 0.5, 1)'
const SINK = 'cubic-bezier(0.5, 0, 0.75, 0)'
const REST = 0.7
/** Far enough to clear every silhouette sideways or up and down. */
const OUT = 58
const ORBIT = 11

const linear = (u: number) => u
export const smooth = (u: number) => u * u * (3 - 2 * u)

/** A path sampled into short linear beats, with `shape` easing the whole of it. */
function curve(seconds: number, steps: number, shape: (u: number) => number, at: (u: number) => Partial<Pose>): Beat[] {
  return Array.from({ length: steps }, (_, index) => ({
    d: seconds / steps,
    ease: 'linear',
    both: at(shape((index + 1) / steps)),
  }))
}

const turn = (from: number, to: number) => (u: number) => {
  const angle = Math.PI * (from + (to - from) * u)
  return { spread: Math.cos(angle) - 1, lift: Math.sin(angle) }
}

const MOVES = {
  shrink: {
    label: 'Shrink',
    beats: [
      { d: 0.6, ease: SWAY, both: { sx: 0.7, sy: 0.7 } },
      { d: 0.5, hold: true },
      { d: 0.6, ease: SWAY },
    ],
  },
  glance: {
    label: 'Glance with a squint',
    beats: [
      {
        d: 0.18,
        ease: 'ease-in',
        both: { x: -4, y: -4, sx: 0.55, sy: 0.18, r: -18 },
      },
      {
        d: 0.22,
        ease: 'ease-out',
        both: { x: -7, y: -7, sx: 0.85, sy: 0.85, r: -18 },
      },
      { d: 0.7, hold: true },
      { d: 0.7, ease: SWAY, both: { x: 6, y: -1, sx: 1.2, sy: 1.2, r: 14 } },
      { d: 0.8, hold: true },
      { d: 0.6, ease: SWAY },
    ],
  },
  top: {
    label: 'Out the top, in from below',
    flipped: 'Out the bottom, in from above',
    beats: [
      { d: 0.5, ease: SWAY, both: { y: 5 } },
      { d: 0.45, ease: LEAVE, both: { y: -OUT, sy: 1.15 } },
      { d: 0, both: { y: OUT, sy: 1.15 } },
      { d: 0.6, ease: ARRIVE, both: { y: -3 } },
      { d: 0.35, ease: SWAY },
    ],
  },
  grow: {
    label: 'Grow',
    beats: [
      { d: 0.6, ease: SWAY, both: { sx: 1.4, sy: 1.4 } },
      { d: 0.6, hold: true },
      { d: 0.6, ease: SWAY },
    ],
  },
  side: {
    label: 'Out the right, in from the left',
    flipped: 'Out the left, in from the right',
    beats: [
      {
        d: 0.6,
        ease: SWAY,
        both: { x: 7, sx: 0.85, sy: 0.95 },
        right: { x: 9, sx: 0.55 },
      },
      { d: 0.4, hold: true },
      { d: 0.5, ease: LEAVE, both: { x: OUT, sx: 0.4, sy: 0.9 } },
      { d: 0, both: { x: -OUT, sx: 0.4, sy: 0.9 } },
      {
        d: 0.6,
        ease: ARRIVE,
        both: { x: -7, sx: 0.85, sy: 0.95 },
        right: { x: -5 },
      },
      { d: 0.2, hold: true },
      { d: 0.6, ease: SWAY },
    ],
  },
  orbit: {
    label: 'Circle the face',
    beats: [
      { d: 0.5, ease: SWAY, both: { x: -ORBIT, sx: 1.15, sy: 0.6 } },
      ...curve(1.6, 16, linear, (u) => {
        const angle = Math.PI * (1 + 2 * u)
        return {
          x: ORBIT * Math.cos(angle),
          y: ORBIT * Math.sin(angle),
          sx: 1.15,
          sy: 0.6,
          r: 25 * Math.sin(angle),
        }
      }),
      { d: 0.55, ease: SWAY },
    ],
  },
  hop: {
    label: 'Hop',
    beats: [
      { d: 0.3, ease: SWAY, both: { y: 2, sx: 1.2, sy: 0.75 } },
      { d: 0.32, ease: RISE, both: { y: -12, sx: 0.88, sy: 1.15 } },
      { d: 0.28, ease: FALL, both: { y: 1, sx: 0.95, sy: 1.05 } },
      { d: 0.1, ease: 'ease-out', both: { y: 2, sx: 1.25, sy: 0.72 } },
      { d: 0.22, ease: RISE, both: { y: -5, sx: 0.95, sy: 1.06 } },
      { d: 0.2, ease: FALL, both: { y: 1, sx: 1.05, sy: 0.95 } },
      { d: 0.35, ease: SWAY },
    ],
  },
  squeeze: {
    label: 'Squeeze shut, pop open',
    beats: [
      { d: 0.35, ease: SWAY, both: { sx: 1.2, sy: 0.12 } },
      { d: 0.8, hold: true },
      { d: 0.25, ease: POP, both: { sx: 1.25, sy: 1.25 } },
      { d: 0.4, hold: true },
      { d: 0.5, ease: SWAY },
    ],
  },
  cross: {
    label: 'Cross-eyed',
    beats: [
      { d: 0.6, ease: SWAY, both: { spread: -0.45, y: 2, sx: 0.9, sy: 0.9 } },
      { d: 0.7, hold: true },
      { d: 0.5, ease: SWAY },
    ],
  },
  split: {
    label: 'Out both sides, drop in from above',
    beats: [
      { d: 0.45, ease: SWAY, both: { spread: 0.25, sy: 1.05 } },
      { d: 0.45, ease: LEAVE, both: { x: -OUT, sx: 0.6 }, right: { x: OUT } },
      { d: 0, both: { y: -OUT } },
      { d: 0.45, ease: FALL, both: { y: 2, sx: 1.15, sy: 0.8 } },
      { d: 0.35, ease: SWAY },
    ],
  },
  wobble: {
    label: 'Wobble',
    beats: [
      ...[5, -4, 3, -2, 1].map((x) => ({
        d: 0.15,
        ease: SWAY,
        both: { x, r: 1.6 * x },
      })),
      { d: 0.2, ease: SWAY },
    ],
  },
  spin: {
    label: 'Spin in place',
    beats: [
      { d: 0.4, ease: SWAY, both: { sx: 1.15, sy: 0.6 } },
      {
        d: 1.1,
        ease: SWAY,
        both: { sx: 1.15, sy: 0.6, r: 360 },
        right: { r: -360 },
      },
      // A full turn reads the same as none, so this jump is invisible.
      { d: 0, both: { sx: 1.15, sy: 0.6 } },
      { d: 0.4, ease: SWAY },
    ],
  },
  dart: {
    label: 'Dart to the corners',
    beats: [
      { d: 0.14, ease: DART, both: { x: -6, y: -5 } },
      { d: 0.45, hold: true },
      { d: 0.14, ease: DART, both: { x: 6, y: -5 } },
      { d: 0.45, hold: true },
      { d: 0.14, ease: DART, both: { x: 6, y: 4 } },
      { d: 0.35, hold: true },
      { d: 0.14, ease: DART, both: { x: -5, y: 4 } },
      { d: 0.45, hold: true },
      { d: 0.4, ease: SWAY },
    ],
  },
  swirl: {
    label: 'Swap places and back',
    beats: [...curve(1.1, 12, smooth, turn(0, 1)), { d: 0.5, hold: true }, ...curve(1.1, 12, smooth, turn(1, 2))],
  },
  eight: {
    label: 'Figure eight',
    beats: curve(2.6, 26, smooth, (u) => ({
      x: 10 * Math.sin(2 * Math.PI * u),
      y: -4 * Math.sin(4 * Math.PI * u),
    })),
  },
} satisfies Record<string, { label: string; flipped?: string; beats: Beat[] }>

type MoveId = keyof typeof MOVES
/** A move as it plays: `~x` mirrors it left to right, `~y` turns it upside down. */
type Step = MoveId | `${MoveId}~${'x' | 'y'}`

export const VARIATIONS = {
  recorded: {
    label: 'Recorded',
    steps: ['shrink', 'glance', 'top', 'grow', 'side', 'orbit'],
  },
  mirrored: {
    label: 'Mirrored',
    steps: ['grow', 'glance~x', 'top~y', 'shrink', 'side~x', 'orbit~x'],
  },
  bouncy: {
    label: 'Bouncy',
    steps: ['hop', 'wobble', 'squeeze', 'split', 'cross', 'hop'],
  },
  twirl: {
    label: 'Twirl',
    steps: ['spin', 'swirl', 'side~x', 'eight', 'grow', 'orbit~x'],
  },
  restless: {
    label: 'Restless',
    steps: ['dart', 'cross', 'top~y', 'swirl~x', 'eight~x', 'shrink'],
  },
} satisfies Record<string, { label: string; steps: Step[] }>

export type VariationId = keyof typeof VARIATIONS
export const VARIATION_IDS = Object.keys(VARIATIONS) as VariationId[]

const parse = (step: Step) => step.split('~') as [MoveId, ('x' | 'y')?]

/** The moves of one variation, named the way they play. */
export function stepLabels(id: VariationId) {
  return (VARIATIONS[id].steps as readonly Step[]).map((step) => {
    const [move, axis] = parse(step)
    const entry: { label: string; flipped?: string } = MOVES[move]
    return axis === undefined ? entry.label : (entry.flipped ?? `${entry.label}, the other way`)
  })
}

export interface BusyLook {
  /** Playback rate; 1 is the recorded pace. */
  speed: number
  /** One variation on repeat, `shuffle` for what a turn does, or `dots` for the melt alone, held. */
  variation: VariationId | 'shuffle' | 'dots'
  /** Melt into three dots after each variation, and back. */
  dots: boolean
  /** Which variation a shuffle starts on. Absent, each start takes the next one, so two turns in a row differ. */
  seed?: number
}

/** What every persona wears while her turn runs, as the user set it in the playground on 3 Oct. */
export const BUSY_LOOK: BusyLook = { speed: 1.6, variation: 'shuffle', dots: true }

/** What the face is doing now: a variation, or the dots between two. */
export type Segment = VariationId | 'dots'

/** The variations one run plays, in order: a shuffle starts where the seed says and runs through all of them. */
export function order(variation: BusyLook['variation'], seed: number): VariationId[] {
  // The dots alone play no variation at all; `timeline` holds the melt instead.
  if (variation === 'dots') return []
  if (variation !== 'shuffle') return [variation]
  const first = seed % VARIATION_IDS.length
  return [...VARIATION_IDS.slice(first), ...VARIATION_IDS.slice(0, first)]
}

export interface Stop {
  t: number
  pose: EyePose
  /** The curve into the next stop. */
  ease: string
}

/** One value over the loop, for the parts of the face that are not the eyes. */
export interface Key<V> {
  t: number
  v: V
  /** The curve into the next key. */
  ease: string
}

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

export interface Dot {
  x: number
  y: number
  s: number
}

/** The dots in the face's 100-unit box: radius, the step between centres, and how high each hops. */
export const DOT = { r: 8, step: 22, hop: 5 }
/** The goo filter's blur while shapes melt together, in the same units. */
export const GOO = 3.5
const HOP = 1.4
/** How many times round the dots hop before the face comes back. */
const HOPS = 5
/** The same for the dots held on their own, while an answer streams in: long enough that a pass rarely ends. */
const HELD_HOPS = 24

export type Pair = [number, number]

/** A move's pose for one eye, turned the way the step plays it and placed against this face's eye gap. */
function place(pose: Pose, side: -1 | 1, [hx, hy]: Pair, fx: number, fy: number, [px, py]: Pair): EyePose {
  const lift = pose.lift * fx * fy
  return {
    x: pose.x * fx + side * (pose.spread * hx - lift * hy) + pose.gather * px,
    y: pose.y * fy + side * (pose.spread * hy + lift * hx) + pose.gather * py,
    sx: pose.sx,
    sy: pose.sy,
    r: pose.r * fx * fy,
  }
}

/**
 * Everything one pass of `ids` moves, and its length in seconds: both eyes, and with
 * `melt` the body's scale, the three dots and the goo blur. No ids and a melt is the
 * dots alone, held. `half` is half the step
 * from the left eye's centre to the right one's, and `pulls` runs from each eye to the
 * middle of the body.
 */
export function timeline(ids: readonly VariationId[], half: Pair, pulls: [Pair, Pair], melt: boolean) {
  const home = place(HOME, 1, half, 1, 1, pulls[1])
  const eyes: [Stop[], Stop[]] = [[{ t: 0, pose: home, ease: 'linear' }], [{ t: 0, pose: home, ease: 'linear' }]]
  const body = track(1)
  const blur = track(0)
  const dots = [0, 1, 2].map(() => track<Dot>({ x: 0, y: 0, s: 0 }))
  const marks: Array<{ t: number; id: Segment }> = []
  let t = 0
  const step = (beat: Beat, fx = 1, fy = 1) => {
    t += beat.d
    eyes.forEach((stops, index) => {
      const last = stops[stops.length - 1]!
      last.ease = beat.ease ?? SWAY
      // Mirrored, the turned-head eye is the left one.
      const lead = fx < 0 ? 0 : 1
      const pose = beat.hold
        ? last.pose
        : place({ ...HOME, ...beat.both, ...(index === lead ? beat.right : {}) }, index === 0 ? -1 : 1, half, fx, fy, pulls[index]!)
      stops.push({ t, pose, ease: 'linear' })
    })
  }

  const dotsBetween = (hops = HOPS) => {
    const from = t
    const at = (dt: number) => from + dt
    marks.push({ t: from, id: 'dots' })
    // The eyes sink into the middle, the body shrinks after them, and three drops bud out of it as it goes.
    step({ d: 0.4, ease: SINK, both: { gather: 0.6, sx: 0, sy: 0 } })
    wait(body, at(0.2))
    to(body, at(1.0), 0)
    wait(blur, at(0.2))
    to(blur, at(0.7), GOO)
    dots.forEach((keys, index) => {
      wait(keys, at(0.45))
      to(keys, at(0.75), { x: 0, y: 0, s: 1 }, ARRIVE)
      if (index !== 1) to(keys, at(1.35), { x: (index - 1) * DOT.step, y: 0, s: 1 }, SPRING)
    })
    wait(blur, at(1.35))
    to(blur, at(1.85), 0)
    // Thinking: each dot hops in turn, HOPS times round.
    const wave = at(1.6)
    dots.forEach((keys, index) => {
      const x = (index - 1) * DOT.step
      for (let round = 0; round < hops; round++) {
        const go = wave + round * HOP + index * 0.16
        wait(keys, go)
        to(keys, go + 0.32, { x, y: -DOT.hop, s: 1.06 })
        to(keys, go + 0.64, { x, y: 0, s: 1 })
      }
    })
    // And back: the drops run together, the body swells out of them, and the eyes pop out of the middle.
    const back = wave + hops * HOP
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
    step({ d: back + 0.9 - t, hold: true })
    step({ d: 0.4, ease: POP })
    step({ d: back + 1.4 - t, hold: true })
  }

  for (const id of ids) {
    marks.push({ t, id })
    for (const each of VARIATIONS[id].steps as readonly Step[]) {
      const [move, axis] = parse(each)
      const beats: readonly Beat[] = MOVES[move].beats
      for (const beat of beats) step(beat, axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1)
      step({ d: REST, hold: true })
    }
    if (melt) {
      dotsBetween()
      step({ d: REST, hold: true })
    }
  }
  // No variation and a melt is the dots on their own: the face melts once and stays melted.
  if (ids.length === 0 && melt) {
    dotsBetween(HELD_HOPS)
    step({ d: REST, hold: true })
  }
  wait(body, t)
  wait(blur, t)
  for (const keys of dots) wait(keys, t)
  return { eyes, body, blur, dots, total: t, marks }
}

export type BusyPlan = ReturnType<typeof timeline>
