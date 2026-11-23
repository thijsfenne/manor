/**
 * The body's half of a face's language, shared by every client that draws it.
 *
 * A working face moves as a whole (see `busyFace`). Every other moment holds a pose
 * and lets the body say what kind of moment it is: a nod, a shake, a bounce, a slow
 * breath. A gesture moves or deforms the whole figure, finish and eyes with it, and
 * leaves each eye's own motion alone, so it plays on top of a pose without knowing
 * about it.
 *
 * A face may never leave its slot, and the ten silhouettes fill it differently, so a
 * gesture is sized per face rather than authored small enough for the largest. `fit`
 * measures the outline against the slot: a body with no room left first draws in a
 * little about its own middle, which reads as gathering itself and frees room on
 * every side, and only past that does the gesture get smaller.
 *
 * This file only plans. The web plays the keys with the Web Animations API on the
 * library's own groups, the phone as Reanimated keyframes on views of its own.
 */

export type Pair = readonly [number, number]

/** One key of the figure: where it sits and how it is stretched. */
export interface GestureKey {
  x?: number
  y?: number
  sx?: number
  sy?: number
}

export interface Gesture {
  /** One pass, in milliseconds. */
  ms: number
  /** The figure's keys by offset, 0 to 1. Absent, the figure stays as it is. */
  fig?: ReadonlyArray<readonly [offset: number, key: GestureKey]>
  /** The figure's turn in degrees by offset, about the middle of what is drawn. */
  rot?: ReadonlyArray<readonly [offset: number, degrees: number]>
}

export const GESTURES = {
  /** A double dip with a slight squash. */
  nod: { ms: 2200, fig: [[0, {}], [0.12, { y: 4.5, sx: 1.03, sy: 0.95 }], [0.26, {}], [0.38, { y: 3, sx: 1.02, sy: 0.97 }], [0.5, {}], [1, {}]] },
  /** Side to side with a counter turn, damped. */
  shake: {
    ms: 2200,
    fig: [[0, {}], [0.07, { x: -4 }], [0.14, { x: 4 }], [0.21, { x: -3 }], [0.28, { x: 3 }], [0.35, { x: -1.5 }], [0.42, {}], [1, {}]],
    rot: [[0, 0], [0.07, 4], [0.14, -4], [0.21, 3], [0.28, -3], [0.35, 1.5], [0.42, 0], [1, 0]],
  },
  /** Anticipate, jump, land, settle. */
  bounce: { ms: 1900, fig: [[0, {}], [0.09, { y: 2, sx: 1.08, sy: 0.9 }], [0.27, { y: -9, sx: 0.94, sy: 1.08 }], [0.43, { sx: 1.1, sy: 0.88 }], [0.54, { y: -3, sx: 0.98, sy: 1.03 }], [0.65, {}], [1, {}]] },
  /** A slow, deflating breath. */
  sink: { ms: 4800, fig: [[0, {}], [0.5, { sx: 1.05, sy: 0.93 }], [1, {}]] },
} satisfies Record<string, Gesture>

export type GestureId = keyof typeof GESTURES

/** The slot's side in the face's own units, and how close a gesture may come to its edge. */
const BOX = 100
const CLEAR = 1
/** The most a body draws in before its gesture is made smaller instead. */
const TIGHT = 0.8

/**
 * What a face is measured by: points along its outline, the foot the figure scales
 * about, and the middle it turns about. The middle is that of everything drawn, not
 * of the core body, so a droplet's tip sweeps the smallest circle it can.
 */
export interface Frame {
  pts: ReadonlyArray<Pair>
  foot: Pair
  middle: Pair
}

/**
 * Points along everything a body is drawn from: its circles, and its paths with each
 * curve sampled where it runs rather than where its handles are. Reads the absolute
 * commands the face library writes.
 */
export function outlinePoints(paths: readonly string[], circles: ReadonlyArray<{ cx: number; cy: number; r: number }>): Pair[] {
  const pts: Pair[] = circles.flatMap((c) =>
    Array.from({ length: 24 }, (_, i): Pair => [c.cx + c.r * Math.cos((i * Math.PI) / 12), c.cy + c.r * Math.sin((i * Math.PI) / 12)]),
  )
  const mix = (a: Pair, b: Pair, u: number): Pair => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]
  for (const d of paths) {
    let at: Pair = [0, 0]
    for (const [, command, args = ''] of d.matchAll(/([MLCQHV])([^MLCQHVZ]*)/g)) {
      const v = args.trim().split(/[\s,]+/).filter(Boolean).map(Number)
      const size = command === 'C' ? 6 : command === 'Q' ? 4 : command === 'H' || command === 'V' ? 1 : 2
      for (let i = 0; i + size <= v.length; i += size) {
        const ends: Pair[] = []
        for (let j = 0; j + 1 < size; j += 2) ends.push([v[i + j]!, v[i + j + 1]!])
        if (command === 'H') ends.push([v[i]!, at[1]])
        if (command === 'V') ends.push([at[0], v[i]!])
        // De Casteljau at a quarter, a half and three quarters of a curve.
        if (ends.length > 1) {
          for (const u of [0.25, 0.5, 0.75]) {
            let line: Pair[] = [at, ...ends]
            while (line.length > 1) line = line.slice(1).map((p, k) => mix(line[k]!, p, u))
            pts.push(line[0]!)
          }
        }
        at = ends[ends.length - 1]!
        pts.push(at)
      }
    }
  }
  return pts
}

