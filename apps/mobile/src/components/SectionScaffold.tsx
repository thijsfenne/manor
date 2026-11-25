import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon'
import MenuTwoLineIcon from '@hugeicons/core-free-icons/MenuTwoLineIcon'
import { useMemo, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { EdgeScrim, SCRIM_REACH, ScrimInsetsContext } from '@/components/EdgeScrim'
import { GlassIconButton } from '@/components/GlassIconButton'
import { Text } from '@/components/Text'
import { useHouseDrawer } from '@/lib/houseDrawer'
import { colors, fonts, spacing } from '@/theme'

/** The header row's height under the status bar. */
const HEADER_HEIGHT = 76
/** What a floating toolbar takes above the tab bar: its 50pt control and the air around it. */
const TOOLBAR_SPACE = 84

interface SectionScaffoldProps {
  children: ReactNode
  title: string
  compactTitle?: boolean
  onBack?: () => void
  /** False in a room from the house menu, which hides the tab bar. */
  tabBar?: boolean
  toolbar?: (scrim: ReactNode) => ReactNode
  /** The header's right side, for a tab root: the usage pill. */
  trailing?: ReactNode
}

interface ScrimFrameProps {
  /** The header row, drawn over the content under the status bar. */
  header: ReactNode
  /** The header row's fixed height, which the content pads for. */
  headerHeight: number
  /** False where the tab bar is hidden: only the header gets a scrim then. */
  tabBar?: boolean
  /**
   * A control floating on the tab bar, such as New session or the search field. Its view
   * places the bottom scrim it is handed as its first child, so the fade rides up with it
   * over the keyboard.
   */
  toolbar?: (scrim: ReactNode) => ReactNode
  /** Placed between the header and the tab bar; a scroll view in it runs under both with `useScrimScroll`. */
  children: ReactNode
}

/**
 * The frame under every page with its own header: the header drawn over the content
 * with the scrim behind it, the same scrim behind the tab bar, and the content padded
 * clear of both so only a scroll view reaches under them.
 */
export function ScrimFrame({ header, headerHeight, tabBar = true, toolbar, children }: ScrimFrameProps) {
  // Inside a tab stack the bottom inset is the tab bar plus the home indicator.
  const insets = useSafeAreaInsets()
  const top = insets.top + headerHeight
  const bottom = insets.bottom + (toolbar === undefined ? 0 : TOOLBAR_SPACE)
  const scrimInsets = useMemo(() => ({ top, bottom }), [top, bottom])
  const bottomScrim = tabBar ? <EdgeScrim edge="bottom" height={bottom + SCRIM_REACH} /> : null

  return (
    <View style={styles.screen}>
      <ScrimInsetsContext.Provider value={scrimInsets}>
        <View style={[styles.content, { paddingTop: top, paddingBottom: bottom }]}>{children}</View>
      </ScrimInsetsContext.Provider>
      {toolbar === undefined ? bottomScrim : toolbar(bottomScrim)}

      <View pointerEvents="box-none" style={styles.top}>
        <EdgeScrim edge="top" height={top + SCRIM_REACH} />
        <View pointerEvents="box-none" style={{ marginTop: insets.top }}>{header}</View>
      </View>
    </View>
  )
}

/** Shared phone chrome for every room: the title, and the button to the house menu or back, in a `ScrimFrame`. */
export function SectionScaffold({ children, title, compactTitle = true, onBack, tabBar, toolbar, trailing }: SectionScaffoldProps) {
  const menu = useHouseDrawer()
  const header = (
    <View pointerEvents="box-none" style={styles.header}>
      {/* With a trailing control both sides take its width, so the title stays centred. */}
      <View style={[styles.side, trailing !== undefined && styles.sideWide]}>
        <GlassIconButton
          accessibilityLabel={onBack === undefined ? 'Open menu' : 'Back'}
          {...(onBack === undefined ? { accessibilityState: { expanded: menu.open } } : {})}
          icon={onBack === undefined ? MenuTwoLineIcon : ArrowLeft01Icon}
          onPress={onBack ?? (() => menu.setOpen(true))}
        />
      </View>

      <View pointerEvents="none" style={styles.heading}>
        <Text maxFontSizeMultiplier={1.35} numberOfLines={1} style={[styles.title, compactTitle && styles.compactTitle]}>{title}</Text>
      </View>

      <View pointerEvents="box-none" style={[styles.side, trailing !== undefined && styles.sideWide, styles.sideEnd]}>{trailing}</View>
    </View>
  )

  return (
    <ScrimFrame header={header} headerHeight={HEADER_HEIGHT} tabBar={tabBar} toolbar={toolbar}>
      {children}
    </ScrimFrame>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1 },
  top: { position: 'absolute', top: 0, right: 0, left: 0 },
  header: {
    width: '100%',
    maxWidth: 760,
    height: HEADER_HEIGHT,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    paddingBottom: spacing.md,
  },
  side: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  // Fits the usage pill at its widest: two overlapping rings and a count.
  sideWide: { width: 92, alignItems: 'flex-start' },
  sideEnd: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center' },
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
})
