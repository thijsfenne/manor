import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The folder that holds the server's own read-only files: the SQL migrations, the
 * default Auto rules, the compiled connector servers. Run from source it is the
 * package folder. In a bundle (`scripts/build-bundle.mjs`) the one entry file sits in
 * `<bundle>/dist`, so the same "one folder up" lands on the bundle's root. Every file
 * lookup goes through here: a module that resolved against its own location would
 * point somewhere else once the bundler folded it into the entry file.
 */
export const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

/** A path inside the server's own files. */
export const serverFile = (...parts: string[]): string => path.join(SERVER_ROOT, ...parts)

/** What the bundle was built from. Absent when the server runs from source. */
export interface BuildInfo {
  version: string
  commit: string
}

/**
 * Written by the bundle build next to the entry file. Its presence is what "bundled"
 * means: the server's folder is then read-only and part of an app, so nothing may be
 * written beside it and there is no checkout to ask git about.
 */
export function readBuildInfo(root: string = SERVER_ROOT): BuildInfo | undefined {
  const file = path.join(root, 'build-info.json')
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<BuildInfo>
    return { version: String(parsed.version ?? 'unknown'), commit: String(parsed.commit ?? 'unknown') }
  } catch {
    return { version: 'unknown', commit: 'unknown' }
  }
}
