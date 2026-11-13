import { describe, expect, it } from 'vitest'
import { FIGMA_MCP_NAME, FIGMA_REMOTE_URL, figmaMcpDraft } from '../src/mcp/figmaAttachment.js'
import { figmaRowDraft, figmaRuntimeUnchanged, reconcileFigmaServer } from '../src/mcp/figmaRegistration.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'

describe('figmaMcpDraft', () => {
  it('is an HTTP registry row on Figma’s remote MCP, with no credential', () => {
    const draft = figmaMcpDraft()
    expect(draft.name).toBe(FIGMA_MCP_NAME)
    expect(draft.url).toBe(FIGMA_REMOTE_URL)
    expect(draft.command).toBe('')
    expect(draft.envKeys).toEqual([])
    expect(draft.writes).toBe(true)
  })
})

describe('reconcileFigmaServer', () => {
  it('does not create a figma row that was never registered', async () => {
    const store = createMemoryStore()
    expect(await reconcileFigmaServer(store, [])).toEqual([])
    expect(await store.listMcpServers()).toEqual([])
  })

  it('leaves a row whose URL already matches', async () => {
    const store = createMemoryStore()
    const derived = figmaMcpDraft()
    const saved = await store.saveMcpServer(derived, { tools: ['get_design_context'], readOnlyTools: [], schemaChars: 1 })
    const next = await reconcileFigmaServer(store, [saved])
    expect(next).toEqual([saved])
    expect(figmaRuntimeUnchanged(saved, derived)).toBe(true)
  })

  it('keeps a hand-added env key when re-deriving the row', () => {
    const derived = figmaMcpDraft()
    const existing = {
      ...derived,
      id: 'mcp_1',
      tools: ['get_design_context'],
      readOnlyTools: [],
      schemaChars: 1,
      envKeys: ['FIGMA_ACCESS_TOKEN'],
      command: 'npx',
    }
    expect(figmaRowDraft(existing, derived).envKeys).toEqual(['FIGMA_ACCESS_TOKEN'])
    expect(figmaRowDraft(existing, derived).command).toBe('')
    expect(figmaRowDraft(existing, derived).url).toBe(FIGMA_REMOTE_URL)
  })
})
