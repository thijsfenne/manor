/**
 * Manor's fluffy finish: a head in soft, short pile.
 *
 * Opt-in through `shading: "fluffy"`. It is built from what a browser and react-native-svg
 * both draw the same way, with no filter at all:
 *
 *  1. A fringe. The head's own outline is stroked a few times under the fill, each time
 *     wider and with a sparser, uneven dash. A dash on a wide stroke is a bristle standing
 *     square on the outline, so the passes together are hairs of several lengths that thin
 *     out away from the body. They repeat the head's own shapes, so they follow whatever
 *     the outline does.
 *  2. The flat head fill, which hides the inner half of every bristle.
 *  3. Light, inside one clip of all the head's parts: a soft light and shade in the head's
 *     relit colours, an inner shade that makes the head a cushion, and a pale rim where
 *     the pile catches light from behind.
 *  4. The pile: one shared texture of light and dark fibres with alpha (`PILE`), laid over
 *     the head inside the same clip. It is white and black only, so the head tints it.
 *  5. The eyes as beads pressed into the pile: a crease above, a lit lip below, a sheen.
 *
 * Three optical sizes, see `furPlan`. A large face wears all of it. A mid face drops the
 * loosest pass of hairs and takes fewer steps of shade. At `FUR.small` and under, only a
 * coarse fringe and the light are drawn, because the rest is finer than a pixel there.
 *
 * Its colours travel the way the clay finish's do: a still face has them written in from
 * the palette it wears, and an animated face reads them from custom properties (`furVars`)
 * that the adapter sets beside `--mo-head`.
 *
 * The numbers live here once. The string renderer below is the web's; the phone draws
 * the same numbers with react-native-svg.
 */
import { fromHex, toHex } from "./color"
import { PILE } from "./pile"
import { clayTones } from "./shading"
import { superellipse, type Superellipse } from "./shape"

/** One pass of the fringe: a dashed stroke on the outline. */
export interface Fringe {
  /** Stroke width in viewBox units. Half of it stands outside the outline. */
  width: number
  /** Bristle and gap lengths along the outline, in turn. An even count, uneven on purpose. */
  dash: readonly number[]
  opacity: number
  /** How much of `FUR.comb` this pass is moved by, 0 to 1. */
  comb: number
}

export const FUR = {
  /** At this size and under, the finish is the coarse fringe and the light alone. */
  small: 28,
  /** At this size and under, a face drops the loosest pass of hairs and takes `inner.stepsMid`. */
  mid: 40,
  /**
   * The fringe of a large face, shortest and densest first. The bristles are thinner than a
   * pixel at every size a face is shown, so each pass draws as a soft, uneven band and not
   * as a comb. `comb` moves a pass down and to the right, the way the coat is brushed: the
   * long hairs hang past the body there and tuck behind it at the top left.
   */
  fringe: [
    { width: 1.4, dash: [1.6, 0.3, 1.1, 0.25, 2.0, 0.35, 0.8, 0.3], opacity: 1, comb: 0 },
    { width: 2.6, dash: [1.4, 0.6, 0.8, 0.5, 2.1, 0.9, 1.1, 0.4, 0.5, 0.7], opacity: 0.8, comb: 0.3 },
    { width: 3.8, dash: [0.9, 1.3, 1.5, 1.8, 0.7, 1.1, 1.2, 2.3, 0.5, 0.9], opacity: 0.5, comb: 0.6 },
    { width: 4.8, dash: [0.3, 0.5, 0.35, 0.8, 0.3, 0.45, 0.4, 0.6], opacity: 0.3, comb: 1 },
  ] as readonly Fringe[],
  /** The fringe of a small face: fewer, wider bristles, so they survive at one pixel. */
  fringeSmall: [
    { width: 3.2, dash: [1.9, 1.0, 1.3, 1.4, 2.4, 1.1], opacity: 0.8, comb: 0 },
    { width: 6, dash: [1.3, 2.0, 1.7, 2.8, 1.1, 1.7], opacity: 0.4, comb: 0 },
  ] as readonly Fringe[],
  /**
   * The hairs are one flat colour: the head, leant this far toward its shade. A flat stroke
   * is several times cheaper to draw than a gradient one, and the hairs are too thin for a
   * gradient to show. Leaning to the shade keeps the far edge from reading as a pale outline.
   */
  hair: { shade: 0.18 },
  /** How far a fully combed pass is moved, in viewBox units. */
  comb: { dx: 0.22, dy: 0.4 },
  /** The soft light and shade across the head, as a radial gradient in user space. */
  light: { cx: 38, cy: 32, r: 66, hi: 0.38, from: 0.5, lo: 0.5 },
  /**
   * The inner shade that makes the head a cushion: the crease tone laid over the whole head
   * at `opacity`, then the lit head drawn again on top in `steps`, each through the same
   * clip moved a step further toward the light by `dx`/`dy`. Step `k` of `n` covers
   * `1 / (n - k)` of what is left, so the shade falls off evenly from the far edge.
   */
  inner: { dx: -5, dy: -8, opacity: 0.42, steps: 5, stepsMid: 2 },
  /** The pale rim on the far side from the light: nothing until `from` of the radius, then up to `opacity`. */
  rim: { cx: 39, cy: 61, r: 56, from: 0.72, opacity: 0.3 },
  /** How strongly the pile shows: on a mid head, a dark one, and one near white, which it would grey. */
  pile: { opacity: 0.16, dark: 0.2, pale: 0.1 },
  /** The eye as a bead in the pile. */
  eye: {
    /** The crease: the eye's outline stroked in the deep tone, moved toward the light. */
    crease: { width: 2, dx: -0.35, dy: -0.55, opacity: 0.3 },
    /** The lit lip under the eye: the eye again, moved down, in the tip colour. */
    lip: { dx: 0.3, dy: 1.15, width: 0.9, opacity: 0.6 },
    /** The sheen: a narrow white glow on the bead's right flank, in the eye's bounding box. */
    sheen: { cx: 0.72, cy: 0.42, rx: 0.24, ry: 0.46, opacity: 0.34 },
  },
} as const

