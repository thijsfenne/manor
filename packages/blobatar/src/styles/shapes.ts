/**
 * The private silhouette vocabulary.
 *
 * A shape is everything the layout needs to draw one silhouette and nothing
 * about when to draw it: how much of the frame its core body takes, how it
 * patches that body, what room it leaves the eyes, what it decorates with, and
 * which path primitive traces it. What it deliberately does *not* carry is its
 * threshold — how often it comes up is a property of the package major's band
 * table, not of the silhouette itself. See `blob.ts`.
 *
 * Shapes that are parameterizations of another share its implementation rather
 * than restating it: `boxy` is `round` with a squarer `n` and a tilt, `hexagon`
 * is `triangle` with six sides, `cloud` is `organic` with lobes. They share it
 * by naming the same function (`path: spline`), never by spreading the parent
 * value — `{ ...round, core: 0.86 }` reads better and defeats tree-shaking
 * completely, measured at ~920 B for a single shape. See ADR-0007.
 *
 * The first ten are Blobatar 2's silhouettes, which a name can come out as. The
 * five after them are Manor's own and only ever chosen by name; see `blob.ts`.
 */
import { blobPath, polygon, stadium, superellipse, taper } from "../shape";
import type { Traits } from "../traits";

const r2 = (v: number) => Math.round(v * 100) / 100;

export interface Body {
  cx: number; cy: number; rx: number; ry: number;
  n: number; rot: number; radii: number[];
  /** Polygon-only, set by the shapes that draw one. */
  sides?: number; round?: number;
}
export interface Ellipse { cx: number; cy: number; rx: number; ry: number }
export interface Deco {
  petals: { cx: number; cy: number; r: number }[];
  /** Extra outlines unioned with the core body, already traced. */
  extra: string[];
}

export interface Shape {
  name: string;
  /** How much of the frame the core body takes. */
  core: number;
  /** Patches the body before the face is measured. */
  body?(t: Traits, b: Body): void;
  /**
   * The region the eyes must fit inside. Omitted, it is the body itself —
   * which is what every silhouette that is convex around its own centre wants,
   * and half the roster is.
   */
  face?(b: Body): Ellipse;
  decorate?(t: Traits, b: Body, out: Deco): void;
  /**
   * The core path. Omitted, `superellipse` — free to default to, because the
   * eyes are superellipses too, so it is in every bundle already. It must hold
   * the eyes: a working face clips its moving eyes to this path alone.
   */
  path?(b: Body): string;
}

// ---------------------------------------------------------------------------
// The shared implementations.

const poly = (b: Body) => polygon(b as Body & { sides: number; round: number });
const spline = (b: Body) => blobPath(b.cx, b.cy, b.rx, b.ry, b.radii, b.rot);

const shrunk = (k: number) => (b: Body): Ellipse => ({
  cx: b.cx, cy: b.cy, rx: b.rx * k, ry: b.ry * k,
});
const splineFace = (b: Body): Ellipse => shrunk(Math.min(...b.radii) * 0.95)(b);
const polyFace = (b: Body): Ellipse => shrunk(0.84)(b);
const pill = (b: Body) => stadium(b.cx, b.cy, b.rx, b.ry);

// ---------------------------------------------------------------------------

export const round: Shape = { name: "round", core: 1 };

export const organic: Shape = {
  name: "organic", core: 0.98, path: spline, face: splineFace,
};

/** `round`, squared off and tilted. Same path, different parameters. */
export const boxy: Shape = {
  name: "boxy", core: 0.86,
  body: (t, b) => {
    b.n = t.num("body.n", 3.4, 6);
    b.rot = t.num("body.rot", -20, 20);
  },
};

export const capsule: Shape = {
  name: "capsule", core: 1.02,
  body: (t, b) => { b.ry *= t.num("capsule.squat", 0.55, 0.68); },
  face: shrunk(0.94),
  path: pill,
};

export const nub: Shape = {
  name: "nub", core: 0.88,
  decorate: (t, b, out) => {
    const count = t.int("nub.n", 1, 2);
    for (let i = 0; i < count; i++) {
      const a = t.num(`nub.a${i}`, 0, 2 * Math.PI);
      out.petals.push({
        cx: b.cx + Math.cos(a) * b.rx * 0.88,
        cy: b.cy + Math.sin(a) * b.rx * 0.88,
        r: b.rx * t.num(`nub.r${i}`, 0.24, 0.4),
      });
    }
  },
};

/**
 * A flat-bottomed pill with three puffs on top, the eyes sitting low in the middle
 * of it. Manor's own drawing: the library's lobed blob read as a lump.
 */
export const cloud: Shape = {
  name: "cloud", core: 0.8,
  body: (_t, b) => { b.ry *= 0.66; b.cy += b.ry * 0.3; },
  face: b => ({ cx: b.cx, cy: b.cy - b.ry * 0.2, rx: b.rx * 0.7, ry: b.ry * 0.7 }),
  decorate: (_t, b, out) => {
    out.petals.push(
      { cx: b.cx - b.rx * 0.45, cy: b.cy - b.ry * 0.55, r: b.rx * 0.45 },
      { cx: b.cx + b.rx * 0.12, cy: b.cy - b.ry * 0.95, r: b.rx * 0.58 },
      { cx: b.cx + b.rx * 0.62, cy: b.cy - b.ry * 0.35, r: b.rx * 0.4 },
    );
  },
  path: pill,
};

