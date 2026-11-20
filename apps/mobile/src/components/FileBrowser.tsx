import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon'
import FileEmpty02Icon from '@hugeicons/core-free-icons/FileEmpty02Icon'
import Folder01Icon from '@hugeicons/core-free-icons/Folder01Icon'
import Search01Icon from '@hugeicons/core-free-icons/Search01Icon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import type { AgentConfig, RepoFileResult } from '@manor/contracts'
import { basename, dirname, entriesUnder, resolveRelativeFileLink, type TreeEntry } from '@manor/client-runtime/file-tree'
import { languageOf } from '@manor/client-runtime/highlight'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { TextInput } from '@/components/TextInput'
import Animated, { FadeIn, FadeOut, SlideInLeft, SlideInRight, useReducedMotion } from 'react-native-reanimated'

import { CodeView } from '@/components/CodeView'
import { Markdown, type MarkdownLinks } from '@/components/Markdown'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle, tracking } from '@/theme'

/** Past this many files a listing gets a search field above the folders. */
const SEARCH_FROM = 12

/** Where the browser stands: a folder, or a file with the folder it came from behind it. */
export interface BrowserPlace {
  dir: string
  file: string | null
  /** The source file behind a followed Markdown link. Folder navigation needs no history. */
  back?: BrowserPlace
}

export const ROOT_PLACE: BrowserPlace = { dir: '', file: null }

/** One step back from `place`, or null at the root, for whoever owns the header's back button. */
export function placeBehind(place: BrowserPlace, rootDir = ''): BrowserPlace | null {
  if (place.back !== undefined) return place.back
  if (place.file !== null) return { dir: place.dir, file: null }
  if (place.dir === rootDir) return null
  const parent = dirname(place.dir)
  return { dir: rootDir === '' || parent === rootDir || parent.startsWith(`${rootDir}/`) ? parent : rootDir, file: null }
}

/** The title and the line under it for `place`, so both sheets and screens say the same thing. */
export function placeTitles(place: BrowserPlace, rootTitle: string, rootSubtitle: string, rootDir = ''): { title: string; subtitle: string } {
  if (place.file !== null) return { title: basename(place.file), subtitle: dirname(place.file) || rootSubtitle }
  if (place.dir === rootDir) return { title: rootTitle, subtitle: rootSubtitle }
  return { title: basename(place.dir), subtitle: place.dir }
}

interface FileBrowserProps {
  place: BrowserPlace
  onPlace: (place: BrowserPlace) => void
  /** Null until the listing lands; the browser says it is loading rather than empty. */
  files: readonly string[] | null
  truncated: boolean
  /** The file being shown and what came back for it; null result means still loading. */
  preview: { path: string; result: RepoFileResult | null } | null
  /** False while the socket is down, the one reason nothing can load. */
  live: boolean
  agents: AgentConfig[]
  onRead: (path: string) => void
  emptyText: string
  /**
   * The note a `[[wikilink]]` means, for a browser standing in a vault. Handed in
   * rather than derived from `files`, because only the screen that knows it is looking
   * at notes may switch the syntax on: in a repo `[[this]]` is somebody's brackets and
   * a name that matches a source file is not a link to it.
   */
  resolveWikilink?: (target: string) => string | null
}

/**
 * A folder tree walked one level at a time, and behind any file the file as it
 * stands. Shared by the project files sheet and the Knowledge screen, because a
 * vault and a repo are both a list of paths and the phone should walk them the
 * same way. Read-only: editing from a bus is a persona's job, not a thumb's.
 */
