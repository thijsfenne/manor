import Add01Icon from '@hugeicons/core-free-icons/Add01Icon'
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon'
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon'
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import Delete02Icon from '@hugeicons/core-free-icons/Delete02Icon'
import Folder01Icon from '@hugeicons/core-free-icons/Folder01Icon'
import FolderOpenIcon from '@hugeicons/core-free-icons/FolderOpenIcon'
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon'
import { PROJECT_ICON_OPTIONS, projectColorChoices, projectIcon } from '@manor/client-runtime/project-icons'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { MAX_PROJECT_FOLDERS, type Project } from '@manor/contracts'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { TextInput } from '@/components/TextInput'

import { Checkbox } from '@/components/Checkbox'
import { GlassPressable } from '@/components/GlassPressable'
import { Sheet } from '@/components/Sheet'
import { Text } from '@/components/Text'
import { useWorkspace, type ProjectEdit } from '@/providers/WorkspaceProvider'
import { colors, fonts, radius, spacing, squircle, tracking } from '@/theme'

const draftOf = (project: Project): ProjectEdit => ({
  name: project.name,
  icon: project.icon,
  color: project.color,
  repoPaths: [...project.repoPaths],
  memoryScope: project.memoryScope,
})

const sameDraft = (one: ProjectEdit, other: ProjectEdit) =>
  one.name.trim() === other.name.trim() &&
  one.icon === other.icon &&
  one.color.toLowerCase() === other.color.toLowerCase() &&
  one.memoryScope === other.memoryScope &&
  one.repoPaths.join('\n') === other.repoPaths.join('\n')