export function frameOf(pts: ReadonlyArray<Pair>): Frame {
  if (pts.length === 0) return { pts, foot: [BOX / 2, BOX / 2], middle: [BOX / 2, BOX / 2] }
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const middle: Pair = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
  return { pts, foot: [middle[0], Math.max(...ys)], middle }
}

/**
 * How one face plays one gesture: at what amplitude, and drawn in how far about its
 * middle for the whole of it.
 */
export interface Fit {
  amount: number
  drawIn: number
}

/** A key as the numbers a client animates, under a fit. */
export interface Placed {
  x: number
  y: number
  sx: number
  sy: number
}

export function place(key: GestureKey, fit: Fit): Placed {
  return {
    x: (key.x ?? 0) * fit.amount,
    y: (key.y ?? 0) * fit.amount,
    sx: 1 + ((key.sx ?? 1) - 1) * fit.amount,
    sy: 1 + ((key.sy ?? 1) - 1) * fit.amount,
  }
}

/**
 * The foot of a body drawn in about its middle: its lowest point comes up with it, and
 * that is where it squashes from, or a stretch would be measured from the ground it
 * has left.
 */
const footOf = (frame: Frame, fit: Fit): Pair => [frame.foot[0], frame.middle[1] + (frame.foot[1] - frame.middle[1]) * fit.drawIn]

/** A track's value at one moment of the loop, blended between the two keys it lies between. */
function at<V, R>(keys: ReadonlyArray<readonly [number, V]>, t: number, blend: (a: V, b: V, u: number) => R): R {
  const next = keys.findIndex(([offset]) => offset >= t)
  const b = keys[next < 0 ? keys.length - 1 : next]!
  const a = keys[Math.max((next < 0 ? keys.length : next) - 1, 0)]!
  return blend(a[1], b[1], b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]))
}

const REST: ReadonlyArray<readonly [number, GestureKey]> = [[0, {}], [1, {}]]
const LEVEL: ReadonlyArray<readonly [number, number]> = [[0, 0], [1, 0]]

/** How far a gesture keeps a face from the edge of its slot under a fit. Negative is clipped. */
export function margin(frame: Frame, gesture: Gesture, fit: Fit): number {
  const figs = gesture.fig ?? REST
  const rots = gesture.rot ?? LEVEL
  const [mx, my] = frame.middle
  const [fx, fy] = footOf(frame, fit)
  let least = Infinity
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const angle = (at(rots, t, (a, b, u) => a + (b - a) * u) * Math.PI) / 180
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const q = at(figs, t, (a, b, u): Placed => {
      const from = place(a, fit)
      const to = place(b, fit)
      const mid = (key: keyof Placed) => from[key] + (to[key] - from[key]) * u
      return { x: mid('x'), y: mid('y'), sx: mid('sx'), sy: mid('sy') }
    })
    for (const [px, py] of frame.pts) {
      // Turned and drawn in about the middle, then stretched and moved about the foot.
      const dx = mx + ((px - mx) * cos - (py - my) * sin) * fit.drawIn - fx
      const dy = my + ((px - mx) * sin + (py - my) * cos) * fit.drawIn - fy
      const x = fx + dx * q.sx + q.x
      const y = fy + dy * q.sy + q.y
      least = Math.min(least, x, y, BOX - x, BOX - y)
    }
  }
  return least
}

/** Sizes a gesture for one face: full amplitude where it fits, drawn in where it nearly does, smaller past that. */
export function fit(frame: Frame, gesture: Gesture): Fit {
  for (const drawIn of [1, 0.96, 0.92, 0.88, 0.84, TIGHT]) {
    const tried = { amount: 1, drawIn }
    if (margin(frame, gesture, tried) >= CLEAR) return tried
  }
  const amount = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1].find((each) => margin(frame, gesture, { amount: each, drawIn: TIGHT }) >= CLEAR) ?? 0
  return { amount, drawIn: TIGHT }
}

/**
 * A gesture for one face, as the keys a client plays. `fig` moves and stretches the
 * figure about `foot`. `rot` turns it about `middle`, where `fit.drawIn` also draws it
 * in for as long as the gesture plays, so a client that nests two groups gives the
 * outer one `fig` and the inner one the other two.
 */
export function plan(id: GestureId, frame: Frame) {
  const gesture: Gesture = GESTURES[id]
  const fitted = fit(frame, gesture)
  return {
    ms: gesture.ms,
    fig: (gesture.fig ?? REST).map(([offset, key]) => ({ offset, ...place(key, fitted) })),
    rot: (gesture.rot ?? LEVEL).map(([offset, degrees]) => ({ offset, degrees })),
    foot: footOf(frame, fitted),
    middle: frame.middle,
    fit: fitted,
  }
}

export type GesturePlan = ReturnType<typeof plan>
