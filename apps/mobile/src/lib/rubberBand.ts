/**
 * Where a dragged value lands when it is pulled past `min` or `max`: it moves only
 * `resistance` of the distance beyond the edge, so the edge gives a little under the
 * finger instead of stopping dead. Inside the range it follows the finger 1:1. Letting
 * go is the caller's to settle, usually a spring back to the edge.
 */
export function rubberBand(value: number, min: number, max: number, resistance: number) {
  'worklet'
  if (value > max) return max + (value - max) * resistance
  if (value < min) return min + (value - min) * resistance
  return value
}
