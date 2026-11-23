import { blobatar } from '@manor/blobatar'
import { BLOB_FACE_TRAITS } from '@manor/client-runtime/blob-shapes'
import { MOVE_IDS, WORK, dotsPlan, figure, figureAt, loopPlan, loopSteps, moveInfo, outline, walk, type Figure, type HeadPart, type Pair } from '@manor/client-runtime/busy-face'
import { outlinePoints } from '@manor/client-runtime/face-gesture'
import { describe, expect, it } from 'vitest'

import { MORPH_STEPS, drawnAt, eased, eyeBoxAt, flat, held, meltAt, morphStep, moveKeys, packed, placeAt, rigOf, walkTo } from './loopFrames'

/** A face rigged out of the library's own markup, the way the phone finds its parts. */
function rigged(shape: string) {
  const markup = blobatar('Manor', { traits: BLOB_FACE_TRAITS, shape })
  const [head = '', eyes = ''] = [...markup.matchAll(/<g fill="[^"]+">(.*?)<\/g>/g)].map((group) => group[1] ?? '')
  const parts: HeadPart[] = [...head.matchAll(/<(?:path d="([^"]+)"|circle cx="([\d.-]+)" cy="([\d.-]+)" r="([\d.-]+)")/g)].map(
    (match) => match[1] ?? { cx: Number(match[2]), cy: Number(match[3]), r: Number(match[4]) },
  )
  const [left = '', right = ''] = [...eyes.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]!)
  // At rest a petal is the circle the library drew; any closed path stands in for it here.
  const still = parts.map((part) => (typeof part === 'string' ? part : `M${part.cx - part.r} ${part.cy}L${part.cx} ${part.cy + part.r}L${part.cx + part.r} ${part.cy}Z`))
  return { rig: rigOf(parts, [left, right], still)!, still }
}

const close = (got: readonly number[], want: readonly number[]) => {
  expect(got).toHaveLength(want.length)
  got.forEach((value, index) => expect(value, `value ${index}`).toBeCloseTo(want[index]!, 9))
}

const turnOf = (points: readonly Pair[]) => points.reduce((sum, [x, y], index) => {
  const [nx, ny] = points[(index + 1) % points.length]!
  return sum + x * ny - nx * y
}, 0)

describe('a plan as flat keys', () => {
  const { rig } = rigged('clover')

  it('draws what the shared plan draws at every moment, before its start and past its end too', () => {
    const plan = loopPlan(rig.head, loopSteps(7).slice(0, 3))
    const keys = packed(plan)
    for (let t = -0.2; t <= plan.seconds + 0.2; t += 0.037) close(drawnAt(keys, t), flat(figureAt(plan, t)))
  })

  it('reads each move once per face and ends it in the working pose it started in', () => {
    for (const move of MOVE_IDS) {
      const keys = moveKeys(rig, move)
      expect(moveKeys(rig, move)).toBe(keys)
      expect(keys.seconds).toBe(moveInfo(move).seconds)
      close(drawnAt(keys, 0), rig.work)
      // The rest after a move is this pose held: the keys end and the clock runs on.
      close(drawnAt(keys, keys.seconds + 0.5), rig.work)
    }
  })

  it('holds one drawing still', () => {
    close(drawnAt(held(rig.home), 3), rig.home)
    expect(rig.home[0]).toBe(1)
  })
})

describe('a drawing as a view and two rects', () => {
  const { rig } = rigged('droplet')
  const plan = loopPlan(rig.head, [{ move: 'shrink', rest: 0 }])
  const keys = packed(plan)

  it('places the body where the shared figure has it, about the middle of the slot instead of the head', () => {
    const [cx, cy] = rig.head.c
    for (const t of [0, 0.4, 0.9, 1.6, 2.4]) {
      const drawn = figureAt(plan, t)
      const place = placeAt(keys, t, rig.head.c, 0.5)
      const turn = (drawn.lean * Math.PI) / 180
      for (const [px, py] of [[10, 20], [80, 33], [cx, cy]] as const) {
        // The view: turned and scaled about the slot's middle, then slid, in points.
        const [cos, sin] = [Math.cos((place.lean * Math.PI) / 180) * place.scale, Math.sin((place.lean * Math.PI) / 180) * place.scale]
        const view = [(50 + (px - 50) * cos - (py - 50) * sin) * 0.5 + place.x, (50 + (px - 50) * sin + (py - 50) * cos) * 0.5 + place.y]
        // The shared figure: lean and scale about the head, slide, fit about the slot.
        const [c, s] = [Math.cos(turn) * drawn.scale, Math.sin(turn) * drawn.scale]
        const head = [cx + (px - cx) * c - (py - cy) * s + drawn.x, cy + (px - cx) * s + (py - cy) * c + drawn.y]
        close(view, head.map((value) => (50 + (value - 50) * drawn.fit) * 0.5))
      }
    }
  })

  it('draws an eye as an ellipse at no roundness and a pill at full', () => {
    const pill = eyeBoxAt(keys, 0, 0)
    const eye = figureAt(plan, 0).eyes[0]
    expect(pill).toEqual({ x: eye.x - eye.a, y: eye.y - eye.b, width: 2 * eye.a, height: 2 * eye.b, rx: Math.min(eye.a, eye.b), ry: Math.min(eye.a, eye.b) })
    const oval = eyeBoxAt(held(rig.home), 0, 0)
    expect([oval.rx, oval.ry]).toEqual([oval.width / 2, oval.height / 2])
  })

  it('keeps a speck of an eye that is behind the head, so its box is never empty', () => {
    const turn = packed(loopPlan(rig.head, [{ move: 'turn', rest: 0 }]))
    const boxes = Array.from({ length: 200 }, (_, i) => eyeBoxAt(turn, 0, (i * turn.seconds) / 200))
    expect(boxes.some((box) => box.width < 0.1)).toBe(true)
    expect(boxes.every((box) => box.width > 0 && box.height > 0)).toBe(true)
  })
})

