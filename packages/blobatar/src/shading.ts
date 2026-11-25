/**
 * Manor's clay finish: the head lit in its own colour from the top left, a soft
 * shadow inside its bottom-right edge with a thin bounce light closing that edge,
 * and a matte highlight.
 *
 * Opt-in through `shading: "clay"`, so the frozen default output stays exactly
 * what it was. Every layer is an overlay, and the head keeps its one flat fill.
 * The overlays are not neutral: the light leans warm and the shade leans cool, both
 * relit from the head's own colour, because black and white over a saturated head
 * dull it at the edges and chalk its highlight. That costs the finish its free ride
 * on a tinting expression, so the relit colours travel the way the head's fill
 * does. A still face has them written into the markup from the palette it wears,
 * and an animated face reads them from `--mo-hi`, `--mo-lo` and `--mo-deep`, which
 * the adapter sets beside `--mo-head`. The markup under the root therefore still
 * does not vary with the expression.
 *
 * The numbers live here once. The string renderer below serializes them for the
 * web, and the phone draws the same values with react-native-svg.
 */
import { fromHex, toHex } from "./color"

/**
 * Which colour a layer wears. `hi`, `lo` and `deep` are the head relit, see
 * `clayTones`.
 */
export type Tone = "white" | "hi" | "lo" | "deep"

/** A gradient stop: offset, opacity and tone. */
export type Stop = readonly [offset: number, opacity: number, tone: Tone]

/** A radial gradient in user space, stretched to an ellipse when `rx` and `ry` differ. */
export interface Glow {
  cx: number
  cy: number
  rx: number
  ry: number
  /** Degrees the ellipse is turned about its own centre. */
  rot?: number
  stops: readonly Stop[]
}

export const CLAY = {
  /**
   * The optical size. At `small` and under, the finish is the light alone and the
   * eyes are drawn larger, because a highlight and a blurred band are haze at
   * twenty pixels and the eyes are a pixel wide.
   */
  small: 28,
  /**
   * The light across the head: its warm relit colour at the top left fading out
   * by 0.46 of the radius, then its cool one toward the far edge. Two stops share
   * 0.46 so the colour switches where both are transparent.
   */
  light: {
    cx: 37, cy: 30, rx: 68, ry: 68,
    stops: [[0, 1, "hi"], [0.46, 0, "hi"], [0.46, 0, "lo"], [1, 1, "lo"]],
  } satisfies Glow,
  /**
   * The matte highlight, a faint white ellipse that the head's outline clips. Wide and
   * low so it reads as light across the face, not a spot on it.
   */
  highlight: {
    cx: 36, cy: 29, rx: 26, ry: 18, rot: -18,
    stops: [[0, 0.2, "white"], [0.6, 0.08, "white"], [1, 0, "white"]],
  } satisfies Glow,
  /** What a dark head keeps of its white layers. */
  dim: { dark: 0.64 },
  /**
   * The inner shadow: the silhouette, blurred by `blur` and moved by `dx`/`dy`
   * toward the light, cut out of itself. What is left is a soft band along the
   * bottom-right edge, painted in `tone` at `opacity`.
   */
  inner: { blur: 4, dx: -3, dy: -4, opacity: 0.62, tone: "deep" },
  /** The bounce light: the same cut, tighter, so a thin lit line closes the shaded edge. */
  bounce: { blur: 1.1, dx: -1.1, dy: -1.5, opacity: 0.38, dark: 0.5, tone: "hi" },
  /** The lit lip under each eye, which is what presses it into the surface. */
  lip: { dy: 0.9, opacity: 0.55, tone: "hi" },
  /**
   * The soft sheen inside each dark eye: a white dome high in the eye, fading
   * toward its edge, where the eye's own outline clips what is left. In the eye's own bounding box, so it follows the eye's
   * shape and pose; centred, so it never points a gaze the way a catchlight would.
   */
  sheen: { cx: 0.46, cy: 0.3, r: 0.5, opacity: 0.3 },
  /** The eyes at `small`: grown about their own centres, spread about the pair's. */
  eyes: { grow: 1.34, spread: 1.16 },
} as const

/** Whether eyes in this ink wear the sheen: dark ink only, since white on light ink is nothing. */
export const sheenInk = (eye: string) => fromHex(eye).l < 0.5

/** The head's colour and the three it is relit into. */
export type Tones = Record<Tone, string> & {
  /** A dark head, whose white layers are dimmed and whose bounce light is raised. */
  dark: boolean
}

/** Moves a hue toward a target along the short arc, by at most `by` degrees. */
const toward = (h: number, target: number, by: number) => {
  const d = ((target - h + 540) % 360) - 180
  return (h + Math.max(-by, Math.min(by, d)) + 360) % 360
}

/**
 * The head relit: `hi` lighter and leaning to yellow, `lo` darker, a touch more
 * saturated and leaning to violet, `deep` further the same way. Lightness, chroma
 * and hue move in OKLCh, the space the palette is built in.
 */
export function clayTones(head: string): Tones {
  const o = fromHex(head)
  const dark = o.l < 0.45
  const relit = (dl: number, dc: number, target: number, by: number) =>
    toHex({ l: Math.max(0.05, Math.min(0.98, o.l + dl)), c: Math.max(0, o.c + dc), h: toward(o.h, target, by) })
  return {
    white: "white",
    hi: relit(dark ? 0.16 : 0.1, -0.01, 95, 14),
    lo: relit(-0.13, 0.02, 285, 18),
    deep: relit(-0.26, 0.01, 285, 24),
    dark,
  }
}

