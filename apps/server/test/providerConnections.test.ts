import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Driver, ProviderAccount, ServerMessage } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { resolveCursorCommand } from '../src/drivers/cursorDriver.js'
import { parseClaudeAccount, parseCodexAccount, parseCursorAccount } from '../src/drivers/providerAccount.js'
import { connectionState, ProviderConnectionService, type SignInProcess } from '../src/providerConnections.js'

const turn = () => { throw new Error('no turns here') }

/** A provider CLI as the service sees it: a version, a login, and a sign-in the test finishes by hand. */
function fixture(start: { version: string | null; account: ProviderAccount }) {
  const cli = { ...start }
  const sent: ServerMessage[] = []
  const exits: ((code: number | null) => void)[] = []
  let stopped = 0
  const driver: Driver = {
    startTurn: turn,
    describeRuntime: () => Promise.resolve({ command: 'claude', version: cli.version }),
    describeAccount: () => Promise.resolve(cli.account),
    signInCommand: () => Promise.resolve({ command: 'claude', args: ['auth', 'login'], env: {} }),
    installCommand: () => Promise.resolve({ command: '/bin/bash', args: ['-c', 'install'], env: {} }),
  }
  const service = new ProviderConnectionService({
    drivers: { claude: driver },
    broadcast: (message) => sent.push(message),
    startSignIn: (): SignInProcess => ({ onExit: (listener) => exits.push(listener), stop: () => { stopped += 1 } }),
  })
  const row = () => service.message().providers[0]
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  return { cli, sent, service, row, settle, exit: (code: number | null) => exits.shift()?.(code), stopped: () => stopped }
}

describe('provider connections', () => {
  it('puts not installed first, then a sign-in under way, then what the CLI said', () => {
    expect(connectionState({ installed: false, signedIn: true, signingIn: true })).toBe('install')
    expect(connectionState({ installed: true, signedIn: false, signingIn: true })).toBe('signing_in')
    expect(connectionState({ installed: true, signedIn: true, signingIn: false })).toBe('ready')
    expect(connectionState({ installed: true, signedIn: false, signingIn: false })).toBe('sign_in')
    expect(connectionState({ installed: true, signedIn: null, signingIn: false })).toBe('attention')
  })

  it('reports a missing CLI without asking about its login, and a silent one as needing attention', async () => {
    const missing = fixture({ version: null, account: { signedIn: true } })
    await missing.service.check()
    expect(missing.row()).toMatchObject({ state: 'install', installed: false, signedIn: null, canSignIn: false })

    const silent = fixture({ version: '2.1.0', account: { signedIn: null } })
    await silent.service.check()
    expect(silent.row()).toMatchObject({ state: 'attention', message: expect.stringContaining('Claude Code') })
  })

  it('offers a side job to a provider that is ready, silent or not asked yet, and not to one that is out', async () => {
    const unasked = fixture({ version: '2.1.0', account: { signedIn: false } })
    expect(unasked.service.usable()).toEqual(['claude'])
    await unasked.service.check()
    expect(unasked.service.usable()).toEqual([])

    for (const account of [{ signedIn: true }, { signedIn: null }]) {
      const able = fixture({ version: '2.1.0', account })
      await able.service.check()
      expect(able.service.usable()).toEqual(['claude'])
    }
    const missing = fixture({ version: null, account: { signedIn: true } })
    await missing.service.check()
    expect(missing.service.usable()).toEqual([])
  })

  it('keeps the newest answer when an older check answers last', async () => {
    const answers: ((account: ProviderAccount) => void)[] = []
    const sent: ServerMessage[] = []
    const driver: Driver = {
      startTurn: turn,
      describeRuntime: () => Promise.resolve({ command: 'claude', version: '2.1.0' }),
      describeAccount: () => new Promise((resolve) => { answers.push(resolve) }),
      signInCommand: () => Promise.resolve({ command: 'claude', args: ['auth', 'login'], env: {} }),
    }
    const exits: ((code: number | null) => void)[] = []
    const service = new ProviderConnectionService({
      drivers: { claude: driver },
      broadcast: (message) => sent.push(message),
      startSignIn: (): SignInProcess => ({ onExit: (listener) => exits.push(listener), stop: () => undefined }),
    })
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

    // A check begins while the user is still signing in, and reads the old state late.
    const check = service.check()
    await settle()
    const signIn = service.signIn('claude')
    await settle()
    exits.shift()?.(0)
    await settle()
    expect(answers).toHaveLength(3)
    // The probe after the sign-in answers first, the two older ones after it.
    answers[2]?.({ signedIn: true })
    await settle()
    answers[1]?.({ signedIn: false })
    answers[0]?.({ signedIn: false })
    await Promise.all([check, signIn])
    expect(service.message().providers[0]).toMatchObject({ state: 'ready', signedIn: true })
  })

  it('signs in through the provider command and becomes ready once the CLI says so', async () => {
    const house = fixture({ version: '2.1.0', account: { signedIn: false } })
    await house.service.check()
    expect(house.row()).toMatchObject({ state: 'sign_in', canSignIn: true })

    await house.service.signIn('claude')
    await house.service.signIn('claude')
    expect(house.row()?.state).toBe('signing_in')

    house.cli.account = { signedIn: true, account: 'someone@example.invalid', plan: 'max' }
    house.exit(0)
    await house.settle()
    expect(house.row()).toMatchObject({ state: 'ready', account: 'someone@example.invalid', plan: 'max' })
    expect(house.row()?.message).toBeUndefined()
    expect(house.sent.at(-1)).toEqual(house.service.message())
  })

  it('says so when the sign-in ended without a login, and clears that on the next try', async () => {
    const house = fixture({ version: '2.1.0', account: { signedIn: false } })
    await house.service.signIn('claude')
    house.service.cancel('claude')
    expect(house.stopped()).toBe(1)
    house.exit(null)
    await house.settle()
    expect(house.row()).toMatchObject({ state: 'sign_in', message: 'Sign in did not finish. Try again.' })

    await house.service.signIn('claude')
    expect(house.row()?.message).toBeUndefined()
  })
})

