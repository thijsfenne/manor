import { useState, type ReactNode } from 'react'
import { StyleSheet, TouchableWithoutFeedback, View, type AccessibilityRole, type AccessibilityState, type ColorValue, type StyleProp, type ViewStyle } from 'react-native'

import { GlassSurface, LIQUID_GLASS_AVAILABLE } from '@/components/GlassSurface'

interface GlassPressableProps {
  accessibilityLabel: string
  accessibilityRole?: AccessibilityRole
  accessibilityState?: AccessibilityState
  children: ReactNode
  disabled?: boolean
  /**
   * Cover a surface that was given a size, so the whole of it takes the touch. Omit
   * for a pill, which is as wide as what it says. Stated as a percentage on purpose:
   * `flex: 1` here carries a zero basis, which leaves the surface no content to
   * measure, and a control that reports no height gets whatever its parent has left.
   */
  fill?: boolean
  fallbackColor?: ColorValue
  fallbackStyle?: StyleProp<ViewStyle>
  hitSlop?: number
  onPress: () => void
  radius?: number
  style?: StyleProp<ViewStyle>
  tintColor?: string
}

/** A native interactive glass surface with one shared touch and fallback treatment. */
export function GlassPressable({
  accessibilityLabel,
  accessibilityRole = 'button',
  accessibilityState,
  children,
  disabled = false,
  fill = false,
  fallbackColor,
  fallbackStyle,
  hitSlop,
  onPress,
  radius = 999,
  style,
  tintColor,
}: GlassPressableProps) {
  const [pressed, setPressed] = useState(false)

  return (
    // TouchableWithoutFeedback adds Pressability to its one child without adding
    // a native wrapper. GlassSurface forwards those responder/accessibility props
    // to GlassView, so SDK 57's interactive material owns the hold and morph.
    <TouchableWithoutFeedback
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      accessibilityState={accessibilityState}
      disabled={disabled}
      hitSlop={hitSlop}
      onPress={onPress}
      {...(LIQUID_GLASS_AVAILABLE ? {} : {
        onPressIn: () => setPressed(true),
        onPressOut: () => setPressed(false),
      })}
    >
      <GlassSurface
        {...(fallbackColor === undefined ? {} : { fallbackColor })}
        {...(fallbackStyle === undefined ? {} : { fallbackStyle })}
        interactive={!disabled}
        radius={radius}
        style={[style, !LIQUID_GLASS_AVAILABLE && pressed && styles.pressed]}
        {...(tintColor === undefined ? {} : { tintColor })}
      >
        {/*
          Decorative: the hit target is the surface itself, so nothing here competes
          with it. Being unavailable dims what the control says and never the material
          it is made of, which fades to nothing under an opacity.
        */}
        <View pointerEvents="none" style={[fill && styles.fill, disabled && styles.disabled]}>{children}</View>
      </GlassSurface>
    </TouchableWithoutFeedback>
  )
}

const styles = StyleSheet.create({
  fill: { width: '100%', height: '100%' },
  pressed: { opacity: 0.64 },
  disabled: { opacity: 0.4 },
})
