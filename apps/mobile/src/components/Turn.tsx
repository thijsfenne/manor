import Clock01Icon from '@hugeicons/core-free-icons/Clock01Icon'
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon'
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon'
import Brain02Icon from '@hugeicons/core-free-icons/Brain02Icon'
import CancelCircleIcon from '@hugeicons/core-free-icons/CancelCircleIcon'
import Copy01Icon from '@hugeicons/core-free-icons/Copy01Icon'
import NoteEditIcon from '@hugeicons/core-free-icons/NoteEditIcon'
import PencilEdit02Icon from '@hugeicons/core-free-icons/PencilEdit02Icon'
import ReplyIcon from '@hugeicons/core-free-icons/ReplyIcon'
import Search01Icon from '@hugeicons/core-free-icons/Search01Icon'
import CommandLineIcon from '@hugeicons/core-free-icons/CommandLineIcon'
import TextSelectionIcon from '@hugeicons/core-free-icons/TextSelectionIcon'
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon'
import ViewIcon from '@hugeicons/core-free-icons/ViewIcon'
import Wrench01Icon from '@hugeicons/core-free-icons/Wrench01Icon'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react-native'
import { ROUTINE_LATE_AFTER_MS, SECRET_CLOSED_TEXT, isSkippedAnswer, userInputAnswerText, type AgentConfig, type Project, type FileEdit, type EventImage, type MessageReply, type UserInputQuestion, type UserInputAnswers } from '@manor/contracts'
import {
  answerTextOf,
  fileWriteGroups,
  finishedSilent,
  personaOf,
  streamedMessages,
  type Persona,
  type ReasoningStep,
  type RoutineTrigger,
  type ToolStep,
  type TurnActivity as TurnStep,
  type TurnConsultation,
  type UnannouncedConsultation,
  type Row,
  type TurnRow,
} from '@manor/client-runtime/state'
import { changedFiles, changedTotals, turnChangedFiles, type ChangedFile } from '@manor/client-runtime/changed-files'
import {
  currentLabel,
  elapsedLabel,
  isEditTool,
  isReadTool,
  isSearchTool,
  isShellTool,
  workSummary,
} from '@manor/client-runtime/turn-labels'
import { activeCall, activityBlocks, type ActivityBlock, groupLabel, hasFold, hasStatus, isCompactNote, isCompacting, isPaused, isSettledCompactNote, shownSegments, statusShimmers, stepDetail, stepLabel, subagentStepState, traceRows, turnSummary, type TraceRow } from '@manor/client-runtime/turn-trace'
import { endFace, turnFace } from '@manor/client-runtime/face-activity'
import * as Clipboard from 'expo-clipboard'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Modal, Pressable, StyleSheet, View, useWindowDimensions, type AccessibilityState, type ColorValue } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { Easing, FadeIn, ReduceMotion, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'

import { Attachments } from '@/components/Attachments'
import { AgentStack } from '@/components/AgentStack'
import { DiffSheet } from '@/components/DiffSheet'
import { Blobatar } from '@/components/Blobatar'
import { useFaceState } from '@/lib/useFaceState'
import { Markdown, type MarkdownLinks } from '@/components/Markdown'
import { MemoryChangesSheet, hasMemoryChanges, memoryChangesLabel } from '@/components/MemoryChangesSheet'
import { MemoryTraceSheet } from '@/components/MemoryTraceSheet'
import type { DraftActions } from '@/components/OutboundDraftBubble'
import { OutboundDraftGroup } from '@/components/OutboundDraftGroup'
import { ShimmerText } from '@/components/ShimmerText'
import { TaskCard } from '@/components/TaskCard'
import { SubagentRows } from '@/components/SubagentRow'
import { useSubagentDirectory } from '@/lib/subagentContext'
import { DeliveredFiles } from '@/components/DeliveredFiles'
import { ConnectCards } from '@/components/ConnectCards'
import { Text } from '@/components/Text'
import type { QuoteSelectionSource } from '@/components/QuoteSelectionSheet'
import { colors, fonts, radius, spacing, squircle } from '@/theme'
import { useWindowInsets } from '@/lib/windowInsets'

/**
 * One persona's turn, read the way the Mac reads it: her face and name, the stable
 * turn status beside them, compact activity bundles, and what she said underneath.
 */
/** Another screen stands over this transcript, so its turns keep their folds as they settle. */
export const TranscriptCovered = createContext(false)

export function Turn({
  turn,
  agents,
  latest = false,
  repoFiles,
  links,
  connected = true,
  bubbleReplies = false,
  showSpeaker = true,
  threadProject,
  onReply,
  onQuoteSource,
  onOpenSubagent,
  draftActions,
  waitingOnAgentId,
  renderUser,
  memoryChanges: dmMemory,
  pinPlan = false,
}: {
  turn: TurnRow
  agents: AgentConfig[]
  /** In a DM: the memory writes this turn's reply shows, its own or handed to it by a turn without one. */
  memoryChanges?: TurnRow['memoryChanges']
  /** This is the latest reply in the transcript, the one face that moves fully; the rest blink. */
  latest?: boolean
  /** Every path the files sheet can place, when this is a project chat. */
  repoFiles?: string[]
  /** Where repo paths written in this reply open. */
  links?: MarkdownLinks
  /** Closing a draft travels over the socket, so an offline phone only reads them. */
  connected?: boolean
  /** Direct messages alone render assistant replies as incoming-message clouds. */
  bubbleReplies?: boolean
  /** False when the runtime voice is deliberately anonymous, as in a Single chat. */
  showSpeaker?: boolean
  threadProject?: Project
  /** Offered by DMs and groups once this turn has a finished visible answer. */
  onReply?: (reply: MessageReply) => void
  onQuoteSource?: (source: QuoteSelectionSource) => void
  /** Opens one helper's own screen from its row in this turn, by launch call id. */
  onOpenSubagent?: (toolCallId: string) => void
  draftActions?: DraftActions
  /** The peer this live turn is synchronously waiting on through message_agent. */
  waitingOnAgentId?: string
  /** Draws a steering message the user sent into this turn, with the transcript's own user-message renderer. */
  renderUser?: (row: Extract<Row, { kind: 'event' }>) => ReactNode
  /** In a Session: the plan stands once at the turn's end, the part of a running turn the list follows. */
  pinPlan?: boolean
}) {
  const persona = personaOf(agents, turn.agentId)
  const memoryChanges = bubbleReplies ? dmMemory : turn.memoryChanges
  const running = turn.live?.state === 'running'
  const faceState = useFaceState(turnFace(turn, waitingOnAgentId !== undefined), endFace(turn), running)
  // A turn the user steered mid-run carries its live text as `live` segments beside their
  // messages, so the loose stream below would draw it a second time. A DM holds a
  // reply back until it is whole; the working indicator at its foot says she is writing.
  const inlineUsers = turn.timeline.some((step) => step.kind === 'user')
  const streaming = inlineUsers || bubbleReplies ? [] : streamedMessages(turn.live)
  // A real failure keeps the one note that says why, except in a DM: there a broken turn
  // just ends and the user carries on by typing, so the reason moves into the trace.
  const plan = pinPlan ? turn.todos ?? [] : []
  const traced = useMemo(() => {
    const noted = bubbleReplies && turn.note?.kind === 'error'
      ? { ...turn, traceNotes: [...turn.traceNotes ?? [], { key: `note:${turn.key}`, text: turn.note.text }] }
      : turn
    return pinPlan && turn.todos !== undefined
      ? { ...noted, segments: noted.segments.filter((segment) => segment.kind !== 'todo') }
      : noted
  }, [bubbleReplies, pinPlan, turn])
  const showActivity = turn.live !== undefined || turn.segments.length > 0 || hasFold(traced)
  // Work keeps the live stream open. A DM never shows it live: the trace is evidence asked for afterwards.
  const quiet = threadProject !== undefined
  const [open, setOpen] = useState(bubbleReplies || quiet ? false : running)
  const [actionSource, setActionSource] = useState<QuoteSelectionSource | null>(null)
  const [copied, setCopied] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [changesOpen, setChangesOpen] = useState(false)
  // Changes already there on mount are history and do not animate; only the writer's
  // diff landing under an answer already on screen fades in.
  const [changesAtMount] = useState(() => hasMemoryChanges(memoryChanges))
  const [renderedAt] = useState(() => Date.now())
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const wasRunning = useRef(running)
  const covered = useContext(TranscriptCovered)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])
  useEffect(() => {
    if (running && !wasRunning.current && !bubbleReplies && !quiet) setOpen(true)
    // Under a subagent's screen the fold stays as it was, so the rows keep their place.
    if (!running && wasRunning.current && !covered) setOpen(false)
    wasRunning.current = running
  }, [running, bubbleReplies, quiet, covered])
  // A manual stop says Stopped on the turn, not in a note; a DM's failure lives in `traced`.
  const note = turn.note?.kind === 'aborted' || (bubbleReplies && turn.note?.kind === 'error') ? undefined : turn.note
  // A DM shows only whole messages: partial text a stop or failure cut off stays out.
  const standing = useMemo(
    () => bubbleReplies ? turn.tail.filter((segment) => segment.kind !== 'reply' || segment.interrupted !== true)
      : pinPlan ? turn.tail.filter((segment) => segment.kind !== 'todo') : turn.tail,
    [bubbleReplies, pinPlan, turn.tail],
  )
  const changed = useMemo(
    () =>
      running
        ? []
        : turnChangedFiles(turn, repoFiles),
    [repoFiles, running, turn],
  )
  const answerText = answerTextOf(turn.answer)
  const showFooter = !quiet && !running && turn.live === undefined && (answerText.length > 0 || turn.memoryTrace !== undefined || hasMemoryChanges(memoryChanges))
  const changesMark = hasMemoryChanges(memoryChanges) ? (
    <Animated.View entering={changesAtMount ? undefined : FadeIn.duration(360).reduceMotion(ReduceMotion.System)}>
      <FooterIconButton
        accessibilityLabel={`Memory updated, ${memoryChangesLabel(memoryChanges)}`}
        accessibilityState={{ expanded: changesOpen }}
        icon={NoteEditIcon}
        iconSize={15}
        onPress={() => setChangesOpen(true)}
      />
    </Animated.View>
  ) : null
  const copy = async (text: string, confirm = false) => {
    try {
      await Clipboard.setStringAsync(text)
    } catch {
      return
    }
    if (!confirm) return
    setCopied(true)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), 1_600)
  }
  const status = (
    <TurnStatus
      onToggle={() => setOpen((value) => !value)}
      open={open}
      turn={traced}
      runningLabel={waitingOnAgentId === undefined ? undefined : `${persona.name} is waiting on ${personaOf(agents, waitingOnAgentId).name}`}
    />
  )
  if (bubbleReplies && dmTurnDrawsNothing(turn)) return null
  const face = (
    <Blobatar
      animate={latest ? true : 'blink'}
      color={persona.color}
      name={persona.name}
      shape={persona.avatarShape}
      tone={persona.avatarTone}
      size={32}
      src={persona.avatar}
      working={running}
      face={faceState}
    />
  )
  const foldable = hasFold(traced)
  // A project thread on the phone is minimal: no face, status, trace, footer or changed files on its
  // turns. While one runs, the working label stands alone at the foot of the chat, without a face.
  // A finished DM turn has no face: the face lives only in the working indicator at the foot of
  // the chat. Its trace opens from a reply's long-press actions, and while it is open its
  // status stands under the bubbles, where a tap folds it shut again. Nothing while it runs.
  const header = quiet ? null : bubbleReplies ? (
    running || !open || !hasStatus(traced) ? null : <View style={styles.header}>{status}</View>
  ) : showSpeaker ? (
    <View style={styles.header}>
      {face}
      <Text numberOfLines={1} style={styles.name}>{persona.name}</Text>
      {status}
    </View>
  ) : hasStatus(turn) ? (
    <View style={styles.header}>{status}</View>
  ) : null
  // A DM turn that left nothing to sign keeps no status line either: it would stand over an empty gap.
  const signsBubble = standing.length > 0 || (turn.files?.length ?? 0) > 0 || (turn.connects?.length ?? 0) > 0
  return (
    <View style={styles.turn}>
      {bubbleReplies ? null : header}
      {showActivity ? (
        <TurnActivity
          agents={agents}
          bubble={bubbleReplies}
          connected={connected}
          open={open}
          persona={persona}
          quiet={quiet}
          turn={traced}
          {...(onOpenSubagent === undefined ? {} : { onOpenSubagent })}
          {...(renderUser === undefined ? {} : { renderUser })}
          {...(draftActions === undefined ? {} : { draftActions })}
        />
      ) : null}
      {finishedSilent(turn) && threadProject === undefined ? <Note text={showSpeaker ? `${persona.name} finished without a reply.` : 'Finished without a reply.'} /> : null}
      {standing.map((segment) =>
        segment.kind === 'reply' ? (
          <Reply
            agents={agents}
            bubble={bubbleReplies}
            images={segment.images}
            key={segment.key}
            links={links}
            quoteAgentId={turn.agentId}
            quoteSources={segment.quoteSources}
            onLongPressSource={bubbleReplies && showFooter || onQuoteSource !== undefined ? setActionSource : undefined}
            {...(!bubbleReplies || onReply === undefined || !showFooter
              ? {}
              : {
                  onSwipeReply: () => onReply({
                    turnId: turn.turnId,
                    agentId: turn.agentId,
                    text: segment.text,
                  }),
                })}
            text={segment.text}
          />
        ) : segment.kind === 'user' ? (
          <View key={segment.key}>{renderUser?.(segment.row)}</View>
        ) : segment.kind === 'todo' ? (
          <TaskCard foldKey={segment.key} key={segment.key} tasks={segment.todos} />
        ) : segment.kind === 'draft' ? (
          <OutboundDraftGroup
            bubble={bubbleReplies}
            connected={connected}
            drafts={segment.drafts}
            key={segment.key}
            {...(draftActions === undefined ? {} : { actions: draftActions })}
          />
        ) : (
          <AskAnswers answers={segment.ask.answers} key={segment.key} questions={segment.ask.questions} />
        ),
      )}
      {streaming.map((message) =>
        message.text.length === 0 ? null : <Reply agents={agents} bubble={bubbleReplies} key={`live:${message.messageId}`} links={links} text={message.text} />,
      )}
      {turn.files === undefined ? null : <DeliveredFiles files={turn.files} />}
      {turn.connects === undefined ? null : <ConnectCards cards={turn.connects} />}
      {turn.fileWrites === undefined || turn.fileWrites.length === 0 ? null : <FileWriteFootnote writes={turn.fileWrites} />}
      {plan.length === 0 ? null : (
        <View style={styles.plan}>
          <TaskCard foldKey={`plan:${turn.key}`} label="Plan" tasks={plan} />
        </View>
      )}
      {bubbleReplies || quiet || changed.length === 0 ? null : <ChangedFilesCard files={changed} />}
      {bubbleReplies && signsBubble ? header : null}
      {bubbleReplies || !showFooter ? null : (
        <View style={styles.messageFooter}>
          {answerText.length === 0 ? null : (
            <FooterIconButton
              accessibilityLabel={copied ? 'Copied' : 'Copy the reply'}
              icon={copied ? Tick02Icon : Copy01Icon}
              onPress={() => void copy(answerText, true)}
            />
          )}
          {onReply === undefined || answerText.length === 0 ? null : (
            <FooterIconButton
              accessibilityLabel="Reply to this message"
              icon={ReplyIcon}
              onPress={() => onReply({ turnId: turn.turnId, agentId: turn.agentId, text: answerText })}
            />
          )}
          {turn.memoryTrace === undefined ? null : (
            <FooterIconButton
              accessibilityLabel="Memory used"
              accessibilityState={{ expanded: memoryOpen }}
              icon={Brain02Icon}
              iconSize={15}
              onPress={() => setMemoryOpen(true)}
            />
          )}
          {changesMark}
          <View style={styles.messageFooterSpace} />
          {turn.endedAt === undefined ? null : (
            <Text style={styles.messageTime}>{messageTime(turn.endedAt, renderedAt)}</Text>
          )}
        </View>
      )}
      {note === undefined || isCompactNote(note) || (threadProject !== undefined && note.kind === 'info') ? null : <Note kind={note.kind} text={note.text} />}
      {turn.memoryTrace === undefined ? null : (
        <MemoryTraceSheet onClose={() => setMemoryOpen(false)} open={memoryOpen} trace={turn.memoryTrace} />
      )}
      {hasMemoryChanges(memoryChanges) ? (
        <MemoryChangesSheet changes={memoryChanges} onClose={() => setChangesOpen(false)} open={changesOpen} />
      ) : null}
      {actionSource === null ? null : (
        <TurnActions
          canCopy={!quiet && actionSource.text.length > 0}
          canReply={onReply !== undefined && actionSource.text.length > 0}
          canQuote={onQuoteSource !== undefined && actionSource.text.length > 0}
          hasMemory={!quiet && turn.memoryTrace !== undefined}
          hasMemoryChanges={!quiet && hasMemoryChanges(memoryChanges)}
          trace={bubbleReplies && foldable ? (open ? 'open' : 'closed') : undefined}
          onTrace={() => {
            setActionSource(null)
            setOpen((value) => !value)
          }}
          onClose={() => setActionSource(null)}
          onCopy={() => void copy(actionSource.text)}
          onMemory={() => {
            setActionSource(null)
            setMemoryOpen(true)
          }}
          onMemoryChanges={() => {
            setActionSource(null)
            setChangesOpen(true)
          }}
          onQuote={() => {
            setActionSource(null)
            onQuoteSource?.(actionSource)
          }}
          onReply={() => {
            setActionSource(null)
            onReply?.({ turnId: turn.turnId, agentId: turn.agentId, text: actionSource.text })
          }}
        />
      )}
    </View>
  )
}

