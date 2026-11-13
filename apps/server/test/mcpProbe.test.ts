import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import type { McpServerDraft } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { estimateEagerTokens, probeMcpServer, readOnlyToolNames } from '../src/mcp/probe.js'

const FIXTURE = fileURLToPath(new URL('../fixtures/fakeMcpServer.mjs', import.meta.url))

const draft = (overrides: Partial<McpServerDraft> = {}): McpServerDraft => ({
  name: 'fake',
  command: process.execPath,
  args: [FIXTURE],
  envKeys: [],
  description: '',
  writes: false,
  effectPolicy: 'confirm_writes' as const,
  ...overrides,
})

describe('probeMcpServer', () => {
  it('lists the tools a server offers', async () => {
    const result = await probeMcpServer(draft())
    expect(result.tools).toEqual(['list_rows', 'write_row'])
    // The fixture's readOnlyHint is connector-owned metadata, never authority.
    expect(result.readOnlyTools).toEqual([])
  })

  it('ignores connector-owned read hints and grants only exact Manor-reviewed names', () => {
    expect(readOnlyToolNames('gmail', [
      { name: 'send_message', annotations: { readOnlyHint: true } },
      { name: 'get_message', annotations: { readOnlyHint: false } },
      { name: 'get_message_unreviewed', annotations: { readOnlyHint: true } },
    ])).toEqual(['get_message'])
  })

  it('measures the wire size the CLI would inject, prefixes included', async () => {
    const result = await probeMcpServer(draft())
    // The name it counts is `mcp__<server>__<tool>`, so a longer server name costs
    // more; that is real, it is what lands in the request body.
    expect(result.schemaChars).toBeGreaterThan(200)
    const longer = await probeMcpServer(draft({ name: 'a-much-longer-server-name' }))
    expect(longer.schemaChars).toBeGreaterThan(result.schemaChars)
  })

  it('counts the instructions block, which tool gating never removes', async () => {
    const bare = await probeMcpServer(draft())
    const chatty = await probeMcpServer(draft({ args: [FIXTURE, '--instructions'] }))
    // The fixture's instructions are one 35-char sentence repeated four times.
    expect(chatty.schemaChars - bare.schemaChars).toBe(140)
  })

  it('refuses to probe when a named env key has no value on this machine', async () => {
    await expect(probeMcpServer(draft({ envKeys: ['ABSENT_KEY'] }), { env: {} })).rejects.toThrow(/ABSENT_KEY/)
  })

  it('passes a named env key through to the server', async () => {
    const spec = draft({ args: [FIXTURE, '--needs-token'], envKeys: ['FAKE_TOKEN'] })
    await expect(probeMcpServer(spec, { env: { FAKE_TOKEN: 'value' } })).resolves.toMatchObject({
      tools: ['list_rows', 'write_row'],
    })
  })

  it('isolates a probe from a stdio server that also binds a fixed HTTP port', async () => {
    const occupied = createServer()
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, resolve)
    })
    const address = occupied.address()
    if (address === null || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    try {
      const spec = draft({ args: [FIXTURE, '--bind-port'], envKeys: ['PORT'] })
      await expect(probeMcpServer(spec, { env: { PORT: String(address.port) } })).resolves.toMatchObject({
        tools: ['list_rows', 'write_row'],
      })
    } finally {
      occupied.close()
    }
  })

  it('reports a server that exits before listing, with its own complaint', async () => {
    const spec = draft({ args: [FIXTURE, '--needs-token'], envKeys: [] })
    await expect(probeMcpServer(spec, { env: {} })).rejects.toThrow(/FAKE_TOKEN is not set/)
  })

  it('redacts a granted secret when the server echoes it to stderr', async () => {
    const spec = draft({ args: [FIXTURE, '--leak-token'], envKeys: ['FAKE_TOKEN'] })
    const probe = probeMcpServer(spec, { env: { FAKE_TOKEN: 'capability-secret' } })

    await expect(probe).rejects.toThrow(/provider rejected \[redacted\]/)
    await expect(probe).rejects.not.toThrow(/capability-secret/)
  })

  it('reports a command that does not exist', async () => {
    await expect(probeMcpServer(draft({ command: '/nope/not-a-binary' }))).rejects.toThrow(/could not start/)
  })

  it('reports a server that refuses tools/list', async () => {
    await expect(probeMcpServer(draft({ args: [FIXTURE, '--refuse'] }))).rejects.toThrow(/no tools for you/)
  })

  it('functionally verifies Gmail credentials with the safe get_profile tool', async () => {
    await expect(probeMcpServer(draft({ args: [FIXTURE, '--profile'] }))).resolves.toMatchObject({
      verifiedBy: 'get_profile',
    })
  })

  it('does not call arbitrary tools when no safe verification tool is known', async () => {
    await expect(probeMcpServer(draft())).resolves.not.toHaveProperty('verifiedBy')
  })

  it('rejects a functional probe whose tool reports an authentication error', async () => {
    await expect(probeMcpServer(draft({ args: [FIXTURE, '--profile-error'] }))).rejects.toThrow(
      /get_profile could not verify its credential/,
    )
  })

  it('gives up on a server that never answers', async () => {
    const spec = draft({ args: [FIXTURE, '--silent'] })
    await expect(probeMcpServer(spec, { timeoutMs: 200 })).rejects.toThrow(/did not answer within 200ms/)
  })
})

describe('estimateEagerTokens', () => {
  it('prices Supabase close to what a real turn measured', () => {
    // 16.590 schema chars + 1.141 instruction chars cost +7.342 input tokens on a
    // real `claude -p` turn. The constant has to stay in that neighbourhood or the
    // number the persona form shows stops meaning anything.
    expect(estimateEagerTokens(17_731)).toBeGreaterThan(6_800);
    expect(estimateEagerTokens(17_731)).toBeLessThan(7_900)
  })
})
