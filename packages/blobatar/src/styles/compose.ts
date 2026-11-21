/**
 * A Blobatar style composed from silhouette definitions.
 *
 * The band table chooses and weights silhouettes. Each silhouette owns its
 * geometry and safe face region; this module owns the shared body, eyes and SVG
 * serialization. The seam is private, so it can deepen when a future shape
 * proves the current definition insufficient without committing consumers to
 * its lifecycle.
 */
import type { Palette } from "../color";
import { superellipse } from "../shape";
import { CLAY, clay, clayTones, paint, sheenInk, type Finish } from "../shading";
import type { Traits } from "../traits";
import type { Body, Deco, Ellipse, Shape } from "./shapes";

export interface Eye {
  cx: number; cy: number; rx: number; ry: number; n: number; rot: number;
}

export type Fit = (t: Traits, b: Body, face: Ellipse) => Eye[];

/**
 * Fits the eye cluster against the silhouette's face region on both axes. The eyes
 * are soft upright ovals, a near-matched pair; the seed varies their size, spacing
 * and a slight lean, not their kind.
 */
export const faceFit: Fit = (t, b, face) => {
  const rx = b.rx;
  const er0 = t.num("eye.rx", 0.1, 0.125) * rx;
  const ratio = t.num("eye.ratio", 1.55, 1.85);
  const scale = t.num("eye.scale", 0.95, 1.05);
  const stretch = t.num("eye.stretch", 0.97, 1.03);
  const clearance = t.num("eye.gap", 0.08, 0.16) * rx;
  const wide = er0 * Math.max(1, scale);
  const tall = er0 * ratio * Math.max(1, scale * stretch);
  const gap0 = wide + rx * 0.03 + clearance;

  const gx = t.jitter("gaze.x", 0.09) * face.rx;
  const gaze = t.num("gaze.y", -0.2, 0.08) * face.ry;
  const dy = t.jitter("eye.dy", 0.04) * face.ry;
  const reach = Math.hypot(wide, tall);
  const across = (Math.abs(gx) + gap0 + reach) / face.rx;
  // About half the seeds carry their eyes higher, by up to 0.18 of the face; the
  // rest keep them where the gaze puts them. The lift spends only the headroom the
  // face has left, so a lifted pair never shrinks to fit.
  const lift = Math.max(0, t.num("eye.lift", -0.18, 0.18)) * face.ry;
  const room = face.ry * Math.sqrt(Math.max(0, 0.81 - across * across)) - Math.abs(dy) - reach;
  const gy = Math.min(gaze, Math.max(gaze - lift, -room));
  // Fitted from the unlifted gaze, so the lift never changes the eyes' size either way.
  const need = Math.hypot(across, (Math.abs(gaze) + Math.abs(dy) + reach) / face.ry);
  const fit = need > 0.9 ? 0.9 / need : 1;

  const er = er0 * fit;
  const eyeRy = er * ratio;
  const gap = gap0 * fit;
  const lean = t.num("eye.lean", -5, 5);
  const lean2 = Math.max(-6, Math.min(6, lean + t.jitter("eye.lean2", 1.5)));

  const cx = face.cx + gx * fit;
  const cy = face.cy + gy * fit;
  return [
    { cx: cx - gap, cy, rx: er, ry: eyeRy, n: t.num("eye.n", 2, 2.3), rot: lean },
    {
      cx: cx + gap, cy: cy + dy * fit,
      rx: er * scale, ry: eyeRy * scale * stretch,
      n: t.num("eye.n", 2, 2.3), rot: lean2,
    },
  ];
};

/**
 * The eyes at a small size: grown and spread by `CLAY.eyes`, as far as the face
 * region still holds them. Tried at the full amount and then at less, so a tight
 * face keeps the containment `faceFit` gave it.
 */
function optical(eyes: Eye[], face: Ellipse): Eye[] {
  const mid = (eyes[0]!.cx + eyes[1]!.cx) / 2;
  const held = (e: Eye) =>
    Math.hypot((Math.abs(e.cx - face.cx) + e.rx) / face.rx, (Math.abs(e.cy - face.cy) + e.ry) / face.ry) <= 1;
  for (const k of [1, 0.75, 0.5, 0.25]) {
    const grow = 1 + (CLAY.eyes.grow - 1) * k;
    const spread = 1 + (CLAY.eyes.spread - 1) * k;
    const grown = eyes.map(e => ({ ...e, cx: mid + (e.cx - mid) * spread, rx: e.rx * grow, ry: e.ry * grow }));
    if (grown.every(held)) return grown;
  }
  return eyes;
}

