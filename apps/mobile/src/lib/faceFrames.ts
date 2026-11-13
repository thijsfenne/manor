import type { EyeStop } from '@manor/client-runtime/face-activity'
import type { GesturePlan } from '@manor/client-runtime/face-gesture'

/**
 * The shared plans for a body gesture and an added eye move, as keyframes Reanimated
 * can play (see the client runtime's `faceGesture` and `faceActivity`).
 *
 * The Mac walks a face to a move's first key and home again, because it can read
 * where a running animation is. Declared keyframes cannot be asked that. So a layer
 * here is two nested views. The outer one rests at the first key and eases there as a
 * plain style change once the face is drawn. The inner one plays the loop measured
 * from that key, so it starts at nothing. A counted gesture starts and ends at home,
 * so it needs no rest: it draws in and lets go inside its own run. Leaving a move is
 * not walked at all: the face fades over to what comes next (see `Blobatar`).
 */

/** A transform as a view's style takes it: one operation per entry, applied last to first. */
export type Transform = Array<Record<string, number | string>>

export interface Track {
  /** Keyframes by percentage of the run. `ease` is the curve into the next key, where a stop names one. */
  keyframes: Record<string, { transform: Transform; ease?: string }>
  duration: number
  passes: number | 'infinite'
}

export interface Layer {
  /** The layer doing nothing, in the shape of every other transform it takes. */
  home: Transform
  rest: Transform
  loop: Track
}

/** How long a counted gesture takes to draw in before it plays, and to let go after. */
const WALK = 240

// Reanimated's angle parser refuses exponent notation, which values near zero produce.
const degrees = (value: number) => `${Number(value.toFixed(3))}deg`
const percent = (offset: number) => `${Number((Math.min(Math.max(offset, 0), 1) * 100).toFixed(3))}%`

interface FigKey { x: number; y: number; sx: number; sy: number; k: number }
const HOME: FigKey = { x: 0, y: 0, sx: 1, sy: 1, k: 0 }

/** Lean first, then stretch, then move: the order the Mac's stylesheet composes them in. */
const figure = (key: FigKey, unit: number): Transform => [
  { translateX: key.x * unit },
  { translateY: key.y * unit },
  { scaleX: key.sx },
  { scaleY: key.sy },
  { skewX: degrees(key.k) },
]
const turned = (angle: number, draw: number): Transform => [{ rotate: degrees(angle) }, { scale: draw }]

/** A track's value at `t`, straight between the two keys around it. */
function at(keys: ReadonlyArray<readonly [number, number]>, t: number): number {
  const next = keys.findIndex(([offset]) => offset >= t)
  const b = keys[next < 0 ? keys.length - 1 : next]!
  const a = keys[Math.max((next < 0 ? keys.length : next) - 1, 0)]!
  return b[0] === a[0] ? b[1] : a[1] + ((b[1] - a[1]) * (t - a[0])) / (b[0] - a[0])
}

/** One pass of keys, laid end to end `passes` times over one run. */
const repeated = <K extends { offset: number }>(keys: readonly K[], passes: number): K[] =>
  Array.from({ length: passes }, (_, pass) => keys.filter((key) => pass === 0 || key.offset > 0).map((key) => ({ ...key, offset: (pass + key.offset) / passes }))).flat()

/**
 * A gesture as two layers: `fig` moves, stretches and leans the figure about its foot,
 * `turn` turns it and draws it in about its middle. `unit` is points per box unit.
 */
export function gestureFrames(plan: GesturePlan, unit: number, passes?: number): { fig: Layer; turn: Layer } {
  if (passes === undefined) {
    const first = plan.fig[0]!
    const angle = plan.rot[0]!.degrees
    const draw = plan.draw[0]!.d
    const offsets = [...new Set([...plan.rot, ...plan.draw].map((key) => key.offset))].sort((a, b) => a - b)
    const rot = plan.rot.map((key) => [key.offset, key.degrees] as const)
    const drawn = plan.draw.map((key) => [key.offset, key.d] as const)
    return {
      fig: {
        home: figure(HOME, unit),
        rest: figure(first, unit),
        loop: {
          duration: plan.ms,
          passes: 'infinite',
          keyframes: Object.fromEntries(plan.fig.map((key) => [percent(key.offset), {
            transform: figure({ x: key.x - first.x, y: key.y - first.y, sx: key.sx / first.sx, sy: key.sy / first.sy, k: key.k - first.k }, unit),
          }])),
        },
      },
      turn: {
        home: turned(0, 1),
        rest: turned(angle, draw),
        loop: {
          duration: plan.ms,
          passes: 'infinite',
          keyframes: Object.fromEntries(offsets.map((offset) => [percent(offset), { transform: turned(at(rot, offset) - angle, at(drawn, offset) / draw) }])),
        },
      },
    }
  }

  const duration = plan.ms * passes
  const lead = WALK / duration
  const rot = repeated(plan.rot, passes).map((key) => [key.offset, key.degrees] as const)
  // Drawn in over the first moments, held for the whole of the run, let go at the end.
  const draw = plan.fit.drawIn
  const drawn = [[0, 1], [lead, draw], [1 - lead, draw], [1, 1]] as const
  const offsets = [...new Set([...rot, ...drawn].map(([offset]) => offset))].sort((a, b) => a - b)
  return {
    fig: {
      home: figure(HOME, unit),
      rest: figure(HOME, unit),
      loop: { duration, passes: 1, keyframes: Object.fromEntries(repeated(plan.fig, passes).map((key) => [percent(key.offset), { transform: figure(key, unit) }])) },
    },
    turn: {
      home: turned(0, 1),
      rest: turned(0, 1),
      // Straight between keys: the keys that draw the body in fall mid swing, and an
      // eased segment on each side of one would stall the turn there.
      loop: { duration, passes: 1, keyframes: Object.fromEntries(offsets.map((offset) => [percent(offset), { transform: turned(at(rot, offset), at(drawn, offset)), ease: 'linear' }])) },
    },
  }
}

/** An added eye move as a layer: it rests at its first stop and loops from there. */
export function eyeFrames(stops: readonly EyeStop[], unit: number, duration: number): Layer {
  const first = stops[0]!
  const move = (x: number, y: number): Transform => [{ translateX: x * unit }, { translateY: y * unit }]
  return {
    home: move(0, 0),
    rest: move(first.x, first.y),
    loop: {
      duration,
      passes: 'infinite',
      keyframes: Object.fromEntries(stops.map((stop) => [percent(stop.offset), { transform: move(stop.x - first.x, stop.y - first.y), ease: stop.ease }])),
    },
  }
}