describe('a walk on the UI thread', () => {
  const { rig } = rigged('droplet')

  it('is the shared walk, key for key', () => {
    const plan = loopPlan(rig.head, [{ move: 'rock', rest: 0 }])
    const from = figureAt(plan, 1.3)
    const to = figure(rig.head, WORK)
    const keys = walkTo(flat(from), flat(to), 0.25)
    const shared = packed(walk(from, to, 0.25))
    close(keys.body, shared.body)
    close(keys.top, shared.top)
    close(keys.eyes[0], shared.eyes[0])
    close(keys.eyes[1], shared.eyes[1])
    expect(keys.seconds).toBe(0.25)
  })

  it('grows an eye that was behind the head where it is going, instead of sliding it in', () => {
    const plan = loopPlan(rig.head, [{ move: 'turn', rest: 0 }])
    const hidden = Array.from({ length: 200 }, (_, i) => figureAt(plan, (i * plan.seconds) / 200)).find((drawn: Figure) => drawn.eyes[0].a === 0 && drawn.eyes[0].b === 0)!
    expect(hidden).toBeDefined()
    const keys = walkTo(flat(hidden), rig.work, 0.25)
    const [, x, y, a] = keys.eyes[0]
    expect([x, y, a]).toEqual([rig.work[6], rig.work[7], 0])
  })
})

describe('the outline on its way into the top view', () => {
  it.each(['round', 'clover', 'cloud', 'droplet', 'triangle'])('samples the %s once per step, from the resting shapes to the ball', (shape) => {
    const { rig, still } = rigged(shape)
    expect(rig.shapes).toHaveLength(still.length)
    for (const [index, steps] of rig.shapes.entries()) {
      expect(steps).toHaveLength(MORPH_STEPS + 1)
      expect(steps[0]).toBe(still[index])
    }
    const read = (d: string) => outlinePoints([d], []).map(([x, y]): Pair => [x, y])
    // The core at the last step is the shared plan's top view, point for point.
    const core = rig.shapes[rig.shapes.length - 1]!
    expect(core[MORPH_STEPS]).toBe(outline(rig.head, 1).core)
    expect(core[MORPH_STEPS / 2]).toBe(outline(rig.head, 0.5).core)
    // Every shape of a step runs the way the core runs, so a clip of them all has no holes.
    for (const step of [1, MORPH_STEPS / 2, MORPH_STEPS]) {
      const ways = rig.shapes.map((steps) => Math.sign(turnOf(read(steps[step]!))))
      expect(new Set(ways).size, `${shape} step ${step}`).toBe(1)
    }
  })

  it('picks a step for any amount', () => {
    expect([-1, 0, 0.01, 0.5, 0.99, 1, 2].map(morphStep)).toEqual([0, 0, 0, MORPH_STEPS / 2, MORPH_STEPS, MORPH_STEPS, MORPH_STEPS])
  })
})

describe('the dots melt at a moment', () => {
  const plan = dotsPlan([[5, 8], [-4, 8]])

  it('starts as the whole face and is three dots by the time they hop', () => {
    const start = meltAt(plan, 0)
    expect(start.body).toBe(1)
    expect(start.dots.every((dot) => dot.s === 0)).toBe(true)
    expect(start.eyes.every((eye) => eye.sx === 1 && eye.x === 0)).toBe(true)
    const hopping = meltAt(plan, 3)
    expect(hopping.body).toBe(0)
    expect(hopping.dots.map((dot) => Math.round(dot.x))).toEqual([-22, 0, 22])
    expect(hopping.eyes.every((eye) => eye.sx === 0)).toBe(true)
  })

  it('goes round with the plan', () => {
    expect(meltAt(plan, plan.seconds + 3)).toEqual(meltAt(plan, 3))
  })

  it('is between two keys where the curve of the earlier one has it, not halfway', () => {
    // An eye sinks on a curve that hardly moves at first: halfway through its time it has barely left.
    const [first, gone] = plan.eyes[0]!
    const share = eased(first!.ease, 0.5)
    expect(share).toBeGreaterThan(0)
    expect(share).toBeLessThan(0.15)
    const eye = meltAt(plan, (first!.t + gone!.t) / 2).eyes[0]!
    expect(eye.sx).toBeCloseTo(1 + (gone!.pose.sx - 1) * share, 9)
    expect(eye.x).toBeCloseTo(gone!.pose.x * share, 9)
  })
})

describe('a CSS curve', () => {
  it('is the time itself when linear, or when its handles lie on the diagonal', () => {
    for (const u of [0, 0.2, 0.5, 0.9, 1]) {
      expect(eased('linear', u)).toBe(u)
      expect(eased('cubic-bezier(0.25, 0.25, 0.75, 0.75)', u)).toBeCloseTo(u, 6)
    }
  })

  it('starts and ends where the time does, and may overshoot between', () => {
    const pop = 'cubic-bezier(0.3, 1.5, 0.5, 1)'
    expect(eased(pop, 0)).toBeCloseTo(0, 6)
    expect(eased(pop, 1)).toBeCloseTo(1, 6)
    expect(Math.max(...[0.3, 0.4, 0.5, 0.6].map((u) => eased(pop, u)))).toBeGreaterThan(1)
    // Ease in and out is halfway at half time.
    expect(eased('cubic-bezier(0.45, 0, 0.55, 1)', 0.5)).toBeCloseTo(0.5, 6)
  })
})
