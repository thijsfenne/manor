import { buildNoteIndex, resolveNote } from '@manor/client-runtime/vault-notes'
import { useFocusEffect } from 'expo-router'
import { useCallback, useMemo, useState } from 'react'
import { StyleSheet, View } from 'react-native'

import { ConnectGate } from '@/components/ConnectGate'
import { FileBrowser, ROOT_PLACE, placeBehind, placeTitles, type BrowserPlace } from '@/components/FileBrowser'
import { SectionScaffold } from '@/components/SectionScaffold'
import { useTabReset } from '@/lib/tabNavigation'
import { useWorkspace } from '@/providers/WorkspaceProvider'
import { Text } from '@/components/Text'
import { colors, fonts, spacing } from '@/theme'

export default function KnowledgeScreen() {
  return <ConnectGate><Vault /></ConnectGate>
}

/**
 * The vault, walked folder by folder like a project's files. The listing is asked
 * for here and not on connect, because a second brain is thousands of paths and
 * nobody pays for them until they open this screen.
 */
function Vault() {
  const { workspace, status, listVault, readVaultFile } = useWorkspace()
  const [place, setPlace] = useState<BrowserPlace>(ROOT_PLACE)
  const { vault } = workspace
  const live = status === 'live'
  useTabReset('(knowledge)', () => setPlace(ROOT_PLACE))

  // Its own file, not the vault's last read: the Search tab opens notes through the same slot.
  useFocusEffect(
    useCallback(() => {
      if (!live || vault.status !== 'ready') return
      listVault()
      if (place.file !== null) readVaultFile(place.file)
    }, [listVault, live, readVaultFile, place.file, vault.status]),
  )

  const behind = placeBehind(place)
  const { title } = placeTitles(place, 'Knowledge', vault.name ?? 'Vault')
  // What a `[[wikilink]]` resolves against, and the reason the syntax is live here at
  // all. The vault listing is notes and nothing else, which is what makes it an index;
  // the project files sheet hands the same browser none, so brackets stay brackets.
  const notes = useMemo(() => buildNoteIndex(vault.files ?? []), [vault.files])

  const pictures = useMemo(
    () => ({ images: vault.images ?? {}, attachmentFolder: vault.attachmentFolder ?? null }),
    [vault.images, vault.attachmentFolder],
  )

  const content = vault.status === 'none' ? (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>No Knowledge folder on this Mac</Text>
        <Text style={styles.emptyCopy}>Check Settings → Memory & knowledge on your Mac.</Text>
      </View>
  ) : (
    <FileBrowser
      agents={workspace.agents}
      emptyText="The vault is empty, or Manor is not allowed to read it."
      files={vault.status === 'unknown' ? null : vault.files}
      live={live}
      onPlace={setPlace}
      onRead={readVaultFile}
      pictures={pictures}
      place={place}
      preview={vault.note}
      resolveWikilink={(target) => resolveNote(notes, target)}
      truncated={vault.truncated}
    />
  )

  return (
    <SectionScaffold
      onBack={behind === null ? undefined : () => setPlace(behind)}
      title={title}
    >
      {content}
    </SectionScaffold>
  )
}

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.xxl },
  emptyTitle: { color: colors.text, fontFamily: fonts.sans, fontSize: 20, fontWeight: '500' },
  emptyCopy: { maxWidth: 300, color: colors.muted, fontFamily: fonts.sans, fontSize: 15, lineHeight: 22, textAlign: 'center' },
})
