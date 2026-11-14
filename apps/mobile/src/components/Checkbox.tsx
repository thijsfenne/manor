import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { Pressable, StyleSheet, View } from 'react-native'
import { colors, radius, spacing } from '@/theme'
import { Text } from './Text'

/** `compact` drops the 44pt touch row to a 34pt one, so the box sits level with a button row. */
export function Checkbox({ checked, disabled = false, label, compact = false, onChange }: {
  checked: boolean
  disabled?: boolean
  label: string
  compact?: boolean
  onChange: (checked: boolean) => void
}) {
  return <Pressable accessibilityRole="checkbox" accessibilityLabel={label}
    accessibilityState={{ checked, disabled }} disabled={disabled}
    onPress={() => onChange(!checked)} style={[styles.row, compact && styles.rowCompact, disabled && styles.disabled]}>
    <View style={[styles.box, checked && styles.checked]}>
      {checked ? <HugeiconsIcon icon={Tick02Icon} size={12} color={colors.onPrimary} strokeWidth={2} /> : null}
    </View>
    <Text style={styles.label}>{label}</Text>
  </Pressable>
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44 },
  rowCompact: { minHeight: 34 },
  box: { width: 16, height: 16, borderWidth: 1, borderColor: colors.line, borderRadius: radius.xs, alignItems: 'center', justifyContent: 'center' },
  checked: { backgroundColor: colors.text, borderColor: colors.text },
  disabled: { opacity: 0.5 },
  label: { color: colors.muted, fontSize: 13 },
})
