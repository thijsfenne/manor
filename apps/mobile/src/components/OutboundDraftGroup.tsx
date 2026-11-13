import { useOutboundDock } from './outboundDockState'
import { ArrowDown01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { plainPreview } from '@manor/client-runtime/plain-preview'
import { draftStatus, tallyDrafts, type DraftRecord, type DraftStatus } from '@manor/client-runtime/state'
import { Image } from 'expo-image'
import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Animated, { FadeIn, FadeOut, LinearTransition, ReduceMotion } from 'react-native-reanimated'

import { OutboundDraftBubble, type DraftActions } from '@/components/OutboundDraftBubble'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

type BubbleProps = {
  docked?: boolean
  connected?: boolean
  actions?: DraftActions
}

/**
 * Every draft one turn prepared. One draft is the plain card, unchanged; two or more
 * become a list with a tally above it and exactly one card unfolded at a time. On a
 * phone that is not a nicety: five editors stacked under a keyboard cannot be worked.
 * There is no "send all", one Submit is one send and the text has been seen first.
 */
export function OutboundDraftGroup({ drafts, docked = false, ...bubble }: BubbleProps & { drafts: readonly DraftRecord[] }) {
  const dock = useOutboundDock()
  if (dock !== null) drafts = drafts.filter((draft) => docked ? dock.pinned(draft) : draftStatus(draft) !== 'open')
  if (drafts.length === 0) return null
  const only = drafts.length === 1 ? drafts[0] : undefined
  if (only !== undefined) return <OutboundDraftBubble draft={only} {...bubble} />
  return <DraftList drafts={drafts} {...bubble} />
}

/**
 * Which row is unfolded. `undefined` follows the work: the first draft still open.
 * `null` is everything folded by hand. A picked row stays unfolded until it is acted
 * on, then the list moves on to the next open one; a settled row picked to be re-read
 * stays until it is folded again.
 */
type Choice = { draftId: string; open: boolean } | null | undefined

function DraftList({ drafts, connected = true, actions }: BubbleProps & { drafts: readonly DraftRecord[] }) {
  const [choice, setChoice] = useState<Choice>(undefined)
  const firstOpen = drafts.find((draft) => draftStatus(draft) === 'open')?.draftId
  const picked = choice === undefined || choice === null
    ? undefined
    : drafts.find((draft) => draft.draftId === choice.draftId)
  const unfolded =
    choice === null
      ? undefined
      : choice === undefined || picked === undefined
        ? firstOpen
        : choice.open && draftStatus(picked) !== 'open'
          ? firstOpen
          : picked.draftId

  return (
    <Animated.View layout={LinearTransition.duration(180).reduceMotion(ReduceMotion.System)} style={styles.list}>
      <Text style={styles.tally}>{tallyLine(drafts)}</Text>
      {drafts.map((draft) => {
        const open = draft.draftId === unfolded
        const status = draftStatus(draft)
        // A thread put aside with one tap gets its way back on the same row, so the
        // undo is never further away than the decision was.
        const restore = status === 'snoozed' || status === 'ignored' ? actions?.onRestore : undefined
        return (
          <Animated.View key={draft.draftId} layout={LinearTransition.duration(180).reduceMotion(ReduceMotion.System)}>
            <View style={styles.rowLine}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                hitSlop={4}
                onPress={() => setChoice(open ? null : { draftId: draft.draftId, open: status === 'open' })}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <Image
                  accessibilityIgnoresInvertColors
                  contentFit="contain"
                  source={draft.channel === 'slack'
                    ? require('../../assets/images/Slack_icon.svg')
                    : require('../../assets/images/Gmail_icon.svg')}
                  style={styles.channelIcon}
                />
                <Text numberOfLines={1} style={styles.to}>{draft.to}</Text>
                <Text numberOfLines={1} style={[styles.gist, open && styles.gistOpen]}>{gist(draft)}</Text>
                <StatusBadge draft={draft} />
                <View style={[styles.chevron, open && styles.chevronOpen]}>
                  <HugeiconsIcon color={colors.dim} icon={ArrowDown01Icon} size={12} strokeWidth={1.8} />
                </View>
              </Pressable>
              {restore === undefined ? null : (
                <Pressable
                  accessibilityLabel="Restore this draft"
                  accessibilityRole="button"
                  disabled={!connected}
                  hitSlop={6}
                  onPress={() => restore(draft.draftId)}
                  style={({ pressed }) => [styles.restore, !connected && styles.disabled, pressed && styles.pressed]}
                >
                  <Text style={styles.restoreLabel}>Restore</Text>
                </Pressable>
              )}
            </View>
            {open ? (
              <Animated.View
                entering={FadeIn.duration(140).reduceMotion(ReduceMotion.System)}
                exiting={FadeOut.duration(80).reduceMotion(ReduceMotion.System)}
                style={styles.card}
              >
                <OutboundDraftBubble
                  connected={connected}
                  draft={draft}
                  {...(actions === undefined ? {} : { actions })}
                />
              </Animated.View>
            ) : null}
          </Animated.View>
        )
      })}
    </Animated.View>
  )
}

/** The subject when there is one, else the first words of the message. */
function gist(draft: DraftRecord): string {
  const subject = draft.closed?.subject ?? draft.submission?.subject ?? draft.subject
  if (subject !== undefined && subject.trim().length > 0) return subject
  return plainPreview(draft.closed?.body ?? draft.submission?.body ?? draft.body)
}

const STATUS_LABEL: Record<DraftStatus, string> = {
  open: 'Open',
  locked: 'Sending',
  sent: 'Sent',
  saved: 'Saved',
  discarded: 'Discarded',
  snoozed: 'Later',
  ignored: 'Ignored',
}

function StatusBadge({ draft }: { draft: DraftRecord }) {
  const status = draftStatus(draft)
  const failed = status === 'open' && draft.failure !== undefined
  const uncertain = status === 'locked' && draft.submission?.status === 'uncertain'
  const color = failed ? colors.danger : status === 'sent' ? colors.ok : status === 'open' ? colors.muted : colors.dim
  return <Text style={[styles.badge, { color }]}>{failed ? 'Failed' : uncertain ? 'Uncertain' : STATUS_LABEL[status]}</Text>
}

/** "5 drafts · 2 sent · 1 discarded · 2 open", only the parts that are not zero. */
function tallyLine(drafts: readonly DraftRecord[]): string {
  const tally = tallyDrafts(drafts)
  const parts = [`${String(drafts.length)} drafts`]
  if (tally.sent > 0) parts.push(`${String(tally.sent)} sent`)
  if (tally.saved > 0) parts.push(`${String(tally.saved)} saved`)
  if (tally.locked > 0) parts.push(`${String(tally.locked)} sending`)
  if (tally.uncertain > 0) parts.push(`${String(tally.uncertain)} uncertain`)
  if (tally.discarded > 0) parts.push(`${String(tally.discarded)} discarded`)
  if (tally.snoozed > 0) parts.push(`${String(tally.snoozed)} later`)
  if (tally.ignored > 0) parts.push(`${String(tally.ignored)} ignored`)
  if (tally.open > 0) parts.push(`${String(tally.open)} open`)
  return parts.join(' · ')
}

const styles = StyleSheet.create({
  list: { gap: 2 },
  tally: { paddingHorizontal: 2, paddingBottom: spacing.xs, color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  rowLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  row: { flex: 1, minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderRadius: radius.sm, ...squircle, paddingHorizontal: 6 },
  restore: { minHeight: 34, justifyContent: 'center', borderRadius: radius.sm, ...squircle, paddingHorizontal: spacing.sm },
  restoreLabel: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  disabled: { opacity: 0.4 },
  channelIcon: { width: 14, height: 14 },
  to: { maxWidth: '38%', flexShrink: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 14 },
  gist: { flex: 1, color: colors.dim, fontFamily: fonts.sans, fontSize: 14 },
  gistOpen: { color: colors.muted },
  badge: { fontFamily: fonts.sans, fontSize: 13 },
  chevron: { transform: [{ rotate: '0deg' }] },
  chevronOpen: { transform: [{ rotate: '180deg' }] },
  card: { paddingTop: spacing.xs, paddingBottom: spacing.sm },
  pressed: { opacity: 0.7 },
})
