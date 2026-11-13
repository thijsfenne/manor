import { Pressable, StyleSheet, View } from 'react-native'

import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

export interface SegmentOption<Value extends string> {
  value: Value
  label: string
  /** Keeps the segment in place but unpickable; the caller says why next to it. */
  disabled?: boolean
}

/** The phone's single-choice switch, the Mac's segmented control as a native capsule. */
export function SegmentedControl<Value extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string
  options: readonly SegmentOption<Value>[]
  value: Value
  onChange: (value: Value) => void
  disabled?: boolean
}) {
  return (
    <View accessibilityLabel={label} accessibilityRole="tablist" style={styles.track}>
      {options.map((option) => {
        const selected = option.value === value
        const off = disabled || option.disabled === true
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected, disabled: off }}
            disabled={off}
            onPress={() => { if (!selected) onChange(option.value) }}
            style={[styles.segment, selected && styles.selected, off && styles.disabled]}
          >
            <Text style={[styles.label, selected && styles.selectedLabel]}>{option.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', alignSelf: 'flex-start', gap: 2, padding: 2, borderRadius: radius.round, backgroundColor: colors.surface2 },
  segment: { minHeight: 36, justifyContent: 'center', paddingHorizontal: spacing.lg, borderRadius: radius.round, ...squircle },
  selected: { backgroundColor: colors.fill },
  label: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, fontWeight: '500' },
  selectedLabel: { color: colors.text },
  disabled: { opacity: 0.38 },
})
