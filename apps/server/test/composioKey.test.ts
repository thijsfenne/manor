import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientMessageSchema, type ComposioApp, type ServerMessage } from '@manor/contracts'
import { COMPOSIO_NOT_STARTED, ComposioKey, removeEnvFileValues, setEnvFileValue, type ComposioKeyDeps } from '../src/composioKey.js'
import { fetchComposioCatalog } from '../src/mcp/composioCatalog.js'

const GOOD = 'ak_GoodKey_0123456789'
const WRONG = 'ak_WrongKey_9876543210'

/** Composio's toolkit and auth-config listings, answering only the good key. */
const fakeComposio: typeof fetch = async (_url, init) => {
  const key = new Headers(init?.headers).get('x-api-key')
  if (key !== GOOD) return new Response('{"error":"unauthorized"}', { status: 401 })
  return Response.json({ items: [{ slug: 'gmail', name: 'Gmail', composio_managed_auth_schemes: ['OAUTH2'] }] })
}

function setup(options: { env?: NodeJS.ProcessEnv; origin?: ComposioKeyDeps['origin']; existing?: string } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'manor-composio-key-'))
  const file = path.join(dir, '.env')
  if (options.existing !== undefined) writeFileSync(file, options.existing, { mode: 0o644 })
  const env: NodeJS.ProcessEnv = options.env ?? {}
  const sent: ServerMessage[] = []
  const started = vi.fn(async (_apps: ComposioApp[]) => undefined)
  const stopped = vi.fn(async () => undefined)
  const validate = vi.fn((value: string) => fetchComposioCatalog(value, fakeComposio))
  const key = new ComposioKey({
    env,
    origin: options.origin ?? (() => undefined),
    file,
    validate,
    started,
    stopped,
    broadcast: (message) => sent.push(message),
  })
  const run = async (message: { type: 'set_composio_key'; key: string } | { type: 'remove_composio_key' }) => {
    const replies: ServerMessage[] = []
    let acked = false
    await key.handle(message, (reply) => replies.push(reply), () => { acked = true })
    return { replies, acked }
  }
  return { dir, file, env, sent, started, stopped, validate, key, run }
}

