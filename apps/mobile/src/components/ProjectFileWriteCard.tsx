import MinusSignIcon from '@hugeicons/core-free-icons/MinusSignIcon'
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon'
import Undo02Icon from '@hugeicons/core-free-icons/Undo02Icon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { projectFileWriteDetail, projectFileWriteLabel, type ProjectFileWrite } from '@manor/contracts'
import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'

import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

/**
 * A project thread's write to its own file, the phone twin of the Mac's card: what
 * happened, to which file, and the line clamped to two rows. A tap unfolds it.
 */
export function ProjectFileWriteCard({ write, projectName }: { write: ProjectFileWrite; projectName?: string | undefined }) {
  const [open, setOpen] = useState(false)
  const label = projectFileWriteLabel(write, projectName)
  const detail = projectFileWriteDetail(write)
  const mark = write.action === 'remove' ? MinusSignIcon : write.action === 'restore' ? Undo02Icon : Tick02Icon
  return (
    <Pressable
      accessibilityLabel={detail === undefined ? label : `${label}: ${detail}`}
      accessibilityRole="button"
      accessibilityState={detail === undefined ? { disabled: true } : { expanded: open }}
      disabled={detail === undefined}
      onPress={() => setOpen((current) => !current)}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <HugeiconsIcon color={colors.muted} icon={mark} size={13} strokeWidth={1.8} style={styles.mark} />
      <View style={styles.body}>
        <Text style={styles.label}>{label}</Text>
        {detail === undefined ? null : <Text numberOfLines={open ? undefined : 2} style={styles.detail}>{detail}</Text>}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    alignSelf: 'center',
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderRadius: radius.md,
    ...squircle,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.raised,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  pressed: { backgroundColor: colors.surface2 },
  mark: { marginTop: 3 },
  body: { flexShrink: 1, minWidth: 0 },
  label: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  detail: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
})