/**
 * A DM turn with nothing of its own to show. A stop or a break: in a DM nothing would carry
 * it, where a Session's header still says Stopped. Or a turn still at work that has not
 * finished a message or a card yet: the working indicator at the foot speaks for it.
 * The transcript leaves such a turn out of its list, because a row that renders nothing
 * still takes a slot, and every slot inserted above the indicator moves it.
 */
export function dmTurnDrawsNothing(turn: TurnRow): boolean {
  // Partial text a stop or failure cut off stays out of a DM, as `standing` drops it.
  const standing = turn.tail.some((segment) => segment.kind !== 'reply' || segment.interrupted !== true)
  if (standing || (turn.files?.length ?? 0) > 0 || (turn.connects?.length ?? 0) > 0 || turn.fileWrites !== undefined) return false
  if (turn.live?.state === 'running') return !turn.segments.some(liveCard)
  return turn.note?.kind === 'error' || turn.note?.kind === 'aborted'
}

/** A card a running DM turn shows before its reply is whole: a draft, a todo list, or a question already answered. */
const liveCard = (segment: TurnRow['segments'][number]): boolean =>
  segment.kind === 'draft'
  || (segment.kind === 'todo' && segment.todos.length > 0)
  || (segment.kind === 'ask' && segment.ask.answers !== undefined)

