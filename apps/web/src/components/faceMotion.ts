import { EYE_MOVE_MS, eyeAt, towardStops, type FaceLook } from '@manor/client-runtime/face-activity'
import { frameOf, outlinePoints, plan, type GestureId } from '@manor/client-runtime/face-gesture'
import { useLayoutEffect, type RefObject } from 'react'
import { bodyMiddle, headParts } from './busyFace'

/**
 * The parts of a face's language the working loop does not play, on the web: the body
 * gestures and the small eye move that is added to a pose (see the client runtime's
 * `faceGesture` and `faceActivity`, which plan them). Driven by the Web Animations
 * API on the library's own groups, like the loop, because a stop has to read where a
 * move is and walk home from there.
 *
 * The library nests two groups around the figure, for a breathe and a bob Manor does
 * not play. A gesture uses them as its two layers: the outer one moves and stretches
 * the figure about its foot, the inner one turns it and draws it in about its middle.
 */

const WALK = 240
const HOME: KeyframeAnimationOptions = { duration: WALK, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }
const still = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Plays a loop after walking to its first key, so a gesture that starts off home never
 * jumps there. With `passes` it plays that many times and then walks home by itself.
 *
 * The walk, the loop and the walk home are all started at once, each waiting its turn
 * on the same clock. Chaining them on `finished` would leave a face standing at its
 * first key for as long as the page draws no frames.
 */
function enter(node: Element, frames: Keyframe[], duration: number, id: string, home: Keyframe, passes?: number) {
  const bare = (frame: Keyframe | undefined) => ({ ...frame, offset: undefined, easing: undefined })
  const parts = [
    node.animate([bare(frames[0])], { ...HOME, id }),
    node.animate(frames, { id, duration, delay: WALK, iterations: passes ?? Infinity, easing: 'ease-in-out' }),
    ...(passes === undefined ? [] : [node.animate([bare(frames.at(-1)), home], { ...HOME, id: `${id}-home`, delay: WALK + passes * duration })]),
  ]
  return {
    /** Walks home from wherever the move has the node, along the same properties. */
    leave: () => {
      const now = getComputedStyle(node)
      const from = Object.fromEntries(Object.keys(home).map((key) => [key, now.getPropertyValue(key)]))
      for (const part of parts) part.cancel()
      return node.isConnected ? node.animate([from, home], { ...HOME, id: `${id}-home` }).finished.catch(() => undefined) : Promise.resolve(undefined)
    },
  }
}

function startGesture(host: HTMLElement, id: GestureId, passes?: number) {
  const outer = host.querySelector<SVGGElement>('.mo-breathe')
  const inner = host.querySelector<SVGGElement>('.mo-bob')
  const body = host.querySelector<SVGGElement>('.mo-bob > g:not(.mo-eyes)')
  if (outer === null || inner === null || body === null || still()) return undefined

  // The head's own parts, never its group: the clay finish adds full-box rects to that,
  // and a face still walking home from work has its shapes redrawn.
  const parts = headParts(body)
  const moves = plan(id, frameOf(outlinePoints(parts.filter((part) => typeof part === 'string'), parts.filter((part) => typeof part !== 'string'))))
  outer.style.transformOrigin = `${moves.foot[0]}px ${moves.foot[1]}px`
  inner.style.transformOrigin = `${moves.middle[0]}px ${moves.middle[1]}px`

  const drawIn = `${moves.fit.drawIn} ${moves.fit.drawIn}`
  const runs = [
    enter(outer, moves.fig.map((key) => ({ offset: key.offset, translate: `${key.x}px ${key.y}px`, scale: `${key.sx} ${key.sy}` })), moves.ms, 'gesture', { translate: '0px 0px', scale: '1 1' }, passes),
    enter(inner, moves.rot.map((key) => ({ offset: key.offset, rotate: `${key.degrees}deg` })), moves.ms, 'gesture-turn', { rotate: '0deg' }, passes),
    enter(inner, [0, 1].map((offset) => ({ offset, scale: drawIn })), moves.ms, 'gesture-draw', { scale: '1 1' }, passes),
  ]
  return () => {
    void Promise.all(runs.map((run) => run.leave())).then(() => {
      // Another gesture may have taken the groups over while this one walked home.
      const taken = [outer, inner].some((node) => node.getAnimations().some((animation) => animation.id.startsWith('gesture') && !animation.id.endsWith('-home')))
      if (taken) return
      outer.style.removeProperty('transform-origin')
      inner.style.removeProperty('transform-origin')
    })
  }
}

/**
 * Plays a body gesture on the face inside `slot` for as long as one is named, or
 * `passes` times. `face` names what the face was drawn from; a change there means
 * fresh nodes, so the gesture starts again on them.
 */
export function useFaceGesture(slot: RefObject<HTMLElement | null>, gesture: GestureId | undefined, face: string, passes?: number) {
  useLayoutEffect(() => {
    const host = slot.current
    if (gesture === undefined || host === null) return
    return startGesture(host, gesture, passes)
  }, [slot, gesture, face, passes])
}

type EyeMove = Extract<FaceLook['eyes'], 'toward'>

function startEyes(host: HTMLElement, move: EyeMove) {
  const body = host.querySelector<SVGGElement>('.mo-bob > g:not(.mo-eyes)')
  const eyes = [...host.querySelectorAll<SVGGElement>('.mo-eye')]
  const [left, right] = eyes
  if (body === null || left === undefined || right === undefined || still()) return undefined

  // From the middle of the pair, where the resting gaze leaves it, to the middle of the face.
  const centre = (eye: SVGGElement) => Number.parseFloat(getComputedStyle(eye).transformOrigin)
  const stops = towardStops(bodyMiddle(body)[0] - (centre(left) + centre(right)) / 2)
  const frames = stops.map((stop) => ({ offset: stop.offset, easing: stop.ease, translate: `${stop.x}px ${stop.y}px` }))

  // Added to wherever the pose has the eye, so a pose still morphing underneath is not read as home.
  const runs = [left, right].map((eye) => {
    const lead = eye.animate([{ translate: '0px 0px' }, { translate: frames[0]!.translate }], { ...HOME, id: 'face-eyes', composite: 'add' })
    const loop = eye.animate(frames, { id: 'face-eyes', duration: EYE_MOVE_MS[move], delay: WALK, iterations: Infinity, composite: 'add' })
    return () => {
      // Still walking out, the eye is somewhere short of its first stop; home from there is close enough.
      const progress = loop.effect?.getComputedTiming().progress
      const at = progress === null || progress === undefined ? stops[0]! : eyeAt(stops, progress)
      lead.cancel()
      loop.cancel()
      if (eye.isConnected) eye.animate([{ translate: `${at.x}px ${at.y}px` }, { translate: '0px 0px' }], { ...HOME, id: 'face-eyes-home', composite: 'add' })
    }
  })
  return () => runs.forEach((stop) => stop())
}

/** Plays an added eye move on the face inside `slot` for as long as one is named. */
export function useFaceEyes(slot: RefObject<HTMLElement | null>, move: EyeMove | undefined, face: string) {
  useLayoutEffect(() => {
    const host = slot.current
    if (move === undefined || host === null) return
    return startEyes(host, move)
  }, [slot, move, face])
}
