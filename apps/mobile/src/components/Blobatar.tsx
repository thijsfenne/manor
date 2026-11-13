import { accentHue } from '@manor/client-runtime/accent-hue'
import { BLOB_FACE_TRAITS, DEFAULT_BLOB_TONE, SIDEBAR_WORKING_GAZE, WORKING_GAZE, blobShapeOf, blobShapeTraits } from '@manor/client-runtime/blob-shapes'
import { BUSY_LOOK, DOT, order, timeline, type Key, type Pair } from '@manor/client-runtime/busy-face'
import { CLAY, groundY, palette, traits as seedTraits, type Glow } from '@manor/blobatar'
import { unsure } from '@manor/blobatar/expression'
import { _parts } from '@manor/blobatar/internal'
import MaskedView from '@react-native-masked-view/masked-view'
import { Image } from 'expo-image'
import { useId, useMemo, useState } from 'react'
import { StyleSheet, View, type ColorValue, type ViewStyle } from 'react-native'
import Animated, { cubicBezier, useReducedMotion, type CSSAnimationKeyframes, type CSSAnimationTimingFunction, type CSSStyle } from 'react-native-reanimated'
import Svg, { Circle, ClipPath, Defs, Ellipse, G, Path, RadialGradient, Rect, Stop } from 'react-native-svg'

import { keyOffsets } from '@/lib/busyFrames'
import { colors, shimmerTones } from '@/theme'

/** A block of CSS animation or transition settings, as the view's style takes them. */
type Motion = CSSStyle<ViewStyle>

/** The library draws in a hundred-unit box; every motion below is stated in those units. */
const BOX = 100

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
  /** Her turn is running in a bubble, with thought dots above her face. */
  working?: boolean
  /**
   * Her turn is running, worn the way the Mac wears it: the busy loop, eyes on the
   * move and now and then melting into three dots. A portrait, or a reader who asks
   * for reduced motion, gets the still working face with thought dots instead.
   */
  busy?: boolean
  /** A running DM in the sidebar holds an upward squint and blinks without dots. */
  sidebarWorking?: boolean
  /**
   * How much of her moves, and what that costs.
   *
   * `true` is the full live face: breathe, bob, glance, blink and a pose per eye,
   * which is ten native views and about seven animations. A sidebar working face
   * keeps the posed eyes and blink but drops the ambient loops. `'blink'` is the
   * cheap living face for a resting persona: three views and one animation. `false` is
   * one still SVG and nothing else.
   *
   * Off by default. A list where every face moves fully is a list that stutters, so
   * only the face behind the latest reply earns `true` while at rest; every other
   * face in a list takes `'blink'`, the idle motion that reads at avatar size.
   */
  animate?: boolean | 'blink'
}

/**
 * A persona's face, drawn from the same generator the web uses and moving the way
 * the web's stylesheet moves it. The library's string API is static markup, so the
 * face is taken apart at its seams: the body is one SVG, each eye is its own layer,
 * and the breathe, bob, blink and glance of `blobatar/motion.css` are restated as
 * Reanimated CSS animations with the library's own seeded timings. Those run on the
 * native side without a worklet per frame, which is what lets a transcript full of
 * faces scroll at speed.
 */
