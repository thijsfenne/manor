import MaskedView from '@react-native-masked-view/masked-view'
import { BlurView } from 'expo-blur'
import { LinearGradient } from 'expo-linear-gradient'
import { createContext, useContext } from 'react'
import { FlatList, Platform, ScrollView, StyleSheet, View, type FlatListProps, type ScrollViewProps, type StyleProp, type ViewStyle } from 'react-native'

import { scrims, sheetScrims, useScheme } from '@/theme'

interface EdgeScrimProps {
  edge: 'top' | 'bottom'
  height: number
  /** The colour it fades from: the page, or a page sheet's own surface. */
  surface?: 'page' | 'sheet'
}

/** How far a scrim reaches past the header or bar it sits behind, so the fade ends in open content. */
export const SCRIM_REACH = 28

/**
 * Where the header and bar drawn over a screen end. `SectionScaffold` and `Sheet` pad
 * their content by these, so whatever they hold starts below the header and ends
 * above the bar; a scroll view reaches back under both with `useScrimScroll`, or is a
 * `ScrimScrollView` or `ScrimFlatList`. Zero anywhere else, so a shared list reads it
 * wherever it is placed.
 */
export interface ScrimInsets {
  top: number
  bottom: number
}

export const ScrimInsetsContext = createContext<ScrimInsets>({ top: 0, bottom: 0 })

const firstNumber = (...values: unknown[]) => values.find((value): value is number => typeof value === 'number') ?? 0

/**
 * The props that let a scroll view run under the header and bar: it reaches through
 * the frame's padding to both edges and pads its content by as much again, on top of
 * its own padding, so its ends rest clear and its rows slide under the scrims.
 */
export function useScrimScroll(contentContainerStyle?: StyleProp<ViewStyle>) {
  const { top, bottom } = useContext(ScrimInsetsContext)
  const own = StyleSheet.flatten(contentContainerStyle) ?? {}
  return {
    style: { marginTop: -top, marginBottom: -bottom },
    contentContainerStyle: [own, {
      paddingTop: top + firstNumber(own.paddingTop, own.paddingVertical, own.padding),
      paddingBottom: bottom + firstNumber(own.paddingBottom, own.paddingVertical, own.padding),
    }],
    scrollIndicatorInsets: { top, bottom },
  }
}

/** A `ScrollView` that runs under the header and bar; reads the insets itself, so it works placed straight inside a `Sheet`. */
export function ScrimScrollView({ contentContainerStyle, style, ...props }: Omit<ScrollViewProps, 'scrollIndicatorInsets'>) {
  const scroll = useScrimScroll(contentContainerStyle)
  return <ScrollView {...props} contentContainerStyle={scroll.contentContainerStyle} scrollIndicatorInsets={scroll.scrollIndicatorInsets} style={[style, scroll.style]} />
}

/** A `FlatList` that runs under the header and bar, as `ScrimScrollView` does. */
export function ScrimFlatList<T>({ contentContainerStyle, style, ...props }: Omit<FlatListProps<T>, 'scrollIndicatorInsets'>) {
  const scroll = useScrimScroll(contentContainerStyle)
  return <FlatList {...props} contentContainerStyle={scroll.contentContainerStyle} scrollIndicatorInsets={scroll.scrollIndicatorInsets} style={[style, scroll.style]} />
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
 * What sits behind every header, tab bar and composer: the page colour at the edge
 * fading to nothing over the content, with the content blurring progressively
 * as it slides under. Pointer-transparent, so the list under it still scrolls where
 * it shows through. Android has no progressive blur worth its frame budget, so it
 * gets the gradient alone.
 */
export function EdgeScrim({ edge, height, surface = 'page' }: EdgeScrimProps) {
  const scheme = useScheme()
  const stops = scrims[scheme]
  const tone = surface === 'sheet' ? sheetScrims[scheme] : stops
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
        colors={[tone.edge, tone.mid, tone.clear]}
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