/** A compact, anchored menu into the standing pairs a stacked marker names. */
export function ConsultedAgents({
  action,
  consultations,
  agents,
  onOpen,
  unannounced,
}: {
  action: 'Messaged' | 'Message from'
  consultations: readonly TurnConsultation[]
  agents: AgentConfig[]
  onOpen: (chatId: string) => void
  /** Set when the asking turn said nothing: the menu then names each question. */
  unannounced?: readonly UnannouncedConsultation[]
}) {
  const triggerRef = useRef<View>(null)
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
  const { width, height } = useWindowDimensions()
  const insets = useWindowInsets()
  const agentIds = consultations.map((consultation) => consultation.agentId)
  const names = agentIds.map((agentId) => personaOf(agents, agentId).name)
  const count = consultations.length
  const repliesFollow = unannounced?.some((entry) => entry.replyPending) === true

  const show = () => {
    triggerRef.current?.measureInWindow((x, y, measuredWidth, measuredHeight) => {
      const menuHeight = consultations.length * (unannounced === undefined ? 52 : 64) + spacing.sm * 2
      const below = y + measuredHeight + spacing.xs
      const top = below + menuHeight <= height - insets.bottom - spacing.md
        ? below
        : Math.max(insets.top + spacing.md, y - spacing.xs - menuHeight)
      setAnchor({ top, right: Math.max(spacing.md, width - x - measuredWidth) })
    })
  }

  return (
    <>
      <Pressable
        accessibilityLabel={`${action} ${names.join(', ')}${repliesFollow ? ', replies follow' : ''}`}
        accessibilityRole="button"
        accessibilityState={{ expanded: anchor !== null }}
        onPress={show}
        ref={triggerRef}
        style={({ pressed }) => [styles.consultedTrigger, pressed && styles.pressed]}
      >
        <Text style={styles.consultedText}>{action}</Text>
        <AgentStack agentIds={agentIds} agents={agents} size={18} />
        <Text style={styles.consultedText}>{count} {count === 1 ? 'agent' : 'agents'}{repliesFollow ? ', replies follow' : ''}</Text>
      </Pressable>
      {anchor === null ? null : (
        <Modal animationType="fade" onRequestClose={() => setAnchor(null)} statusBarTranslucent transparent visible>
          <View style={StyleSheet.absoluteFill}>
            <Pressable
              accessibilityLabel="Close consulted agents"
              accessibilityRole="button"
              onPress={() => setAnchor(null)}
              style={StyleSheet.absoluteFill}
            />
            <View style={[styles.consultedMenu, anchor]}>
              {consultations.map((consultation) => {
                const persona = personaOf(agents, consultation.agentId)
                const question = unannounced?.find((entry) => entry.agentId === consultation.agentId)?.question
                return (
                  <Pressable
                    accessibilityLabel={`Open ${persona.name} pair chat`}
                    accessibilityRole="button"
                    key={consultation.agentId}
                    onPress={() => {
                      setAnchor(null)
                      onOpen(consultation.pairChatId)
                    }}
                    style={({ pressed }) => [styles.consultedRow, pressed && styles.actionRowPressed]}
                  >
                    <Blobatar color={persona.color} name={persona.name} shape={persona.avatarShape} tone={persona.avatarTone} size={26} src={persona.avatar} />
                    {question === undefined ? (
                      <Text numberOfLines={1} style={styles.consultedName}>{persona.name}</Text>
                    ) : (
                      <View style={styles.consultedLabel}>
                        <Text numberOfLines={1} style={styles.consultedName}>{persona.name}</Text>
                        <Text numberOfLines={1} style={styles.consultedQuestion}>“{question}”</Text>
                      </View>
                    )}
                  </Pressable>
                )
              })}
            </View>
          </View>
        </Modal>
      )}
    </>
  )
}

