import Download04Icon from '@hugeicons/core-free-icons/Download04Icon'
import Message01Icon from '@hugeicons/core-free-icons/Message01Icon'
import SquareArrowUpRightIcon from '@hugeicons/core-free-icons/SquareArrowUpRightIcon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import type { AgentConfig, DmFile } from '@manor/contracts'
import { DM_FILE_FILTERS, DM_FILES_EMPTY_TITLE, DM_FILES_MORE, DM_FILES_SHOWN, DM_FILTER_EMPTY, dmFilesEmptyLine, filterDmFiles, groupDmFiles, type DmFileFilter } from '@manor/client-runtime/dm-files'
import { Image } from 'expo-image'
import { useRef, useState } from 'react'
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated'

import { dmFileGlyph, FileViewer, saveDmFile } from '@/components/FileViewer'
import { SegmentedControl } from '@/components/SegmentedControl'
import { Sheet } from '@/components/Sheet'
import { Text } from '@/components/Text'
import { serverMediaUri } from '@/lib/config'
import { fileFailure } from '@/lib/fileSave'
import { relativeTime } from '@/lib/time'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

/**
 * A DM's files as the phone shows them: filter chips, then this week and older as
 * two cards of rows, newest first. Tap opens the viewer; long press opens a menu with
 * Open, Download and, when the file's message is known, Show in chat. `files` is
 * undefined until the server has answered.
 */
export function FileLibrary({ name, files, agents, onShowInChat }: {
  /** The DM's agent, as the empty library names it. */
  name: string
  files: readonly DmFile[] | undefined
  agents: readonly AgentConfig[]
  /** Leaves the library for the message the file came with. */
  onShowInChat: (messageId: string) => void
}) {
  const still = useReducedMotion()
  // The week boundary is read once per visit; the screen is short-lived.
  const [now] = useState(Date.now)
  const [filter, setFilter] = useState<DmFileFilter>('all')
  const [extra, setExtra] = useState<Record<string, number>>({})
  const [viewingId, setViewingId] = useState<string | null>(null)
  // The menu keeps its file while it slides away, so its rows do not blank mid-dismiss.
  const [menu, setMenu] = useState<{ file: DmFile; open: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // What the menu hands on once its sheet is fully gone: iOS cannot present a second
  // modal, or leave the screen, while a page sheet is still dismissing.
  const afterMenu = useRef<(() => void) | null>(null)
  const closeMenu = (then?: () => void) => {
    setMenu((current) => (current === null ? null : { ...current, open: false }))
    if (then === undefined) return
    if (Platform.OS === 'ios') afterMenu.current = then
    else then()
  }

  if (files === undefined) {
    return <View style={styles.center}><ActivityIndicator color={colors.muted} /></View>
  }
  if (files.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>{DM_FILES_EMPTY_TITLE}</Text>
        <Text style={styles.emptyBody}>{dmFilesEmptyLine(name)}</Text>
      </View>
    )
  }

  const shown = filterDmFiles(files, filter)
  const groups = groupDmFiles(shown, now)
  const viewing = viewingId === null || !shown.some((file) => file.id === viewingId) ? null : viewingId

  return (
    <>
      <ScrollView contentContainerStyle={styles.list}>
        <SegmentedControl label="Filter" onChange={setFilter} options={DM_FILE_FILTERS} value={filter} />
        {filter !== 'all' && groups.length === 0 ? (
          <Text style={styles.filterEmpty}>{DM_FILTER_EMPTY[filter]}</Text>
        ) : groups.map((group) => {
          const limit = DM_FILES_SHOWN + (extra[group.label] ?? 0)
          const rows = group.files.slice(0, limit)
          return (
            <Animated.View entering={still ? undefined : FadeIn.duration(120)} key={group.label} style={styles.section}>
              <Text style={styles.sectionTitle}>{group.label}</Text>
              <View style={styles.card}>
                {rows.map((file) => (
                  <FileRow
                    file={file}
                    key={file.id}
                    onLongPress={() => { setError(null); setMenu({ file, open: true }) }}
                    onOpen={() => setViewingId(file.id)}
                  />
                ))}
                {rows.length < group.files.length ? (
                  <Pressable
                    accessibilityLabel="Show more"
                    accessibilityRole="button"
                    onPress={() => setExtra((current) => ({ ...current, [group.label]: (current[group.label] ?? 0) + DM_FILES_MORE }))}
                    style={({ pressed }) => [styles.more, pressed && styles.pressed]}
                  >
                    <Text style={styles.moreText}>Show more</Text>
                  </Pressable>
                ) : null}
              </View>
            </Animated.View>
          )
        })}
      </ScrollView>
      <FileMenu
        error={error}
        file={menu?.file ?? null}
        onClose={() => closeMenu()}
        onDismiss={() => {
          const then = afterMenu.current
          afterMenu.current = null
          then?.()
        }}
        open={menu?.open === true}
        onDownload={async (file) => {
          setError(null)
          try {
            await saveDmFile(file)
            closeMenu()
          } catch (failure: unknown) {
            setError(fileFailure(failure))
          }
        }}
        onOpen={(file) => closeMenu(() => setViewingId(file.id))}
        onShowInChat={(messageId) => closeMenu(() => onShowInChat(messageId))}
      />
      {viewing === null ? null : (
        <FileViewer agents={agents} files={shown} initialId={viewing} onClose={() => setViewingId(null)} />
      )}
    </>
  )
}

