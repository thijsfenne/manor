import { withTiming, Easing, ReduceMotion } from 'react-native-reanimated'

/**
 * How a Liquid Glass surface arrives and leaves.
 *
 * Transform only, and that is the whole point: a `GlassView` that mounts inside a
 * layer whose opacity is being animated renders as a flat panel and stays flat for
 * as long as it is on screen. Anything below 1 forces the view offscreen to
 * composite, and the glass has nothing left to sample from the transcript behind it.
 * A translate and a scale move the layer without ever taking it off full opacity, so
 * the material survives the entrance.
 *
 * The same trap in a different disguise as the one `EditsPill` documents: a plain
 * view between the glass and what it samples flattens it too. Fading is that view.
 */
export function glassRise() {
  'worklet'
  return {
    initialValues: { transform: [{ translateY: 10 }, { scale: 0.96 }] },
    animations: {
      transform: [
        { translateY: withTiming(0, { duration: 200, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System }) },
        { scale: withTiming(1, { duration: 200, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System }) },
      ],
    },
  }
}

/** The way back out, quicker than the way in, as a dismissal should be. */
export function glassSink() {
  'worklet'
  return {
    initialValues: { transform: [{ translateY: 0 }, { scale: 1 }] },
    animations: {
      transform: [
        { translateY: withTiming(8, { duration: 120, easing: Easing.in(Easing.cubic), reduceMotion: ReduceMotion.System }) },
        { scale: withTiming(0.96, { duration: 120, easing: Easing.in(Easing.cubic), reduceMotion: ReduceMotion.System }) },
      ],
    },
  }
}
