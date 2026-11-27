import BubbleChatIcon from '@hugeicons/core-free-icons/BubbleChatIcon'
import Note01Icon from '@hugeicons/core-free-icons/Note01Icon'
import QuoteDownIcon from '@hugeicons/core-free-icons/QuoteDownIcon'
import Search01Icon from '@hugeicons/core-free-icons/Search01Icon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { rankSearchResults, type SearchChat, type SearchResult } from '@manor/client-runtime/search-ranking'
import { chatList, createListedState, inbox, personaOf, projectThreads } from '@manor/client-runtime/state'
import { buildNoteIndex, resolveNote } from '@manor/client-runtime/vault-notes'
import { SEARCH_QUERY_MAX, searchMatchKind, searchWords, type SearchMessageHit, type SearchNoteHit } from '@manor/contracts'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { TextInput } from '@/components/TextInput'
import { useKeyboardState } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { ScrimFlatList } from '@/components/EdgeScrim'
import { FileBrowser } from '@/components/FileBrowser'
import { GlassSurface } from '@/components/GlassSurface'
import { KeyboardFooter } from '@/components/KeyboardFooter'
import { SectionScaffold } from '@/components/SectionScaffold'
import { UsageButton } from '@/components/UsageButton'
import { Text } from '@/components/Text'
import { useTabReset } from '@/lib/tabNavigation'
import { leaveEventReveal } from '@/lib/threadReveal'
import { relativeTime } from '@/lib/time'
import { useWorkspace } from '@/providers/WorkspaceProvider'
import { colors, fonts, radius, spacing, squircle, tracking } from '@/theme'

/** Typing is a burst; one search on the Mac per pause, not per key. */
const SEARCH_DEBOUNCE_MS = 120
const SEARCH_FAILED = 'Messages and notes could not be searched. Type again to retry.'

/** The Mac's answer for one query; `failed` when it could not search, so the screen stops waiting. */
type Answer = { query: string; messages: SearchMessageHit[]; notes: SearchNoteHit[]; failed?: boolean }

/** The kind each row wears in front of its context, as the Mac's palette badges it. */
const KIND = {
  chat: { label: 'Chat', icon: BubbleChatIcon },
  message: { label: 'Message', icon: QuoteDownIcon },
  note: { label: 'Note', icon: Note01Icon },
} as const

/**
 * The phone's search, on the Mac palette's rule and in its one ranked list: chat titles
 * matched here from the lists the phone already holds, message content and note bodies
 * searched on the Mac. Reminders stay on the Mac. A chat opens on this tab's stack, a
 * message opens its chat at that message; a note opens in place, and back returns to the results.
 */
