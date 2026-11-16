import { GlassContainer, GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable, type GlassColorScheme, type GlassContainerProps, type GlassStyle } from 'expo-glass-effect'
import type { ReactNode } from 'react'
import { Platform, StyleSheet, View, type ColorValue, type StyleProp, type ViewProps, type ViewStyle } from 'react-native'

import { colors, squircle, useScheme } from '@/theme'

let nativeGlassAvailable = false
try {
  nativeGlassAvailable = Platform.OS === 'ios' && isGlassEffectAPIAvailable() && isLiquidGlassAvailable()
} catch {
  // A binary built before expo-glass-effect was linked still gets usable chrome.
  nativeGlassAvailable = false
}

/** OS and binary capability are fixed for the process, so every glass control shares one safe answer. */
export const LIQUID_GLASS_AVAILABLE = nativeGlassAvailable

/** Native merging on supported SDK 57 builds, an ordinary layout group everywhere else. */
export function GlassGroup(props: GlassContainerProps) {
  if (LIQUID_GLASS_AVAILABLE) return <GlassContainer {...props} />
  const { spacing: _spacing, ...viewProps } = props
  return <View {...viewProps} />
}

interface GlassSurfaceProps extends Omit<ViewProps, 'style'> {
  children?: ReactNode
  style?: StyleProp<ViewStyle>
  /** The material's own radius; native glass needs this to draw its rim correctly. */
  radius: number
  glassStyle?: GlassStyle
  tintColor?: string
  interactive?: boolean
  /** Flat fallback fill used when the native material is unavailable. */
  fallbackColor?: ColorValue
  /** Additional fallback-only treatment, such as a stronger floating shadow. */
  fallbackStyle?: StyleProp<ViewStyle>
}

/**
 * The one material boundary for Manor's existing phone chrome. SDK 57 owns the
 * native effect; older iOS builds and Android keep the same raised fallback without
 * asking each call-site to know which native module is present.
 */
export function GlassSurface({
  children,
  style,
  radius,
  glassStyle = 'regular',
  tintColor,
  interactive = false,
  fallbackColor = colors.raised,
  fallbackStyle,
  ...props
}: GlassSurfaceProps) {
  const scheme: GlassColorScheme = useScheme()
  const shape = { borderRadius: radius, ...squircle }

  if (LIQUID_GLASS_AVAILABLE) {
    return (
      <GlassView
        {...props}
        colorScheme={scheme}
        glassEffectStyle={glassStyle}
        isInteractive={interactive}
        // Never clipped: clipping cuts the glass's own rim and shadow, which is what
        // keeps a light surface apart from a light screen, and the growth of a
        // control under a hold. Content that scrolls past the curve, such as a
        // menu's rows, rounds its own scroll view instead.
        style={[shape, style]}
        tintColor={tintColor}
      >
        {children}
      </GlassView>
    )
  }

  return (
    <View
      {...props}
      style={[shape, styles.clip, styles.fallback, { backgroundColor: fallbackColor }, fallbackStyle, style]}
    >
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  fallback: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
})
