import Add01Icon from '@hugeicons/core-free-icons/Add01Icon'
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon'
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon'
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import Delete02Icon from '@hugeicons/core-free-icons/Delete02Icon'
import Folder01Icon from '@hugeicons/core-free-icons/Folder01Icon'
import FolderOpenIcon from '@hugeicons/core-free-icons/FolderOpenIcon'
import PencilEdit02Icon from '@hugeicons/core-free-icons/PencilEdit02Icon'
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon'
import { PROJECT_ICON_OPTIONS, draftMark, markFields, projectColorChoices, projectLetters, projectMark, sameMark, sameRepoIcon, type ProjectMarkChoice } from '@manor/client-runtime/project-icons'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { MAX_PROJECT_FOLDERS, type Project } from '@manor/contracts'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { TextInput } from '@/components/TextInput'

import { CardButton } from '@/components/CardButton'
import { GlassIconButton } from '@/components/GlassIconButton'
import { GlassPressable } from '@/components/GlassPressable'
import { ProjectMark } from '@/components/ProjectMark'
import { Sheet } from '@/components/Sheet'
import { Text } from '@/components/Text'
import { serverMediaUri } from '@/lib/connection'
import { useWorkspace, type ProjectEdit } from '@/providers/WorkspaceProvider'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

type Draft = Omit<ProjectEdit, 'repoIcon' | 'letters'> & { mark: ProjectMarkChoice }

const draftOf = (project: Project): Draft => ({
  name: project.name,
  icon: project.icon,
  mark: projectMark(project),
  color: project.color,
  repoPaths: [...project.repoPaths],
})

const sameDraft = (one: Draft, other: Draft) =>
  one.name.trim() === other.name.trim() &&
  one.icon === other.icon &&
  sameMark(draftMark(one), draftMark(other)) &&
  one.color.toLowerCase() === other.color.toLowerCase() &&
  one.repoPaths.join('\n') === other.repoPaths.join('\n')

/**
 * The Mac's Edit project on the phone (2026-10-12), opened from the thread's pill: name,
 * icon and colour, folders and Delete, the same form saved as a whole with the tick.
 * Memory scope is the Mac's alone; the phone's save leaves it as stored. Files has no header button on a thread any more, so it lives here, next to
 * the folders it lists. Hide project thread stays on the Mac: the phone cannot re-add a hidden
 * project, so the room would drop out of its list with no way back.
 */