describe('the Composio key the Connectors page saves', () => {
  let logs: string[]
  beforeEach(() => {
    logs = []
    for (const level of ['log', 'warn', 'error', 'info'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
    }
  })
  afterEach(() => vi.restoreAllMocks())

  it('keeps a valid key in the data folder file with mode 0600, every other line kept byte for byte', async () => {
    const existing = '# my settings\nMANOR_REMINDERS=on\r\n\nexport OTHER="a b" # note\nLAST=1'
    const host = setup({ existing })
    const { replies, acked } = await host.run({ type: 'set_composio_key', key: `  ${GOOD}\n` })
    expect(replies).toEqual([])
    expect(acked).toBe(true)
    expect(readFileSync(host.file, 'utf8')).toBe(`${existing}\nCOMPOSIO_API_KEY=${GOOD}\n`)
    expect(statSync(host.file).mode & 0o777).toBe(0o600)
    expect(readdirSync(host.dir)).toEqual(['.env'])
    expect(host.env.COMPOSIO_API_KEY).toBe(GOOD)
    expect(host.key.source()).toBe('manor')
    expect(host.sent).toEqual([{ type: 'composio_key', source: 'manor' }])
    expect(host.started).toHaveBeenCalledWith([expect.objectContaining({ slug: 'gmail', connect: 'one_click' })])
  })

  it('creates a missing file owner-only, and replaces an existing key line in place', async () => {
    const fresh = setup()
    await fresh.run({ type: 'set_composio_key', key: GOOD })
    expect(readFileSync(fresh.file, 'utf8')).toBe(`COMPOSIO_API_KEY=${GOOD}\n`)
    expect(statSync(fresh.file).mode & 0o777).toBe(0o600)

    const file = path.join(fresh.dir, 'other.env')
    writeFileSync(file, 'A=1\nCOMPOSIO_API_KEY=old\nB=2\n')
    await setEnvFileValue(file, 'COMPOSIO_API_KEY', GOOD)
    expect(readFileSync(file, 'utf8')).toBe(`A=1\nCOMPOSIO_API_KEY=${GOOD}\nB=2\n`)
  })

  it('stores nothing for a key Composio refuses, and says so in plain words', async () => {
    const host = setup({ existing: 'A=1\n' })
    const { replies, acked } = await host.run({ type: 'set_composio_key', key: WRONG })
    expect(acked).toBe(false)
    expect(replies).toEqual([{ type: 'notice', kind: 'error', text: 'Composio did not accept this key. Check that you copied the whole project API key.' }])
    expect(readFileSync(host.file, 'utf8')).toBe('A=1\n')
    expect(host.env.COMPOSIO_API_KEY).toBeUndefined()
    expect(host.started).not.toHaveBeenCalled()
    expect(host.sent).toEqual([])
  })

  it('refuses a value that could break out of its line, before Composio or the file sees it', async () => {
    for (const bad of [`${GOOD}\nMANOR_EFFECT_MODE=full-access`, `${GOOD}=x`, `"${GOOD}"`, 'ak short', 'ak_1', `${GOOD} ${GOOD}`, 'a'.repeat(300)]) {
      const host = setup()
      const { replies } = await host.run({ type: 'set_composio_key', key: bad })
      expect(replies[0]).toMatchObject({ type: 'notice', kind: 'error' })
      expect(existsSync(host.file)).toBe(false)
      expect(host.env.COMPOSIO_API_KEY).toBeUndefined()
      expect(host.validate).not.toHaveBeenCalled()
    }
  })

  it('removes only the key lines, unsets it, and settles Composio', async () => {
    const host = setup({ env: { COMPOSIO_API_KEY: GOOD }, existing: `# keep\nA=1\nCOMPOSIO_API_KEY=${GOOD}\nCOMPOSIO_CONSUMER_API_KEY=legacy\nB=2` })
    expect(host.key.source()).toBe('manor')
    const { replies, acked } = await host.run({ type: 'remove_composio_key' })
    expect(replies).toEqual([])
    expect(acked).toBe(true)
    expect(readFileSync(host.file, 'utf8')).toBe('# keep\nA=1\nB=2')
    expect(statSync(host.file).mode & 0o777).toBe(0o600)
    expect(host.env.COMPOSIO_API_KEY).toBeUndefined()
    expect(host.stopped).toHaveBeenCalledTimes(1)
    expect(host.sent).toEqual([{ type: 'composio_key', source: 'none' }])
    expect(await removeEnvFileValues(host.file, ['COMPOSIO_API_KEY'])).toBe(false)
  })

  it('reports a key from the real environment or the checkout as outside Manor, and never replaces or removes it', async () => {
    for (const where of ['environment', 'checkout'] as const) {
      const host = setup({ env: { COMPOSIO_API_KEY: WRONG }, origin: (name) => name === 'COMPOSIO_API_KEY' ? where : undefined, existing: 'A=1\n' })
      expect(host.key.status()).toEqual({ type: 'composio_key', source: where })
      const set = await host.run({ type: 'set_composio_key', key: GOOD })
      const removed = await host.run({ type: 'remove_composio_key' })
      expect(set.acked || removed.acked).toBe(false)
      expect([...set.replies, ...removed.replies].every((reply) => reply.type === 'notice' && reply.kind === 'error')).toBe(true)
      expect(host.env.COMPOSIO_API_KEY).toBe(WRONG)
      expect(readFileSync(host.file, 'utf8')).toBe('A=1\n')
      expect(host.started).not.toHaveBeenCalled()
      expect(host.stopped).not.toHaveBeenCalled()
    }
  })

  it('takes the source from the variable in use, so Manor’s key wins over a legacy one in the checkout', async () => {
    const origin: ComposioKeyDeps['origin'] = (name) => name === 'COMPOSIO_CONSUMER_API_KEY' ? 'checkout' : undefined
    const host = setup({
      env: { COMPOSIO_API_KEY: GOOD, COMPOSIO_CONSUMER_API_KEY: WRONG },
      origin,
      existing: `COMPOSIO_API_KEY=${GOOD}\n`,
    })
    expect(host.key.source()).toBe('manor')
    const { acked } = await host.run({ type: 'remove_composio_key' })
    expect(acked).toBe(true)
    expect(readFileSync(host.file, 'utf8')).toBe('')
    expect(host.env.COMPOSIO_CONSUMER_API_KEY).toBe(WRONG)
    expect(host.key.source()).toBe('checkout')

    const legacyOnly = setup({ env: { COMPOSIO_CONSUMER_API_KEY: WRONG }, origin })
    expect(legacyOnly.key.source()).toBe('checkout')
  })

  it('says the key is saved but Composio did not start, without the key or Composio’s words', async () => {
    const host = setup()
    host.started.mockRejectedValueOnce(new Error(`session refused for ${GOOD}`))
    const { replies, acked } = await host.run({ type: 'set_composio_key', key: GOOD })
    expect(acked).toBe(false)
    expect(replies).toEqual([{ type: 'notice', kind: 'info', text: COMPOSIO_NOT_STARTED }])
    expect(COMPOSIO_NOT_STARTED).toBe('The key is saved, but Composio did not start. Press Test on the Composio row, or try again later.')
    expect(JSON.stringify(replies)).not.toContain('session refused')
    expect(host.env.COMPOSIO_API_KEY).toBe(GOOD)
    expect(host.key.source()).toBe('manor')
  })

  it('never puts the key in a message to any client or a log line, whatever happens', async () => {
    const host = setup()
    const replies: ServerMessage[] = []
    const collect = async (message: Parameters<typeof host.run>[0]) => { replies.push(...(await host.run(message)).replies) }
    await collect({ type: 'set_composio_key', key: WRONG })
    await collect({ type: 'set_composio_key', key: GOOD })
    await collect({ type: 'set_composio_key', key: GOOD })
    await collect({ type: 'remove_composio_key' })
    // A start that fails with the key in its error still logs it redacted.
    host.started.mockRejectedValueOnce(new Error(`session refused for ${GOOD}`))
    await collect({ type: 'set_composio_key', key: GOOD })
    const outgoing = JSON.stringify([...replies, ...host.sent])
    for (const secret of [GOOD, WRONG, GOOD.slice(3, 15), WRONG.slice(3, 15)]) {
      expect(outgoing).not.toContain(secret)
      expect(logs.join('\n')).not.toContain(secret)
    }
    expect(logs.join('\n')).toContain('[redacted]')
    expect(host.sent.every((message) => message.type === 'composio_key')).toBe(true)
  })

  it('is a client message only through its schema, with no key field in what goes back', () => {
    expect(ClientMessageSchema.safeParse({ type: 'set_composio_key', key: GOOD, requestId: 'r1' }).success).toBe(true)
    expect(ClientMessageSchema.safeParse({ type: 'remove_composio_key' }).success).toBe(true)
    expect(Object.keys(setup().key.status())).toEqual(['type', 'source'])
  })
})
