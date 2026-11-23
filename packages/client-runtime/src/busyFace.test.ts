import { blobatar } from '@manor/blobatar'
import { describe, expect, it } from 'vitest'
import { BLOB_FACE_TRAITS, BLOB_SHAPES } from './blobShapes'
import {
  MOVE_IDS,
  WORK,
  dotsPlan,
  eyeReach,
  figure,
  figureAt,
  inside,
  loopPlan,
  loopSteps,
  measure,
  moveInfo,
  outline,
  poseAt,
  walk,
  turned,
  type Figure,
  type Head,
  type HeadPart,
  type MoveId,
  type Pair,
} from './busyFace'
import { outlinePoints } from './faceGesture'

/** A face measured out of the library's own markup, the way a client finds its parts. */
function headOf(name: string, shape: string): Head {
  const markup = blobatar(name, { traits: BLOB_FACE_TRAITS, shape })
  const [head = '', eyes = ''] = [...markup.matchAll(/<g fill="[^"]+">(.*?)<\/g>/g)].map((group) => group[1] ?? '')
  const parts: HeadPart[] = [...head.matchAll(/<(?:path d="([^"]+)"|circle cx="([\d.-]+)" cy="([\d.-]+)" r="([\d.-]+)")/g)].map(
    (match) => match[1] ?? { cx: Number(match[2]), cy: Number(match[3]), r: Number(match[4]) },
  )
  return measure(parts, [...eyes.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]!))!
}

const heads = BLOB_SHAPES.map(({ id }) => ({ shape: id, head: headOf('Manor', id) }))

/** Every pose of a move, read finely enough to catch the fastest part of it. */
const posesOf = (id: MoveId) => Array.from({ length: Math.ceil(moveInfo(id).seconds * 30) + 1 }, (_, i) => poseAt(id, Math.min(moveInfo(id).seconds, i / 30)))

/** The head's outlines as a client draws them at one moment of the morph, read back out of the path data. */
function shapesAt(head: Head, top: number, known: Map<number, { core: Pair[]; all: Pair[] }>) {
  const found = known.get(top)
  if (found) return found
  const shapes = outline(head, top)
  const read = (paths: string[]) => outlinePoints(paths, []).map(([x, y]): Pair => [x, y])
  const made = { core: read([shapes.core]), all: read([shapes.core, ...shapes.extras]) }
  known.set(top, made)
  return made
}

/** A point of the head where a figure draws it in the slot. */
function drawn(head: Head, at: Figure, [px, py]: Pair): Pair {
  const [cx, cy] = head.c
  const [cos, sin] = [Math.cos((at.lean * Math.PI) / 180) * at.scale, Math.sin((at.lean * Math.PI) / 180) * at.scale]
  const [x, y] = [cx + (px - cx) * cos - (py - cy) * sin + at.x, cy + (px - cx) * sin + (py - cy) * cos + at.y]
  return [50 + (x - 50) * at.fit, 50 + (y - 50) * at.fit]
}

