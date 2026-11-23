import { accentHue } from '@manor/client-runtime/accent-hue'
import { BLOB_FACE_TRAITS, DEFAULT_BLOB_TONE, WORKING_GAZE, blobShapeOf } from '@manor/client-runtime/blob-shapes'
import { DOT, DOTS_RATE, WAKE, loopSteps, type Dot as MeltDot, type DotsPlan, type EyePose, type Key, type MoveId, type Step } from '@manor/client-runtime/busy-face'
import { EYE_MOVE_MS, FACE_LOOK, towardStops, type FaceLook, type FaceState } from '@manor/client-runtime/face-activity'
import { frameOf, outlinePoints, plan, type GestureId } from '@manor/client-runtime/face-gesture'
import { CLAY, clayTones, palette, sheenInk, traits as seedTraits, type Glow, type Tones } from '@manor/blobatar'
import { happy, sad, sleepy, unsure } from '@manor/blobatar/expression'
import { _parts } from '@manor/blobatar/internal'
import { Image } from 'expo-image'
import { Fragment, useEffect, useEffectEvent, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { StyleSheet, View, type ColorValue, type ViewStyle } from 'react-native'
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  ReduceMotion,
  cancelAnimation,
  cubicBezier,
  runOnJS,
  runOnUI,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type CSSAnimationKeyframes,
  type CSSAnimationTimingFunction,
  type CSSStyle,
  type SharedValue,
} from 'react-native-reanimated'
import Svg, { Circle, ClipPath, Defs, G, Path, RadialGradient, Rect, Stop } from 'react-native-svg'

import { keyOffsets } from '@/lib/busyFrames'
import { eyeFrames, gestureFrames, type Layer } from '@/lib/faceFrames'
import { drawnAt, eyeBoxAt, held, meltAt, meltPlan, morphStep, moveKeys, placeAt, rigOf, topAt, walkTo, type Keys, type Melted, type Rig } from '@/lib/loopFrames'
import { colors } from '@/theme'

/** A block of CSS animation or transition settings, as the view's style takes them. */
type Motion = CSSStyle<ViewStyle>

/** The library draws in a hundred-unit box; every motion below is stated in those units. */
const BOX = 100

/** The library's poses a face state can name. */
const POSES = { sleepy, happy, sad }

/**
 * How the one fully moving face changes from one way of being drawn to the next: at
 * rest, at work, or in a moment with a look of its own. Each way is a component of its
 * own, and the ones with declared keyframes cannot be asked where they are. So the next
 * one fades in over the last, and the last leaves once it is covered. The working face
 * is the exception on its own side of the fade: it walks home first, so what is faded
 * over is the face at rest.
 */
const FACE_IN = FadeIn.duration(200).reduceMotion(ReduceMotion.System)
const FACE_OUT = FadeOut.delay(160).duration(120).reduceMotion(ReduceMotion.System)

/** How long the face takes to swell back out of the dots she wrote behind, and its curve. */
const DOTS_HOME_MS = 450
const dotsHome = cubicBezier(0.4, 0, 0.2, 1)

interface BlobatarProps {
  name: string
  color: string
  /** A `data:image/…` portrait, or absent for a persona who has none. */
  src?: string
  /** A chosen silhouette, or absent to let her name pick one. */
  shape?: string
  /** Chosen swatch position; absent keeps the existing deep tone. */
  tone?: number
  size: number
  /**
   * Her turn is running. On the face that moves fully (`animate`), her whole face plays
   * the working loop, body and eyes, and melts into three dots while she writes. Any
   * other face, a portrait, or a reader who asks for reduced motion gets the still
   * working face: a sideways gaze, with thought dots above it where it moves fully.
   */
  working?: boolean
  /**
   * How much of her moves, and what that costs.
   *
   * `true` is the full live face: breathe, bob, glance, blink and a pose per eye,
   * which is ten native views and about seven animations. At work it is the loop
   * instead: seven views, with the body and each eye placed on the UI thread every
   * frame. `'blink'` is the cheap living face for a resting persona: three views and
   * one animation. `false` is one still SVG and nothing else.
   *
   * Off by default. A list where every face moves fully is a list that stutters, so
   * only the face behind the latest reply earns `true` while at rest; every other
   * face in a list takes `'blink'`, the idle motion that reads at avatar size. A row
   * whose turn runs earns `true` for as long as it does.
   */
  animate?: boolean | 'blink'
  /**
   * What the turn behind this face is doing, where the caller knows more than that it
   * runs: she writes, waits, needs the user, or has just finished. Only the face that
   * moves fully shows it, with her eyes, a pose and her body. Absent, a working face
   * plays the loop. A portrait, or a reader who asks for reduced motion, shows none of it.
   */
  face?: FaceState
}

/** What the working face plays: the loop, the dots she writes behind, or the walk home at the end of her turn. */
type Play = 'loop' | 'dots' | 'home'

/**
 * A persona's face, drawn from the same generator the web uses and moving the way
 * the web's stylesheet moves it. The library's string API is static markup, so the
 * face is taken apart at its seams: the body is one SVG, each eye is its own layer,
 * and the breathe, bob, blink and glance of `blobatar/motion.css` are restated as
 * Reanimated CSS animations with the library's own seeded timings. Those run on the
 * native side without a worklet per frame, which is what lets a transcript full of
 * faces scroll at speed. Only a face at work costs more; see `WorkFace`.
 */
