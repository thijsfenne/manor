import { useEffect, useState, type ReactNode } from 'react'
import {
  ArrowDown01Icon, ArrowRight01Icon, GitBranchIcon, LinkSquare02Icon, PlusMinusSquare01Icon,
} from '@hugeicons/core-free-icons'
import type { RepoFileApp, ServerMessage, SessionRepo } from '@manor/contracts'
import { failedFilesStill } from '@manor/client-runtime/state'
import { useRequest, type RequestEvents } from '../../useRequest'
import { ExternalLink } from '../ExternalLink'
import { Icon } from '../Icon'
import { AppMark, RepoHostMark } from '../AppMarks'
import { APP_LABELS } from '../RepoFileOpenMenu'
import { Button } from '../ui/Button'
import { PopDigits } from '../ui/PopDigits'
import { PANEL_ROW_ARROW, PANEL_ROW_HOVER } from '../ui/dockPanel'
import { ContextMenu } from '../ui/ContextMenu'
import { CommitDialog } from './CommitDialog'
import type { SessionCommits } from './SessionGitToast'

export type SessionRepoReply = Extract<ServerMessage, { type: 'session_repo' }>

/**
 * An answer lost with the socket never arrives, so a Session action is dropped rather
 * than left pending, never sent again by itself; the status read on reconnect shows
 * whether it landed.
 */
export const SESSION_CONNECTION_LOST = 'The connection dropped before Manor answered. The outcome shows here once Manor is back.'
export type SessionGitResult = Extract<ServerMessage, { type: 'session_git_result' }>

