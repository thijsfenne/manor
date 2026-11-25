import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon'
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import { useMemo, useState, type ReactNode } from 'react'
import { Modal, StyleSheet, View } from 'react-native'

import { EdgeScrim, SCRIM_REACH, ScrimInsetsContext } from '@/components/EdgeScrim'
import { GlassIconButton } from '@/components/GlassIconButton'
import { Text } from '@/components/Text'
import { colors, fonts, spacing } from '@/theme'
import { useWindowInsets } from '@/lib/windowInsets'

interface SheetProps {
  open: boolean
  /** Left out where the body carries the identity, as a hero does; the header then holds only its buttons. */
  title?: string
  /** A line under the title. A composed line may add a compact status mark. */
  subtitle?: ReactNode
  onClose: () => void
  /** Takes the place of close while the sheet has somewhere to step back to. */
  onBack?: () => void
  /** Fires once the sheet is fully gone, for focus that must wait until it is. */
  onDismiss?: () => void
  /** The header's right side, for a sheet that saves: its confirm control. */
  action?: ReactNode
  /** Placed below the header; a scroll view in it runs under the header with `useScrimScroll`. */
  children: ReactNode
}

/** The header's height with one title line, until it has laid out. */
const HEADER_ESTIMATE = 72

/**
 * The one sheet every picker on the phone opens in: a native page sheet with the
 * house header on top, so the runtime roster, the files list and whatever comes
 * next read as the same surface. The parent owns what is in it and when it opens;
 * this owns the frame and the way out. The header floats over the body with the
 * scrim behind it, so the body slides under it as the pages do.
 */
export function Sheet({ open, title, subtitle, onClose, onBack, onDismiss, action, children }: SheetProps) {
  const insets = useWindowInsets()
  const [headerHeight, setHeaderHeight] = useState(HEADER_ESTIMATE)
  // A sheet has no tab bar, so only its top is scrimmed.
  const scrimInsets = useMemo(() => ({ top: headerHeight, bottom: 0 }), [headerHeight])
  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={open}
      {...(onDismiss === undefined ? {} : { onDismiss })}
    >
      <View style={styles.screen}>
        <ScrimInsetsContext.Provider value={scrimInsets}>
          <View style={[styles.body, { paddingTop: headerHeight, paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>{children}</View>
        </ScrimInsetsContext.Provider>
        <EdgeScrim edge="top" height={headerHeight + SCRIM_REACH} surface="sheet" />
        <View onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)} pointerEvents="box-none" style={styles.header}>
          <GlassIconButton
            accessibilityLabel={onBack === undefined ? 'Close' : 'Back'}
            icon={onBack === undefined ? Cancel01Icon : ArrowLeft01Icon}
            onPress={onBack ?? onClose}
            size={44}
          />
          {/* Static, so a drag that starts on it still scrolls the body under it. */}
          <View pointerEvents="none" style={styles.titles}>
            {title === undefined ? null : <Text numberOfLines={1} style={styles.title}>{title}</Text>}
            {typeof subtitle === 'string' ? (
              <Text numberOfLines={1} style={styles.subtitle}>{subtitle}</Text>
            ) : subtitle}
          </View>
          {action}
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.sheet },
  header: { position: 'absolute', top: 0, right: 0, left: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.md },
  titles: { flex: 1, gap: 1 },
  title: { color: colors.text, fontFamily: fonts.sans, fontSize: 18, fontWeight: '500', letterSpacing: -0.2 },
  subtitle: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  body: { flex: 1 },
})