export function Blobatar({ name, color, src, shape, tone = DEFAULT_BLOB_TONE, size, working = false, animate = false, face: state }: BlobatarProps) {
  const still = useReducedMotion()
  const full = animate === true
  const hue = accentHue(color)
  const square = { width: size, height: size }
  const portrait = src !== undefined && src !== ''
  // Only a face that moves fully, and may, shows what its turn is doing.
  const look = state === undefined || !full || portrait || still ? undefined : FACE_LOOK[state]
  // Work plays the loop and writing the dots. A state with a look of its own takes the face over.
  const own = look === undefined || look.eyes === 'loop' || look.eyes === 'dots' ? undefined : look
  const asked: Play | undefined = !working || !full || portrait || still || own !== undefined ? undefined : look?.eyes === 'dots' ? 'dots' : 'loop'
  // A face whose turn just ended stays at work a moment longer, to walk home from
  // wherever the loop had it. It says when it is there.
  const [last, setLast] = useState(asked)
  const [homing, setHoming] = useState(false)
  if (last !== asked) {
    setLast(asked)
    setHoming(asked === undefined)
  }
  const playing: Play | undefined = asked ?? (homing ? 'home' : undefined)
  const plays = playing !== undefined

  const worn = blobShapeOf(name, shape)
  // The working face wears her resting traits, so a turn starting moves the face she has
  // rather than drawing a new one.
  const rest = useMemo(() => (portrait ? null : faceOf({ name, size, tone, hue, shape })), [hue, name, portrait, shape, size, tone])
  // A face the loop cannot measure works the still way.
  const rig = useMemo(() => (plays && rest !== null ? rigFor(rest) : undefined), [plays, rest])
  const work = rig === undefined || playing === undefined || rest === null ? undefined : { rig, play: playing, face: rest }
  // The still working face pins its own gaze; a moment waits until the walk home is over.
  const pinned = working && own === undefined && work === undefined
  const moment = work === undefined ? own : undefined
  const pose = moment?.pose
  const face = useMemo(
    () => (rest === null || (pose === undefined && !pinned) ? rest : faceOf({ name, size, tone, hue, shape, pinned, pose })),
    [hue, name, pinned, pose, rest, shape, size, tone],
  )

  if (portrait || face === null) {
    return (
      <View style={square}>
        <Image contentFit="cover" source={{ uri: src }} style={[square, { borderRadius: size / 2 }]} />
        {working && full ? <ThoughtDots color={color} size={size} /> : null}
      </View>
    )
  }

  // The triangle draws its ink high in its viewBox; the lift levels it with a name.
  const lift = worn?.lift === undefined ? 0 : (worn.lift / 100) * size

  const chosen = work !== undefined ? (
    // Another size or shape is another face at work: it starts over, so one never plays across two rigs.
    <WorkFace face={work.face} key={`${size} ${name} ${shape}`} onHome={() => setHoming(false)} play={work.play} rig={work.rig} size={size} />
  ) : moment !== undefined ? (
    <StateFace face={face} look={moment} size={size} />
  ) : full ? (
    <LiveFace face={face} size={size} />
  ) : animate ? (
    <BlinkFace face={face} size={size} />
  ) : (
    <StillFace face={face} size={size} />
  )
  // The body gesture of the moment moves whichever face is drawn, so the whole figure moves as one.
  const drawn = moment?.gesture === undefined ? chosen : (
    <GestureLayers face={face} gesture={moment.gesture} size={size} {...(moment.passes === undefined ? {} : { passes: moment.passes })}>
      {chosen}
    </GestureLayers>
  )
  // Which way she is drawn, and for a state which look: a change of either is a fade.
  // The loop and the dots are one way: the working face hands over between them itself.
  const way = work !== undefined ? 'work' : moment !== undefined ? `state ${state}` : 'live'

  return (
    <View style={[square, lift === 0 ? null : { transform: [{ translateY: lift }] }]}>
      {full || work !== undefined ? (
        // A face that has just come on screen is simply there; only a change fades.
        <LayoutAnimationConfig skipEntering>
          <Animated.View entering={FACE_IN} exiting={FACE_OUT} key={way} style={StyleSheet.absoluteFill}>
            {drawn}
          </Animated.View>
        </LayoutAnimationConfig>
      ) : drawn}
      {pinned && full ? <ThoughtDots color={workingDot(name, hue, tone)} size={size} /> : null}
    </View>
  )
}

/** A face taken apart: at rest, in a pose of the library, or pinned to the still working gaze. */
function faceOf({ name, size, tone, hue, shape, pinned = false, pose }: {
  name: string
  size: number
  tone: number
  hue: number | undefined
  shape: string | undefined
  pinned?: boolean
  pose?: keyof typeof POSES | undefined
}) {
  return takeApart(
    _parts(name, {
      size,
      tone,
      animate: 'always',
      ...(hue === undefined ? {} : { hue }),
      traits: { ...BLOB_FACE_TRAITS, ...(pinned ? WORKING_GAZE : {}) },
      ...(shape === undefined ? {} : { shape }),
      ...(pose !== undefined ? { expression: POSES[pose] } : pinned ? { expression: unsure } : {}),
    }),
    size,
  )
}

/** The loop's rig for a face: its shapes in the library's order, and its eyes from left to right. */
function rigFor(face: Face): Rig | undefined {
  const [left, right, more] = [...face.eyes].sort((a, b) => a.cx - b.cx)
  if (left === undefined || right === undefined || more !== undefined) return undefined
  return rigOf(face.body.map((part) => (part.kind === 'path' ? part.d : { cx: part.cx, cy: part.cy, r: part.r })), [left.d, right.d], face.silhouette)
}

/** Match the dots to the colour the library resolved for this face. */
function workingDot(name: string, hue: number | undefined, tone: number): ColorValue {
  const degrees = hue ?? seedTraits(name)('hue') * 360
  return palette(degrees, true, tone).head ?? colors.muted
}

type BodyPart = { kind: 'path'; d: string } | { kind: 'circle'; cx: number; cy: number; r: number }

interface Eye {
  d: string
  /** Which side she is on, -1 or 1; the pose mirrors across it. */
  wrap: number
  /** Her resting tilt in degrees; every scale happens along it. */
  lean: number
  /** Her centre in box units, the origin of everything that moves her. */
  cx: number
  cy: number
}

/** The pose the stylesheet reads off custom properties, resolved to the numbers it uses. */
interface Pose {
  esx: number
  esy: number
  tilt: number
  edy: number
  edx: number
  esx2: number
  esy2: number
  tilt2: number
  edy2: number
  lock: number
}

const IDLE: Pose = { esx: 1, esy: 1, tilt: 0, edy: 0, edx: 0, esx2: 0, esy2: 0, tilt2: 0, edy2: 0, lock: 0 }

interface Face {
  /** The slot's side in points, which picks the finish's optical size. */
  size: number
  bodyFill: string | undefined
  body: BodyPart[]
  /** The head's parts as one clip outline; see `silhouette`. */
  silhouette: string[]
  /** The library's ink for this face; absent leaves the path to its own default. */
  eyeFill: string | undefined
  eyes: Eye[]
  /** Whether the eyes wear the clay sheen: dark ink on a shaded face past `CLAY.small`. */
  sheen: boolean
  pose: Pose
  /** Seeded timings, in milliseconds and box units, straight from the library. */
  breathePhase: number
  bobPhase: number
  blink: number
  blinkPhase: number
  saccade: number
  saccadePhase: number
  lookX: number
  lookY: number
}

const EYE = /<g class="mo-eye" style="([^"]*)">(.*?)<\/g>/g
const PART = /<(path|circle)\s([^>]*)\/>/g

/**
 * The animated markup, split at its seams: the body group as paths and circles, and
 * each `mo-eye` group as path data plus the custom properties the stylesheet would
 * have read. Written against the markup `_parts` emits for this major of the
 * library, which its adapters also read; the shape is stable inside a major.
 */
