import { HOME_PROJECT_ID, type Chat, type Project } from '@manor/contracts'

/**
 * The room of the newest active Session, which may be the home room; archived work does
 * not steer a new draft. With nothing to go on, the first project, or none at all.
 */
export function lastCreatedProjectId(
  chats: readonly (Pick<Chat, 'kind' | 'projectId' | 'createdAt'> & { archivedAt?: number | null })[],
  projects: readonly Pick<Project, 'id'>[],
) {
  const projectIds = new Set(projects.map((project) => project.id))
  let latest: (typeof chats)[number] | undefined

  for (const chat of chats) {
    if (
      chat.kind !== 'project' ||
      chat.projectId === null ||
      (chat.archivedAt !== null && chat.archivedAt !== undefined) ||
      !(projectIds.has(chat.projectId) || chat.projectId === HOME_PROJECT_ID)
    ) continue
    if (latest === undefined || chat.createdAt > latest.createdAt) latest = chat
  }

  return latest?.projectId ?? projects[0]?.id
}
