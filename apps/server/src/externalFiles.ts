import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { RepoFileApp } from '@manor/contracts'

const execFileAsync = promisify(execFile)
const APPLICATIONS: Record<RepoFileApp, string> = {
  cursor: 'Cursor.app',
  vscode: 'Visual Studio Code.app',
  windsurf: 'Windsurf.app',
  terminal: 'Utilities/Terminal.app',
  iterm: 'iTerm.app',
  xcode: 'Xcode.app',
  finder: '/System/Library/CoreServices/Finder.app',
}

export interface ExternalFileOpener {
  apps: RepoFileApp[]
  /**
   * Receives an existing, vetted absolute path. A file opens in the app, or for a
   * terminal its folder does, and Finder shows it; a folder opens as itself everywhere.
   */
  open: (app: RepoFileApp, filePath: string, kind?: 'file' | 'folder') => Promise<void>
}

/** Uses the host's installed applications; never executes file content or shell text. */
export function createExternalFileOpener(host: {
  platform?: NodeJS.Platform
  home?: string
  exists?: (candidate: string) => boolean
  run?: (file: string, args: readonly string[]) => Promise<void>
} = {}): ExternalFileOpener | undefined {
  if ((host.platform ?? process.platform) !== 'darwin') return undefined
  const exists = host.exists ?? existsSync
  const roots = ['/Applications', path.join(host.home ?? homedir(), 'Applications'), '/System/Applications']
  const installed = new Map<RepoFileApp, string>()
  for (const app of Object.keys(APPLICATIONS) as RepoFileApp[]) {
    const name = APPLICATIONS[app]
    const candidates = path.isAbsolute(name) ? [name] : roots.map((root) => path.join(root, name))
    const location = candidates.find(exists)
    if (location !== undefined) installed.set(app, location)
  }
  if (installed.size === 0) return undefined
  const run = host.run ?? (async (file: string, args: readonly string[]) => {
    await execFileAsync(file, [...args], { timeout: 5_000 })
  })
  return {
    apps: [...installed.keys()],
    open: async (app, filePath, kind = 'file') => {
      const application = installed.get(app)
      if (application === undefined || !exists(application)) throw new Error('That application is not installed.')
      if (!path.isAbsolute(filePath) || filePath.includes('\0')) throw new Error('An absolute file path is required.')
      if (kind === 'folder') {
        await run('/usr/bin/open', ['-a', application, filePath])
        return
      }
      const target = app === 'terminal' || app === 'iterm' ? path.dirname(filePath) : filePath
      await run('/usr/bin/open', app === 'finder' ? ['-R', target] : ['-a', application, target])
    },
  }
}