function takeApart(parts: ReturnType<typeof _parts>, size: number): Face | null {
  const inner = parts.inner
  const eyesTag = inner.indexOf('class="mo-eyes"')
  if (eyesTag < 0) return null
  const eyesStart = inner.lastIndexOf('<g ', eyesTag)
  const bodyStart = inner.indexOf('<g fill=')
  const bodyMarkup = inner.slice(bodyStart, eyesStart)
  const bodyFill = /^<g fill="([^"]+)"/.exec(bodyMarkup)?.[1]
  const body: BodyPart[] = []
  for (const match of bodyMarkup.matchAll(PART)) {
    const attrs = match[2] ?? ''
    const attr = (key: string) => new RegExp(`\\b${key}="([^"]+)"`).exec(attrs)?.[1]
    if (match[1] === 'path') {
      const d = attr('d')
      if (d !== undefined) body.push({ kind: 'path', d })
    } else {
      body.push({ kind: 'circle', cx: Number(attr('cx') ?? 0), cy: Number(attr('cy') ?? 0), r: Number(attr('r') ?? 0) })
    }
  }
  const eyeFill = /fill="([^"]+)"/.exec(inner.slice(eyesStart, eyesTag))?.[1]
  const eyes: Eye[] = []
  for (const match of inner.slice(eyesStart).matchAll(EYE)) {
    const style = match[1] ?? ''
    const d = [...(match[2] ?? '').matchAll(/d="([^"]+)"/g)].map((path) => path[1]).join(' ')
    const origin = /transform-origin:([\d.-]+)px ([\d.-]+)px/.exec(style)
    eyes.push({
      d,
      wrap: Number(/--mo-wrap:([\d.-]+)/.exec(style)?.[1] ?? 1),
      lean: Number(/--mo-lean:([\d.-]+)/.exec(style)?.[1] ?? 0),
      cx: Number(origin?.[1] ?? BOX / 2),
      cy: Number(origin?.[2] ?? BOX / 2),
    })
  }
  const vars = parts.vars ?? {}
  const num = (key: string, fallback: number) => {
    const raw = vars[key]
    return raw === undefined ? fallback : Number.parseFloat(raw)
  }
  const head = vars['--mo-head'] ?? bodyFill
  return {
    size,
    // The custom properties carry a tinting pose's colours; the markup keeps the resting pair.
    bodyFill: head,
    body,
    silhouette: silhouette(body),
    eyeFill: vars['--mo-eye'] ?? eyeFill,
    eyes,
    // The resting ink, as the web's animated markup decides it, so a tinting pose does not toggle it.
    sheen: size > CLAY.small && head !== undefined && eyeFill !== undefined && sheenInk(eyeFill),
    pose: {
      esx: num('--mo-esx', IDLE.esx),
      esy: num('--mo-esy', IDLE.esy),
      tilt: num('--mo-tilt', IDLE.tilt),
      edy: num('--mo-edy', IDLE.edy),
      edx: num('--mo-edx', IDLE.edx),
      esx2: num('--mo-esx2', IDLE.esx2),
      esy2: num('--mo-esy2', IDLE.esy2),
      tilt2: num('--mo-tilt2', IDLE.tilt2),
      edy2: num('--mo-edy2', IDLE.edy2),
      lock: num('--mo-lock', IDLE.lock),
    },
    breathePhase: num('--mo-phase', 0),
    bobPhase: num('--mo-bob-phase', 0),
    blink: num('--mo-blink', 4800),
    blinkPhase: num('--mo-blink-phase', 0),
    saccade: num('--mo-saccade', 5600),
    saccadePhase: num('--mo-saccade-phase', 0),
    lookX: num('--mo-look-x', 1.4),
    lookY: num('--mo-look-y', 1.1),
  }
}

/** Where `.mo-eye` ends up for a pose: the stylesheet's arithmetic, in box units and degrees. */
function eyeStance(eye: Eye, pose: Pose) {
  const sel = (eye.wrap + 1) / 2
  return {
    x: pose.esx + pose.esx2 * sel,
    y: pose.esy + pose.esy2 * sel,
    turn: (pose.tilt + pose.tilt2 * sel) * eye.wrap - eye.lean * pose.lock,
    dx: pose.edx * eye.wrap,
    dy: pose.edy + pose.edy2 * sel,
  }
}

/** The squash and stretch of `mo-breathe`, at a multiple of the library's own amplitude. */
function breatheKeyframes(amp: number): CSSAnimationKeyframes<ViewStyle> {
  return {
    from: { transform: [{ scaleX: 1 }, { scaleY: 1 }] },
    to: { transform: [{ scaleX: 1 + 0.022 * amp }, { scaleY: 1 - 0.018 * amp }] },
  }
}

/**
 * How much louder the face has to breathe and float than the library asks.
 *
 * The library states its idle motion as a fraction of the face, which is right for a
 * portrait and invisible on an avatar: at 32pt the bob travels 0.35pt, about one
 * device pixel over three and a half seconds, and the breath changes the width by
 * 0.7pt. That is why the breathing was never there. So the live face states the two
 * in points instead: the bob clears two points of travel, and the breath is capped
 * at two and a half times the authored one, past which a blob stops breathing and
 * starts pulsing. Both are clamped to a share of her own height, so a 16pt face
 * floats rather than hops.
 *
 * A deliberate divergence from the Mac at avatar size; see the idea note for why the
 * Mac cannot follow through the library's public knobs.
 */
const BOB_FLOOR = 2
const BOB_CEILING = 0.07
const BREATHE_CAP = 2.5

function bodyAmp(size: number, unit: number) {
  const authored = 1.1 * unit
  const travel = Math.min(Math.max(authored, BOB_FLOOR), size * BOB_CEILING)
  return Math.max(1, travel / authored)
}

/**
 * Where the pair rests, as fractions of the period, and the box-unit offset it holds
 * there. Movement between consecutive stops is linear, which is what makes a glance a
 * dart rather than a drift.
 *
 * Two glances per period, not the library's six, and over a period three times as
 * long. The stylesheet's rhythm is written for motion you half-notice at a fraction
 * of a point; at the amplitude this file gives it, six darts a cycle is a face that
 * never settles. Two of the library's own stops are kept, one to each side, with the
 * eyes returning to centre in between and resting there for most of the period. So a
 * face mostly blinks, and now and then looks somewhere.
 */
const GLANCE_STRETCH = 3

const GLANCE: readonly [number, number, number][] = [
  [0, 0, 0],
  [22, 0, 0],
  [23.5, -0.8, -0.9],
  [34, -0.8, -0.9],
  [35.5, 0, 0],
  [64, 0, 0],
  [65.5, 0.75, -0.8],
  [76, 0.75, -0.8],
  [77.5, 0, 0],
  [100, 0, 0],
]

/**
 * The furthest the eyes travel in a glance, in points, for the same reason the bob
 * has a floor: the library's 1.4 box units land at 0.45pt on a 32pt face, which is a
 * dart nobody sees. Above the size where the authored amplitude already clears this,
 * the multiplier is 1 and the face glances exactly as the Mac's does.
 */
const GLANCE_FLOOR = 1.4

/** And never more than this share of the face, for the same reason the bob is capped. */
const GLANCE_CEILING = 0.05

/** The web's `ease-in-out`, by its CSS curve. */
const easeInOut = cubicBezier(0.42, 0, 0.58, 1)

function LiveFace({ face, size }: { face: Face; size: number }) {
  const still = useReducedMotion()
  const unit = size / BOX
  const square = { width: size, height: size }

  const amp = bodyAmp(size, unit)
  const breathe = breatheMotion(face.breathePhase, still, Math.min(amp, BREATHE_CAP))
  const bob = bobMotion(face.bobPhase, unit, still, amp)
  const gaze = useMemo<Motion | null>(() => {
    if (still) return null
    const reach = Math.abs(face.lookX) * unit
    const travel = Math.min(Math.max(reach, GLANCE_FLOOR), size * GLANCE_CEILING)
    const amp = reach === 0 ? 1 : Math.max(1, travel / reach)
    const keyframes: CSSAnimationKeyframes<ViewStyle> = {}
    for (const [at, dx, dy] of GLANCE) {
      keyframes[`${at}%`] = {
        transform: [{ translateX: dx * face.lookX * unit * amp }, { translateY: dy * face.lookY * unit * amp }],
      }
    }
    return {
      animationName: keyframes,
      animationDuration: face.saccade * GLANCE_STRETCH,
      animationDelay: face.saccadePhase * GLANCE_STRETCH,
      animationIterationCount: 'infinite' as const,
      animationTimingFunction: 'linear' as const,
    }
  }, [face.lookX, face.lookY, face.saccade, face.saccadePhase, size, still, unit])

  return (
    <View style={square}>
      <Animated.View style={[square, breathe]}>
        <Animated.View style={[square, bob]}>
          <Svg height={size} viewBox={`0 0 ${BOX} ${BOX}`} width={size}>
            <Body face={face} />
          </Svg>
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, gaze]}>
            {face.eyes.map((eye) => (
              <EyeLayer eye={eye} fill={face.eyeFill} key={eye.wrap} pose={face.pose} sheen={face.sheen} size={size} still={still} timing={face} />
            ))}
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </View>
  )
}

