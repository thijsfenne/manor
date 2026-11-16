import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import Download04Icon from '@hugeicons/core-free-icons/Download04Icon'
import File01Icon from '@hugeicons/core-free-icons/File01Icon'
import Image01Icon from '@hugeicons/core-free-icons/Image01Icon'
import Pdf01Icon from '@hugeicons/core-free-icons/Pdf01Icon'
import SquareArrowUpRightIcon from '@hugeicons/core-free-icons/SquareArrowUpRightIcon'
import Video01Icon from '@hugeicons/core-free-icons/Video01Icon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import type { AgentConfig, DmFile, DmFileKind } from '@manor/contracts'
import { describeBytes } from '@manor/client-runtime/attachments'
import { dmFileReadsAs, dmFileTypeLabel } from '@manor/client-runtime/dm-files'
import { Image } from 'expo-image'
import * as WebBrowser from 'expo-web-browser'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { GlassIconButton } from '@/components/GlassIconButton'
import { Markdown } from '@/components/Markdown'
import { Text } from '@/components/Text'
import { serverMediaUri } from '@/lib/config'
import { FILE_GONE, fileFailure, saveToShareSheet } from '@/lib/fileSave'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

const GLYPHS = { image: Image01Icon, video: Video01Icon, pdf: Pdf01Icon, file: File01Icon } as const
/** The glyph a file of this kind wears where there is no picture to show. */
export const dmFileGlyph = (kind: DmFileKind) => GLYPHS[kind]

/** Hands a copy of the file to the share sheet. Throws on failure, and for a file whose bytes are gone. */
export async function saveDmFile(file: DmFile): Promise<void> {
  const uri = file.src === undefined ? undefined : serverMediaUri(file.src)
  if (uri === undefined) throw new Error(FILE_GONE)
  await saveToShareSheet(uri, file.id, file.name)
}

/** A delivered page is drawn by the server's sandboxed wrapper, asked for with `view=1`. */
const browserUri = (file: DmFile, uri: string) =>
  file.page === true ? `${uri}${uri.includes('?') ? '&' : '?'}view=1` : uri

const THUMB = 52
const STRIP_GAP = spacing.sm

/**
 * Full-screen viewer for a DM's files. Swiping pages through `files` (the library's
 * current filter); the strip at the bottom jumps to one. Pictures
 * show in place, markdown and text are read into the page, anything else is a card
 * with Open and Download. The empty band under the strip is kept free for a message box.
 */
export function FileViewer({ files, initialId, agents, onClose }: {
  files: readonly DmFile[]
  initialId: string
  agents: readonly AgentConfig[]
  onClose: () => void
}) {
  const { width } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const start = Math.max(0, files.findIndex((file) => file.id === initialId))
  const [current, setCurrent] = useState(start)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const pager = useRef<FlatList<DmFile>>(null)
  const strip = useRef<FlatList<DmFile>>(null)
  const file = files[current]

  const goTo = (index: number, animated: boolean) => {
    setCurrent(index)
    setError(null)
    pager.current?.scrollToIndex({ index, animated })
    strip.current?.scrollToIndex({ index, animated, viewPosition: 0.5 })
  }
  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = Math.round(event.nativeEvent.contentOffset.x / width)
    if (index === current) return
    setCurrent(index)
    setError(null)
    strip.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 })
  }

  const download = async () => {
    if (file === undefined || saving) return
    setSaving(true)
    setError(null)
    try {
      await saveDmFile(file)
    } catch (failure: unknown) {
      setError(fileFailure(failure))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal animationType="fade" onRequestClose={onClose} statusBarTranslucent visible>
      {/* A modal is its own native root, so its controls need their own handler root. */}
      <GestureHandlerRootView style={styles.viewer}>
        <FlatList
          data={files}
          getItemLayout={(_, index) => ({ index, length: width, offset: width * index })}
          horizontal
          initialNumToRender={1}
          initialScrollIndex={start}
          keyExtractor={(item) => item.id}
          onMomentumScrollEnd={settle}
          pagingEnabled
          ref={pager}
          renderItem={({ item }) => <Page agents={agents} file={item} width={width} />}
          showsHorizontalScrollIndicator={false}
          style={styles.pager}
          windowSize={3}
        />
        <View pointerEvents="box-none" style={[styles.header, { paddingTop: Math.max(insets.top, spacing.lg) }]}>
          {/* Room for one more round button, which belongs here once it exists. */}
          <View style={styles.headerSide} />
          <View style={styles.titlePill}>
            <Text numberOfLines={1} style={styles.titleText}>{file?.name ?? ''}</Text>
          </View>
          <View style={[styles.headerSide, styles.headerRight]}>
            {file?.src === undefined ? null : (
              <GlassIconButton accessibilityLabel="Download" accessibilityState={{ busy: saving }} icon={Download04Icon} onPress={() => void download()} />
            )}
            <GlassIconButton accessibilityLabel="Close" icon={Cancel01Icon} onPress={onClose} />
          </View>
        </View>
        <View pointerEvents="box-none" style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
          {error === null ? null : <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
          {file === undefined ? null : (
            <View style={styles.caption}>
              <Text numberOfLines={1} style={styles.captionName}>{file.name}</Text>
              <Text style={styles.captionPlace}>{`${current + 1} / ${files.length}`}</Text>
            </View>
          )}
          <FlatList
            contentContainerStyle={styles.stripContent}
            data={files}
            getItemLayout={(_, index) => ({ index, length: THUMB + STRIP_GAP, offset: (THUMB + STRIP_GAP) * index })}
            horizontal
            initialScrollIndex={start}
            keyExtractor={(item) => item.id}
            ref={strip}
            renderItem={({ item, index }) => <StripThumb file={item} onPress={() => goTo(index, false)} selected={index === current} />}
            showsHorizontalScrollIndicator={false}
            style={styles.strip}
          />
          {/* Reserved for a message box; nothing draws here yet. */}
          <View style={styles.reserved} />
        </View>
      </GestureHandlerRootView>
    </Modal>
  )
}

function StripThumb({ file, selected, onPress }: { file: DmFile; selected: boolean; onPress: () => void }) {
  const uri = file.kind === 'image' && file.src !== undefined ? serverMediaUri(file.src) : undefined
  return (
    <Pressable
      accessibilityLabel={file.name}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.thumb, selected && styles.thumbSelected]}
    >
      {uri === undefined ? (
        <HugeiconsIcon color={colors.muted} icon={dmFileGlyph(file.kind)} size={22} strokeWidth={1.7} />
      ) : (
        <Image accessibilityIgnoresInvertColors contentFit="cover" source={{ uri }} style={StyleSheet.absoluteFill} />
      )}
    </Pressable>
  )
}

