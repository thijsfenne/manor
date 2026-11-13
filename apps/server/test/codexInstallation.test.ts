import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, readFile, utimes } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexInstallation, type CodexRelease } from '../src/drivers/codexInstallation.js'

const temps: string[] = []
const temp = (prefix: string) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix))
  temps.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A Codex package tarball in the release layout, whose `bin/codex` answers `--version`. */
function fakeRelease(version: string): { release: CodexRelease; archive: Buffer } {
  const directory = temp('codex-package-')
  const executable = (name: string, body: string) => {
    mkdirSync(path.dirname(path.join(directory, name)), { recursive: true })
    writeFileSync(path.join(directory, name), body)
    chmodSync(path.join(directory, name), 0o755)
  }
  writeFileSync(path.join(directory, 'codex-package.json'), JSON.stringify({ layoutVersion: 1, version, target: 'aarch64-apple-darwin', entrypoint: 'bin/codex' }))
  executable('bin/codex', `#!/bin/sh\necho "codex-cli ${version}"\n`)
  executable('bin/codex-code-mode-host', '#!/bin/sh\n')
  executable('codex-path/rg', '#!/bin/sh\n')
  const file = path.join(temp('codex-archive-'), 'package.tar.gz')
  execFileSync('tar', ['-czf', file, '-C', directory, 'codex-package.json', 'bin', 'codex-path'])
  const archive = readFileSync(file)
  return { release: { version, sha256: createHash('sha256').update(archive).digest('hex'), bytes: archive.length }, archive }
}

