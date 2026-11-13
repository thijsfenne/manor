import { PERSONA_TOOLS, type AgentConfig, type DriverName, type TurnInput } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { buildArgs } from '../src/drivers/claudeDriver.js'
import { buildCodexTurnRequest } from '../src/drivers/codexDriver.js'
import { buildCursorArgs } from '../src/drivers/cursorDriver.js'
import { buildGrokArgs } from '../src/drivers/grokDriver.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { childTools } from '../src/subagents.js'

/**
 * Tool groups are gone (agent setup 3/4): every persona holds every built-in tool,
 * whatever list it was saved with, and each driver turns that into its own full grant.
 */

/** A persona saved under tool groups with a narrow list. */
const narrowed = (driver: DriverName): AgentConfig => ({
  id: `narrow-${driver}`, name: `Narrow ${driver}`, color: '#8B7EC8', character: 'You help.',
  driver, effort: 'high', allowedTools: ['Read', 'WebSearch'], mcpServers: [], memoryScope: false,
  role: '', description: '', isCos: false,
})

/** The persona as every driver receives it: read back through the store. */
async function asStored(driver: DriverName): Promise<AgentConfig> {
  const store = await createMemoryStore({ agents: [narrowed(driver)] })
  const agent = (await store.loadRoster())[0]
  if (agent === undefined) throw new Error('the store should hold the persona')
  return agent
}

const turn = (agent: AgentConfig): TurnInput => ({
  agent, threadId: 'main', cwd: '/scratch', repoPaths: [], isFullCatchUp: true,
  catchUp: [{ id: 'evt_1', ts: 1, type: 'user_message', text: 'Hello.', mentions: [agent.id] }],
})

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]

describe('every persona holds every built-in tool', () => {
  it('reads a stale narrow list back as the whole set, and saves the whole set', async () => {
    const store = await createMemoryStore({ agents: [narrowed('claude')] })
    expect((await store.loadRoster())[0]?.allowedTools).toEqual(PERSONA_TOOLS)

    const { id: _id, allowedTools: _tools, ...draft } = narrowed('claude')
    const saved = await store.saveAgent({ ...draft, name: 'Fresh' })
    expect(saved.allowedTools).toEqual(PERSONA_TOOLS)
  })

  it('Claude passes every name to --tools', async () => {
    const tools = flag(buildArgs(turn(await asStored('claude'))), '--tools')?.split(',')
    expect(tools).toEqual(expect.arrayContaining([...PERSONA_TOOLS]))
  })

  it('Grok allows its built-ins, web and reading included, and denies none of them', async () => {
    const args = buildGrokArgs(turn(await asStored('grok')))
    const tools = flag(args, '--tools')?.split(',') ?? []
    expect(tools).toEqual(expect.arrayContaining(['read_file', 'write', 'search_replace', 'run_terminal_command', 'web_search', 'web_fetch', 'todo_write', 'scheduler_create']))
    expect(tools).not.toContain('NotebookEdit')
    expect(args).not.toContain('--disable-web-search')
    expect(args).not.toContain('--disallowed-tools')
  })

  it('Codex runs with full access rather than read-only', async () => {
    expect(buildCodexTurnRequest(turn(await asStored('codex')), '/work', 'x', 't')).toMatchObject({
      params: { sandboxPolicy: { type: 'dangerFullAccess' } },
    })
  })

  it('Cursor starts in its acting mode rather than Ask', async () => {
    const args = buildCursorArgs(turn(await asStored('cursor')), '/work')
    expect(args).toContain('--force')
    expect(args).not.toContain('ask')
  })

  it('a Claude subagent keeps them all except the native helper, so delegation stays capped', async () => {
    const parent = await asStored('claude')
    expect(childTools(parent.allowedTools, 'claude')).toEqual(PERSONA_TOOLS.filter((tool) => tool !== 'Agent'))
  })
})
