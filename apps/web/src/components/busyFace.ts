import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import {
  DOT,
  GOO,
  HOME,
  order,
  sample,
  smooth,
  timeline,
  type BusyLook,
  type BusyPlan,
  type EyePose,
  type Pair,
  type VariationId,
} from '@manor/client-runtime/busy-face'

export { BUSY_LOOK, VARIATIONS, VARIATION_IDS, stepLabels, type BusyLook, type Segment, type VariationId } from '@manor/client-runtime/busy-face'

/**
 * The working face on the web: the shared busy loop (see the client runtime's
 * `busyFace`) driven by the Web Animations API on the library's own eye nodes rather
 * than by CSS, because a stop has to read where the eyes are and walk them home from
 * there, and a CSS animation cannot be asked that.
 */

interface Base {
  x: number
  y: number
  r: number
}

const pair = (value: string): Pair => {
  if (value === 'none') return [0, 0]
  const [x = '0', y = '0'] = value.split(' ')
  return [Number.parseFloat(x), Number.parseFloat(y)]
}
const degrees = (value: string) => (value === 'none' ? 0 : Number.parseFloat(value))
const css = (base: Base, pose: EyePose) => ({
  translate: `${base.x + pose.x}px ${base.y + pose.y}px`,
  rotate: `${base.r + pose.r}deg`,
  scale: `${pose.sx} ${pose.sy}`,
})
const SETTLE: KeyframeAnimationOptions = {
  duration: 450,
  easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
}
const SVG = 'http://www.w3.org/2000/svg'
let goos = 0
/** Takes the dots rig off a face at once, by its body group, so a restart builds on the plain face. */
const rigs = new WeakMap<Element, () => void>()

/**
 * The body's half of the melt. The body's shapes are wrapped so they shrink as one,
 * three dots wait beside them in the head colour, and a goo filter on the body group
 * runs whatever touches together. The filter is on only while it blurs, and its
 * contrast follows the blur, so turning it on or off draws nothing different.
 */
function rig(body: SVGGElement, [cx, cy]: Pair) {
  const wrap = document.createElementNS(SVG, 'g')
  wrap.append(...body.childNodes)
  wrap.style.transformBox = 'view-box'
  wrap.style.transformOrigin = `${cx}px ${cy}px`
  const dots = [0, 1, 2].map(() => {
    const dot = document.createElementNS(SVG, 'circle')
    dot.setAttribute('cx', String(cx))
    dot.setAttribute('cy', String(cy))
    dot.setAttribute('r', String(DOT.r))
    dot.style.transformBox = 'fill-box'
    dot.style.transformOrigin = 'center'
    dot.style.scale = '0'
    return dot
  })
  const id = `busy-goo-${++goos}`
  const defs = document.createElementNS(SVG, 'defs')
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

  let frame = 0
  let timer = 0
  const halt = () => {
    cancelAnimationFrame(frame)
    window.clearTimeout(timer)
  }
  let done = false
  const teardown = () => {
    if (done) return
    done = true
    halt()
    for (const node of [wrap, ...dots]) for (const animation of node.getAnimations()) animation.cancel()
    wrap.replaceWith(...wrap.childNodes)
    for (const node of [...dots, defs]) node.remove()
    body.removeAttribute('filter')
    rigs.delete(body)
  }
  rigs.set(body, teardown)

  return {
    /** Runs the body's half of `plan` in step with `lead`, the left eye's loop. */
    play: (plan: BusyPlan, lead: Animation) => {
      const options = { id: 'busy', duration: plan.total * 1000, iterations: Infinity }
      const offset = (t: number) => t / plan.total
      const loops = [
        wrap.animate(
          plan.body.map((key) => ({ offset: offset(key.t), easing: key.ease, scale: String(key.v) })),
          options,
        ),
        ...dots.map((dot, index) =>
          dot.animate(
            plan.dots[index]!.map((key) => ({
              offset: offset(key.t),
              easing: key.ease,
              translate: `${key.v.x}px ${key.v.y}px`,
              scale: String(key.v.s),
            })),
            options,
          ),
        ),
      ]
      for (const loop of loops) loop.playbackRate = lead.playbackRate
      const tick = () => {
        const t = (lead.effect?.getComputedTiming().progress ?? 0) * plan.total
        setBlur(sample(plan.blur, t))
        // The blur only moves around the dots, so between them the tick sleeps instead of
        // waking every frame. Capped, so a speed change is caught within half a second.
        const next = plan.blur.findIndex((key) => key.t > t)
        if (next > 0 && plan.blur[next - 1]!.v === plan.blur[next]!.v) {
          timer = window.setTimeout(tick, Math.min(500, ((plan.blur[next]!.t - t) / Math.abs(lead.playbackRate || 1)) * 1000))
        } else frame = requestAnimationFrame(tick)
      }
      tick()
      return loops
    },
    /** Swells the body back out of wherever the dots are, then takes the rig off. */
    stop: () => {
      halt()
      if (!body.isConnected) return teardown()
      const size = getComputedStyle(wrap).scale
      const now = dots.map((dot) => {
        const style = getComputedStyle(dot)
        return { translate: style.translate === 'none' ? '0px 0px' : style.translate, scale: style.scale }
      })
      for (const node of [wrap, ...dots]) for (const animation of node.getAnimations()) animation.cancel()
      const walks = [
        wrap.animate([{ scale: size === 'none' ? '1' : size }, { scale: '1' }], SETTLE),
        ...dots.map((dot, index) => dot.animate([now[index]!, { translate: '0px 0px', scale: '0' }], SETTLE)),
      ]
      const from = shown
      const began = performance.now()
      const fade = () => {
        const u = Math.min(1, (performance.now() - began) / 450)
        setBlur(from * (1 - smooth(u)))
        if (u < 1) frame = requestAnimationFrame(fade)
      }
      fade()
      void Promise.all(walks.map((walk) => walk.finished)).then(teardown, () => undefined)
    },
  }
}

