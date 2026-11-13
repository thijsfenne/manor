/*
 * THESIS: One quiet Sessions list makes open work and settled history legible: projects first, standalone Sessions below; it refuses a grouped card dashboard.
 * OWN-WORLD: Quiet House neutrals, flat edge-to-edge rows, muted metadata, persona accents, and rounded floating native chrome.
 * STORY: the user sees what needs attention, finds finished threads, and starts a project conversation on their Mac with one hand.
 * FIRST VIEWPORT: The Sessions title sits above active rows; Settled follows; menu, search, and Compose stay in a bottom tool cluster. Compose keeps context through project and host-folder selection with native sheet motion.
 * FORM: Operate, a messaging inbox.
 * FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
 */
import {
  ArrowDown01Icon,
  BubbleChatIcon,
  Cancel01Icon,
  FolderOffIcon,
  PencilEdit01Icon,
  Search01Icon,
  Tick02Icon,
  Undo02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react-native'
import type { AgentConfig } from '@manor/contracts'
import { projectIcon } from '@manor/client-runtime/project-icons'
import {
  inbox,
  projectThreads,
  searchThreads,
  sitsSettled,
  type InboxChat,
  type ProjectThreadRow,
  type ThreadSearchHit,
} from '@manor/client-runtime/state'
import { router } from 'expo-router'
import { useMemo, useRef, useState, type ComponentType, type ReactElement, type Ref } from 'react'
import {
  FlatList,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native'
import { KeyboardStickyView, useKeyboardState } from 'react-native-keyboard-controller'
import ReanimatedSwipeable, {
  type SwipeableMethods,
  type SwipeableProps,
} from 'react-native-gesture-handler/ReanimatedSwipeable'
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AuthGate } from '@/components/AuthGate'
import { DisclosureChevron } from '@/components/DisclosureChevron'
import { GlassPressable } from '@/components/GlassPressable'
import { GlassGroup, GlassSurface } from '@/components/GlassSurface'
import { SectionScaffold } from '@/components/SectionScaffold'
import { SessionMark } from '@/components/SessionMark'
import { Text } from '@/components/Text'
import { relativeTime } from '@/lib/time'
import { useWorkspace } from '@/providers/WorkspaceProvider'
import { colors, fonts, glassTints, radius, spacing, squircle, tracking } from '@/theme'

type InboxRow =
  | { kind: 'section-header'; key: string; label: string; first?: true }
  | { kind: 'thread'; key: string; row: ProjectThreadRow }
  | { kind: 'active'; key: string; entry: InboxChat; searchResult?: boolean }
  | { kind: 'settled-header'; key: string; count: number }
  | { kind: 'settled'; key: string; entry: InboxChat }

/** The settled history pages in at the end of the scroll, twenty rows at a time. */
const INITIAL_SETTLED_COUNT = 20
const SETTLED_PAGE_SIZE = 20

/** The running Session count beside a project thread. */
const runningLabel = (count: number): string => `${count} running`

export default function HomeScreen() {
  return (
    <AuthGate>
      <ProjectInbox />
    </AuthGate>
  )
}

function ProjectInbox() {
  const { workspace, status, openChat, setChatSettled } = useWorkspace()
  const insets = useSafeAreaInsets()
  const [query, setQuery] = useState('')
  const [settledOpen, setSettledOpen] = useState(true)
  const [visibleSettled, setVisibleSettled] = useState(INITIAL_SETTLED_COUNT)
  const [searchFocused, setSearchFocused] = useState(false)
  const searchRef = useRef<TextInput>(null)
  // The toolbar rides the keyboard like the composer does: the safe-area padding is
  // covered by the keys once they are up, so the view sinks by that much and the
  // field keeps a small gap above them instead.
  const keyboardUp = useKeyboardState((state) => state.isVisible)
  const toolbarPad = Math.max(insets.bottom, spacing.sm)
  const keyboardSink = toolbarPad - spacing.sm
  // The desktop sidebar's two sections from the same selectors (2026-10-12): Projects,
  // whose rows carry the Sessions their thread started, then Sessions, which leaves
  // those Sessions out. Search still reaches every Session, a thread's included.
  const directory = useMemo(() => inbox(workspace, { hideThreadSessions: true }), [workspace])
  const everySession = useMemo(() => inbox(workspace), [workspace])
  const entriesById = useMemo(
    () => new Map([...everySession.unsettled, ...everySession.settled].map((entry) => [entry.chat.id, entry])),
    [everySession.settled, everySession.unsettled],
  )
  const threads = useMemo(() => projectThreads(workspace), [workspace])
  const searchHits = useMemo<ThreadSearchHit[]>(
    () => [...everySession.unsettled, ...everySession.settled].map((entry) => ({
      chatId: entry.chat.id,
      title: entry.chat.title,
      preview: entry.chat.lastMessagePreview ?? '',
      lastMessageAt: entry.chat.lastMessageAt,
      fields: [entry.chat.title, entry.chat.lastMessagePreview ?? '', entry.projectName],
      projectName: entry.projectName,
    })),
    [everySession.settled, everySession.unsettled],
  )

  const rows = useMemo<InboxRow[]>(() => {
    if (query.trim() !== '') {
      return searchThreads(searchHits, query).flatMap((hit) => {
        const entry = entriesById.get(hit.chatId)
        return entry === undefined
          ? []
          : [{ kind: 'active' as const, key: `search:${hit.chatId}`, entry, searchResult: true }]
      })
    }

    const result: InboxRow[] = []
    // Projects first, in the projects' own order, then the Sessions no thread started.
    if (threads.length > 0) {
      result.push({ kind: 'section-header', key: 'projects-header', label: 'Projects', first: true })
      result.push(...threads.map((row) => ({ kind: 'thread' as const, key: `thread:${row.chat.id}`, row })))
      result.push({ kind: 'section-header', key: 'standalone-header', label: 'Sessions' })
    }
    result.push(...directory.unsettled.map((entry) => ({
      kind: 'active' as const,
      key: `active:${entry.chat.id}`,
      entry,
    })))
    if (directory.settled.length > 0) {
      result.push({ kind: 'settled-header', key: 'settled-header', count: directory.settled.length })
      if (settledOpen) {
        // Only the first page is a row; the rest arrives via onEndReached. Search
        // never reads this slice, it scans the full directory above.
        result.push(...directory.settled.slice(0, visibleSettled).map((entry) => ({
          kind: 'settled' as const,
          key: `settled:${entry.chat.id}`,
          entry,
        })))
      }
    }
    return result
  }, [directory.settled, directory.unsettled, entriesById, query, searchHits, settledOpen, threads, visibleSettled])

  const loadMoreSettled = () => {
    if (query.trim() !== '' || !settledOpen || directory.settled.length <= visibleSettled) return
    setVisibleSettled((count) => Math.min(count + SETTLED_PAGE_SIZE, directory.settled.length))
  }

  const cancelSearch = () => {
    setQuery('')
    searchRef.current?.blur()
  }

  const enterChat = (chatId: string) => {
    openChat(chatId)
    router.push({ pathname: '/chat/[id]', params: { id: chatId } })
  }

  const empty = query.trim() !== ''
    ? { title: 'No Sessions found', copy: 'Try a project name, a title, or a word from the last message.' }
    : workspace.hasDirectory
      ? { title: 'No sessions yet', copy: 'Start a Session with the button at the bottom right.' }
      : status === 'offline'
        ? { title: 'No connection to your Mac', copy: 'Open Manor on your Mac. Your Sessions show up here once the connection is back.' }
        : status === 'connecting'
          ? { title: 'Connecting to your Mac', copy: 'Your projects and Sessions show up here once Manor connects.' }
          : { title: 'Loading Sessions', copy: 'Your Mac is sending over your projects and Sessions.' }

  return (
    <SectionScaffold active="inbox" compactTitle title="Sessions">
      <FlatList
        contentContainerStyle={[
          styles.list,
          { paddingBottom: 84 + Math.max(insets.bottom, spacing.md) },
          rows.length === 0 && styles.emptyList,
        ]}
        data={rows}
        keyExtractor={(row) => row.key}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onEndReached={loadMoreSettled}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={
          <View style={styles.empty}>
            <View style={styles.emptyMark}>
              <HugeiconsIcon color={colors.muted} icon={BubbleChatIcon} size={22} strokeWidth={1.6} />
            </View>
            <Text style={styles.emptyTitle}>{empty.title}</Text>
            <Text style={styles.emptyCopy}>{empty.copy}</Text>
          </View>
        }
        renderItem={({ item }) => {
          if (item.kind === 'section-header') {
            return (
              <View style={[styles.sectionHeader, item.first === true && styles.sectionHeaderFirst]}>
                <Text accessibilityRole="header" style={styles.settledLabel}>{item.label}</Text>
              </View>
            )
          }
          if (item.kind === 'thread') {
            return <ThreadRow row={item.row} onPress={() => enterChat(item.row.chat.id)} />
          }
          if (item.kind === 'settled-header') {
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: settledOpen }}
                onPress={() => setSettledOpen((open) => !open)}
                style={({ pressed }) => [styles.settledHeader, pressed && styles.pressed]}
              >
                <DisclosureChevron open={settledOpen}>
                  <HugeiconsIcon color={colors.dim} icon={ArrowDown01Icon} size={16} strokeWidth={1.7} />
                </DisclosureChevron>
                <Text style={styles.settledLabel}>Settled</Text>
                <Text style={styles.settledCount}>{item.count}</Text>
              </Pressable>
            )
          }
          const settled = sitsSettled(workspace, item.entry.chat)
          const row = item.kind === 'settled' ? (
            <SettledRow agents={workspace.agents} entry={item.entry} onPress={() => enterChat(item.entry.chat.id)} />
          ) : (
            <ActiveRow
              agents={workspace.agents}
              entry={item.entry}
              searchResult={item.searchResult === true}
              settled={settled}
              onPress={() => enterChat(item.entry.chat.id)}
            />
          )
          return (
            <SettleSwipe settled={settled} onSwipe={() => setChatSettled(item.entry.chat.id, !settled)}>
              {row}
            </SettleSwipe>
          )
        }}
      />

      <KeyboardStickyView
        enabled={keyboardUp}
        offset={{ closed: 0, opened: keyboardSink }}
        pointerEvents="box-none"
        style={[styles.toolbarArea, { paddingBottom: toolbarPad }]}
      >
        <GlassGroup spacing={10} style={styles.toolbar}>
          <GlassSurface fallbackStyle={styles.floatingFallback} radius={25} style={styles.searchControl}>
            <HugeiconsIcon color={colors.muted} icon={Search01Icon} size={21} strokeWidth={1.7} />
            <TextInput
              accessibilityLabel="Search Sessions"
              clearButtonMode="while-editing"
              maxFontSizeMultiplier={1.35}
              onBlur={() => setSearchFocused(false)}
              onChangeText={setQuery}
              onFocus={() => setSearchFocused(true)}
              placeholder="Search"
              placeholderTextColor={colors.muted}
              ref={searchRef}
              returnKeyType="search"
              selectionColor={colors.text}
              style={styles.searchInput}
              value={query}
            />
          </GlassSurface>

          {searchFocused ? (
            <GlassPressable
              accessibilityLabel="Cancel search"
              fallbackStyle={styles.floatingFallback}
              fill
              hitSlop={6}
              onPress={cancelSearch}
              radius={25}
              style={styles.roundControl}
            >
              <View style={styles.controlPressable}>
                <HugeiconsIcon color={colors.text} icon={Cancel01Icon} size={20} strokeWidth={1.7} />
              </View>
            </GlassPressable>
          ) : (
            <GlassPressable
              accessibilityLabel="New Session"
              fallbackColor={colors.lightControl}
              fallbackStyle={styles.lightControlShadow}
              fill
              hitSlop={6}
              onPress={() => router.push('/new-chat')}
              radius={25}
              style={styles.roundControl}
              tintColor={glassTints.lightControl}
            >
              <View style={styles.controlPressable}>
                <HugeiconsIcon color={colors.onLight} icon={PencilEdit01Icon} size={22} strokeWidth={1.7} />
              </View>
            </GlassPressable>
          )}
        </GlassGroup>
      </KeyboardStickyView>
    </SectionScaffold>
  )
}

