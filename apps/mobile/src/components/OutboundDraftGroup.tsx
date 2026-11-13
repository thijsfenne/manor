import { draftStatus, tallyDrafts, type DraftRecord } from '@manor/client-runtime/state'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { LinearTransition, ReduceMotion } from 'react-native-reanimated'

import { OutboundDraftBubble, type DraftActions } from '@/components/OutboundDraftBubble'
import { Text } from '@/components/Text'
import { colors, fonts, spacing } from '@/theme'

type BubbleProps = {
  connected?: boolean
  actions?: DraftActions
}

/**
 * Every draft one turn prepared, in the turn. One draft is the plain card; two or more
 * stack with a tally above them and exactly one card unfolded at a time. On a phone
 * that is not a nicety: five editors stacked under a keyboard cannot be worked.
 * There is no "send all", one Send is one send and the text has been seen first.
 */
/** `bubble` (a DM) caps the card at the reply bubble's width; elsewhere it spans the column. */
export function OutboundDraftGroup({ drafts, bubble = false, ...card }: BubbleProps & { drafts: readonly DraftRecord[]; bubble?: boolean }) {
  if (drafts.length === 0) return null
  const only = drafts.length === 1 ? drafts[0] : undefined
  return (
    <View style={bubble && styles.bubble}>
      {only !== undefined ? <OutboundDraftBubble draft={only} {...card} /> : <DraftList drafts={drafts} {...card} />}
    </View>
  )
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
        return (
          <OutboundDraftBubble
            key={draft.draftId}
            connected={connected}
            draft={draft}
            unfolded={open}
            onToggle={() => setChoice(open ? null : { draftId: draft.draftId, open: draftStatus(draft) === 'open' })}
            {...(actions === undefined ? {} : { actions })}
          />
        )
      })}
    </Animated.View>
  )
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
  bubble: { maxWidth: '86%' },
  list: { gap: spacing.sm },
  tally: { paddingHorizontal: 2, color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
})
