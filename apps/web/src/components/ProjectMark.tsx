import { useState, type CSSProperties } from 'react'
import type { ProjectIcon } from '@manor/contracts'
import { isTileRepoIcon, projectIcon, projectTileRadius } from '../projectAppearance'
import { Icon } from './Icon'

interface ProjectMarkProps {
  icon: ProjectIcon
  color: string
  /** The project's repo icon link (`Project.repoIconSrc`); the glyph stands in when absent or when it fails to load. */
  src?: string | undefined
  /** The project's letters (`markLetters`), drawn on a tile of its colour in place of the glyph. */
  letters?: string | undefined
  size: number
  className?: string
  style?: CSSProperties
}

/**
 * A project's icon wherever one is drawn: its repo icon at the glyph's size and untinted,
 * with rounded corners only when it fills its square, its letters on a tile of its colour,
 * or its glyph in the project's colour. A file deleted from the repo answers 404, and the
 * glyph takes its place without a broken image.
 */
export function ProjectMark({ icon, color, src, letters, size, className = '', style }: ProjectMarkProps) {
  const [failed, setFailed] = useState<string | null>(null)
  if (src !== undefined && failed !== src) {
    const tile = isTileRepoIcon(src)
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        draggable={false}
        className={`flex-none ${tile ? 'object-cover' : 'object-contain'} ${className}`}
        style={{ width: size, height: size, ...(tile ? { borderRadius: projectTileRadius(size) } : {}), ...style }}
        onError={() => setFailed(src)}
      />
    )
  }
  if (letters !== undefined && letters !== '') {
    return (
      <span
        aria-hidden
        className={`grid flex-none select-none place-items-center font-medium leading-none tracking-[-0.02em] ${className}`}
        style={{ width: size, height: size, borderRadius: projectTileRadius(size), fontSize: size * 0.5, color, backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)`, ...style }}
      >
        {letters}
      </span>
    )
  }
  return <Icon icon={projectIcon(icon)} size={size} className={`flex-none ${className}`} style={{ color, ...style }} />
}
