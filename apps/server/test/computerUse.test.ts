import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from '@manor/contracts'
import { EFFECT_CALL_LIMIT, EffectBroker } from '../src/effectBroker.js'
import { EffectCapabilities } from '../src/effectCapability.js'
import { CODEX_COMPUTER_TOOLS, COMPUTER_CALL_LIMIT, COMPUTER_TOOLS, computerRefusal } from '../src/computerPolicy.js'
import { DesktopLease } from '../src/desktopLease.js'
import { CODEX_COMPUTER_PLUGIN_DIR, resolveCodexComputer } from '../src/mcp/codexComputerLaunch.js'
import { codexComputerMcpDraft, reconcileCodexComputerServer } from '../src/mcp/codexComputerRegistration.js'
import {
  addEmbeddedComputer, CUA_DRIVER_PATH, EMBEDDED_COMPUTER_ENV_KEYS, embeddedComputerFromEnv, embeddedComputerLaunch,
} from '../src/mcp/computerAttachment.js'
import { createSqliteStore } from '../src/stores/sqliteStore.js'
import { effectProxyAttachment, type EffectProxyUpstream } from '../src/mcp/effectProxyAttachment.js'
import type { Store } from '../src/store.js'

const computer = {
  id: 'mcp_computer', name: 'computer', command: '/Applications/CuaDriver.app/Contents/MacOS/cua-driver', args: ['mcp'],
  envKeys: [], description: '', writes: true, effectPolicy: 'trusted', tools: [...COMPUTER_TOOLS],
  readOnlyTools: [], schemaChars: 0,
} as McpServerConfig

/**
 * How long the lease waits for the host to arm Escape. A test that needs the wait to run
 * out moves fake time past it; real time never does, however loaded the machine is.
 */
const ARM_TIMEOUT_MS = 60_000

function setup(options: { host?: boolean; fullAccess?: boolean; ack?: boolean | 'never' } = {}) {
  const armed: boolean[] = []
  const armIds: number[] = []
  const stopTokens: string[] = []
  const lease: DesktopLease<string> = new DesktopLease<string>({
    nameOf: (agentId) => (agentId === 'sage' ? 'Sage' : agentId),
    onArmed: (_host, value, arm) => {
      armed.push(value)
      const armId = arm?.armId
      if (arm !== undefined) { armIds.push(arm.armId); stopTokens.push(arm.stopToken) }
      const ack = options.ack ?? true
      if (armId !== undefined && ack !== 'never') queueMicrotask(() => lease.confirmArmed(armId, ack))
    },
    armTimeoutMs: ARM_TIMEOUT_MS,
  })
  if (options.host ?? true) lease.attachHost('window')
  armed.length = 0
  const ask = vi.fn(async () => ({ allow_effect: 'Allow once' }))
  const review = vi.fn(async () => true)
  const broker = new EffectBroker({ request: ask }, review, options.fullAccess ?? false)
  const capabilities = new EffectCapabilities(lease)
  const token = (turnId: string, agentId = 'smith', server: McpServerConfig = computer) =>
    capabilities.issue({ chatId: 'chat_1', agentId, turnId, canApprove: true }, server)
  const call = (capability: string, tool: string, arguments_: unknown = { pid: 42 }) =>
    capabilities.authorize(capability, { tool, arguments: arguments_ }, broker)
  return { lease, ask, review, armed, armIds, stopTokens, token, call }
}

describe('computer policy', () => {
  it('refuses tools and arguments that leave the background', () => {
    expect(computerRefusal('click', { pid: 1, x: 3, y: 4 })).toBeUndefined()
    expect(computerRefusal('bring_to_front', {})).toMatch(/not available/)
    expect(computerRefusal('click', { delivery_mode: 'foreground' })).toMatch(/exact window/)
    expect(computerRefusal('type_text', { delivery_mode: 'foreground', pid: 1, window_id: 2, text: 'hi' })).toBeUndefined()
    expect(computerRefusal('type_text', { scope: 'desktop', text: 'hi' })).toMatch(/frontmost/)
    expect(computerRefusal('get_window_state', { pid: 1, screenshot_out_file: '/tmp/x.png' })).toMatch(/files/)
    expect(computerRefusal('launch_app', { name: 'Figma', additional_arguments: ['--x'] })).toMatch(/launch arguments/)
    expect(computerRefusal('click', { target: { kind: 'window', pid: 1, window_id: 2 } })).toBeUndefined()
    expect(computerRefusal('click', { target: { display_id: 'primary' }, x: 5, y: 5 })).toMatch(/window target/)
    expect(computerRefusal('click', undefined)).toMatch(/without its arguments/)
  })

  it('refuses a display target that reaches the broker through the capability', async () => {
    const { token, call, armed } = setup()
    await expect(call(token('turn_1'), 'click', { target: { display_id: 'primary' }, x: 5, y: 5 }))
      .rejects.toThrow('window target')
    expect(armed).toEqual([])
  })
})