/**
 * The fur's own colours, all from the head. Fur is shaded in its own hue: the shade between
 * hairs is the same dye with less light on it, and a hair's tip is paler because light
 * scatters in it. `hi` is the clay finish's warm relit tone.
 */
export interface FurTones {
  head: string
  hi: string
  /** The head with less light on it, for the soft shade and the far side. */
  shade: string
  /** Darker again, for the inner shade and the crease the eyes sit in. */
  deep: string
  /** A hair's tip: lighter and less saturated. */
  tip: string
  /** The colour of the fringe, see `FUR.hair`. */
  hair: string
  dark: boolean
  /** A head near white, whose pile is drawn fainter so it does not grey. */
  pale: boolean
}

const mix = (a: string, b: string, t: number) => {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [x, y] = [rgb(a), rgb(b)]
  return "#" + x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, "0")).join("")
}

export function furTones(head: string): FurTones {
  const o = fromHex(head)
  const { hi, dark } = clayTones(head)
  const lit = (dl: number, c: number) => toHex({ l: Math.max(0.04, Math.min(0.985, o.l + dl)), c: o.c * c, h: o.h })
  const shade = lit(-0.11, 1)
  return {
    head, hi, shade,
    deep: lit(-0.24, 0.95),
    tip: lit(dark ? 0.2 : 0.11, 0.74),
    hair: mix(head, shade, FUR.hair.shade),
    dark,
    pale: o.l > 0.9,
  }
}

/** Which tones an animated face reads from custom properties, and under which names. */
const VARS = { head: "--mo-head", hi: "--mo-hi", shade: "--mo-shade", deep: "--mo-crease", tip: "--mo-tip", hair: "--mo-hair" } as const

type FurTone = keyof typeof VARS

/** The fur's colours as the custom properties an animated face reads them from. */
export const furVars = (head: string) => {
  const t = furTones(head)
  return { [VARS.hi]: t.hi, [VARS.shade]: t.shade, [VARS.deep]: t.deep, [VARS.tip]: t.tip, [VARS.hair]: t.hair }
}

/** What a face of this size wears. The web and the phone both read it, so they draw the same layers. */
export function furPlan(size?: number) {
  const small = size !== undefined && size <= FUR.small
  const mid = !small && size !== undefined && size <= FUR.mid
  return {
    small,
    /** The passes of the fringe, shortest first. */
    fringe: small ? FUR.fringeSmall : mid ? FUR.fringe.slice(0, 3) : FUR.fringe,
    /** Steps of the inner shade; none on a small face. */
    steps: small ? 0 : mid ? FUR.inner.stepsMid : FUR.inner.steps,
  }
}

/** The pile's opacity on this head. */
export const pileOpacity = (t: Pick<FurTones, "dark" | "pale">) =>
  t.dark ? FUR.pile.dark : t.pale ? FUR.pile.pale : FUR.pile.opacity

const r2 = (v: number) => Math.round(v * 100) / 100

/**
 * One fur finish, as the renderer asks for it. `tones` is what a still face is painted in;
 * absent, the face is animated and reads its colours from the custom properties. `flags`
 * are stated apart from the tones for that reason: they set opacities, which may not move
 * with an expression.
 */
export interface FurFinish {
  id: string
  size?: number
  tones?: FurTones
  flags: Pick<FurTones, "dark" | "pale">
}

/**
 * Paint properties as markup: attributes for a still face, one `style` for an animated
 * one, because an attribute cannot read a custom property.
 */
const ink = (props: ReadonlyArray<readonly [string, FurTone]>, t?: FurTones) =>
  t
    ? props.map(([k, tone]) => `${k}="${t[tone]}"`).join(" ")
    : `style="${props.map(([k, tone]) => `${k}:var(${VARS[tone]})`).join(";")}"`

