import type { DmFile, DmFileKind } from '@manor/contracts'

/** The library's filter chips. Media is pictures and video; Files is everything else. */
export const DM_FILE_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'media', label: 'Media' },
  { value: 'files', label: 'Files' },
] as const
export type DmFileFilter = (typeof DM_FILE_FILTERS)[number]['value']

/** What the library says when it has nothing to list, the same words on the Mac and the phone. */
export const DM_FILES_EMPTY_TITLE = 'No files yet'
export const dmFilesEmptyLine = (agentName: string): string =>
  `Files you attach and files ${agentName} makes in this chat show up here.`
export const DM_FILTER_EMPTY: Record<Exclude<DmFileFilter, 'all'>, string> = {
  media: 'No pictures or video in this chat yet.',
  files: 'No documents in this chat yet.',
}

/** Rows a group shows before Show more, and how many each Show more adds. */
export const DM_FILES_SHOWN = 5
export const DM_FILES_MORE = 20

const TYPE_LABELS: Record<DmFileKind, string> = { image: 'Image', video: 'Video', pdf: 'PDF', file: 'File' }
export const dmFileTypeLabel = (kind: DmFileKind): string => TYPE_LABELS[kind]

const isMedia = (file: DmFile) => file.kind === 'image' || file.kind === 'video'

export const filterDmFiles = (files: readonly DmFile[], filter: DmFileFilter): DmFile[] =>
  files.filter((file) => filter === 'all' || isMedia(file) === (filter === 'media'))

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface DmFileGroup {
  label: 'This week' | 'Older'
  files: DmFile[]
}

/** The list as its two cards: the last seven days, then the rest. An empty one is left out. */
export function groupDmFiles(files: readonly DmFile[], now: number): DmFileGroup[] {
  const recent = files.filter((file) => now - file.ts < WEEK_MS)
  const older = files.filter((file) => now - file.ts >= WEEK_MS)
  const groups: DmFileGroup[] = [{ label: 'This week', files: recent }, { label: 'Older', files: older }]
  return groups.filter((group) => group.files.length > 0)
}

/** The largest text file the viewer reads into the page; a bigger one is a card with Download. */
const MAX_READ_BYTES = 1_024 * 1_024
const TEXT_MIME = /^(text\/|application\/(?:[a-z0-9.+-]+\+)?(?:json|xml)$|application\/(?:x-)?(?:yaml|toml|javascript)$)/i

/**
 * How the viewer reads a file as text: `markdown` is rendered, `text` is shown as written.
 * Null for a delivered HTML page, which is drawn instead, and for anything that is not text.
 */
export function dmFileReadsAs(file: DmFile): 'markdown' | 'text' | null {
  if (file.page === true || file.size > MAX_READ_BYTES) return null
  if (file.mime === 'text/markdown' || /\.(md|markdown)$/i.test(file.name)) return 'markdown'
  return TEXT_MIME.test(file.mime) ? 'text' : null
}
