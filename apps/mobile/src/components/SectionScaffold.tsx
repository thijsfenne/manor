import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon'
import MenuTwoLineIcon from '@hugeicons/core-free-icons/MenuTwoLineIcon'
import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { GlassIconButton } from '@/components/GlassIconButton'
import { Text } from '@/components/Text'
import { useHouseDrawer } from '@/lib/houseDrawer'
import { colors, fonts, spacing } from '@/theme'

interface SectionScaffoldProps {
  children: ReactNode
  title: string
  compactTitle?: boolean
  onBack?: () => void
  /**
   * Content runs on under the tab bar, for a screen that pads its own bottom around a
   * floating toolbar. Otherwise the content ends where the tab bar starts.
   */
  edgeToEdge?: boolean
}

/** Shared phone chrome for every room: the title, and the button to the house menu or back. */
export function SectionScaffold({ children, title, compactTitle = true, onBack, edgeToEdge = false }: SectionScaffoldProps) {
  const menu = useHouseDrawer()

  return (
    <SafeAreaView edges={edgeToEdge ? ['top'] : ['top', 'bottom']} style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.side}>
          <GlassIconButton
            accessibilityLabel={onBack === undefined ? 'Open menu' : 'Back'}
            {...(onBack === undefined ? { accessibilityState: { expanded: menu.open } } : {})}
            icon={onBack === undefined ? MenuTwoLineIcon : ArrowLeft01Icon}
            onPress={onBack ?? (() => menu.setOpen(true))}
          />
        </View>

        <View style={styles.heading}>
          <Text maxFontSizeMultiplier={1.35} numberOfLines={1} style={[styles.title, compactTitle && styles.compactTitle]}>{title}</Text>
        </View>

        <View style={styles.side} />
      </View>
      <View style={styles.content}>{children}</View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    width: '100%',
    maxWidth: 760,
    minHeight: 76,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    paddingBottom: spacing.md,
  },
  side: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  heading: { flex: 1, minWidth: 0, alignItems: 'center', gap: 3, paddingHorizontal: spacing.sm },
  title: {
    maxWidth: '100%',
    color: colors.text,
    fontFamily: fonts.display,
    fontSize: 24,
    letterSpacing: -0.5,
    textAlign: 'center',
  },
  compactTitle: { fontSize: 18, letterSpacing: -0.25 },
  content: { flex: 1 },
})