/**
 * What a project thread turn wrote to its own files, as one dim line under the reply.
 * A tap unfolds the lines it touched; one kind of write is already named on the line.
 */
function FileWriteFootnote({ writes }: { writes: NonNullable<TurnRow['fileWrites']> }) {
  const [open, setOpen] = useState(false)
  const groups = useMemo(() => fileWriteGroups(writes), [writes])
  const hasLines = groups.some((group) => group.lines.length > 0)
  const label = groups.map((group) => group.label).join(', ')
  return (
    <View style={styles.footnote}>
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        accessibilityState={hasLines ? { expanded: open } : { disabled: true }}
        disabled={!hasLines}
        onPress={() => setOpen((current) => !current)}
        style={({ pressed }) => [styles.footnoteButton, pressed && styles.footerButtonPressed]}
      >
        <HugeiconsIcon color={colors.dim} icon={Tick02Icon} size={13} strokeWidth={1.8} />
        <Text numberOfLines={1} style={styles.footnoteLabel}>{label}</Text>
        {hasLines ? <HugeiconsIcon color={colors.dim} icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={13} strokeWidth={1.8} /> : null}
      </Pressable>
      {open ? (
        <View style={styles.footnoteLines}>
          {groups.map((group) => group.lines.length === 0 ? null : (
            <View key={group.label}>
              {groups.length === 1 ? null : <Text style={styles.footnoteGroup}>{group.label}</Text>}
              {group.lines.map((line, index) => <Text key={index} style={styles.footnoteLine}>{line}</Text>)}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  )
}

/** The same quiet 28pt transcript action as the Mac footer, without glass. */
function FooterIconButton({
  accessibilityLabel,
  accessibilityState,
  icon,
  iconSize = 14,
  onPress,
}: {
  accessibilityLabel: string
  accessibilityState?: AccessibilityState
  icon: IconSvgElement
  iconSize?: number
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [styles.footerButton, pressed && styles.footerButtonPressed]}
    >
      {({ pressed }) => (
        <HugeiconsIcon color={pressed ? colors.text : colors.muted} icon={icon} size={iconSize} strokeWidth={1.8} />
      )}
    </Pressable>
  )
}

/** Secondary actions for the one beat that was held. */
function TurnActions({
  canCopy,
  canReply,
  canQuote,
  hasMemory,
  hasMemoryChanges,
  trace,
  onTrace,
  onClose,
  onCopy,
  onReply,
  onQuote,
  onMemory,
  onMemoryChanges,
}: {
  canCopy: boolean
  canReply: boolean
  canQuote: boolean
  hasMemory: boolean
  hasMemoryChanges: boolean
  /** A DM turn's folded work, reached here because its bubbles carry no status line. */
  trace: 'open' | 'closed' | undefined
  onTrace: () => void
  onClose: () => void
  onCopy: () => void
  onReply: () => void
  onQuote: () => void
  onMemory: () => void
  onMemoryChanges: () => void
}) {
  const insets = useWindowInsets()
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible>
      <View style={[styles.actionScrim, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
        <Pressable
          accessibilityLabel="Close message actions"
          accessibilityRole="button"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.actionMenu}>
          {canCopy ? <ActionRow icon={Copy01Icon} label="Copy" onPress={() => { onClose(); onCopy() }} /> : null}
          {canReply ? <ActionRow icon={ReplyIcon} label="Reply" onPress={onReply} /> : null}
          {canQuote ? <ActionRow icon={TextSelectionIcon} label="Quote text" onPress={onQuote} /> : null}
          {hasMemory ? <ActionRow icon={Brain02Icon} label="Memory used" onPress={onMemory} /> : null}
          {hasMemoryChanges ? <ActionRow icon={NoteEditIcon} label="Memory updated" onPress={onMemoryChanges} /> : null}
          {trace === undefined ? null : <ActionRow icon={Wrench01Icon} label={trace === 'open' ? 'Hide work' : 'Show work'} onPress={onTrace} />}
        </View>
      </View>
    </Modal>
  )
}

function ActionRow({
  icon,
  label,
  onPress,
}: {
  icon: IconSvgElement
  label: string
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.actionRow, pressed && styles.actionRowPressed]}
    >
      <HugeiconsIcon color={colors.text} icon={icon} size={19} strokeWidth={1.8} />
      <Text style={styles.actionLabel}>{label}</Text>
    </Pressable>
  )
}

/**
 * The stable turn status beside the name owns the outer fold; activity bundles keep
 * their own inner accordions. Stopping a running turn is the composer's send button
 * turning into a stop, so the status line stays a label and never a control.
 */
function TurnStatus({
  turn,
  open,
  onToggle,
  runningLabel,
}: {
  turn: TurnRow
  open: boolean
  onToggle: () => void
  runningLabel?: string
}) {
  const running = turn.live?.state === 'running'
  // An open trace shows Compacting in its own row, so the status keeps Working then.
  const compacting = !open && isCompacting(turn)
  const [now, setNow] = useState(() => Date.now())
  const foldable = hasFold(turn)
  const summary = running && runningLabel !== undefined && !compacting ? runningLabel : turnSummary(turn, open)
  // An open trace's Compacting row is then the only thing that shimmers.
  const shimmers = statusShimmers(summary) && !(open && isCompacting(turn))

  useEffect(() => {
    if (!running) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [running])

  if (!hasStatus(turn) || (summary === '' && !running && !foldable)) return null

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={foldable ? { expanded: open } : undefined}
      disabled={!foldable}
      hitSlop={8}
      onPress={onToggle}
      style={styles.status}
    >
      {summary === '' ? null : shimmers ? (
        <ShimmerText style={styles.statusText} text={summary} />
      ) : (
        <Text numberOfLines={1} style={styles.statusText}>{summary}</Text>
      )}
      {running && !compacting ? (
        <Text style={styles.statusDim}>
          {isPaused(turn) ? '' : 'for '}{elapsedLabel(turn.live?.startedAt, now)}
        </Text>
      ) : null}
      {foldable ? (
        <View style={[styles.chevron, open && styles.chevronOpen]}>
          <HugeiconsIcon color={colors.dim} icon={ArrowDown01Icon} size={13} strokeWidth={1.8} />
        </View>
      ) : null}
    </Pressable>
  )
}

function TurnActivity({
  turn,
  persona,
  agents,
  open,
  connected,
  draftActions,
  onOpenSubagent,
  renderUser,
  quiet = false,
  bubble = false,
}: {
  renderUser?: (row: Extract<Row, { kind: 'event' }>) => ReactNode
  /** A project thread keeps its asks, todos and drafts but no tool or helper rows. */
  quiet?: boolean
  /** A DM keeps its helpers in the fold: they are Session work, and the sheet reaches them. */
  bubble?: boolean
  turn: TurnRow
  persona: Persona
  agents: AgentConfig[]
  open: boolean
  connected: boolean
  draftActions?: DraftActions
  onOpenSubagent?: (toolCallId: string) => void
}) {
  const running = turn.live?.state === 'running'
  const visible = shownSegments(turn.segments).filter((segment) => {
    if (segment.kind === 'ask') return segment.ask.answers !== undefined || !running
    if (segment.kind === 'todo') return segment.todos.length > 0
    return true
  })
  const blocks = activityBlocks(visible)
  // Helpers stay visible in a folded turn while it runs, and a batch of them while any
  // of its children still works past it; settled, they fold. A project thread and a DM show none.
  const directory = useSubagentDirectory()
  const displayed = open
    ? blocks
    : blocks.filter((segment) => segment.kind === 'ask' || segment.kind === 'todo' || segment.kind === 'draft'
      // His steering messages are his words, not work, and a reply still streaming beside them stays in view.
      || segment.kind === 'user'
      || (running && segment.kind === 'reply' && segment.live === true)
      || (!quiet && !bubble && segment.kind === 'subagents' && (running || segment.agents.some((step) => subagentStepState(step, running, directory) === 'running'))))
  const active = activeCall(turn, blocks)
  const compactRecord = open && isSettledCompactNote(turn.note) ? turn.note : undefined
  // Manor's bookkeeping about this turn: there for whoever opens the trace, nowhere else.
  const traceNotes = open ? turn.traceNotes ?? [] : []
  const compacting = open && isCompacting(turn)
  if (displayed.length === 0 && compactRecord === undefined && traceNotes.length === 0 && !compacting) return null

  return (
    <View style={styles.activity}>
      {open && turn.routineTrigger !== undefined ? <RoutineTriggerRow trigger={turn.routineTrigger} /> : null}
      {displayed.map((segment) => (
        <Segment
          accent={persona.color}
          bubble={bubble}
          activeTool={segment.kind === 'bundle' && segment.key === active?.key ? active.tool : undefined}
          agents={agents}
          connected={connected}
          key={segment.key}
          onOpenSubagent={onOpenSubagent}
          renderUser={renderUser}
          running={running}
          segment={segment}
          activities={turn.activities}
          {...(draftActions === undefined ? {} : { draftActions })}
        />
      ))}
      {compactRecord === undefined ? null : (
        <Text style={styles.stepText}>{compactRecord.text}</Text>
      )}
      {traceNotes.map((traced) => <Text key={traced.key} selectable style={styles.stepText}>{traced.text}</Text>)}
      {compacting ? <ShimmerText style={styles.stepText} text="Compacting" /> : null}
    </View>
  )
}

function Segment({
  segment,
  activeTool,
  accent,
  agents,
  bubble,
  connected,
  draftActions,
  onOpenSubagent,
  renderUser,
  running,
  activities,
}: {
  renderUser?: ((row: Extract<Row, { kind: 'event' }>) => ReactNode) | undefined
  segment: ActivityBlock
  running: boolean
  activities: readonly TurnStep[]
  activeTool?: ToolStep
  accent: string
  agents: AgentConfig[]
  bubble: boolean
  connected: boolean
  draftActions?: DraftActions
  onOpenSubagent: ((toolCallId: string) => void) | undefined
}) {
  switch (segment.kind) {
    case 'user':
      return renderUser === undefined ? null : <>{renderUser(segment.row)}</>
    case 'reply':
      return <Reply agents={agents} images={segment.images} text={segment.text} />
    case 'ask':
      return <AskAnswers answers={segment.ask.answers} questions={segment.ask.questions} />
    case 'todo':
      return <TaskCard foldKey={segment.key} tasks={segment.todos} />
    case 'draft':
      return (
        <OutboundDraftGroup
          bubble={bubble}
          connected={connected}
          drafts={segment.drafts}
          {...(draftActions === undefined ? {} : { actions: draftActions })}
        />
      )
    case 'bundle':
      return <WorkRun accent={accent} activeTool={activeTool} breaks={segment.breaks} edits={segment.edits} steps={segment.steps} />
    case 'subagents':
      return <SubagentRows activities={activities} agents={segment.agents} onOpen={onOpenSubagent} running={running} />
  }
}

/** Past this many top-level rows an opened run folds its oldest steps behind one line. */
const TRACE_VISIBLE = 12
/** Half the trace's row gap, so neighbouring rows tile the column without overlapping hit areas. */
const ROW_HIT_SLOP = { top: 4, bottom: 4 } as const

/** One compact activity bundle between two narration messages. */
function WorkRun({ steps, edits, breaks, activeTool, accent }: { steps: TurnStep[]; edits: FileEdit[]; breaks: ReadonlySet<string>; activeTool?: ToolStep; accent: string }) {
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const current = activeTool?.status === 'error' ? undefined : activeTool
  const summary = workSummary(steps, edits.length > 0)
  const label = current === undefined ? summary.label : currentLabel(current)
  const trace = useMemo(() => (open ? traceRows(steps, breaks) : []), [open, steps, breaks])
  const hidden = showAll ? 0 : Math.max(trace.length - TRACE_VISIBLE, 0)
  const shown = hidden > 0 ? trace.slice(-TRACE_VISIBLE) : trace
  const currentIsInRows = current !== undefined && steps.some((step) => step.key === current.key)

  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)} style={styles.stepRow}>
        {current === undefined ? (
          <Text numberOfLines={2} style={styles.stepText}>{label}</Text>
        ) : (
          <ShimmerText numberOfLines={2} style={styles.stepText} text={label} />
        )}
        <View style={[styles.chevron, styles.bundleChevron, open && styles.chevronOpen]}>
          <HugeiconsIcon color={colors.dim} icon={ArrowDown01Icon} size={12} strokeWidth={1.8} />
        </View>
      </Pressable>
      {open ? (
        <View style={styles.traceList}>
          {edits.length === 0 ? null : <EditRows edits={edits} />}
          {hidden > 0 ? (
            <Pressable accessibilityRole="button" hitSlop={ROW_HIT_SLOP} onPress={() => setShowAll(true)}>
              <Text style={styles.stepText}>Show {hidden} earlier {hidden === 1 ? 'step' : 'steps'}</Text>
            </Pressable>
          ) : null}
          {shown.map((row) => (
            <TraceItem accent={accent} current={current} key={row.key} row={row} />
          ))}
          {current === undefined || currentIsInRows ? null : (
            <ToolRow accent={accent} active key={`active:${current.key}`} step={current} />
          )}
        </View>
      ) : null}
    </View>
  )
}