describe('the desktop lease', () => {
  it('asks a human once per turn, then lets routine writes through until the turn closes', async () => {
    const { ask, review, armed, token, call, lease } = setup()
    const turn = token('turn_1')
    await call(turn, 'get_window_state')
    expect(ask).not.toHaveBeenCalled()
    await call(turn, 'click')
    await call(turn, 'type_text', { pid: 42, text: 'Melk' })
    expect(ask).toHaveBeenCalledTimes(1)
    // Foreground delivery is allowed for one exact window, so the consent must say so.
    const prompt = JSON.stringify((ask.mock.calls[0] as unknown[])[1])
    expect(prompt).toContain('brought to the front')
    expect(prompt).not.toMatch(/never brings an app to the front|in the background for the rest/)
    expect(review).not.toHaveBeenCalled()
    expect(armed).toEqual([true])
    lease.closeTurn('turn_1')
    expect(armed).toEqual([true, false])
  })

  it('keeps the Mac held after Escape until the stopped turn has closed', async () => {
    const { token, call, lease, armed } = setup()
    await call(token('turn_1', 'sage'), 'click')
    await expect(call(token('turn_2'), 'click')).rejects.toThrow('in use by Sage')
    expect(lease.stop()).toBe('turn_1')
    expect(armed).toEqual([true, false])
    await expect(call(token('turn_1', 'sage'), 'click')).rejects.toThrow('Escape')
    await expect(call(token('turn_2'), 'click')).rejects.toThrow('in use by Sage')
    lease.closeTurn('turn_1')
    await call(token('turn_2'), 'click')
  })

  it('runs the first action only after the host confirms Escape', async () => {
    const { token, call, lease, armIds } = setup({ ack: 'never' })
    let settled = false
    const first = call(token('turn_1'), 'click').then(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    lease.confirmArmed(armIds[0]!, true)
    await first
    expect(settled).toBe(true)
  })

  it('refuses the action and frees the Mac when Escape cannot be armed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      for (const ack of [false, 'never'] as const) {
        const { token, call, armed, lease } = setup({ ack })
        const refused = expect(call(token('turn_1'), 'click')).rejects.toThrow('could not be armed')
        await vi.advanceTimersByTimeAsync(ARM_TIMEOUT_MS)
        await refused
        expect(armed).toEqual([true, false])
        expect(lease.admit('turn_2')).toBe('free')
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a late Escape answer meant for an earlier arm request', async () => {
    const { token, call, lease, armIds } = setup({ ack: 'never' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const refused = expect(call(token('turn_1'), 'click')).rejects.toThrow('could not be armed')
      await vi.advanceTimersByTimeAsync(ARM_TIMEOUT_MS)
      await refused
    } finally {
      vi.useRealTimers()
    }
    let settled = false
    const second = call(token('turn_2'), 'click').then(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    lease.confirmArmed(armIds[0]!, true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    lease.confirmArmed(armIds[1]!, true)
    await second
  })

  it('keeps the Mac held when Escape arrives before the arm is confirmed', async () => {
    const { token, call, lease, armIds } = setup({ ack: 'never' })
    const first = call(token('turn_1', 'sage'), 'click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lease.stop()).toBe('turn_1')
    await expect(first).rejects.toThrow('Escape')
    lease.confirmArmed(armIds[0]!, true)
    await expect(call(token('turn_2'), 'click')).rejects.toThrow('in use by Sage')
    lease.closeTurn('turn_1')
    expect(lease.admit('turn_2')).toBe('free')
  })

  it('keeps the stop on a repeat announcement, and stops the lease when the host changes or leaves', async () => {
    const { token, call, lease, armed } = setup()
    await call(token('turn_1'), 'click')
    expect(lease.attachHost('window')).toBeUndefined()
    expect(armed).toEqual([true])
    expect(lease.attachHost('reloaded window')).toBe('turn_1')
    expect(lease.detachHost('window')).toBeUndefined()
    lease.closeTurn('turn_1')
    await call(token('turn_2'), 'click')
    expect(lease.detachHost('reloaded window')).toBe('turn_2')
    await expect(call(token('turn_3'), 'click')).rejects.toThrow('desktop app')
  })

  it('stops only with the current lease\'s token, so an old Escape cannot end a new turn', async () => {
    const { token, call, lease, stopTokens } = setup()
    await call(token('turn_1'), 'click')
    lease.closeTurn('turn_1')
    await call(token('turn_2'), 'click')
    expect(lease.stopWith(stopTokens[0]!)).toBeUndefined()
    expect(lease.stopWith(stopTokens[1]!)).toBe('turn_2')
    await expect(call(token('turn_2'), 'click')).rejects.toThrow('Escape')
  })

  it('refuses computer use without a desktop host that can arm Escape', async () => {
    const { token, call } = setup({ host: false })
    await expect(call(token('turn_1'), 'get_window_state')).rejects.toThrow('desktop app')
  })

  it('grants the lease silently in Full access but still refuses windowless foreground delivery', async () => {
    const { ask, armed, token, call } = setup({ fullAccess: true })
    const turn = token('turn_1')
    await call(turn, 'click')
    expect(ask).not.toHaveBeenCalled()
    expect(armed).toEqual([true])
    await expect(call(turn, 'click', { delivery_mode: 'foreground' })).rejects.toThrow('exact window')
  })

  it('counts computer calls on their own budget, not the shared connector one', async () => {
    const { token, call } = setup()
    const turn = token('turn_1')
    for (let n = 0; n <= EFFECT_CALL_LIMIT; n += 1) await call(turn, 'get_window_state')
  })
})

const codexComputer = {
  ...computer, id: 'mcp_codex_computer', name: 'codex-computer', command: '/node', args: ['codexComputerMcp.mjs'],
  tools: ['js', 'js_add_node_module_dir', 'js_reset', 'turn_ended'],
} as McpServerConfig

describe('the Codex computer connector', () => {
  const card = (ask: ReturnType<typeof setup>['ask'], n: number) => JSON.stringify((ask.mock.calls[n] as unknown[])[1])

  it('takes the shared desktop lease even on a trusted row, and says its scripts can run commands', async () => {
    const { ask, review, armed, token, call } = setup()
    const turn = token('turn_1', 'smith', codexComputer)
    await call(turn, 'js', { code: 'let app = await cua.getApp("Calculator")' })
    await call(turn, 'js', { code: 'await app.click(3)' })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(card(ask, 0)).toContain('run commands')
    // Cua shares the Escape lease but brings apps to the front, so it asks for that itself.
    const cua = token('turn_1')
    await call(cua, 'click')
    await call(cua, 'click')
    expect(ask).toHaveBeenCalledTimes(2)
    expect(card(ask, 1)).toContain('brought to the front')
    expect(review).not.toHaveBeenCalled()
    expect(armed).toEqual([true])
  })

  it('asks again before Codex scripts ride a lease approved only for Cua clicks', async () => {
    const { ask, review, armed, token, call } = setup()
    await call(token('turn_1'), 'click')
    expect(card(ask, 0)).not.toContain('run commands')
    const codex = token('turn_1', 'smith', codexComputer)
    await call(codex, 'js', { code: 'await cua.getApp("Calculator")' })
    await call(codex, 'js', { code: '1' })
    expect(ask).toHaveBeenCalledTimes(2)
    expect(card(ask, 1)).toContain('run commands')
    expect(review).not.toHaveBeenCalled()
    expect(armed).toEqual([true])
  })

  it('keeps a denied Codex script out of a lease Cua holds', async () => {
    const { ask, token, call, armed } = setup()
    await call(token('turn_1'), 'click')
    ask.mockResolvedValueOnce({ allow_effect: 'Deny' })
    await expect(call(token('turn_1', 'smith', codexComputer), 'js', { code: '1' })).rejects.toThrow('denied')
    expect(armed).toEqual([true])
  })

  it('offers only js and js_reset', async () => {
    const { token, call, armed } = setup()
    const turn = token('turn_1', 'smith', codexComputer)
    await expect(call(turn, 'js_add_node_module_dir', { path: '/tmp/node_modules' })).rejects.toThrow('not available')
    await expect(call(turn, 'turn_ended', {})).rejects.toThrow('not available')
    expect(armed).toEqual([])
    const proxied = effectProxyAttachment({ server: codexComputer, disabledTools: [] }, 'http://broker', 'cap', {
      execPath: '/node', execArgv: [], entryPath: '/effectProxyMcp.ts',
    })
    const upstream = JSON.parse(Buffer.from(proxied.server.args.at(-1)!, 'base64url').toString('utf8')) as EffectProxyUpstream
    expect(upstream.allowTools).toEqual([...CODEX_COMPUTER_TOOLS])
  })

  it('shares the computer call budget with Cua', async () => {
    const { token, call } = setup()
    for (let n = 0; n < COMPUTER_CALL_LIMIT; n += 1) await call(token('turn_1', 'smith', codexComputer), 'js', { code: '1' })
    await expect(call(token('turn_1'), 'click')).rejects.toThrow('Computer budget exhausted')
  })
})

function codexHome(versions: Record<string, string>, runtime = true): string {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
  const app = join(home, 'ChatGPT.app')
  if (runtime) {
    mkdirSync(join(app, 'Codex Computer Use.app'), { recursive: true })
    for (const file of ['node', 'cua-repl.mjs', 'node_repl']) writeFileSync(join(app, file), '')
  }
  for (const [version, command] of Object.entries(versions)) {
    const dir = join(home, CODEX_COMPUTER_PLUGIN_DIR, version)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: {
      command: join(app, command), args: [join(app, 'cua-repl.mjs')],
      env: {
        CUA_REPL_NODE_REPL_PATH: join(app, 'node_repl'),
        SKY_CUA_SERVICE_PATH: join(app, 'Codex Computer Use.app'),
        NODE_REPL_NODE_PATH: join(app, 'node'),
        CUA_REPL_ENABLED_SURFACES: 'browser,computer',
        NODE_REPL_TRUSTED_SERVICES: '{"browser":"@oai/browser-desktop/service","sky":"@oai/sky/service"}',
        BROWSER_USE_AVAILABLE_BACKENDS: 'chrome,iab,mcpapps',
      },
    } } }))
  }
  return home
}

