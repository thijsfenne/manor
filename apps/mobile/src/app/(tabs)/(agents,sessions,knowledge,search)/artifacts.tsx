import Search01Icon from '@hugeicons/core-free-icons/Search01Icon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import type { MyMindArtifact } from '@manor/contracts'
import { Image } from 'expo-image'
import * as WebBrowser from 'expo-web-browser'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native'
import { TextInput } from '@/components/TextInput'

import { ConnectGate } from '@/components/ConnectGate'
import { SectionScaffold } from '@/components/SectionScaffold'
import { serverMediaUri } from '@/lib/connection'
import { useWorkspace } from '@/providers/WorkspaceProvider'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle, tracking } from '@/theme'

export default function ArtifactsScreen() {
  return <ConnectGate><SectionScaffold title="Artifacts"><Library /></SectionScaffold></ConnectGate>
}

const KIND_LABEL: Record<MyMindArtifact['kind'], string> = {
  image: 'Image',
  article: 'Article',
  note: 'Note',
  product: 'Product',
  other: 'Item',
}

/**
 * The mymind library, searched as typed and paged as scrolled. Read-only, like on
 * the Mac: an item with a link opens in the in-app browser, the rest shows what
 * mymind kept of it.
 */
function Library() {
  const { workspace, status, listArtifacts, loadMoreArtifacts } = useWorkspace()
  const { artifacts } = workspace
  const [query, setQuery] = useState('')
  const live = status === 'live'
  const asked = useRef(false)

  // A reply-only request dies with its socket. Let the new connection ask for the
  // current search again instead of keeping a spinner for an answer that cannot land.
  useEffect(() => {
    if (!live) asked.current = false
  }, [live])

  useEffect(() => {
    if (!live || artifacts.status !== 'ready' || asked.current) return
    asked.current = true
    listArtifacts(query.trim())
  }, [artifacts.status, listArtifacts, live, query])

  // A search leaves after the typing pauses, not on every key.
  useEffect(() => {
    if (!live || artifacts.status !== 'ready' || !asked.current) return
    if (query === artifacts.query && query === (artifacts.askingQuery ?? artifacts.query)) return
    const timeout = setTimeout(() => listArtifacts(query.trim()), 300)
    return () => clearTimeout(timeout)
  }, [artifacts.askingQuery, artifacts.query, artifacts.status, listArtifacts, live, query])

  if (artifacts.status === 'none') {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>mymind is not connected</Text>
        <Text style={styles.emptyCopy}>{artifacts.connection?.problem ?? 'Connect mymind on your Mac and your library will show up here.'}</Text>
      </View>
    )
  }

  const loading = artifacts.askingQuery !== null && artifacts.objects.length === 0

  return (
    <View style={styles.host}>
      <View style={styles.search}>
        <HugeiconsIcon color={colors.muted} icon={Search01Icon} size={18} strokeWidth={1.7} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          editable={live}
          onChangeText={setQuery}
          placeholder="Search your artifacts"
          placeholderTextColor={colors.dim}
          selectionColor={colors.text}
          style={styles.searchInput}
          value={query}
        />
      </View>
      {!live ? (
        <Text style={styles.note}>Your Mac is offline.</Text>
      ) : artifacts.error !== null ? (
        <Text style={[styles.note, styles.error]}>{artifacts.error}</Text>
      ) : loading || artifacts.status === 'unknown' ? (
        <View style={styles.loading}><ActivityIndicator color={colors.muted} /></View>
      ) : (
        <FlatList
          contentContainerStyle={styles.list}
          data={artifacts.objects}
          ItemSeparatorComponent={() => <View style={styles.gap} />}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          keyExtractor={(item) => item.id}
          ListEmptyComponent={<Text style={styles.note}>{artifacts.query.trim() === '' ? 'No artifacts in this view.' : `Nothing found for “${artifacts.query.trim()}”.`}</Text>}
          ListFooterComponent={artifacts.loadingMore ? <View style={styles.loading}><ActivityIndicator color={colors.muted} /></View> : null}
          onEndReached={() => {
            if (artifacts.hasMore && !artifacts.loadingMore) loadMoreArtifacts()
          }}
          onEndReachedThreshold={0.6}
          renderItem={({ item }) => <ArtifactRow artifact={item} />}
        />
      )}
    </View>
  )
}

