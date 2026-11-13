import { Idea01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { StyleSheet, View } from 'react-native'

import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

/**
 * The Mac's empty room: a dashed outline around what is missing and where it gets
 * added. The phone adds nothing itself, so the body names the place on the Mac.
 * `idea` puts the Suggestions lightbulb on top, as the Mac does there.
 */
export function EmptyCard({ title, body, idea = false }: { title: string; body: string; idea?: boolean }) {
  return (
    <View style={styles.card}>
      {idea ? (
        <View style={styles.icon}><HugeiconsIcon color={colors.skill} icon={Idea01Icon} size={18} strokeWidth={1.7} /></View>
      ) : null}
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    gap: 6,
    borderRadius: radius.md,
    ...squircle,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.line,
    paddingHorizontal: spacing.xl,
    paddingVertical: 40,
  },
  icon: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, ...squircle, backgroundColor: colors.surface, marginBottom: 6 },
  title: { color: colors.text, fontFamily: fonts.sans, fontSize: 16, fontWeight: '500', textAlign: 'center' },
  body: { maxWidth: 300, color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, textAlign: 'center' },
})
