import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react-native'
import { StyleSheet, View, type AccessibilityState } from 'react-native'

import { GlassPressable } from '@/components/GlassPressable'
import { colors } from '@/theme'

interface GlassIconButtonProps {
  accessibilityLabel: string
  accessibilityState?: AccessibilityState
  icon: IconSvgElement
  onPress: () => void
  /** Header controls are 44pt. Floating transcript actions use the compact 36pt size. */
  size?: 36 | 44
  iconSize?: number
}

/** One Liquid Glass icon control for headers, sheets and compact floating actions. */
export function GlassIconButton({
  accessibilityLabel,
  accessibilityState,
  icon,
  onPress,
  size = 44,
  iconSize,
}: GlassIconButtonProps) {
  const resolvedIconSize = iconSize ?? (size === 36 ? 20 : 22)
  return (
    <GlassPressable
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      fill
      hitSlop={6}
      onPress={onPress}
      radius={size / 2}
      style={{ width: size, height: size }}
    >
      <View style={styles.content}>
        <HugeiconsIcon color={colors.text} icon={icon} size={resolvedIconSize} strokeWidth={1.8} />
      </View>
    </GlassPressable>
  )
}

const styles = StyleSheet.create({
  content: { flex: 1, alignItems: 'center', justifyContent: 'center' },
})