describe('installing a missing CLI', () => {
  it('runs the installer on request and reads the result from the CLI', async () => {
    const house = fixture({ version: null, account: { signedIn: false } })
    await house.service.check()
    expect(house.row()).toMatchObject({ state: 'install', canInstall: true, canSignIn: false })

    await house.service.install('claude')
    expect(house.row()).toMatchObject({ state: 'installing' })
    // A second click while it runs starts nothing.
    await house.service.install('claude')

    house.cli.version = '2.1.0'
    house.exit(0)
    await house.settle()
    expect(house.row()).toMatchObject({ state: 'sign_in', installed: true, canInstall: false, canSignIn: true })
    expect(house.exit(0)).toBeUndefined()
  })

  it('says so when the installer ended without a CLI, and can be stopped', async () => {
    const house = fixture({ version: null, account: { signedIn: false } })
    await house.service.install('claude')
    house.service.cancel('claude')
    expect(house.stopped()).toBe(1)
    house.exit(null)
    await house.settle()
    expect(house.row()).toMatchObject({ state: 'install', message: expect.stringContaining('did not install') })
  })

  it('does not install a CLI that is already there', async () => {
    const house = fixture({ version: '2.1.0', account: { signedIn: true } })
    await house.service.install('claude')
    expect(house.row()).toMatchObject({ state: 'ready' })
    expect(house.exit(0)).toBeUndefined()
  })
})

describe('what each CLI says about its login', () => {
  it('reads Claude', () => {
    expect(parseClaudeAccount({ code: 0, text: '{"loggedIn":true,"email":"a@example.invalid","subscriptionType":"max"}' }))
      .toEqual({ signedIn: true, account: 'a@example.invalid', plan: 'max' })
    expect(parseClaudeAccount({ code: 1, text: '{"loggedIn":false}' })).toEqual({ signedIn: false })
    expect(parseClaudeAccount({ code: 0, text: 'not json' })).toEqual({ signedIn: null })
    expect(parseClaudeAccount(null)).toEqual({ signedIn: null })
  })

  it('reads Codex', () => {
    expect(parseCodexAccount({ code: 0, text: 'Logged in using ChatGPT\n' })).toEqual({ signedIn: true, plan: 'ChatGPT' })
    expect(parseCodexAccount({ code: 1, text: 'Not logged in\n' })).toEqual({ signedIn: false })
    expect(parseCodexAccount({ code: 2, text: 'error: unexpected argument' })).toEqual({ signedIn: null })
  })

  it('reads Cursor through its colour codes', () => {
    expect(parseCursorAccount({ code: 0, text: '\u001b[32m✓ Logged in as a@example.invalid\u001b[0m\n' })).toEqual({ signedIn: true, account: 'a@example.invalid' })
    expect(parseCursorAccount({ code: 1, text: 'Not logged in' })).toEqual({ signedIn: false })
    expect(parseCursorAccount(null)).toEqual({ signedIn: null })
  })
})

describe('finding the Cursor CLI', () => {
  it('prefers cursor-agent over an `agent` that another tool put first on PATH', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-cursor-path-'))
    const put = (dir: string, name: string) => {
      const file = path.join(root, dir, name)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 })
      return file
    }
    put('other', 'agent')
    const cursorAgent = put('cursor', 'cursor-agent')
    const cursorAlias = put('cursor', 'agent')
    const env = (dirs: string[]) => ({ HOME: path.join(root, 'home'), PATH: dirs.map((dir) => path.join(root, dir)).join(path.delimiter) })

    expect(resolveCursorCommand(env(['other', 'cursor']))).toBe(cursorAgent)
    rmSync(cursorAgent)
    expect(resolveCursorCommand(env(['cursor']))).toBe(cursorAlias)
    rmSync(root, { recursive: true, force: true })
  })
})
