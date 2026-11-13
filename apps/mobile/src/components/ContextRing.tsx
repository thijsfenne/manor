import { contextBreakdown, contextProvenance, readContextMeter, type ContextFigureRead, type ContextMeter, type ContextRowKey } from '@manor/client-runtime/context-meter'
import { memo } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Svg, { Circle } from 'react-native-svg'

import { Text } from '@/components/Text'
import { compactCopy, sourceWord, usageCopy, windowCopy } from '@/components/contextRingCopy'
import { colors, fonts, spacing } from '@/theme'

const SIZE = 18
const RADIUS = 7
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const BLOCK_LABELS: Record<ContextRowKey, string> = {
  messages: 'Messages',
  mcp: 'MCP tools',
  memory: 'Memory',
  instructions: 'Instructions',
  skills: 'Skills',
}

// Memoized like the web ring: its props change only when a live reading lands.
export const ContextRingButton = memo(function ContextRingButton({
  used,
  window,
  estimate,
  open,
  onPress,
}: ContextMeter & {
  open: boolean
  onPress: () => void
}) {
  const meter = readContextMeter(used, window, estimate)
  const usage = usageCopy(meter, contextProvenance(estimate).used)

  return (
    <Pressable
      accessibilityLabel={`Context window ${usage}`}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [styles.button, open && styles.buttonOn, pressed && styles.pressed]}
    >
      <Ring fraction={meter.fraction} reported={meter.reported} warns={meter.warns} />
    </Pressable>
  )
})

export function ContextRingCopy({ used, window, estimate }: ContextMeter) {
  const meter = readContextMeter(used, window, estimate)
  const breakdown = contextBreakdown(used, estimate, meter.limit)
  const source = contextProvenance(estimate)

  return (
    <View style={styles.copy}>
      <Text style={styles.label}>Context window</Text>
      <View style={styles.row}>
        <Text style={[styles.usage, styles.rowLabel]}>{usageCopy(meter, source.used)}</Text>
        <SourceMark figure={source.used} />
      </View>
      <View style={styles.row}>
        <Text style={[styles.meta, styles.rowLabel]}>{windowCopy(meter, source.window)}</Text>
        <SourceMark figure={source.window} />
      </View>
      {breakdown === undefined ? (
        <Text style={styles.meta}>A breakdown is available after the next completed turn.</Text>
      ) : (
        <>
          {breakdown.rows.map((row) => (
            <View key={row.key} style={styles.row}>
              <Text style={[styles.meta, styles.rowLabel]}>{BLOCK_LABELS[row.key]}</Text>
              <Text style={styles.value}>{row.tokens}{row.percent === null ? '' : ` · ${row.percent}`}</Text>
            </View>
          ))}
          <Text style={styles.meta}>Estimated split</Text>
        </>
      )}
      <Text style={styles.meta}>{compactCopy(source.autoCompactAt, meter.limitIsCompact)}</Text>
    </View>
  )
}

/** The mark that keeps a number and its provenance on the same line. */
function SourceMark({ figure }: { figure: ContextFigureRead | undefined }) {
  const word = sourceWord(figure)
  if (word === null) return null
  return <Text style={[styles.mark, figure?.source === 'measured' && styles.markOn]}>{word}</Text>
}

/**
 * `reported` draws the track itself: a solid ring is a window someone measured and
 * found empty, a dashed one is a provider that said nothing. Both are 0% full, and
 * without this the dial is the one surface that still cannot tell them apart.
 */
function Ring({ fraction, warns, reported = true }: { fraction: number; warns: boolean; reported?: boolean }) {
  return (
    <Svg height={SIZE} viewBox="0 0 18 18" width={SIZE} style={styles.dial}>
      <Circle
        cx={9}
        cy={9}
        fill="none"
        r={RADIUS}
        stroke={colors.line}
        strokeWidth={2.5}
        {...(reported ? {} : { strokeDasharray: '2 2.5' })}
      />
      {fraction > 0 ? (
        <Circle
          cx={9}
          cy={9}
          fill="none"
          r={RADIUS}
          stroke={warns ? colors.warning : colors.muted}
          strokeDasharray={`${CIRCUMFERENCE * fraction} ${CIRCUMFERENCE}`}
          strokeLinecap="round"
          strokeWidth={2.5}
        />
      ) : null}
    </Svg>
  )
}

const styles = StyleSheet.create({
  button: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  buttonOn: { backgroundColor: colors.fill },
  pressed: { opacity: 0.64 },
  dial: { transform: [{ rotate: '-90deg' }] },
  copy: { gap: 6, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  label: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12, fontWeight: '500' },
  usage: { color: colors.text, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  meta: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12, lineHeight: 16 },
  mark: { color: colors.dim, fontFamily: fonts.sans, fontSize: 11, lineHeight: 16 },
  markOn: { color: colors.text },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: spacing.sm },
  rowLabel: { flex: 1 },
  value: { color: colors.text, fontSize: 12, fontVariant: ['tabular-nums'] },
})
