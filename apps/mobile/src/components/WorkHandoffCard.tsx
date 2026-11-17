import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon'
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon'
import Attachment01Icon from '@hugeicons/core-free-icons/Attachment01Icon'
import CellsIcon from '@hugeicons/core-free-icons/CellsIcon'
import CheckmarkCircle02Icon from '@hugeicons/core-free-icons/CheckmarkCircle02Icon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { useContext, useEffect, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Animated, { Easing, FadeIn, FadeOut, LinearTransition, ReduceMotion, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated'
import { router } from 'expo-router'
import { workReopenedLine, type AgentConfig, type ChatMode, type SingleRuntime } from '@manor/contracts'
import { projectIcon } from '@manor/client-runtime/project-icons'
import { acceptWorkProposal, updateWorkProposal, workProposalAttachmentCount, workProposalMultipleBlock, workProposalRuntimeName } from '@manor/client-runtime/work-proposals'
import { closedWorkHandoff, forwardedLine, threadWorkCard, workCardLine, workCardStatus, workByline, workResultWaits, type Row } from '@manor/client-runtime/state'
import { modelLabel } from '@manor/client-runtime/runtimes'
import { useWorkspaceActions } from '@/providers/WorkspaceProvider'
import { useWorkProposal } from '@/lib/useWorkProposal'
import { colors, fonts, radius, spacing, squircle } from '@/theme'
import { bundleTile, InBundle } from './bundleTile'
import { CardButton } from './CardButton'
import { Checkbox } from './Checkbox'
import { GlassSurface } from './GlassSurface'
import { ProviderMark } from './ProviderMark'
import { ProjectBadge } from './ProjectBadge'
import { SegmentedControl } from './SegmentedControl'
import { SingleRuntimeSheet } from './RuntimeSheet'
import { Text } from './Text'
import { WorkPromptSheet } from './WorkPromptSheet'
import { WORK_STATUS_TONE, WorkCardStatusLabel, WorkResultBody, WorkStatusMark, type RevealPlace } from './WorkResultBody'

const MODE_OPTIONS = [
  { value: 'single', label: 'Single' },
  { value: 'house', label: 'Multiple' },
] as const
const SINGLE_ONLY_OPTIONS = [MODE_OPTIONS[0], { ...MODE_OPTIONS[1], disabled: true }] as const