/** The breath of `mo-breathe`, on this face's own seeded phase so a roster never pulses in step. */
function breatheMotion(phase: number, still: boolean, amp = 1): Motion | null {
  return still
    ? null
    : {
        animationName: breatheKeyframes(amp),
        animationDuration: 2800,
        animationDelay: phase,
        animationIterationCount: 'infinite',
        animationDirection: 'alternate',
        animationTimingFunction: easeInOut,
      }
}

/** The float of `mo-bob`, stated in box units so it travels with the size of the face. */
function bobMotion(phase: number, unit: number, still: boolean, amp = 1): Motion | null {
  return still
    ? null
    : {
        animationName: { from: { transform: [{ translateY: 0 }] }, to: { transform: [{ translateY: -1.1 * unit * amp }] } },
        animationDuration: 3400,
        animationDelay: phase,
        animationIterationCount: 'infinite',
        animationDirection: 'alternate',
        animationTimingFunction: easeInOut,
      }
}

/**
 * The cheap living face: she holds still and blinks every few seconds, on the seeded
 * period the library gave her, so a list of faces never blinks in unison.
 *
 * Blink is the one idle motion worth spending anything on at avatar size. Breathing
 * and floating are stated as a fraction of the face and vanish under a point of
 * travel; an eye closing to a twelfth of its height is unmissable at any size, and
 * it is what makes a face read as a face rather than as an icon.
 *
 * The cost is a body SVG, one wrapper and an eye SVG: three views and one animation,
 * against the live face's ten and seven. Both eyes ride that one wrapper, which
 * closes them along a single horizontal line through their centres rather than each
 * across its own lean. On a leaned eye that shears by a fraction of a point for the
 * 140ms of a blink; the live face still does it properly, per eye.
 */
function BlinkFace({ face, size }: { face: Face; size: number }) {
  const still = useReducedMotion()
  // Both eyes close toward the line through their centres. A scaleY needs only the
  // vertical origin, which is why one wrapper can carry a pair.
  const line = face.eyes.reduce((sum, eye) => sum + eye.cy, 0) / Math.max(face.eyes.length, 1)
  const blink = useMemo<Motion | null>(() => {
    if (still) return null
    const keyframes: CSSAnimationKeyframes<ViewStyle> = {
      '0%': { transform: [{ scaleY: 1 }] },
      '97.2%': { transform: [{ scaleY: 1 }], animationTimingFunction: 'ease-in' },
      '98.6%': { transform: [{ scaleY: 0.08 }], animationTimingFunction: 'ease-out' },
      '100%': { transform: [{ scaleY: 1 }] },
    }
    return {
      animationName: keyframes,
      animationDuration: face.blink,
      animationDelay: face.blinkPhase,
      animationIterationCount: 'infinite',
      animationTimingFunction: 'linear',
    }
  }, [face.blink, face.blinkPhase, still])

  if (still) return <StillFace face={face} size={size} />

  return (
    <>
      <Svg height={size} viewBox={`0 0 ${BOX} ${BOX}`} width={size}>
        <Body face={face} />
      </Svg>
      <Animated.View
        pointerEvents="none"
        // The array form: RN reads the string form's decimals as a third, z component.
        style={[StyleSheet.absoluteFill, { transformOrigin: ['50%', `${line}%`, 0] as (string | number)[] }, blink]}
      >
        <Svg height={size} viewBox={`0 0 ${BOX} ${BOX}`} width={size}>
          <Eyes face={face} />
        </Svg>
      </Animated.View>
    </>
  )
}

/** The face at rest, body and eyes in one SVG: nothing moves, nothing costs. */
function StillFace({ face, size }: { face: Face; size: number }) {
  return (
    <Svg height={size} viewBox={`0 0 ${BOX} ${BOX}`} width={size}>
      <Body face={face} />
      <Eyes face={face} />
    </Svg>
  )
}

/** Her eyes at rest, as the body's own SVG draws them. */
function Eyes({ face }: { face: Face }) {
  return (
    <G {...(face.eyeFill === undefined ? {} : { fill: face.eyeFill })}>
      {face.eyes.map((eye) => (
        <Fragment key={eye.wrap}>
          <Path d={eye.d} />
          {face.sheen ? <Sheen d={eye.d} /> : null}
        </Fragment>
      ))}
    </G>
  )
}

/** The soft sheen inside a dark eye: the web's `CLAY.sheen`, in the box of whatever it fills. */
function SheenGlow({ id }: { id: string }) {
  const { sheen } = CLAY
  return (
    <RadialGradient cx={sheen.cx} cy={sheen.cy} id={id} r={sheen.r}>
      <Stop offset={0} stopColor="white" stopOpacity={sheen.opacity} />
      <Stop offset={1} stopColor="white" stopOpacity={0} />
    </RadialGradient>
  )
}

function Sheen({ d }: { d: string }) {
  const id = useId().replace(/[^\w-]/g, '')
  return (
    <>
      <Defs>
        <SheenGlow id={id} />
      </Defs>
      <Path d={d} fill={`url(#${id})`} />
    </>
  )
}

function Parts({ body }: { body: readonly BodyPart[] }) {
  return body.map((part, index) =>
    part.kind === 'path'
      ? <Path d={part.d} key={index} />
      : <Circle cx={part.cx} cy={part.cy} key={index} r={part.r} />,
  )
}

/** Whether a path runs clockwise on screen, judged by the shoelace sum of its points. */
function clockwise(d: string) {
  const points: [number, number][] = []
  let [x, y] = [0, 0]
  for (const [, command, args = ''] of d.matchAll(/([MLCQHV])([^MLCQHVZ]*)/g)) {
    const values = args.trim().split(/[\s,]+/).filter(Boolean).map(Number)
    if (command === 'H') x = values.at(-1) ?? x
    else if (command === 'V') y = values.at(-1) ?? y
    else [x, y] = [values.at(-2) ?? x, values.at(-1) ?? y]
    points.push([x, y])
  }
  let area = 0
  points.forEach(([x1, y1], index) => {
    const [x2, y2] = points[(index + 1) % points.length] ?? [x1, y1]
    area += x1 * y2 - x2 * y1
  })
  return area > 0
}

/**
 * The head's parts for its clip, every one running the same way round. Core Graphics
 * merges a clip's children into one path and fills it by winding, so a petal drawn
 * against the outline's direction cancels it where they overlap and leaves the
 * shading out of that lens. The library's outlines run either way, so each circle
 * becomes an arc that follows its head's outline.
 */