/**
 * The fur around one head, as the places it goes.
 *
 * `shapes` is the head's parts, unfilled. `fringe` goes inside the head's group, ahead of
 * its parts, so the fill covers the inner half of every bristle. Each pass is a group
 * marked `data-fringe` that repeats the parts in their order, which is how the busy morph
 * finds them to reshape with the outline. `overlays` goes after the parts, and is groups
 * and rects only, so the group's last path is still the silhouette. `eye` gives the layers
 * of one eye, crease and lip as moved geometry rather than transforms, so a box measure of
 * a layer says where it is drawn.
 */
export function fur(finish: FurFinish, shapes: string) {
  const { id, tones: t } = finish
  const { small, fringe, steps } = furPlan(finish.size)
  const url = (k: string) => `url(#${id}${k})`
  const { light: L, rim: R, eye: E, inner: I } = FUR
  const box = (fill: string, extra = "") => `<rect width="100" height="100" ${fill}${extra}/>`
  const passes = fringe
    .slice()
    .reverse() // longest first, so the short dense hairs lie over the long loose ones
    .map(
      (f) =>
        `<g data-fringe="" fill="none" ${ink([["stroke", "hair"]], t)} stroke-width="${f.width}" stroke-dasharray="${f.dash.join(" ")}" stroke-opacity="${f.opacity}"` +
        `${f.comb ? ` transform="translate(${r2(FUR.comb.dx * f.comb)} ${r2(FUR.comb.dy * f.comb)})"` : ""}>${shapes}</g>`,
    )
    .join("")
  // The lit head through the clip moved by this share of the shade's offset. The rects are
  // moved back, so the light stays where it is and only the cut travels.
  const lit = (share: number, cover: number) =>
    `<g opacity="${r2(cover)}" transform="translate(${r2(I.dx * share)} ${r2(I.dy * share)})"><g clip-path="${url("k")}">` +
    `<g transform="translate(${r2(-I.dx * share)} ${r2(-I.dy * share)})">${box(ink([["fill", "head"]], t))}${box(`fill="${url("l")}"`)}</g></g></g>`
  const shade =
    box(ink([["fill", "deep"]], t), ` opacity="${I.opacity}"`) +
    Array.from({ length: steps }, (_, k) => lit((k + 1) / steps, 1 / (steps - k))).join("")
  const stop = (offset: number, tone: FurTone, opacity: number) =>
    `<stop offset="${offset}" ${ink([["stop-color", tone]], t)} stop-opacity="${opacity}"/>`
  const defs =
    `<defs><clipPath id="${id}k">${shapes}</clipPath>` +
    `<radialGradient id="${id}l" gradientUnits="userSpaceOnUse" cx="${L.cx}" cy="${L.cy}" r="${L.r}">` +
    stop(0, "hi", L.hi) + stop(L.from, "hi", 0) + stop(L.from, "shade", 0) + stop(1, "shade", L.lo) +
    `</radialGradient>` +
    (small
      ? ""
      : `<radialGradient id="${id}r" gradientUnits="userSpaceOnUse" cx="${R.cx}" cy="${R.cy}" r="${R.r}">` +
        stop(R.from, "tip", 0) + stop(1, "tip", R.opacity) +
        `</radialGradient>` +
        `<radialGradient id="${id}e" cx="0" cy="0" r="1" gradientTransform="translate(${E.sheen.cx} ${E.sheen.cy}) scale(${E.sheen.rx} ${E.sheen.ry})">` +
        `<stop offset="0" stop-color="white" stop-opacity="${E.sheen.opacity}"/><stop offset="1" stop-color="white" stop-opacity="0"/></radialGradient>`) +
    `</defs>`
  const overlays =
    `<g clip-path="${url("k")}">` +
    box(`fill="${url("l")}"`) +
    (small
      ? ""
      : shade +
        box(`fill="${url("r")}"`) +
        `<image href="${PILE}" width="100" height="100" preserveAspectRatio="none" opacity="${pileOpacity(finish.flags)}"/>`) +
    `</g>`
  /** One eye's layers in drawing order. `sheen` is whether its ink wears one. */
  const eye = (e: Superellipse, sheen: boolean) => {
    const d = superellipse(e)
    if (small) return [`<path d="${d}"/>`]
    const moved = (dx: number, dy: number) => superellipse({ ...e, cx: e.cx + dx, cy: e.cy + dy })
    const { crease: C, lip: P } = E
    return [
      `<path d="${moved(C.dx, C.dy)}" fill="none" ${ink([["stroke", "deep"]], t)} stroke-width="${C.width}" opacity="${C.opacity}"/>`,
      `<path d="${moved(P.dx, P.dy)}" ${ink([["fill", "tip"], ["stroke", "tip"]], t)} stroke-width="${P.width}" opacity="${P.opacity}"/>`,
      `<path d="${d}"/>`,
      ...(sheen ? [`<path d="${d}" fill="${url("e")}"/>`] : []),
    ]
  }
  return { defs, fringe: passes, overlays, eye }
}