describe('the working loop', () => {
  it('has eight moves that each start and end in the working pose', () => {
    expect(MOVE_IDS).toEqual(['lean', 'rock', 'turn', 'top', 'shrink', 'away', 'think', 'down'])
    for (const id of MOVE_IDS) {
      const { seconds } = moveInfo(id)
      const [start, end] = [poseAt(id, 0), poseAt(id, seconds)]
      for (const key of Object.keys(WORK) as Array<keyof typeof WORK>) {
        expect(start[key], `${id} ${key}`).toBeCloseTo(WORK[key], 9)
        // A head that turned all the way round faces front again.
        expect(key === 'sx' || key === 'sy' ? end[key] % 1 : end[key], `${id} ${key}`).toBeCloseTo(WORK[key], 9)
      }
    }
  })

  it.each(heads)('plans tracks that start and end at home on the $shape', ({ shape, head }) => {
    const home = figure(head, WORK)
    const plan = loopPlan(head, loopSteps(3))
    const moves = MOVE_IDS.reduce((sum, id) => sum + moveInfo(id).seconds, 0)
    expect(plan.seconds, shape).toBeGreaterThan(moves + 8 * 0.25)
    expect(plan.seconds, shape).toBeLessThan(moves + 8 * 0.75)
    for (const key of [plan.body[0]!, plan.body.at(-1)!]) {
      expect(key, shape).toMatchObject({ fit: home.fit, x: 0, y: 0, lean: 0, scale: 1 })
    }
    plan.eyes.forEach((keys, index) => {
      expect(keys[0], shape).toMatchObject(home.eyes[index]!)
      expect(keys.at(-1), shape).toMatchObject(home.eyes[index]!)
      expect(keys.at(-1)!.t, shape).toBe(plan.seconds)
    })
    expect([plan.top[0]!.top, plan.top.at(-1)!.top], shape).toEqual([0, 0])
    expect(plan.body.at(-1)!.t, shape).toBe(plan.seconds)
    // Keys run forward in time, so a client can play them as they are.
    for (const keys of [plan.body, plan.eyes[0], plan.eyes[1], plan.top]) expect(keys.every((key, i) => i === 0 || key.t > keys[i - 1]!.t), shape).toBe(true)
    expect(plan.marks.map((mark) => mark.move), shape).toEqual(loopSteps(3).map((step) => step.move))
    // Between two moves the face is back in the working pose and holds it.
    for (const [index, mark] of plan.marks.entries()) {
      if (index > 0) expect(figureAt(plan, mark.t - 0.1), shape).toEqual(home)
      expect(figureAt(plan, mark.t), shape).toEqual(home)
    }
    // A move planned by itself is the same move as in a round.
    const alone = loopPlan(head, [{ move: plan.marks[2]!.move, rest: 0 }])
    expect(alone.seconds).toBe(moveInfo(plan.marks[2]!.move).seconds)
    const [single, inRound] = [figureAt(alone, 0.8), figureAt(plan, plan.marks[2]!.t + 0.8)]
    for (const read of [(at: Figure) => at.y, (at: Figure) => at.lean, (at: Figure) => at.top, (at: Figure) => at.eyes[0].x, (at: Figure) => at.eyes[1].b]) {
      expect(read(single), shape).toBeCloseTo(read(inRound), 9)
    }
  })

  it.each(heads)('plays the keys of a whole round inside the outline and the slot on the $shape', ({ shape, head }) => {
    // What a client shows between two keys is a straight line from one to the next, so this reads the plan, not the moves.
    const plan = loopPlan(head, loopSteps(5))
    const mix = (from: readonly Pair[], to: readonly Pair[], top: number) => from.map(([x, y], i): Pair => [x + (to[i]![0] - x) * top, y + (to[i]![1] - y) * top])
    let [least, out, read] = [Infinity, 0, 0]
    for (let t = 0; t <= plan.seconds; t += 1 / 37) {
      const at = figureAt(plan, t)
      const mark = plan.marks.filter((each) => each.t <= t).at(-1)!
      const core = mix(head.core, head.ball, at.top)
      for (const point of [...core, ...head.extras.flatMap((extra) => mix(extra.from, extra.to, at.top))]) {
        const [x, y] = drawn(head, at, point)
        least = Math.min(least, x, y, 100 - x, 100 - y)
      }
      // A turning eye runs off the edge of the head on purpose; the client's clip cuts it there.
      const near = [-1 / 60, 0, 1 / 60].some((by) => turned(poseAt(mark.move, Math.min(moveInfo(mark.move).seconds, Math.max(0, t + by - mark.t)))))
      if (near) continue
      for (const eye of at.eyes) {
        read += 1
        if (!eyeReach({ ...eye, a: eye.a - 0.05, b: eye.b - 0.05 }).every((point) => inside(core, point))) out += 1
      }
    }
    expect(read, shape).toBeGreaterThan(1000)
    expect(out, shape).toBe(0)
    expect(least, shape).toBeGreaterThanOrEqual(2)
  })

  it('keeps what the thinned keys say close to the move itself', () => {
    const { head } = heads[0]!
    const plan = loopPlan(head, [{ move: 'top', rest: 0.3 }])
    expect(plan.body.length).toBeLessThan(120)
    for (let t = 0; t <= moveInfo('top').seconds; t += 0.013) {
      const [said, meant] = [figureAt(plan, t), figure(head, poseAt('top', t))]
      expect(said.top).toBeCloseTo(meant.top, 1)
      expect(Math.abs(said.y - meant.y)).toBeLessThan(0.1)
    }
    // The eyes cross the front of a pitching head within a few frames, so they are held to their keys.
    for (const key of plan.eyes[0].filter((each) => each.t <= moveInfo('top').seconds)) {
      const meant = figure(head, poseAt('top', key.t)).eyes[0]
      expect(key.x).toBeCloseTo(meant.x, 6)
      expect(key.y).toBeCloseTo(meant.y, 6)
      expect(key.b).toBeCloseTo(meant.b, 6)
    }
    expect(figureAt(plan, 99)).toEqual(figure(head, WORK))
  })

  it('walks a face from the drawing it has into the working pose, and home from the middle of a move', () => {
    const { head } = heads[0]!
    const [rest, work] = [figure(head, WORK, 0), figure(head, WORK)]
    // At no work the eyes are where the library drew them, as ellipses close to its own.
    rest.eyes.forEach((eye, index) => {
      const drawn = head.eyes[index]!
      expect(eye).toMatchObject({ x: drawn.x, y: drawn.y, round: 0 })
      expect(eye.a / drawn.a).toBeGreaterThan(0.95)
      expect(eye.b / drawn.b).toBeGreaterThan(0.95)
    })
    const wake = walk(rest, work)
    expect(wake.seconds).toBe(0.25)
    expect(figureAt(wake, 0)).toEqual(rest)
    expect(figureAt(wake, wake.seconds)).toEqual(work)
    // Stopped while the eyes are behind the head, they grow back where they belong.
    const hidden = figure(head, poseAt('turn', 1.3))
    expect(hidden.eyes[0].a).toBe(0)
    const home = walk(hidden, rest)
    expect(figureAt(home, 0).eyes[0]).toEqual({ ...rest.eyes[0], a: 0, b: 0 })
    expect(figureAt(home, home.seconds)).toEqual(rest)
    const half = figureAt(home, home.seconds / 2)
    expect(half.eyes[0].a).toBeCloseTo(rest.eyes[0].a / 2, 5)
  })

  it('keeps the eyes inside the core outline through every move on every silhouette', () => {
    for (const { shape, head } of heads) {
      const known = new Map<number, { core: Pair[]; all: Pair[] }>()
      for (const id of MOVE_IDS) {
        for (const pose of posesOf(id)) {
          const at = figure(head, pose)
          const { core } = shapesAt(head, at.top, known)
          for (const eye of at.eyes) {
            // Turning, an eye runs off the edge of the head on purpose, and the client's clip
            // to this same outline cuts it there. It still never leaves the ball it rides on.
            if (turned(pose)) {
              expect(Math.abs(eye.x - head.c[0]), `${id} on ${shape}`).toBeLessThanOrEqual(head.hw * 1.03 + 1e-9)
              expect(Math.abs(eye.y - head.c[1]), `${id} on ${shape}`).toBeLessThanOrEqual(head.hh * 1.03 + 1e-9)
            } else {
              expect(eye.a, `${id} on ${shape}`).toBeGreaterThan(0)
              expect(eyeReach(eye).every((point) => inside(core, point)), `${id} on ${shape}`).toBe(true)
            }
          }
        }
      }
    }
  })

  it('plays the approved moves at full size on the bodies they were measured on', () => {
    for (const shape of ['droplet', 'round', 'clover']) expect(heads.find((each) => each.shape === shape)!.head.snug, shape).toBe(1)
    for (const { shape, head } of heads) expect(head.snug, shape).toBeGreaterThanOrEqual(0.75)
  })

  it('hides an eye while it is behind the head, on both turns', () => {
    const { head } = heads[0]!
    for (const id of ['turn', 'top'] as const) {
      const hidden = posesOf(id).filter((pose) => figure(head, pose).eyes.every((eye) => eye.a === 0 && eye.b === 0))
      expect(hidden.length, id).toBeGreaterThan(0)
    }
    for (const id of MOVE_IDS.filter((each) => each !== 'turn' && each !== 'top')) {
      expect(posesOf(id).every((pose) => !turned(pose) && figure(head, pose).eyes.every((eye) => eye.a > 0 && eye.b > 0)), id).toBe(true)
    }
  })

  it('keeps the whole figure inside its slot, outline morph included', () => {
    for (const { shape, head } of heads) {
      const known = new Map<number, { core: Pair[]; all: Pair[] }>()
      for (const id of MOVE_IDS) {
        let least = Infinity
        for (const pose of posesOf(id)) {
          const at = figure(head, pose)
          expect(at.fit, `${id} on ${shape}`).toBeGreaterThan(0.85)
          for (const point of shapesAt(head, at.top, known).all) {
            const [x, y] = drawn(head, at, point)
            least = Math.min(least, x, y, 100 - x, 100 - y)
          }
        }
        // Three units clear by the points the fit is measured on, a little less between them.
        expect(least, `${id} on ${shape}`).toBeGreaterThanOrEqual(2)
      }
    }
  })

  it('turns the outline into a circle of the same area, and back into itself', () => {
    for (const { shape, head } of heads) {
      const area = (pts: readonly Pair[]) => Math.abs(pts.reduce((sum, [x, y], i) => sum + x * pts[(i + 1) % pts.length]![1] - pts[(i + 1) % pts.length]![0] * y, 0) / 2)
      expect(head.core.length, shape).toBe(160)
      expect(area(head.ball) / area(head.core), shape).toBeCloseTo(1, 2)
      for (const [x, y] of outlinePoints([outline(head, 1).core], [])) expect(Math.hypot(x - head.c[0], y - head.c[1]), shape).toBeCloseTo(head.r, 1)
      // Seen from above, nothing sticks out past the ball.
      for (const [x, y] of outlinePoints(outline(head, 1).extras, [])) expect(Math.hypot(x - head.c[0], y - head.c[1]), shape).toBeLessThanOrEqual(head.r)
      expect(outline(head, 0).extras.length, shape).toBe(head.extras.length)
    }
  })
})