describe('resolving the Codex computer engine', () => {
  it('starts the numerically newest plugin with the computer surface only and no host secrets', () => {
    const home = codexHome({ '26.928.40906': 'missing-node', '26.1000.1': 'node', '26.999.9': 'missing-node' })
    const launch = resolveCodexComputer({ HOME: home, PATH: '/usr/bin', MANOR_SECRET: 'x', ANTHROPIC_API_KEY: 'y' })
    expect(launch.version).toBe('26.1000.1')
    expect(launch.command).toBe(join(home, 'ChatGPT.app', 'node'))
    expect(Object.keys(launch.env).sort()).toEqual([
      'CUA_REPL_ENABLED_SURFACES', 'CUA_REPL_NODE_REPL_PATH', 'HOME', 'NODE_REPL_NODE_PATH', 'PATH', 'SKY_CUA_SERVICE_PATH',
    ])
    expect(launch.env.CUA_REPL_ENABLED_SURFACES).toBe('computer')
  })

  it('names what is missing', () => {
    expect(() => resolveCodexComputer({ HOME: mkdtempSync(join(tmpdir(), 'codex-home-')) })).toThrow('not installed')
    expect(() => resolveCodexComputer({ HOME: codexHome({ '26.928.40906': 'node' }, false) })).toThrow('ChatGPT app is missing')
  })

  it('keeps the row visible but off every turn when the engine is missing', async () => {
    const draft = codexComputerMcpDraft()
    const row = { ...draft, id: 'mcp_codex', tools: ['js'], readOnlyTools: [], schemaChars: 0 } as McpServerConfig
    const store = {} as Store
    const [reconciled] = await reconcileCodexComputerServer(store, [row], { HOME: mkdtempSync(join(tmpdir(), 'codex-home-')) })
    expect(reconciled?.unavailable).toContain('not installed')
  })
})

