import type { AgentConfig } from '@manor/contracts'
import { dirname, singleRootDir } from '@manor/client-runtime/file-tree'
import type { RepoFilePreview, RepoFiles } from '@manor/client-runtime/state'
import { useEffect, useRef, useState } from 'react'

import { FileBrowser, ROOT_PLACE, placeBehind, placeTitles, type BrowserPlace } from '@/components/FileBrowser'
import { Sheet } from '@/components/Sheet'

interface FilesSheetProps {
  open: boolean
  onClose: () => void
  projectName: string
  /** Undefined until the listing lands; the sheet says it is loading rather than empty. */
  files: RepoFiles | undefined
  preview: RepoFilePreview | undefined
  /** False while the socket is down, which is the one reason nothing can load. */
  live: boolean
  agents: AgentConfig[]
  onList: () => void
  onRead: (path: string) => void
  /** A file link in the transcript may open the sheet directly at this listed path. */
  targetPath?: string | null
}

/**
 * The project's linked folders, as the Mac's files panel lists them, in the house
 * sheet: walked folder by folder, and behind any file the file as it stands now.
 */
export function FilesSheet({ open, onClose, projectName, files, preview, live, agents, onList, onRead, targetPath }: FilesSheetProps) {
  const [place, setPlace] = useState<BrowserPlace>(() => targetPath == null
    ? ROOT_PLACE
    : { dir: dirname(targetPath), file: targetPath })

  // Opening the sheet is what asks for the listing, so the same ref rule as the
  // browser's read: the handler's identity changes with every render of the screen
  // above, and one `git ls-files` per render is a request storm nobody asked for.
  const askList = useRef(onList)
  useEffect(() => {
    askList.current = onList
  }, [onList])
  useEffect(() => {
    if (open && live) askList.current()
  }, [live, open])
  const rootDir = singleRootDir(files?.files ?? [])
  const visiblePlace = place.dir === '' && place.file === null && rootDir !== ''
    ? { dir: rootDir, file: null }
    : place
  const behind = placeBehind(visiblePlace, rootDir)
  const close = () => {
    setPlace(ROOT_PLACE)
    onClose()
  }
  const { title, subtitle } = placeTitles(visiblePlace, 'Files', projectName, rootDir)

  return (
    <Sheet
      onClose={close}
      onBack={behind === null ? undefined : () => setPlace(behind)}
      open={open}
      subtitle={subtitle}
      title={title}
    >
      <FileBrowser
        agents={agents}
        emptyText="No files in this project's linked folders."
        files={files?.files ?? null}
        live={live}
        onPlace={setPlace}
        onRead={onRead}
        place={visiblePlace}
        preview={preview === undefined ? null : { path: preview.path, result: preview.result }}
        truncated={files?.truncated ?? false}
      />
    </Sheet>
  )
}