function silhouette(body: readonly BodyPart[]) {
  const outline = body.find((part) => part.kind === 'path')
  const sweep = outline === undefined || clockwise(outline.d) ? 1 : 0
  return body.map((part) => {
    if (part.kind === 'path') return part.d
    const { cx, cy, r } = part
    return `M${cx + r} ${cy}A${r} ${r} 0 1 ${sweep} ${cx - r} ${cy}A${r} ${r} 0 1 ${sweep} ${cx + r} ${cy}Z`
  })
}

/**
 * A clay gradient from the library's numbers, turned and stretched to its ellipse in
 * user space, in the head's relit colours. `keep` is what is left of its opacity.
 */
function ClayGlow({ id, glow, tones, keep = 1 }: { id: string; glow: Glow; tones: Tones; keep?: number }) {
  return (
    <RadialGradient cx={0} cy={0} gradientTransform={`translate(${glow.cx} ${glow.cy})${glow.rot ? ` rotate(${glow.rot})` : ''} scale(${glow.rx} ${glow.ry})`} gradientUnits="userSpaceOnUse" id={id} r={1}>
      {glow.stops.map(([offset, opacity, tone], index) => (
        <Stop key={index} offset={offset} stopColor={tones[tone]} stopOpacity={opacity * keep} />
      ))}
    </RadialGradient>
  )
}

/** From this size up the shade is drawn in `CLAY_STEPS` steps instead of two. */
const CLAY_LARGE = 64
const CLAY_STEPS = 6

/**
 * The head in the library's clay finish, drawn with the same numbers the web draws.
 * Every overlay is a full-box rect inside one clip of all the head's parts, so a pill
 * or a cloud is shaded as one silhouette with no seams where its parts overlap.
 *
 * The web blurs the inner shadow. A blur here is a Core Image pass per face on every
 * mount, which a scrolling list cannot afford. So the shade is laid over the whole
 * lit head and the lit head is drawn again on top in steps, each through the same
 * clip moved a step further toward the light. Step `k` of `n` covers `1 / (n - k + 1)`
 * of what is left, so the shade falls off evenly from the edge to none past the band.
 * A list face takes two steps; a large face takes `CLAY_STEPS`, because two hard steps
 * read as a solid rim once the band is several pixels wide.
 *
 * The optical size follows the web: a small face wears the light alone. Three
 * things the web draws are left out here. The bounce light is a second band, the lip under each eye would have to ride every eye layer,
 * and the larger eyes of a small face would have to be redrawn from the layout;
 * none is worth its cost on a scrolling list.
 *
 * With `morph`, the head's shapes are the working face's: see `MorphPath`.
 */
function Body({ face, morph }: { face: Face; morph?: Morph }) {
  const id = useId().replace(/[^\w-]/g, '')
  const fill = face.bodyFill ?? colors.muted
  const tones = useMemo(() => (face.bodyFill === undefined ? undefined : clayTones(face.bodyFill)), [face.bodyFill])
  const { inner } = CLAY
  const clip = `url(#${id}k)`
  const small = face.size <= CLAY.small
  const whites = tones?.dark ? CLAY.dim.dark : 1
  const light = <Rect fill={`url(#${id}l)`} height={BOX} width={BOX} />
  // The lit head through the clip moved by this share of the shadow's offset. The
  // rects are moved back, so the light stays where it is and only the cut travels.
  const steps = face.size >= CLAY_LARGE ? CLAY_STEPS : 2
  const lit = (share: number, cover: number) => (
    <G key={share} opacity={cover} transform={`translate(${inner.dx * share} ${inner.dy * share})`}>
      <G clipPath={clip} clipRule="nonzero">
        <G transform={`translate(${-inner.dx * share} ${-inner.dy * share})`}>
          <Rect fill={fill} height={BOX} width={BOX} />
          {light}
        </G>
      </G>
    </G>
  )
  // A working face draws every shape at the step of the morph it is on, in the clip as well, so the finish follows.
  const morphing = morph?.shapes.map((steps, index) => <MorphPath key={index} step={morph.step} steps={steps} />)
  return (
    <>
      <Defs>
        <ClipPath id={`${id}k`}>
          {morphing ?? face.silhouette.map((d, index) => <Path d={d} key={index} />)}
        </ClipPath>
        {tones ? <ClayGlow glow={CLAY.light} id={`${id}l`} tones={tones} /> : null}
        {tones && !small ? <ClayGlow glow={CLAY.highlight} id={`${id}h`} keep={whites} tones={tones} /> : null}
      </Defs>
      <G fill={fill}>
        {morphing ?? <Parts body={face.body} />}
      </G>
      {tones ? (
        <G clipPath={clip} clipRule="nonzero">
          {light}
          {small ? null : (
            <>
              <Rect fill={tones[inner.tone]} height={BOX} opacity={inner.opacity} width={BOX} />
              {Array.from({ length: steps }, (_, k) => lit((k + 1) / steps, 1 / (steps - k)))}
              <Rect fill={`url(#${id}h)`} height={BOX} width={BOX} />
            </>
          )}
        </G>
      ) : null}
    </>
  )
}

/** How long adopting an expression takes on the web, and its curve. */
const POSE_MS = 300
const poseEase = cubicBezier(0.45, 0.05, 0.5, 1)

function EyeLayer({
  eye,
  fill,
  pose,
  sheen,
  size,
  still,
  timing,
}: {
  eye: Eye
  fill: string | undefined
  pose: Pose
  sheen: boolean
  size: number
  still: boolean
  timing: Pick<Face, 'blink' | 'blinkPhase'>
}) {
  const unit = size / BOX
  // The array form: RN reads the string form's decimals as a third, z component.
  const origin: (string | number)[] = [`${eye.cx}%`, `${eye.cy}%`, 0]
  const stance = eyeStance(eye, pose)
  // Each number eases from wherever it is to where the pose wants it, which is
  // what the stylesheet does with the custom properties this is derived from.
  const posed: Motion = {
    transform: [
      { translateX: stance.dx * unit },
      { translateY: stance.dy * unit },
      { rotate: `${stance.turn}deg` },
      { rotate: `${eye.lean}deg` },
      { scaleX: stance.x },
      { scaleY: stance.y },
      { rotate: `${-eye.lean}deg` },
    ],
    transitionProperty: 'transform',
    transitionDuration: still ? 0 : POSE_MS,
    transitionTimingFunction: poseEase,
  }

  const blink = useMemo<Motion | null>(() => {
    if (still) return null
    const open: ViewStyle['transform'] = [{ rotate: `${eye.lean}deg` }, { scaleY: 1 }, { rotate: `${-eye.lean}deg` }]
    const shut: ViewStyle['transform'] = [{ rotate: `${eye.lean}deg` }, { scaleY: 0.08 }, { rotate: `${-eye.lean}deg` }]
    const keyframes: CSSAnimationKeyframes<ViewStyle> = {
      '0%': { transform: open },
      '97.2%': { transform: open, animationTimingFunction: 'ease-in' },
      '98.6%': { transform: shut, animationTimingFunction: 'ease-out' },
      '100%': { transform: open },
    }
    return {
      animationName: keyframes,
      animationDuration: timing.blink,
      animationDelay: timing.blinkPhase,
      animationIterationCount: 'infinite' as const,
      animationTimingFunction: 'linear' as const,
    }
  }, [eye.lean, still, timing.blink, timing.blinkPhase])

  return (
    <Animated.View style={[StyleSheet.absoluteFill, { transformOrigin: origin }, posed]}>
      <Animated.View style={[StyleSheet.absoluteFill, { transformOrigin: origin }, blink]}>
        <Svg height={size} viewBox={`0 0 ${BOX} ${BOX}`} width={size}>
          <Path d={eye.d} {...(fill === undefined ? {} : { fill })} />
          {sheen ? <Sheen d={eye.d} /> : null}
        </Svg>
      </Animated.View>
    </Animated.View>
  )
}

