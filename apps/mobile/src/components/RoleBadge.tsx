import { StyleSheet, View } from 'react-native'

import { Text } from '@/components/Text'
import { colors, fonts, squircle } from '@/theme'

/**
 * What someone is, beside her name. The Direct messages list and a DM's own header
 * ask the same question of the same persona, so the chip they answer it with lives
 * once; the Mac keeps its own `ui/RoleBadge` for the same reason. A group wears it
 * too, because in a list of people "Group" is what that row is.
 */
export function RoleBadge({ label }: { label: string }) {
  return (
    <View style={styles.badge}>
      <Text numberOfLines={1} style={styles.text}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: { flexShrink: 1, borderRadius: 5, ...squircle, backgroundColor: colors.fill, paddingHorizontal: 7, paddingVertical: 2 },
  text: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
})
