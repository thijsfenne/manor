import { Blobatar } from '@manor/blobatar/react'
import { palette, traits as seedTraits } from '@manor/blobatar'
import { happy, sad, sleepy, unsure } from '@manor/blobatar/expression'
import { FACE_LOOK, type FaceState } from '@manor/client-runtime/face-activity'
import '@manor/blobatar/motion.css'
import { useReducedMotion } from 'motion/react'
import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'
import { accentHue, accentStyle } from '../accent'
import { BLOB_FACE_TRAITS, DEFAULT_BLOB_TONE, WORKING_GAZE, blobShapeOf } from '../blobShapes'
import { BUSY_LOOK, DOTS_LOOK, useBusyFace } from './busyFace'
import { useFaceEyes, useFaceGesture } from './faceMotion'

/** How long a face that stops working stays live, so its eyes and body can walk home. */
const SETTLE_MS = 600

const POSES = { sleepy, happy, sad }

interface AvatarProps {
  name: string
  color: string
  /** A `data:image/…` portrait, or absent for a persona who has none. */
  src?: string
  /** A chosen silhouette, or absent to let her name pick one. */
  shape?: string
  /** Chosen swatch position; absent keeps the existing deep tone. */
  tone?: number
  /** Square side in pixels. Every call site picks one deliberately; there is no default. */
  size: number
  /**
   * Sit in the middle of the slot rather than next to a name. The triangle's lift
   * is for a row; a picker tile that uses it leaves the face low in its ring.
   */
  center?: boolean
  /**
   * Her turn is running: her whole face plays the working loop, body and eyes. A
   * portrait, or a reader who asks for reduced motion, gets the still working face
   * with thought dots above it.
   *
   * Passed where a face stands for a conversation with a turn behind it: the
   * transcript, the DM list and the pinned head card. Never on the roster, whose
   * entry is a persona and is never busy.
   */
  working?: boolean
  /**
   * What the turn behind this face is doing, where the caller knows more than that it
   * runs: she writes, waits, needs the user, or has just finished. The eyes, the pose
   * and the body follow it. Absent, a working face plays the loop. A portrait, or a
   * reader who asks for reduced motion, shows none of it.
   */
  face?: FaceState
}

/**
 * A persona's face: her own blobatar, or the picture she was given instead.
 *
 * Purely decorative everywhere it appears, because the name is always right next
 * to it, so it takes no alt text and no role.
 */