const curves = new Map<string, CSSAnimationTimingFunction>()

/** The shared plan's CSS curve names, as Reanimated takes them. */
function curveOf(ease: string): CSSAnimationTimingFunction {
  const known = curves.get(ease)
  if (known !== undefined) return known
  const points = /^cubic-bezier\(([^)]+)\)$/.exec(ease)?.[1]?.split(',').map(Number)
  const curve = points?.length === 4
    ? cubicBezier(points[0]!, points[1]!, points[2]!, points[3]!)
    : ease as CSSAnimationTimingFunction
  curves.set(ease, curve)
  return curve
}

/** A scale of exactly zero leaves a native layer with no inverse; this is as gone. */
const GONE = 0.001

function busyMotion<V>(keys: readonly Key<V>[], total: number, duration: number, style: (value: V) => ViewStyle): Motion {
  const offsets = keyOffsets(keys.map((key) => key.t), total)
  const keyframes: Record<string, Omit<ViewStyle, 'animationTimingFunction'> & { animationTimingFunction: CSSAnimationTimingFunction }> = {}
  keys.forEach((key, index) => {
    keyframes[offsets[index]!] = { ...style(key.v), animationTimingFunction: curveOf(key.ease) }
  })
  return {
    // The style type narrows a block's curve to a name; a curve object is what the keyframes runtime reads.
    animationName: keyframes as unknown as CSSAnimationKeyframes<ViewStyle>,
    animationDuration: duration,
    animationIterationCount: 'infinite',
    animationTimingFunction: 'linear',
  }
}

/** The head's shapes on their way into the top view, and the step of it the face is on; see `morphShapes`. */
interface Morph {
  shapes: string[][]
  step: SharedValue<number>
}

const AnimatedPath = Animated.createAnimatedComponent(Path)
const AnimatedRect = Animated.createAnimatedComponent(Rect)

/**
 * One of the head's shapes at the step of the morph the face is on. The outlines are
 * sampled ahead, so a frame only picks one, and only a frame on which the step changes
 * draws anything.
 */
function MorphPath({ steps, step }: { steps: string[]; step: SharedValue<number> }) {
  const drawn = useAnimatedProps(() => ({ d: steps[step.get()] ?? steps[0]! }))
  return <AnimatedPath animatedProps={drawn} />
}

/**
 * One working eye: a rounded rect in the head's own space, an ellipse at no roundness
 * and a pill at full, cut off at the edge of the core. It is an SVG of its own, so a
 * frame that moves the eyes redraws two small rects and not the shaded head under them.
 */
function WorkEye({ face, size, side, core, step, stage, clock }: {
  face: Face
  size: number
  side: 0 | 1
  /** The core outline per step of the morph, which the eye is cut off at. */
  core: string[]
  step: SharedValue<number>
  stage: SharedValue<Keys>
  clock: SharedValue<number>
}) {
  const id = useId().replace(/[^\w-]/g, '')
  const box = useAnimatedProps(() => eyeBoxAt(stage.get(), side, clock.get()))
  return (
    <Svg height={size} viewBox={`0 0 ${BOX} ${BOX}`} width={size}>
      <Defs>
        <ClipPath id={`${id}c`}>
          <MorphPath step={step} steps={core} />
        </ClipPath>
        {face.sheen ? <SheenGlow id={`${id}s`} /> : null}
      </Defs>
      <G clipPath={`url(#${id}c)`} {...(face.eyeFill === undefined ? {} : { fill: face.eyeFill })}>
        <AnimatedRect animatedProps={box} />
        {face.sheen ? <AnimatedRect animatedProps={box} fill={`url(#${id}s)`} /> : null}
      </G>
    </Svg>
  )
}

const shrunk = (scale: number): ViewStyle => ({ transform: [{ scale: Math.max(scale, GONE) }] })
const dotted = (dot: MeltDot, unit: number): ViewStyle => ({
  transform: [{ translateX: dot.x * unit }, { translateY: dot.y * unit }, { scale: Math.max(dot.s, GONE) }],
})
const sunk = (pose: EyePose, unit: number): ViewStyle => ({
  transform: [{ translateX: pose.x * unit }, { translateY: pose.y * unit }, { scaleX: Math.max(pose.sx, GONE) }, { scaleY: Math.max(pose.sy, GONE) }],
})

/** The shared melt as native keyframes: the body's scale, the three dots, and each eye's way into the middle. */
function meltMotion(melt: DotsPlan, unit: number) {
  const duration = (melt.seconds * 1000) / DOTS_RATE
  return {
    body: busyMotion(melt.body, melt.seconds, duration, shrunk),
    dots: melt.dots.map((keys) => busyMotion(keys, melt.seconds, duration, (dot) => dotted(dot, unit))),
    eyes: melt.eyes.map((stops) => busyMotion(stops.map((stop) => ({ t: stop.t, v: stop.pose, ease: stop.ease })), melt.seconds, duration, (pose) => sunk(pose, unit))),
  }
}

/** The way back out of the dots, once, from where they were: the body swells, the dots run into it, the eyes pop out. */
function leaveMotion(from: Melted, unit: number) {
  const home = (start: ViewStyle, end: ViewStyle): Motion => ({
    animationName: { from: start, to: end } as CSSAnimationKeyframes<ViewStyle>,
    animationDuration: DOTS_HOME_MS,
    animationTimingFunction: dotsHome,
    animationFillMode: 'forwards',
  })
  return {
    body: home(shrunk(from.body), shrunk(1)),
    dots: from.dots.map((dot) => home(dotted(dot, unit), dotted({ x: 0, y: 0, s: 0 }, unit))),
    eyes: from.eyes.map((pose) => home(sunk(pose, unit), sunk({ x: 0, y: 0, sx: 1, sy: 1 }, unit))),
  }
}

/** Each face that starts to work takes the next order of moves, from somewhere new on every launch. */
let rounds = Math.floor(Math.random() * 0x10000)

/** What a working face remembers between renders, off the UI thread. */
interface Run {
  /** Counts what the face was last asked to do, so what an earlier request still had coming is dropped. */
  ask: number
  /** The moves left of this round, the last one played, and which round is next. */
  queue: Step[]
  last: MoveId | undefined
  round: number | undefined
  /** When the dots came on, while they are. */
  wrote: number | undefined
  /** The dots on their way out, as the pass home that takes them there. */
  leaving: Melted | undefined
  /** The walk this face was last asked for has arrived. */
  landed: boolean
  /** What comes once the walk has arrived and the dots are gone: the next move, or word that she is home. */
  after: (() => void) | undefined
}

