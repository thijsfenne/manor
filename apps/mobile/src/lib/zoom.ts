/**
 * Geometry for a picture zoomed inside a full-screen frame. Offsets are measured from
 * the frame's centre, the origin a centred `scale` transform turns around, so a
 * translation of 0 at scale 1 is the picture fitted and centred.
 */

export const MAX_ZOOM = 5
export const DOUBLE_TAP_ZOOM = 2
/** A pinch may go a little under fit while the fingers are down; letting go snaps back. */
export const MIN_PINCH = 0.75

export function clamp(value: number, min: number, max: number) {
  'worklet'
  return Math.min(max, Math.max(min, value))
}

/** The size a picture of this width:height `aspect` takes when fitted whole in the frame. */
export function fittedSize(frameWidth: number, frameHeight: number, aspect: number | null) {
  if (aspect === null || !(aspect > 0) || !(frameHeight > 0)) return { width: frameWidth, height: frameHeight }
  return frameWidth / frameHeight > aspect
    ? { width: frameHeight * aspect, height: frameHeight }
    : { width: frameWidth, height: frameWidth / aspect }
}

/** How far the picture may move along one axis before its edge comes off the frame's edge. */
export function panLimit(frame: number, content: number, scale: number) {
  'worklet'
  return Math.max(0, (content * scale - frame) / 2)
}

export function clampPan(offset: number, frame: number, content: number, scale: number) {
  'worklet'
  const limit = panLimit(frame, content, scale)
  return clamp(offset, -limit, limit)
}

/**
 * The offset that keeps the point first under `startFocal` under `focal` while the
 * scale moves from `startScale` to `scale`: a pinch zooms around the fingers and
 * follows them as they move.
 */
export function zoomAround(focal: number, startFocal: number, startOffset: number, startScale: number, scale: number) {
  'worklet'
  return focal - ((startFocal - startOffset) * scale) / startScale
}
