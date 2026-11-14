import { describe, expect, it } from 'vitest'
import { defaultModel } from '../src/runtimes'
import { draftToCreate, newAgentDraft, starterInstructions, withRuntime } from '../src/components/agents/newAgent'

describe('the New agent form', () => {
  it('starts on Claude with its default model, no role, no chief of staff and memory on', () => {
    expect(newAgentDraft([])).toMatchObject({ name: '', role: '', description: '', driver: 'claude', model: defaultModel('claude'), isCos: false, memoryScope: true })
  })

  it('takes the new provider default model on a switch, and keeps effort only where it is offered', () => {
    const draft = { ...newAgentDraft([]), effort: 'max' as const }
    const codex = withRuntime(draft, 'codex')
    expect(codex.model).toBe(defaultModel('codex'))
    expect(withRuntime({ ...draft, effort: 'medium' }, 'codex').effort).toBe('medium')
    // A model the provider does not list is not kept.
    expect(withRuntime(draft, 'codex', 'claude-opus-5-5').model).toBe(defaultModel('codex'))
  })

  it('writes starter instructions from the name and the job, because the server refuses none', () => {
    expect(starterInstructions({ name: 'Otto', description: '', isCos: false })).toMatch(/^You are Otto in this workspace\. Answer directly/)
    const created = draftToCreate({ ...newAgentDraft([]), name: ' Otto ', description: ' Client follow-ups. ' })
    expect(created).toMatchObject({ name: 'Otto', description: 'Client follow-ups.' })
    expect(created.character).toBe('You are Otto in this workspace. You help with this: Client follow-ups. Answer directly and completely, in plain language. Say so when you are unsure, and ask one question when a request is unclear.')
  })
})