export function FileBrowser({ place, onPlace, files, truncated, preview, live, agents, onRead, emptyText, resolveWikilink }: FileBrowserProps) {
  const [query, setQuery] = useState('')
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const still = useReducedMotion()

  // The location owns loading, and only the location. That keeps Back, nested Markdown
  // links, and a reconnect from restoring a file name while leaving the previous
  // preview behind. The handler is read through a ref rather than depended on: whoever
  // owns the screen above rebuilds that closure on every render, and asking again per
  // render re-arms this file's own "loading" state, so the preview never settles.
  const askRead = useRef(onRead)
  useEffect(() => {
    askRead.current = onRead
  }, [onRead])
  useEffect(() => {
    if (live && place.file !== null) askRead.current(place.file)
  }, [live, place.file])

  const entries = useMemo<TreeEntry[]>(() => {
    const all = files ?? []
    const needle = query.trim().toLowerCase()
    if (needle !== '') {
      return all.filter((file) => file.toLowerCase().includes(needle)).map((file) => ({ kind: 'file', name: basename(file), path: file, count: 1 }))
    }
    return entriesUnder(all, place.dir)
  }, [files, place.dir, query])

  const go = (next: BrowserPlace, dir: 'forward' | 'back') => {
    setDirection(dir)
    onPlace(next)
  }
  const openEntry = (entry: TreeEntry) => {
    if (entry.kind === 'folder') {
      go({ dir: entry.path, file: null }, 'forward')
    } else {
      go({ dir: place.dir, file: entry.path }, 'forward')
    }
  }

  if (place.file !== null) {
    const openFile = (path: string) => go({ dir: dirname(path), file: path, back: place }, 'forward')
    const links: MarkdownLinks = {
      relative: (href) => {
        const path = resolveRelativeFileLink(place.file ?? '', href)
        if (path === null) return
        openFile(path)
      },
      ...(resolveWikilink === undefined ? {} : { notes: { resolve: resolveWikilink, open: openFile } }),
    }
    return (
      <Animated.View entering={still ? undefined : SlideInRight.duration(220)} exiting={still ? undefined : FadeOut.duration(80)} key={place.file} style={styles.fill}>
        <Preview agents={agents} links={links} path={place.file} preview={preview} />
      </Animated.View>
    )
  }

  const searching = query.trim() !== ''
  return (
    <Animated.View entering={still ? undefined : direction === 'back' ? SlideInLeft.duration(220) : FadeIn.duration(120)} exiting={still ? undefined : FadeOut.duration(80)} key={place.dir} style={styles.fill}>
      {!live ? (
        <Empty text="Your Mac is offline." />
      ) : files === null ? (
        <Loading text="Loading files…" />
      ) : files.length === 0 ? (
        <Empty text={emptyText} />
      ) : (
        <>
          {files.length >= SEARCH_FROM ? (
            <View style={styles.search}>
              <HugeiconsIcon color={colors.muted} icon={Search01Icon} size={18} strokeWidth={1.7} />
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                clearButtonMode="while-editing"
                onChangeText={setQuery}
                placeholder="Search files…"
                placeholderTextColor={colors.dim}
                selectionColor={colors.text}
                style={styles.searchInput}
                value={query}
              />
            </View>
          ) : null}
          <FlatList
            contentContainerStyle={styles.list}
            data={entries}
            keyboardShouldPersistTaps="handled"
            keyExtractor={(entry) => `${entry.kind}:${entry.path}`}
            ListEmptyComponent={<Empty text={searching ? `No files match “${query.trim()}”.` : 'This folder is empty.'} />}
            ListFooterComponent={truncated ? <Text style={styles.truncated}>Not everything is shown.</Text> : null}
            renderItem={({ item }) => (
              <Pressable accessibilityLabel={item.path} accessibilityRole="button" onPress={() => openEntry(item)} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
                <View style={styles.mark}>
                  <HugeiconsIcon color={item.kind === 'folder' ? colors.text : colors.muted} icon={item.kind === 'folder' ? Folder01Icon : FileEmpty02Icon} size={20} strokeWidth={1.6} />
                </View>
                <View style={styles.names}>
                  <Text numberOfLines={1} style={styles.name}>{item.name}</Text>
                  {searching ? (
                    <Text ellipsizeMode="head" numberOfLines={1} style={styles.dir}>{dirname(item.path) || '/'}</Text>
                  ) : item.kind === 'folder' ? (
                    <Text numberOfLines={1} style={styles.dir}>{item.count === 1 ? '1 file' : `${item.count} files`}</Text>
                  ) : null}
                </View>
                <HugeiconsIcon color={colors.dim} icon={ArrowRight01Icon} size={16} strokeWidth={1.7} />
              </Pressable>
            )}
          />
        </>
      )}
    </Animated.View>
  )
}

function Preview({
  path,
  preview,
  agents,
  links,
}: {
  path: string
  preview: { path: string; result: RepoFileResult | null } | null
  agents: AgentConfig[]
  links: MarkdownLinks
}) {
  const result = preview?.path === path ? preview.result : null
  if (result === null) return <Loading text="Loading file…" />
  if (result.status === 'too_large') return <Empty text={`This file is ${kb(result.size)}. Previews stop at ${kb(result.maxSize)}.`} />
  if (result.status === 'binary') return <Empty text={'This binary file cannot be previewed.'} />
  if (result.status === 'unavailable') return <Empty text={result.message} />
  if (result.content === '') return <Empty text="This file is empty." />
  if (/\.(md|markdown)$/i.test(path)) {
    return (
      <ScrollView contentContainerStyle={styles.doc}>
        <Markdown agents={agents} links={links} sources={false} text={result.content} />
      </ScrollView>
    )
  }
  return <CodeView code={result.content} language={languageOf(path, result.content.split('\n', 1)[0])} />
}

function Loading({ text }: { text: string }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.muted} />
      <Text style={styles.loadingText}>{text}</Text>
    </View>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <View style={styles.empty}>
      <HugeiconsIcon color={colors.dim} icon={FileEmpty02Icon} size={26} strokeWidth={1.5} />
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  )
}

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} kB`

const styles = StyleSheet.create({
  fill: { flex: 1 },
  search: { height: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginHorizontal: spacing.lg, marginBottom: spacing.sm, borderRadius: radius.md, ...squircle, backgroundColor: colors.surface2, paddingHorizontal: spacing.md },
  searchInput: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 16, letterSpacing: tracking.body, paddingVertical: 0 },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderRadius: radius.md, ...squircle, paddingHorizontal: spacing.md },
  rowPressed: { backgroundColor: colors.surface2 },
  mark: { width: 24, alignItems: 'center' },
  names: { flex: 1, minWidth: 0, gap: 2 },
  name: { color: colors.text, fontFamily: fonts.sans, fontSize: 15, fontWeight: '500' },
  dir: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12 },
  truncated: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17, textAlign: 'center', paddingVertical: spacing.lg },
  loading: { flex: 1, minHeight: 160, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  loadingText: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14 },
  empty: { flex: 1, minHeight: 160, alignItems: 'center', justifyContent: 'center', gap: spacing.md, paddingHorizontal: spacing.xl },
  emptyText: { maxWidth: 300, color: colors.muted, fontFamily: fonts.sans, fontSize: 15, lineHeight: 22, textAlign: 'center' },
  doc: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
})
