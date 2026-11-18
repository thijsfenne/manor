import { roomAgents } from '@manor/client-runtime/mentions'
import { stageCommandContext } from '@manor/client-runtime/chat-commands'
import Add01Icon from '@hugeicons/core-free-icons/Add01Icon'
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon'
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon'
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import Folder01Icon from '@hugeicons/core-free-icons/Folder01Icon'
import FolderAddIcon from '@hugeicons/core-free-icons/FolderAddIcon'
import UnfoldMoreIcon from '@hugeicons/core-free-icons/UnfoldMoreIcon'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react-native'
import {
  NEW_SINGLE_CHAT_DEFAULT,
  SINGLE_CHAT_VOICE,
  addsAgentMention,
  isFolder,
  type AgentConfig,
  type ChatMode,
  type ChatOverride,
  type ImageAttachment,
  type SingleRuntime,
  type SkillConfig,
} from '@manor/contracts'
import type { StagedFile } from '@manor/client-runtime/attachments'
import {
  isAutoOn,
  readSingleRuntime,
  runtimeLabel,
  singleRuntimeVoice,
  withAuto,
  withOverride,
} from '@manor/client-runtime/runtime-choices'
import { projectsByRecentActivity, repoListingKey, roomOf } from '@manor/client-runtime/state'
import { router } from 'expo-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { ConnectGate } from '@/components/ConnectGate'
import { Composer } from '@/components/Composer'
import { AiBotHeadLookingIcon } from '@/components/customIcons'
import { GlassIconButton } from '@/components/GlassIconButton'
import { ProviderMark } from '@/components/ProviderMark'
import { RuntimeSheet, SingleRuntimeSheet } from '@/components/RuntimeSheet'
import { SegmentedControl } from '@/components/SegmentedControl'
import { useWorkspace } from '@/providers/WorkspaceProvider'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'
import { useHostAuto } from '@/useHostAuto'

type Stage = 'projects' | 'folders' | 'draft'

export default function NewChatScreen() {
  return (
    <ConnectGate>
      <NewChatFlow />
    </ConnectGate>
  )
}

