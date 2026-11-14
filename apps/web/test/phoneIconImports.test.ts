import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const BARREL = /from\s+['"]@hugeicons\/core-free-icons['"]/
const repo = path.resolve(import.meta.dirname, '../../..')

/** Every source file under `dir`, tests left out. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(file)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [file] : []
  })
}

describe('HugeIcons imports the phone bundles', () => {
  // Metro does not tree shake: one import from the package's barrel pulls all 6,000
  // icons into the phone bundle and runs them at start. The web build rewrites such an
  // import itself (`hugeiconsDeepImports`); the phone and the shared runtime it bundles
  // name the icon's own file, `@hugeicons/core-free-icons/Search01Icon`. This test sits
  // with the web tests because the phone package has no Node types to read files with.
  it('names one icon file per import, never the barrel', () => {
    const roots = [path.join(repo, 'apps/mobile/src'), path.join(repo, 'packages/client-runtime/src')]
    const offenders = roots.flatMap(sources).filter((file) => BARREL.test(readFileSync(file, 'utf8'))).map((file) => path.relative(repo, file))
    expect(offenders).toEqual([])
  })
})