describe('the order of the moves', () => {
  it('plays all eight in every round, in an order that differs from round to round', () => {
    const rounds = Array.from({ length: 40 }, (_, seed) => loopSteps(seed))
    for (const round of rounds) {
      expect([...round.map((step) => step.move)].sort()).toEqual([...MOVE_IDS].sort())
      for (const step of round) {
        expect(step.rest).toBeGreaterThanOrEqual(0.25)
        expect(step.rest).toBeLessThanOrEqual(0.75)
      }
    }
    expect(new Set(rounds.map((round) => round.map((step) => step.move).join())).size).toBeGreaterThan(35)
    expect(new Set(rounds.map((round) => round[0]!.move)).size).toBe(MOVE_IDS.length)
    expect(loopSteps(7)).toEqual(loopSteps(7))
  })

  it('never opens a round with the move the last one ended on', () => {
    let after: MoveId | undefined
    for (let seed = 0; seed < 400; seed += 1) {
      const round = loopSteps(seed, after)
      expect(round[0]!.move).not.toBe(after)
      after = round.at(-1)!.move
    }
    for (const id of MOVE_IDS) for (let seed = 0; seed < 50; seed += 1) expect(loopSteps(seed, id)[0]!.move).not.toBe(id)
  })
})

describe('the dots she writes behind', () => {
  const plan = dotsPlan([[4, 2], [-4, 2]])

  it('melts the face away and brings it back whole', () => {
    expect([plan.body[0]!.v, plan.body.at(-1)!.v]).toEqual([1, 1])
    expect(Math.min(...plan.body.map((key) => key.v))).toBe(0)
    expect([plan.blur[0]!.v, plan.blur.at(-1)!.v]).toEqual([0, 0])
    for (const keys of [plan.body, plan.blur, ...plan.dots]) expect(keys.at(-1)!.t).toBe(plan.seconds)
    for (const keys of plan.dots) expect([keys[0]!.v.s, keys.at(-1)!.v.s]).toEqual([0, 0])
  })

  it('sinks each eye toward the middle of the body and pops it back home', () => {
    plan.eyes.forEach((stops, index) => {
      const home = { x: 0, y: 0, sx: 1, sy: 1 }
      expect(stops[0]!.pose).toEqual(home)
      expect(stops.at(-1)).toMatchObject({ t: plan.seconds, pose: home })
      expect(stops[1]!.pose).toEqual({ x: index === 0 ? 2.4 : -2.4, y: 1.2, sx: 0, sy: 0 })
    })
  })

  it('holds its dots hopping in turn, for longer than an answer usually takes', () => {
    expect(plan.seconds).toBeGreaterThan(30)
    const [first, second, third] = plan.dots.map((keys) => keys.find((key) => key.v.y < 0)!.t)
    expect(first!).toBeLessThan(second!)
    expect(second!).toBeLessThan(third!)
  })
})