/**
 * The library types its children against the React 18 typings it ships with, which
 * reject this app's React 19 `ReactNode`. Same component, this app's element type.
 */
const Swipeable = ReanimatedSwipeable as unknown as ComponentType<
  Omit<SwipeableProps, 'children'> & { children?: ReactElement; ref?: Ref<SwipeableMethods> }
>

/** How wide the action under a swiped row is, and how far a swipe has to go to fire it. */
const SWIPE_ACTION_WIDTH = 96

/**
 * Swipe a row left to settle it, or to pick a settled one back up. The row leaves
 * the list under the finger on the optimistic update; when the send fails (Mac
 * offline) the row is closed again rather than left hanging on a promise.
 */
function SettleSwipe({
  settled,
  onSwipe,
  children,
}: {
  settled: boolean
  onSwipe: () => boolean
  children: ReactElement
}) {
  const ref = useRef<SwipeableMethods>(null)
  return (
    <Swipeable
      friction={2}
      overshootRight={false}
      ref={ref}
      renderRightActions={(_progress, drag) => <SwipeAction drag={drag} settled={settled} />}
      rightThreshold={SWIPE_ACTION_WIDTH * 0.75}
      onSwipeableWillOpen={() => {
        // Only a right panel exists, so any open is the settle gesture; the direction
        // the library reports is the row's travel, which this must not depend on.
        onSwipe()
        // A row that stays mounted (a search hit keeps its key) must not sit open with
        // the opposite label, and a refused send must not sit open on a promise.
        ref.current?.close()
      }}
    >
      {children}
    </Swipeable>
  )
}

