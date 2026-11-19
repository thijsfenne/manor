import { stageCommandContext } from '@manor/client-runtime/chat-commands'
import { useEffect, useMemo, type ComponentProps } from 'react'
import { NEW_SINGLE_CHAT_DEFAULT, SINGLE_CHAT_VOICE, runtimeOn, type AgentConfig } from '@manor/contracts'
import { useOffModels } from '../../useOffModels'
import { Avatar } from '../Avatar'
import { CheckoutRow, type CheckoutStatus } from '../CheckoutRow'
import { Composer } from '../Composer'
import { AddAgentIcon } from '../customIcons'
import { Icon } from '../Icon'
import { ComposerAutoRow } from '../NewChatModeControl'
import { RuntimeControls } from '../RuntimeControls'
import { SingleRuntimeControl } from '../SingleRuntimeControl'
import { StageBackdrop } from '../StageBackdrop'
import { Transcript } from '../Transcript'
import { AddFolderDialog } from '../projects/AddFolderDialog'
import { ProjectPicker } from '../projects/ProjectPicker'
import { useAddFolder } from '../../useAddFolder'
import { chatRoster } from '../../chatRoster'
import { insertIntoDraft } from '../../composerDrafts'
import { roomAgents } from '../../mentions'
import { effectiveDriver, isAutoOn, withAuto } from '../../runtimeChoices'
import { emptyThread, isHomeRoom, projectsByRecentActivity, repoListingKey, roomOf, rowsOf } from '../../state'
import { draftBlockedNote, stageDraftKey, type NewChatDraft, type useChatDialogs } from '../../useChatDialogs'
import type { usePageContexts } from '../../useChatSide'
import type { Theme } from '../../useTheme'
import type { Manor } from '../../useWorkspace'
import { useHostAuto } from '../../useHostAuto'

/**
 * A bare session has no mentionable personas. Stable by design: a fresh empty array
 * on every streamed delta makes every finished Markdown bubble render again.
 */
const NO_AGENTS: AgentConfig[] = []

/** The two first moves a chief of staff's empty DM offers. A chip fills the composer and never sends. */
const STARTERS = ['Plan my week', 'Turn a client request into a brief']

/** "Sage", "Sage and Smith", "Sage, Smith and Argus". */
const nameList = (names: readonly string[]): string =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

/**
 * The new-chat stage under its header: who or what the chat is about, the composer,
 * and from the send onwards the one message it was started with. On the whole stage,
 * or in a pane of a split (`inPane`), which only changes the padding.
 */
