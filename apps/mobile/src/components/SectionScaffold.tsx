import { ArrowLeft01Icon, MenuTwoLineIcon } from '@hugeicons/core-free-icons'
import { useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { Drawer } from '@/components/Drawer'
import { GlassIconButton } from '@/components/GlassIconButton'
import { HouseMenu, type HouseSection } from '@/components/HouseMenu'
import { Text } from '@/components/Text'
import { colors, fonts, spacing } from '@/theme'

interface SectionScaffoldProps {
  active: HouseSection
  children: ReactNode
  title: string
  compactTitle?: boolean
  onBack?: () => void
}

/** Shared phone chrome for every room behind the house menu. */
export function SectionScaffold({ active, children, title, compactTitle = true, onBack }: SectionScaffoldProps) {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <Drawer
      menu={<HouseMenu active={active} onClose={() => setMenuOpen(false)} />}
      onOpenChange={setMenuOpen}
      open={menuOpen}
    >
      <SafeAreaView edges={['top']} style={styles.screen}>
        <View style={styles.header}>
          <View style={styles.side}>
            <GlassIconButton
              accessibilityLabel={onBack === undefined ? 'Open menu' : 'Back'}
              {...(onBack === undefined ? { accessibilityState: { expanded: menuOpen } } : {})}
              icon={onBack === undefined ? MenuTwoLineIcon : ArrowLeft01Icon}
              onPress={onBack ?? (() => setMenuOpen(true))}
            />
          </View>

          <View style={styles.heading}>
            <Text maxFontSizeMultiplier={1.35} numberOfLines={1} style={[styles.title, compactTitle && styles.compactTitle]}>{title}</Text>
          </View>

          <View style={styles.side} />
        </View>
        <View style={styles.content}>{children}</View>
      </SafeAreaView>
    </Drawer>
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
