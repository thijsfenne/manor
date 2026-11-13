import type { AgentConfig, AttachedMcpServer, McpServerConfig, TurnInput } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { buildArgs, buildMcpArgs, liveMcpServers, StreamParser } from '../src/drivers/claudeDriver.js'
import { interactionMcpAttachment } from '../src/mcp/interactionAttachment.js'
import {
  buildCodexAppServerArgs,
  buildCodexMcpArgs,
  buildCodexTurnRequest,
} from '../src/drivers/codexDriver.js'

/**
 * The MCP attachment contract, on both drivers. Every expectation here traces to a
 * measurement in `.claude/ideas/2026-08-07-mcp-in-manor.md`; the ones that pin a
 * negative (no server means no flag, an attachment does not move the sandbox) are the
 * ones that keep the contract from quietly widening later.
 */

const server = (overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'srv_1',
  name: 'supabase',
  command: '/usr/bin/mcp-supabase',
  args: ['--read-only'],
  envKeys: [],
  description: '',
  writes: false,
  effectPolicy: 'confirm_writes' as const,
  tools: ['list_tables', 'execute_sql'],
  readOnlyTools: [],
  schemaChars: 17_731,
  ...overrides,
})

const attach = (overrides: Partial<McpServerConfig> = {}, disabledTools: string[] = []): AttachedMcpServer => ({
  server: server(overrides),
  disabledTools,
})

const sage: AgentConfig = {
  id: 'sage',
  name: 'Sage',
  color: '#6FA8A0',
  driver: 'claude',
  effort: 'high',
  allowedTools: [],
  mcpServers: [],
  memoryScope: false,
  role: 'Generalist',
  description: '',
  isCos: false,
  character: 'You are Sage.',
}

const turnInput = (agent: AgentConfig, overrides: Partial<TurnInput> = {}): TurnInput => ({
  agent,
  threadId: 'main',
  cwd: '/tmp/manor-scratch/main',
  catchUp: [],
  isFullCatchUp: true,
  repoPaths: [],
  ...overrides,
})

/** The parsed `--mcp-config` payload, so assertions read as config not as a string. */
function mcpConfigOf(args: string[]): Record<string, unknown> | undefined {
  const at = args.indexOf('--mcp-config')
  if (at === -1) return undefined
  return JSON.parse(args[at + 1] ?? '{}') as Record<string, unknown>
}

const valuesAfter = (args: string[], flag: string): string[] => {
  const at = args.indexOf(flag)
  if (at === -1) return []
  const values: string[] = []
  for (let index = at + 1; index < args.length; index += 1) {
    const value = args[index] ?? ''
    if (value.startsWith('--')) break
    values.push(value)
  }
  return values
}