/** Goes on to what waits, once, when both the walk and the dots are over. */
function settle(state: Run) {
  if (!state.landed || state.wrote !== undefined || state.leaving !== undefined) return
  const after = state.after
  state.after = undefined
  after?.()
}

/**
 * Her face at work: the shared loop (see the client runtime's `busyFace`), and the dots
 * she writes behind.
 *
 * The loop is not declared keyframes, because it has to be cut short anywhere: for the
 * dots when she starts to write, and for the walk home when her turn ends. One clock
 * runs on the UI thread through the keys of the move being played. The body's place is
 * read off them as a view transform, each eye as the geometry of a rect, and the
 * outline as a step of its morph, every frame, by worklets. A change of plan is a walk
 * from what the keys draw at that moment, made on the same thread, so nothing jumps.
 * The JS thread only says what comes next: a move, once every few seconds, and it may
 * be late, because every move ends in the working pose and holds it.
 *
 * The dots stay the declared keyframes they were, on layers inside the body's
 * transform: the body's scale about its middle, three dots, and a wrapper per eye that
 * sinks it into the middle. They start as the walk to the working pose starts, so a
 * move that is cut short runs straight into the melt. On the way back they are swapped
 * for one pass home from where the plan says they are by then (see `meltAt`), and only
 * when that is over does the loop go on, or the face say it is home.
 *
 * She does not breathe, bob, glance or blink here; the loop is all of it.
 */
function WorkFace({ face, rig, size, play, onHome }: {
  face: Face
  rig: Rig
  size: number
  play: Play
  /** The face has walked home, and may be swapped for the one at rest. */
  onHome: () => void
}) {
  const unit = size / BOX
  const middle = rig.head.c
  const [mx, my] = rig.middle
  // The keys the face draws from, and how many seconds into them it is.
  const stage = useSharedValue<Keys>(held(rig.home))
  const clock = useSharedValue(0)
  // A derived value, so the paths that read the step are worked out after it, in the same frame as the eyes.
  const step = useDerivedValue(() => morphStep(topAt(stage.get(), clock.get())))
  const placed = useAnimatedStyle(() => {
    const place = placeAt(stage.get(), clock.get(), middle, unit)
    return { transform: [{ translateX: place.x }, { translateY: place.y }, { rotate: `${place.lean.toFixed(3)}deg` }, { scale: place.scale }] }
  })

  const run = useRef<Run>({ ask: 0, queue: [], last: undefined, round: undefined, wrote: undefined, leaving: undefined, landed: false, after: undefined })
  const home = useEffectEvent(onHome)
  // The dots: playing, or on their way out from where they were.
  const [melt, setMelt] = useState<'on' | Melted>()

  useEffect(() => {
    const state = run.current
    const mine = ++state.ask

    const land = (asked: number) => {
      if (state.ask !== asked) return
      state.landed = true
      settle(state)
    }
    /** Walks from what the face draws right now, and says so when it has arrived. */
    const walk = (to: number[]) => {
      state.landed = false
      runOnUI(() => {
        'worklet'
        stage.set(walkTo(drawnAt(stage.get(), clock.get()), to, WAKE))
        clock.set(0)
        clock.set(withTiming(WAKE, { duration: WAKE * 1000, easing: Easing.linear }, (finished) => {
          'worklet'
          if (finished === true) runOnJS(land)(mine)
        }))
      })()
    }
    /** Plays the next move of the round and the breath after it, then the one after that. */
    const advance = (asked: number) => {
      if (state.ask !== asked) return
      state.round ??= rounds++
      if (state.queue.length === 0) state.queue = loopSteps(state.round++, state.last)
      const next = state.queue.shift()!
      state.last = next.move
      const keys = moveKeys(rig, next.move)
      const seconds = keys.seconds + next.rest
      runOnUI(() => {
        'worklet'
        stage.set(keys)
        clock.set(0)
        clock.set(withTiming(seconds, { duration: seconds * 1000, easing: Easing.linear }, (finished) => {
          'worklet'
          if (finished === true) runOnJS(advance)(asked)
        }))
      })()
    }

    // What is next waits for this walk, and for dots that are on or on their way out; see `settle`.
    state.after = play === 'dots' ? undefined : play === 'home' ? () => { if (state.ask === mine) home() } : () => advance(mine)
    walk(play === 'home' ? rig.home : rig.work)
    // The dots are declared keyframes, which React has to draw: on when she starts to
    // write, and out from where the plan has them when she stops.
    const frame = requestAnimationFrame(() => {
      if (play === 'dots') {
        if (state.wrote !== undefined) return
        // A pass home that was still on its way is dropped here, so its end cannot take these dots with it.
        state.wrote = Date.now()
        state.leaving = undefined
        setMelt('on')
      } else if (state.wrote !== undefined) {
        const from = meltAt(meltPlan(rig), ((Date.now() - state.wrote) / 1000) * DOTS_RATE)
        state.wrote = undefined
        state.leaving = from
        setMelt(from)
      }
    })
    return () => {
      state.ask += 1
      cancelAnimationFrame(frame)
    }
  }, [clock, play, rig, stage])

  const layers = useMemo(
    () => (melt === undefined ? undefined : melt === 'on' ? meltMotion(meltPlan(rig), unit) : leaveMotion(melt, unit)),
    [melt, rig, unit],
  )

  // The dots' keyframes start when they are drawn, which is a little after they were asked for.
  useEffect(() => {
    const state = run.current
    if (melt === undefined) return undefined
    if (melt === 'on') {
      if (state.wrote !== undefined) state.wrote = Date.now()
      return undefined
    }
    const timer = setTimeout(() => {
      if (state.leaving !== melt) return
      state.leaving = undefined
      setMelt(undefined)
      settle(state)
    }, DOTS_HOME_MS)
    return () => clearTimeout(timer)
  }, [melt])

  useEffect(() => () => cancelAnimation(clock), [clock])

  const drop = DOT.r * unit
  const core = rig.shapes[rig.shapes.length - 1]!
  return (
    <Animated.View style={[StyleSheet.absoluteFill, placed]}>
      <Animated.View style={[StyleSheet.absoluteFill, about(rig.middle), layers?.body]}>
        <Svg height={size} viewBox={`0 0 ${BOX} ${BOX}`} width={size}>
          <Body face={face} morph={{ shapes: rig.shapes, step }} />
        </Svg>
      </Animated.View>
      {layers?.dots.map((motion, index) => (
        <Animated.View
          // A dot on its way out is a new view, so its one pass home starts when it is drawn.
          key={`${melt === 'on' ? 'on' : 'out'} ${index}`}
          pointerEvents="none"
          style={[
            styles.busyDot,
            { left: mx * unit - drop, top: my * unit - drop, width: drop * 2, height: drop * 2, borderRadius: drop, backgroundColor: face.bodyFill ?? colors.muted },
            motion,
          ]}
        />
      ))}
      {([0, 1] as const).map((side) => (
        <Animated.View key={side} pointerEvents="none" style={[StyleSheet.absoluteFill, about(rig.eyes[side]), layers?.eyes[side]]}>
          <WorkEye clock={clock} core={core} face={face} side={side} size={size} stage={stage} step={step} />
        </Animated.View>
      ))}
    </Animated.View>
  )
}