/** What a picture may become on a phone column, so a panorama or a tower still reads. */
const clampRatio = (ratio: number) => Math.min(1.9, Math.max(0.72, ratio))

/**
 * One item in the library. A picture is the thing being recognised, so where mymind
 * kept one it leads the card and the excerpt underneath it steps aside, exactly as
 * the Mac's grid decides it. A thumbnail that will not load falls back to those words
 * rather than leaving a hole.
 */
function ArtifactRow({ artifact }: { artifact: MyMindArtifact }) {
  const [imageFailed, setImageFailed] = useState(false)
  const image = artifact.imageUrl === undefined || imageFailed ? undefined : serverMediaUri(artifact.imageUrl)
  const body = image !== undefined ? '' : artifact.summary || artifact.note || artifact.content || ''
  const ratio = artifact.imageWidth !== undefined && artifact.imageHeight !== undefined
    ? clampRatio(artifact.imageWidth / artifact.imageHeight)
    : 4 / 3
  const open = artifact.url === undefined ? undefined : () => void WebBrowser.openBrowserAsync(artifact.url!)
  return (
    <Pressable accessibilityRole={open === undefined ? 'text' : 'link'} disabled={open === undefined} onPress={open} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      {image === undefined ? null : (
        <Image
          accessibilityLabel={artifact.title}
          contentFit="cover"
          onError={() => setImageFailed(true)}
          source={{ uri: image }}
          style={[styles.image, { aspectRatio: ratio }]}
          transition={140}
        />
      )}
      <View style={styles.rowBody}>
        <View style={styles.rowHead}>
          <Text style={styles.kind}>{KIND_LABEL[artifact.kind]}</Text>
          {artifact.spaces.length === 0 ? null : <Text numberOfLines={1} style={styles.spaces}>{artifact.spaces.join(', ')}</Text>}
        </View>
        <Text numberOfLines={2} style={styles.title}>{artifact.title}</Text>
        {body === '' ? null : <Text numberOfLines={3} style={styles.body}>{body}</Text>}
        {artifact.url === undefined ? null : <Text numberOfLines={1} style={styles.url}>{artifact.url.replace(/^https?:\/\//, '')}</Text>}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  host: { flex: 1 },
  search: { height: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginHorizontal: spacing.lg, marginVertical: spacing.sm, borderRadius: radius.md, ...squircle, backgroundColor: colors.surface2, paddingHorizontal: spacing.md },
  searchInput: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 16, letterSpacing: tracking.body, paddingVertical: 0 },
  list: { paddingHorizontal: spacing.lg, paddingBottom: 48 },
  gap: { height: spacing.sm },
  row: { overflow: 'hidden', borderRadius: radius.md, ...squircle, backgroundColor: colors.surface },
  rowBody: { gap: 4, padding: spacing.md },
  image: { width: '100%', backgroundColor: colors.surface2 },
  rowPressed: { backgroundColor: colors.surface2 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  kind: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12, fontWeight: '500' },
  spaces: { flexShrink: 1, color: colors.dim, fontFamily: fonts.sans, fontSize: 12 },
  title: { color: colors.text, fontFamily: fonts.sans, fontSize: 15, fontWeight: '500', lineHeight: 20 },
  body: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  url: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12, marginTop: 2 },
  note: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, textAlign: 'center', padding: spacing.xl },
  error: { color: colors.danger },
  loading: { padding: spacing.xl, alignItems: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.xxl },
  emptyTitle: { color: colors.text, fontFamily: fonts.sans, fontSize: 20, fontWeight: '500' },
  emptyCopy: { maxWidth: 300, color: colors.muted, fontFamily: fonts.sans, fontSize: 15, lineHeight: 22, textAlign: 'center' },
})