interface SessionSectionsProps {
  /** Undefined until the first answer: the rows say they are reading rather than guess. */
  repo: SessionRepoReply | undefined
  diffOpen: boolean
  /** A turn is running: what it writes is not finished, so Commit waits for it. */
  running: boolean
  connected: boolean
  /** The host's running Session Commits, all chats; this panel picks its own. */
  commits: SessionCommits
  /** This chat's failed Commits by folder. The runtime drops one only once a full status read shows it landed. */
  commitFailures: Readonly<Record<string, SessionGitResult>> | undefined
  /** This chat's last Push per folder that came back with a pull or merge request page, shown under its branch. */
  pushedLinks?: Readonly<Record<string, SessionGitResult>> | undefined
  requestEvents: RequestEvents
  onToggleDiff: () => void
  /** Reads the status again after it failed. */
  onRetry: () => void
  onCommit: (root: string, files: string[], message: string, requestId: string) => boolean
  onPush: (root: string, requestId: string) => boolean
  /** The host's installed apps, in its order. Empty hides Open in. */
  openApps: readonly RepoFileApp[]
  onOpenFolder: (root: string, app: RepoFileApp) => void
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/**
 * The Session panel below its roster, laid out as an environment card:
 * titled sections with one row per fact. Environment is what the Session would land
 * and where (Changes, then a Branch line per folder), Repository where it pushes to,
 * Editor the folder in an app. Present only where the chat has a linked git folder;
 * the panel stays the roster everywhere else, without empty sections or dead buttons.
 */
export function SessionSections({
  repo, diffOpen, running, connected, commits, commitFailures, pushedLinks, requestEvents, onToggleDiff, onRetry, onCommit, onPush, openApps, onOpenFolder,
}: SessionSectionsProps) {
  const repos = repo?.repos ?? []
  const named = repos.length > 1
  const remotes = repos.filter((entry) => entry.remote !== undefined)
  return (
    <>
      <Section title="Environment">
        {repo?.error === undefined
          ? <ChangesRow repo={repo} open={diffOpen} onToggle={onToggleDiff} />
          : <ReadFailed repo={repo} error={repo.error} connected={connected} onRetry={onRetry} />}
        {repo === undefined ? (
          <Line icon={GitBranchIcon}><span className="text-dim">Reading the branch…</span></Line>
        ) : repos.map((entry) => (
          <BranchLine
            key={entry.root}
            repo={entry}
            named={named}
            waiting={repo.waiting}
            running={running}
            connected={connected}
            committing={connected && commits.some((commit) => commit.chatId === repo.chatId && commit.root === entry.root)}
            failure={commitFailures?.[entry.root]}
            pushed={pushedLink(pushedLinks?.[entry.root], entry)}
            requestEvents={requestEvents}
            onCommit={onCommit}
            onPush={onPush}
          />
        ))}
      </Section>
      {remotes.length === 0 ? null : (
        <Section title="Repository">
          {remotes.map((entry) => <RepoRow key={entry.root} remote={entry.remote!} />)}
        </Section>
      )}
      {openApps.length === 0 || repos.length === 0 ? null : (
        <Section title="Editor">
          {repos.map((entry) => (
            <OpenInRow key={entry.root} apps={openApps} folder={named ? entry.label : undefined} connected={connected}
              onOpen={(app) => onOpenFolder(entry.root, app)} />
          ))}
        </Section>
      )}
    </>
  )
}

/** A titled block of rows, ruled off from the one above it. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex-none border-t border-line px-1.5 pt-2 pb-1.5 first:border-t-0 first:pt-3">
      <h3 className="m-0 px-2 pb-0.5 text-meta font-medium text-dim">{title}</h3>
      {children}
    </section>
  )
}

/**
 * Where the branch pushes to, by the name its host knows it by, and its page there.
 * The page opens the way every website link in a chat does.
 */
function RepoRow({ remote }: { remote: NonNullable<SessionRepo['remote']> }) {
  const host = remote.url === undefined ? '' : new URL(remote.url).hostname
  const body = (
    <>
      <RepoHostMark host={host} />
      <span className="min-w-0 flex-1 truncate text-text">{remote.name}</span>
      {remote.url === undefined ? null : <Icon icon={LinkSquare02Icon} size={13} className={PANEL_ROW_ARROW} />}
    </>
  )
  const row = 'group flex min-h-8 w-full min-w-0 items-center gap-2 rounded-button-sm px-2 text-left text-[13px] no-underline'
  return remote.url === undefined
    ? <div className={row} title={remote.name}>{body}</div>
    : <ExternalLink href={remote.url} target="_blank" rel="noreferrer noopener" title={`Open ${remote.name} on ${host}`} className={`${row} ${PANEL_ROW_HOVER}`}>{body}</ExternalLink>
}

const OPEN_APP_KEY = 'manor:open-in-app'

/**
 * Open in: the folder in the app last chosen, one click; the chevron picks another app
 * and opens it there. The choice is remembered across chats, the way an editor is.
 */
function OpenInRow({ apps, folder, connected, onOpen }: {
  apps: readonly RepoFileApp[]
  /** The folder's name where the Session has several. */
  folder: string | undefined
  connected: boolean
  onOpen: (app: RepoFileApp) => void
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [chosen, setChosen] = useState<RepoFileApp | null>(readOpenApp)
  const active = chosen !== null && apps.includes(chosen) ? chosen : apps[0]!
  const label = `Open ${folder === undefined ? '' : `${folder} `}in ${APP_LABELS[active]}`
  const pick = (app: RepoFileApp) => {
    setChosen(app)
    writeOpenApp(app)
    onOpen(app)
  }
  return (
    <div className={`group flex min-h-8 min-w-0 items-center rounded-button-sm text-[13px] ${PANEL_ROW_HOVER}`}>
      <button type="button" disabled={!connected} onClick={() => onOpen(active)} title={label}
        className="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-button-sm border-0 bg-transparent px-2 text-left text-[13px] text-text disabled:cursor-default disabled:opacity-60">
        <AppMark app={active} />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      <button type="button" aria-haspopup="menu" aria-expanded={menu !== null} aria-label="Choose application" title="Choose application"
        disabled={!connected}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setMenu((current) => current === null ? { x: rect.right - 196, y: rect.bottom + 4 } : null)
        }}
        className={`grid h-8 w-8 flex-none cursor-pointer place-items-center rounded-button-sm border-0 bg-transparent hover:text-text disabled:cursor-default ${menu === null ? 'text-dim' : 'text-text'}`}>
        <Icon icon={ArrowDown01Icon} size={12} />
      </button>
      {menu === null ? null : (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}
          items={apps.map((app) => ({ label: APP_LABELS[app], mark: <AppMark app={app} />, checked: app === active, onSelect: () => pick(app) }))} />
      )}
    </div>
  )
}

function readOpenApp(): RepoFileApp | null {
  try {
    return window.localStorage.getItem(OPEN_APP_KEY) as RepoFileApp | null
  } catch {
    return null
  }
}

function writeOpenApp(app: RepoFileApp) {
  try {
    window.localStorage.setItem(OPEN_APP_KEY, app)
  } catch {
    // The choice still holds until the panel closes.
  }
}

/** One row inside a section: a quiet glyph, then the line. */
function Line({ icon, children }: { icon: typeof GitBranchIcon; children: ReactNode }) {
  return (
    <div className="flex min-h-8 min-w-0 items-center gap-2 px-2 text-[13px]">
      <Icon icon={icon} size={14} className="flex-none text-dim" />
      {children}
    </div>
  )
}

/**
 * A status read that failed, in full, with a way to read it again. Retry reads until
 * the next answer arrives, whatever it says, so a second failure is visibly a new one.
 */
