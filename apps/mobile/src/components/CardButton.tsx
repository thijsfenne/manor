import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native'
import { colors, fonts, radius, spacing } from '@/theme'
import { Text } from './Text'

export type CardButtonVariant = 'primary' | 'secondary' | 'quiet'

/**
 * Every button on a phone card (proposal, result, ask, permission, secret, mail and
 * Slack draft): a capsule 40pt high. `primary` is the card's one decision, filled;
 * `secondary` sits on a sheer fill that reads on a flat card and on glass alike;
 * `quiet` is text only. Pass `style` for layout (`flex`, margins), never for looks.
 */
export function CardButton({
  label,
  variant = 'secondary',
  disabled = false,
  busy = false,
  accessibilityLabel,
  accessibilityHint,
  style,
  onPress,
}: {
  label: string
  variant?: CardButtonVariant
  disabled?: boolean
  /** Work is underway; VoiceOver hears it, the label says what. */
  busy?: boolean
  accessibilityLabel?: string
  accessibilityHint?: string
  style?: StyleProp<ViewStyle>
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      {...(accessibilityLabel === undefined ? {} : { accessibilityLabel })}
      {...(accessibilityHint === undefined ? {} : { accessibilityHint })}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.base, FILLS[variant], disabled && styles.disabled, pressed && styles.pressed, style]}
    >
      <Text numberOfLines={1} style={[styles.label, LABELS[variant]]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  base: { minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radius.round, paddingHorizontal: 18 },
  label: { fontFamily: fonts.sans, fontSize: 14, fontWeight: '500' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
})

const FILLS = StyleSheet.create({
  primary: { backgroundColor: colors.text },
  secondary: { backgroundColor: colors.chip },
  quiet: { backgroundColor: 'transparent', paddingHorizontal: spacing.sm + 2 },
})

const LABELS = StyleSheet.create({
  primary: { color: colors.onPrimary },
  secondary: { color: colors.text },
  quiet: { color: colors.muted },
})