export function WorkHandoffCard({ row, agents, onReject, onReveal, inThread = false }: {
  row: Extract<Row, { kind: 'work_handoff' }>
  agents: AgentConfig[]
  onReject: (handoffId: string) => void
  /** Scrolls a card into view by row key: a replaced proposal points at its newest version. */
  onReveal: (rowKey: string, place?: RevealPlace) => void
  /**
   * Set in a project thread: the card changes shape as its Session moves (one line once
   * accepted, one line once done), and the line's word is the overview's for its Session.
   */
  inThread?: boolean
}) {
  const { acceptWorkHandoff } = useWorkspaceActions()
  const proposal = useWorkProposal(row, agents)
  const { mode, runtime, isolate, accepting, error } = proposal
  const editedTask = proposal.task
  const setMode = (next: ChatMode) => updateWorkProposal(row.handoffId, { mode: next })
  const setIsolate = (next: boolean) => updateWorkProposal(row.handoffId, { isolate: next })
  const setEditedTask = (task: string | undefined) => updateWorkProposal(row.handoffId, { task })
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [runtimeOpen, setRuntimeOpen] = useState(false)
  const [promptDraft, setPromptDraft] = useState<string | null>(null)
  const tile = useContext(InBundle)
  const pending = row.acceptedAt === null
  const canAccept = pending && row.status === 'Working'
  const canReject = pending && row.status === 'Working'
  const singleMode = pending ? mode === 'single' : row.mode === 'single'
  const singleDriver = pending ? runtime.driver : row.singleDriver ?? runtime.driver
  // Accept lists the Session without opening it: the user opens it themselves.
  const accept = () => void acceptWorkProposal(row, agents, acceptWorkHandoff)
  const chooseMode = (next: ChatMode) => {
    if (accepting) return
    setMode(next)
    if (next === 'house') setRuntimeOpen(false)
  }
  const workChatId = row.workChatId
  const openSession = workChatId === null || (pending && row.status === 'Working')
    ? undefined
    : () => router.push({ pathname: '/chat/[id]', params: { id: workChatId } })
  // A revised proposal leaves its earlier version as one line that leads to the current one.
  const replacement = row.replacedBy
  if (replacement !== undefined) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Shows the current version in the chat"
        onPress={() => onReveal(replacement.key)}
        style={({ pressed }) => [tile ? bundleTile.tile : styles.closedRow, pressed && styles.pressed]}
      >
        <Text numberOfLines={1} style={styles.replacedTitle}>{row.title}</Text>
        <Text style={styles.closedLabel}>Replaced by v{replacement.revision}</Text>
      </Pressable>
    )
  }
  const closed = closedWorkHandoff(row)
  if (closed !== null) {
    return (
      <View style={tile ? bundleTile.tile : styles.closedRow}>
        <Text numberOfLines={1} style={styles.closedTitle}>{row.title}</Text>
        <Text style={styles.closedLabel}>{closed}</Text>
      </View>
    )
  }
  // A brief handed to its project thread (2026-10-10) is one line that follows the
  // session the thread started and opens the thread, where its questions and Confirm are.
  const forwarded = row.forwarded
  if (forwarded !== undefined) {
    const threadChatId = forwarded.threadChatId
    const line = forwardedLine(row)
    return (
      <Pressable
        accessibilityLabel={`${row.title}: ${line}`}
        accessibilityRole="button"
        disabled={threadChatId === null}
        onPress={threadChatId === null ? undefined : () => router.push({ pathname: '/chat/[id]', params: { id: threadChatId } })}
        style={({ pressed }) => [styles.forwardedRow, pressed && styles.pressed]}
      >
        <HugeiconsIcon color={row.projectColor} icon={projectIcon(row.projectIcon)} size={14} strokeWidth={1.7} />
        <Text numberOfLines={1} style={styles.forwardedTitle}>{row.title}</Text>
        <Text numberOfLines={1} style={[styles.closedLabel, styles.forwardedLine, forwarded.phase === 'ready' && styles.forwardedReady]}>{line}</Text>
      </Pressable>
    )
  }
  const shape = inThread ? threadWorkCard(row) : null
  // Inside an open bundle a Session line is one of its filled tiles, not a bordered card.
  const rowStyle = tile ? bundleTile.tile : styles.doneRow
  // A done assignment is one line: title, the first sentence of what came of it, how it
  // ended. In a thread it leads with the Sessions mark, as it stands among a bundle's notes.
  const done = shape === null ? workCardLine(row) : shape.shape === 'done' ? shape : null
  if (done !== null) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityHint={openSession === undefined ? undefined : 'Opens the Session'}
        disabled={openSession === undefined}
        onPress={openSession}
        style={({ pressed }) => [rowStyle, pressed && styles.pressed]}
      >
        {shape === null ? null : <View style={styles.tileMark}><HugeiconsIcon color={WORK_STATUS_TONE[done.status.tone]} icon={CellsIcon} size={tile ? 15 : 14} strokeWidth={1.8} /></View>}
        <Text numberOfLines={1} style={styles.doneText}>
          <Text style={tile ? styles.tileTitle : styles.doneTitle}>{row.title}</Text>{done.summary === '' ? '' : `, ${done.summary}`}
        </Text>
        <View style={styles.doneStatus}>
          {/* A finished Session that waits on no Confirm still gets the check, in its muted tone. */}
          {shape !== null && done.status.text === 'Done'
            ? <HugeiconsIcon color={WORK_STATUS_TONE[done.status.tone]} icon={CheckmarkCircle02Icon} size={14} strokeWidth={1.8} />
            : <WorkStatusMark status={done.status} />}
          <Text style={[styles.closedLabel, { color: WORK_STATUS_TONE[done.status.tone] }]}>{done.status.text}</Text>
        </View>
      </Pressable>
    )
  }
  // An accepted Session in its thread: its mark, its title and the word the overview has for it.
  if (shape?.shape === 'line') {
    const status = shape.status
    return (
      <Pressable
        accessibilityLabel={`Open Session ${row.title}, ${status.text}`}
        accessibilityRole="button"
        disabled={openSession === undefined}
        onPress={openSession}
        style={({ pressed }) => [rowStyle, pressed && styles.pressed]}
      >
        {/* Every Session line in the thread leads with the Sessions mark in its state's colour. */}
        <View style={styles.tileMark}><HugeiconsIcon color={WORK_STATUS_TONE[status.tone]} icon={CellsIcon} size={tile ? 15 : 14} strokeWidth={1.8} /></View>
        <Text numberOfLines={1} style={[styles.doneText, tile ? styles.tileTitle : styles.doneTitle]}>{row.title}</Text>
        <View style={styles.doneStatus}>
          <WorkStatusMark status={status} />
          <Text style={[styles.closedLabel, { color: WORK_STATUS_TONE[status.tone] }]}>{status.text}</Text>
        </View>
      </Pressable>
    )
  }
  const report = row.report
  const goal = row.summary ?? row.task
  const byline = workByline(singleMode
    ? { single: true, model: modelLabel(singleDriver, pending ? runtime.model : row.singleModel) }
    : { single: false, lead: row.leadAgentName, starter: row.firstExecutorName })
  // Only a proposal whose session does not exist yet can still take an edit.
  const proposedTask = canAccept && workChatId === null ? row.task : undefined
  // `agents` is the whole household here, which is what the lead is checked against.
  const multipleBlock = canAccept ? workProposalMultipleBlock(row, agents) : undefined
  // The model is named once, on the runtime line; the summary stands alone under the title.
  // A result reads without it (2026-11-07): its lines and status say what matters.
  const metaByline = canAccept || report !== undefined ? undefined : byline
  const head = (
    <View style={styles.workMain}>
      <View style={styles.workBody}>
        <View style={styles.workHead}>
          {/* The version label stays visible however long the title runs. */}
          <View style={styles.titleLine}>
            <Text numberOfLines={1} style={styles.workTitle}>{row.title}</Text>
            {row.revision === undefined ? null : <Text style={styles.revision}>v{row.revision}</Text>}
          </View>
          <WorkCardStatusLabel row={row} />
        </View>
        {inThread && metaByline === undefined ? null : (
          <View style={styles.workMeta}>
            {/* The thread is the project's own room: its name and the branch are noise there. */}
            {!inThread ? <ProjectBadge name={row.projectName} icon={row.projectIcon} color={row.projectColor} style={styles.projectBadge} /> : null}
            {metaByline === undefined ? null : <Text numberOfLines={1} style={[styles.workMetaText, styles.shrink]}>{metaByline}</Text>}
            {!inThread && !pending && row.worktreeBranch ? <Text numberOfLines={1} style={[styles.workMetaText, styles.shrink]}>{row.worktreeBranch}</Text> : null}
          </View>
        )}
        {canAccept && goal !== undefined ? <ExpandableSummary text={goal} /> : null}
        {row.changedAfterReady === true
          ? <Text style={styles.reopened}>{workReopenedLine(singleMode ? undefined : row.leadAgentName)}</Text>
          : null}
      </View>
    </View>
  )
  return (
    <>
      {/* Glass outermost, never inside a Pressable or a fading parent, or it renders flat. */}
      <GlassSurface radius={radius.panel} fallbackColor={colors.surface} style={styles.workCard}>
        {openSession === undefined ? head : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open Session ${row.title}`}
            onPress={openSession}
            style={({ pressed }) => pressed && styles.pressed}
          >
            {head}
          </Pressable>
        )}
        {report === undefined ? null : (
          <View style={styles.resultIndent}>
            <WorkResultBody
              result={report}
              blocked={workCardStatus(row)?.tone === 'warn'}
              sessionSettled={row.status === 'Settled'}
              waits={workResultWaits(row)}
              onShowCard={() => onReveal(row.key, 'end')}
              {...(openSession === undefined ? {} : { onOpenSession: openSession })}
            />
          </View>
        )}
        {canAccept ? (
          <RuntimeBlock
            open={detailsOpen}
            onToggle={() => setDetailsOpen((value) => !value)}
            disabled={accepting}
            runtime={singleMode ? runtime : undefined}
            attachments={workProposalAttachmentCount(row)}
            // A thread's card is always Single (2026-11-17); only a persona's card offers the mode.
            {...(row.threadAuthored === true ? {} : { mode: { value: mode, block: multipleBlock, onChange: chooseMode } })}
            onModel={() => setRuntimeOpen(true)}
            {...(proposedTask === undefined ? {} : { prompt: { edited: editedTask !== undefined, onOpen: () => setPromptDraft(editedTask ?? proposedTask) } })}
          />
        ) : null}
        {canAccept || canReject ? (
          <View style={styles.workActions}>
            {canAccept && row.worktreeAvailable ? <Checkbox label="Worktree" checked={isolate} disabled={accepting} onChange={setIsolate} compact /> : null}
            <View style={styles.grow} />
            {canReject ? <CardButton label="Reject" variant="quiet" disabled={accepting} onPress={() => { onReject(row.handoffId) }} /> : null}
            {canAccept ? <CardButton label={accepting ? 'Accepting…' : 'Accept'} variant="primary" disabled={accepting} busy={accepting} onPress={accept} /> : null}
          </View>
        ) : null}
        {error === null ? null : <Text accessibilityRole="alert" style={[styles.workError, { color: colors.danger }]}>{error}</Text>}
      </GlassSurface>
      <SingleRuntimeSheet
        open={runtimeOpen}
        override={runtime}
        fallback={runtime}
        allowAuto={false}
        disabled={accepting}
        onChange={(next) => {
          const driver = next.driver
          const model = next.model
          const effort = next.effort
          if (driver === undefined || model === undefined || effort === undefined) return
          if (driver === 'mock') return
          updateWorkProposal(row.handoffId, {
            runtime: {
              driver,
              model,
              effort,
              ...(next.speed === 'fast' ? { speed: 'fast' as const } : {}),
            },
          })
        }}
        onClose={() => setRuntimeOpen(false)}
      />
      {proposedTask === undefined ? null : (
        <WorkPromptSheet
          open={promptDraft !== null}
          title={row.title}
          draft={promptDraft ?? ''}
          onChange={setPromptDraft}
          onSave={() => {
            const task = (promptDraft ?? '').trim()
            setEditedTask(task === proposedTask ? undefined : task)
            setPromptDraft(null)
          }}
          onClose={() => setPromptDraft(null)}
        />
      )}
    </>
  )
}

/**
 * Who runs a proposal and what goes along, folded into one line under the summary:
 * the model and effort, the attachment count and a chevron. Open, the same line stays
 * where it was and heads a block on its own subtle fill, with a row for the model and
 * one for the prompt (and the mode on a persona's card). The block bleeds into the
 * card's padding by the inset it adds, so the header never shifts when it opens.
 */
function RuntimeBlock({ open, onToggle, disabled, runtime, attachments, mode, onModel, prompt }: {
  open: boolean
  onToggle: () => void
  disabled: boolean
  /** The Single runtime, or undefined while the card stands on Multiple. */
  runtime: SingleRuntime | undefined
  attachments: string | undefined
  mode?: { value: ChatMode; block: string | undefined; onChange: (mode: ChatMode) => void }
  onModel: () => void
  prompt?: { edited: boolean; onOpen: () => void }
}) {
  const runtimeName = runtime === undefined ? 'Multiple' : workProposalRuntimeName(runtime)
  const turn = useSharedValue(open ? 1 : 0)
  const still = useReducedMotion()
  useEffect(() => {
    turn.set(still ? (open ? 1 : 0) : withTiming(open ? 1 : 0, { duration: 180, easing: Easing.out(Easing.cubic) }))
  }, [open, turn, still])
  const chevron = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get() * 180}deg` }] }))
  const count = attachments === undefined ? null : (
    <View style={styles.count}>
      <HugeiconsIcon color={colors.dim} icon={Attachment01Icon} size={13} strokeWidth={1.7} />
      <Text numberOfLines={1} style={styles.countText}>{attachments}</Text>
    </View>
  )
  return (
    <View style={[styles.block, open && styles.blockOpen]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${runtimeName}${attachments === undefined ? '' : `, ${attachments}`}`}
        accessibilityHint={open ? 'Hides the Session details' : 'Shows the model and the prompt'}
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={({ pressed }) => [styles.blockHeader, pressed && styles.pressed]}
      >
        {runtime === undefined ? null : <ProviderMark driver={runtime.driver} size={13} />}
        <Text numberOfLines={1} style={styles.blockName}>{runtimeName}</Text>
        {count}
        <View style={styles.grow} />
        <Animated.View style={chevron}>
          <HugeiconsIcon color={colors.dim} icon={ArrowDown01Icon} size={16} strokeWidth={1.7} />
        </Animated.View>
      </Pressable>
      {open ? (
        <Animated.View entering={FadeIn.duration(180).reduceMotion(ReduceMotion.System)} exiting={FadeOut.duration(120).reduceMotion(ReduceMotion.System)}>
          {mode === undefined ? null : (
            <View style={styles.blockRow}>
              <Text style={styles.blockKey}>Mode</Text>
              <View style={styles.blockValue}>
                <SegmentedControl disabled={disabled} label="Chat mode" onChange={mode.onChange} options={mode.block === undefined ? MODE_OPTIONS : SINGLE_ONLY_OPTIONS} value={mode.value} />
              </View>
            </View>
          )}
          {mode?.block === undefined ? null : <Text style={styles.blockNote}>{mode.block}</Text>}
          {runtime === undefined ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Model, ${runtimeName}`}
              disabled={disabled}
              onPress={onModel}
              style={({ pressed }) => [styles.blockRow, pressed && styles.pressed]}
            >
              <Text style={styles.blockKey}>Model</Text>
              <Text numberOfLines={1} style={[styles.blockValue, styles.blockValueText]}>{runtimeName}</Text>
              <HugeiconsIcon color={colors.dim} icon={ArrowRight01Icon} size={16} strokeWidth={1.7} />
            </Pressable>
          )}
          {prompt === undefined ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Prompt, ${prompt.edited ? 'Edited prompt' : 'View prompt'}${attachments === undefined ? '' : `, ${attachments}`}`}
              disabled={disabled}
              onPress={prompt.onOpen}
              style={({ pressed }) => [styles.blockRow, pressed && styles.pressed]}
            >
              <Text style={styles.blockKey}>Prompt</Text>
              <View style={styles.blockValue}>
                <Text numberOfLines={1} style={[styles.blockValueText, styles.shrink]}>{prompt.edited ? 'Edited prompt' : 'View prompt'}</Text>
                {count}
              </View>
              <HugeiconsIcon color={colors.dim} icon={ArrowRight01Icon} size={16} strokeWidth={1.7} />
            </Pressable>
          )}
        </Animated.View>
      ) : null}
    </View>
  )
}

const SUMMARY_LINES = 2

/**
 * A proposal's summary, cut at the end of its second line. "Show more" appears only
 * when the text really runs past it: a copy laid out unclamped, out of sight, counts
 * the lines at this width.
 */
function ExpandableSummary({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const [truncated, setTruncated] = useState(false)
  return (
    <Animated.View layout={LinearTransition.duration(220).easing(Easing.out(Easing.exp)).reduceMotion(ReduceMotion.System)}>
      <View>
        <Text numberOfLines={open ? undefined : SUMMARY_LINES} style={styles.workTask}>{text}</Text>
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          onTextLayout={(event) => setTruncated(event.nativeEvent.lines.length > SUMMARY_LINES)}
          style={[styles.workTask, styles.measure]}
        >
          {text}
        </Text>
      </View>
      {truncated ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)}>
          <Text style={styles.showMore}>{open ? 'Show less' : 'Show more'}</Text>
        </Pressable>
      ) : null}
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.7 },
  grow: { flex: 1 },
  workCard: { gap: spacing.md, padding: 14 },
  workMain: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  workBody: { flex: 1, minWidth: 0, gap: spacing.xs },
  workHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titleLine: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  workTitle: { flexShrink: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 15, fontWeight: '500' },
  workMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 0 },
  projectBadge: { flexShrink: 1, maxWidth: '50%' },
  workMetaText: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12 },
  shrink: { flexShrink: 1 },
  workTask: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  // Laid out invisibly at the visible text's width, so the line count is real and not guessed.
  measure: { position: 'absolute', left: 0, right: 0, top: 0, opacity: 0 },
  showMore: { alignSelf: 'flex-start', marginTop: spacing.xs, color: colors.text, fontFamily: fonts.sans, fontSize: 13 },
  reopened: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  resultIndent: { marginTop: spacing.xs },
  // Bleeds by its own inset, so the header line keeps its place folded and open; the
  // corner is the card's less the 6pt gap left between the two edges.
  block: { marginHorizontal: -spacing.sm, paddingHorizontal: spacing.sm, borderRadius: radius.panel - 6, ...squircle },
  blockOpen: { backgroundColor: colors.chip },
  blockHeader: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  blockName: { flexShrink: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 13 },
  count: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  countText: { flexShrink: 1, color: colors.dim, fontFamily: fonts.sans, fontSize: 13 },
  blockRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  blockKey: { width: 56, color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  blockValue: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  blockValueText: { color: colors.text, fontFamily: fonts.sans, fontSize: 13 },
  blockNote: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12, paddingBottom: spacing.sm },
  doneRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderRadius: radius.sm, ...squircle, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.surface, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  doneText: { flex: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  doneTitle: { color: colors.text, fontWeight: '500' },
  tileTitle: { color: colors.text },
  tileMark: { width: 16, flexShrink: 0 },
  doneStatus: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  workError: { fontFamily: fonts.sans, fontSize: 13 },
  closedRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderRadius: radius.sm, ...squircle, borderWidth: StyleSheet.hairlineWidth, borderStyle: 'dashed', borderColor: colors.line, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  closedTitle: { flex: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 13, textDecorationLine: 'line-through' },
  replacedTitle: { flex: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  revision: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12 },
  forwardedRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderRadius: radius.sm, ...squircle, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  forwardedTitle: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 13 },
  forwardedLine: { flexShrink: 1, maxWidth: '60%' },
  forwardedReady: { color: colors.warning, fontWeight: '500' },
  closedLabel: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12 },
  workActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
})