export const Avatar = memo(function Avatar({ name, color, src, shape, tone = DEFAULT_BLOB_TONE, size, center = false, working = false, face }: AvatarProps) {
  const slot = useRef<HTMLSpanElement>(null)
  const [onScreen, setOnScreen] = useState(false)
  const [pageVisible, setPageVisible] = useState(true)
  const [windowFocused, setWindowFocused] = useState(false)
  const [hovered, setHovered] = useState(false)
  const reduceMotion = useReducedMotion() ?? false
  const portrait = src !== undefined && src !== ''
  const lively = !reduceMotion && !portrait
  const look = face === undefined || !lively ? undefined : FACE_LOOK[face]
  // Work plays the loop and writing the dots. A state with a look of its own takes the face over.
  const busy = working && lively && (look === undefined || look.eyes === 'loop' || look.eyes === 'dots')
  // A face whose turn just ended stays live a moment, or it would snap home from
  // wherever the loop had it, mid-melt included.
  const [settling, setSettling] = useState(false)
  const [wasBusy, setWasBusy] = useState(busy)
  if (busy !== wasBusy) {
    setWasBusy(busy)
    setSettling(!busy)
  }
  useEffect(() => {
    if (!settling) return
    const timer = window.setTimeout(() => setSettling(false), SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [settling])
  useEffect(() => {
    const element = slot.current
    if (!element) return
    const updateAttention = () => {
      setPageVisible(document.visibilityState === 'visible')
      setWindowFocused(document.hasFocus())
    }
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(([entry]) => {
      setOnScreen(entry?.isIntersecting ?? false)
    })
    if (observer === undefined) setOnScreen(true)
    else observer.observe(element)
    updateAttention()
    document.addEventListener('visibilitychange', updateAttention)
    window.addEventListener('focus', updateAttention)
    window.addEventListener('blur', updateAttention)
    return () => {
      observer?.disconnect()
      document.removeEventListener('visibilitychange', updateAttention)
      window.removeEventListener('focus', updateAttention)
      window.removeEventListener('blur', updateAttention)
    }
  }, [])
  const moving = pageVisible && (working || settling || look !== undefined || (onScreen && (hovered || windowFocused)))
  const square = { width: size, height: size }
  const hue = accentHue(color)
  // The loop is the costly part of a working face, so one scrolled out of view rests
  // and wakes into another order of moves when it comes back. Going from the loop to
  // the dots and back is handed over on the running face.
  const drawn = JSON.stringify([name, hue, tone, shape, size])
  // Her faces share a beat, so the transcript and the sidebar move together and write together.
  useBusyFace(slot, busy && moving && onScreen, { ...(look?.eyes === 'dots' ? DOTS_LOOK : BUSY_LOOK), beat: name }, drawn)
  // The body and the added eye move rest with the loop when the face is out of sight.
  const shown = moving && onScreen ? look : undefined
  useFaceGesture(slot, shown?.gesture, drawn, shown?.passes)
  useFaceEyes(slot, shown?.eyes === 'toward' ? shown.eyes : undefined, drawn)

  if (portrait) {
    return (
      <span ref={slot} className="relative block flex-none" style={{ ...accentStyle(color), ...square }} aria-hidden="true">
        <span className="absolute inset-0 overflow-hidden rounded-full ring-1 ring-[color-mix(in_srgb,var(--accent-fg)_45%,transparent)]">
          <img className="absolute inset-0 size-full object-cover" src={src} alt="" />
        </span>
        {working && moving ? <ThoughtDots color="var(--accent-fg)" size={size} /> : null}
      </span>
    )
  }

  // Nobody has to pick this one: the name is the seed, so a persona has a face
  // from the moment she is named, and it is hers rather than the first letter of
  // whoever else starts with the same one. It sits on nothing, because a plate in
  // the accent puts the blobatar's own colour behind the blobatar.
  const worn = blobShapeOf(name, shape)
  // Keep the face family consistent while leaving her silhouette individually
  // seeded or explicitly chosen.
  // The busy face wears her resting traits, so a turn starting moves the face she has
  // rather than drawing a new one; only the still working face pins its own gaze.
  const still = working && !lively
  const traits = { ...BLOB_FACE_TRAITS, ...(still ? WORKING_GAZE : {}) }
  // Nine of the ten silhouettes need none of this. The tenth draws its ink high in
  // its own viewBox, so centring the box leaves the face hovering above the name
  // beside it; the lift is stated in viewBox units and scales with what is drawn.
  // Visual only: the slot stays exactly where the layout put it.
  const lift = center || worn?.lift === undefined ? undefined : (worn.lift / 100) * size
  return (
    <span
      ref={slot}
      className="relative grid flex-none place-items-center"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={{ ...square, ...(lift === undefined ? {} : { transform: `translateY(${lift.toFixed(2)}px)` }) }}
      data-avatar="blobatar"
      // Only the still face asks for the library's full motion. The loop moves the
      // face itself, and breathing and bob under it stay off, as in the playground.
      data-working={still ? 'true' : undefined}
      aria-hidden="true"
    >
      <Blobatar
        name={name}
        // The SVG is exactly its layout slot, so its visible bounds never become
        // larger merely because the face animates.
        size={size}
        tone={tone}
        shading="clay"
        // Resting faces render still until the focused window or pointer needs them.
        {...(moving ? { animate: 'always' as const } : {})}
        {...(hue === undefined ? {} : { hue })}
        traits={traits}
        {...(shape === undefined ? {} : { shape })}
        {...(look?.pose !== undefined ? { expression: POSES[look.pose] } : still ? { expression: unsure } : {})}
      />
      {still && moving ? <ThoughtDots color={workingDot(name, hue, tone)} size={size} /> : null}
    </span>
  )
})

/** Match the dots to the colour the library resolved for this face. */
function workingDot(name: string, hue: number | undefined, tone: number): string {
  const degrees = hue ?? seedTraits(name)('hue') * 360
  return palette(degrees, true, tone).head ?? 'var(--accent-fg)'
}

export function ThoughtDots({ color, size }: { color: string; size: number }) {
  return (
    <span className="thought-dots" style={{ '--face': `${size}px`, '--dot': color } as CSSProperties}>
      <i />
      <i />
      <i />
    </span>
  )
}