function NewChatFlow() {
  const hostAuto = useHostAuto()
  const {
    workspace,
    status,
    createdChat,
    createdProject,
    clearCreatedChat,
    clearCreatedProject,
    closeDirs,
    createChat,
    addFolder,
    removeFolder,
    listDirs,
    listRepoFiles,
    openChat,
  } = useWorkspace()
  const [stage, setStage] = useState<Stage>('projects')
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [message, setMessage] = useState('')
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [textFiles, setTextFiles] = useState<StagedFile[]>([])
  // Single with Auto off is the default. Multiple has no pins yet, so switching to
  // it arrives with Auto on.
  const [mode, setMode] = useState<ChatMode>('single')
  /** Runtime pins for the chat about to be made; they ride along on `create_chat`. */
  const [overrides, setOverrides] = useState<Record<string, ChatOverride>>({})
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [singleRuntimeOpen, setSingleRuntimeOpen] = useState(false)
  const [manualPath, setManualPath] = useState('')
  const [pendingChatRequestId, setPendingChatRequestId] = useState<string | null>(null)
  const [pendingProjectRequestId, setPendingProjectRequestId] = useState<string | null>(null)
  const [chatError, setChatError] = useState<string | null>(null)
  const [folderError, setFolderError] = useState<string | null>(null)
  const folderNoticeAtRequest = useRef(workspace.notice)
  // The folder stage asks on its own once per opening; after a refusal the user retries.
  const foldersAsked = useRef(false)
  /** The listing path already copied into the draft fields, so a refresh never clobbers an edit. */
  const [appliedPath, setAppliedPath] = useState<string | null>(null)

  const selectedProject = useMemo(
    () => roomOf(workspace, selectedProjectId),
    [selectedProjectId, workspace.projects, workspace.home],
  )
  const pickerProjects = useMemo(
    () => projectsByRecentActivity({ projects: workspace.projects, chats: workspace.chats }),
    [workspace.projects, workspace.chats],
  )
  // "No project" is the home room, a row of its own; no project list holds it.
  const generalProject = workspace.home
  // Projects and the folders added here (2026-11-13); a removed folder is off the list.
  const namedProjects = pickerProjects.filter((project) => project.unlisted !== true)
  const listing = workspace.dirs.listing
  // The `@` menu's files, for the project this chat is about to open in. Re-listed
  // rather than cached: the listing is one `git ls-files`, and a menu offering files
  // that were renamed an hour ago is worse than the round trip.
  const repoFiles = selectedProjectId === '' ? undefined : workspace.repoFiles[repoListingKey(selectedProjectId)]
  const repoPaths = selectedProject?.repoPaths.join('\0') ?? ''
  const singleDefault = NEW_SINGLE_CHAT_DEFAULT
  /** An absent pin still reads as Auto on, so the manual default is explicit. */
  const singleOverride = overrides[SINGLE_CHAT_VOICE.id] ?? singleDefault
  const singleRuntime = readSingleRuntime(singleOverride, singleDefault)

  useEffect(() => {
    if (stage !== 'draft' || selectedProjectId === '' || status !== 'live') return
    listRepoFiles(selectedProjectId)
  }, [listRepoFiles, repoPaths, selectedProjectId, stage, status])

  useEffect(() => {
    clearCreatedChat()
    clearCreatedProject()
    closeDirs()
    return closeDirs
  }, [clearCreatedChat, clearCreatedProject, closeDirs])

  useEffect(() => {
    // A dropped connection loses the request, so the stage may ask again once it is back.
    if (status !== 'live') foldersAsked.current = false
    if (stage !== 'folders' || status !== 'live' || listing !== null || workspace.dirs.asking || foldersAsked.current) return
    foldersAsked.current = true
    folderNoticeAtRequest.current = workspace.notice
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a synchronous send failure is the request's own fallout, not a render cascade
    if (!listDirs()) setFolderError('Manor could not list the folders on your Mac.')
  }, [listDirs, listing, stage, status, workspace.dirs.asking, workspace.notice])

  useEffect(() => {
    if (
      stage !== 'folders' ||
      workspace.dirs.asking ||
      workspace.notice === null ||
      workspace.notice === folderNoticeAtRequest.current ||
      workspace.notice.requestId !== undefined
    ) return
    folderNoticeAtRequest.current = workspace.notice
    setFolderError(workspace.notice.text)
  }, [stage, workspace.dirs.asking, workspace.notice])

  // Everything below settles local state off answers the server already gave, so it
  // adjusts in render, the pattern Turn folds itself with, rather than an effect
  // pass a frame later. Only the outward moves (navigation, closing the dir
  // session, clearing the provider's created markers) stay in effects.
  if (listing !== null && listing.path !== appliedPath) {
    setAppliedPath(listing.path)
    setManualPath(listing.path)
  }

  // Both confirmations are kept as state rather than derived: a value the
  // adjustment itself nulls never reaches the commit, and only committed state
  // can feed an effect.
  // Keyed by request: adding a folder already on the list answers with the same id.
  const [confirmedProjectRequest, setConfirmedProjectRequest] = useState<string | null>(null)
  if (
    createdProject !== null &&
    pendingProjectRequestId !== null &&
    createdProject.requestId === pendingProjectRequestId &&
    confirmedProjectRequest !== pendingProjectRequestId
  ) {
    setConfirmedProjectRequest(pendingProjectRequestId)
    setPendingProjectRequestId(null)
    setSelectedProjectId(createdProject.projectId)
    setStage('draft')
  }

  const [confirmedChatId, setConfirmedChatId] = useState<string | null>(null)
  if (
    createdChat !== null &&
    pendingChatRequestId !== null &&
    createdChat.requestId === pendingChatRequestId &&
    confirmedChatId !== createdChat.chatId
  ) {
    setConfirmedChatId(createdChat.chatId)
    setPendingChatRequestId(null)
  }

  if (pendingProjectRequestId !== null && workspace.notice?.requestId === pendingProjectRequestId) {
    setPendingProjectRequestId(null)
    setFolderError(workspace.notice.text)
  }

  if (pendingChatRequestId !== null && workspace.notice?.requestId === pendingChatRequestId) {
    setPendingChatRequestId(null)
    setChatError(workspace.notice.text)
  }

  if (status !== 'live') {
    if (pendingProjectRequestId !== null) {
      setPendingProjectRequestId(null)
      setFolderError('The connection to your Mac dropped before Manor confirmed the folder.')
    }
    if (pendingChatRequestId !== null) {
      setPendingChatRequestId(null)
      setChatError('The connection to your Mac dropped before Manor confirmed the chat.')
    }
  }

  useEffect(() => {
    if (confirmedProjectRequest === null) return
    clearCreatedProject()
    closeDirs()
  }, [clearCreatedProject, closeDirs, confirmedProjectRequest])

  useEffect(() => {
    if (confirmedChatId === null) return
    clearCreatedChat()
    openChat(confirmedChatId)
    router.replace({ pathname: '/chat/[id]', params: { id: confirmedChatId } })
  }, [clearCreatedChat, confirmedChatId, openChat])

  useEffect(() => {
    if (status === 'live' || !workspace.dirs.asking) return
    closeDirs()
  }, [closeDirs, status, workspace.dirs.asking])

  const showProjects = () => {
    closeDirs()
    setFolderError(null)
    setStage('projects')
  }

  const showFolders = () => {
    setFolderError(status === 'live' ? null : 'Connect to your Mac first to choose a folder.')
    foldersAsked.current = false
    setStage('folders')
  }

  const chooseProject = (projectId: string) => {
    setSelectedProjectId(projectId)
    setChatError(null)
    setStage('draft')
  }

  const browse = (path?: string) => {
    setFolderError(null)
    folderNoticeAtRequest.current = workspace.notice
    if (!listDirs(path)) setFolderError('Manor could not list the folders on your Mac.')
  }

  const addCurrentFolder = () => {
    if (listing === null || status !== 'live') return
    const requestId = `mobile-folder-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setFolderError(null)
    if (addFolder(listing.path, requestId)) {
      setPendingProjectRequestId(requestId)
    } else {
      setFolderError('Manor could not send the request to your Mac.')
    }
  }

  const startChat = (text: string) => {
    if (selectedProjectId === '' || status !== 'live') return
    const requestId = `mobile-chat-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setChatError(null)
    const pins = withOverride(overrides, SINGLE_CHAT_VOICE.id, singleOverride)
    if (createChat({ kind: 'project', projectId: selectedProjectId, mode }, { text, images, files: textFiles }, pins, requestId)) {
      setPendingChatRequestId(requestId)
    } else {
      setChatError('Manor could not send the request to your Mac.')
    }
  }

  const chooseMode = (next: ChatMode) => {
    setMode(next)
  }

  const changeSingleRuntime = (runtime: ChatOverride) => {
    setOverrides((current) => withOverride(current, SINGLE_CHAT_VOICE.id, runtime))
  }

  // A new project chat is a Session, so it seats Session personas only.
  const sessionAgents = roomAgents(workspace.agents, { kind: 'project' })
  const autoOn = mode === 'single'
    ? isAutoOn(singleOverride, hostAuto)
    : sessionAgents.every((agent) => isAutoOn(overrides[agent.id] ?? {}, hostAuto))

  const setAuto = (checked: boolean) => {
    if (mode === 'single') {
      if (checked) setSingleRuntimeOpen(false)
      setOverrides((current) => withOverride(
        current,
        SINGLE_CHAT_VOICE.id,
        checked ? withAuto(current[SINGLE_CHAT_VOICE.id] ?? singleDefault, true) : singleDefault,
      ))
      return
    }
    setOverrides((current) => {
      let next = current
      for (const agent of sessionAgents) {
        next = withOverride(next, agent.id, withAuto(next[agent.id] ?? {}, checked))
      }
      return next
    })
  }

  const title = stage === 'projects' ? 'Choose project' : stage === 'folders' ? 'Add folder' : 'New Session'

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
      <SheetHeader
        canGoBack={stage !== 'projects'}
        onBack={showProjects}
        onClose={() => router.back()}
        onAdd={stage === 'projects' ? showFolders : undefined}
        title={title}
      />
      {stage === 'projects' ? (
        <ProjectPicker
          onAdd={showFolders}
          general={generalProject}
          onChoose={chooseProject}
          onRemove={(projectId) => {
            void removeFolder(projectId).catch((error: unknown) => {
              Alert.alert('Folder not removed', error instanceof Error ? error.message : 'Try again when Manor is back.')
            })
          }}
          projects={namedProjects}
        />
      ) : stage === 'folders' ? (
        <FolderPicker
          asking={workspace.dirs.asking && status === 'live'}
          error={folderError}
          listing={listing}
          manualPath={manualPath}
          onAdd={addCurrentFolder}
          onBrowse={browse}
          onManualPathChange={setManualPath}
          status={status}
          submitting={pendingProjectRequestId !== null}
        />
      ) : (
        <ChatDraft
          agents={sessionAgents}
          error={chatError}
          files={repoFiles}
          images={images}
          message={message}
          mode={mode}
          onAgents={() => setAgentsOpen(true)}
          onImagesChange={setImages}
          onTextFilesChange={setTextFiles}
          textFiles={textFiles}
          onMessageChange={setMessage}
          onModeChange={chooseMode}
          // Nothing to choose from yet: the row goes straight to adding a folder, as the Mac's chip does.
          onPickProject={namedProjects.length === 0 ? showFolders : showProjects}
          addFolder={namedProjects.length === 0}
          onSingleRuntime={() => setSingleRuntimeOpen(true)}
          onSubmit={startChat}
          overrides={overrides}
          project={selectedProject}
          noProject={selectedProject !== undefined && selectedProject.id === generalProject?.id}
          skills={workspace.skills}
          status={status}
          submitting={pendingChatRequestId !== null}
          singleRuntime={singleRuntime}
          autoOn={autoOn}
          onAutoChange={setAuto}
        />
      )}
      <RuntimeSheet
        agents={sessionAgents}
        disabled={status !== 'live' || pendingChatRequestId !== null}
        onChange={(agentId, override) => setOverrides((current) => withOverride(current, agentId, override))}
        onClose={() => setAgentsOpen(false)}
        open={agentsOpen}
        overrides={overrides}
      />
      <SingleRuntimeSheet
        allowAuto={false}
        disabled={status !== 'live' || pendingChatRequestId !== null}
        onChange={changeSingleRuntime}
        onClose={() => setSingleRuntimeOpen(false)}
        open={singleRuntimeOpen}
        override={singleOverride}
        fallback={singleDefault}
      />
    </SafeAreaView>
  )
}

