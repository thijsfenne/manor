import DashboardSpeed02Icon from '@hugeicons/core-free-icons/DashboardSpeed02Icon'
import { useEffect, useId, useMemo, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import Svg, { Circle, Defs, G, Mask, Rect } from 'react-native-svg'

import type { ProviderUsage, UsageWindow } from '@manor/contracts'
import {
  STALE_AFTER_MS,
  WINDOW_DETAILS,
  byCardOrder,
  clockOf,
  connectedUsage,
  headerRings,
  heatOf,
  paceMarkPercent,
  remainingPercent,
  resetLabel,
  type Heat,
  type UsageRing,
} from '@manor/client-runtime/usage'

import { GlassIconButton } from '@/components/GlassIconButton'
import { GlassPressable } from '@/components/GlassPressable'
import { ProviderMark } from '@/components/ProviderMark'
import { ScrimScrollView } from '@/components/EdgeScrim'
import { Sheet } from '@/components/Sheet'
import { Text } from '@/components/Text'
import { useWorkspace, useWorkspaceData } from '@/providers/WorkspaceProvider'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

const heatColor = (heat: Heat) =>
  heat === 'critical' ? colors.danger : heat === 'warn' ? colors.warning : colors.muted

const capitalised = (provider: string) => `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`

/**
 * The house's subscription headroom in a tab root's header, and the one usage view
 * on the phone behind it. Claude's ring, then Codex's, each filled to what is left of
 * that provider's fullest window, with every other reporting provider folded into
 * "+N" (`headerRings`). Before any provider has reported, the gauge glyph holds the
 * place so the sheet, with its reason why, stays one tap away.
 */
export function UsageButton() {
  const [open, setOpen] = useState(false)
  const { workspace } = useWorkspaceData()
  const { rings, more } = useMemo(
    () => headerRings(workspace.providerUsage, workspace.providerConnections),
    [workspace.providerUsage, workspace.providerConnections],
  )
  const reading = [
    ...rings.map((ring) => `${capitalised(ring.provider)} ${String(ring.left)}% left`),
    ...(more > 0 ? [`${String(more)} more`] : []),
  ].join(', ')

  return (
    <>
      {rings.length === 0 ? (
        <GlassIconButton accessibilityLabel="Usage" icon={DashboardSpeed02Icon} onPress={() => setOpen(true)} />
      ) : (
        <GlassPressable accessibilityLabel={`Usage, ${reading}`} hitSlop={6} onPress={() => setOpen(true)} radius={22}>
          <View style={styles.pill}>
            {rings.map((ring, index) => (
              <Ring key={ring.provider} ring={ring} overlap={index > 0} />
            ))}
            {more > 0 ? <Text maxFontSizeMultiplier={1.2} style={styles.more}>+{more}</Text> : null}
          </View>
        </GlassPressable>
      )}
      <Sheet onClose={() => setOpen(false)} open={open} title="Usage">
        <UsageList />
      </Sheet>
    </>
  )
}

const RING_SIZE = 26
const RING_STROKE = 2.5
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
/** How far a ring tucks under the one before it. */
const RING_OVERLAP = 6
/** The front ring's disc plus a hairline of air, cut out of the ring behind it. */
const RING_CUTOUT = RING_SIZE / 2 + 1.5

/**
 * As the Mac's rail ring: a full ring is a fresh plan, and a spent one draws no arc.
 * A ring behind another loses the part under the front ring's disc, so the front
 * ring reads as solid without painting a fill that would not match the glass.
 */
function Ring({ ring, overlap }: { ring: UsageRing; overlap: boolean }) {
  const mask = useId().replace(/[^\w-]/g, '')
  const centre = RING_SIZE / 2
  const fraction = ring.left / 100
  return (
    <View style={[styles.ring, overlap && styles.ringOverlap]}>
      <Svg height={RING_SIZE} style={StyleSheet.absoluteFill} width={RING_SIZE}>
        {overlap ? (
          <Defs>
            <Mask height={RING_SIZE} id={mask} maskUnits="userSpaceOnUse" width={RING_SIZE} x={0} y={0}>
              <Rect fill="white" height={RING_SIZE} width={RING_SIZE} x={0} y={0} />
              <Circle cx={centre - (RING_SIZE - RING_OVERLAP)} cy={centre} fill="black" r={RING_CUTOUT} />
            </Mask>
          </Defs>
        ) : null}
        <G {...(overlap ? { mask: `url(#${mask})` } : {})}>
          <Circle cx={centre} cy={centre} fill="none" r={RING_RADIUS} stroke={colors.line} strokeWidth={RING_STROKE} />
          {fraction > 0 ? (
            <Circle
              cx={centre}
              cy={centre}
              fill="none"
              origin={`${String(centre)}, ${String(centre)}`}
              r={RING_RADIUS}
              rotation={-90}
              stroke={heatColor(ring.heat)}
              strokeDasharray={`${String(RING_CIRCUMFERENCE * fraction)} ${String(RING_CIRCUMFERENCE)}`}
              strokeLinecap="round"
              strokeWidth={RING_STROKE}
            />
          ) : null}
        </G>
      </Svg>
      <ProviderMark driver={ring.provider} size={11} />
    </View>
  )
}

/**
 * How much of each subscription is left, per connected provider, with the reset
 * moment and the pace mark beside each bar. The same reading the Mac's Usage dialog
 * gives: the numbers, the heat and the labels all come from
 * `@manor/client-runtime/usage`, so the phone can never tell the story differently.
 */
function UsageList() {
  const { workspace, status } = useWorkspace()
  const providers = useMemo(
    () => connectedUsage(workspace.providerUsage, workspace.providerConnections).sort(byCardOrder),
    [workspace.providerUsage, workspace.providerConnections],
  )
  // The reset labels, pace marks and the stale note read the clock, so the clock
  // ticks on state rather than in render. Thirty seconds: the labels are
  // minute-grained, and a probe broadcast re-renders the sheet long before a reading
  // turns stale.
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
            ? 'None of the connected runtimes on this Mac has a subscription to read.'
            : 'Usage shows up once the connection to your Mac is back.'}
        </Text>
      </View>
    )
  }

  return (
    <ScrimScrollView contentContainerStyle={styles.list}>
      {providers.map((usage) => (
        <ProviderCard key={usage.provider} usage={usage} now={now} />
      ))}
    </ScrimScrollView>
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
        <Text numberOfLines={1} style={styles.cardMeta}>{usage.plan?.replace(/\b\w/g, (letter) => letter.toUpperCase()) ?? ''}</Text>
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
  // Where the bar would end had the window been spent evenly so far.
  const pace = paceMarkPercent(limit, now)

  return (
    <View style={styles.window}>
      <View style={styles.windowHead}>
        <Text numberOfLines={1} style={styles.windowLabel}>{limit.label}</Text>
        {reset === '' ? null : <Text style={styles.windowReset}>{reset}</Text>}
        <Text style={[styles.windowPercent, { color: heatColor(heat) }]}>{left}% left</Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${left}%`, backgroundColor: heatColor(heat) }]} />
        {pace === null ? null : <View style={[styles.pace, { left: `${pace}%` }]} testID="usage-pace-mark" />}
      </View>
      {detail === undefined ? null : <Text style={styles.detail}>{detail}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  pill: { height: 44, minWidth: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 9 },
  ring: { width: RING_SIZE, height: RING_SIZE, alignItems: 'center', justifyContent: 'center' },
  ringOverlap: { marginLeft: -RING_OVERLAP },
  more: { color: colors.text, fontFamily: fonts.sans, fontSize: 14, fontWeight: '500', fontVariant: ['tabular-nums'], marginLeft: 4, paddingRight: 2 },
  list: { padding: spacing.lg, paddingTop: spacing.xs, paddingBottom: 48, gap: spacing.sm },
  card: { borderRadius: radius.md, ...squircle, backgroundColor: colors.sheetSurface, padding: spacing.lg },
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
  track: { marginTop: spacing.sm, height: 5, borderRadius: radius.round, backgroundColor: colors.line },
  fill: { height: '100%', borderRadius: radius.round },
  // The text tone, as on the Mac's dialog: the fill itself is muted.
  pace: { position: 'absolute', top: -2, bottom: -2, width: 1.5, marginLeft: -0.75, borderRadius: 1, backgroundColor: colors.text },
  detail: { color: colors.dim, fontFamily: fonts.sans, fontSize: 11, marginTop: 6 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.xxl },
  emptyTitle: { color: colors.text, fontFamily: fonts.sans, fontSize: 20, fontWeight: '500' },
  emptyCopy: { maxWidth: 300, color: colors.muted, fontFamily: fonts.sans, fontSize: 15, lineHeight: 22, textAlign: 'center' },
})
