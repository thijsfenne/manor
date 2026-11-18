import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'

import { Text } from '@/components/Text'
import { pressedValue, slideDuration, type SegmentSlot } from '@/components/segmentedSlide'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

export interface SegmentOption<Value extends string> {
  value: Value
  label: string
  /** Keeps the segment in place but unpickable; the caller says why next to it. */
  disabled?: boolean
}

const HEIGHT = 44
const PADDING = 2
const EASING = Easing.out(Easing.cubic)

/**
 * The phone's single-choice switch: a pill track with one pill indicator that slides
 * under the labels. By default the control is as wide as its segments; `fill` stretches
 * it across its row with equal segments, for a control that stands on a row of its own.
 */
export function SegmentedControl<Value extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  fill = false,
}: {
  label: string
  options: readonly SegmentOption<Value>[]
  value: Value
  onChange: (value: Value) => void
  disabled?: boolean
  fill?: boolean
}) {
  const [slots, setSlots] = useState<readonly (SegmentSlot | undefined)[]>([])
  const index = options.findIndex((option) => option.value === value)
  const slotX = slots[index]?.x
  const slotWidth = slots[index]?.width
  const x = useSharedValue(0)
  const width = useSharedValue(0)
  const shown = useSharedValue(0)
  const placed = useRef<number | undefined>(undefined)

  // A changed segment slides; a first layout or a resize jumps, so only a pick moves the indicator.
  useEffect(() => {
    if (slotX === undefined || slotWidth === undefined) {
      shown.set(0)
      placed.current = undefined
      return
    }
    const slide = placed.current !== undefined && placed.current !== index
    const timing = { duration: slideDuration(placed.current ?? index, index), easing: EASING, reduceMotion: ReduceMotion.System }
    placed.current = index
    shown.set(1)
    x.set(slide ? withTiming(slotX, timing) : slotX)
    width.set(slide ? withTiming(slotWidth, timing) : slotWidth)
  }, [index, slotX, slotWidth, shown, width, x])

  const indicator = useAnimatedStyle(() => ({ opacity: shown.get(), width: width.get(), transform: [{ translateX: x.get() }] }))

  return (
    <View
      accessibilityLabel={label}
      accessibilityRole="tablist"
      style={[styles.track, fill ? styles.fill : styles.content, disabled && styles.disabled]}
    >
      <Animated.View pointerEvents="none" style={[styles.indicator, indicator]} />
      {options.map((option, at) => {
        const selected = option.value === value
        const off = disabled || option.disabled === true
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected, disabled: off }}
            disabled={off}
            onLayout={({ nativeEvent: { layout } }) => {
              setSlots((current) => {
                const previous = current[at]
                if (previous?.x === layout.x && previous.width === layout.width) return current
                const next = current.slice()
                next[at] = { x: layout.x, width: layout.width }
                return next
              })
            }}
            onPress={() => {
              const picked = pressedValue(option, value, disabled)
              if (picked !== undefined) onChange(picked)
            }}
            style={[styles.segment, fill && styles.grow]}
          >
            <Text style={[styles.label, selected && styles.selectedLabel, option.disabled === true && !disabled && styles.disabled]}>{option.label}</Text>
          </Pressable>
        )
      })}
      {/* Drawn last, so the track's own fill never eats the contour. */}
      <View pointerEvents="none" style={styles.contour} />
    </View>
  )
}

const styles = StyleSheet.create({
  track: { minHeight: HEIGHT, flexDirection: 'row', padding: PADDING, borderRadius: radius.round, backgroundColor: colors.surface2, ...squircle },
  content: { alignSelf: 'flex-start' },
  fill: { alignSelf: 'stretch' },
  indicator: { position: 'absolute', top: PADDING, bottom: PADDING, left: 0, borderRadius: radius.round, backgroundColor: colors.segment, ...squircle },
  contour: { ...StyleSheet.absoluteFill, borderRadius: radius.round, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, ...squircle },
  segment: { justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.lg, borderRadius: radius.round },
  grow: { flex: 1 },
  label: { color: colors.muted, fontFamily: fonts.sans, fontSize: 16, fontWeight: '500' },
  selectedLabel: { color: colors.text },
  disabled: { opacity: 0.38 },
})