function Page({ file, width, agents }: { file: DmFile; width: number; agents: readonly AgentConfig[] }) {
  const uri = file.src === undefined ? undefined : serverMediaUri(file.src)
  const reads = dmFileReadsAs(file)
  let body = <FileCard file={file} uri={uri} {...(uri === undefined ? { note: FILE_GONE } : {})} />
  if (uri !== undefined && file.kind === 'image') body = <PictureBody file={file} uri={uri} />
  else if (uri !== undefined && reads !== null) body = <TextBody agents={agents} file={file} reads={reads} uri={uri} />
  return <View style={[styles.page, { width }]}>{body}</View>
}

function PictureBody({ file, uri }: { file: DmFile; uri: string }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading')
  if (state === 'failed') return <Text style={styles.status}>The image could not be loaded.</Text>
  return (
    <>
      <Image
        accessibilityIgnoresInvertColors
        accessibilityLabel={file.name}
        contentFit="contain"
        onError={() => setState('failed')}
        onLoad={() => setState('loaded')}
        source={{ uri }}
        style={StyleSheet.absoluteFill}
      />
      {state === 'loading' ? <ActivityIndicator color={colors.muted} /> : null}
    </>
  )
}

/** A text file read whole into the page: markdown rendered, anything else in monospace. */
function TextBody({ file, uri, reads, agents }: { file: DmFile; uri: string; reads: 'markdown' | 'text'; agents: readonly AgentConfig[] }) {
  const still = useReducedMotion()
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const insets = useSafeAreaInsets()

  useEffect(() => {
    const abort = new AbortController()
    fetch(uri, { signal: abort.signal })
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then(setText)
      .catch(() => { if (!abort.signal.aborted) setFailed(true) })
    return () => abort.abort()
  }, [uri])

  if (failed) return <FileCard file={file} uri={uri} note="The file could not be read here." />
  if (text === null) return <ActivityIndicator color={colors.muted} />
  return (
    <Animated.View entering={still ? undefined : FadeIn.duration(120)} style={styles.textFrame}>
      {/* Clear of the floating header above and the caption, strip and message room below. */}
      <ScrollView contentContainerStyle={[styles.textContent, { paddingTop: insets.top + 76, paddingBottom: insets.bottom + 200 }]}>
        {reads === 'markdown' ? (
          <Markdown agents={agents} text={text} />
        ) : (
          <Text selectable style={styles.mono}>{text}</Text>
        )}
      </ScrollView>
    </Animated.View>
  )
}

