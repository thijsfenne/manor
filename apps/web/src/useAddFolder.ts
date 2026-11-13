import { useEffect, useRef, useState } from 'react'
import { desktopChooseFolder } from './desktopBrowser'
import type { Manor } from './useWorkspace'

/**
 * Add folder on the new-Session stage (2026-11-13): a folder to work in, with no
 * project thread. The desktop opens Finder straight away; plain web walks the
 * server's folders in a dialog, because a browser cannot hand out an absolute path.
 */
export function useAddFolder(
  manor: Pick<Manor, 'addFolder' | 'listDirs' | 'closeDirs'>,
  onAdded: (projectId: string) => void,
) {
  const [browsing, setBrowsing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Stops a double click racing the first Finder sheet or a second add.
  const working = useRef(false)
  // Cancel and unmount end the opening: whatever lands later, from Finder or from
  // Manor, moves no draft and releases nothing a newer opening holds.
  const opening = useRef(0)
  useEffect(() => () => {
    opening.current += 1
  }, [])

  const addIn = async (current: number, path: string) => {
    if (working.current) return
    working.current = true
    setBusy(true)
    setError(null)
    try {
      const projectId = await manor.addFolder(path)
      if (opening.current !== current) return
      setBrowsing(false)
      manor.closeDirs()
      onAdded(projectId)
    } catch (failure) {
      if (opening.current !== current) return
      // Finder has no place to say it, so the dialog opens on the refusal.
      setError(failure instanceof Error ? failure.message : 'That folder could not be added.')
      setBrowsing(true)
    } finally {
      if (opening.current === current) {
        working.current = false
        setBusy(false)
      }
    }
  }

  const start = async () => {
    if (working.current) return
    const current = opening.current
    const choose = desktopChooseFolder()
    if (choose === undefined) {
      setError(null)
      setBrowsing(true)
      manor.listDirs()
      return
    }
    working.current = true
    let path: string | null = null
    try {
      path = await choose()
    } catch {
      if (opening.current !== current) return
      // The sheet could not open; the server's folder browser is the way in instead.
      setBrowsing(true)
      manor.listDirs()
    } finally {
      if (opening.current === current) working.current = false
    }
    if (path !== null && opening.current === current) await addIn(current, path)
  }

  const cancel = () => {
    opening.current += 1
    working.current = false
    setBusy(false)
    setBrowsing(false)
    setError(null)
    manor.closeDirs()
  }

  return { browsing, busy, error, start, add: (path: string) => addIn(opening.current, path), cancel, listDirs: manor.listDirs }
}
