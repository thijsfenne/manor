import { FolderOffIcon } from '@hugeicons/core-free-icons'
import type { ProjectIcon } from '@manor/contracts'
import { ProjectMark } from './ProjectMark'
import { Badge } from './ui/Badge'

interface ProjectBadgeProps {
  name: string
  icon: ProjectIcon
  color: string
  /** The project's repo icon link, drawn in place of the glyph. */
  iconSrc?: string | undefined
  /** The project's letters (`markLetters`), drawn in place of the glyph. */
  letters?: string | undefined
  /** The Session has no project: grey, with a crossed-out folder, reading "No project". */
  noProject?: boolean | undefined
  className?: string
}

/** The project label on a Session's card and header. */
export function ProjectBadge({ name, icon, color, iconSrc, letters, noProject = false, className }: ProjectBadgeProps) {
  return noProject ? (
    <Badge icon={FolderOffIcon} size="inline" {...(className === undefined ? {} : { className })}>
      No project
    </Badge>
  ) : (
    <Badge mark={<ProjectMark icon={icon} color={color} src={iconSrc} letters={letters} size={12} />} tint={color} size="inline" {...(className === undefined ? {} : { className })}>
      {name}
    </Badge>
  )
}