export function ProjectSettingsSheet({ project, open, onClose, onFiles, onDeleted, onDismiss }: {
  project: Project
  open: boolean
  onClose: () => void
  /** Present when the project has a folder to list. */
  onFiles?: () => void
  /** The project is gone, with this thread; the screen has to leave. */
  onDeleted: () => void
  /** Fires once the sheet is fully gone, for a sheet that opens after it. */
  onDismiss?: () => void
}) {
  const { workspace, status, updateProject, deleteProject, listDirs, closeDirs, findRepoIcon } = useWorkspace()
  const [draft, setDraft] = useState(() => draftOf(project))
  // The choice as the sheet opened, so a save sends it only when this sheet changed it.
  const [openedMark, setOpenedMark] = useState(() => draftMark(draftOf(project)))
  const [picking, setPicking] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The notice standing when the walk last asked, so only a newer one reads as its refusal.
  const [noticeAtBrowse, setNoticeAtBrowse] = useState(workspace.notice)
  // The save whose ack may still close the sheet; leaving the sheet first disowns it.
  const pendingSave = useRef<symbol | null>(null)

  // Every opening starts from what the project holds now, not from an abandoned edit.
  // Only the opening resets; a broadcast while editing must not wipe the draft.
  const [shownOpen, setShownOpen] = useState(open)
  if (open !== shownOpen) {
    setShownOpen(open)
    if (open) {
      setDraft(draftOf(project))
      setOpenedMark(draftMark(draftOf(project)))
      setPicking(false)
      setBrowsing(false)
      setError(null)
    }
  }

  const live = status === 'live'
  // Each opening looks at the folders again, so a favicon added since shows up.
  useEffect(() => {
    if (open && live) findRepoIcon(project.id)
  }, [findRepoIcon, live, open, project.id])
  const found = workspace.repoIcons[project.id]
  const offer = found != null && draft.repoPaths.includes(found.folder) ? found : undefined
  const mark = draftMark(draft)
  const picked = mark === 'letters' ? null : mark
  const letters = projectLetters(draft.name)
  // The offer's picture once it is the pick, else the picture the project wears now.
  const pickedSrc = picked === null ? undefined : offer !== undefined && sameRepoIcon(picked, offer) ? offer.src : project.repoIconSrc
  const offerUri = offer === undefined ? undefined : serverMediaUri(offer.src)
  // A folder request lost with the socket never answers; drop it so the walk offers a retry.
  const lostWalk = !live && workspace.dirs.asking
  useEffect(() => {
    if (lostWalk) closeDirs()
  }, [closeDirs, lostWalk])
  const dirty = !sameDraft(draft, draftOf(project))
  const canSave = live && dirty && draft.name.trim() !== '' && !saving
  const full = draft.repoPaths.length >= MAX_PROJECT_FOLDERS
  const listing = workspace.dirs.listing
  // A folder the Mac cannot open answers with a plain notice, the way New project reads it.
  const notice = workspace.notice
  const folderError = browsing && !workspace.dirs.asking && notice !== null && notice !== noticeAtBrowse && notice.requestId === undefined
    ? notice.text
    : null

  const stopBrowsing = () => {
    setBrowsing(false)
    closeDirs()
  }
  const close = () => {
    pendingSave.current = null
    if (browsing) closeDirs()
    onClose()
  }
  const save = () => {
    if (!canSave) return
    const attempt = Symbol('save')
    pendingSave.current = attempt
    setSaving(true)
    setError(null)
    // Sent only when it changed since the sheet opened: an untouched icon whose file went
    // missing must not refuse a rename, nor may it undo a choice made meanwhile on the Mac.
    const { mark: _draftMark, ...edit } = draft
    const changed = !sameMark(mark, openedMark)
    updateProject(project.id, changed ? { ...edit, ...markFields(mark) } : edit)
      .then(() => {
        if (pendingSave.current === attempt) close()
      })
      .catch((reason: unknown) => {
        if (pendingSave.current === attempt) setError(reason instanceof Error ? reason.message : 'Manor could not save the project.')
      })
      .finally(() => setSaving(false))
  }
  const browse = (path?: string) => {
    setBrowsing(true)
    setNoticeAtBrowse(workspace.notice)
    if (!listDirs(path)) setError('Manor could not request the folders on your Mac.')
  }
  const openFiles = () => {
    pendingSave.current = null
    onFiles?.()
  }
  const addFolder = (path: string) => {
    stopBrowsing()
    if (draft.repoPaths.includes(path)) return
    setDraft({ ...draft, repoPaths: [...draft.repoPaths, path] })
  }
  const askDelete = () => Alert.alert(
    `Delete “${project.name}”?`,
    'With its thread, Sessions and chats.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete project thread',
        style: 'destructive',
        onPress: () => {
          setError(null)
          deleteProject(project.id)
            .then(() => {
              onClose()
              onDeleted()
            })
            .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Manor could not delete the project.'))
        },
      },
    ],
  )

  return (
    <Sheet
      action={
        <GlassPressable
          accessibilityLabel="Save changes"
          accessibilityState={{ disabled: !canSave }}
          disabled={!canSave}
          fill
          hitSlop={6}
          onPress={save}
          radius={22}
          style={[styles.confirm, !canSave && styles.disabled]}
        >
          <View style={styles.confirmInner}>
            {saving ? <ActivityIndicator color={colors.text} size="small" /> : (
              <HugeiconsIcon color={colors.text} icon={Tick02Icon} size={22} strokeWidth={1.8} />
            )}
          </View>
        </GlassPressable>
      }
      onClose={close}
      {...(onDismiss === undefined ? {} : { onDismiss })}
      open={open}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <View style={styles.markSlot}>
            <View style={[styles.mark, { backgroundColor: `${draft.color}29` }]}>
              <ProjectMark color={draft.color} icon={draft.icon} letters={mark === 'letters' ? letters : undefined} size={44} src={pickedSrc} strokeWidth={1.5} />
            </View>
            <View style={styles.markBadge}>
              <GlassIconButton
                accessibilityLabel={picking ? 'Close icon and color' : 'Change icon and color'}
                accessibilityState={{ expanded: picking }}
                icon={PencilEdit02Icon}
                iconSize={16}
                onPress={() => setPicking(!picking)}
                size={36}
              />
            </View>
          </View>
          <TextInput
            accessibilityLabel="Project name"
            autoCapitalize="words"
            onChangeText={(name) => setDraft({ ...draft, name })}
            onSubmitEditing={save}
            placeholder="Project name"
            placeholderTextColor={colors.dim}
            returnKeyType="done"
            selectionColor={colors.text}
            style={styles.name}
            value={draft.name}
          />
        </View>

        {!picking ? null : (
          <View style={styles.picker}>
            <View style={styles.swatches}>
              {projectColorChoices(draft.color).map((option) => {
                const chosen = option.value.toLowerCase() === draft.color.toLowerCase()
                return (
                  <Pressable
                    accessibilityLabel={option.label}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: chosen }}
                    key={option.value}
                    onPress={() => setDraft({ ...draft, color: option.value })}
                    style={[styles.swatchRing, chosen && { borderColor: option.value }]}
                  >
                    <View style={[styles.swatch, { backgroundColor: option.value }]} />
                  </Pressable>
                )
              })}
            </View>
            <View style={styles.icons}>
              {offer === undefined || offerUri === undefined ? null : (
                <Pressable
                  accessibilityLabel="Repo icon"
                  accessibilityRole="radio"
                  accessibilityState={{ selected: sameRepoIcon(picked, offer) }}
                  onPress={() => setDraft({ ...draft, mark: { folder: offer.folder, path: offer.path } })}
                  style={({ pressed }) => [styles.iconCell, sameRepoIcon(picked, offer) && styles.iconChosen, pressed && styles.pressed]}
                >
                  <ProjectMark color={draft.color} icon={draft.icon} size={20} src={offer.src} />
                </Pressable>
              )}
              {letters === '' ? null : (
                <Pressable
                  accessibilityLabel="Letters"
                  accessibilityRole="radio"
                  accessibilityState={{ selected: mark === 'letters' }}
                  onPress={() => setDraft({ ...draft, mark: 'letters' })}
                  style={({ pressed }) => [styles.iconCell, mark === 'letters' && styles.iconChosen, pressed && styles.pressed]}
                >
                  <ProjectMark color={draft.color} icon={draft.icon} letters={letters} size={24} />
                </Pressable>
              )}
              {PROJECT_ICON_OPTIONS.map((option) => {
                const chosen = mark === null && option.value === draft.icon
                return (
                  <Pressable
                    accessibilityLabel={option.label}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: chosen }}
                    key={option.value}
                    onPress={() => setDraft({ ...draft, icon: option.value, mark: null })}
                    style={({ pressed }) => [styles.iconCell, chosen && styles.iconChosen, pressed && styles.pressed]}
                  >
                    <HugeiconsIcon color={chosen ? draft.color : colors.muted} icon={option.icon} size={20} strokeWidth={1.8} />
                  </Pressable>
                )
              })}
            </View>
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.label}>Folders</Text>
          <View style={styles.card}>
            {draft.repoPaths.map((path) => (
              <View key={path} style={styles.row}>
                <HugeiconsIcon color={colors.muted} icon={Folder01Icon} size={20} strokeWidth={1.7} />
                <FolderPath path={path} />
                <Pressable
                  accessibilityLabel={`Remove ${path}`}
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => setDraft({ ...draft, repoPaths: draft.repoPaths.filter((candidate) => candidate !== path) })}
                  style={({ pressed }) => [styles.removeFolder, pressed && styles.pressed]}
                >
                  <HugeiconsIcon color={colors.dim} icon={Cancel01Icon} size={16} strokeWidth={1.8} />
                </Pressable>
                <View style={styles.line} />
              </View>
            ))}
            {browsing ? (
              <FolderWalk
                asking={workspace.dirs.asking && live}
                error={folderError}
                live={live}
                listing={listing}
                onAdd={addFolder}
                onBrowse={browse}
                onDone={stopBrowsing}
              />
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: full || !live }}
                disabled={full || !live}
                onPress={() => browse()}
                style={({ pressed }) => [styles.row, (full || !live) && styles.disabled, pressed && styles.rowPressed]}
              >
                <HugeiconsIcon color={colors.text} icon={Add01Icon} size={20} strokeWidth={1.8} />
                <Text style={styles.rowLabel}>Add a folder…</Text>
              </Pressable>
            )}
          </View>
          {!full || browsing ? null : (
            <Text style={styles.hint}>That is the most a project can link ({MAX_PROJECT_FOLDERS}).</Text>
          )}
        </View>

        {onFiles === undefined ? null : (
          <View style={styles.card}>
            <Pressable
              accessibilityRole="button"
              onPress={openFiles}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <HugeiconsIcon color={colors.text} icon={FolderOpenIcon} size={20} strokeWidth={1.7} />
              <Text style={styles.rowLabel}>Files</Text>
              <HugeiconsIcon color={colors.dim} icon={ArrowRight01Icon} size={16} strokeWidth={1.7} />
            </Pressable>
          </View>
        )}

        {error === null ? null : <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}

        <View style={[styles.card, styles.deleteCard]}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !live }}
            disabled={!live}
            onPress={askDelete}
            style={({ pressed }) => [styles.row, styles.deleteRow, !live && styles.disabled, pressed && styles.rowPressed]}
          >
            <HugeiconsIcon color={colors.danger} icon={Delete02Icon} size={20} strokeWidth={1.8} />
            <Text style={styles.deleteText}>Delete project thread</Text>
          </Pressable>
        </View>
      </ScrollView>
    </Sheet>
  )
}

