import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BubbleChatIcon, Download04Icon, Files01Icon, MoreHorizontalIcon, ViewIcon } from '@hugeicons/core-free-icons'
import type { AgentConfig, DmFile } from '@manor/contracts'
import {
  DM_FILES_EMPTY_TITLE,
  DM_FILES_MORE,
  DM_FILES_SHOWN,
  DM_FILE_FILTERS,
  DM_FILTER_EMPTY,
  dmFileTypeLabel,
  dmFilesEmptyLine,
  filterDmFiles,
  groupDmFiles,
  type DmFileFilter,
} from '@manor/client-runtime/dm-files'
import { saveDmFile } from '../../dmFileActions'
import { messageTime } from '../../messageMeta'
import { relativeTime } from '../../relativeTime'
import { useMinuteClock } from '../../useMinuteClock'
import type { ConnectionStatus } from '../../useWorkspace'
import { Avatar } from '../Avatar'
import { Icon } from '../Icon'
import { HoverCard } from '../ui/HoverCard'
import { IconButton } from '../ui/IconButton'
import { Menu, MenuItem, useMenu } from '../ui/Menu'
import { SegmentedControl } from '../ui/SegmentedControl'
import { useHoverCard } from '../ui/useHoverCard'
import { FileThumb } from './FileThumb'
import { MiddleCut } from '../MiddleCut'

// The viewer brings the PDF reader with it, which a page that only lists must not pay for.
const FileViewer = lazy(() => import('./FileViewer').then((module) => ({ default: module.FileViewer })))

/** How long the DM has to stay quiet before a list on screen is asked for again. */
const REFRESH_MS = 600
const CARD_WIDTH = 288
const LIST_ID = 'agent-files-list'
const TABS = DM_FILE_FILTERS.map((filter) => ({ ...filter, tabId: `agent-files-tab-${filter.value}`, panelId: LIST_ID }))

export interface AgentFilesProps {
  chatId: string
  /** The agent's name, as the page says it. */
  name: string
  /** Newest first. Undefined until the server has answered for this DM. */
  files: readonly DmFile[] | undefined
  /** Changes when the DM's transcript does, so a list on screen is asked for again. */
  revision: string
  status: ConnectionStatus
  agents: readonly AgentConfig[]
  /** Who an attached file is from. */
  user: { name: string; photo: string }
  onLoad: (chatId: string) => boolean
  /** Scrolls the DM to the message that holds a file. */
  onShowInChat: (messageId: string) => void
}

/**
 * The Files page of a DM's agent settings: everything attached to and made in that DM,
 * newest first. A row opens the viewer over the files of the filter it is listed under.
 */
export function AgentFiles({ chatId, name, files, revision, status, agents, user, onLoad, onShowInChat }: AgentFilesProps) {
  const [filter, setFilter] = useState<DmFileFilter>('all')
  // How many rows each group shows, once Show more has been pressed in it.
  const [shown, setShown] = useState<Record<string, number>>({})
  const [viewing, setViewing] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const now = useMinuteClock()

  // Asked on opening and on reconnect, and a beat after the DM last gained an event.
  const asked = useRef(false)
  useEffect(() => {
    if (status !== 'live') return
    const timer = setTimeout(() => onLoad(chatId), asked.current ? REFRESH_MS : 0)
    asked.current = true
    return () => clearTimeout(timer)
  }, [chatId, onLoad, revision, status])

  const listed = useMemo(() => filterDmFiles(files ?? [], filter), [files, filter])
  const viewIndex = viewing === null ? -1 : listed.findIndex((file) => file.id === viewing)

  const authorOf = (file: DmFile): { name: string; face: ReactNode } => {
    if (file.agentId === undefined) {
      return { name: user.name, face: <img src={user.photo} alt="" className="h-4 w-4 flex-none rounded-full object-cover" /> }
    }
    const agent = agents.find((candidate) => candidate.id === file.agentId)
    if (agent === undefined) return { name: file.agentId, face: null }
    return {
      name: agent.name,
      face: <Avatar name={agent.name} color={agent.color} src={agent.avatar} shape={agent.avatarShape} tone={agent.avatarTone} size={16} center />,
    }
  }

  if (files === undefined) {
    return <p className="m-0 px-5 py-4 text-[14px] text-dim">{status === 'live' ? 'Loading files…' : 'Files load once Manor is connected.'}</p>
  }
  if (files.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-8 pb-10 text-center">
        <Icon icon={Files01Icon} size={20} className="mb-1.5 text-dim" />
        <p className="m-0 text-[14px] text-text">{DM_FILES_EMPTY_TITLE}</p>
        <p className="m-0 text-label text-dim">{dmFilesEmptyLine(name)}</p>
      </div>
    )
  }

  return (
    <>
      <div className="flex h-11 shrink-0 items-center border-b border-line pr-2 pl-2">
        <SegmentedControl label="Files shown" options={TABS} value={filter} onChange={setFilter} />
      </div>
      <div
        id={LIST_ID}
        role="tabpanel"
        aria-labelledby={`agent-files-tab-${filter}`}
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 pt-3.5 pb-5 [&>*]:shrink-0"
      >
        {filter !== 'all' && listed.length === 0 ? <p className="m-0 text-[14px] text-dim">{DM_FILTER_EMPTY[filter]}</p> : null}
        {groupDmFiles(listed, now).map((group) => {
          const limit = shown[group.label] ?? DM_FILES_SHOWN
          return (
            <section key={group.label} className="flex flex-col gap-1.5" aria-label={group.label}>
              <span className="pl-0.5 text-meta font-medium text-dim">{group.label}</span>
              <div className="rounded-lg border border-line bg-surface-2 p-1">
                {group.files.slice(0, limit).map((file) => (
                  <FileRow
                    key={file.id}
                    file={file}
                    now={now}
                    author={authorOf(file)}
                    onOpen={() => setViewing(file.id)}
                    onDownload={() => void saveDmFile(file).then(setProblem)}
                    onShowInChat={onShowInChat}
                  />
                ))}
                {group.files.length <= limit ? null : (
                  <button
                    type="button"
                    className="flex min-h-[34px] w-full cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-label text-muted outline-none hover:bg-user-bg hover:text-text focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
                    onClick={() => setShown((current) => ({ ...current, [group.label]: limit + DM_FILES_MORE }))}
                  >
                    Show more
                  </button>
                )}
              </div>
            </section>
          )
        })}
        {problem === null ? null : <p role="alert" className="m-0 px-0.5 text-label text-danger">{problem}</p>}
      </div>
      {viewIndex < 0 ? null : (
        <Suspense fallback={null}>
          <FileViewer files={listed} index={viewIndex} onIndex={(index) => setViewing(listed[index]?.id ?? null)} onClose={() => setViewing(null)} />
        </Suspense>
      )}
    </>
  )
}

