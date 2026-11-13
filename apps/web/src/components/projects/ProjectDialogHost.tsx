import { useEffect, useState } from 'react'
import { NEW_SINGLE_CHAT_DEFAULT, type Project, type ProjectIcon, type ProjectMemoryScope, type SingleRuntime } from '@manor/contracts'
import { readSingleRuntime } from '../../runtimeChoices'
import type { DirBrowse, Notice } from '../../state'
import { useRequest, type RequestEvents } from '../../useRequest'
import { draftOf, emptyDraft, normaliseProjectColor, ProjectDialog, type ProjectDraft } from './ProjectDialog'

/**
 * Which project the dialog is about, and therefore what saving it means. `armDelete`
 * opens the edit form with its delete question already up, for a sidebar row's
 * Delete project… entry, so that menu shares the dialog's one confirmation.
 */
export type ProjectDialogState =
  | { mode: 'create' }
  | { mode: 'edit'; projectId: string; armDelete?: boolean }

interface ProjectDialogHostProps {
  dialog: ProjectDialogState
  projects: Project[]
  notice: Notice | null
  requestEvents: RequestEvents
  dirs: DirBrowse
  onNewProject: (
    name: string,
    repoPaths: string[],
    icon: ProjectIcon,
    color: string,
    memoryScope: ProjectMemoryScope,
    requestId: string,
    threadRuntime: SingleRuntime,
  ) => boolean
  onUpdateProject: (
    projectId: string,
    name: string,
    repoPaths: string[],
    icon: ProjectIcon,
    color: string,
    memoryScope: ProjectMemoryScope,
    requestId: string,
  ) => boolean
  onListDirs: (path?: string) => void
  onCloseDirs: () => void
  onDismissNotice: () => void
  onClose: () => void
  onDeleteProject: (projectId: string, requestId: string) => boolean
}

/**
 * The project form and the whole life of one opening of it, opened by the sidebar's
 * New project and by a project row's Edit and Delete entries. Mounted only
 * while a dialog is open and keyed on which project it is about, so every opening
 * starts from a freshly seeded draft instead of the last one's leftovers.
 */
export function ProjectDialogHost({
  dialog,
  projects,
  notice,
  requestEvents,
  dirs,
  onNewProject,
  onUpdateProject,
  onListDirs,
  onCloseDirs,
  onDismissNotice,
  onClose,
  onDeleteProject,
}: ProjectDialogHostProps) {
  const editing = dialog.mode === 'edit' ? projects.find((project) => project.id === dialog.projectId) : undefined
  const [draft, setDraft] = useState<ProjectDraft>(() =>
    dialog.mode === 'create' || editing === undefined ? emptyDraft : draftOf(editing),
  )
  const request = useRequest(requestEvents)

  const close = () => {
    request.cancel()
    onCloseDirs()
    onClose()
  }

  useEffect(() => {
    // The project being edited was deleted from under the dialog.
    if (dialog.mode === 'edit' && editing === undefined && !request.pending) {
      onCloseDirs()
      onClose()
    }
  }, [dialog, editing, request.pending, onCloseDirs, onClose])

  const finish = () => {
    onCloseDirs()
    onClose()
  }

  const submitDraft = () => {
    const name = draft.name.trim()
    if (name === '') return
    if (dialog.mode === 'create') {
      request.start(
        (requestId) => onNewProject(name, draft.repoPaths, draft.icon, normaliseProjectColor(draft.color), draft.memoryScope, requestId,
          readSingleRuntime(draft.threadRuntime, NEW_SINGLE_CHAT_DEFAULT)),
        { onAck: finish },
      )
      return
    }
    if (editing === undefined) return
    request.start(
      (requestId) => onUpdateProject(
        dialog.projectId,
        name,
        draft.repoPaths,
        draft.icon,
        normaliseProjectColor(draft.color),
        draft.memoryScope,
        requestId,
      ),
      { onAck: finish },
    )
  }

  return (
    <ProjectDialog
      mode={dialog.mode}
      draft={draft}
      onDraft={(next) => {
        onDismissNotice()
        setDraft(next)
      }}
      dirs={dirs}
      notice={notice}
      busy={request.pending}
      onListDirs={onListDirs}
      onSubmit={submitDraft}
      onCancel={close}
      onClose={close}
      {...(dialog.mode === 'edit'
        ? {
            initialArmed: dialog.armDelete === true,
            // The deleted-from-under-us effect above sees the row vanish and closes.
            onDelete: () => request.start(
              (requestId) => onDeleteProject(dialog.projectId, requestId),
              { onAck: finish },
            ),
          }
        : {})}
    />
  )
}