function SheetHeader({
  title,
  canGoBack,
  onBack,
  onClose,
  onAdd,
}: {
  title: string
  canGoBack: boolean
  onBack: () => void
  onClose: () => void
  onAdd?: () => void
}) {
  return (
    <View style={styles.header}>
      <GlassIconButton
        accessibilityLabel={canGoBack ? 'Back' : 'Close'}
        icon={canGoBack ? ArrowLeft01Icon : Cancel01Icon}
        onPress={canGoBack ? onBack : onClose}
      />
      <Text numberOfLines={1} style={styles.headerTitle}>{title}</Text>
      {onAdd === undefined ? <View style={styles.headerButton} /> : (
        <GlassIconButton
          accessibilityLabel="Add folder"
          icon={Add01Icon}
          onPress={onAdd}
        />
      )}
    </View>
  )
}

function ProjectPicker({
  projects,
  general,
  onChoose,
  onAdd,
  onRemove,
}: {
  projects: ReturnType<typeof useWorkspace>['workspace']['projects']
  /** The project "No project" stands for; absent, there is no such row. */
  general: ReturnType<typeof useWorkspace>['workspace']['projects'][number] | undefined
  onChoose: (projectId: string) => void
  onAdd: () => void
  /** Takes a folder off this list; a long press asks first. A project is never offered. */
  onRemove: (projectId: string) => void
}) {
  return (
    <ScrollView
      contentContainerStyle={[styles.content, projects.length === 0 && general === undefined && styles.fill]}
      keyboardShouldPersistTaps="handled"
    >
      {projects.length === 0 && general === undefined ? (
        <View style={styles.empty}>
          <View style={styles.emptyIcon}>
            <HugeiconsIcon color={colors.muted} icon={Folder01Icon} size={24} strokeWidth={1.6} />
          </View>
          <Text style={styles.emptyTitle}>No folders yet</Text>
          <Text style={styles.emptyCopy}>Choose a folder on your Mac to work in. Manor takes you straight to your first Session.</Text>
          <Pressable
            accessibilityRole="button"
            onPress={onAdd}
            style={({ pressed }) => [styles.primaryButton, styles.emptyAction, pressed && styles.pressed]}
          >
            <HugeiconsIcon color={colors.onPrimary} icon={Add01Icon} size={18} strokeWidth={1.8} />
            <Text style={styles.primaryText}>Add folder</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <Text style={styles.intro}>Where does this conversation belong?</Text>
          {general === undefined ? null : (
            <View style={[styles.group, projects.length > 0 && styles.noProjectGroup]}>
              <Pressable
                accessibilityLabel="Start a Session without a project"
                accessibilityRole="button"
                onPress={() => onChoose(general.id)}
                style={({ pressed }) => [styles.projectRow, pressed && styles.rowPressed]}
              >
                <View style={styles.projectMark}>
                  <HugeiconsIcon color={colors.muted} icon={Folder01Icon} size={20} strokeWidth={1.7} />
                </View>
                <View style={styles.projectCopy}>
                  <Text numberOfLines={1} style={styles.projectTitle}>No project</Text>
                </View>
                <HugeiconsIcon color={colors.dim} icon={ArrowRight01Icon} size={18} strokeWidth={1.7} />
              </Pressable>
            </View>
          )}
          <View style={styles.group}>
            {projects.map((project, index) => (
              <Pressable
                accessibilityLabel={`Start a Session in ${project.name}`}
                accessibilityRole="button"
                key={project.id}
                onPress={() => onChoose(project.id)}
                {...(isFolder(project) ? {
                  accessibilityHint: 'Long press to remove this folder from the list',
                  onLongPress: () => Alert.alert(`Remove ${project.name}?`, 'It leaves this list. Its Sessions stay.', [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Remove', style: 'destructive', onPress: () => onRemove(project.id) },
                  ]),
                } : {})}
                style={({ pressed }) => [styles.projectRow, pressed && styles.rowPressed]}
              >
                <View style={styles.projectMark}>
                  <HugeiconsIcon color={project.color} icon={Folder01Icon} size={20} strokeWidth={1.7} />
                </View>
                <View style={styles.projectCopy}>
                  <Text numberOfLines={1} style={styles.projectTitle}>{project.name}</Text>
                  <Text numberOfLines={1} style={styles.projectPath}>
                    {project.repoPaths[0] ?? 'No linked folder'}
                  </Text>
                </View>
                <HugeiconsIcon color={colors.dim} icon={ArrowRight01Icon} size={18} strokeWidth={1.7} />
                {index === projects.length - 1 ? null : <View style={styles.rowLine} />}
              </Pressable>
            ))}
          </View>
          <View style={styles.group}>
            <Pressable
              accessibilityLabel="Add folder"
              accessibilityRole="button"
              onPress={onAdd}
              style={({ pressed }) => [styles.projectRow, pressed && styles.rowPressed]}
            >
              <View style={styles.projectMark}>
                <HugeiconsIcon color={colors.muted} icon={FolderAddIcon} size={20} strokeWidth={1.7} />
              </View>
              <View style={styles.projectCopy}>
                <Text numberOfLines={1} style={styles.projectTitle}>Add folder</Text>
              </View>
            </Pressable>
          </View>
        </>
      )}
    </ScrollView>
  )
}