describe('claude driver, MCP argv', () => {
  it('loads Manor in-turn tools upfront in every room, including resumed Work, without loading registered connectors', () => {
    const manor = interactionMcpAttachment('http://127.0.0.1:8787/internal/user-input', 'test-capability', {
      subagents: { models: [{ model: 'gpt-6.1-sol', label: 'Sol', provider: 'codex', efforts: ['high'] }], maxConcurrent: 3 },
    })
    expect(manor.server.tools).toEqual(expect.arrayContaining(['delegate_task', 'task_result']))
    const attached = [manor, attach()]
    const config = mcpConfigOf(buildArgs(turnInput(sage, {
      singleSession: true, sessionId: 'single-work', mcpServers: attached,
    })))
    expect(config).toMatchObject({ mcpServers: { manor: { alwaysLoad: true } } })
    expect(config).toEqual({ mcpServers: liveMcpServers(attached, {}) })
    expect(liveMcpServers(attached, {}).supabase).not.toHaveProperty('alwaysLoad')
    expect(liveMcpServers(attached, {})).toMatchObject({ manor: { alwaysLoad: true } })
    // A DM or persona room, and a resumed Work room, load the same way.
    for (const room of [{}, { sessionId: 'work-room' }]) {
      expect(mcpConfigOf(buildArgs(turnInput(sage, { ...room, mcpServers: attached }))))
        .toEqual({ mcpServers: liveMcpServers(attached, {}) })
    }
    expect(buildArgs(turnInput(sage, { singleSession: true, mcpServers: [] }))).not.toContain('--mcp-config')
  })

  it('passes no MCP flag at all when the persona has no attachments', () => {
    expect(buildMcpArgs([])).toEqual([])
    expect(buildArgs(turnInput(sage))).not.toContain('--mcp-config')
  })

  it('renders one attached server into the config', () => {
    const config = mcpConfigOf(buildMcpArgs([attach()]))
    expect(config).toEqual({
      mcpServers: { supabase: { command: '/usr/bin/mcp-supabase', args: ['--read-only'] } },
    })
  })

  it('writes env keys as ${KEY} placeholders and never a value', () => {
    const args = buildMcpArgs([attach({ envKeys: ['SUPABASE_ACCESS_TOKEN'] })])
    const config = mcpConfigOf(args) as { mcpServers: { supabase: { env: Record<string, string> } } }
    expect(config.mcpServers.supabase.env).toEqual({ SUPABASE_ACCESS_TOKEN: '${SUPABASE_ACCESS_TOKEN}' })
    // The whole argv, not just the env block: a secret must not reach `ps` anywhere.
    expect(args.join(' ')).not.toContain('sbp_')
  })

  it('prefixes excluded tools with the server name', () => {
    const args = buildMcpArgs([attach({}, ['execute_sql', 'apply_migration'])])
    expect(valuesAfter(args, '--disallowed-tools')).toEqual([
      'mcp__supabase__execute_sql',
      'mcp__supabase__apply_migration',
    ])
  })

  it('omits --disallowed-tools when nothing is excluded', () => {
    expect(buildMcpArgs([attach()])).not.toContain('--disallowed-tools')
  })

  it('renders an HTTP server as type url, never as a spawned command', () => {
    const config = mcpConfigOf(buildMcpArgs([attach({ command: '', url: 'http://127.0.0.1:3845/mcp' })]))
    expect(config).toEqual({
      mcpServers: { supabase: { type: 'http', url: 'http://127.0.0.1:3845/mcp' } },
    })
  })

  it('puts an OAuth bearer in headers as a placeholder, never the value', () => {
    const args = buildMcpArgs([
      {
        server: server({ command: '', url: 'https://mcp.figma.com/mcp' }),
        disabledTools: [],
        runtimeEnv: { MANOR_MCP_BEARER_SUPABASE: 'secret-token' },
      },
    ])
    const config = mcpConfigOf(args) as {
      mcpServers: { supabase: { headers?: { Authorization: string } } }
    }
    expect(config.mcpServers.supabase.headers?.Authorization).toBe('Bearer ${MANOR_MCP_BEARER_SUPABASE}')
    expect(args.join(' ')).not.toContain('secret-token')
  })

  it('renders HTTP API-key headers from environment placeholders', () => {
    const args = buildMcpArgs([attach({
      command: '',
      url: 'https://connect.composio.dev/mcp',
      httpHeaders: [{ name: 'x-consumer-api-key', envKey: 'COMPOSIO_CONSUMER_API_KEY' }],
    })])
    const config = mcpConfigOf(args) as {
      mcpServers: { supabase: { headers: Record<string, string> } }
    }
    expect(config.mcpServers.supabase.headers).toEqual({
      'x-consumer-api-key': '${COMPOSIO_CONSUMER_API_KEY}',
    })
  })

  it('places the MCP flags before the variadic --tools terminator', () => {
    const args = buildArgs(turnInput(sage, { mcpServers: [attach({}, ['execute_sql'])] }))
    expect(args.indexOf('--mcp-config')).toBeLessThan(args.indexOf('--tools'))
    expect(args.indexOf('--disallowed-tools')).toBeLessThan(args.indexOf('--tools'))
  })

  it('keeps an empty allowedTools meaning no built-ins but ToolSearch while a server is attached', () => {
    // The measured defect this contract exists for: `--tools ""` does not gate MCP,
    // so the toolset must stay empty AND the server must still be handed over. The one
    // exception is ToolSearch, the only way to load a deferred tool under lazy MCP.
    const args = buildArgs(turnInput(sage, { mcpServers: [attach()] }))
    expect(valuesAfter(args, '--tools')).toEqual(['ToolSearch'])
    expect(mcpConfigOf(args)).toBeDefined()
    expect(valuesAfter(buildArgs(turnInput({ ...sage, allowedTools: ['Read', 'ToolSearch'] }, { mcpServers: [attach()] })), '--tools'))
      .toEqual(['Read,ToolSearch'])
    expect(valuesAfter(buildArgs(turnInput(sage)), '--tools')).toEqual([''])
  })
})

