import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTailscaleRunner, createTailscaleServe, type TailscaleRun } from '../src/tailscale.js'

const PORT = 43179
const TARGET = `http://127.0.0.1:${PORT}`
const ok = (stdout: unknown): TailscaleRun => ({ code: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '' })
const running = ok({ BackendState: 'Running', Self: { DNSName: 'mac.example.ts.net.', CapMap: { https: null } } })
const serving = ok({ Web: { 'mac.example.ts.net:443': { Handlers: { '/': { Proxy: TARGET } } } } })

/** A fake CLI: answers by subcommand, and serve changes flip what `serve status` reports. */
function fakeCli(start: { status: TailscaleRun; serve?: TailscaleRun }) {
  const calls: string[][] = []
  let serve = start.serve ?? ok('null')
  const run = (args: readonly string[]): Promise<TailscaleRun> => {
    calls.push([...args])
    if (start.status === 'missing') return Promise.resolve('missing')
    if (args[0] === 'status') return Promise.resolve(start.status)
    if (args[1] === 'status') return Promise.resolve(serve)
    if (args.includes('--bg')) serve = serving
    else if (args.at(-1) === 'off') serve = ok('{}')
    return Promise.resolve(ok(''))
  }
  return { calls, tailscale: createTailscaleServe({ run, port: PORT }) }
}

describe('Tailscale HTTPS', () => {
  it('turns on with Manor\'s own mapping and off by removing exactly that one', async () => {
    const { calls, tailscale } = fakeCli({ status: running })

    expect(await tailscale.status()).toEqual({ state: 'ready', address: 'https://mac.example.ts.net', serving: false })
    expect(await tailscale.setServing(true)).toEqual({ state: 'ready', address: 'https://mac.example.ts.net', serving: true })
    expect(calls).toContainEqual(['serve', '--bg', '--https=443', TARGET])
    expect(await tailscale.setServing(false)).toEqual({ state: 'ready', address: 'https://mac.example.ts.net', serving: false })
    expect(calls).toContainEqual(['serve', '--https=443', '--set-path=/', 'off'])
    expect(calls.flat()).not.toContain('funnel')
  })

  it('says the CLI is missing, without running anything else', async () => {
    const { tailscale } = fakeCli({ status: 'missing' })
    expect(await tailscale.status()).toEqual({ state: 'missing' })
    expect(await tailscale.setServing(true)).toEqual({ state: 'missing' })
  })

  it('says Tailscale is not signed in, from the backend state or the CLI\'s complaint', async () => {
    expect(await fakeCli({ status: ok({ BackendState: 'NeedsLogin' }) }).tailscale.setServing(true)).toEqual({ state: 'logged_out' })
    expect(await fakeCli({ status: { code: 1, stdout: '', stderr: 'Logged out.' } }).tailscale.status()).toEqual({ state: 'logged_out' })
  })

  it('says Tailscale is turned off', async () => {
    expect(await fakeCli({ status: ok({ BackendState: 'Stopped' }) }).tailscale.status()).toEqual({ state: 'stopped' })
  })

  it('asks for MagicDNS and HTTPS certificates when the tailnet lacks them', async () => {
    const noCert = ok({ BackendState: 'Running', Self: { DNSName: 'mac.example.ts.net.', CapMap: {} } })
    const { calls, tailscale } = fakeCli({ status: noCert })
    expect(await tailscale.setServing(true)).toEqual({ state: 'no_https', serving: false })
    expect(calls.some((args) => args.includes('--bg'))).toBe(false)
    expect(await fakeCli({ status: ok({ BackendState: 'Running', Self: {} }) }).tailscale.status()).toEqual({ state: 'no_https', serving: false })
    const noMagicDns = ok({ BackendState: 'Running', CurrentTailnet: { MagicDNSEnabled: false }, Self: { DNSName: 'mac.example.ts.net.', CapMap: { https: null } } })
    expect(await fakeCli({ status: noMagicDns }).tailscale.status()).toEqual({ state: 'no_https', serving: false })
  })

  it('still removes Manor\'s mapping after MagicDNS or HTTPS went away', async () => {
    const noMagicDns = ok({ BackendState: 'Running', CurrentTailnet: { MagicDNSEnabled: false }, Self: { DNSName: 'mac.example.ts.net.', CapMap: { https: null } } })
    const { calls, tailscale } = fakeCli({ status: noMagicDns, serve: serving })
    expect(await tailscale.status()).toEqual({ state: 'no_https', serving: true })
    expect(await tailscale.setServing(false)).toEqual({ state: 'no_https', serving: false })
    expect(calls).toContainEqual(['serve', '--https=443', '--set-path=/', 'off'])

    const funnel = ok({ AllowFunnel: { 'mac.example.ts.net:443': true }, Web: { 'mac.example.ts.net:443': { Handlers: { '/': { Proxy: TARGET } } } } })
    const withFunnel = fakeCli({ status: noMagicDns, serve: funnel })
    expect(await withFunnel.tailscale.setServing(false)).toEqual({ state: 'conflict', address: 'https://mac.example.ts.net', funnel: true })
    expect(withFunnel.calls.some((args) => args.at(-1) === 'off')).toBe(false)
  })

  it('leaves another mapping on port 443 alone, and refuses while Funnel is on', async () => {
    const other = ok({ Web: { 'mac.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } })
    const funnel = ok({ AllowFunnel: { 'mac.example.ts.net:443': true }, Web: { 'mac.example.ts.net:443': { Handlers: { '/': { Proxy: TARGET } } } } })

    const taken = fakeCli({ status: running, serve: other })
    expect(await taken.tailscale.setServing(true)).toEqual({ state: 'conflict', address: 'https://mac.example.ts.net', funnel: false })
    expect(await taken.tailscale.setServing(false)).toEqual({ state: 'conflict', address: 'https://mac.example.ts.net', funnel: false })
    expect(taken.calls.some((args) => args.includes('--bg') || args.at(-1) === 'off')).toBe(false)

    expect(await fakeCli({ status: running, serve: funnel }).tailscale.status()).toEqual({ state: 'conflict', address: 'https://mac.example.ts.net', funnel: true })
  })

  it('never puts the CLI\'s own words in the message it shows', async () => {
    const leaky = fakeCli({ status: { code: 1, stdout: '', stderr: 'error tskey-auth-SECRET for mac.example.ts.net' } })
    const status = await leaky.tailscale.status()
    expect(JSON.stringify(status)).not.toContain('tskey')
    expect(status.state).toBe('error')
  })

  it('runs the Mac app\'s binary as the CLI, so it answers in JSON instead of starting its GUI', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'manor-tailscale-'))
    try {
      // Stands in for the app binary: without the switch it prints a GUI error and exits 0.
      const cli = path.join(dir, 'tailscale')
      writeFileSync(cli, '#!/bin/sh\nif [ "$TAILSCALE_BE_CLI" = 1 ]; then echo \'{"BackendState":"Stopped"}\'; else echo "The Tailscale GUI failed to start"; fi\n')
      chmodSync(cli, 0o755)
      const tailscale = createTailscaleServe({ run: createTailscaleRunner({ PATH: dir, HOME: dir }), port: PORT })
      expect(await tailscale.status()).toEqual({ state: 'stopped' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('says it cannot read an answer that is not JSON, without repeating it', async () => {
    const gui = ok('The Tailscale GUI failed to start: (Tailscale.CLIError error 3.)')
    expect(await fakeCli({ status: gui }).tailscale.status()).toEqual({ state: 'error', message: 'Tailscale answered with something Manor cannot read.' })
  })
})
