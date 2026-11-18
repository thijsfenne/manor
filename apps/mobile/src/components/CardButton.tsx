import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { colors, fonts, glassTints, radius, spacing, useScheme } from '@/theme'
import { GlassPressable } from './GlassPressable'
import { Text } from './Text'
import { useGlassSettle } from './useGlassSettle'

export type CardButtonVariant = 'primary' | 'secondary' | 'quiet'

/**
 * Every button on a phone card (proposal, result, ask, permission, secret, mail and
 * Slack draft): a capsule 40pt high. `primary` is the card's one decision, on tinted
 * Liquid Glass; `secondary` is clear glass; `quiet` is text only. Where glass is
 * missing both fall back to the flat fills below. Pass `style` for layout (`flex`,
 * margins), never for looks.
 *
 * The glass is its own native view, so it must never sit inside a Pressable or under
 * a parent whose opacity animates: it renders flat there. Keep a card's button row
 * out of fading wrappers. See `useGlassSettle` for the one re-creation it gets.
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
  const scheme = useScheme()
  const settled = useGlassSettle(variant !== 'quiet')
  const face = <Text numberOfLines={1} style={[styles.label, LABELS[variant]]}>{label}</Text>

  if (variant === 'quiet') {
    return (
      <Pressable
        accessibilityRole="button"
        {...(accessibilityLabel === undefined ? {} : { accessibilityLabel })}
        {...(accessibilityHint === undefined ? {} : { accessibilityHint })}
        accessibilityState={{ disabled, busy }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [styles.base, styles.quiet, disabled && styles.disabled, pressed && styles.pressed, style]}
      >
        {face}
      </Pressable>
    )
  }

  const primary = variant === 'primary'
  return (
    <GlassPressable
      key={settled}
      {...(accessibilityHint === undefined ? {} : { accessibilityHint })}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      fallbackColor={primary ? colors.text : colors.chip}
      fallbackStyle={styles.flat}
      onPress={onPress}
      style={style}
      {...(primary ? { tintColor: glassTints.primary[scheme] } : {})}
    >
      <View style={styles.base}>{face}</View>
    </GlassPressable>
  )
}

const styles = StyleSheet.create({
  base: { minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radius.round, paddingHorizontal: 18 },
  label: { fontFamily: fonts.sans, fontSize: 14, fontWeight: '500' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
  quiet: { paddingHorizontal: spacing.sm + 2 },
  // The flat fallback keeps the earlier borderless fills.
  flat: { borderWidth: 0 },
})

const LABELS = StyleSheet.create({
  primary: { color: colors.onPrimary },
  secondary: { color: colors.text },
  quiet: { color: colors.muted },
})