function SwipeAction({ drag, settled }: { drag: SharedValue<number>; settled: boolean }) {
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: drag.value + SWIPE_ACTION_WIDTH }] }))
  return (
    <Animated.View style={[styles.swipeAction, settled ? styles.swipeUnsettle : styles.swipeSettle, style]}>
      <HugeiconsIcon color={colors.onPrimary} icon={settled ? Undo02Icon : Tick02Icon} size={20} strokeWidth={2} />
      <Text style={styles.swipeLabel}>{settled ? 'Unsettle' : 'Settle'}</Text>
    </Animated.View>
  )
}

function ActiveRow({
  entry,
  agents,
  searchResult,
  settled,
  onPress,
}: {
  entry: InboxChat
  agents: AgentConfig[]
  searchResult: boolean
  settled: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityLabel={`Open ${entry.chat.title}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.activeRow, pressed && styles.rowPressed]}
    >
      {/* The room first, the conversation second, as on the desktop. */}
      <View style={styles.rowMeta}>
        <HugeiconsIcon
          color={entry.noProject === true ? colors.muted : entry.projectColor}
          icon={entry.noProject === true ? FolderOffIcon : projectIcon(entry.projectIcon)}
          size={14}
          strokeWidth={1.7}
        />
        <Text numberOfLines={1} style={styles.projectName}>
          {entry.noProject === true ? 'No project' : entry.projectName || 'Project'}
          {entry.viaThread === true ? <Text style={styles.viaThread}>{' via project thread'}</Text> : null}
        </Text>
        <Standing entry={entry} settled={searchResult && settled} />
      </View>
      <View style={styles.titleRow}>
        <Text numberOfLines={1} style={styles.chatTitle}>{entry.chat.title}</Text>
        <SessionMark agents={agents} chat={entry.chat} stackSize={24} />
      </View>
    </Pressable>
  )
}

/**
 * A project, which opens its thread. Its Sessions live behind it, so the right side
 * carries the one thing they want: a dot when the user has a move, else the ones running, else
 * when it last spoke.
 */
function ThreadRow({ row, onPress }: { row: ProjectThreadRow; onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={`Open project thread ${row.project.name}${row.waiting ? ', waiting on you' : ''}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.threadRow, pressed && styles.rowPressed]}
    >
      <HugeiconsIcon color={row.project.color} icon={projectIcon(row.project.icon)} size={16} strokeWidth={1.7} />
      <Text numberOfLines={1} style={styles.threadName}>{row.project.name}</Text>
      {row.waiting ? (
        <View style={styles.waitingDot} />
      ) : row.running > 0 ? (
        <Text style={styles.time}>{runningLabel(row.running)}</Text>
      ) : (
        <Text style={styles.time}>{relativeTime(row.lastActivityAt)}</Text>
      )}
    </Pressable>
  )
}

