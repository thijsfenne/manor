import { driverForModel, modelLabel, supportsFastMode, type AgentConfig } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { activeModel, contextWindow, runtimeLabel, withModel } from './runtimeChoices'
import { defaultModel, effortsFor, MODELS } from './runtimes'

const cursorAgent = (model: string): AgentConfig => ({
  id: model,
  name: 'Cursor',
  color: 'black',
  character: '',
  driver: 'cursor',
  model,
  effort: 'high',
  allowedTools: [],
  mcpServers: [],
  memoryScope: false,
  description: '',
  role: '',
  isCos: false,
})

describe('Cursor runtime choices', () => {
  it('offers the curated models', () => {
    expect(MODELS.cursor).toEqual([
      { value: 'cursor-claude-fable-5-2', label: 'Claude Fable 5.2' },
      { value: 'cursor-claude-opus-5-5', label: 'Claude Opus 5.5' },
      { value: 'cursor-claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { value: 'cursor-grok-4.6', label: 'Cursor Grok 4.6' },
      { value: 'cursor-grok-4.7', label: 'Cursor Grok 4.7' },
      { value: 'cursor-muse-wonder-1.0', label: 'Muse Wonder' },
    ])
  })

  it.each(Object.entries(MODELS))('lists %s models alphabetically', (_driver, models) => {
    const labels = models.map((option) => option.label)
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)))
  })

  it('keeps the defaults the lists used to start with', () => {
    expect(['claude', 'codex', 'grok', 'cursor', 'mock'].map((driver) => defaultModel(driver as AgentConfig['driver'])))
      .toEqual(['claude-fable-5-2', 'gpt-6-luna', 'grok-4.7', 'cursor-grok-4.6', undefined])
  })

  it('keeps naming retired models that old chat pins still run', () => {
    expect(modelLabel('cursor', 'cursor-kimi-k3')).toBe('Kimi K3')
    expect(modelLabel('cursor', 'cursor-gpt-5.6-sol')).toBe('GPT-5.6 Sol')
    expect(driverForModel('cursor-glm-5.2')).toBe('cursor')
  })

  it('uses the Cursor-specific context estimates', () => {
    expect(contextWindow(cursorAgent('cursor-grok-4.7'))).toBe(500_000)
    expect(contextWindow(cursorAgent('cursor-composer-2.5'))).toBe(200_000)
    expect(contextWindow(cursorAgent('cursor-claude-opus-5-5'))).toBe(1_000_000)
    expect(contextWindow(cursorAgent('cursor-claude-sonnet-5-5'))).toBe(200_000)
    expect(contextWindow(cursorAgent('cursor-gpt-5.6-luna'))).toBe(1_000_000)
    expect(contextWindow(cursorAgent('cursor-gemini-3.8-flash'))).toBe(200_000)
    expect(contextWindow(cursorAgent('cursor-muse-spark-1.3'))).toBe(1_000_000)
    expect(contextWindow(cursorAgent('cursor-muse-wonder-1.0'))).toBe(300_000)
  })

  it('offers only effort levels each Cursor family accepts', () => {
    expect(effortsFor('cursor', 'cursor-grok-4.7').map((option) => option.value)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(effortsFor('cursor', 'cursor-composer-2.5').map((option) => option.value)).toEqual(['high'])
    expect(effortsFor('cursor', 'cursor-gemini-3.8-flash').map((option) => option.value)).toEqual([
      'low',
      'medium',
      'high',
    ])
    expect(effortsFor('cursor', 'cursor-kimi-k3').map((option) => option.value)).toEqual([
      'low',
      'high',
      'max',
    ])
    expect(effortsFor('cursor', 'cursor-glm-5.2').map((option) => option.value)).toEqual([
      'high',
      'max',
    ])
  })

  it('routes Grok 4.7 through Cursor and preserves Fast when switching from 4.6', () => {
    expect(driverForModel('cursor-grok-4.7')).toBe('cursor')
    expect(supportsFastMode('cursor', 'cursor-grok-4.7')).toBe(true)
    const agent = cursorAgent('cursor-grok-4.6')
    const pin = withModel(agent, { speed: 'fast', effort: 'xhigh' }, 'cursor-grok-4.7')
    expect(activeModel(agent, {})).toBe('cursor-grok-4.6')
    expect(runtimeLabel(agent, pin, true)).toBe('Cursor Grok 4.7, Extra, Fast')
  })
})
