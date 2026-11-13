import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DIA_BUNDLE_ID = 'company.thebrowser.dia'

type Run = (file: string, args: readonly string[]) => Promise<void>

export interface ExternalLinkOpener {
  browser: 'dia'
  open: (url: string) => Promise<void>
}

export interface ExternalLinkHost {
  platform?: NodeJS.Platform
  home?: string
  exists?: (candidate: string) => boolean
  run?: Run
}

/**
 * Makes the local Mac shell capability explicit. A VPS gets no opener and the web
 * client keeps its ordinary anchor behaviour; Manor never tries to open a browser
 * on the wrong machine.
 */
export function createExternalLinkOpener(host: ExternalLinkHost = {}): ExternalLinkOpener | undefined {
  const platform = host.platform ?? process.platform
  const home = host.home ?? homedir()
  const exists = host.exists ?? existsSync
  if (
    platform !== 'darwin' ||
    !['/Applications/Dia.app', path.join(home, 'Applications/Dia.app')].some(exists)
  ) {
    return undefined
  }

  const run: Run =
    host.run ??
    (async (file, args) => {
      await execFileAsync(file, [...args])
    })

  return {
    browser: 'dia',
    open: async (raw) => {
      const url = new URL(raw)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Only website links can be opened externally.')
      }
      // Arguments stay separate from the executable. A URL from model output is
      // untrusted text even though the user still has to click it.
      await run('/usr/bin/open', ['-b', DIA_BUNDLE_ID, url.href])
    },
  }
}