export function Blobatar({ name, color, src, shape, tone = DEFAULT_BLOB_TONE, size, working: asked = false, busy: busyAsked = false, sidebarWorking = false, animate = false }: BlobatarProps) {
  const still = useReducedMotion()
  const live = animate === true && !sidebarWorking
  const hue = accentHue(color)
  const square = { width: size, height: size }
  const portrait = src !== undefined && src !== ''
  // The busy face wears her resting traits, so only the still working face pins its own gaze.
  const busy = busyAsked && live && !portrait && !still
  const working = asked || (busyAsked && !busy)
  const worn = blobShapeOf(name, shape)
  const face = useMemo(() => {
    if (portrait) return null
    const chosen = blobShapeTraits(shape)
    const traits = { ...BLOB_FACE_TRAITS, ...chosen, ...(sidebarWorking ? SIDEBAR_WORKING_GAZE : working ? WORKING_GAZE : {}) }
    return takeApart(
      _parts(name, {
        size,
        tone,
        animate: 'always',
        ...(hue === undefined ? {} : { hue }),
        traits,
        ...(working || sidebarWorking ? { expression: unsure } : {}),
      }),
    )
  }, [hue, name, portrait, shape, size, tone, working, sidebarWorking])

  if (portrait || face === null) {
    return (
      <View style={square}>
        <Image contentFit="cover" source={{ uri: src }} style={[square, { borderRadius: size / 2 }]} />
        {working && live ? <ThoughtDots color={color} size={size} /> : null}
      </View>
    )
  }

  // The triangle draws its ink high in its viewBox; the lift levels it with a name.
  const lift = worn?.lift === undefined ? 0 : (worn.lift / 100) * size

  return (
    <View style={[square, lift === 0 ? null : { transform: [{ translateY: lift }] }]}>
      {busy ? (
        <BusyFace face={face} size={size} />
      ) : sidebarWorking && animate ? (
        <LiveFace face={face} size={size} blinkOnly />
      ) : live ? (
        <LiveFace face={face} size={size} />
      ) : animate ? (
        <BlinkFace face={face} size={size} />
      ) : (
        <StillFace face={face} size={size} />
      )}
      {working && live ? <ThoughtDots color={workingDot(name, hue, tone)} size={size} /> : null}
    </View>
  )
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
  bodyFill: string | undefined
  body: BodyPart[]
  /** Where her contact shadow centres, in box units. */
  ground: number
  /** The head's parts as one clip outline; see `silhouette`. */
  silhouette: string[]
  /** The library's ink for this face; absent leaves the path to its own default. */
  eyeFill: string | undefined
  eyes: Eye[]
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
function takeApart(parts: ReturnType<typeof _parts>): Face | null {
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
  return {
    // The custom properties carry a tinting pose's colours; the markup keeps the resting pair.
    bodyFill: vars['--mo-head'] ?? bodyFill,
    body,
    ground: groundY(
      body.flatMap((part) => (part.kind === 'path' ? [part.d] : [])),
      body.flatMap((part) => (part.kind === 'circle' ? [part] : [])),
    ),
    silhouette: silhouette(body),
    eyeFill: vars['--mo-eye'] ?? eyeFill,
    eyes,
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

function LiveFace({ face, size, blinkOnly = false }: { face: Face; size: number; blinkOnly?: boolean }) {
  const still = useReducedMotion()
  const unit = size / BOX
  const square = { width: size, height: size }

  const amp = bodyAmp(size, unit)
  const breathe = blinkOnly ? null : breatheMotion(face.breathePhase, still, Math.min(amp, BREATHE_CAP))
  const bob = blinkOnly ? null : bobMotion(face.bobPhase, unit, still, amp)
  const gaze = useMemo<Motion | null>(() => {
    if (still || blinkOnly) return null
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
  }, [blinkOnly, face.lookX, face.lookY, face.saccade, face.saccadePhase, size, still, unit])

  return (
    <View style={square}>
      <Ground face={face} size={size} />
      <Animated.View style={[square, breathe]}>
        <Animated.View style={[square, bob]}>
          <Svg height={size} viewBox={`0 0 ${BOX} ${BOX}`} width={size}>
            <Body face={face} ground={false} />
          </Svg>
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, gaze]}>
            {face.eyes.map((eye) => (
              <EyeLayer eye={eye} fill={face.eyeFill} key={eye.wrap} pose={face.pose} size={size} still={still} timing={face} />
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
      {face.eyes.map((eye) => <Path d={eye.d} key={eye.wrap} />)}
    </G>
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

/** A clay gradient from the library's numbers, stretched to its ellipse in user space. */
function ClayGlow({ id, glow }: { id: string; glow: Glow }) {
  return (
    <RadialGradient cx={0} cy={0} gradientTransform={`translate(${glow.cx} ${glow.cy}) scale(${glow.rx} ${glow.ry})`} gradientUnits="userSpaceOnUse" id={id} r={1}>
      {glow.stops.map(([offset, opacity, white], index) => (
        <Stop key={index} offset={offset} stopColor={white ? '#fff' : '#000'} stopOpacity={opacity} />
      ))}
    </RadialGradient>
  )
}

/** The contact shadow on the ground under her. */
function Contact({ face }: { face: Face }) {
  const id = useId().replace(/[^\w-]/g, '')
  const contact = { ...CLAY.contact, cy: face.ground }
  return (
    <>
      <Defs>
        <ClayGlow glow={contact} id={`${id}c`} />
      </Defs>
      <Ellipse cx={contact.cx} cy={contact.cy} fill={`url(#${id}c)`} rx={contact.rx} ry={contact.ry} />
    </>
  )
}

/**
 * The contact shadow as a layer of its own, for a face whose head breathes, bobs or
 * melts: the ground stays put while she moves over it.
 */
function Ground({ face, size }: { face: Face; size: number }) {
  return (
    <Svg height={size} pointerEvents="none" style={StyleSheet.absoluteFill} viewBox={`0 0 ${BOX} ${BOX}`} width={size}>
      <Contact face={face} />
    </Svg>
  )
}

/**
 * How far the inner shadow softens. The web blurs it; a blur here is a Core Image
 * pass per face on every mount, which a scrolling list cannot afford. So the band is
 * cut with a copy of the head moved toward the light, over a half-strength copy
 * grown by this band: full shadow at the edge, half across the band, none past it.
 * The grown copy fades as one group, so overlapping parts never double its strength.
 */
const SHADOW_BAND = 5

/**
 * The head in the library's clay finish, drawn with the same numbers the web draws.
 * Every overlay is a full-box rect inside one clip of all the head's parts, so a pill
 * or a cloud is shaded as one silhouette with no seams where its parts overlap.
 */
function Body({ face, ground = true }: { face: Face; ground?: boolean }) {
  const id = useId().replace(/[^\w-]/g, '')
  const fill = face.bodyFill ?? colors.muted
  const { inner } = CLAY
  const clip = `url(#${id}k)`
  return (
    <>
      <Defs>
        <ClipPath id={`${id}k`}>
          {face.silhouette.map((d, index) => <Path d={d} key={index} />)}
        </ClipPath>
        <ClayGlow glow={CLAY.light} id={`${id}l`} />
        <ClayGlow glow={CLAY.highlight} id={`${id}h`} />
      </Defs>
      {ground ? <Contact face={face} /> : null}
      <G fill={fill}>
        <Parts body={face.body} />
      </G>
      <G clipPath={clip} clipRule="nonzero">
        <Rect fill="#000" height={BOX} opacity={inner.opacity} width={BOX} />
        <G opacity={0.5} transform={`translate(${inner.dx} ${inner.dy})`}>
          <G fill={fill} stroke={fill} strokeWidth={SHADOW_BAND}>
            <Parts body={face.body} />
          </G>
        </G>
        <G fill={fill} transform={`translate(${inner.dx} ${inner.dy})`}>
          <Parts body={face.body} />
        </G>
        <Rect fill={`url(#${id}l)`} height={BOX} width={BOX} />
        <Rect fill={`url(#${id}h)`} height={BOX} width={BOX} />
      </G>
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
  size,
  still,
  timing,
}: {
  eye: Eye
  fill: string | undefined
  pose: Pose
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

/** The middle of the body's drawn box, where the Mac's `getBBox` puts the dots. Curve handles count, which barely moves a blob's middle. */
function bodyMiddle(body: readonly BodyPart[]): Pair {
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity]
  const add = (x: number, y: number) => {
    left = Math.min(left, x)
    right = Math.max(right, x)
    top = Math.min(top, y)
    bottom = Math.max(bottom, y)
  }
  for (const part of body) {
    if (part.kind === 'circle') {
      add(part.cx - part.r, part.cy - part.r)
      add(part.cx + part.r, part.cy + part.r)
      continue
    }
    let [x, y] = [0, 0]
    for (const [, command, args = ''] of part.d.matchAll(/([MLCQHVZ])([^MLCQHVZ]*)/g)) {
      const values = args.trim().split(/[\s,]+/).filter(Boolean).map(Number)
      if (command === 'H') for (const value of values) add((x = value), y)
      else if (command === 'V') for (const value of values) add(x, (y = value))
      else for (let index = 0; index + 1 < values.length; index += 2) add((x = values[index]!), (y = values[index + 1]!))
    }
  }
  return left === Infinity ? [BOX / 2, BOX / 2] : [(left + right) / 2, (top + bottom) / 2]
}

/** Each busy face that starts takes the next variation, so two turns in a row differ. */
let busyTurns = 0

/**
 * The Mac's working face: the shared busy loop played as native keyframes. Each eye
 * runs its track on a layer of its own, clipped to the silhouette so it can leave the
 * shape and stay out of sight until it comes back; between two variations the body
 * shrinks into three dots in its own colour and swells back out of them. It blinks
 * underneath, as the Mac's does, and nothing else moves: no breath, bob or glance.
 *
 * The Mac also runs a goo filter while the dots bud and merge. Native views have no
 * cheap filter to animate, so here the drops overlap the shrinking body instead.
 */
function BusyFace({ face, size }: { face: Face; size: number }) {
  const [seed] = useState(() => busyTurns++)
  const unit = size / BOX
  const rig = useMemo(() => {
    const left = face.eyes.find((eye) => eye.wrap < 0)
    const right = face.eyes.find((eye) => eye.wrap > 0)
    if (left === undefined || right === undefined) return null
    const middle = bodyMiddle(face.body)
    const pull = (eye: Eye): Pair => [middle[0] - eye.cx, middle[1] - eye.cy]
    const plan = timeline(
      order(BUSY_LOOK.variation, seed),
      [(right.cx - left.cx) / 2, (right.cy - left.cy) / 2],
      [pull(left), pull(right)],
      BUSY_LOOK.dots,
    )
    const duration = (plan.total * 1000) / BUSY_LOOK.speed
    const silhouette = [...face.body].reverse().find((part) => part.kind === 'path')
    return {
      middle,
      silhouette: silhouette?.kind === 'path' ? silhouette.d : undefined,
      eyes: new Map([left, right].map((eye, index) => [eye.wrap, busyMotion(plan.eyes[index]!.map((stop) => ({ t: stop.t, v: stop.pose, ease: stop.ease })), plan.total, duration, (pose) => ({
        transform: [
          { translateX: pose.x * unit },
          { translateY: pose.y * unit },
          // Reanimated's angle parser refuses exponent notation, which eased values near zero produce.
          { rotate: `${Number(pose.r.toFixed(3))}deg` },
          { scaleX: Math.max(pose.sx, GONE) },
          { scaleY: Math.max(pose.sy, GONE) },
        ],
      }))])),
      body: busyMotion(plan.body, plan.total, duration, (scale) => ({ transform: [{ scale: Math.max(scale, GONE) }] })),
      dots: plan.dots.map((keys) => busyMotion(keys, plan.total, duration, (dot) => ({
        transform: [{ translateX: dot.x * unit }, { translateY: dot.y * unit }, { scale: Math.max(dot.s, GONE) }],
      }))),
    }
  }, [face, seed, unit])

  if (rig === null) return <BlinkFace face={face} size={size} />

  const [mx, my] = rig.middle
  const eyes = face.eyes.map((eye) => (
    <Animated.View key={eye.wrap} style={[StyleSheet.absoluteFill, { transformOrigin: [`${eye.cx}%`, `${eye.cy}%`, 0] as (string | number)[] }, rig.eyes.get(eye.wrap)]}>
      <EyeLayer eye={eye} fill={face.eyeFill} pose={face.pose} size={size} still={false} timing={face} />
    </Animated.View>
  ))
  const drop = DOT.r * unit
  return (
    <>
      <Ground face={face} size={size} />
      <Animated.View style={[StyleSheet.absoluteFill, { transformOrigin: [`${mx}%`, `${my}%`, 0] as (string | number)[] }, rig.body]}>
        <Svg height={size} viewBox={`0 0 ${BOX} ${BOX}`} width={size}>
          <Body face={face} ground={false} />
        </Svg>
      </Animated.View>
      {rig.dots.map((motion, index) => (
        <Animated.View
          key={index}
          pointerEvents="none"
          style={[
            styles.busyDot,
            { left: mx * unit - drop, top: my * unit - drop, width: drop * 2, height: drop * 2, borderRadius: drop, backgroundColor: face.bodyFill ?? colors.muted },
            motion,
          ]}
        />
      ))}
      {rig.silhouette === undefined ? (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>{eyes}</View>
      ) : (
        <MaskedView
          maskElement={
            <Svg height={size} viewBox={`0 0 ${BOX} ${BOX}`} width={size}>
              <Path d={rig.silhouette} fill={shimmerTones.mask} />
            </Svg>
          }
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
        >
          {eyes}
        </MaskedView>
      )}
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
