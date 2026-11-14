import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon'
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import type { ReactNode } from 'react'
import { Modal, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { GlassIconButton } from '@/components/GlassIconButton'
import { Text } from '@/components/Text'
import { colors, fonts, spacing } from '@/theme'

interface SheetProps {
  open: boolean
  title: string
  /** A line under the title. A composed line may add a compact status mark. */
  subtitle?: ReactNode
  onClose: () => void
  /** Takes the place of close while the sheet has somewhere to step back to. */
  onBack?: () => void
  /** Fires once the sheet is fully gone, for focus that must wait until it is. */
  onDismiss?: () => void
  /** The header's right side, for a sheet that saves: its confirm control. */
  action?: ReactNode
  children: ReactNode
}

/**
 * The one sheet every picker on the phone opens in: a native page sheet with the
 * house header on top, so the runtime roster, the files list and whatever comes
 * next read as the same surface. The parent owns what is in it and when it opens;
 * this owns the frame and the way out.
 */
export function Sheet({ open, title, subtitle, onClose, onBack, onDismiss, action, children }: SheetProps) {
  const insets = useSafeAreaInsets()
  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={open}
      {...(onDismiss === undefined ? {} : { onDismiss })}
    >
      <View style={styles.screen}>
        <View style={styles.header}>
          <GlassIconButton
            accessibilityLabel={onBack === undefined ? 'Close' : 'Back'}
            icon={onBack === undefined ? Cancel01Icon : ArrowLeft01Icon}
            onPress={onBack ?? onClose}
            size={44}
          />
          <View style={styles.titles}>
            <Text numberOfLines={1} style={styles.title}>{title}</Text>
            {typeof subtitle === 'string' ? (
              <Text numberOfLines={1} style={styles.subtitle}>{subtitle}</Text>
            ) : subtitle}
          </View>
          {action}
        </View>
        <View style={[styles.body, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>{children}</View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.sheet },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.md },
  titles: { flex: 1, gap: 1 },
  title: { color: colors.text, fontFamily: fonts.sans, fontSize: 18, fontWeight: '500', letterSpacing: -0.2 },
  subtitle: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  body: { flex: 1 },
})