export const droplet: Shape = {
  name: "droplet", core: 0.78,
  // Shifted down by what the taper adds above, so the whole silhouette — head
  // and point together — sits centred in the frame rather than the head alone.
  // `n` is pinned to a true ellipse, which is the curve the taper is tangent to.
  body: (_t, b) => { b.cy += 0.22 * b.ry; b.n = 2; },
  face: b => ({ cx: b.cx, cy: b.cy + b.ry * 0.05, rx: b.rx * 0.88, ry: b.ry * 0.88 }),
  decorate: (t, b, out) => {
    out.extra.push(taper(b.cx, b.cy, b.rx, b.ry, t.num("droplet.tip", 1.4, 1.65)));
  },
};

export const hexagon: Shape = {
  name: "hexagon", core: 1.05, path: poly, face: polyFace,
  body: (t, b) => {
    b.sides = 6;
    b.rot = t.num("body.rot", -12, 12);
    b.round = t.num("poly.round", 0.24, 0.5);
  },
};

export const sun: Shape = {
  name: "sun", core: 0.7,
  decorate: (t, b, out) => {
    const count = t.int("sun.n", 6, 9);
    const dist = b.rx * t.num("sun.dist", 1.0, 1.08);
    const pr = b.rx * t.num("sun.r", 0.2, 0.26);
    const off = t.num("sun.rot", 0, 2 * Math.PI);
    for (let i = 0; i < count; i++) {
      const a = off + (2 * Math.PI * i) / count;
      out.petals.push({ cx: b.cx + Math.cos(a) * dist, cy: b.cy + Math.sin(a) * dist, r: pr });
    }
  },
};

/** `hexagon` with three sides, and a tighter tilt so it rests on its base. */
export const triangle: Shape = {
  name: "triangle", core: 1.15, path: poly,
  body: (t, b) => {
    b.sides = 3;
    b.rot = t.num("body.rot", -5, 5);
    b.round = t.num("poly.round", 0.24, 0.5);
  },
  face: b => ({ cx: b.cx, cy: b.cy + b.ry * 0.1, rx: b.rx * 0.54, ry: b.ry * 0.36 }),
};

// ---------------------------------------------------------------------------
// Manor's own, reached only by name. Every path is absolute M, L, C, Q, H and V,
// closed with Z: the commands the phone and the gesture fit read back out of the markup.

/**
 * `count` round lobes about a smaller core, drawn at `k` of the body. The eyes are
 * sized from the body and then fitted into `face`, so a small face shrinks them.
 * The face sits inside the core, which is what a working face clips its eyes to.
 */
const lobed = (name: string, count: number, k: number, dist: number, r: number, face: number): Shape => ({
  name, core: 1, face: shrunk(face),
  path: b => superellipse({ ...b, rx: b.rx * k, ry: b.ry * k, n: 2 }),
  decorate: (_t, b, out) => {
    for (let i = 0; i < count; i++) {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / count;
      out.petals.push({ cx: b.cx + Math.cos(a) * b.rx * dist, cy: b.cy + Math.sin(a) * b.rx * dist, r: b.rx * r });
    }
  },
});

/** Five round petals, one pointing up. */
export const flower: Shape = lobed("flower", 5, 0.6, 0.59, 0.36, 0.6);

/** Six shallow puffs, a scalloped round. */
export const clover: Shape = lobed("clover", 6, 0.76, 0.51, 0.42, 0.75);

/** A soft five-pointed star: the spline through alternating long and short radii. */
export const star: Shape = {
  name: "star", core: 1.08, face: shrunk(0.5),
  path: b => blobPath(b.cx, b.cy, b.rx, b.ry, [1, 0.66, 1, 0.66, 1, 0.66, 1, 0.66, 1, 0.66], -90),
};

export const heart: Shape = {
  name: "heart", core: 1,
  face: b => ({ cx: b.cx, cy: b.cy - b.ry * 0.12, rx: b.rx * 0.62, ry: b.ry * 0.5 }),
  path: ({ cx: x, cy: y, rx: w, ry: h }) => {
    const p = (dx: number, dy: number) => `${r2(x + w * dx)} ${r2(y + h * dy)}`;
    return `M${p(0, 0.95)}C${p(-0.35, 0.7)} ${p(-1.05, 0.25)} ${p(-1, -0.3)}` +
      `C${p(-0.95, -0.85)} ${p(-0.25, -1)} ${p(0, -0.5)}` +
      `C${p(0.25, -1)} ${p(0.95, -0.85)} ${p(1, -0.3)}` +
      `C${p(1.05, 0.25)} ${p(0.35, 0.7)} ${p(0, 0.95)}Z`;
  },
};

/** A dome over straight sides and a hem of three scallops. */
export const ghost: Shape = {
  name: "ghost", core: 0.9,
  face: b => ({ cx: b.cx, cy: b.cy - b.ry * 0.15, rx: b.rx * 0.7, ry: b.ry * 0.55 }),
  path: b => {
    const w = b.rx * 0.88, top = b.cy - b.ry * 0.1, hem = b.cy + b.ry * 0.85, wave = b.ry * 0.28;
    const k = 0.5523 * w;
    const [l, r] = [b.cx - w, b.cx + w];
    let d = `M${r2(l)} ${r2(hem)}V${r2(top)}` +
      `C${r2(l)} ${r2(top - k)} ${r2(b.cx - k)} ${r2(top - w)} ${r2(b.cx)} ${r2(top - w)}` +
      `C${r2(b.cx + k)} ${r2(top - w)} ${r2(r)} ${r2(top - k)} ${r2(r)} ${r2(top)}V${r2(hem)}`;
    const step = (2 * w) / 3;
    for (let i = 0; i < 3; i++) {
      const at = r - i * step;
      d += `Q${r2(at - step / 4)} ${r2(hem - wave)} ${r2(at - step / 2)} ${r2(hem)}` +
        `Q${r2(at - (3 * step) / 4)} ${r2(hem + wave)} ${r2(at - step)} ${r2(hem)}`;
    }
    return d + "Z";
  },
};
