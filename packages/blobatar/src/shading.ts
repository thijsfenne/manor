/**
 * Manor's clay finish: the head modelled with light from the top left, a soft
 * shadow inside its bottom-right edge, a matte highlight, and a contact shadow
 * on the ground below it.
 *
 * Opt-in through `shading: "clay"`, so the frozen default output stays exactly
 * what it was. Every layer is a neutral black or white overlay rather than a mix
 * of the head colour. Mixing a colour toward white or black by `k` is the same
 * as laying white or black over it at opacity `k`, so the overlays reproduce the
 * colour-mixed look while the head keeps its one flat fill. That is what lets a
 * tinting expression keep working: `--mo-head` changes the head's fill, and the
 * shading over it follows for free.
 *
 * The numbers live here once. The string renderer below serializes them for the
 * web, and the phone draws the same values with react-native-svg.
 */

/** A gradient stop: offset, opacity, and white or (absent) black. */
export type Stop = readonly [offset: number, opacity: number, white?: true]

/** A radial gradient in user space, stretched to an ellipse when `rx` and `ry` differ. */
export interface Glow {
  cx: number
  cy: number
  rx: number
  ry: number
  stops: readonly Stop[]
}

export const CLAY = {
  /**
   * The light across the head: white at the top left fading out by 0.75 of the
   * radius, then black toward the far edge. Two stops share 0.75 so the colour
   * switches where both are transparent.
   */
  light: {
    cx: 40, cy: 35, rx: 62, ry: 62,
    stops: [[0, 0.12, true], [0.75, 0, true], [0.75, 0], [1, 0.18]],
  } satisfies Glow,
  /** The matte highlight, a soft white ellipse that the head's outline clips. */
  highlight: {
    cx: 36, cy: 28, rx: 19, ry: 12,
    stops: [[0, 0.22, true], [0.45, 0.19, true], [1, 0, true]],
  } satisfies Glow,
  /**
   * The contact shadow. It sits `gap` below the head's lowest point, so a face
   * drawn high keeps its shadow close, and never lower than `cy`, which keeps it
   * inside the viewBox so a tight slot never clips it. See `groundY`.
   */
  contact: {
    cx: 50, cy: 92, rx: 33, ry: 6.5, gap: 3,
    stops: [[0, 0.26], [0.5, 0.15], [1, 0]],
  } satisfies Glow & { gap: number },
  /**
   * The inner shadow: the silhouette, blurred by `blur` and moved by `dx`/`dy`
   * toward the light, cut out of itself. What is left is a soft band along the
   * bottom-right edge, painted black at `opacity`.
   */
  inner: { blur: 4, dx: -3, dy: -4, opacity: 0.25 },
} as const

const r2 = (v: number) => Math.round(v * 100) / 100

const stop = ([offset, opacity, white]: Stop) =>
  `<stop offset="${offset}"${white ? ` stop-color="#fff"` : ""} stop-opacity="${opacity}"/>`

/** A user-space radial gradient; the stretch rides on its transform so it stays elliptical. */
const glow = (id: string, g: Glow) =>
  `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(${g.cx} ${r2(g.cy)}) scale(${g.rx} ${g.ry})">${g.stops.map(stop).join("")}</radialGradient>`

/**
 * Where the contact shadow centres for a head drawn from these paths and circles.
 * Curve control points count as drawn, which can only place it a touch lower.
 */
export function groundY(paths: readonly string[], circles: readonly { cy: number; r: number }[]) {
  let lowest = -Infinity
  for (const c of circles) lowest = Math.max(lowest, c.cy + c.r)
  for (const d of paths) {
    for (const [, command, args = ""] of d.matchAll(/([MLCQHVZ])([^MLCQHVZ]*)/g)) {
      const values = args.trim().split(/[\s,]+/).filter(Boolean).map(Number)
      if (command === "V") for (const y of values) lowest = Math.max(lowest, y)
      else if (command !== "H") for (let i = 1; i < values.length; i += 2) lowest = Math.max(lowest, values[i]!)
    }
  }
  const { cy, gap } = CLAY.contact
  return lowest === -Infinity ? cy : Math.min(cy, lowest + gap)
}

/** The whole viewBox; the head's clip trims it to the silhouette. */
const box = (fill = "") => `<rect width="100" height="100"${fill && ` fill="${fill}"`}/>`

/**
 * The clay finish around one head, as the three places it goes.
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
 */
export function clay(id: string, shapes: string, ground: number) {
  const contact = { ...CLAY.contact, cy: ground }
  const { inner: s } = CLAY
  // Filtered as a group, so `SourceAlpha` is the clipped silhouette, not the rect.
  const shadow =
    `<filter id="${id}i" x="-20%" y="-20%" width="140%" height="140%">` +
    `<feGaussianBlur in="SourceAlpha" stdDeviation="${s.blur}"/>` +
    `<feOffset dx="${s.dx}" dy="${s.dy}"/>` +
    `<feComposite in2="SourceAlpha" operator="arithmetic" k2="-1" k3="1" result="s"/>` +
    `<feFlood flood-opacity="${s.opacity}"/>` +
    `<feComposite in2="s" operator="in"/>` +
    `</filter>`
  return {
    defs:
      `<defs><clipPath id="${id}k">${shapes}</clipPath>` +
      glow(`${id}l`, CLAY.light) +
      glow(`${id}h`, CLAY.highlight) +
      glow(`${id}c`, contact) +
      shadow +
      `</defs>`,
    contact: `<ellipse cx="${contact.cx}" cy="${r2(contact.cy)}" rx="${contact.rx}" ry="${contact.ry}" fill="url(#${id}c)"/>`,
    overlays:
      `<g filter="url(#${id}i)"><g clip-path="url(#${id}k)">${box()}</g></g>` +
      `<g clip-path="url(#${id}k)">${box(`url(#${id}l)`)}${box(`url(#${id}h)`)}</g>`,
  }
}
