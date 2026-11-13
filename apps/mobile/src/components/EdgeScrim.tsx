import MaskedView from '@react-native-masked-view/masked-view'
import { BlurView } from 'expo-blur'
import { LinearGradient } from 'expo-linear-gradient'
import { Platform, StyleSheet, View } from 'react-native'

import { scrims, useScheme } from '@/theme'

interface EdgeScrimProps {
  edge: 'top' | 'bottom'
  height: number
}

/**
 * How far into the scrim each blur layer reaches, as a fraction of its height, and
 * how hard it blurs there. Three layers, each masked shorter and blurred harder than
 * the one under it, read as one blur that ramps from nothing at the transcript to
 * full at the screen edge; a single blur with a soft mask reads as a smear.
 */
const LAYERS: readonly { reach: number; intensity: number }[] = [
  { reach: 1, intensity: 18 },
  { reach: 0.66, intensity: 40 },
  { reach: 0.36, intensity: 70 },
]

/**
 * What sits behind the chat header and the composer: the page colour at the edge
 * fading to nothing over the transcript, with the transcript blurring progressively
 * as it slides under. Pointer-transparent, so the list under it still scrolls where
 * it shows through. Android has no progressive blur worth its frame budget, so it
 * gets the gradient alone.
 */
export function EdgeScrim({ edge, height }: EdgeScrimProps) {
  const scheme = useScheme()
  const stops = scrims[scheme]
  const top = edge === 'top'
  const start = top ? { x: 0.5, y: 0 } : { x: 0.5, y: 1 }
  const end = top ? { x: 0.5, y: 1 } : { x: 0.5, y: 0 }

  return (
    <View pointerEvents="none" style={[styles.host, top ? styles.top : styles.bottom, { height }]}>
      {Platform.OS === 'ios'
        ? LAYERS.map((layer) => (
            <MaskedView
              key={layer.reach}
              maskElement={
                <LinearGradient
                  colors={[stops.mask, stops.mask, stops.maskClear]}
                  end={end}
                  locations={[0, Math.max(0, layer.reach - 0.34), layer.reach]}
                  start={start}
                  style={StyleSheet.absoluteFill}
                />
              }
              style={StyleSheet.absoluteFill}
            >
              <BlurView intensity={layer.intensity} style={StyleSheet.absoluteFill} tint={stops.blurTint} />
            </MaskedView>
          ))
        : null}
      <LinearGradient
        colors={[stops.edge, stops.mid, stops.clear]}
        end={end}
        locations={[0, 0.42, 1]}
        start={start}
        style={StyleSheet.absoluteFill}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  host: { position: 'absolute', right: 0, left: 0 },
  top: { top: 0 },
  bottom: { bottom: 0 },
})