describe('embeddedComputerLaunch', () => {
  const inside = { driver: '/Applications/Manor.app/Contents/Resources/cua-driver/cua-driver', socket: '/tmp/manor-cua-x/driver.sock' }

  it('points the registered Cua row at the driver inside Manor.app for the turn', () => {
    const attached = { server: { ...computer, envKeys: ['HOME'] }, disabledTools: ['drag'] }
    const launched = embeddedComputerLaunch(attached, inside)
    expect(launched.server.command).toBe(inside.driver)
    expect(launched.server.args).toEqual(['mcp', '--embedded', '--socket', inside.socket])
    expect(launched.server.envKeys).toEqual(['HOME', ...EMBEDDED_COMPUTER_ENV_KEYS])
    expect(launched.disabledTools).toEqual(['drag'])
    // The registry row itself stays as stored; a checkout shares it.
    expect(attached.server.command).toBe(CUA_DRIVER_PATH)
  })

  it('leaves the row alone without an embedded driver, and leaves every other row alone', () => {
    const attached = { server: computer, disabledTools: [] }
    expect(embeddedComputerLaunch(attached, undefined)).toBe(attached)
    const other = { server: { ...computer, name: 'calendar' }, disabledTools: [] }
    expect(embeddedComputerLaunch(other, inside)).toBe(other)
    const custom = { server: { ...computer, command: '/usr/local/bin/cua-driver' }, disabledTools: [] }
    expect(embeddedComputerLaunch(custom, inside)).toBe(custom)
  })

  it('reads both paths from the environment the desktop shell sets, or neither', () => {
    expect(embeddedComputerFromEnv({ MANOR_CUA_DRIVER: inside.driver, MANOR_CUA_SOCKET: inside.socket })).toEqual(inside)
    expect(embeddedComputerFromEnv({ MANOR_CUA_DRIVER: inside.driver })).toBeUndefined()
    expect(embeddedComputerFromEnv({ MANOR_CUA_DRIVER: '', MANOR_CUA_SOCKET: inside.socket })).toBeUndefined()
  })
})