/** How long a layer takes to ease to the first key of its move, and home again. */
const REST_MS = 240

/**
 * One layer of a state, as the styles its two views take. The outer view rests at the
 * move's first key and eases there; the inner one plays the loop measured from that
 * key. `arrived` is false for the first frame, so a face that has just been drawn
 * eases into its rest instead of being born there. A loop that never leaves home is
 * not played at all: a face that only turns to the reader may hold that for hours.
 */
function layerMotion(layer: Layer | undefined, arrived: boolean): { rest: Motion | null; loop: Motion | null } {
  if (layer === undefined) return { rest: null, loop: null }
  const keyframes: Record<string, { transform: Layer['rest']; animationTimingFunction: CSSAnimationTimingFunction }> = {}
  for (const [at, key] of Object.entries(layer.loop.keyframes)) keyframes[at] = { transform: key.transform, animationTimingFunction: curveOf(key.ease ?? 'ease-in-out') }
  const home = JSON.stringify(layer.home)
  const idle = Object.values(layer.loop.keyframes).every((key) => JSON.stringify(key.transform) === home)
  return {
    rest: {
      // The frames are plain data, so one module plans for every client; a view's own type is narrower.
      transform: (arrived ? layer.rest : layer.home) as unknown as ViewStyle['transform'],
      transitionProperty: 'transform',
      transitionDuration: REST_MS,
      transitionTimingFunction: easeInOut,
    },
    loop: idle ? null : {
      // The style type narrows a block's curve to a name; a curve object is what the keyframes runtime reads.
      animationName: keyframes as unknown as CSSAnimationKeyframes<ViewStyle>,
      animationDuration: layer.loop.duration,
      animationIterationCount: layer.loop.passes,
      animationTimingFunction: 'linear',
    },
  }
}

/** Whether a face has been drawn for a frame yet, so a layer eases into its rest instead of being born there. */
function useArrived() {
  const [arrived, setArrived] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setArrived(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  return arrived
}

const frameOfFace = (face: Face) => frameOf(outlinePoints(
  face.body.flatMap((part) => (part.kind === 'path' ? [part.d] : [])),
  face.body.flatMap((part) => (part.kind === 'circle' ? [part] : [])),
))

const about = ([x, y]: readonly [number, number]) => ({ transformOrigin: [`${x}%`, `${y}%`, 0] as (string | number)[] })

/**
 * The body gesture of a moment, from the shared plan and sized for her silhouette, as
 * the layers around whatever draws the figure: the pose with its added eye move, or
 * her working face.
 */
function GestureLayers({ face, size, gesture, passes, children }: { face: Face; size: number; gesture: GestureId; passes?: number; children: ReactNode }) {
  const unit = size / BOX
  const arrived = useArrived()
  const layers = useMemo(() => {
    const moves = plan(gesture, frameOfFace(face))
    return { body: gestureFrames(moves, unit, passes), foot: moves.foot, middle: moves.middle }
  }, [face, gesture, passes, unit])
  const fig = layerMotion(layers.body.fig, arrived)
  const turn = layerMotion(layers.body.turn, arrived)
  return (
    <Animated.View style={[StyleSheet.absoluteFill, about(layers.foot), fig.rest]}>
      <Animated.View style={[StyleSheet.absoluteFill, about(layers.foot), fig.loop]}>
        <Animated.View style={[StyleSheet.absoluteFill, about(layers.middle), turn.rest]}>
          <Animated.View style={[StyleSheet.absoluteFill, about(layers.middle), turn.loop]}>
            {children}
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </Animated.View>
  )
}

/**
 * A face in a state with a look of its own: the pose the library gave her eyes and a
 * small eye move added on top; the body gesture is played around it. She does not
 * breathe, bob or glance here: the gesture is the body's motion, and it means something.
 */
function StateFace({ face, size, look }: { face: Face; size: number; look: FaceLook }) {
  const unit = size / BOX
  const arrived = useArrived()
  const move = look.eyes
  const eyes = useMemo(() => {
    // From the middle of the pair, where the resting gaze leaves it, to the middle of the face.
    const toMiddle = frameOfFace(face).middle[0] - face.eyes.reduce((sum, eye) => sum + eye.cx, 0) / Math.max(face.eyes.length, 1)
    return new Map(face.eyes.map((eye) => [eye.wrap, move === 'toward' ? eyeFrames(towardStops(toMiddle), unit, EYE_MOVE_MS.toward) : undefined]))
  }, [face, move, unit])

  return (
    <>
      <Svg height={size} viewBox={`0 0 ${BOX} ${BOX}`} width={size}>
        <Body face={face} />
      </Svg>
      {face.eyes.map((eye) => {
        const added = layerMotion(eyes.get(eye.wrap), arrived)
        return (
          <Animated.View key={eye.wrap} pointerEvents="none" style={[StyleSheet.absoluteFill, added.rest]}>
            <Animated.View style={[StyleSheet.absoluteFill, added.loop]}>
              <EyeLayer eye={eye} fill={face.eyeFill} pose={face.pose} sheen={face.sheen} size={size} still={false} timing={face} />
            </Animated.View>
          </Animated.View>
        )
      })}
    </>
  )
}

const DOT_SCALE = [0.125, 0.15625, 0.1875]
const DOT_DELAY_MS = [0, 180, 360]

function ThoughtDots({ color, size }: { color: ColorValue; size: number }) {
  return (
    <View pointerEvents="none" style={[styles.dots, { top: -size * 0.1875, left: size * 0.75, gap: size * 0.0625 }]}>
      {DOT_SCALE.map((scale, index) => (
        <Dot color={color} delay={DOT_DELAY_MS[index] ?? 0} face={size} key={scale} side={size * scale} />
      ))}
    </View>
  )
}

const drift = cubicBezier(0.3, 0.7, 0.3, 1)

function driftKeyframes(face: number): CSSAnimationKeyframes<ViewStyle> {
  return {
    '0%': { opacity: 0, transform: [{ translateY: face * 0.125 }, { scale: 0.5 }], animationTimingFunction: drift },
    '30%': { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }], animationTimingFunction: drift },
    '75%': { opacity: 1, animationTimingFunction: drift },
    '100%': { opacity: 0, transform: [{ translateY: -face * 0.15625 }, { scale: 0.7 }] },
  } as unknown as CSSAnimationKeyframes<ViewStyle>
}

function Dot({ color, delay, face, side }: { color: ColorValue; delay: number; face: number; side: number }) {
  const still = useReducedMotion()
  const rise = useMemo<Motion | null>(
    () =>
      still
        ? null
        : {
            animationName: driftKeyframes(face),
            animationDuration: 1500,
            animationDelay: delay,
            animationIterationCount: 'infinite' as const,
            animationFillMode: 'backwards' as const,
          },
    [delay, face, still],
  )

  return <Animated.View style={[{ width: side, height: side, borderRadius: side, backgroundColor: color }, rise]} />
}

const styles = StyleSheet.create({
  dots: { position: 'absolute', flexDirection: 'row', alignItems: 'flex-end' },
  busyDot: { position: 'absolute' },
})