function FileRow({ file, onOpen, onLongPress }: { file: DmFile; onOpen: () => void; onLongPress: () => void }) {
  const available = file.src !== undefined
  const picture = file.kind === 'image' && file.src !== undefined ? serverMediaUri(file.src) : undefined
  return (
    <Pressable
      accessibilityLabel={file.name}
      accessibilityRole="button"
      onLongPress={onLongPress}
      onPress={onOpen}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed, !available && styles.unavailable]}
    >
      <View style={styles.thumb}>
        {picture === undefined ? (
          <HugeiconsIcon color={colors.muted} icon={dmFileGlyph(file.kind)} size={20} strokeWidth={1.7} />
        ) : (
          <Image accessibilityIgnoresInvertColors contentFit="cover" source={{ uri: picture }} style={StyleSheet.absoluteFill} />
        )}
      </View>
      <Text numberOfLines={1} style={styles.name}>{file.name}</Text>
      <Text style={styles.age}>{available ? relativeTime(file.ts) : 'Unavailable'}</Text>
    </Pressable>
  )
}

/** The long-press menu: one sheet with a row per action. Download needs the bytes, Show in chat needs the message. */
function FileMenu({ file, open, error, onClose, onDismiss, onOpen, onDownload, onShowInChat }: {
  file: DmFile | null
  open: boolean
  error: string | null
  onClose: () => void
  onDismiss: () => void
  onOpen: (file: DmFile) => void
  onDownload: (file: DmFile) => Promise<void>
  onShowInChat: (messageId: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const available = file?.src !== undefined
  return (
    <Sheet onClose={onClose} onDismiss={onDismiss} open={open} title={file?.name ?? 'File'}>
      <View style={styles.menu}>
        <View style={styles.menuGroup}>
          {file === null ? null : (
            <>
              <MenuAction icon={SquareArrowUpRightIcon} label="Open" onPress={() => onOpen(file)} />
              <MenuAction
                busy={busy}
                disabled={!available || busy}
                icon={Download04Icon}
                label="Download"
                last={file.messageId === undefined}
                onPress={() => {
                  setBusy(true)
                  void onDownload(file).finally(() => setBusy(false))
                }}
              />
              {file.messageId === undefined ? null : (
                <MenuAction icon={Message01Icon} label="Show in chat" last onPress={() => onShowInChat(file.messageId ?? '')} />
              )}
            </>
          )}
        </View>
        {error === null ? null : <Text accessibilityRole="alert" style={styles.menuError}>{error}</Text>}
      </View>
    </Sheet>
  )
}

function MenuAction({ label, icon, last = false, busy = false, disabled = false, onPress }: {
  label: string
  icon: typeof Download04Icon
  last?: boolean
  busy?: boolean
  disabled?: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ busy, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.menuRow, pressed && styles.rowPressed, disabled && !busy && styles.unavailable]}
    >
      <HugeiconsIcon color={colors.text} icon={icon} size={19} strokeWidth={1.7} />
      <Text style={styles.menuLabel}>{busy ? '…' : label}</Text>
      {last ? null : <View style={styles.line} />}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', flex: 1, gap: 6, justifyContent: 'center', paddingHorizontal: spacing.xl },
  emptyTitle: { color: colors.text, fontFamily: fonts.sans, fontSize: 16, fontWeight: '500', textAlign: 'center' },
  emptyBody: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, maxWidth: 300, textAlign: 'center' },
  list: { gap: spacing.xl, paddingBottom: spacing.xxl, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  filterEmpty: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, paddingVertical: spacing.xl, textAlign: 'center' },
  section: { gap: spacing.sm },
  sectionTitle: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500', paddingHorizontal: spacing.xs },
  card: { backgroundColor: colors.surface2, borderRadius: radius.panel, ...squircle, overflow: 'hidden' },
  row: { alignItems: 'center', flexDirection: 'row', gap: spacing.md, minHeight: 64, paddingHorizontal: spacing.lg },
  rowPressed: { backgroundColor: colors.fill },
  unavailable: { opacity: 0.45 },
  thumb: { alignItems: 'center', backgroundColor: colors.fill, borderRadius: radius.sm, ...squircle, height: 40, justifyContent: 'center', overflow: 'hidden', width: 40 },
  name: { color: colors.text, flex: 1, fontFamily: fonts.sans, fontSize: 16 },
  age: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13 },
  // Between the actions of the long-press menu, inset on both sides.
  line: { backgroundColor: colors.line, bottom: 0, height: StyleSheet.hairlineWidth, left: spacing.lg, position: 'absolute', right: spacing.lg },
  more: { alignItems: 'center', justifyContent: 'center', minHeight: 48 },
  moreText: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, fontWeight: '500' },
  pressed: { opacity: 0.7 },
  menu: { gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  menuGroup: { backgroundColor: colors.sheetSurface, borderRadius: radius.panel, ...squircle, overflow: 'hidden' },
  menuRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.md, minHeight: 52, paddingHorizontal: spacing.lg },
  menuLabel: { color: colors.text, flex: 1, fontFamily: fonts.sans, fontSize: 16 },
  menuError: { color: colors.warning, fontFamily: fonts.sans, fontSize: 12, paddingHorizontal: spacing.sm },
})
