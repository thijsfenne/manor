import type { AgentConfig } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { cleanDraft, draftOf } from '../src/persona'
import { emptyWorkspace, personaOf, reduce } from '../src/state'

describe('draftOf', () => {
  it('keeps the personas an existing agent may summon', () => {
    const agent = {
      id: 'smith',
      name: 'Smith',
      color: '#818791',
      character: 'Engineer',
      driver: 'claude',
      effort: 'high',
      allowedTools: [],
      mcpServers: [],
      mentionAllowlist: ['argus'],
      memoryScope: false,
      description: 'Builds the house.',
      role: 'Engineer',
      isCos: false,
    } as AgentConfig

    expect(draftOf(agent).mentionAllowlist).toEqual(['argus'])
  })
})

describe('the silhouette a persona was given', () => {
  const base = {
    id: 'wren',
    name: 'Wren',
    color: '#C77DBB',
    character: 'Front-end',
    driver: 'claude',
    effort: 'high',
    allowedTools: [],
    mcpServers: [],
    memoryScope: false,
    description: 'Builds screens.',
    role: 'Front-end',
    isCos: false,
  } as AgentConfig

  it('opens the form on the shape she is wearing', () => {
    expect(draftOf({ ...base, avatarShape: 'sun' }).avatarShape).toBe('sun')
    expect(draftOf(base).avatarShape).toBeUndefined()
  })

  it('preserves a chosen tone when reopening and saving the persona', () => {
    expect(cleanDraft(draftOf({ ...base, avatarTone: 0.1 })).avatarTone).toBe(0.1)
    expect(cleanDraft(draftOf(base)).avatarTone).toBeUndefined()
  })

  it('refreshes the face when only its tone changes, including a reset to the default', () => {
    const original = reduce(emptyWorkspace, { type: 'roster', agents: [base] })
    const changed = reduce(original, { type: 'roster', agents: [{ ...base, avatarTone: 0.1 }] })
    expect(changed).not.toBe(original)
    expect(personaOf(changed.agents, base.id).avatarTone).toBe(0.1)
    expect(reduce(changed, { type: 'roster', agents: [{ ...base, avatarTone: 0.1 }] })).toBe(changed)
    const reset = reduce(changed, { type: 'roster', agents: [base] })
    expect(personaOf(reset.agents, base.id).avatarTone).toBeUndefined()
  })

  it('goes on the wire as absent rather than empty when she has none', () => {
    const draft = cleanDraft({ ...draftOf(base), avatarShape: '' })

    expect('avatarShape' in draft).toBe(false)
    expect(cleanDraft(draftOf({ ...base, avatarShape: 'droplet' })).avatarShape).toBe('droplet')
  })
})