/**
 * Starts the loop on one face and returns its controls, or nothing when there is no
 * animated face to move. The eye group is held still and clipped to the silhouette
 * while it runs, so the eyes can leave the shape and stay out of sight until they
 * come back in; the clip comes off once they are home again.
 */
function start(host: HTMLElement, ids: readonly VariationId[], speed: number, melt: boolean) {
  const group = host.querySelector<SVGGElement>('.mo-eyes')
  const body = host.querySelector<SVGGElement>('.mo-bob > g:not(.mo-eyes)')
  if (body !== null) rigs.get(body)?.()
  const eyes = [...host.querySelectorAll<SVGGElement>('.mo-eye')]
  const silhouette = body?.querySelector(':scope > path:last-of-type')?.getAttribute('d')
  const [left, right] = eyes
  if (group === null || body === null || left === undefined || right === undefined || ids.length === 0) return undefined
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined

  // A stop that has not finished walking home would be read as home and offset the loop.
  for (const eye of [left, right]) for (const animation of eye.getAnimations()) if (animation.id === 'busy-home') animation.finish()
  const bases = [left, right].map((eye): Base => {
    const style = getComputedStyle(eye)
    const [x, y] = pair(style.translate)
    return { x, y, r: degrees(style.rotate) }
  })
  const [l, r] = [left, right].map((eye, index) => {
    const [x, y] = pair(getComputedStyle(eye).transformOrigin)
    return [x + bases[index]!.x, y + bases[index]!.y] as Pair
  }) as [Pair, Pair]
  const middle = partsMiddle(body)
  if (silhouette) group.style.clipPath = `path('${silhouette}') view-box`
  const [gx, gy] = pair(getComputedStyle(group).translate)
  const hold = group.animate([{ translate: `${gx}px ${gy}px` }, { translate: '0px 0px' }], { ...SETTLE, fill: 'forwards' })

  const pulls = [l, r].map(([x, y]) => [middle[0] - x, middle[1] - y]) as [Pair, Pair]
  const plan = timeline(ids, [(r[0] - l[0]) / 2, (r[1] - l[1]) / 2], pulls, melt)
  const { total, marks } = plan
  const loops = [left, right].map((eye, index) =>
    eye.animate(
      plan.eyes[index]!.map((stop) => ({
        offset: stop.t / total,
        easing: stop.ease,
        ...css(bases[index]!, stop.pose),
      })),
      { id: 'busy', duration: total * 1000, iterations: Infinity },
    ),
  )
  for (const loop of loops) loop.playbackRate = speed
  const lead = loops[0]!
  const melting = melt ? rig(body, middle) : undefined
  loops.push(...(melting?.play(plan, lead) ?? []))

  return {
    setSpeed: (next: number) => {
      for (const loop of loops) loop.updatePlaybackRate(next)
    },
    /** What the face is doing now. */
    playing: () => {
      const t = (lead.effect?.getComputedTiming().progress ?? 0) * total
      return marks.filter((mark) => mark.t <= t).at(-1)?.id
    },
    /** Walks the eyes home from wherever the loop has them, then hands back to the library. */
    stop: () => {
      // Gone with its face: nothing left to walk home.
      if (!group.isConnected) {
        for (const loop of loops) loop.cancel()
        hold.cancel()
        return melting?.stop()
      }
      const now = [left, right].map((eye) => {
        const style = getComputedStyle(eye)
        // A full turn reads the same as none, and walking it back would spin the eye.
        const turned = ((((degrees(style.rotate) + 180) % 360) + 360) % 360) - 180
        return {
          translate: style.translate,
          rotate: `${turned}deg`,
          scale: style.scale === 'none' ? '1 1' : style.scale,
        }
      })
      for (const loop of loops.slice(0, 2)) loop.cancel()
      melting?.stop()
      const homes = [left, right].map((eye, index) =>
        eye.animate([now[index]!, css(bases[index]!, HOME)], {
          ...SETTLE,
          id: 'busy-home',
        }),
      )
      const before = pair(getComputedStyle(group).translate)
      hold.cancel()
      const after = pair(getComputedStyle(group).translate)
      group.animate([{ translate: `${before[0] - after[0]}px ${before[1] - after[1]}px` }, { translate: '0px 0px' }], { ...SETTLE, composite: 'add' })
      void Promise.all(homes.map((home) => home.finished)).then(
        () => {
          const restarted = [left, right].some((eye) => eye.getAnimations().some((animation) => animation.id === 'busy'))
          if (!restarted) group.style.removeProperty('clip-path')
        },
        () => undefined,
      )
    },
  }
}

