import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CURRENT_CHECKOUT, HOME_PROJECT_ID, MAX_SESSION_DIFF_FILES, type Chat, type Project, type WorkHandoff } from '@manor/contracts'
import { setWorkChangesOpen } from '@manor/client-runtime/work-proposals'
import { chatRailItems } from '../src/components/RightRail'
import { DiffPanel } from '../src/components/session/DiffPanel'
import { WorkChangesField } from '../src/components/WorkChangesField'
import { SESSION_CONNECTION_LOST, SessionSections, type SessionGitResult } from '../src/components/session/SessionSections'
import { useSessionGitToast, type SessionCommits } from '../src/components/session/SessionGitToast'
import { CommitDialog } from '../src/components/session/CommitDialog'
import { TOAST_VISIBLE_MS } from '../src/motion'
import { Button } from '../src/components/ui/Button'
import { chatHasRepo, waitingGoal } from '../src/sessionRepo'
import { emptyWorkspace, homeRoom } from '../src/state'

// The field's editor needs a DOM; this suite only asks whether the field is there.
vi.mock('../src/components/ComposerEditor', () => ({ ComposerEditor: () => null }))
// The Commit dialog portals into a document this renderer does not have.
vi.mock('../src/components/Modal', () => ({ Modal: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

const chat = (patch: Partial<Chat>): Chat => ({
  id: 'chat', projectId: 'project', title: 'Session', kind: 'project', routineId: null, parentChatId: null,
  sideModel: null, sideEffort: null, memberIds: [], agentIds: [], createdAt: 1, lastMessageAt: 1,
  lastMessagePreview: null, settledAt: null, archivedAt: null, checkout: CURRENT_CHECKOUT, ...patch,
})
const rail = (room: Chat, options: { singleChat: boolean; hasRepo: boolean; hasRoster: boolean }) => chatRailItems(room, {
  phone: false, hasProject: room.projectId !== null, canBrowseFiles: options.hasRepo, hasVault: false, hasBrowser: false,
  ...options,
}).find((item) => item.id === 'agents')?.label

describe('the Session panel door', () => {
  it('is named Session where the room has a git folder, Agents elsewhere, and absent in a DM', () => {
    expect(rail(chat({}), { singleChat: false, hasRepo: true, hasRoster: true })).toBe('Session')
    // A Single Session has no roster, and gets the door only for its Changes and Branch.
    expect(rail(chat({ mode: 'single' }), { singleChat: true, hasRepo: true, hasRoster: false })).toBe('Session')
    expect(rail(chat({ mode: 'single' }), { singleChat: true, hasRepo: false, hasRoster: false })).toBeUndefined()
    expect(rail(chat({ kind: 'group', projectId: null }), { singleChat: false, hasRepo: false, hasRoster: true })).toBe('Agents')
    expect(rail(chat({ kind: 'dm', projectId: null }), { singleChat: false, hasRepo: false, hasRoster: true })).toBeUndefined()
  })

  it('knows the room has git before the Session is read, and believes the Session once it is', () => {
    const project = { id: 'project', repoPaths: ['/repo'] } as Project
    const workspace = { ...emptyWorkspace, projects: [project], projectHasGit: { project: true } }
    expect(chatHasRepo(workspace, chat({}))).toBe(true)
    const read = { type: 'session_repo' as const, chatId: 'chat', waiting: false, changes: { files: 0, added: 0, removed: 0 }, repos: [] }
    expect(chatHasRepo({ ...workspace, sessionRepos: { chat: read } }, chat({}))).toBe(false)
    expect(chatHasRepo({ ...workspace, projects: [{ ...project, repoPaths: [] }] }, chat({}))).toBe(false)
    // A failed read keeps the door, so its error and Retry stay on screen.
    expect(chatHasRepo({ ...workspace, sessionRepos: { chat: { ...read, error: 'Manor could not read this checkout.' } } }, chat({}))).toBe(true)
  })

  it('gives a Session without a project no door, whatever its room reports', () => {
    const workspace = { ...emptyWorkspace, home: homeRoom(['/notes']), projectHasGit: { [HOME_PROJECT_ID]: true } }
    const session = chat({ projectId: HOME_PROJECT_ID })
    expect(chatHasRepo(workspace, session)).toBe(false)
    // Not even a read that found a repository opens it: the memory folder is no project's checkout.
    const repo = { root: '/notes', branch: 'main', files: [], added: 0, removed: 0 } as never
    expect(chatHasRepo({ ...workspace, sessionRepos: { chat: { type: 'session_repo', chatId: 'chat', waiting: false, changes: { files: 0, added: 0, removed: 0 }, repos: [repo] } } }, session)).toBe(false)
  })

  it('offers Confirm only for a published result nobody has confirmed', () => {
    const handoff = { id: 'h', workChatId: 'chat', state: 'active', version: 4, goalReport: { result: 'Done.' } } as WorkHandoff
    expect(waitingGoal({ ...emptyWorkspace, workHandoffs: [handoff] }, chat({}))).toEqual({ handoffId: 'h', version: 4 })
    expect(waitingGoal({ ...emptyWorkspace, workHandoffs: [{ ...handoff, goalConfirmedAt: 5 }] }, chat({}))).toBeUndefined()
    expect(waitingGoal({ ...emptyWorkspace, workHandoffs: [handoff] }, chat({ settledAt: 9 }))).toBeUndefined()
  })
})

describe('a Session action whose answer is lost with the connection', () => {
  let view: ReactTestRenderer | undefined
  afterEach(() => { act(() => view?.unmount()); view = undefined })
  const requestEvents = { subscribe: () => () => {} }
  const button = (...labels: string[]) => view!.root.findAllByType(Button).find((found) => labels.includes(found.props.children as string))!
  const alerts = () => view!.root.findAll((node) => node.props.role === 'alert').map((node) => node.props.children as unknown)

  it('frees Push, says so, and clears the line once back, without sending it again', () => {
    const onPush = vi.fn(() => true)
    const props = {
      repo: { type: 'session_repo' as const, chatId: 'chat', waiting: false, changes: { files: 0, added: 0, removed: 0 },
        repos: [{ root: '/repo', label: 'repo', branch: 'main', ahead: 1, pushTarget: 'origin/main', uncommitted: [] }] },
      diffOpen: false, diffBlocked: false, running: false, connected: true, commits: [], commitFailures: undefined, requestEvents,
      onToggleDiff: () => {}, onRetry: () => {}, onCommit: () => true, onPush, openApps: [], onOpenFolder: () => {},
    }
    act(() => { view = create(<SessionSections {...props} />) })
    act(() => button('Push 1').props.onClick())
    expect(button('Pushing…').props.disabled).toBe(true)
    act(() => view!.update(<SessionSections {...props} connected={false} />))
    expect(view!.root.findAll((node) => node.props.role === 'alert' && node.type === 'p').length).toBe(1)
    act(() => view!.update(<SessionSections {...props} />))
    expect(button('Push 1').props.disabled).toBeUndefined()
    expect(view!.root.findAll((node) => node.props.role === 'alert' && node.type === 'p')).toEqual([])
    expect(onPush).toHaveBeenCalledTimes(1)
  })

  it('frees Confirm in the diff header', () => {
    const props = {
      hasSession: true, scope: { kind: 'session' as const }, turns: [], onScope: () => {},
      sessionDiff: { type: 'session_diff' as const, chatId: 'chat', waiting: true, ignoreWhitespace: true, files: [], partial: false },
      onRead: () => {}, turnFiles: undefined, goal: { handoffId: 'h', version: 1 },
      actions: { connected: true, requestEvents, accept: vi.fn(() => true), revise: vi.fn(() => true), retry: vi.fn(() => true), askCheckout: () => {} },
      width: 720, overlay: false, revealed: true, resizing: false, resizeProps: {}, onClose: () => {},
    }
    act(() => { view = create(<DiffPanel {...props} />) })
    act(() => button('Confirm').props.onClick())
    act(() => view!.update(<DiffPanel {...props} actions={{ ...props.actions, connected: false }} />))
    expect(alerts()).toContain(SESSION_CONNECTION_LOST)
    act(() => view!.update(<DiffPanel {...props} />))
    expect(button('Confirm').props.disabled).toBe(false)
    expect(props.actions.accept).toHaveBeenCalledTimes(1)
  })
})

describe('a Ready result in the diff', () => {
  let view: ReactTestRenderer | undefined
  afterEach(() => { act(() => view?.unmount()); view = undefined; setWorkChangesOpen('h', false) })
  const file = (path: string, excluded?: true) => ({
    path, root: '/repo', status: 'edited' as const, added: 1, removed: 0, hunks: [], ...(excluded === undefined ? {} : { excluded }),
  })
  const props = {
    hasSession: true, scope: { kind: 'session' as const }, turns: [], onScope: () => {},
    sessionDiff: { type: 'session_diff' as const, chatId: 'chat', waiting: true, ignoreWhitespace: true, partial: false,
      files: [file('src/a.ts'), file('docs/notes.md', true)] },
    onRead: () => {}, turnFiles: undefined, goal: { handoffId: 'h', version: 1, confirmTitle: 'Commits the reviewed file.' },
    actions: { connected: true, requestEvents: { subscribe: () => () => {} }, accept: () => true, revise: () => true, retry: () => true, askCheckout: () => {} },
    width: 720, overlay: false, revealed: true, resizing: false, resizeProps: {}, onClose: () => {},
  }
  const text = () => JSON.stringify(view!.toJSON())

  it('lists the files Confirm leaves out under Not included, and counts them beside Ready', () => {
    act(() => { view = create(<DiffPanel {...props} />) })
    const heading = view!.root.find((node) => node.type === 'h3')
    expect(heading.props.children).toBe('Not included')
    expect(text().indexOf('src/a.ts')).toBeLessThan(text().indexOf('Not included'))
    expect(text().indexOf('Not included')).toBeLessThan(text().indexOf('docs/notes.md'))
    expect(text()).toContain('"Ready"')
    expect(text()).toContain('"1",' + '" ","file"," not included"')
    expect(view!.root.findAllByType(Button).find((found) => found.props.children === 'Confirm')!.props.title).toBe('Commits the reviewed file.')
  })

  it('opens Request changes when the Session’s Ready row above the composer asked for it', () => {
    setWorkChangesOpen('h', true)
    act(() => { view = create(<DiffPanel {...props} />) })
    expect(view!.root.findAllByType(WorkChangesField)).toHaveLength(1)
  })
})

describe('a Commit that runs on after its dialog closed', () => {
  let view: ReactTestRenderer | undefined
  afterEach(() => { act(() => view?.unmount()); view = undefined })
  const file = (path: string) => ({ path, status: 'edited' as const, added: 1, removed: 0 })
  const repo = {
    type: 'session_repo' as const, chatId: 'chat', waiting: false, changes: { files: 3, added: 3, removed: 0 },
    repos: [{ root: '/repo', label: 'repo', branch: 'main', ahead: 0, pushTarget: 'origin/main', uncommitted: [file('a.ts'), file('b.ts'), file('c.ts')] }],
  }
  const failed: SessionGitResult = {
    type: 'session_git_result', chatId: 'chat', root: '/repo', action: 'commit', ok: false,
    text: 'The pre-commit check stopped the commit. Failing: apps/web test/a.test.ts.', files: ['a.ts', 'c.ts'], message: 'Ship a and c',
  }
  const props = {
    repo, diffOpen: false, diffBlocked: false, running: false, connected: true, commits: [] as SessionCommits, commitFailures: undefined as Record<string, SessionGitResult> | undefined,
    requestEvents: { subscribe: () => () => {} }, onToggleDiff: () => {}, onRetry: () => {}, onCommit: () => true, onPush: () => true,
    openApps: [], onOpenFolder: () => {},
  }
  const buttons = () => view!.root.findAllByType(Button).map((found) => [found.props.children, found.props.disabled === true])

  it('reads Committing… and takes no second commit while the host runs it', () => {
    act(() => { view = create(<SessionSections {...props} commits={[{ chatId: 'chat', root: '/repo', files: 2 }]} />) })
    expect(buttons()).toContainEqual(['Committing…', true])
    // Another Session's commit, or a dropped connection, is not this folder's.
    act(() => view!.update(<SessionSections {...props} commits={[{ chatId: 'other', root: '/repo', files: 2 }]} />))
    expect(buttons()).toContainEqual(['Commit', false])
    act(() => view!.update(<SessionSections {...props} connected={false} commits={[{ chatId: 'chat', root: '/repo', files: 2 }]} />))
    expect(buttons()).toEqual([])
  })

  it('offers only the action that can act now, never a disabled one', () => {
    const ahead = { ...repo, repos: [{ ...repo.repos[0]!, ahead: 14 }] }
    act(() => { view = create(<SessionSections {...props} repo={ahead} />) })
    expect(buttons()).toEqual([['Commit', false]])
    act(() => view!.update(<SessionSections {...props} repo={ahead} running />))
    expect(buttons()).toEqual([])
    const pushOnly = { ...repo, repos: [{ ...repo.repos[0]!, ahead: 14, uncommitted: [] }] }
    act(() => view!.update(<SessionSections {...props} repo={pushOnly} />))
    expect(buttons()).toEqual([['Push 14', false]])
    act(() => view!.update(<SessionSections {...props} repo={{ ...repo, repos: [{ ...repo.repos[0]!, uncommitted: [] }] }} />))
    expect(buttons()).toEqual([])
    act(() => view!.update(<SessionSections {...props} repo={{ ...repo, waiting: true }} />))
    expect(buttons()).toEqual([])
  })

  it('keeps a failure under the branch and reopens with its message, ticks and error', () => {
    act(() => { view = create(<SessionSections {...props} commitFailures={{ '/repo': failed }} />) })
    const reopen = view!.root.find((node) => node.type === 'button' && node.props.children === 'Reopen')
    expect(JSON.stringify(view!.toJSON())).toContain(failed.text)
    act(() => reopen.props.onClick())
    const dialog = view!.root.findByType(CommitDialog)
    expect(dialog.props.initial).toEqual({ files: ['a.ts', 'c.ts'], message: 'Ship a and c' })
    expect(dialog.props.error).toBe(failed.text)
    expect(view!.root.findByType('textarea').props.value).toBe('Ship a and c')
    expect(buttons()).toContainEqual(['Commit 2 files', false])
  })

  it('keeps the pull request page a Push came back with under its branch, until the branch moves on', () => {
    const feature = { ...repo, repos: [{ ...repo.repos[0]!, branch: 'feature', pushTarget: 'origin/feature', uncommitted: [] }] }
    const pushed: SessionGitResult = {
      type: 'session_git_result', chatId: 'chat', root: '/repo', action: 'push', ok: true, text: 'Pushed 2 commits to origin/feature.',
      link: { label: 'Open pull request', url: 'https://git.example.test/someone/notes/pull/new/feature', branch: 'feature' },
    }
    const links = () => view!.root.findAll((node) => node.type === 'a' && node.props.href === pushed.link!.url)
    act(() => { view = create(<SessionSections {...props} repo={feature} pushedLinks={{ '/repo': pushed }} />) })
    expect(links()).toHaveLength(1)
    expect(JSON.stringify(view!.toJSON())).toContain('Open pull request')
    // A second folder on that branch has no page of its own, so the page shows once, under the folder it is for.
    const two = { ...feature, repos: [...feature.repos, { ...feature.repos[0]!, root: '/other', label: 'other' }] }
    act(() => view!.update(<SessionSections {...props} repo={two} pushedLinks={{ '/repo': pushed }} />))
    expect(links()).toHaveLength(1)
    // New commits wait to be pushed, or another branch is checked out: the page is not this state's.
    act(() => view!.update(<SessionSections {...props} repo={{ ...feature, repos: [{ ...feature.repos[0]!, ahead: 1 }] }} pushedLinks={{ '/repo': pushed }} />))
    expect(links()).toHaveLength(0)
    act(() => view!.update(<SessionSections {...props} repo={repo} pushedLinks={{ '/repo': pushed }} />))
    expect(links()).toHaveLength(0)
    act(() => view!.update(<SessionSections {...props} repo={feature} />))
    expect(links()).toHaveLength(0)
  })

  it('reopens a failed file renamed since under its new name', () => {
    const renamed = { ...repo, repos: [{ ...repo.repos[0]!, uncommitted: [file('b.ts'), { ...file('a2.ts'), oldPath: 'a.ts' }] }] }
    act(() => { view = create(<SessionSections {...props} repo={renamed} commitFailures={{ '/repo': failed }} />) })
    act(() => view!.root.find((node) => node.type === 'button' && node.props.children === 'Reopen').props.onClick())
    expect(view!.root.findByType(CommitDialog).props.initial).toEqual({ files: ['a2.ts'], message: 'Ship a and c' })
    expect(buttons()).toContainEqual(['Commit 1 file', false])
  })

  it('keeps Reopen and the draft while its file sits beyond a capped list', () => {
    // The runtime decides when a failure has landed; a list cut at the limit proves nothing.
    const capped = { ...repo, repos: [{ ...repo.repos[0]!, uncommitted: Array.from({ length: MAX_SESSION_DIFF_FILES }, (_, i) => file(`x${i}.ts`)) }] }
    act(() => { view = create(<SessionSections {...props} repo={capped} commitFailures={{ '/repo': failed }} />) })
    act(() => view!.root.find((node) => node.type === 'button' && node.props.children === 'Reopen').props.onClick())
    const dialog = view!.root.findByType(CommitDialog)
    expect(dialog.props.initial).toEqual({ files: [], message: 'Ship a and c' })
    expect(dialog.props.error).toBe(failed.text)
  })
})

describe('the Commit and Push toast', () => {
  const result = (requestId: string, ok = true, action: 'commit' | 'push' = 'commit'): SessionGitResult => ({
    type: 'session_git_result', chatId: 'chat', root: '/repo', action, ok, text: `${ok ? 'Done' : 'Failed'} ${requestId}`, requestId,
  })
  function mount(initial: Record<string, SessionGitResult>) {
    let seen: ReturnType<typeof useSessionGitToast> | undefined
    function Probe({ results, commits = [], live = true }: { results: Record<string, SessionGitResult>; commits?: SessionCommits; live?: boolean }) {
      seen = useSessionGitToast(results, commits, live)
      return null
    }
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<Probe results={initial} />) })
    return {
      get: () => seen!,
      send: (results: Record<string, SessionGitResult>, commits: SessionCommits = [], live = true) =>
        act(() => renderer.update(<Probe results={results} commits={commits} live={live} />)),
    }
  }

  it('shows a result that arrives, not one already there, and lifts out on its own', () => {
    vi.useFakeTimers()
    try {
      const view = mount({ chat: result('abc1234') })
      expect(view.get().notice).toBeNull()
      view.send({ chat: result('def5678') })
      expect(view.get().notice).toEqual({ key: 'commit:chat:/repo', text: 'Done def5678', tone: 'done' })
      act(() => { vi.advanceTimersByTime(TOAST_VISIBLE_MS) })
      expect(view.get().notice).toBeNull()
      // A refused Push was answered in its panel; it is no toast.
      view.send({ chat: result('0000000', false, 'push') })
      expect(view.get().notice).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('spins while the host commits, under the same key its outcome replaces, and fails out loud', () => {
    const view = mount({})
    const running = [{ chatId: 'chat', root: '/repo', files: 2 }]
    view.send({}, running)
    expect(view.get().notice).toEqual({ key: 'commit:chat:/repo', text: 'Committing 2 files…', tone: 'running' })
    // Without the connection nobody knows whether it still runs.
    view.send({}, running, false)
    expect(view.get().notice).toBeNull()
    const failure = { chat: result('abc1234', false) }
    view.send(failure, [])
    expect(view.get().notice).toEqual({ key: 'commit:chat:/repo', text: 'Failed abc1234', tone: 'failed' })
    // A retry straight away spins at once instead of the old failure standing over it.
    view.send(failure, running)
    expect(view.get().notice).toEqual({ key: 'commit:chat:/repo', text: 'Committing 2 files…', tone: 'running' })
    view.send({ chat: result('def5678') }, [])
    expect(view.get().notice).toEqual({ key: 'commit:chat:/repo', text: 'Done def5678', tone: 'done' })
  })
})
