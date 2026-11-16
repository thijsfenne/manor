import type { DmFile } from '@manor/contracts'
import { desktopFiles } from './desktopBrowser'

/**
 * Saves a file from a DM's library. The Mac asks where through its own dialog; a
 * browser tab downloads the signed link. Resolves to what went wrong, or null.
 */
export async function saveDmFile(file: DmFile): Promise<string | null> {
  if (file.src === undefined) return 'This file is no longer available in Manor.'
  const bridge = desktopFiles()
  if (bridge === undefined) {
    const link = document.createElement('a')
    link.href = `${file.src}?download=1`
    link.download = file.name
    link.click()
    return null
  }
  try {
    const result = await bridge.save(file.src, file.name)
    return result.ok ? null : result.error
  } catch {
    return 'Manor could not reach the desktop shell for this file.'
  }
}