function harness(options: { pinned: string; latest?: string; check?: (command: string) => Promise<{ ok: true } | { ok: false; reason: string }>; timeoutMs?: number; now?: () => number }) {
  const root = temp('codex-tools-')
  const releases = new Map<string, ReturnType<typeof fakeRelease>>()
  const release = (version: string) => {
    if (!releases.has(version)) releases.set(version, fakeRelease(version))
    return releases.get(version)!
  }
  const downloads: string[] = []
  const checked: string[] = []
  const fetchFn = (async (url: string | URL | Request) => {
    const version = /rust-v([\d.]+)\//.exec(String(url))?.[1] ?? ''
    downloads.push(version)
    const found = releases.get(version)
    return found === undefined ? new Response('missing', { status: 404 }) : new Response(new Uint8Array(found.archive))
  }) as typeof fetch
  const installation = new CodexInstallation({
    root,
    pinned: release(options.pinned).release,
    fetchFn,
    latest: async () => (options.latest === undefined ? null : release(options.latest).release),
    check: async (command) => {
      checked.push(command)
      return options.check === undefined ? { ok: true } : options.check(command)
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const pointer = async () => JSON.parse(await readFile(path.join(root, 'active.json'), 'utf8')) as { version: string; previous?: string }
  const versions = async () => (await readdir(root)).filter((entry) => /^\d/.test(entry)).sort()
  return { root, installation, downloads, checked, pointer, versions, release }
}

describe('CodexInstallation', () => {
  it('installs the pinned release once, however many spawns ask at the same time', async () => {
    const { root, installation, downloads, checked, pointer } = harness({ pinned: '1.0.0' })
    const commands = await Promise.all([installation.ensure(), installation.ensure(), installation.ensure()])
    const binary = path.join(root, '1.0.0', 'bin', 'codex')
    expect(commands).toEqual([binary, binary, binary])
    expect(downloads).toEqual(['1.0.0'])
    // The protocol check ran against the placed binary before the pointer named it.
    expect(checked).toEqual([binary])
    expect(await pointer()).toEqual({ version: '1.0.0' })
    expect(execFileSync(binary, ['--version']).toString().trim()).toBe('codex-cli 1.0.0')
    expect(await installation.ensure()).toBe(binary)
    expect(downloads).toHaveLength(1)
  })

  it('swaps the pointer to a checked update and keeps the previous release for rollback', async () => {
    const { root, installation, pointer, versions } = harness({ pinned: '1.0.0', latest: '1.1.0' })
    await installation.ensure()
    expect(await installation.update()).toEqual({ ok: true, version: '1.1.0' })
    expect(await pointer()).toEqual({ version: '1.1.0', previous: '1.0.0' })
    expect((await installation.active())?.command).toBe(path.join(root, '1.1.0', 'bin', 'codex'))
    expect(await versions()).toEqual(['1.0.0', '1.1.0'])
  })

  it('removes a release only a week after it was last active or previous', async () => {
    const day = 24 * 60 * 60_000
    let now = Date.now()
    let latest = '1.1.0'
    const h = harness({ pinned: '1.0.0' })
    const installation = new CodexInstallation({
      root: h.root, pinned: h.release('1.0.0').release, now: () => now,
      fetchFn: (async (url: string | URL | Request) => new Response(new Uint8Array(h.release(/rust-v([\d.]+)\//.exec(String(url))![1]!).archive))) as typeof fetch,
      latest: async () => h.release(latest).release, check: async () => ({ ok: true }),
    })
    await installation.ensure()
    await installation.update()
    now += day
    latest = '1.2.0'
    await installation.update()
    // 1.0.0 retired a day ago; a live session spawned from it may still run its helpers.
    expect(await h.versions()).toEqual(['1.0.0', '1.1.0', '1.2.0'])
    now += 7 * day
    latest = '1.3.0'
    await installation.update()
    expect(await h.pointer()).toEqual({ version: '1.3.0', previous: '1.2.0' })
    expect(await h.versions()).toEqual(['1.2.0', '1.3.0'])
  })

  it('does not let another process prune a cached release while it is being activated', async () => {
    const day = 24 * 60 * 60_000
    let now = Date.now()
    let latest = '1.1.0'
    const h = harness({ pinned: '1.0.0' })
    const fetchFn = (async (url: string | URL | Request) => new Response(new Uint8Array(h.release(/rust-v([\d.]+)\//.exec(String(url))![1]!).archive))) as typeof fetch
    const first = new CodexInstallation({ root: h.root, pinned: h.release('1.0.0').release, now: () => now, fetchFn, latest: async () => h.release(latest).release, check: async () => ({ ok: true }) })
    await first.ensure()
    await first.update()
    now += 8 * day
    // A second Manor process re-activates the retired 1.0.0 and is slow to check it.
    let checking: () => void = () => undefined
    const started = new Promise<void>((resolve) => { checking = resolve })
    let pass: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { pass = resolve })
    const second = new CodexInstallation({
      root: h.root, pinned: h.release('1.0.0').release, now: () => now, fetchFn,
      latest: async () => h.release('1.0.0').release,
      check: async () => { checking(); await gate; return { ok: true } },
    })
    const slow = second.update()
    await started
    latest = '1.2.0'
    await first.update()
    pass()
    expect(await slow).toEqual({ ok: true, version: '1.0.0' })
    expect((await second.active())?.version).toBe('1.0.0')
  })

  it('leaves the old release active when the protocol check fails', async () => {
    const { installation, pointer, versions } = harness({
      pinned: '1.0.0', latest: '1.1.0',
      check: async (command) => (command.includes('1.1.0') ? { ok: false, reason: 'TurnSteerParams.expectedTurnId is missing' } : { ok: true }),
    })
    await installation.ensure()
    expect(await installation.update()).toEqual({
      ok: false, reason: "Codex 1.1.0 fails Manor's protocol check: TurnSteerParams.expectedTurnId is missing, kept 1.0.0.",
    })
    expect(await pointer()).toEqual({ version: '1.0.0' })
    // Only the pointer decides what runs; the rejected folder retires like any other.
    expect((await installation.active())?.version).toBe('1.0.0')
    expect(await versions()).toEqual(['1.0.0', '1.1.0'])
  })

  it('leaves the old release active when the update times out', async () => {
    const { installation, pointer } = harness({
      pinned: '1.0.0', latest: '1.1.0', timeoutMs: 2_000,
      check: async (command) => {
        if (command.includes('1.1.0')) await new Promise((resolve) => setTimeout(resolve, 2_100))
        return { ok: true }
      },
    })
    await installation.ensure()
    expect(await installation.update()).toEqual({ ok: false, reason: 'Codex 1.1.0 timed out, kept 1.0.0.' })
    expect(await pointer()).toEqual({ version: '1.0.0' })
  })

  it('installs nothing from a download that fails its SHA-256 check', async () => {
    const h = harness({ pinned: '1.0.0' })
    const installation = new CodexInstallation({
      root: h.root, pinned: { ...h.release('1.0.0').release, sha256: '0'.repeat(64) },
      fetchFn: (async () => new Response(new Uint8Array(h.release('1.0.0').archive))) as typeof fetch,
      check: async () => ({ ok: true }),
    })
    await expect(installation.ensure()).rejects.toThrow('Codex 1.0.0 failed its SHA-256 check.')
    expect(await installation.active()).toBeNull()
    expect(await readdir(h.root)).toEqual([])
  })

  it('replaces an active release older than the pinned one', async () => {
    const old = harness({ pinned: '0.9.0' })
    await old.installation.ensure()
    const pinned = old.release('1.0.0').release
    const installation = new CodexInstallation({
      root: old.root, pinned,
      fetchFn: (async () => new Response(new Uint8Array(old.release('1.0.0').archive))) as typeof fetch,
      check: async () => ({ ok: true }),
    })
    expect(await installation.active()).toBeNull()
    expect(await installation.ensure()).toBe(path.join(old.root, '1.0.0', 'bin', 'codex'))
    expect(await old.pointer()).toEqual({ version: '1.0.0', previous: '0.9.0' })
  })

  it('removes staging folders a crashed install left a day ago, and only those', async () => {
    const now = Date.now()
    const { root, installation } = harness({ pinned: '1.0.0', now: () => now })
    mkdirSync(path.join(root, '.install-stale'), { recursive: true })
    mkdirSync(path.join(root, '.install-running'))
    writeFileSync(path.join(root, '.active-stale.json'), '{}')
    const dayAgo = new Date(now - 25 * 60 * 60_000)
    await utimes(path.join(root, '.install-stale'), dayAgo, dayAgo)
    await utimes(path.join(root, '.active-stale.json'), dayAgo, dayAgo)
    await installation.cleanStaging()
    expect((await readdir(root)).sort()).toEqual(['.install-running'])
  })
})