function TraceItem({ row, current, accent }: { row: TraceRow; current: ToolStep | undefined; accent: string }) {
  if (row.kind === 'reasoning') return <ReasoningRow step={row.step} />
  if (row.kind === 'tool') return <ToolRow accent={accent} active={row.step.key === current?.key} step={row.step} />
  return <GroupRow accent={accent} current={current} group={row} />
}

/** Consecutive reads, searches or identical calls on one line; tap for the calls themselves. */
function GroupRow({ group, current, accent }: { group: Extract<TraceRow, { kind: 'group' }>; current: ToolStep | undefined; accent: string }) {
  const [open, setOpen] = useState(false)
  const live = current !== undefined && group.steps.some((step) => step.key === current.key)
  const icon = group.family === 'read' ? ViewIcon : group.family === 'search' ? Search01Icon : toolIcon(group.steps[0]!.tool)
  return (
    <View style={styles.traceItem}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} hitSlop={ROW_HIT_SLOP} onPress={() => setOpen((value) => !value)} style={styles.stepRow}>
        <StepIcon color={live ? accent : colors.dim} icon={icon} />
        {live ? (
          <ShimmerText numberOfLines={1} style={styles.stepText} text={currentLabel(current)} />
        ) : (
          <Text numberOfLines={1} style={styles.stepText}>{groupLabel(group)}</Text>
        )}
        {group.family === 'same' ? <Text style={styles.stepCount}>×{group.steps.length}</Text> : null}
      </Pressable>
      {open ? (
        <View style={styles.groupMembers}>
          {group.steps.map((step) => (
            <ToolRow accent={accent} active={step.key === current?.key} key={step.key} step={step} />
          ))}
        </View>
      ) : null}
    </View>
  )
}