/**
 * The middle of the head's own parts. The group's box would also count the clay
 * finish, whose full-box rects only show through the silhouette's clip.
 */
function partsMiddle(body: SVGGElement): Pair {
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const part of body.querySelectorAll<SVGGraphicsElement>(':scope > path, :scope > circle')) {
    const box = part.getBBox()
    left = Math.min(left, box.x)
    top = Math.min(top, box.y)
    right = Math.max(right, box.x + box.width)
    bottom = Math.max(bottom, box.y + box.height)
  }
  return left === Infinity ? [50, 50] : [(left + right) / 2, (top + bottom) / 2]
}

export type BusyRun = NonNullable<ReturnType<typeof start>>

/** Each start of a shuffle without a seed of its own takes the next variation. */
let turns = 0

/**
 * Runs the busy loop on the face inside `slot` while `active`. `face` names what the
 * face was drawn from; a change there means fresh nodes, so the loop restarts on them.
 * A speed change retimes the running loop without restarting it. The returned ref holds
 * the running loop, for a caller that wants to ask it what it is playing.
 */
export function useBusyFace(slot: RefObject<HTMLElement | null>, active: boolean, look: BusyLook, face: string) {
  const { variation, dots, seed } = look
  const speed = useRef(look.speed)
  speed.current = look.speed
  const run = useRef<BusyRun>(undefined)

  useLayoutEffect(() => {
    const host = slot.current
    if (!active || host === null) return
    const started = start(host, order(variation, seed ?? turns++), speed.current, dots)
    run.current = started
    return () => {
      started?.stop()
      run.current = undefined
    }
  }, [slot, active, variation, seed, dots, face])

  useEffect(() => {
    run.current?.setSpeed(look.speed)
  }, [look.speed])

  return run
}