describe('addEmbeddedComputer', () => {
  const probed = { tools: ['click', 'list_apps'], readOnlyTools: ['list_apps'], schemaChars: 10 }

  function embeddedFixture() {
    const directory = mkdtempSync(join(tmpdir(), 'manor-embedded-computer-'))
    const socket = join(directory, 'driver.sock')
    writeFileSync(socket, '')
    const filename = join(directory, 'manor.db')
    return { inside: { driver: join(directory, 'cua-driver'), socket }, filename, store: createSqliteStore({ filename }) }
  }

  it('adds the usual row once, probed through the embedded driver, and a removal sticks across restarts', async () => {
    const { inside, filename, store } = embeddedFixture()
    const probe = vi.fn(async () => probed)
    const added = await addEmbeddedComputer(store, () => [], { inside, probe })
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ command: inside.driver, args: ['mcp', '--embedded', '--socket', inside.socket] }))
    expect(added).toMatchObject({ name: 'computer', command: CUA_DRIVER_PATH, args: ['mcp'], tools: probed.tools })
    await store.deleteMcpServer(added!.id)
    store.close()
    const restarted = createSqliteStore({ filename })
    expect(await addEmbeddedComputer(restarted, () => [], { inside, probe })).toBeUndefined()
    expect(probe).toHaveBeenCalledTimes(1)
    restarted.close()
  })

  it('tries again on the next start when the daemon did not answer, and leaves a server without the driver alone', async () => {
    const { inside, store } = embeddedFixture()
    const probe = vi.fn(async () => probed)
    const silent = { ...inside, socket: `${inside.socket}.missing` }
    expect(await addEmbeddedComputer(store, () => [], { inside: silent, probe, socketWaitMs: 0 })).toBeUndefined()
    expect(probe).not.toHaveBeenCalled()
    const failing = vi.fn(async () => { throw new Error('daemon not listening') })
    expect(await addEmbeddedComputer(store, () => [], { inside, probe: failing })).toBeUndefined()
    expect(await store.setupDone('computer-connector')).toBe(false)
    expect(await addEmbeddedComputer(store, () => [], { probe })).toBeUndefined()
    expect(probe).not.toHaveBeenCalled()
    expect(await addEmbeddedComputer(store, () => [], { inside, probe })).toBeDefined()
    store.close()
  })

  it('counts a row that is already there, or registered during the probe, as done', async () => {
    const { inside, store } = embeddedFixture()
    const probe = vi.fn(async () => probed)
    expect(await addEmbeddedComputer(store, () => [computer], { inside, probe })).toBeUndefined()
    expect(probe).not.toHaveBeenCalled()
    expect(await store.setupDone('computer-connector')).toBe(true)
    const second = embeddedFixture()
    let registry: McpServerConfig[] = []
    const racing = vi.fn(async () => { registry = [computer]; return probed })
    expect(await addEmbeddedComputer(second.store, () => registry, { inside: second.inside, probe: racing })).toBeUndefined()
    expect(await second.store.listMcpServers()).toEqual([])
    expect(await second.store.setupDone('computer-connector')).toBe(true)
    store.close()
    second.store.close()
  })
})