/** One file: the row opens it, and a mouse resting on it gets the age, the menu and the card above. */
function FileRow({ file, now, author, onOpen, onDownload, onShowInChat }: {
  file: DmFile
  now: number
  author: { name: string; face: ReactNode }
  onOpen: () => void
  onDownload: () => void
  onShowInChat: (messageId: string) => void
}) {
  const [menu, trigger] = useMenu({ maxHeight: 200, minHeight: 120, minWidth: 176 })
  const hover = useHoverCard<HTMLDivElement>({ suspended: menu.open })
  const gone = file.src === undefined
  const { messageId } = file
  // A finger has no hover, so on touch the menu button is there from the start.
  const onRest = 'opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 group-data-[open]:opacity-100'
  return (
    <div
      ref={hover.anchorRef}
      className="group flex min-h-[36px] items-center rounded-md pr-1 hover:bg-user-bg has-[:focus-visible]:bg-user-bg data-[open]:bg-user-bg"
      data-open={menu.open || undefined}
      onPointerEnter={hover.scheduleShow}
      onPointerLeave={hover.scheduleHide}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 self-stretch rounded-md border-0 bg-transparent pr-1 pl-2 text-left text-[14px] outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
        onClick={() => {
          hover.dismiss()
          onOpen()
        }}
      >
        <FileThumb file={file} glyph={13} className="h-5 w-5 rounded-[5px] border border-line" />
        <MiddleCut text={file.name} className={`flex-1 ${gone ? 'text-dim' : 'text-text'}`} />
      </button>
      {gone
        ? <span className="flex-none px-1 text-meta text-dim">Unavailable</span>
        : <span className={`flex-none px-1 text-meta tabular-nums text-dim ${onRest}`}>{relativeTime(file.ts, now)}</span>}
      <IconButton
        ref={trigger}
        icon={MoreHorizontalIcon}
        label={`Actions for ${file.name}`}
        size={28}
        className={`${onRest} [@media(hover:none)]:opacity-100`}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={() => {
          hover.dismiss()
          menu.toggle()
        }}
      />
      <Menu menu={menu} label={`Actions for ${file.name}`}>
        <MenuItem icon={ViewIcon} onClick={() => { menu.close(false); onOpen() }}>Open</MenuItem>
        <MenuItem icon={Download04Icon} disabled={gone} onClick={() => { menu.close(); onDownload() }}>Download</MenuItem>
        {messageId === undefined ? null : (
          <MenuItem icon={BubbleChatIcon} onClick={() => { menu.close(false); onShowInChat(messageId) }}>Show in chat</MenuItem>
        )}
      </Menu>
      {hover.card === null ? null : (
        <HoverCard
          anchor={hover.card.anchor}
          open={hover.card.open}
          width={CARD_WIDTH}
          side="top"
          label={`${file.name} details`}
          onClose={hover.dismiss}
          onPointerEnter={hover.show}
          onPointerLeave={hover.scheduleHide}
          // Read, never pressed: the pointer passes through to the rows it covers.
          className="pointer-events-none overflow-hidden"
        >
          <FileThumb file={file} glyph={28} className={`w-full object-top ${file.kind === 'image' && !gone ? 'h-[168px]' : 'h-[104px]'}`} />
          <div className="flex flex-col gap-0.5 px-3 pb-3">
            <span className="text-meta text-dim">{gone ? `${dmFileTypeLabel(file.kind)}, unavailable` : dmFileTypeLabel(file.kind)}</span>
            <span className="line-clamp-2 break-words text-[14px] font-medium text-text">{file.name}</span>
            <span className="mt-1.5 flex min-w-0 items-center gap-1.5 text-meta text-muted">
              {author.face}
              <span className="min-w-0 truncate">{author.name}</span>
              <span className="flex-none text-dim">{messageTime(file.ts, now)}</span>
            </span>
          </div>
        </HoverCard>
      )}
    </div>
  )
}
