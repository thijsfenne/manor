import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'

import { Text } from '@/components/Text'
import { colors, fonts, squircle } from '@/theme'

/**
 * A read-only chip on something else: when a helper started, what it runs on, the branch
 * an isolated Session works on. `mark` is its icon or brand mark; the Mac's `ui/Badge`
 * is the same chip.
 */
export function Badge({ mark, children }: { mark?: ReactNode; children: string }) {
  return (
    <View style={styles.badge}>
      {mark}
      <Text numberOfLines={1} style={styles.text}>{children}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%', borderRadius: 5, ...squircle, backgroundColor: colors.fill, paddingHorizontal: 7, paddingVertical: 3 },
  text: { flexShrink: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
})