/** `[shape, upper edge of its band in [0, 1)]`, in order. */
export type Band = readonly [Shape, number];

export function compose(bands: Band[], fit: Fit) {
  const pick = (v: number) => (bands.find(([, upTo]) => v < upTo) ?? bands[bands.length - 1]!)[0];

  function layout(t: Traits) {
    const shape = pick(t("shape"));
    const r = t.num("body.r", 31, 38) * shape.core;
    const body: Body = {
      cx: 50 + t.jitter("body.x", 1.5),
      cy: 50 + t.jitter("body.y", 1.5),
      rx: r,
      ry: r * t.num("body.ratio", 0.92, 1.08),
      n: t.num("body.n", 1.9, 2.5),
      rot: 0,
      radii: Array.from({ length: t.int("body.pts", 6, 8) }, (_, i) => 1 + t.jitter(`body.r${i}`, 0.16)),
    };
    shape.body?.(t, body);

    // The body itself when the shape names no face, which is what a silhouette
    // convex around its own centre wants — and it already carries the four
    // fields a face is.
    const face = shape.face?.(body) ?? body;
    const deco: Deco = { petals: [], extra: [] };
    shape.decorate?.(t, body, deco);

    return {
      shape: shape.name,
      draw: shape.path,
      body, face,
      petals: deco.petals,
      extra: deco.extra,
      eyes: fit(t, body, face),
    };
  }

  function render(l: ReturnType<typeof layout>, p: Palette, mo?: boolean, finish?: Finish) {
    const r2 = (v: number) => Math.round(v * 100) / 100;
    // A still face is painted from the palette it wears. An animated one reads its
    // colours from the custom properties, and keeps only what may not move with them.
    const tones = finish && clayTones(p.head!);
    const look = finish && { ...finish, ...(mo ? { dark: tones!.dark } : { tones }) };
    const small = finish?.size !== undefined && finish.size <= CLAY.small;
    const eyes = look && small ? optical(l.eyes, l.face) : l.eyes;
    const outline = l.draw ? l.draw(l.body) : superellipse(l.body);
    const shapes =
      l.petals.map(d => `<circle cx="${r2(d.cx)}" cy="${r2(d.cy)}" r="${r2(d.r)}"/>`).join("") +
      l.extra.map(d => `<path d="${d}"/>`).join("") +
      `<path d="${outline}"/>`;
    const finished = look && clay(look, shapes);
    // The lip and the sheen ride inside the eye's own group, so they pose and travel
    // with it. There they are one child with the eye: the stylesheet blinks each child
    // of an eye about its own centre, and a layer blinking apart from its eye leaves a
    // sliver on a closed one.
    const lip = (e: Eye) =>
      look && !small
        ? `<path d="${superellipse({ ...e, cy: e.cy + CLAY.lip.dy })}" ${paint("fill", CLAY.lip.tone, look.tones)} opacity="${CLAY.lip.opacity}"/>`
        : "";
    const eye = (e: Eye, i: number) => {
      const d = superellipse(e);
      const sheen = finished?.sheen && p.eye && sheenInk(p.eye) ? `<path d="${d}" fill="${finished.sheen}"/>` : "";
      const layers = [lip(e), `<path d="${d}"/>`, sheen].filter(Boolean);
      const path = mo && layers.length > 1 ? `<g>${layers.join("")}</g>` : layers.join("");
      return mo
        ? `<g class="mo-eye" style="--mo-wrap:${i ? 1 : -1};--mo-lean:${r2(e.rot)};transform-origin:${r2(e.cx)}px ${r2(e.cy)}px">${path}</g>`
        : path;
    };
    const body =
      `<g fill="${p.head}">` +
      shapes +
      (finished?.overlays ?? "") +
      `</g>` +
      `<g fill="${p.eye}"${mo ? ` class="mo-eyes"` : ""}>` +
      eyes.map(eye).join("") +
      `</g>`;
    return {
      // Outside the breathe, the bob and a static pose, so the ids they reference stay put.
      defs: finished?.defs ?? "",
      body: mo ? `<g class="mo-breathe"><g class="mo-bob">${body}</g></g>` : body,
    };
  }

  return { layout, render, background: false as const };
}

/**
 * What a composed `layout` returns.
 *
 * `shape` is a `string` here rather than a union of names, because which names
 * are possible is a property of the band table and not of the composer. The
 * public `blob` entry narrows this to the package major's known vocabulary.
 */
export type Layout = ReturnType<ReturnType<typeof compose>["layout"]>;