describe('claude driver, MCP server status', () => {
  const init = (servers: { name: string; status: string }[]) =>
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', mcp_servers: servers })

  it('says nothing when every server connected', () => {
    expect(new StreamParser().handle(init([{ name: 'supabase', status: 'connected' }]))).toEqual([])
  })

  it('keeps an eager startup failure out of the turn trace', () => {
    expect(
      new StreamParser().handle(
        init([{ name: 'supabase', status: 'failed' }, { name: 'context7', status: 'connected' }]),
      ),
    ).toEqual([])
  })

  it('still records the session id from an init line carrying a failure', () => {
    const parser = new StreamParser()
    parser.handle(init([{ name: 'supabase', status: 'failed' }]))
    expect(parser.sessionId).toBe('s1')
    expect(parser.sawInit).toBe(true)
  })
})

describe('codex driver, MCP argv', () => {
  const codexSage: AgentConfig = { ...sage, driver: 'codex' }

  it('passes no override when the persona has no attachments', () => {
    expect(buildCodexMcpArgs([])).toEqual([])
    expect(buildCodexAppServerArgs(turnInput(codexSage)).join(' ')).not.toContain('mcp_servers')
  })

  it('renders the whole table into one -c override', () => {
    expect(buildCodexMcpArgs([attach()])).toEqual([
      '-c',
      'mcp_servers={supabase={command="/usr/bin/mcp-supabase",args=["--read-only"]}}',
    ])
  })

  it('names host env vars rather than carrying values', () => {
    const [, override = ''] = buildCodexMcpArgs([attach({ envKeys: ['SUPABASE_ACCESS_TOKEN'] })])
    expect(override).toContain('env_vars=["SUPABASE_ACCESS_TOKEN"]')
  })

  it('renders excluded tools as disabled_tools, unprefixed', () => {
    const [, override = ''] = buildCodexMcpArgs([attach({}, ['execute_sql'])])
    expect(override).toContain('disabled_tools=["execute_sql"]')
  })

  it('escapes quotes and backslashes so a path cannot break the TOML', () => {
    const [, override = ''] = buildCodexMcpArgs([attach({ command: 'C:\\a "b"\\mcp' })])
    expect(override).toContain('command="C:\\\\a \\"b\\"\\\\mcp"')
  })

  it('renders an HTTP server as url and omits command', () => {
    const [, override = ''] = buildCodexMcpArgs([attach({ command: '', url: 'http://127.0.0.1:3845/mcp' })])
    expect(override).toBe('mcp_servers={supabase={url="http://127.0.0.1:3845/mcp"}}')
  })

  it('names an HTTP bearer without adding unsupported streamable_http env_vars', () => {
    const bearerKey = 'MANOR_MCP_BEARER_SUPABASE'
    const attachment = {
      ...attach({ command: '', url: 'http://127.0.0.1:3845/mcp' }),
      runtimeEnv: { [bearerKey]: 'secret-turn-capability' },
    }
    const [, override = ''] = buildCodexMcpArgs([attachment])

    expect(override).toContain(`bearer_token_env_var="${bearerKey}"`)
    expect(override).not.toContain('env_vars=')
    expect(override).not.toContain('secret-turn-capability')
  })

  it('maps HTTP headers to env_http_headers without carrying their values', () => {
    const [, override = ''] = buildCodexMcpArgs([attach({
      command: '',
      url: 'https://connect.composio.dev/mcp',
      httpHeaders: [{ name: 'x-consumer-api-key', envKey: 'COMPOSIO_CONSUMER_API_KEY' }],
    })])
    expect(override).toContain('env_http_headers={"x-consumer-api-key"="COMPOSIO_CONSUMER_API_KEY"}')
    expect(override).not.toContain('ck_secret')
  })

  it('leaves the sandbox alone: an attached server is not "this persona acts"', () => {
    // Deliberate. --sandbox governs model-generated shell commands and cannot reach an
    // MCP process, so widening it would grant shell bypass without containing anything.
    const request = buildCodexTurnRequest(
      turnInput(codexSage, { mcpServers: [attach({ writes: true })] }),
      '/work',
      'prompt',
      'thread-1',
    )
    expect(request).toMatchObject({ params: { sandboxPolicy: { type: 'readOnly' } } })
  })

  it('keeps MCP configuration process-scoped on resumed threads', () => {
    const args = buildCodexAppServerArgs(
      turnInput(codexSage, { mcpServers: [attach()], sessionId: 'thread_1' }),
    )
    expect(args).toContain('-c')
    expect(args.join(' ')).toContain('mcp_servers={supabase=')
  })
})