/** A step row's leading glyph. HugeiconsIcon drops `style`, so the offset sits on a wrapper. */
function StepIcon({ icon, color }: { icon: IconSvgElement; color: ColorValue }) {
  return (
    <View style={styles.stepIcon}>
      <HugeiconsIcon color={color} icon={icon} size={14} strokeWidth={1.8} />
    </View>
  )
}

function EditRows({ edits }: { edits: FileEdit[] }) {
  const files = useMemo(() => changedFiles(edits), [edits])
  return (
    <>
      {files.map((file) => (
        <View key={file.raw} style={styles.stepRow}>
          <StepIcon color={colors.dim} icon={PencilEdit02Icon} />
          <Text numberOfLines={1} style={styles.stepText}>
            {file.status === 'created' ? 'Created' : file.status === 'deleted' ? 'Deleted' : 'Edited'} {tail(file.path)}
          </Text>
          <ChangeStat added={file.added} removed={file.removed} />
        </View>
      ))}
    </>
  )
}

function ReasoningRow({ step }: { step: ReasoningStep }) {
  const [open, setOpen] = useState(false)
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)} style={styles.stepRow}>
      <StepIcon color={colors.dim} icon={Brain02Icon} />
      <Text numberOfLines={open ? undefined : 1} selectable={open} style={[styles.stepText, styles.thought]}>
        {open ? step.text : firstLine(step.text)}
      </Text>
    </Pressable>
  )
}

const TRIGGER_CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
const TRIGGER_DUE = new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

/** The routine fire behind a DM turn, as the fold's first line; tap for the prompt. */
function RoutineTriggerRow({ trigger }: { trigger: RoutineTrigger }) {
  const [open, setOpen] = useState(false)
  const late = trigger.dueAt !== undefined && trigger.ts - trigger.dueAt > ROUTINE_LATE_AFTER_MS
  const label = `Routine${trigger.name === undefined ? '' : `, ${trigger.name}`}, ${TRIGGER_CLOCK.format(new Date(trigger.ts))}${
    late && trigger.dueAt !== undefined ? `, late, due ${TRIGGER_DUE.format(new Date(trigger.dueAt))}` : ''}`
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)} style={styles.stepRow}>
      <StepIcon color={colors.dim} icon={Clock01Icon} />
      <View style={styles.triggerCopy}>
        <Text style={[styles.stepText, styles.trigger]}>{label}</Text>
        {open ? <Text selectable style={[styles.stepText, styles.trigger]}>{trigger.prompt}</Text> : null}
      </View>
    </Pressable>
  )
}

function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0)?.trim() ?? 'Thought'
  return line.length > 110 ? `${line.slice(0, 107)}…` : line
}

function toolIcon(tool: string) {
  if (isReadTool(tool)) return ViewIcon
  if (isSearchTool(tool)) return Search01Icon
  if (isEditTool(tool)) return PencilEdit02Icon
  if (isShellTool(tool)) return CommandLineIcon
  return Wrench01Icon
}

