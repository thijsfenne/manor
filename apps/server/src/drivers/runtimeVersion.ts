import { execFile } from 'node:child_process'
import path from 'node:path'
import { childProcessEnv } from '../childEnv.js'

export async function runtimeVersion(command: string): Promise<{ command: string; version: string | null }> {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 5_000, maxBuffer: 8_192, env: childProcessEnv() }, (error, stdout) => {
      // Keep only the version token, never arbitrary subprocess output or stderr.
      const version = error === null ? stdout.match(/\b\d[\w-]*(?:\.[\w+-]+)+\b/)?.[0] ?? null : null
      resolve({ command: path.basename(command), version })
    })
  })
}
