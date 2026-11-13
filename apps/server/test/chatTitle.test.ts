import type { TurnInput } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import {
  CHAT_TITLE_FALLBACK_MODEL,
  CHAT_TITLE_MODEL,
  cleanChatTitle,
  createChatTitleGenerator,
  fallbackChatTitle,
} from '../src/chatTitle.js'
import { scripted } from './helpers.js'

describe('chat titles', () => {
  it('runs a disposable title turn on Haiku 5.5, with no tools and no MCP, and cleans its answer', async () => {
    const seen: TurnInput[] = []
    const driver = scripted(
      () => [{ type: 'result', text: 'Title: "Sidebar project navigation."' }],
      seen,
    )
    const generate = createChatTitleGenerator({
      attempts: [{ driver, runtime: 'claude', model: CHAT_TITLE_MODEL }],
      ensureScratchDir: (threadId) => Promise.resolve(`/tmp/${threadId}`),
    })

    await expect(generate('chat_1', 'Maak de sidebar projectgericht')).resolves.toBe('Sidebar project navigation')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.agent).toMatchObject({
      id: 'manor-title-writer',
      driver: 'claude',
      model: 'claude-haiku-5-5',
      allowedTools: [],
      mcpServers: [],
      memoryScope: false,
    })
    expect(seen[0]?.threadId).toBe('title_chat_1')
    expect(seen[0]?.catchUp).toEqual([
      expect.objectContaining({ type: 'user_message', text: 'Maak de sidebar projectgericht' }),
    ])
  })

  it('hands naming to Luna when Claude is unavailable', async () => {
    const seen: TurnInput[] = []
    const haiku = scripted(() => [{ type: 'error', message: 'provider unavailable' }], seen)
    const luna = scripted(() => [{ type: 'result', text: 'Projectplan voor Manor' }], seen)
    const generate = createChatTitleGenerator({
      attempts: [
        { driver: haiku, runtime: 'claude', model: CHAT_TITLE_MODEL },
        { driver: luna, runtime: 'codex', model: CHAT_TITLE_FALLBACK_MODEL },
      ],
      ensureScratchDir: () => Promise.resolve('/tmp/title'),
    })

    await expect(generate('chat_1', '@Marlow Kun je een projectplan maken voor Manor?')).resolves.toBe(
      'Projectplan voor Manor',
    )
    expect(seen.map((input) => input.agent.model)).toEqual([CHAT_TITLE_MODEL, CHAT_TITLE_FALLBACK_MODEL])
    expect(seen[1]?.agent).toMatchObject({ driver: 'codex', model: 'gpt-6-luna', allowedTools: [], memoryScope: false })
  })

  it('moves on when a provider exits cleanly without saying anything', async () => {
    const seen: TurnInput[] = []
    const silent = scripted(() => [], seen)
    const luna = scripted(() => [{ type: 'result', text: 'Projectplan voor Manor' }], seen)
    const generate = createChatTitleGenerator({
      attempts: [
        { driver: silent, runtime: 'claude', model: CHAT_TITLE_MODEL },
        { driver: luna, runtime: 'codex', model: CHAT_TITLE_FALLBACK_MODEL },
      ],
      ensureScratchDir: () => Promise.resolve('/tmp/title'),
    })

    await expect(generate('chat_1', 'Kun je een projectplan maken?')).resolves.toBe('Projectplan voor Manor')
    expect(seen).toHaveLength(2)
  })

  it('falls back to the opening words when every attempt fails', async () => {
    const errors: unknown[] = []
    const failing = () => scripted(() => [{ type: 'error', message: 'provider unavailable' }], [])
    const generate = createChatTitleGenerator({
      attempts: [
        { driver: failing(), runtime: 'claude', model: CHAT_TITLE_MODEL },
        { driver: failing(), runtime: 'codex', model: CHAT_TITLE_FALLBACK_MODEL },
      ],
      ensureScratchDir: () => Promise.resolve('/tmp/title'),
      onError: (error) => errors.push(error),
    })

    await expect(generate('chat_1', '@Marlow Kun je een projectplan maken voor Manor?')).resolves.toBe(
      'Kun je een projectplan maken voor Manor?',
    )
    expect(errors).toHaveLength(2)
  })

  it('keeps generated and fallback titles short enough for the sidebar', () => {
    expect(cleanChatTitle('# Chat title: Een korte, bruikbare naam!\nExtra uitleg', 'Fallback')).toBe(
      'Een korte, bruikbare naam',
    )
    expect(fallbackChatTitle('een twee drie vier vijf zes zeven acht negen tien')).toBe(
      'een twee drie vier vijf zes zeven acht',
    )
  })
})