/** The relit colours as the custom properties an animated face reads them from. */
export const toneVars = (head: string) => {
  const t = clayTones(head)
  return { "--mo-hi": t.hi, "--mo-lo": t.lo, "--mo-deep": t.deep }
}

const r2 = (v: number) => Math.round(v * 100) / 100

/**
 * One finish, as the renderer asks for it. `id` prefixes every gradient, clip and
 * filter. `tones` is what a still face is painted in; absent, the face is animated
 * and reads its colours from the custom properties. `dark` is stated apart from
 * the tones for that reason: an animated face has none here, and its opacities may
 * not move with the expression.
 */
export interface Finish {
  id: string
  /** Which finish: this module's clay, or the fur in `fur.ts`. */
  kind: "clay" | "fluffy"
  size?: number
  tones?: Tones
  dark?: boolean
}

/** A tone as the value of a paint property: a colour, or the custom property it rides on. */
const colour = (tone: Tone, tones?: Tones) =>
  tones ? tones[tone] : tone === "white" ? tone : `var(--mo-${tone})`

/** A paint property as markup. A custom property has to go through `style`; an attribute cannot read one. */
export const paint = (property: string, tone: Tone, tones?: Tones) => {
  const value = colour(tone, tones)
  return value.startsWith("var(") ? `style="${property}:${value}"` : `${property}="${value}"`
}

/** A user-space radial gradient; the turn and the stretch ride on its transform so it stays elliptical. */
const glow = (id: string, g: Glow, tones?: Tones, keep = 1) =>
  `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(${g.cx} ${r2(g.cy)})${g.rot ? ` rotate(${g.rot})` : ""} scale(${g.rx} ${g.ry})">` +
  g.stops.map(([offset, opacity, tone]) => `<stop offset="${offset}" ${paint("stop-color", tone, tones)} stop-opacity="${r2(opacity * keep)}"/>`).join("") +
  `</radialGradient>`

/** The whole viewBox; the head's clip trims it to the silhouette. */
const box = (fill = "") => `<rect width="100" height="100"${fill && ` fill="${fill}"`}/>`

/**
 * The clay finish around one head, as the two places it goes.
 *
 * `shapes` is the head's parts, unfilled. They become one clip path, and every
 * overlay is a full-box rect inside that clip. Drawing the overlays on the parts
 * themselves would stack their translucency where parts overlap, which seams a
 * head built from several (the pill, the cloud, the sun). A clip is their union.
 *
 * `overlays` belongs inside the head's own group, after its parts: the busy melt
 * scales that group as one. They are a rect and groups, never paths, so the
 * group's last path is still the silhouette. A box measure of that group counts
 * the rects, so measure its parts instead.
 *
 * At `CLAY.small` and under there are no filters at all, only the light: the rest
 * is haze at that size, and a filter per list row is the costly part of the finish.
 */
export function clay(finish: Finish, shapes: string) {
  const { id, tones } = finish
  const dark = finish.dark ?? tones?.dark ?? false
  const small = finish.size !== undefined && finish.size <= CLAY.small
  const url = (key: string) => `url(#${id}${key})`
  const whites = dark ? CLAY.dim.dark : 1
  // Filtered as a group, so `SourceAlpha` is the clipped silhouette, not the rect.
  const band = (key: string, s: { blur: number; dx: number; dy: number; tone: Tone }, opacity: number) =>
    `<filter id="${id}${key}" x="-20%" y="-20%" width="140%" height="140%">` +
    `<feGaussianBlur in="SourceAlpha" stdDeviation="${s.blur}"/>` +
    `<feOffset dx="${s.dx}" dy="${s.dy}"/>` +
    `<feComposite in2="SourceAlpha" operator="arithmetic" k2="-1" k3="1" result="s"/>` +
    `<feFlood ${paint("flood-color", s.tone, tones)} flood-opacity="${opacity}"/>` +
    `<feComposite in2="s" operator="in"/>` +
    `</filter>`
  const cut = (inside: string) => `<g clip-path="${url("k")}">${inside}</g>`
  const { sheen: s } = CLAY
  const sheen =
    `<radialGradient id="${id}e" cx="${s.cx}" cy="${s.cy}" r="${s.r}">` +
    `<stop offset="0" stop-color="white" stop-opacity="${s.opacity}"/><stop offset="1" stop-color="white" stop-opacity="0"/>` +
    `</radialGradient>`
  return {
    defs:
      `<defs><clipPath id="${id}k">${shapes}</clipPath>` +
      glow(`${id}l`, CLAY.light, tones) +
      (small
        ? ""
        : glow(`${id}h`, CLAY.highlight, tones, whites) +
          band("i", CLAY.inner, CLAY.inner.opacity) +
          band("b", CLAY.bounce, dark ? CLAY.bounce.dark : CLAY.bounce.opacity) +
          sheen) +
      `</defs>`,
    overlays: small
      ? cut(box(url("l")))
      : cut(box(url("l"))) +
        `<g filter="${url("i")}">${cut(box())}</g><g filter="${url("b")}">${cut(box())}</g>` +
        cut(box(url("h"))),
    /** The fill of each eye's sheen, empty on a small face. Draw it only on eyes `sheenInk` passes. */
    sheen: small ? "" : url("e"),
  }
}