/**
 * The top-right slot: what the chat wants from the user, or when it last spoke.
 * Waiting is the loudest, then Working, then Done for an unread answer.
 */
function Standing({ entry, settled }: { entry: InboxChat; settled: boolean }) {
  if (entry.waiting) return <Text style={styles.waiting}>Waiting</Text>
  if (entry.running) return <Text style={styles.runningText}>Working</Text>
  if (entry.unread) return <Text style={styles.doneText}>Done</Text>
  return <Text style={styles.time}>{settled ? 'Settled · ' : ''}{relativeTime(entry.chat.lastMessageAt)}</Text>
}

function SettledRow({ entry, agents, onPress }: { entry: InboxChat; agents: AgentConfig[]; onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={`Open settled Session ${entry.chat.title}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.quietRow, pressed && styles.rowPressed]}
    >
      <HugeiconsIcon color={entry.projectColor} icon={projectIcon(entry.projectIcon)} size={14} strokeWidth={1.7} />
      <Text numberOfLines={1} style={styles.quietTitle}>{entry.chat.title}</Text>
      <SessionMark agents={agents} chat={entry.chat} />
      <Text style={styles.time}>{relativeTime(entry.chat.lastMessageAt)}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  list: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    paddingHorizontal: spacing.md,
  },
  emptyList: { flexGrow: 1 },
  activeRow: {
    minHeight: 72,
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    ...squircle,
  },
  rowPressed: { backgroundColor: colors.surface2 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  projectName: { flex: 1, color: colors.dim, fontFamily: fonts.sans, fontSize: 13 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  chatTitle: {
    flex: 1,
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 17,
    fontWeight: '500',
    letterSpacing: -0.2,
    lineHeight: 22,
  },
  waiting: { color: colors.warning, fontFamily: fonts.sans, fontSize: 12, fontWeight: '500' },
  waitingDot: { width: 8, height: 8, borderRadius: radius.round, backgroundColor: colors.warning },
  runningText: { color: colors.busy, fontFamily: fonts.sans, fontSize: 12, fontWeight: '500' },
  doneText: { color: colors.ok, fontFamily: fonts.sans, fontSize: 12, fontWeight: '500' },
  time: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12, fontVariant: ['tabular-nums'] },
  sectionHeader: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
  },
  sectionHeaderFirst: { marginTop: 0 },
  threadRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    ...squircle,
  },
  threadName: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 17, fontWeight: '500', letterSpacing: -0.2 },
  viaThread: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13 },
  settledHeader: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
  },
  settledLabel: { flex: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 15, fontWeight: '500' },
  settledCount: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, fontVariant: ['tabular-nums'] },
  quietRow: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    ...squircle,
  },
  quietTitle: { flex: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 17, lineHeight: 22 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.xxl },
  emptyMark: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    ...squircle,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
  },
  emptyTitle: { color: colors.text, fontFamily: fonts.sans, fontSize: 20, fontWeight: '500' },
  emptyCopy: { maxWidth: 280, color: colors.muted, fontFamily: fonts.sans, fontSize: 15, lineHeight: 21, textAlign: 'center' },
  toolbarArea: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  toolbar: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  roundControl: { width: 50, height: 50 },
  floatingFallback: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.24,
    shadowRadius: 20,
    elevation: 8,
  },
  lightControlShadow: {
    shadowColor: colors.onLight,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    elevation: 8,
  },
  controlPressable: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  searchControl: {
    flex: 1,
    height: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
  },
  searchInput: {
    flex: 1,
    height: 50,
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 17,
    letterSpacing: tracking.body,
    paddingVertical: 0,
  },
  pressed: { opacity: 0.64 },
  swipeAction: {
    width: SWIPE_ACTION_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderRadius: radius.md,
    ...squircle,
  },
  swipeSettle: { backgroundColor: colors.ok },
  swipeUnsettle: { backgroundColor: colors.muted },
  swipeLabel: { color: colors.onPrimary, fontFamily: fonts.sans, fontSize: 12, fontWeight: '500' },
})
