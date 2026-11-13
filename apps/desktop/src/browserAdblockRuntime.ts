import path from 'node:path'
import { ElectronBlocker } from '@ghostery/adblocker-electron'
import { utilityProcess } from 'electron'
import type { AdblockEngine } from './browserAdblock'

/** Ghostery's frame preload: asks the main process for element-hiding rules per page. */
export const ADBLOCK_PRELOAD_PATH = require.resolve('@ghostery/adblocker-electron-preload')

export function loadAdblockEngine(bytes: Uint8Array): AdblockEngine {
  return ElectronBlocker.deserialize(bytes)
}

/** Fetches and parses the filter lists in a utility process; see `browserAdblockWorker.ts`. */
export function buildAdblockEngine(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(path.join(__dirname, 'browserAdblockWorker.js'), [file], {
      serviceName: 'Manor ad block lists',
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2_000) })
    const timeout = setTimeout(() => child.kill(), 3 * 60_000)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `The list builder exited with code ${code}.`))
    })
  })
}
