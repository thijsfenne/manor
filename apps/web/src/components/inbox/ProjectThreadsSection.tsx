import { useState, type MouseEvent } from 'react'
import { Delete02Icon, FolderAddIcon, PencilEdit02Icon, PlusSignIcon, ViewOffSlashIcon } from '@hugeicons/core-free-icons'
import type { Project } from '@manor/contracts'
import { projectIcon } from '../../projectAppearance'
import { relativeTime } from '../../relativeTime'
import type { ProjectThreadRow } from '../../state'
import { useMinuteClock } from '../../useMinuteClock'
import { Icon } from '../Icon'
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu'
import { IconButton } from '../ui/IconButton'

/** "1 running", "2 running": what a project row says while its sessions run. */
export const runningLabel = (count: number): string => `${count} running`

interface ProjectThreadsSectionProps {
  rows: ProjectThreadRow[]
  /** Hidden projects (no thread), offered by the + menu so a re-add reuses them. */
  available: Project[]
  mobile?: boolean
  /** A row stays lit while its thread is on the stage or in a pane. */
  showSelection: boolean
  occupiedChatIds?: ReadonlySet<string>
  onOpen: (chatId: string) => void
  onCreate: (projectId: string) => void
  onNewProject: () => void
  /** The row's menu: the Edit project dialog, plain or already asking to delete. */
  onEdit: (projectId: string) => void
  onDelete: (projectId: string) => void
  onRemove: (projectId: string) => void
}

/**
 * The Projects section above the Sessions list (decided 2026-10-10): one row per
 * project with a thread, which opens that thread. The row carries what its sessions
 * are doing, because those sessions stay out of the list below on the Mac. Being
 * listed here is having a thread (2026-10-14): Hide project thread archives the
 * thread, and + lists the hidden projects to bring one back.
 */
export function ProjectThreadsSection({
  rows,
  available,
  mobile = false,
  showSelection,
  occupiedChatIds,
  onOpen,
  onCreate,
  onNewProject,
  onEdit,
  onDelete,
  onRemove,
}: ProjectThreadsSectionProps) {
  const now = useMinuteClock()
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null)
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; row: ProjectThreadRow } | null>(null)
  const addItems: ContextMenuItem[] = [
    ...available.map((project) => ({ label: project.name, icon: projectIcon(project.icon), onSelect: () => onCreate(project.id) })),
    { label: 'New project thread…', icon: FolderAddIcon, onSelect: onNewProject },
  ]

  return (
    <section aria-label="Project threads" className="flex-none pt-2">
      <div className={`flex items-center gap-1 pl-2 ${mobile ? 'h-11' : 'h-8'}`}>
        <h3 className="m-0 min-w-0 flex-1 truncate text-[12px] font-medium text-dim">Project threads</h3>
        <IconButton
          icon={PlusSignIcon}
          iconSize={15}
          size={mobile ? 44 : 28}
          label="Add a project thread"
          aria-haspopup="menu"
          aria-expanded={addMenu !== null}
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect()
            setAddMenu({ x: bounds.left, y: bounds.bottom + 4 })
          }}
        />
      </div>
      {rows.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {rows.map((row) => {
            const selected = occupiedChatIds !== undefined ? occupiedChatIds.has(row.chat.id) : showSelection && row.selected
            return (
              <li
                key={row.chat.id}
                className={`relative rounded-lg ${selected ? 'bg-user-bg text-text' : 'text-muted hover:bg-surface-2 hover:text-text'}`}
                onContextMenu={(event: MouseEvent<HTMLLIElement>) => {
                  event.preventDefault()
                  setRowMenu({ x: event.clientX, y: event.clientY, row })
                }}
              >
                <button
                  type="button"
                  className={`flex w-full cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-3 text-left text-inherit [font:inherit] ${mobile ? 'h-11' : 'h-9'}`}
                  aria-label={`Open project thread ${row.project.name}`}
                  aria-current={selected ? 'page' : undefined}
                  data-sidebar-section="projects"
                  onClick={() => onOpen(row.chat.id)}
                >
                  <Icon icon={projectIcon(row.project.icon)} size={16} className="flex-none" style={{ color: row.project.color }} />
                  {/* Sized on the span: `[font:inherit]` on the button outranks a text-size utility there. */}
                  <span className="min-w-0 flex-1 truncate text-[14px]">{row.project.name}</span>
                  {row.waiting ? (
                    <span className="flex-none text-[12px] font-medium text-warn">Waiting on you</span>
                  ) : row.running > 0 ? (
                    <span className="flex-none text-[12px] text-dim">{runningLabel(row.running)}</span>
                  ) : (
                    <span className="flex-none text-[12px] tabular-nums text-dim">{relativeTime(row.lastActivityAt, now)}</span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {addMenu === null ? null : <ContextMenu x={addMenu.x} y={addMenu.y} items={addItems} onClose={() => setAddMenu(null)} />}
      {rowMenu === null ? null : (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          items={[
            { label: 'Edit project thread…', icon: PencilEdit02Icon, onSelect: () => onEdit(rowMenu.row.project.id) },
            { label: 'Hide project thread', icon: ViewOffSlashIcon, onSelect: () => onRemove(rowMenu.row.project.id) },
            { label: 'Delete project thread…', icon: Delete02Icon, tone: 'danger' as const, onSelect: () => onDelete(rowMenu.row.project.id) },
          ]}
          onClose={() => setRowMenu(null)}
        />
      )}
    </section>
  )
}
