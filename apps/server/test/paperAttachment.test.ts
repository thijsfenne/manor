import { describe, expect, it, vi } from 'vitest'
import { PAPER_DESKTOP_URL, PAPER_MCP_NAME, paperMcpDraft } from '../src/mcp/paperAttachment.js'
import {
  PAPER_UNAVAILABLE_MESSAGE,
  paperRowDraft,
  paperRuntimeUnchanged,
  probePaperRow,
  reconcilePaperServer,
} from '../src/mcp/paperRegistration.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'

describe('paperMcpDraft', () => {
  it('is a writable local HTTP connector with no credential', () => {
    const draft = paperMcpDraft()
    expect(draft.name).toBe(PAPER_MCP_NAME)
    expect(draft.url).toBe(PAPER_DESKTOP_URL)
    expect(draft.command).toBe('')
    expect(draft.envKeys).toEqual([])
    expect(draft.writes).toBe(true)
  })
})

describe('probePaperRow', () => {
  it('keeps the tool list from the live Paper probe', async () => {
    const probed = { tools: ['get_basic_info', 'write_html'], readOnlyTools: [], schemaChars: 1200 }
    await expect(probePaperRow(paperMcpDraft(), () => Promise.resolve(probed))).resolves.toEqual(probed)
  })

  it('explains the ordinary closed-app state', async () => {
    await expect(
      probePaperRow(paperMcpDraft(), () => Promise.reject(new Error(`could not reach ${PAPER_DESKTOP_URL}`))),
    ).rejects.toThrow(PAPER_UNAVAILABLE_MESSAGE)
  })

  it('keeps an HTTP failure intact instead of blaming a closed Paper file', async () => {
    const failure = new Error(`${PAPER_DESKTOP_URL} answered HTTP 500`)
    await expect(
      probePaperRow(paperMcpDraft(), () => Promise.reject(failure)),
    ).rejects.toThrow(failure.message)
  })
})

describe('reconcilePaperServer', () => {
  it('does not create a Paper row that was never registered', async () => {
    const store = createMemoryStore()
    expect(await reconcilePaperServer(store, [])).toEqual([])
    expect(await store.listMcpServers()).toEqual([])
  })

  it('leaves a row whose URL already matches', async () => {
    const store = createMemoryStore()
    const derived = paperMcpDraft()
    const saved = await store.saveMcpServer(derived, { tools: ['get_basic_info'], readOnlyTools: [], schemaChars: 1 })
    const next = await reconcilePaperServer(store, [saved])
    expect(next).toEqual([saved])
    expect(paperRuntimeUnchanged(saved, derived)).toBe(true)
  })

  it('removes stale credentials and restores the writable flag', () => {
    const derived = paperMcpDraft()
    const existing = {
      ...derived,
      id: 'mcp_1',
      tools: ['get_basic_info'],
      readOnlyTools: [],
      schemaChars: 1,
      envKeys: ['PAPER_DIAGNOSTIC_KEY'],
      writes: false,
      effectPolicy: 'confirm_writes' as const,
    }
    const corrected = paperRowDraft(existing, derived)
    expect(corrected.envKeys).toEqual([])
    expect(corrected.writes).toBe(true)
    expect(paperRuntimeUnchanged(existing, corrected)).toBe(false)
  })

  it('persists the safe derived row with last-known tools while Paper is offline', async () => {
    const store = createMemoryStore()
    const derived = paperMcpDraft()
    const stale = await store.saveMcpServer(
      { ...derived, envKeys: ['PAPER_STALE_SECRET'], writes: false },
      { tools: ['get_basic_info'], readOnlyTools: [], schemaChars: 321 },
    )
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      const next = await reconcilePaperServer(
        store,
        [stale],
        () => Promise.reject(new Error(PAPER_UNAVAILABLE_MESSAGE)),
      )

      expect(next[0]).toMatchObject({
        id: stale.id,
        envKeys: [],
        writes: true,
        effectPolicy: 'trusted' as const,
        tools: ['get_basic_info'],
        readOnlyTools: [],
        schemaChars: 321,
      })
      expect((await store.listMcpServers())[0]).toEqual(next[0])
    } finally {
      warning.mockRestore()
    }
  })
})
