import { describe, expect, it, vi } from 'vitest'
import { createExternalFileOpener } from '../src/externalFiles.js'

describe('external file applications', () => {
  it('advertises only installed apps on macOS, including user and system applications', () => {
    expect(createExternalFileOpener({ platform: 'linux', exists: () => true })).toBeUndefined()
    expect(createExternalFileOpener({ platform: 'darwin', exists: () => false })).toBeUndefined()
    const installed = new Set([
      '/Users/test/Applications/Cursor.app',
      '/System/Applications/Utilities/Terminal.app',
      '/System/Library/CoreServices/Finder.app',
    ])
    expect(createExternalFileOpener({
      platform: 'darwin', home: '/Users/test', exists: (candidate) => installed.has(candidate),
    })?.apps).toEqual(['cursor', 'terminal', 'finder'])
  })

  it('opens files in editors, containing folders in terminals and reveals files in Finder', async () => {
    const run = vi.fn(async () => undefined)
    const opener = createExternalFileOpener({ platform: 'darwin', exists: () => true, run })!
    const file = '/tmp/project with spaces/$(touch nope); file.ts'
    for (const app of opener.apps) await opener.open(app, file)
    expect(run.mock.calls).toEqual([
      ['/usr/bin/open', ['-a', '/Applications/Cursor.app', file]],
      ['/usr/bin/open', ['-a', '/Applications/Visual Studio Code.app', file]],
      ['/usr/bin/open', ['-a', '/Applications/Windsurf.app', file]],
      ['/usr/bin/open', ['-a', '/Applications/Utilities/Terminal.app', '/tmp/project with spaces']],
      ['/usr/bin/open', ['-a', '/Applications/iTerm.app', '/tmp/project with spaces']],
      ['/usr/bin/open', ['-a', '/Applications/Xcode.app', file]],
      ['/usr/bin/open', ['-R', file]],
    ])
  })

  it('opens a folder as itself in every app, Finder and terminals included', async () => {
    const run = vi.fn(async () => undefined)
    const opener = createExternalFileOpener({ platform: 'darwin', exists: () => true, run })!
    await opener.open('finder', '/tmp/repo', 'folder')
    await opener.open('terminal', '/tmp/repo', 'folder')
    expect(run.mock.calls).toEqual([
      ['/usr/bin/open', ['-a', '/System/Library/CoreServices/Finder.app', '/tmp/repo']],
      ['/usr/bin/open', ['-a', '/Applications/Utilities/Terminal.app', '/tmp/repo']],
    ])
  })

  it('refuses unavailable apps and relative paths and reports launch failures', async () => {
    const run = vi.fn(async () => { throw new Error('Launch failed') })
    const installed = new Set(['/Applications/Cursor.app'])
    const opener = createExternalFileOpener({ platform: 'darwin', exists: (p) => installed.has(p), run })!
    await expect(opener.open('vscode', '/tmp/file.ts')).rejects.toThrow('not installed')
    await expect(opener.open('cursor', '-bad.ts')).rejects.toThrow('absolute file path')
    expect(run).not.toHaveBeenCalled()
    await expect(opener.open('cursor', '/tmp/file.ts')).rejects.toThrow('Launch failed')
    installed.clear()
    await expect(opener.open('cursor', '/tmp/file.ts')).rejects.toThrow('not installed')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