export function DraftStage({
  draft,
  inPane,
  phone,
  theme,
  manor,
  dialogs,
  pageContexts,
  onNewSessionAgent,
}: {
  draft: NewChatDraft
  inPane: boolean
  phone: boolean
  theme: Theme
  manor: Manor
  dialogs: ReturnType<typeof useChatDialogs>
  pageContexts: ReturnType<typeof usePageContexts>
  /** Opens the form for a first Session agent, offered when Multiple has nobody to seat. */
  onNewSessionAgent: () => void
}) {
  const hostAuto = useHostAuto()
  // A new chat never opens on a model turned off in Settings.
  const singleDefault = runtimeOn(NEW_SINGLE_CHAT_DEFAULT, useOffModels())
  const { workspace, status } = manor
  const { draftBoxRef, creating, draftProjectId, draftAgentId, submitDraft, draftOverride, setDraftMode,
    setDraftSingleRuntime, setDraftProject, setDraftCheckout } = dialogs
  const pickerProjects = useMemo(
    () => projectsByRecentActivity({ projects: workspace.projects, chats: workspace.chats }),
    [workspace.projects, workspace.chats],
  )
  // A folder added from the chip is where the draft goes next.
  const folders = useAddFolder(manor, setDraftProject)
  // The draft leaves the folder as the press lands, so a late answer cannot undo a newer pick.
  const removeFolder = (projectId: string) => {
    if (draftProjectId === projectId && workspace.home !== undefined) setDraftProject(workspace.home.id)
    void manor.removeFolder(projectId).catch(() => undefined)
  }
  const draftProject = roomOf(workspace, draftProjectId)
  // "No project" is the home room, so a draft sitting there reads as having none.
  const generalProject = workspace.home
  const draftNamedProject = draftProject !== undefined && !isHomeRoom(draftProject.id) ? draftProject : undefined
  const draftAgent = workspace.agents.find((agent) => agent.id === draftAgentId)
  const draftMode = draft.target.kind === 'project' ? draft.target.mode ?? 'house' : undefined
  // The room the draft will become, for placement: a project seats Session personas.
  const draftRoom = draft.target.kind === 'dm' ? null : { kind: draft.target.kind, memberIds: [] }
  const draftRuntimeAgents = draftAgent === undefined
    ? chatRoster(workspace.agents, draftRoom, [])
    : [draftAgent]
  const draftComposerAutoOn = draftMode === 'single'
    ? isAutoOn(draft.overrides[SINGLE_CHAT_VOICE.id] ?? {}, hostAuto)
    : draftRuntimeAgents
        .filter((agent) => effectiveDriver(agent, draft.overrides[agent.id] ?? {}) !== 'mock')
        .every((agent) => isAutoOn(draft.overrides[agent.id] ?? {}, hostAuto))
  const blockedNote = draftBlockedNote({
    live: status === 'live',
    starting: draft.submitting || creating,
    mode: draftMode,
    seatedAgents: draftRuntimeAgents.length,
  })
  const draftPickerCollapsible = draftMode === 'single'
  // The project whose files the composer's `@` menu may offer.
  const composerFiles = draftProject === undefined ? undefined : workspace.repoFiles[repoListingKey(draftProject.id, undefined)]

  const draftCheckoutProjectId =
    draft.target.kind === 'project' && (draftNamedProject?.repoPaths.length ?? 0) > 0
      ? draftNamedProject?.id
      : undefined
  const draftRepoKey = draftNamedProject?.repoPaths.join('\0') ?? ''
  useEffect(() => {
    if (draftCheckoutProjectId === undefined || status !== 'live') return
    manor.askProjectCheckout(draftCheckoutProjectId)
  }, [draftCheckoutProjectId, draftRepoKey, status, manor.askProjectCheckout])
  const draftCheckout =
    draftCheckoutProjectId === undefined ? undefined : workspace.checkoutStatus[draftCheckoutProjectId]
  /**
   * The row is for a chat that can actually be isolated: a project chat in a project
   * with a git-linked folder. A notes-only folder must not offer a worktree that the
   * server will refuse on send, so `gitRoots` stays the authoritative answer; before
   * the status lands, the project's remembered answer stands in, which is what keeps a
   * new chat from growing a tray a round trip after it opened. Linked folders are read
   * off the project directory, so unlinking the last one takes the row away in the same
   * frame as the sidebar rather than leaving a remembered `true` behind.
   */
  const showsGitRow = (project: { id: string; repoPaths: string[] } | undefined, checkout: CheckoutStatus | undefined) =>
    project !== undefined &&
    project.repoPaths.length > 0 &&
    (checkout === undefined ? workspace.projectHasGit[project.id] === true : checkout.gitRoots.length > 0)
  // No project means no checkout to choose: the tray keeps only the chip, even though the memory folder may be a repo.
  const draftShowsCheckout = draft.target.kind === 'project' && showsGitRow(draftNamedProject, draftCheckout)

  /**
   * The message a chat was started with, from the send until the server answers with
   * the chat itself. Its presence is what puts the thread on screen early: the stage
   * is done the moment Enter is pressed, and waiting out the round trip on a frozen
   * stage is the one thing that made creating a chat feel slow.
   */
  const birthing = draft.submitting ? draft.sent : null
  const birthRows = useMemo(
    () =>
      birthing === null
        ? []
        : rowsOf({
            ...emptyThread,
            hasSnapshot: true,
            pending: [{ key: 'pending:new-chat', ...birthing }],
          }),
    [birthing],
  )

  const draftKey = stageDraftKey(draft.target)
  // The default agent, the one that receives messages with no mention, passes work only to
  // who its own allowlist names, so that is who the line promises.
  const passesTo = draftAgent?.isCos === true
    ? workspace.agents.filter((agent) => draftAgent.mentionAllowlist?.includes(agent.id) === true).map((agent) => agent.name)
    : []
  const draftRole = draftAgent === undefined
    ? ''
    : passesTo.length > 0
      ? `Passes work to ${nameList(passesTo)}.`
      : draftAgent.isCos && draftAgent.role === '' ? 'Chief of staff' : draftAgent.role
  // The stage's sources travel with the create, so the slot they were staged in is
  // spent. Left standing they would ride along into the next new chat as well. A create
  // the server then refuses puts them back, the same way the text goes back in the box.
  const send: ComponentProps<typeof Composer>['onSend'] = (text, attachments, sources, _replyTo, quotes) => {
    const created = submitDraft(text, attachments, sources ?? [], quotes)
    if (created) pageContexts.consumePageContexts(draftKey)
    return created
  }

  // The heading's project name and the chip under the composer are two controls on one
  // state: choosing or clearing in either moves both.
  const draftHeading = (
    <h1 className="mb-6 text-center font-display text-[24px] font-semibold tracking-[-0.02em] text-text">
      {draftNamedProject === undefined ? (
        'What are we working on?'
      ) : (
        <>
          What are we working on in{' '}
          <ProjectPicker
            projects={pickerProjects}
            value={draftProjectId ?? ''}
            general={generalProject}
            disabled={draft.submitting}
            variant="inline"
            onChange={setDraftProject}
            onAddFolder={() => void folders.start()}
            onRemoveFolder={removeFolder}
          />
          ?
        </>
      )}
    </h1>
  )
  // Leads the tray under the composer, ahead of the checkout.
  const draftProjectChip = (
    <ProjectPicker
      projects={pickerProjects}
      value={draftProjectId ?? ''}
      general={generalProject}
      disabled={draft.submitting}
      onChange={setDraftProject}
      onAddFolder={() => void folders.start()}
      onRemoveFolder={removeFolder}
    />
  )
  const addFolderDialog = folders.browsing ? (
    <AddFolderDialog
      dirs={workspace.dirs}
      error={folders.error}
      busy={folders.busy}
      onWalk={folders.listDirs}
      onPick={(path) => void folders.add(path)}
      onClose={folders.cancel}
    />
  ) : null

  /**
   * The one composer the new-chat stage has, and the very same element that ends up
   * at the foot of the chat it creates. Written once and placed twice: on the stage
   * while the chat is being composed, at the foot from the send onwards, where it
   * travels down to the place it will keep. Two composers with one job drift apart,
   * and a second element would have nothing to travel from.
   */
  const stageComposer = (
    <Composer
      commandContext={() => stageCommandContext(draft.target.kind === 'project')}
      boxRef={draftBoxRef}
      travelFrom={draft.travelFrom}
      // The stage's range while the chat is composed, the foot's own from the send, as it
      // travels to the foot where the chat's composer takes over.
      {...(phone ? {} : { heights: birthing === null ? 'stage' as const : 'session' as const })}
      agents={draftAgent === undefined ? roomAgents(workspace.agents, draftRoom) : workspace.agents}
      household={workspace.agents}
      overrides={draft.overrides}
      files={composerFiles?.files}
      filesTruncated={composerFiles?.truncated}
      skills={workspace.skills}
      {...(draftAgent !== undefined ? { fallbackTargets: [draftAgent] } : {})}
      draftKey={draftKey}
      onSend={send}
      // Sources may be picked before the chat that will carry them exists, so the
      // stage stages them under its own key and the create takes them along.
      pageContexts={pageContexts.pageContextsByChat[draftKey] ?? []}
      onRemovePageContext={(contextId: string) => pageContexts.removePageContext(draftKey, contextId)}
      canSend={blockedNote === ''}
      blockedNote={blockedNote}
      autoFocus
      // Escape with nothing open is "No project", the same as the chip's clear control.
      {...(draftNamedProject !== undefined && generalProject !== undefined && !draft.submitting
        ? { onEscapeIdle: () => setDraftProject(generalProject.id) }
        : {})}
      allowAgentMentions={draftAgent === undefined}
      // Tagging a persona is asking for the house, so a fresh session follows the tag
      // into Multiple. Only here: an open chat's mode is fixed once it exists.
      {...(draftMode === 'single' && !draft.submitting && !creating
        ? { onAgentMention: () => setDraftMode('house') }
        : {})}
      allowWorkDestination={draft.target.kind === 'dm'}
      allSkillsAvailable={draftMode === 'single'}
      placeholder={draftAgent === undefined ? 'Ask anything…' : `Message ${draftAgent.name}`}
      oneRow={draftAgent !== undefined}
      // A DM takes its model from its agent's settings, so its draft has no runtime row.
      {...(draftAgent !== undefined ? {} : { controls: (
        <ComposerAutoRow
          {...(draftMode === undefined ? {} : { mode: draftMode, onModeChange: setDraftMode })}
          {...(draftMode === undefined || !hostAuto
            ? {}
            : {
                auto: {
                  checked: draftComposerAutoOn,
                  disabled: status !== 'live' || draft.submitting,
                  onChange: (checked: boolean) => {
                    if (draftMode === 'single') {
                      setDraftSingleRuntime(
                        checked
                          ? withAuto(draft.overrides[SINGLE_CHAT_VOICE.id] ?? {}, true)
                          : singleDefault,
                      )
                      return
                    }
                    for (const agent of draftRuntimeAgents) {
                      if (effectiveDriver(agent, draft.overrides[agent.id] ?? {}) === 'mock') continue
                      draftOverride(agent.id, withAuto(draft.overrides[agent.id] ?? {}, checked))
                    }
                  },
                },
              })}
          pickerOpen={!draftPickerCollapsible || !draftComposerAutoOn}
          pickerCollapsible={draftPickerCollapsible}
          picker={
            draftMode === 'single' ? (
              <SingleRuntimeControl
                override={draft.overrides[SINGLE_CHAT_VOICE.id] ?? {}}
                fallback={singleDefault}
                allowAuto={false}
                disabled={status !== 'live' || draft.submitting}
                onChange={setDraftSingleRuntime}
              />
            ) : draftRuntimeAgents.length === 0 ? (
              // Multiple seats Session agents, and there are none: say so, with the way to make one.
              <button
                type="button"
                className="flex h-7 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent px-3 text-label font-medium text-muted hover:bg-user-bg hover:text-text [font-family:inherit]"
                onClick={onNewSessionAgent}
              >
                <Icon icon={AddAgentIcon} size={14} />
                Add a session agent
              </button>
            ) : (
              <RuntimeControls
                agents={draftRuntimeAgents}
                overrides={draft.overrides}
                disabled={status !== 'live' || draft.submitting}
                directLayout="split"
                onChange={draftOverride}
              />
            )
          }
        />
      ) })}
      {...(draftAgent !== undefined
        ? {}
        : {
            checkout: (
              <CheckoutRow
                lead={draftProjectChip}
                leadOnly={!draftShowsCheckout}
                base={{
                  mode: draft.checkout.mode,
                  branch:
                    draft.checkout.mode === 'worktree'
                      ? (draft.checkout.branch ?? null)
                      : (draftCheckout?.branch ?? null),
                }}
                status={draftCheckout ?? null}
                planned
                disabled={status !== 'live' || draft.submitting}
                onAsk={
                  draftCheckoutProjectId === undefined
                    ? undefined
                    : () => manor.askProjectCheckout(draftCheckoutProjectId)
                }
                onChoose={setDraftCheckout}
              />
            ),
          })}
    />
  )

  // A DM's composer stands where it will stand once the chat has messages, so the
  // first send moves nothing.
  const docked = draftAgent !== undefined
  return (
    <>
      {/* `min-w-0` is load-bearing beside a wide panel: without it this grid
          item will not shrink below the transcript's 780px column, and that
          column paints under the browser. */}
      <main className={birthing === null ? `relative flex ${docked ? '' : 'h-full '}min-h-0 min-w-0 flex-col items-center justify-center bg-bg` : 'flex min-h-0 min-w-0 justify-center bg-bg'}>
        {birthing === null ? (
          <>
          <StageBackdrop theme={theme} />
          <div className={`relative flex w-full max-w-[900px] flex-col items-center ${inPane ? 'px-3' : 'px-5'} pt-14 pb-10`}>
            {/* A DM has no room to pick, so the question is simply who is being
                written to: the picker would be a control with one dead option. */}
            {draftAgent !== undefined ? (
              <div className="mb-6 flex flex-col items-center gap-2.5">
                <Avatar name={draftAgent.name} color={draftAgent.color} src={draftAgent.avatar} shape={draftAgent.avatarShape} tone={draftAgent.avatarTone} size={56} />
                <h1 className="m-0 text-center font-display text-[24px] font-semibold tracking-[-0.02em] text-text">
                  {draftAgent.name}
                </h1>
                {draftRole === '' ? null : <p className="m-0 text-center text-meta text-dim">{draftRole}</p>}
                {draftAgent.isCos ? (
                  <div className="flex flex-wrap justify-center gap-2">
                    {STARTERS.map((starter) => (
                      <button
                        key={starter}
                        type="button"
                        className="h-7 cursor-pointer rounded-full border border-line bg-transparent px-3 text-label text-muted [font-family:inherit] hover:bg-user-bg hover:text-text"
                        onClick={() => insertIntoDraft(draftKey, starter)}
                      >
                        {starter}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              draftHeading
            )}
            {docked ? null : stageComposer}
          </div>
          </>
        ) : (
          // The chat before the server has said it exists: one message, nothing
          // running, nothing to answer. What lands replaces it with the same
          // message written down, which is why there is nothing to see in the swap.
          <Transcript
            rows={birthRows}
            agents={draftMode === 'single' ? NO_AGENTS : workspace.agents}
            skills={workspace.skills}
            hasSnapshot
            showSpeakers={draftMode !== 'single'}
          />
        )}
      </main>

      {birthing !== null || docked ? (
        <footer className={`pointer-events-none relative z-[4] -mt-[var(--radius-composer)] flex min-w-0 flex-col items-center bg-transparent ${inPane ? 'px-3 pb-3' : phone ? 'px-3 pb-[max(12px,env(safe-area-inset-bottom))]' : 'px-5 pb-3'}`}>
          <div className="pointer-events-auto flex min-w-0 w-full flex-col items-center" {...(birthing === null ? {} : BIRTHING_BOX)}>
            {stageComposer}
          </div>
        </footer>
      ) : null}
      {addFolderDialog}
    </>
  )
}

/**
 * The stage box under a chat still being made is shown, not used. Anything typed,
 * pasted or dropped there would belong to neither the refused draft nor the new chat.
 * Spread because React 18's types do not know `inert`.
 */
const BIRTHING_BOX = { inert: '' }