/** A linked folder as its parent path, quiet and cut from the front, then its own name. */
function FolderPath({ path }: { path: string }) {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/') + 1
  return (
    <Text accessibilityLabel={path} ellipsizeMode="head" numberOfLines={1} style={styles.path}>
      <Text style={styles.pathParent}>{path.slice(0, cut)}</Text>
      {path.slice(cut)}
    </Text>
  )
}

/** Walks the Mac's folders as the last part of the Folders card, the way New project does on the phone. */
function FolderWalk({ listing, asking, error, live, onBrowse, onAdd, onDone }: {
  listing: ReturnType<typeof useWorkspace>['workspace']['dirs']['listing']
  asking: boolean
  error: string | null
  live: boolean
  onBrowse: (path?: string) => void
  onAdd: (path: string) => void
  onDone: () => void
}) {
  return (
    <View style={styles.walk}>
      {error === null ? null : <Text accessibilityRole="alert" style={[styles.error, styles.walkError]}>{error}</Text>}
      {listing === null ? (
        asking ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.muted} />
            <Text style={styles.hint}>Loading folders on your Mac…</Text>
          </View>
        ) : (
          // Nothing is on its way: a refusal or a lost connection. The user asks again.
          <View style={styles.loading}>
            {error !== null ? null : <Text style={styles.hint}>{live ? 'Nothing came back.' : 'Connect to your Mac first.'}</Text>}
            <CardButton disabled={!live} label="Ask again" onPress={() => onBrowse()} />
          </View>
        )
      ) : (
        <>
          <Text numberOfLines={2} style={styles.where}>{listing.path}</Text>
          {listing.parent === null ? null : (
            <Pressable
              accessibilityLabel="Up one folder"
              accessibilityRole="button"
              onPress={() => onBrowse(listing.parent ?? undefined)}
              style={({ pressed }) => [styles.walkRow, pressed && styles.pressed]}
            >
              <HugeiconsIcon color={colors.muted} icon={ArrowLeft01Icon} size={17} strokeWidth={1.7} />
              <Text style={styles.walkName}>Up</Text>
            </Pressable>
          )}
          {listing.entries.map((entry) => (
            <Pressable
              accessibilityLabel={`Open folder ${entry.name}`}
              accessibilityRole="button"
              key={entry.path}
              onPress={() => onBrowse(entry.path)}
              style={({ pressed }) => [styles.walkRow, pressed && styles.pressed]}
            >
              <HugeiconsIcon color={colors.muted} icon={Folder01Icon} size={17} strokeWidth={1.7} />
              <Text numberOfLines={1} style={styles.walkName}>{entry.name}</Text>
              <HugeiconsIcon color={colors.dim} icon={ArrowRight01Icon} size={16} strokeWidth={1.7} />
            </Pressable>
          ))}
        </>
      )}
      <View style={styles.walkActions}>
        <CardButton label="Cancel" onPress={onDone} variant="quiet" />
        <CardButton
          disabled={listing === null}
          label="Add this folder"
          onPress={() => listing === null ? undefined : onAdd(listing.path)}
          variant="primary"
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  content: { gap: spacing.xxl, paddingHorizontal: spacing.lg, paddingTop: spacing.xs, paddingBottom: spacing.xl },
  confirm: { width: 44, height: 44 },
  confirmInner: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  // Centred like the agent overview: the tile, then the name as the page's title.
  hero: { alignItems: 'center', gap: spacing.lg },
  markSlot: { width: 88, height: 88 },
  mark: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 44 },
  // Centred on the circle's edge at its lower right.
  markBadge: { position: 'absolute', right: -5, bottom: -5 },
  name: {
    alignSelf: 'stretch',
    color: colors.text,
    fontFamily: fonts.sansMedium,
    fontSize: 24,
    letterSpacing: -0.4,
    textAlign: 'center',
    paddingVertical: spacing.xs,
  },
  picker: { gap: spacing.md, borderRadius: radius.panel, ...squircle, backgroundColor: colors.sheetSurface, padding: spacing.md },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  swatchRing: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18, borderWidth: 2, borderColor: 'transparent' },
  swatch: { width: 24, height: 24, borderRadius: 12 },
  icons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  iconCell: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, ...squircle },
  iconChosen: { backgroundColor: colors.sheetPressed },
  section: { gap: spacing.sm },
  label: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, paddingHorizontal: spacing.lg },
  // The grouped list of the agent overview: one surface, rows split by an inset hairline.
  card: { overflow: 'hidden', borderRadius: radius.panel, ...squircle, backgroundColor: colors.sheetSurface },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg },
  rowPressed: { backgroundColor: colors.sheetPressed },
  rowLabel: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 16 },
  line: { position: 'absolute', right: 0, bottom: 0, left: spacing.lg + 20 + spacing.md, height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  path: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 15, fontWeight: '500' },
  pathParent: { color: colors.dim, fontWeight: '400' },
  removeFolder: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', marginRight: -spacing.sm },
  hint: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, paddingHorizontal: spacing.lg },
  walk: { gap: 2, padding: spacing.sm },
  loading: { minHeight: 80, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  where: { color: colors.muted, fontFamily: fonts.mono, fontSize: 12, lineHeight: 17, padding: spacing.sm },
  walkRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.sm },
  walkName: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 15 },
  walkActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm, paddingTop: spacing.sm },
  error: { color: colors.danger, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  walkError: { padding: spacing.sm },
  deleteCard: { marginTop: spacing.lg },
  deleteRow: { justifyContent: 'center', gap: spacing.sm },
  deleteText: { color: colors.danger, fontFamily: fonts.sans, fontSize: 16 },
})
