import { useEffect, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'

import type { ProviderUsage, UsageWindow } from '@manor/contracts'
import {
  STALE_AFTER_MS,
  WINDOW_DETAILS,
  byCardOrder,
  clockOf,
  heatOf,
  remainingPercent,
  resetLabel,
  type Heat,
} from '@manor/client-runtime/usage'

import { ConnectGate } from '@/components/ConnectGate'
import { ProviderMark } from '@/components/ProviderMark'
import { SectionScaffold } from '@/components/SectionScaffold'
import { useWorkspace } from '@/providers/WorkspaceProvider'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

export default function UsageScreen() {
  return <ConnectGate><SectionScaffold title="Usage"><UsageList /></SectionScaffold></ConnectGate>
}

const heatColor = (heat: Heat) =>
  heat === 'critical' ? colors.danger : heat === 'warn' ? colors.warning : colors.muted

/**
 * How much of each subscription is left, per provider, with the reset moment next
 * to it. The same reading the Mac's sidebar dialog gives: the numbers, the heat and
 * the labels all come from `@manor/client-runtime/usage`, so the phone can never
 * tell the story differently than the desktop. Manor's own token history stays a
 * desktop surface; what this screen answers is "how much is left, and when does it
 * reset".
 */
function UsageList() {
  const { workspace, status } = useWorkspace()
  const providers = useMemo(() => [...workspace.providerUsage].sort(byCardOrder), [workspace.providerUsage])
  // The reset labels and the stale note read the clock, so the clock ticks on
  // state rather than in render. Thirty seconds: the labels are minute-grained,
  // and a probe broadcast re-renders the screen long before a reading turns stale.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  if (providers.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>
          {status === 'live' ? 'No provider is reporting usage' : 'No usage yet'}
        </Text>
        <Text style={styles.emptyCopy}>
          {status === 'live'
            ? 'None of the runtimes on this Mac has a subscription to read.'
            : 'Usage shows up once the connection to your Mac is back.'}
        </Text>
      </View>
    )
  }

  return (
    <ScrollView contentContainerStyle={styles.list}>
      {providers.map((usage) => (
        <ProviderCard key={usage.provider} usage={usage} now={now} />
      ))}
    </ScrollView>
  )
}

function ProviderCard({ usage, now }: { usage: ProviderUsage; now: number }) {
  const stale = now - usage.fetchedAt > STALE_AFTER_MS
  const note = usage.status === 'ok' && stale ? clockOf(usage.fetchedAt) : undefined

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <ProviderMark driver={usage.provider} size={15} />
        <Text style={styles.cardTitle}>{usage.provider}</Text>
        <Text numberOfLines={1} style={styles.cardMeta}>{usage.plan ?? ''}</Text>
        {note === undefined ? null : <Text style={styles.cardNote}>at {note}</Text>}
      </View>

      {usage.status === 'unavailable' ? (
        // No bar, no zero. A provider that did not answer has no number, and drawing
        // an empty meter for it would read as a completely unused plan.
        <Text style={styles.unavailable}>Unavailable</Text>
      ) : (
        usage.windows.map((limit) => (
          <WindowRow
            key={limit.label}
            limit={limit}
            now={now}
            detail={WINDOW_DETAILS[usage.provider]?.[limit.label]}
          />
        ))
      )}
    </View>
  )
}

function WindowRow({ limit, now, detail }: { limit: UsageWindow; now: number; detail?: string }) {
  const heat = heatOf(limit)
  const reset = resetLabel(limit.resetsAt, now)
  // What is left, as on the Mac's dialog: a full bar is a fresh plan and it drains
  // toward empty. The heat still follows how much is used.
  const left = remainingPercent(limit)

  return (
    <View style={styles.window}>
      <View style={styles.windowHead}>
        <Text numberOfLines={1} style={styles.windowLabel}>{limit.label}</Text>
        {reset === '' ? null : <Text style={styles.windowReset}>{reset}</Text>}
        <Text style={[styles.windowPercent, { color: heatColor(heat) }]}>{left}% left</Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${left}%`, backgroundColor: heatColor(heat) }]} />
      </View>
      {detail === undefined ? null : <Text style={styles.detail}>{detail}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  list: { padding: spacing.lg, paddingBottom: 48, gap: spacing.sm },
  card: { borderRadius: radius.md, ...squircle, backgroundColor: colors.surface, padding: spacing.lg },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardTitle: { color: colors.text, fontFamily: fonts.sans, fontSize: 15, fontWeight: '500', textTransform: 'capitalize' },
  cardMeta: { flex: 1, color: colors.dim, fontFamily: fonts.sans, fontSize: 12, textAlign: 'right' },
  cardNote: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12 },
  unavailable: { color: colors.dim, fontFamily: fonts.sans, fontSize: 14, paddingTop: spacing.md },
  window: { paddingTop: spacing.lg },
  windowHead: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  windowLabel: { flexShrink: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 14, fontWeight: '500' },
  windowReset: { marginLeft: 'auto', color: colors.dim, fontFamily: fonts.sans, fontSize: 12 },
  windowPercent: { fontFamily: fonts.sans, fontSize: 14, fontVariant: ['tabular-nums'] },
  track: { marginTop: spacing.sm, height: 5, overflow: 'hidden', borderRadius: radius.round, backgroundColor: colors.line },
  fill: { height: '100%', borderRadius: radius.round },
  detail: { color: colors.dim, fontFamily: fonts.sans, fontSize: 11, marginTop: 6 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.xxl },
  emptyTitle: { color: colors.text, fontFamily: fonts.sans, fontSize: 20, fontWeight: '500' },
  emptyCopy: { maxWidth: 300, color: colors.muted, fontFamily: fonts.sans, fontSize: 15, lineHeight: 22, textAlign: 'center' },
})