/**
 * The Mac's Edit project on the phone (2026-10-12), opened from the thread's pill: name,
 * icon and colour, folders, memory scope and Delete, the same form saved as a whole with
 * the tick. Files has no header button on a thread any more, so it lives here, next to
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
  const { workspace, status, updateProject, deleteProject, listDirs, closeDirs } = useWorkspace()
  const [draft, setDraft] = useState(() => draftOf(project))
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
      setPicking(false)
      setBrowsing(false)
      setError(null)
    }
  }

  const live = status === 'live'
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
    updateProject(project.id, draft)
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
      subtitle={project.name}
      title="Settings"
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.group}>
          <Text style={styles.label}>Name</Text>
          <View style={styles.nameRow}>
            <Pressable
              accessibilityLabel="Icon and color"
              accessibilityRole="button"
              accessibilityState={{ expanded: picking }}
              onPress={() => setPicking(!picking)}
              style={({ pressed }) => [styles.mark, picking && styles.markOpen, pressed && styles.pressed]}
            >
              <HugeiconsIcon color={draft.color} icon={projectIcon(draft.icon)} size={22} strokeWidth={1.8} />
            </Pressable>
            <TextInput
              autoCapitalize="words"
              onChangeText={(name) => setDraft({ ...draft, name })}
              onSubmitEditing={save}
              placeholder="Client work"
              placeholderTextColor={colors.dim}
              returnKeyType="done"
              selectionColor={colors.text}
              style={styles.nameInput}
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
                {PROJECT_ICON_OPTIONS.map((option) => {
                  const chosen = option.value === draft.icon
                  return (
                    <Pressable
                      accessibilityLabel={option.label}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: chosen }}
                      key={option.value}
                      onPress={() => setDraft({ ...draft, icon: option.value })}
                      style={({ pressed }) => [styles.iconCell, chosen && styles.iconChosen, pressed && styles.pressed]}
                    >
                      <HugeiconsIcon color={chosen ? draft.color : colors.muted} icon={option.icon} size={20} strokeWidth={1.8} />
                    </Pressable>
                  )
                })}
              </View>
            </View>
          )}
        </View>

        <View style={styles.group}>
          <Text style={styles.label}>Folders</Text>
          {draft.repoPaths.map((path) => (
            <View key={path} style={styles.folder}>
              <HugeiconsIcon color={colors.dim} icon={Folder01Icon} size={16} strokeWidth={1.7} />
              <Text style={styles.path}>{path}</Text>
              <Pressable
                accessibilityLabel={`Remove ${path}`}
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => setDraft({ ...draft, repoPaths: draft.repoPaths.filter((candidate) => candidate !== path) })}
                style={({ pressed }) => [styles.removeFolder, pressed && styles.pressed]}
              >
                <HugeiconsIcon color={colors.muted} icon={Cancel01Icon} size={14} strokeWidth={1.8} />
              </Pressable>
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
            <View style={styles.folderHint}>
              <Text style={styles.hint}>
                {draft.repoPaths.length === 0
                  ? 'No folders.'
                  : full
                    ? `That is the most a project can link (${MAX_PROJECT_FOLDERS}).`
                    : 'Every folder is real, and every persona here can write to it.'}
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={full || !live}
                onPress={() => browse()}
                style={({ pressed }) => [styles.quiet, (full || !live) && styles.disabled, pressed && styles.pressed]}
              >
                <HugeiconsIcon color={colors.text} icon={Add01Icon} size={16} strokeWidth={1.8} />
                <Text style={styles.quietText}>Add a folder…</Text>
              </Pressable>
            </View>
          )}
          {onFiles === undefined ? null : (
            <Pressable
              accessibilityRole="button"
              onPress={openFiles}
              style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
            >
              <HugeiconsIcon color={colors.muted} icon={FolderOpenIcon} size={18} strokeWidth={1.7} />
              <Text style={styles.linkText}>Files</Text>
              <HugeiconsIcon color={colors.dim} icon={ArrowRight01Icon} size={17} strokeWidth={1.7} />
            </Pressable>
          )}
        </View>

        <View style={styles.group}>
          <Checkbox
            checked={draft.memoryScope === 'knowledge'}
            label="Knowledge work memory"
            onChange={(checked) => setDraft({ ...draft, memoryScope: checked ? 'knowledge' : 'project' })}
          />
          <Text style={styles.hint}>Search every memory index, not only this project’s own.</Text>
        </View>

        {error === null ? null : <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}

        <Pressable
          accessibilityRole="button"
          disabled={!live}
          onPress={askDelete}
          style={({ pressed }) => [styles.delete, !live && styles.disabled, pressed && styles.pressed]}
        >
          <HugeiconsIcon color={colors.danger} icon={Delete02Icon} size={18} strokeWidth={1.8} />
          <Text style={styles.deleteText}>Delete project thread</Text>
        </Pressable>
      </ScrollView>
    </Sheet>
  )
}

/** Walks the Mac's folders inside the sheet, the way New project does on the phone. */
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
            <Pressable
              accessibilityRole="button"
              disabled={!live}
              onPress={() => onBrowse()}
              style={({ pressed }) => [styles.quiet, styles.retry, !live && styles.disabled, pressed && styles.pressed]}
            >
              <Text style={styles.quietText}>Ask again</Text>
            </Pressable>
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
        <Pressable accessibilityRole="button" onPress={onDone} style={({ pressed }) => [styles.quiet, pressed && styles.pressed]}>
          <Text style={styles.quietText}>Cancel</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={listing === null}
          onPress={() => listing === null ? undefined : onAdd(listing.path)}
          style={({ pressed }) => [styles.use, listing === null && styles.disabled, pressed && styles.pressed]}
        >
          <Text style={styles.useText}>Add this folder</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  content: { gap: spacing.xl, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xl },
  confirm: { width: 44, height: 44 },
  confirmInner: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  group: { gap: spacing.sm },
  label: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  mark: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    ...squircle,
    backgroundColor: colors.sheetSurface,
  },
  markOpen: { backgroundColor: colors.sheetPressed },
  nameInput: {
    flex: 1,
    minHeight: 52,
    borderRadius: radius.md,
    ...squircle,
    backgroundColor: colors.sheetSurface,
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 16,
    letterSpacing: tracking.body,
    paddingHorizontal: spacing.md,
  },
  picker: { gap: spacing.md, borderRadius: radius.md, ...squircle, backgroundColor: colors.sheetSurface, padding: spacing.md },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  swatchRing: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18, borderWidth: 2, borderColor: 'transparent' },
  swatch: { width: 24, height: 24, borderRadius: 12 },
  icons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  iconCell: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, ...squircle },
  iconChosen: { backgroundColor: colors.sheetPressed },
  folder: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.md,
    ...squircle,
    backgroundColor: colors.sheetSurface,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
  },
  path: { flex: 1, color: colors.text, fontFamily: fonts.mono, fontSize: 12, lineHeight: 17, paddingVertical: spacing.sm },
  removeFolder: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  folderHint: { gap: spacing.sm },
  hint: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  quiet: {
    minHeight: 40,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radius.round,
    backgroundColor: colors.chip,
    paddingHorizontal: spacing.md,
  },
  quietText: { color: colors.text, fontFamily: fonts.sans, fontSize: 14 },
  linkRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radius.md,
    ...squircle,
    backgroundColor: colors.sheetSurface,
    paddingHorizontal: spacing.md,
  },
  linkText: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 15 },
  walk: { gap: 2, borderRadius: radius.md, ...squircle, backgroundColor: colors.sheetSurface, padding: spacing.sm },
  loading: { minHeight: 80, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  where: { color: colors.muted, fontFamily: fonts.mono, fontSize: 12, lineHeight: 17, padding: spacing.sm },
  walkRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.sm },
  walkName: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 15 },
  walkActions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm, paddingTop: spacing.sm },
  use: { minHeight: 40, justifyContent: 'center', borderRadius: radius.round, backgroundColor: colors.text, paddingHorizontal: spacing.md },
  useText: { color: colors.onPrimary, fontFamily: fonts.sans, fontSize: 14, fontWeight: '500' },
  error: { color: colors.danger, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  walkError: { padding: spacing.sm },
  retry: { alignSelf: 'center' },
  delete: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  deleteText: { color: colors.danger, fontFamily: fonts.sans, fontSize: 15 },
})