function ToolRow({ step, active, accent }: { step: ToolStep; active: boolean; accent: string }) {
  const [open, setOpen] = useState(false)
  const current = active && step.status !== 'error'
  const label = stepLabel(step, active)
  const detail = stepDetail(step)
  const row = (
    <>
      <StepIcon color={current ? accent : colors.dim} icon={step.status === 'error' ? CancelCircleIcon : toolIcon(step.tool)} />
      {current ? <ShimmerText numberOfLines={1} style={styles.stepText} text={label} /> : <Text numberOfLines={1} style={styles.stepText}>{label}</Text>}
    </>
  )
  if (detail === undefined) return <View style={styles.stepRow}>{row}</View>
  return (
    <View style={styles.traceItem}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} hitSlop={ROW_HIT_SLOP} onPress={() => setOpen((value) => !value)} style={styles.stepRow}>
        {row}
      </Pressable>
      {open ? (
        <View style={styles.stepDetail}>
          {detail.error === undefined ? null : <Text selectable style={styles.detailText}>{detail.error}</Text>}
          {detail.targets?.map((target, index) => (
            <Text key={`${index}:${target}`} selectable style={styles.detailPath}>{target}</Text>
          ))}
          {(detail.command ?? detail.query) === undefined ? null : <Text selectable style={styles.detailCommand}>{detail.command ?? detail.query}</Text>}
        </View>
      ) : null}
    </View>
  )
}

function AskAnswers({ questions, answers }: { questions: readonly UserInputQuestion[]; answers?: UserInputAnswers }) {
  return (
    <View style={styles.card}>
      {questions.map((question) => {
        const given = answers?.[question.id]
        return (
          <View key={question.id} style={styles.askItem}>
            {question.header ? <Text style={styles.askHeader}>{question.header}</Text> : null}
            <Text style={styles.askQuestion}>{question.question}</Text>
            {given === undefined ? (
              <Text style={styles.askMissing}>{question.secret === undefined ? 'Never answered. The turn ended first.' : SECRET_CLOSED_TEXT}</Text>
            ) : (
              // A passed over question says so. The answer itself is a line meant for the model.
              <Text style={isSkippedAnswer(given) ? styles.askSkipped : styles.askAnswer}>{isSkippedAnswer(given) ? 'Skipped' : userInputAnswerText(given)}</Text>
            )}
          </View>
        )
      })}
    </View>
  )
}

function Reply({
  text,
  images = [],
  agents,
  links,
  quoteSources,
  quoteAgentId,
  onLongPressSource,
  onSwipeReply,
  bubble = false,
}: {
  text: string
  images?: readonly EventImage[]
  agents: AgentConfig[]
  links?: MarkdownLinks
  quoteSources?: readonly { eventId: string; text: string }[]
  quoteAgentId?: string
  onLongPressSource?: (source: QuoteSelectionSource) => void
  onSwipeReply?: () => void
  bubble?: boolean
}) {
  const drag = useSharedValue(0)
  const pan = Gesture.Pan()
    .enabled(onSwipeReply !== undefined)
    .activeOffsetX(12)
    .failOffsetY([-10, 10])
    .onUpdate((event) => drag.set(Math.max(0, Math.min(event.translationX, 72))))
    .onEnd((event) => {
      if (onSwipeReply !== undefined && (drag.get() >= 52 || event.velocityX >= 650)) {
        runOnJS(onSwipeReply)()
      }
    })
    .onFinalize(() => drag.set(withTiming(0, { duration: 160, easing: Easing.linear })))
  const swipeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: drag.get() }] }))

  return (
    <View style={[styles.replySwipe, bubble && styles.replySwipeBubble]}>
      {onSwipeReply === undefined ? null : (
        <View style={styles.replyCue}>
          <HugeiconsIcon color={colors.dim} icon={ReplyIcon} size={21} strokeWidth={1.8} />
        </View>
      )}
      <GestureDetector gesture={pan}>
        <Animated.View style={[swipeStyle, styles.reply, bubble && styles.replyBubble]}>
          {quoteSources !== undefined && quoteSources.length > 0 ? quoteSources.map((source) => (
            <Pressable
              accessibilityHint={onLongPressSource === undefined ? undefined : 'Press and hold for actions'}
              delayLongPress={360}
              disabled={onLongPressSource === undefined}
              key={source.eventId}
              onLongPress={onLongPressSource === undefined ? undefined : () => onLongPressSource({ ...source, ...(quoteAgentId === undefined ? {} : { agentId: quoteAgentId }) })}
            >
              <Markdown agents={agents} links={links} text={source.text} />
            </Pressable>
          )) : text === '' ? null : <Markdown agents={agents} links={links} text={text} />}
            <Attachments images={images} />
        </Animated.View>
      </GestureDetector>
    </View>
  )
}

function Note({ text, kind = 'info' }: { text: string; kind?: 'info' | 'error' | 'aborted' }) {
  return <Text style={[styles.note, kind === 'error' && styles.noteError]}>{text}</Text>
}

/**
 * A finished turn's edits, as the claim only: this many files, this much either way,
 * and the first few names. The evidence lives one tap away in its own sheet, because
 * a diff is taller than the message that explains it and inline it buries the
 * conversation it belongs to. Unknown line counts stay unknown instead of rendering
 * as +0 and -0.
 */
function ChangedFilesCard({ files }: { files: ChangedFile[] }) {
  const [open, setOpen] = useState(false)
  const totals = useMemo(() => changedTotals(files), [files])
  const shown = files.slice(0, CARD_FILES)
  const rest = files.length - shown.length

  return (
    <>
      <Pressable
        accessibilityLabel={`View the changes in ${files.length} ${files.length === 1 ? 'file' : 'files'}`}
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.changedCard, pressed && styles.pressed]}
      >
        <View style={styles.changedHeader}>
          <Text style={styles.changedTitle}>{files.length} changed {files.length === 1 ? 'file' : 'files'}</Text>
          <ChangeStat added={totals.added} removed={totals.removed} />
        </View>
        {files.some((file) => file.diffTruncated) ? <Text style={styles.changedKind}>Partial diff</Text> : null}
        {shown.map((file, index) => (
          <View key={`${file.raw}:${index}`} style={styles.changedRow}>
            {/* Clipped at the head, never the middle: the file name is the thing being
                named and the folders in front of it are only there to place it. */}
            <Text ellipsizeMode="head" numberOfLines={1} style={styles.changedPath}>{file.path}</Text>
            {file.status === 'edited' ? null : (
              <Text style={styles.changedKind}>{file.status === 'created' ? 'new' : 'deleted'}</Text>
            )}
            <ChangeStat added={file.added} removed={file.removed} />
          </View>
        ))}
        {rest === 0 ? null : (
          <View style={styles.changedRow}>
            <Text style={styles.changedMore}>{rest} more {rest === 1 ? 'file' : 'files'}</Text>
            <HugeiconsIcon color={colors.dim} icon={ArrowRight01Icon} size={14} strokeWidth={1.8} />
          </View>
        )}
      </Pressable>
      <DiffSheet files={files} onClose={() => setOpen(false)} open={open} />
    </>
  )
}