function FolderPicker({
  listing,
  asking,
  manualPath,
  error,
  status,
  submitting,
  onManualPathChange,
  onBrowse,
  onAdd,
}: {
  listing: ReturnType<typeof useWorkspace>['workspace']['dirs']['listing']
  asking: boolean
  manualPath: string
  error: string | null
  status: 'connecting' | 'live' | 'offline'
  submitting: boolean
  onManualPathChange: (path: string) => void
  onBrowse: (path?: string) => void
  onAdd: () => void
}) {
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.fill}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>Folder on your Mac</Text>
          <View style={styles.pathField}>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={onManualPathChange}
              onSubmitEditing={() => onBrowse(manualPath.trim())}
              placeholder="/Users/name/Project"
              placeholderTextColor={colors.dim}
              returnKeyType="go"
              selectionColor={colors.text}
              style={styles.pathInput}
              value={manualPath}
            />
            <Pressable
              accessibilityLabel="Open this path"
              accessibilityRole="button"
              disabled={manualPath.trim() === '' || asking}
              onPress={() => onBrowse(manualPath.trim())}
              style={({ pressed }) => [styles.goButton, (manualPath.trim() === '' || asking) && styles.disabled, pressed && styles.pressed]}
            >
              {asking ? <ActivityIndicator color={colors.text} size="small" /> : (
                <HugeiconsIcon color={colors.text} icon={ArrowRight01Icon} size={18} strokeWidth={1.8} />
              )}
            </Pressable>
          </View>
        </View>

        {listing === null && asking ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.muted} />
            <Text style={styles.loadingText}>Loading folders on your Mac…</Text>
          </View>
        ) : listing === null ? null : (
          <>
            <View style={styles.location}>
              <HugeiconsIcon color={colors.muted} icon={Folder01Icon} size={16} strokeWidth={1.7} />
              <Text numberOfLines={2} style={styles.locationText}>{listing.path}</Text>
            </View>
            <View style={styles.group}>
              {listing.parent === null ? null : (
                <Pressable
                  accessibilityLabel="Go to parent folder"
                  accessibilityRole="button"
                  onPress={() => onBrowse(listing.parent ?? undefined)}
                  style={({ pressed }) => [styles.folderRow, pressed && styles.rowPressed]}
                >
                  <View style={styles.folderMark}>
                    <HugeiconsIcon color={colors.muted} icon={ArrowLeft01Icon} size={18} strokeWidth={1.7} />
                  </View>
                  <Text style={styles.folderTitle}>Parent folder</Text>
                  <View style={styles.rowLine} />
                </Pressable>
              )}
              {listing.entries.map((entry, index) => (
                <Pressable
                  accessibilityLabel={`Open folder ${entry.name}`}
                  accessibilityRole="button"
                  key={entry.path}
                  onPress={() => onBrowse(entry.path)}
                  style={({ pressed }) => [styles.folderRow, pressed && styles.rowPressed]}
                >
                  <View style={styles.folderMark}>
                    <HugeiconsIcon color={colors.muted} icon={Folder01Icon} size={18} strokeWidth={1.7} />
                  </View>
                  <Text numberOfLines={1} style={styles.folderTitle}>{entry.name}</Text>
                  <HugeiconsIcon color={colors.dim} icon={ArrowRight01Icon} size={17} strokeWidth={1.7} />
                  {index === listing.entries.length - 1 ? null : <View style={styles.rowLine} />}
                </Pressable>
              ))}
              {listing.entries.length === 0 ? (
                <Text style={styles.noFolders}>No subfolders. You can still use this folder.</Text>
              ) : null}
            </View>
          </>
        )}

        <Pressable
          accessibilityRole="button"
          disabled={listing === null || status !== 'live' || submitting}
          onPress={onAdd}
          style={({ pressed }) => [
            styles.primaryButton,
            (listing === null || status !== 'live' || submitting) && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          {submitting ? <ActivityIndicator color={colors.onPrimary} size="small" /> : (
            <HugeiconsIcon color={colors.onPrimary} icon={Add01Icon} size={18} strokeWidth={1.8} />
          )}
          <Text style={styles.primaryText}>{submitting ? 'Adding folder…' : 'Use this folder'}</Text>
        </Pressable>
        <Text style={styles.hostHint}>This folder stays on your Mac. The app only uses Manor as a remote control.</Text>
        {error === null ? null : <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

function ChatDraft({
  project,
  noProject,
  addFolder,
  agents,
  overrides,
  message,
  mode,
  images,
  textFiles,
  error,
  files,
  skills,
  status,
  submitting,
  onMessageChange,
  onModeChange,
  onImagesChange,
  onTextFilesChange,
  onPickProject,
  onAgents,
  onSingleRuntime,
  onSubmit,
  singleRuntime,
  autoOn,
  onAutoChange,
}: {
  project: ReturnType<typeof useWorkspace>['workspace']['projects'][number] | undefined
  /** The chat is in the home room, shown as "No project". */
  noProject: boolean
  /** Nothing to choose from yet: the project row reads Add folder (2026-11-13). */
  addFolder: boolean
  agents: AgentConfig[]
  overrides: Record<string, ChatOverride>
  message: string
  mode: ChatMode
  images: ImageAttachment[]
  textFiles: StagedFile[]
  error: string | null
  files: { files: string[]; truncated: boolean } | undefined
  skills: SkillConfig[]
  status: 'connecting' | 'live' | 'offline'
  submitting: boolean
  singleRuntime: SingleRuntime
  autoOn: boolean
  onAutoChange: (checked: boolean) => void
  onMessageChange: (message: string) => void
  onModeChange: (mode: ChatMode) => void
  onImagesChange: (images: ImageAttachment[]) => void
  onTextFilesChange: (files: StagedFile[]) => void
  onPickProject: () => void
  onAgents: () => void
  onSingleRuntime: () => void
  onSubmit: (text: string) => void
}) {
  const hostAuto = useHostAuto()
  const pinned = agents.filter((agent) => overrides[agent.id] !== undefined).length
  const agentsLabel = pinned === 0 ? 'Default' : `${pinned} customized`
  // Tagging a persona is asking for the house, so a fresh Single session follows
  // the tag into Multiple. The web stage does the same.
  const changeMessage = (next: string) => {
    if (mode === 'single' && !submitting && addsAgentMention(message, next, agents)) {
      onModeChange('house')
    }
    onMessageChange(next)
  }
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.fill}>
      <View style={styles.draft}>
        {/* Where the chat will run, as rows above the composer: the
            project and the personas' runtime for this chat alone. */}
        <View style={styles.scope}>
          <ScopeRow
            icon={noProject && addFolder ? FolderAddIcon : Folder01Icon}
            label={noProject ? (addFolder ? 'Add folder' : 'No project') : (project?.name ?? 'Preparing project…')}
            onPress={onPickProject}
            tint={noProject ? undefined : project?.color}
          />
          <View style={styles.modeRow}>
            <SegmentedControl disabled={submitting} fill label="Chat mode" onChange={onModeChange} options={MODES} value={mode} />
            {/* What the session runs on, with Auto at the far right of the same row:
                the Mac puts Auto beside the picker it collapses. */}
            <View style={styles.runtimeRow}>
              <View style={styles.runtimePick}>
                {mode === 'house' ? (
                  <ScopeRow icon={AiBotHeadLookingIcon} label="Agents" onPress={onAgents} value={agentsLabel} />
                ) : autoOn ? (
                  <ScopeRow label="Model" mark={singleRuntime.driver} value="Auto picks" />
                ) : (
                  <ScopeRow
                    label={runtimeLabel(singleRuntimeVoice(singleRuntime), overrides[SINGLE_CHAT_VOICE.id] ?? singleRuntime, hostAuto)}
                    mark={singleRuntime.driver}
                    onPress={onSingleRuntime}
                  />
                )}
              </View>
              {!hostAuto ? null : (
                <View style={styles.autoRow}>
                  <Text style={styles.autoLabel}>Auto</Text>
                  <Switch
                    accessibilityLabel="Auto mode"
                    disabled={submitting}
                    onValueChange={onAutoChange}
                    value={autoOn}
                  />
                </View>
              )}
            </View>
          </View>
        </View>
        <Composer
          commandContext={() => stageCommandContext(true)}
          allSkillsAvailable={mode === 'single'}
          allowEmpty
          allowWorkDestination={false}
          autoFocus
          disabled={status !== 'live' || project === undefined}
          draft={message}
          files={files?.files ?? []}
          filesTruncated={files?.truncated ?? false}
          images={images}
          mentionable={agents}
          onChangeDraft={changeMessage}
          onChangeImages={onImagesChange}
          onChangeTextFiles={onTextFilesChange}
          textFiles={textFiles}
          onSend={onSubmit}
          skills={skills}
          placeholder={project === undefined ? 'Preparing project…' : 'Ask anything…'}
          submitting={submitting}
        />
        {error === null ? null : <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        {status === 'live' ? null : <Text style={styles.offline}>You can start once your Mac is connected again.</Text>}
      </View>
    </KeyboardAvoidingView>
  )
}

const MODES = [
  { value: 'single', label: 'Single' },
  { value: 'house', label: 'Multiple' },
] as const satisfies readonly { value: ChatMode; label: string }[]

/** One line of the chat's scope. With `onPress` it opens its picker; without, it states a fact. */
function ScopeRow({
  icon,
  mark,
  label,
  value,
  tint,
  onPress,
}: {
  icon?: IconSvgElement
  /** A provider's own mark in place of the glyph, as the Mac's model picker shows it. */
  mark?: SingleRuntime['driver']
  label: string
  value?: string
  tint?: string
  onPress?: () => void
}) {
  return (
    <Pressable
      accessibilityLabel={value === undefined ? label : `${label}, ${value}`}
      accessibilityRole={onPress === undefined ? 'text' : 'button'}
      disabled={onPress === undefined}
      onPress={onPress}
      style={({ pressed }) => [styles.scopeRow, pressed && styles.pressed]}
    >
      {mark !== undefined ? (
        <View style={styles.scopeMark}><ProviderMark driver={mark} size={16} /></View>
      ) : icon === undefined ? null : (
        <HugeiconsIcon color={tint ?? colors.muted} icon={icon} size={20} strokeWidth={1.7} />
      )}
      <Text numberOfLines={1} style={styles.scopeLabel}>{label}</Text>
      {value === undefined ? null : <Text numberOfLines={1} style={styles.scopeValue}>{value}</Text>}
      {onPress === undefined ? null : <HugeiconsIcon color={colors.dim} icon={UnfoldMoreIcon} size={16} strokeWidth={1.8} />}
    </Pressable>
  )
}


const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  fill: { flex: 1 },
  header: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  headerButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.round,
  },
  headerTitle: {
    flex: 1,
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 20,
    fontWeight: '500',
    letterSpacing: -0.2,
    textAlign: 'center',
  },
  content: { gap: spacing.xl, paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: 48 },
  intro: { color: colors.muted, fontFamily: fonts.sans, fontSize: 15, lineHeight: 21 },
  group: { overflow: 'hidden', borderRadius: radius.panel, ...squircle, backgroundColor: colors.surface },
  noProjectGroup: { marginBottom: spacing.md },
  projectRow: {
    minHeight: 74,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  projectMark: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  projectCopy: { flex: 1, gap: 3 },
  projectTitle: { color: colors.text, fontFamily: fonts.sans, fontSize: 16, fontWeight: '500' },
  projectPath: { color: colors.muted, fontFamily: fonts.mono, fontSize: 12, lineHeight: 16 },
  rowLine: {
    position: 'absolute',
    right: spacing.lg,
    bottom: 0,
    left: 56,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.line,
  },
  rowPressed: { backgroundColor: colors.surface2 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingBottom: 72 },
  emptyIcon: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    ...squircle,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
  },
  emptyTitle: { color: colors.text, fontFamily: fonts.sans, fontSize: 20, fontWeight: '500' },
  emptyCopy: { maxWidth: 310, color: colors.muted, fontFamily: fonts.sans, fontSize: 15, lineHeight: 22, textAlign: 'center' },
  emptyAction: { marginTop: spacing.lg, paddingHorizontal: spacing.xl },
  fieldGroup: { gap: spacing.sm },
  fieldLabel: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  pathField: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    ...squircle,
    backgroundColor: colors.surface2,
    paddingLeft: spacing.md,
  },
  pathInput: {
    flex: 1,
    minHeight: 52,
    color: colors.text,
    fontFamily: fonts.mono,
    fontSize: 13,
    paddingVertical: 0,
  },
  goButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  location: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingHorizontal: spacing.xs },
  locationText: { flex: 1, color: colors.muted, fontFamily: fonts.mono, fontSize: 12, lineHeight: 17 },
  folderRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  folderMark: { width: 24, alignItems: 'center' },
  folderTitle: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 15 },
  noFolders: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, padding: spacing.lg },
  loading: { minHeight: 120, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  loadingText: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14 },
  primaryButton: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radius.md,
    ...squircle,
    backgroundColor: colors.text,
    paddingHorizontal: spacing.lg,
  },
  primaryText: { color: colors.onPrimary, fontFamily: fonts.sans, fontSize: 14, fontWeight: '500' },
  hostHint: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17, textAlign: 'center' },
  draft: { flex: 1, justifyContent: 'flex-end', gap: spacing.lg, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  scope: { gap: 2, paddingHorizontal: spacing.xs },
  modeRow: { gap: spacing.sm, paddingTop: spacing.sm },
  runtimeRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  runtimePick: { flex: 1, minWidth: 0 },
  autoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingRight: spacing.xs },
  autoLabel: { color: colors.muted, fontFamily: fonts.sans, fontSize: 15 },
  scopeMark: { width: 20, alignItems: 'center' },
  scopeRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.sm },
  scopeLabel: { flexShrink: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 17 },
  scopeValue: { flexShrink: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 15 },
  error: { color: colors.danger, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  offline: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  disabled: { opacity: 0.38 },
  pressed: { opacity: 0.64 },
})
