import { FolderOffIcon } from '@hugeicons/core-free-icons'
import type { ProjectIcon } from '@manor/contracts'
import { projectIcon } from '../projectAppearance'
import { Badge } from './ui/Badge'

interface ProjectBadgeProps {
  name: string
  icon: ProjectIcon
  color: string
  /** The Session has no project: grey, with a crossed-out folder, reading "No project". */
  noProject?: boolean | undefined
  className?: string
}

/** The project label on a Session's card and header. */
export function ProjectBadge({ name, icon, color, noProject = false, className }: ProjectBadgeProps) {
  return noProject ? (
    <Badge icon={FolderOffIcon} size="inline" {...(className === undefined ? {} : { className })}>
      No project
    </Badge>
  ) : (
    <Badge icon={projectIcon(icon)} tint={color} size="inline" {...(className === undefined ? {} : { className })}>
      {name}
    </Badge>
  )
}