function ReadFailed({ repo, error, connected, onRetry }: { repo: SessionRepoReply; error: string; connected: boolean; onRetry: () => void }) {
  const [retried, setRetried] = useState<SessionRepoReply | null>(null)
  const reading = retried === repo
  return (
    <div className="min-w-0">
      <Line icon={PlusMinusSquare01Icon}>
        <span className="text-text">Changes</span>
        <Button size="compact" variant="secondary" className="ml-auto flex-none" disabled={!connected || reading}
          onClick={() => {
            setRetried(repo)
            onRetry()
          }}>
          {reading ? 'Reading…' : 'Retry'}
        </Button>
      </Line>
      <p role="alert" className="m-0 px-2 pb-1.5 pl-[30px] text-meta break-words text-danger">{error}</p>
    </div>
  )
}

/**
 * "Changes +12 −3", and the door to the diff, which opens in this panel's place. While a
 * result waits for Confirm it shows the count of files Confirm would land, in the waiting colour.
 */
function ChangesRow({ repo, open, onToggle }: { repo: SessionRepoReply | undefined; open: boolean; onToggle: () => void }) {
  if (repo === undefined) return <Line icon={PlusMinusSquare01Icon}><span className="text-text">Changes</span><span className="ml-auto text-dim">Reading…</span></Line>
  const { files, added, removed } = repo.changes
  if (files === 0 && !open) return <Line icon={PlusMinusSquare01Icon}><span className="text-text">Changes</span><span className="ml-auto text-dim">None yet</span></Line>
  return (
    <button
      type="button"
      aria-expanded={open}
      title={open ? 'Hide the diff' : 'Show the diff'}
      onClick={onToggle}
      className={`group flex min-h-8 w-full min-w-0 items-center gap-2 rounded-button-sm border-0 px-2 text-left text-[13px] ${
        open ? 'cursor-pointer bg-icon-fill' : `cursor-pointer bg-transparent ${PANEL_ROW_HOVER}`
      }`}
    >
      <Icon icon={PlusMinusSquare01Icon} size={14} className="flex-none text-dim" />
      <span className="text-text">Changes</span>
      {repo.waiting ? (
        <span className="ml-auto flex-none tabular-nums text-warn">{plural(files, 'file')}<span className="sr-only"> waiting for Confirm</span></span>
      ) : (
        <span className="ml-auto flex flex-none items-center gap-2 tabular-nums">
          {/* Hidden at zero rather than unmounted, so a count that starts mid-turn pops in too. */}
          <span hidden={added === 0} className="text-ok"><PopDigits value={added} prefix="+" /></span>
          <span hidden={removed === 0} className="text-danger"><PopDigits value={removed} prefix="−" /></span>
          {added === 0 && removed === 0 ? <span className="text-dim">{files === 0 ? 'None' : plural(files, 'file')}</span> : null}
        </span>
      )}
      <Icon icon={ArrowRight01Icon} size={12} className={open ? 'flex-none text-text' : PANEL_ROW_ARROW} />
    </button>
  )
}

/**
 * The page the remote offered when this branch was last pushed, for as long as that
 * push is still the whole story: the same branch, with nothing new to send.
 */
function pushedLink(result: SessionGitResult | undefined, repo: SessionRepo): PushedLink | undefined {
  if (result?.link === undefined || result.link.branch !== repo.branch || repo.ahead > 0) return undefined
  return { text: result.text, label: result.link.label, url: result.link.url }
}

interface PushedLink { text: string; label: string; url: string }