function ChangeStat({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null
  return (
    <View style={styles.changedStat}>
      {added === 0 ? null : <Text style={styles.changedAdded}>+{added}</Text>}
      {removed === 0 ? null : <Text style={styles.changedRemoved}>−{removed}</Text>}
    </View>
  )
}

/** How many file names the card lists before it just counts the rest. */
const CARD_FILES = 3

const tail = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

const CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long' })
const CALENDAR = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const DAY_MS = 86_400_000
const midnight = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()

function messageTime(ts: number, now: number): string {
  const then = new Date(ts)
  const clock = CLOCK.format(then)
  const days = Math.round((midnight(new Date(now)) - midnight(then)) / DAY_MS)
  if (days <= 0) return clock
  if (days === 1) return `Yesterday ${clock}`
  if (days < 7) return `${WEEKDAY.format(then)} ${clock}`
  return `${CALENDAR.format(then)} ${clock}`
}

const styles = StyleSheet.create({
  turn: { gap: spacing.sm, alignSelf: 'stretch' },
  // Room above the plan card, so it does not sit on the line of work above it.
  plan: { marginTop: spacing.sm },
  header: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 6 },
  consultedTrigger: { alignSelf: 'center', minHeight: 30, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  consultedText: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13 },
  consultedMenu: { position: 'absolute', width: 220, overflow: 'hidden', borderRadius: radius.lg, ...squircle, backgroundColor: colors.raised },
  consultedRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg },
  consultedName: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 16 },
  consultedLabel: { flex: 1, minWidth: 0, paddingVertical: spacing.sm },
  consultedQuestion: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13 },
  name: { flexShrink: 0, color: colors.text, fontFamily: fonts.sans, fontSize: 16, fontWeight: '500' },
  status: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusText: { flexShrink: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  statusDim: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, fontVariant: ['tabular-nums'] },
  chevron: { transform: [{ rotate: '0deg' }] },
  chevronOpen: { transform: [{ rotate: '180deg' }] },
  bundleChevron: { marginTop: 4 },
  activity: { gap: spacing.sm },
  rows: { gap: 6 },
  traceList: { gap: 8, marginTop: 6, marginLeft: 11, paddingRight: spacing.sm },
  traceItem: { gap: 8 },
  groupMembers: { gap: 8, marginLeft: 22 },
  stepDetail: { gap: 4, marginLeft: 22, paddingRight: spacing.sm },
  stepCount: { flexShrink: 0, color: colors.dim, fontFamily: fonts.sans, fontSize: 14, lineHeight: 18, fontVariant: ['tabular-nums'] },
  detailText: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 17 },
  detailPath: { color: colors.muted, fontFamily: fonts.mono, fontSize: 12, lineHeight: 16 },
  detailCommand: { color: colors.muted, fontFamily: fonts.mono, fontSize: 12, lineHeight: 16 },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingTop: 1 },
  // Drops the 14pt glyph onto the middle of the 18pt line beside it.
  stepIcon: { marginTop: 2 },
  stepText: { flexShrink: 1, color: colors.dim, fontFamily: fonts.sans, fontSize: 14, lineHeight: 18 },
  thought: { fontSize: 12, fontStyle: 'italic', lineHeight: 17 },
  trigger: { fontSize: 12, lineHeight: 17 },
  triggerCopy: { flexShrink: 1, gap: spacing.xs },
  card: { gap: spacing.sm, borderRadius: radius.md, ...squircle, backgroundColor: colors.surface, paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  askItem: { gap: 2 },
  askHeader: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12 },
  askQuestion: { color: colors.dim, fontFamily: fonts.sans, fontSize: 15, lineHeight: 21 },
  askAnswer: { color: colors.text, fontFamily: fonts.sans, fontSize: 15, lineHeight: 21 },
  askSkipped: { color: colors.dim, fontFamily: fonts.sans, fontSize: 15, lineHeight: 21 },
  askMissing: { color: colors.warning, fontFamily: fonts.sans, fontSize: 15, lineHeight: 21 },
  reply: { gap: spacing.sm },
  replySwipe: { position: 'relative', alignSelf: 'stretch' },
  replySwipeBubble: { maxWidth: '86%', alignSelf: 'flex-start' },
  replyCue: { position: 'absolute', top: 0, bottom: 0, left: spacing.md, justifyContent: 'center' },
  replyBubble: { borderRadius: radius.composer, ...squircle, backgroundColor: colors.bubble, paddingHorizontal: spacing.md + 2, paddingVertical: spacing.sm + 1 },
  messageFooter: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: 2 },
  footerButton: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  footerButtonPressed: { backgroundColor: colors.surface2 },
  messageFooterSpace: { flex: 1 },
  footnote: { alignSelf: 'flex-start', maxWidth: '100%' },
  footnoteButton: { minHeight: 28, maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: radius.sm },
  footnoteLabel: { flexShrink: 1, color: colors.dim, fontFamily: fonts.sans, fontSize: 12 },
  footnoteLines: { gap: spacing.xs, paddingLeft: 19, paddingBottom: spacing.xs },
  footnoteGroup: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
  footnoteLine: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
  messageTime: { paddingRight: spacing.xs, color: colors.dim, fontFamily: fonts.sans, fontSize: 12 },
  actionScrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.scrim, padding: spacing.lg },
  actionMenu: { overflow: 'hidden', borderRadius: radius.lg, ...squircle, backgroundColor: colors.raised },
  actionRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg },
  actionRowPressed: { backgroundColor: colors.surface2 },
  actionLabel: { color: colors.text, fontFamily: fonts.sans, fontSize: 16 },
  /* The header sits a step lighter than the rows under it, so the claim and its
     receipts read as two surfaces rather than one long list with a bold first line. */
  changedCard: { overflow: 'hidden', borderRadius: radius.lg, ...squircle, backgroundColor: colors.surface },
  changedHeader: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.surface2, paddingHorizontal: spacing.md },
  changedTitle: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  changedRow: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md },
  changedPath: { flex: 1, color: colors.muted, fontFamily: fonts.mono, fontSize: 12 },
  changedKind: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12 },
  changedMore: { flex: 1, color: colors.dim, fontFamily: fonts.sans, fontSize: 12 },
  changedStat: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  changedAdded: { color: colors.ok, fontFamily: fonts.mono, fontSize: 12, fontVariant: ['tabular-nums'] },
  changedRemoved: { color: colors.danger, fontFamily: fonts.mono, fontSize: 12, fontVariant: ['tabular-nums'] },
  note: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  noteError: { color: colors.danger, textAlign: 'left' },
  pressed: { opacity: 0.7 },
})
