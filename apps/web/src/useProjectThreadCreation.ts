import { useCallback, useEffect, useState } from 'react'
import type { ProjectDialogState } from './components/projects/ProjectDialogHost'
import { chatOf } from './state'
import type { Manor } from './useWorkspace'

/**
 * A project thread (2026-10-10): + opens it, Hide project archives it. New project makes
 * the project first and its thread as soon as the directory lists the project.
 */
export function useProjectThreadCreation(
  manor: Manor,
  openChat: (chatId: string) => void,
  openProjectDialog: (dialog: ProjectDialogState) => void,
  projectDialog: ProjectDialogState | null,
) {
  const { workspace } = manor
  // Opened once a render holds it: the answer can arrive before the directory that lists it renders.
  const [openAfterCreate, setOpenAfterCreate] = useState<string | null>(null)
  const createProjectThread = useCallback((projectId: string) => {
    void manor.createProjectThread(projectId).then((chatId) => {
      if (chatId !== '') setOpenAfterCreate(chatId)
    }).catch(() => undefined)
  }, [manor.createProjectThread])
  useEffect(() => {
    if (openAfterCreate === null || chatOf(workspace, openAfterCreate) === null) return
    setOpenAfterCreate(null)
    openChat(openAfterCreate)
  }, [openAfterCreate, workspace, openChat])

  // The projects there were when New project opened; the one that appears after is the new one.
  const [threadForNewProject, setThreadForNewProject] = useState<ReadonlySet<string> | null>(null)
  const newProjectThread = useCallback(() => {
    setThreadForNewProject(new Set(workspace.projects.map((project) => project.id)))
    openProjectDialog({ mode: 'create' })
  }, [workspace.projects, openProjectDialog])
  useEffect(() => {
    if (threadForNewProject === null) return
    const created = workspace.projects.find((project) => !threadForNewProject.has(project.id))
    if (created !== undefined) {
      setThreadForNewProject(null)
      createProjectThread(created.id)
    } else if (projectDialog === null) {
      setThreadForNewProject(null)
    }
  }, [threadForNewProject, workspace.projects, projectDialog, createProjectThread])

  return { createProjectThread, newProjectThread }
}
