import MaskedView from '@react-native-masked-view/masked-view'
import { LinearGradient } from 'expo-linear-gradient'
import { useState, type ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'

import { Text } from '@/components/Text'
import { clampFade, colors, fonts, spacing } from '@/theme'

/** The fold's height and its fade for a cut of `lines`: the Mac's fade depth is 0.4 of the kept lines, at most 2.6. */
export function foldFor(lines: number, lineHeight: number) {
  const height = lines * lineHeight
  const fadeHeight = Math.min(2.6, lines * 0.4) * lineHeight
  const start = 1 - fadeHeight / height
  return { height, locations: clampFade.stops.map((stop) => start + stop * (1 - start)) as [number, number, ...number[]] }
}

/**
 * Content cut to `lines` of `lineHeight`, its last lines dissolving through a mask on the
 * content itself, as on the Mac. "Show more" and "Show less" appear only when the content
 * really runs past the cut, and sit on the faded tail rather than under it.
 */
export function FoldedBody({ lines, lineHeight, children }: { lines: number; lineHeight: number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [height, setHeight] = useState(0)
  const fold = foldFor(lines, lineHeight)
  const clipped = height > fold.height + 1
  const folded = clipped && !open
  // A still ScrollView reports its content's full height even while the viewport is
  // cut, which a View inside a maxHeight parent does not.
  const body = (
    <ScrollView
      scrollEnabled={false}
      style={open ? undefined : { maxHeight: fold.height }}
      onContentSizeChange={(_, contentHeight) => setHeight(contentHeight)}
    >
      {children}
    </ScrollView>
  )
  return (
    <View>
      {folded ? (
        <MaskedView
          maskElement={<LinearGradient colors={clampFade.colors} locations={fold.locations} style={StyleSheet.absoluteFill} />}
        >
          {body}
        </MaskedView>
      ) : body}
      {clipped ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          hitSlop={8}
          onPress={() => setOpen((current) => !current)}
          // The Mac's link target: the last 1.6 lines of the cut, text aligned to its foot.
          style={folded ? [styles.toggleOver, { height: 1.6 * lineHeight }] : styles.toggle}
        >
          <Text style={styles.toggleLabel}>{open ? 'Show less' : 'Show more'}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  toggle: { alignSelf: 'flex-end', marginTop: spacing.sm },
  toggleOver: { position: 'absolute', right: 0, bottom: 0, justifyContent: 'flex-end' },
  toggleLabel: { color: colors.text, fontFamily: fonts.sans, fontSize: 14, fontWeight: '500' },
})