/** The branch, where a worktree merges, and the one way to land it that can act now. */
function BranchLine({ repo, named, waiting, running, connected, committing: committingNow, failure, pushed, requestEvents, onCommit, onPush }: {
  repo: SessionRepo
  named: boolean
  waiting: boolean
  running: boolean
  connected: boolean
  /** The host is committing in this folder: the dialog closed on Commit, the hook still runs. */
  committing: boolean
  failure: SessionGitResult | undefined
  pushed: PushedLink | undefined
  requestEvents: RequestEvents
  onCommit: SessionSectionsProps['onCommit']
  onPush: SessionSectionsProps['onPush']
}) {
  const push = useRequest(requestEvents)
  const commit = useRequest(requestEvents)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [last, setLast] = useState<{ requestId: string; error?: string } | null>(null)
  const [commitError, setCommitError] = useState<string | null>(null)
  const { pending: pushing, cancel: dropPush } = push
  const { pending: sendingCommit, cancel: dropCommit } = commit
  useEffect(() => {
    if (connected) {
      setLast((current) => current?.error === SESSION_CONNECTION_LOST ? null : current)
      setCommitError((current) => current === SESSION_CONNECTION_LOST ? null : current)
      return
    }
    if (pushing) {
      dropPush()
      setLast((current) => current === null ? current : { ...current, error: SESSION_CONNECTION_LOST })
    }
    if (sendingCommit) {
      dropCommit()
      setCommitError(SESSION_CONNECTION_LOST)
    }
  }, [connected, pushing, sendingCommit, dropPush, dropCommit])

  const branch = repo.branch ?? 'Not on a branch'
  const where = `${named ? `${repo.label}: ` : ''}${branch}${repo.mergeTarget === undefined ? '' : ` → ${repo.mergeTarget}`}`
  const state = repo.branch === null ? null
    : repo.pushTarget === undefined ? 'no remote'
      : repo.ahead > 0 ? `${plural(repo.ahead, 'commit')} to push` : 'nothing to push'
  // One action at most, the one that can act now: Commit first, since Push then sends it too.
  // Confirm is the way to land a waiting result, so Commit is not here at all then.
  const canCommit = !waiting && repo.uncommitted.length > 0
  const canPush = repo.pushTarget !== undefined && repo.ahead > 0
  // What went through is the window's toast (`SessionGitToast`); what went wrong stays
  // here, under the branch it is about, and so does the page a Push came back with.
  const error = last?.error
  const busy = commit.pending || committingNow
  // A failed Commit reopens as it was left, from its Reopen and from Commit alike.
  const openDialog = () => {
    setCommitError(null)
    setDialogOpen(true)
  }

  const startPush = () => {
    push.start((requestId) => {
      const sent = onPush(repo.root, requestId)
      if (sent) setLast({ requestId })
      return sent
    }, { onNotice: (notice) => setLast((current) => current === null ? current : { ...current, error: notice.text }) })
  }

  return (
    <div className="min-w-0">
      <div className="flex min-h-8 min-w-0 items-center gap-2 px-2 text-[13px]">
        <Icon icon={GitBranchIcon} size={14} className="flex-none text-dim" />
        <span className="min-w-0 flex-1 truncate text-text" title={state === null ? where : `${where}, ${state}`}>{where}</span>
        {push.pending ? (
          <Button size="compact" variant="secondary" className="flex-none" disabled>Pushing…</Button>
        ) : busy ? (
          <Button size="compact" variant="secondary" className="flex-none" disabled
            title={committingNow ? 'Committing. The pre-commit checks may take a while.' : undefined}>Committing…</Button>
        ) : !connected || running ? null : canCommit ? (
          <Button size="compact" variant="secondary" className="flex-none"
            title={`Commit this Session’s ${plural(repo.uncommitted.length, 'uncommitted file')}`} onClick={openDialog}>
            Commit
          </Button>
        ) : canPush ? (
          <Button size="compact" variant="secondary" className="flex-none"
            title={`Push ${plural(repo.ahead, 'commit')} on ${branch} to ${repo.pushTarget}. Never forced.`} onClick={startPush}>
            {`Push ${repo.ahead}`}
          </Button>
        ) : null}
      </div>
      {error === undefined ? null : (
        <p role="alert" className="m-0 px-2 pb-1.5 pl-[30px] text-meta break-words text-danger">{error}</p>
      )}
      {pushed === undefined || error !== undefined ? null : (
        <div className="flex min-w-0 items-baseline gap-2 px-2 pb-1.5 pl-[30px] text-meta">
          <span className="min-w-0 flex-1 break-words text-dim">{pushed.text}</span>
          <ExternalLink href={pushed.url} target="_blank" rel="noreferrer noopener" title={pushed.url}
            className="flex-none text-meta font-medium text-text no-underline hover:underline">
            {pushed.label}
          </ExternalLink>
        </div>
      )}
      {failure === undefined || busy || dialogOpen ? null : (
        <div role="alert" className="flex min-w-0 items-baseline gap-2 px-2 pb-1.5 pl-[30px] text-meta">
          <span className="min-w-0 flex-1 break-words text-danger">{failure.text}</span>
          <button type="button" disabled={!connected || running} onClick={openDialog}
            className="flex-none cursor-pointer border-0 bg-transparent p-0 text-meta font-medium text-text hover:underline disabled:cursor-default disabled:text-dim disabled:no-underline">
            Reopen
          </button>
        </div>
      )}
      {dialogOpen ? (
        <CommitDialog
          repo={repo}
          {...(failure?.files === undefined ? {} : { initial: { files: failedFilesStill(failure.files, repo), message: failure.message ?? '' } })}
          pending={commit.pending}
          error={commitError ?? failure?.text ?? null}
          connected={connected}
          onClose={() => {
            commit.cancel()
            setDialogOpen(false)
          }}
          onCommit={(files, message) => {
            setCommitError(null)
            commit.start((requestId) => {
              const sent = onCommit(repo.root, files, message, requestId)
              if (sent) setLast({ requestId })
              return sent
            }, {
              onAck: () => setDialogOpen(false),
              onNotice: (notice) => setCommitError(notice.text),
            })
          }}
        />
      ) : null}
    </div>
  )
}