export default function SearchScreen() {
  const { workspace, status, openChat, readVaultFile, search } = useWorkspace()
  const insets = useSafeAreaInsets()
  const [query, setQuery] = useState('')
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const asked = useRef(0)
  const live = status === 'live'
  const needle = query.trim().slice(0, SEARCH_QUERY_MAX)

  const keyboardUp = useKeyboardState((state) => state.isVisible)

  const [listedOf] = useState(createListedState)
  const listed = listedOf(workspace)
  const agents = workspace.agents
  // Every DM, group, project thread and Session, settled and archived ones included, the way the Mac's palette finds them.
  const chats = useMemo<SearchChat[]>(() => {
    const sessions = inbox(listed)
    const byId = new Map<string, SearchChat>()
    for (const row of projectThreads(listed)) {
      byId.set(row.chat.id, { chatId: row.chat.id, title: row.project.name, projectName: '', lastMessageAt: row.lastActivityAt })
    }
    for (const row of chatList(listed)) {
      if (row.chat === null || row.kind === 'pair') continue
      byId.set(row.chat.id, { chatId: row.chat.id, title: row.title, projectName: '', lastMessageAt: row.lastMessageAt ?? 0 })
    }
    for (const entry of [...sessions.unsettled, ...sessions.settled, ...sessions.archived]) {
      byId.set(entry.chat.id, { chatId: entry.chat.id, title: entry.chat.title, projectName: entry.projectName, lastMessageAt: entry.chat.lastMessageAt })
    }
    return [...byId.values()]
  }, [listed])

  useEffect(() => {
    if (needle === '' || !live) return
    const timer = setTimeout(() => {
      const ticket = ++asked.current
      search(needle).then(
        (found) => {
          if (ticket === asked.current) setAnswer({ query: needle, ...found })
        },
        () => {
          if (ticket === asked.current) setAnswer({ query: needle, messages: [], notes: [], failed: true })
        },
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [needle, live, search])

  const results = useMemo(() => {
    if (needle === '') return []
    // Until the Mac answers this query, the last answer stands where it still matches,
    // so rows do not blink out and back between keystrokes.
    const words = searchWords(needle)
    const current = answer?.query === needle
    const matches = (text: string | undefined) => text !== undefined && searchMatchKind(text, words) !== null
    const messages = answer === null ? [] : current ? answer.messages : answer.messages.filter((hit) => matches(hit.snippet))
    const notes = answer === null ? [] : current ? answer.notes : answer.notes.filter((hit) => matches(hit.title) || matches(hit.snippet))
    return rankSearchResults(needle, { chats, messages, notes, reminders: [], lists: [] })
  }, [needle, answer, chats])
  const waiting = needle !== '' && live && answer?.query !== needle
  const failed = needle !== '' && answer?.query === needle && answer.failed === true

  const notes = useMemo(() => buildNoteIndex(workspace.vault.files ?? []), [workspace.vault.files])

  useTabReset('(search)', () => setNote(null))
  // Knowledge reads its notes through the same slot, so coming back rereads this one.
  useFocusEffect(
    useCallback(() => {
      if (live && note !== null) readVaultFile(note)
    }, [live, note, readVaultFile]),
  )

  if (note !== null) {
    return (
      <SectionScaffold onBack={() => setNote(null)} title={basename(note)}>
        <FileBrowser
          agents={agents}
          emptyText=""
          files={workspace.vault.files ?? []}
          live={live}
          onPlace={(place) => setNote(place.file)}
          onRead={readVaultFile}
          place={{ dir: dirname(note), file: note }}
          preview={workspace.vault.note}
          resolveWikilink={(target) => resolveNote(notes, target)}
          truncated={false}
        />
      </SectionScaffold>
    )
  }

  const pick = (result: SearchResult) => {
    if (result.kind === 'note') {
      setNote(result.path)
    } else if (result.kind !== 'reminder') {
      // A message hit lands on that message once the chat holds it.
      if (result.kind === 'message') leaveEventReveal(result.chatId, result.eventId)
      openChat(result.chatId)
      router.push({ pathname: '/chat/[id]', params: { id: result.chatId } })
    }
  }
  // Named the way the transcript names the same message.
  const authorOf = (result: SearchResult) => result.kind !== 'message' ? ''
    : result.agentId === undefined ? 'You' : personaOf(agents, result.agentId).name

  const empty = needle === ''
    ? { title: 'Search everything', copy: 'Chats, messages and notes from your Mac.' }
    : !live
      ? { title: 'No connection to your Mac', copy: 'Chat titles are searched here. Messages and notes need Manor on your Mac.' }
      : failed
        ? { title: 'Search failed', copy: SEARCH_FAILED }
        : waiting
          ? { title: 'Searching' }
          : { title: 'Nothing found', copy: 'Try fewer words, or a word from the title.' }

  const toolbar = (scrim: ReactNode) => (
    <KeyboardFooter
      enabled={keyboardUp}
      pointerEvents="box-none"
      sink={insets.bottom}
      style={styles.toolbarArea}
    >
      {scrim}
      <GlassSurface fallbackStyle={styles.floatingFallback} radius={25} style={styles.searchControl}>
        <HugeiconsIcon color={colors.muted} icon={Search01Icon} size={21} strokeWidth={1.7} />
        <TextInput
          accessibilityLabel="Search chats, messages and notes"
          autoCorrect={false}
          clearButtonMode="while-editing"
          maxFontSizeMultiplier={1.35}
          onChangeText={setQuery}
          placeholder="Search"
          placeholderTextColor={colors.muted}
          returnKeyType="search"
          selectionColor={colors.text}
          style={styles.searchInput}
          value={query}
        />
      </GlassSurface>
    </KeyboardFooter>
  )

  return (
    <SectionScaffold title="Search" toolbar={toolbar} toolbarFade trailing={<UsageButton />}>
      <ScrimFlatList
        contentContainerStyle={[styles.list, results.length === 0 && styles.emptyList]}
        data={results}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(result) => result.key}
        ListEmptyComponent={
          <View style={styles.empty}>
            <View style={styles.emptyMark}>
              <HugeiconsIcon color={colors.muted} icon={Search01Icon} size={22} strokeWidth={1.6} />
            </View>
            <Text style={styles.emptyTitle}>{empty.title}</Text>
            {empty.copy === undefined ? null : <Text style={styles.emptyCopy}>{empty.copy}</Text>}
          </View>
        }
        ListFooterComponent={results.length > 0 && (waiting || failed) ? (
          <Text style={styles.footnote}>{failed ? SEARCH_FAILED : 'Searching messages and notes…'}</Text>
        ) : null}
        renderItem={({ item }) => <ResultRow author={authorOf(item)} onPress={() => pick(item)} result={item} />}
      />
    </SectionScaffold>
  )
}

/** One result: the kind and age above, the title, then what matched underneath. */
function ResultRow({ result, author, onPress }: { result: SearchResult; author: string; onPress: () => void }) {
  if (result.kind === 'reminder') return null
  const kind = KIND[result.kind]
  const title = result.kind === 'message' ? result.chatTitle : result.title
  const context = result.kind === 'note' ? result.folder : result.projectName
  const snippet = result.kind === 'message' ? `${author}: ${result.snippet}` : result.kind === 'note' ? result.snippet : undefined
  return (
    <Pressable
      accessibilityLabel={[kind.label, title, snippet].filter(Boolean).join(', ')}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <HugeiconsIcon color={colors.muted} icon={kind.icon} size={18} strokeWidth={1.7} />
      <View style={styles.rowText}>
        <View style={styles.rowTop}>
          <Text numberOfLines={1} style={styles.rowTitle}>{title}</Text>
          <Text style={styles.rowMeta}>{relativeTime(result.at)}</Text>
        </View>
        <Text numberOfLines={1} style={styles.rowKind}>{context === '' ? kind.label : `${kind.label} · ${context}`}</Text>
        {snippet === undefined ? null : <Text numberOfLines={2} style={styles.rowSubtitle}>{snippet}</Text>}
      </View>
    </Pressable>
  )
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const dirname = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))

const styles = StyleSheet.create({
  list: { width: '100%', maxWidth: 760, alignSelf: 'center', paddingHorizontal: spacing.md },
  emptyList: { flexGrow: 1 },
  row: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    ...squircle,
  },
  rowPressed: { backgroundColor: colors.surface2 },
  rowText: { flex: 1, minWidth: 0, gap: 4 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  rowTitle: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 17, fontWeight: '500', letterSpacing: -0.2 },
  rowMeta: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, fontVariant: ['tabular-nums'] },
  rowKind: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13 },
  rowSubtitle: { color: colors.muted, fontFamily: fonts.sans, fontSize: 15, lineHeight: 20 },
  footnote: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, textAlign: 'center', paddingVertical: spacing.lg },
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
  toolbarArea: { position: 'absolute', right: 0, bottom: 0, left: 0, paddingTop: spacing.md },
  floatingFallback: {
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.24,
    shadowRadius: 20,
    elevation: 8,
  },
  searchControl: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
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
})