/** What a file the phone cannot draw shows: its glyph, what it is, Open and Download. */
function FileCard({ file, uri, note }: { file: DmFile; uri: string | undefined; note?: string }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'open' | 'save' | null>(null)

  const run = async (action: 'open' | 'save') => {
    if (uri === undefined || busy !== null) return
    setBusy(action)
    setError(null)
    try {
      if (action === 'open') await WebBrowser.openBrowserAsync(browserUri(file, uri))
      else await saveDmFile(file)
    } catch (failure: unknown) {
      setError(fileFailure(failure))
    } finally {
      setBusy(null)
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.cardGlyph}>
        <HugeiconsIcon color={colors.muted} icon={dmFileGlyph(file.kind)} size={32} strokeWidth={1.6} />
      </View>
      <Text numberOfLines={2} style={styles.cardName}>{file.name}</Text>
      <View style={styles.cardFacts}>
        <Text style={styles.cardMeta}>{dmFileTypeLabel(file.kind)}</Text>
        <Text style={styles.cardMeta}>{describeBytes(file.size)}</Text>
      </View>
      {note === undefined ? null : <Text style={styles.cardMeta}>{note}</Text>}
      <View style={styles.cardActions}>
        <CardButton busy={busy === 'open'} disabled={uri === undefined || busy !== null} icon={SquareArrowUpRightIcon} label="Open" onPress={() => void run('open')} />
        <CardButton busy={busy === 'save'} disabled={uri === undefined || busy !== null} icon={Download04Icon} label="Download" onPress={() => void run('save')} />
      </View>
      {error === null ? null : <Text accessibilityRole="alert" style={styles.cardError}>{error}</Text>}
    </View>
  )
}

function CardButton({ label, icon, busy, disabled, onPress }: { label: string; icon: typeof File01Icon; busy: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ busy, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.cardButton, pressed && styles.pressed, disabled && !busy && styles.disabled]}
    >
      <HugeiconsIcon color={colors.text} icon={icon} size={17} strokeWidth={1.8} />
      <Text style={styles.cardButtonText}>{busy ? '…' : label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  viewer: { flex: 1, backgroundColor: colors.background },
  pager: { flex: 1 },
  page: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  header: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, left: spacing.lg, position: 'absolute', right: spacing.lg, top: 0 },
  headerSide: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  headerRight: { justifyContent: 'flex-end', gap: spacing.sm },
  titlePill: { maxWidth: '50%', backgroundColor: colors.raised, borderColor: colors.line, borderRadius: radius.round, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  titleText: { color: colors.text, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  footer: { bottom: 0, gap: spacing.sm, left: 0, position: 'absolute', right: 0 },
  caption: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'center', paddingHorizontal: spacing.lg },
  captionName: { color: colors.muted, flexShrink: 1, fontFamily: fonts.sans, fontSize: 13 },
  captionPlace: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, fontVariant: ['tabular-nums'] },
  error: { color: colors.warning, fontFamily: fonts.sans, fontSize: 12, paddingHorizontal: spacing.lg, textAlign: 'center' },
  strip: { flexGrow: 0 },
  stripContent: { gap: STRIP_GAP, paddingHorizontal: spacing.lg },
  thumb: { alignItems: 'center', backgroundColor: colors.surface2, borderColor: 'transparent', borderRadius: radius.sm, ...squircle, borderWidth: 2, height: THUMB, justifyContent: 'center', overflow: 'hidden', width: THUMB },
  thumbSelected: { borderColor: colors.text },
  reserved: { height: 56 },
  status: { color: colors.muted, fontFamily: fonts.sans, fontSize: 15, paddingHorizontal: spacing.xl, textAlign: 'center' },
  textFrame: { alignSelf: 'stretch', flex: 1 },
  textContent: { paddingHorizontal: spacing.lg },
  mono: { color: colors.text, fontFamily: fonts.mono, fontSize: 13, lineHeight: 19 },
  card: { alignItems: 'center', gap: spacing.sm, maxWidth: 320, paddingHorizontal: spacing.xl },
  cardGlyph: { alignItems: 'center', backgroundColor: colors.surface2, borderRadius: radius.lg, ...squircle, height: 72, justifyContent: 'center', marginBottom: spacing.sm, width: 72 },
  cardName: { color: colors.text, fontFamily: fonts.sans, fontSize: 17, fontWeight: '500', textAlign: 'center' },
  cardMeta: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, textAlign: 'center' },
  cardFacts: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'center' },
  cardActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  cardButton: { alignItems: 'center', backgroundColor: colors.fill, borderRadius: radius.round, flexDirection: 'row', gap: spacing.xs, minHeight: 44, paddingHorizontal: spacing.lg },
  cardButtonText: { color: colors.text, fontFamily: fonts.sans, fontSize: 15, fontWeight: '500' },
  cardError: { color: colors.warning, fontFamily: fonts.sans, fontSize: 12, textAlign: 'center' },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
})
