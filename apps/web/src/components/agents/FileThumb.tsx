import { PlayIcon } from '@hugeicons/core-free-icons'
import type { DmFile } from '@manor/contracts'
import { FileMark } from '../fileMark'
import { Icon } from '../Icon'

/**
 * A library file at thumbnail size: the picture itself, a play mark for a video, and
 * the file-type glyph for everything else or once the bytes are gone. The caller sets
 * the box with `className`; `glyph` is the mark's size inside it.
 */
export function FileThumb({ file, glyph = 16, className = '' }: { file: DmFile; glyph?: number; className?: string }) {
  const box = `flex flex-none items-center justify-center overflow-hidden bg-surface-2 text-muted ${className}`
  if (file.kind === 'image' && file.src !== undefined) {
    return <img src={file.src} alt="" loading="lazy" draggable={false} className={`${box} object-cover`} />
  }
  return (
    <span className={box} aria-hidden="true">
      {file.kind === 'video' ? <Icon icon={PlayIcon} size={glyph} /> : <FileMark path={file.name} size={glyph} />}
    </span>
  )
}
