import { compose, faceFit, type Band } from "./compose";
import {
  boxy, capsule, cloud, clover, droplet, flower, ghost, heart, hexagon, nub, organic, round, star, sun, triangle,
} from "./shapes";

/**
 * The ten-shape vocabulary introduced by Blobatar 2.
 *
 * Weighted rather than uniform: round and organic are the everyday shapes,
 * while the louder silhouettes stay finds. These bands, the layout ranges in
 * `compose.ts`, and the tone set together form gen2's seed→look mapping.
 */
const BANDS: Band[] = [
  [round, 0.22], [organic, 0.48], [boxy, 0.6], [capsule, 0.7], [nub, 0.79],
  [cloud, 0.86], [droplet, 0.915], [hexagon, 0.95], [sun, 0.98], [triangle, 1],
];

/**
 * Manor's own silhouettes, outside the bands: no name comes out as one, so adding
 * them moved no face. They are drawn only when the `shape` option names them.
 */
const CHOSEN = [flower, clover, star, heart, ghost];

export const style = compose(BANDS, faceFit, CHOSEN);
