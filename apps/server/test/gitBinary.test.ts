import { describe, expect, it } from 'vitest'
import { createGitBinary, type GitBinaryHost } from '../src/gitBinary.js'

const XCODE_GIT = '/Applications/Xcode.app/Contents/Developer/usr/bin/git'

function setup(options: { gitOnPath?: string; xcrun?: string; platform?: NodeJS.Platform; path?: string } = {}) {
  const files = new Set([options.gitOnPath ?? '/usr/bin/git', ...(options.xcrun === undefined ? [] : [options.xcrun])])
  const state = { xcrun: options.xcrun as string | undefined, xcrunCalls: 0, now: 0 }
  const host: GitBinaryHost = {
    platform: options.platform ?? 'darwin',
    env: { PATH: options.path ?? `${(options.gitOnPath ?? '/usr/bin/git').replace(/\/git$/, '')}:/fake/bin` },
    now: () => state.now,
    isFile: (file) => files.has(file),
    xcrunFindGit: () => { state.xcrunCalls += 1; return state.xcrun },
  }
  return { files, state, gitBinary: createGitBinary(host) }
}

describe('gitBinary', () => {
  it('runs the git behind the xcrun shim and looks it up once', () => {
    const { state, gitBinary } = setup({ xcrun: XCODE_GIT })
    expect(gitBinary()).toBe(XCODE_GIT)
    expect(gitBinary()).toBe(XCODE_GIT)
    expect(state.xcrunCalls).toBe(1)
  })

  it('keeps git when another git is first on PATH or the host is not macOS', () => {
    const homebrew = setup({ gitOnPath: '/opt/homebrew/bin/git', xcrun: XCODE_GIT })
    expect(homebrew.gitBinary()).toBe('git')
    expect(homebrew.state.xcrunCalls).toBe(0)
    expect(setup({ platform: 'linux', xcrun: XCODE_GIT }).gitBinary()).toBe('git')
  })

  it('skips empty and relative PATH entries, as a pnpm-started dev server carries one', () => {
    const { gitBinary } = setup({ xcrun: XCODE_GIT, path: './node_modules/.bin::/usr/bin' })
    expect(gitBinary()).toBe(XCODE_GIT)
  })

  it('keeps git when xcrun fails or names a missing file, and retries only after the TTL', () => {
    const failed = setup()
    expect(failed.gitBinary()).toBe('git')
    expect(failed.gitBinary()).toBe('git')
    expect(failed.state.xcrunCalls).toBe(1)
    failed.state.xcrun = XCODE_GIT
    failed.files.add(XCODE_GIT)
    failed.state.now = 31_000
    expect(failed.gitBinary()).toBe(XCODE_GIT)

    const missing = setup({ xcrun: XCODE_GIT })
    missing.files.delete(XCODE_GIT)
    expect(missing.gitBinary()).toBe('git')
  })

  it('looks again when the resolved git disappears', () => {
    const beta = '/Applications/Xcode-beta.app/Contents/Developer/usr/bin/git'
    const { files, state, gitBinary } = setup({ xcrun: XCODE_GIT })
    expect(gitBinary()).toBe(XCODE_GIT)
    files.delete(XCODE_GIT)
    files.add(beta)
    state.xcrun = beta
    expect(gitBinary()).toBe(beta)
    expect(state.xcrunCalls).toBe(2)
  })
})
