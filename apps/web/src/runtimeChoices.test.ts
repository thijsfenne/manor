import { describe, expect, it, vi } from 'vitest'
import { parseServerMessage } from '@manor/client-runtime/connection'
import { driverForModel, type AgentConfig } from '@manor/contracts'
import {
  activeEffort,
  activeModel,
  activeSpeed,
  contextWindow,
  differsFromRoster,
  effectiveDriver,
  isPinned,
  isAutoOn,
  isAutoPending,
  modelRowsFor,
  providerRowsFor,
  readHostAuto,
  readOffModels,
  runtimeLabel,
  setHostAuto,
  subscribeHostAuto,
  supportsFastMode,
  withDriver,
  withAuto,
  withEffort,
  withModel,
  withSpeed,
  withOptimisticOverrides,
} from './runtimeChoices'
import { MODELS, defaultModel, effortsFor, modelLabel } from './runtimes'
import { cleanDraft, draftOf, fastFor } from './persona'

const agent = (driver: AgentConfig['driver'], model: string): AgentConfig => ({
  id: `${driver}-${model}`,
  name: model,
  color: '#ffffff',
  character: '',
  driver,
  model,
  effort: 'medium',
  allowedTools: [],
  mcpServers: [],
  memoryScope: false,
  description: '',
  role: '',
  isCos: false,
})

describe('Auto runtime choices', () => {
  it('runs Auto in an untouched chat, and keeps the switch-off as a stored value', () => {
    const persona = agent('codex', 'gpt-5.6-sol')
    // The state every new chat starts in. Nobody has said anything, so Auto decides.
    expect(isAutoOn({}, true)).toBe(true)
    expect(isAutoPending(persona, {}, true)).toBe(true)
    expect(runtimeLabel(persona, {}, true)).toBe('Auto')

    const disabled = withAuto({}, false)
    // Off cannot be an absence any more, or reopening the chat would read it as on.
    expect(disabled).toEqual({ auto: false })
    expect(isPinned(disabled)).toBe(true)
    expect(isAutoOn(disabled, true)).toBe(false)
    expect(isAutoPending(persona, disabled, true)).toBe(false)
    expect(runtimeLabel({ ...persona, model: 'gpt-6-astra', effort: 'high' }, disabled, true)).toBe('GPT-6 Astra, High')
    expect(withAuto(disabled, true)).toEqual({ auto: true })
  })

  it('has no Auto on a host that cannot choose, so an untouched chat names her own model', () => {
    const persona = { ...agent('codex', 'gpt-6-astra'), effort: 'high' as const }
    expect(isAutoOn({}, false)).toBe(false)
    // A switch left on by another host changes nothing here either.
    expect(isAutoOn({ auto: true }, false)).toBe(false)
    expect(isAutoPending(persona, {}, false)).toBe(false)
    expect(runtimeLabel(persona, {}, false)).toBe('GPT-6 Astra, High')
  })

  it('tells its readers when the host answers differently, and only then', () => {
    const heard = vi.fn()
    const stop = subscribeHostAuto(heard)
    try {
      expect(readHostAuto()).toBe(true)
      setHostAuto(true)
      expect(heard).not.toHaveBeenCalled()
      setHostAuto(false)
      expect(readHostAuto()).toBe(false)
      expect(heard).toHaveBeenCalledOnce()
      // An older server leaves the field out, which reads as a host that has Auto.
      parseServerMessage(JSON.stringify({ type: 'host_capabilities', externalBrowser: null }))
      expect(readHostAuto()).toBe(true)
      parseServerMessage(JSON.stringify({ type: 'host_capabilities', externalBrowser: null, auto: false }))
      expect(readHostAuto()).toBe(false)
    } finally {
      stop()
      setHostAuto(true)
    }
  })

  it('reads a runtime picked by hand as Auto off, whether or not the flag is there', () => {
    const persona = agent('codex', 'gpt-5.6-sol')
    // What a pin stored before Auto had a default looks like. Re-deciding it under
    // whoever pinned it is the one thing the default must not do.
    expect(isAutoOn({ model: 'gpt-6-astra' }, true)).toBe(false)
    expect(isAutoOn({ speed: 'fast' }, true)).toBe(false)
    expect(isAutoPending(persona, { driver: 'grok' }, true)).toBe(false)
    // An Auto switched on by hand keeps its pins and stays on; the server snapshots
    // them at the first turn.
    expect(isAutoOn({ auto: true, model: 'gpt-6-astra' }, true)).toBe(true)
  })

  it('leaves a mock persona on her own runtime, the way the server does', () => {
    expect(isAutoPending(agent('mock', ''), {}, true)).toBe(false)
    expect(isAutoPending(agent('mock', ''), { auto: true }, true)).toBe(false)
  })

  it('preserves existing pins and the resolved marker across an Auto toggle cycle', () => {
    const pin = { driver: 'codex' as const, model: 'gpt-5.6-sol', effort: 'medium' as const, autoResolved: true as const }
    expect(withAuto(withAuto(pin, true), false)).toEqual({ ...pin, auto: false })
  })

  it('disables Auto on every manual choice while preserving the once-only marker', () => {
    const persona = agent('codex', 'gpt-5.6-sol')
    const automatic = { ...withAuto({}, true), autoResolved: true as const }
    const manual = [
      withDriver(persona, automatic, 'codex'),
      withModel(persona, automatic, 'gpt-6-astra'),
      withEffort(persona, automatic, 'high'),
      withSpeed(persona, automatic, 'fast'),
    ]
    for (const pin of manual) {
      // A pick reads as off whether it dropped the flag or wrote one, which is the
      // whole point of asking `isAutoOn` rather than the field.
      expect(isAutoOn(pin, true)).toBe(false)
      expect(pin.autoResolved).toBe(true)
      expect(withAuto(pin, true).autoResolved).toBe(true)
    }
  })
})

describe('contextWindow', () => {
  it('uses the active model window for subscription-backed personas', () => {
    expect(contextWindow(agent('claude', 'claude-opus-5-5'))).toBe(1_000_000)
    expect(contextWindow(agent('codex', 'gpt-5.6-sol'))).toBe(258_000)
    expect(contextWindow(agent('codex', 'gpt-6-astra'))).toBe(258_000)
    expect(contextWindow(agent('grok', 'grok-4.6'))).toBe(500_000)
    expect(contextWindow(agent('grok', 'grok-4.7'))).toBe(500_000)
  })

  it('uses a chat model pin before the persona default', () => {
    expect(contextWindow(agent('codex', 'older-model'), { model: 'gpt-5.6-terra' })).toBe(258_000)
  })

  it('reads a pinned provider default rather than the roster model it left behind', () => {
    // The roster model is a Claude id, so measuring against its million-token window
    // while the chat runs on Codex is the lie this rule exists to prevent.
    expect(contextWindow(agent('claude', 'claude-opus-5'), { driver: 'codex' })).toBe(258_000)
    expect(contextWindow(agent('claude', 'claude-opus-5'), { driver: 'grok', model: 'grok-4.5' })).toBe(500_000)
  })
})

describe('Codex catalog', () => {
  it('offers GPT-6.1 and 6.2 models without changing the default or existing pins', () => {
    expect(defaultModel('codex')).toBe('gpt-6-luna')
    expect(MODELS.codex.map((option) => option.value)).toEqual([
      'gpt-6-astra',
      'gpt-6-luna',
      'gpt-6.1-sol',
      'gpt-6.1-terra',
      'gpt-6.2-astra',
      'gpt-6.2-sol',
    ])
    expect(activeModel(agent('codex', 'gpt-6-luna'), { model: 'gpt-6-sol' })).toBe('gpt-6-sol')
    expect(driverForModel('gpt-6.1-sol')).toBe('codex')
    expect(modelLabel('codex', 'gpt-6.1-sol')).toBe('GPT-6.1 Sol')
    expect(contextWindow(agent('codex', 'gpt-6.1-sol'))).toBe(475_000)
    expect(driverForModel('gpt-6.1-terra')).toBe('codex')
    expect(modelLabel('codex', 'gpt-6.1-terra')).toBe('GPT-6.1 Terra')
    expect(contextWindow(agent('codex', 'gpt-6.1-terra'))).toBe(475_000)
    expect(driverForModel('gpt-6.2-sol')).toBe('codex')
    expect(modelLabel('codex', 'gpt-6.2-sol')).toBe('GPT-6.2 Sol')
    expect(contextWindow(agent('codex', 'gpt-6.2-sol'))).toBe(475_000)
    expect(driverForModel('gpt-6.2-astra')).toBe('codex')
    expect(modelLabel('codex', 'gpt-6.2-astra')).toBe('GPT-6.2 Astra')
    expect(contextWindow(agent('codex', 'gpt-6.2-astra'))).toBe(258_000)
  })
})

describe('Claude catalog', () => {
  it('offers Opus 5.5, Sonnet 5.5 and Haiku 5.5 and no longer offers Opus 5 or Sonnet 5', () => {
    expect(MODELS.claude.map((option) => option.value)).toEqual([
      'claude-fable-5-2',
      'claude-haiku-5-5',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
    ])
    expect(driverForModel('claude-opus-5-5')).toBe('claude')
    expect(driverForModel('claude-sonnet-5-5')).toBe('claude')
    expect(driverForModel('claude-haiku-5-5')).toBe('claude')
    expect(contextWindow(agent('claude', 'claude-haiku-5-5'))).toBe(1_000_000)
    expect(modelLabel('claude', 'claude-opus-5')).toBe('Opus 5')
    expect(modelLabel('claude', 'claude-sonnet-5')).toBe('Sonnet 5')
    expect(modelLabel('claude', 'claude-fable-5-1')).toBe('Fable 5.1')
  })
})

describe('a pinned provider', () => {
  it('defaults to Grok 4.7 and routes an explicit pick without changing saved models', () => {
    expect(defaultModel('grok')).toBe('grok-4.7')
    expect(driverForModel('grok-4.7')).toBe('grok')
    const sage = agent('grok', 'grok-4.6')
    expect(activeModel(sage, {})).toBe('grok-4.6')
    const pin = withModel(sage, {}, 'grok-4.7')
    expect(runtimeLabel(sage, pin, true)).toBe('Grok 4.7, Medium')
    expect(activeEffort(sage, { ...pin, effort: 'xhigh' })).toBe('xhigh')
  })

  it('leaves the persona her own settings when nothing is pinned', () => {
    const sage = agent('claude', 'claude-opus-5')
    expect(effectiveDriver(sage, {})).toBe('claude')
    expect(activeModel(sage, {})).toBe('claude-opus-5')
    expect(isPinned({})).toBe(false)
  })

  it('drops the roster model, because it belongs to the other CLI', () => {
    const sage = agent('claude', 'claude-opus-5')
    expect(effectiveDriver(sage, { driver: 'codex' })).toBe('codex')
    expect(activeModel(sage, { driver: 'codex' })).toBe('gpt-6-luna')
    expect(runtimeLabel(sage, { driver: 'codex' }, true)).toBe('GPT-6 Luna, Medium')
  })

  it('is a pin on its own, so the wire and the row both carry it', () => {
    expect(isPinned({ driver: 'grok' })).toBe(true)
    expect(isPinned({ speed: 'fast' })).toBe(true)
  })

  it('offers that provider models, not the persona own and not an unnamed default', () => {
    const sage = agent('claude', 'claude-opus-5')
    expect(modelRowsFor(sage, { driver: 'grok' }).map((row) => row.value)).toEqual([
      'grok-4.5',
      'grok-4.6',
      'grok-4.7',
    ])
    // Unpinned, her own configured model is still the way out of a model pin.
    expect(modelRowsFor(sage, {}).map((row) => row.value)).toContain('claude-opus-5')
  })
})

describe('models turned off in Settings', () => {
  const sage = agent('claude', 'claude-opus-5-5')

  it('leaves a picker, except the model this chat still runs on, which stays marked off', () => {
    const off = ['claude-haiku-5-5', 'claude-opus-5-5']
    expect(modelRowsFor(sage, { model: 'claude-sonnet-5-5' }, off).map((row) => row.value)).toEqual(['claude-fable-5-2', 'claude-sonnet-5-5'])
    expect(modelRowsFor(sage, {}, off)).toEqual([
      { value: 'claude-fable-5-2', label: 'Fable 5.2' },
      { value: 'claude-opus-5-5', label: 'Opus 5.5', off: true },
      { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    ])
  })

  it('drops a provider with every model off unless the chat runs on it, and a switch lands on a model still on', () => {
    const grokOff = MODELS.grok.map((option) => option.value)
    expect(providerRowsFor(sage, {}, grokOff).map((row) => row.value)).toEqual(['claude', 'codex', 'cursor'])
    expect(providerRowsFor(sage, { driver: 'grok' }, grokOff).map((row) => row.value)).toContain('grok')
    expect(withDriver(sage, {}, 'grok', ['grok-4.7'])).toMatchObject({ driver: 'grok', model: 'grok-4.5' })
    // Back to her own provider with her own model off pins one still on.
    expect(withDriver(sage, { driver: 'codex', model: 'gpt-6-luna' }, 'claude', ['claude-opus-5-5'])).toEqual({ model: 'claude-fable-5-2' })
    expect(withDriver(sage, { driver: 'codex', model: 'gpt-6-luna' }, 'claude')).toEqual({})
  })

  it('follows the house settings frame', () => {
    parseServerMessage(JSON.stringify({ type: 'house_settings', settings: { disabledModels: ['grok-4.5'] } }))
    expect(readOffModels()).toEqual(['grok-4.5'])
    parseServerMessage(JSON.stringify({ type: 'house_settings', settings: {} }))
    expect(readOffModels()).toEqual([])
  })
})

describe('optimistic override composition', () => {
  it('replays later whole-value picks over the last server truth', () => {
    expect(withOptimisticOverrides({}, [
      { requestId: 'model', agentId: 'sage', override: { model: 'claude-sonnet-5' } },
      {
        requestId: 'effort',
        agentId: 'sage',
        override: { model: 'claude-sonnet-5', effort: 'low' },
      },
    ])).toEqual({ sage: { model: 'claude-sonnet-5', effort: 'low' } })
  })

  it('keeps a fast-only pin while its request settles', () => {
    expect(withOptimisticOverrides({}, [
      { requestId: 'speed', agentId: 'sage', override: { speed: 'fast' } },
    ])).toEqual({ sage: { speed: 'fast' } })
  })
})

describe('fast mode', () => {
  const codex = agent('codex', 'gpt-5.6-sol')
  const cursor = agent('cursor', 'cursor-grok-4.6')

  it('offers Fast for all Codex models and verified Cursor variants', () => {
    for (const model of [...MODELS.codex.map((row) => row.value), 'future-codex-model', undefined]) {
      expect(supportsFastMode('codex', model)).toBe(true)
    }
    expect(supportsFastMode('cursor', 'cursor-grok-4.6')).toBe(true)
    expect(supportsFastMode('cursor', 'cursor-composer-2.5')).toBe(true)
    expect(supportsFastMode('cursor', 'cursor-gpt-5.6-luna')).toBe(true)
    expect(supportsFastMode('cursor', 'cursor-claude-fable-5-2')).toBe(false)
    expect(supportsFastMode('cursor', 'cursor-gemini-3.8-flash')).toBe(false)
    expect(supportsFastMode('cursor', 'cursor-muse-spark-1.3')).toBe(false)
    expect(supportsFastMode('grok', 'grok-4.6')).toBe(false)
  })

  it('stores Fast and represents Standard by removing that half of the pin', () => {
    expect(withSpeed(cursor, {}, 'fast')).toEqual({ speed: 'fast' })
    expect(activeSpeed(cursor, { speed: 'fast' })).toBe('fast')
    expect(runtimeLabel(cursor, { speed: 'fast' }, true)).toBe('Cursor Grok 4.6, Medium, Fast')
    expect(withSpeed(cursor, { speed: 'fast' }, 'standard')).toEqual({})
    expect(withSpeed(codex, {}, 'fast')).toEqual({ speed: 'fast' })
    expect(withEffort(cursor, { speed: 'fast' }, 'high')).toEqual({ effort: 'high', speed: 'fast' })
  })

  it('keeps Fast across supported picks and drops it before an unsupported model runs', () => {
    expect(withModel(cursor, { speed: 'fast' }, 'cursor-composer-2.5')).toEqual({
      model: 'cursor-composer-2.5',
      speed: 'fast',
    })
    expect(withModel(cursor, { speed: 'fast' }, 'cursor-claude-fable-5-2')).toEqual({
      model: 'cursor-claude-fable-5-2',
    })
    expect(withModel(codex, { speed: 'fast' }, 'gpt-6-astra')).toEqual({ model: 'gpt-6-astra', speed: 'fast' })
    expect(activeSpeed(agent('grok', 'grok-4.6'), { speed: 'fast' })).toBe('standard')
  })

  it('inherits Fast from the persona and keeps an explicit Standard choice through other picks', () => {
    const fast = { ...codex, speed: 'fast' as const }
    expect(activeSpeed(fast, {})).toBe('fast')
    expect(activeSpeed(fast, { autoResolved: true })).toBe('standard')
    expect(differsFromRoster(fast, {})).toBe(false)
    const standard = withSpeed(fast, {}, 'standard')
    expect(standard).toEqual({ speed: 'standard' })
    expect(activeSpeed(fast, standard)).toBe('standard')
    expect(differsFromRoster(fast, standard)).toBe(true)
    expect(isPinned(standard)).toBe(true)
    expect(withEffort(fast, standard, 'high')).toMatchObject({ speed: 'standard' })
    expect(withModel(fast, standard, 'gpt-6-astra')).toMatchObject({ speed: 'standard' })
    expect(withDriver(fast, standard, 'cursor')).toMatchObject({ speed: 'standard' })
    expect(activeSpeed(fast, { driver: 'claude' })).toBe('standard')
    expect(withOptimisticOverrides({}, [{ requestId: 'standard', agentId: fast.id, override: standard }]))
      .toEqual({ [fast.id]: standard })
    expect(activeSpeed(fast, withSpeed(fast, standard, 'fast'))).toBe('fast')
  })

  it('carries a persona Fast default through the edit form, and drops it on a model without Fast', () => {
    const fast = { ...agent('codex', 'gpt-6.1-sol'), speed: 'fast' as const }
    expect(cleanDraft(draftOf(fast)).speed).toBe('fast')
    expect(cleanDraft({ ...draftOf(fast), speed: undefined })).not.toHaveProperty('speed')
    expect(fastFor('cursor', 'cursor-composer-2.5', 'fast')).toBe('fast')
    expect(fastFor('claude', 'claude-opus-5', 'fast')).toBeUndefined()
    expect(fastFor('cursor', 'cursor-muse-spark-1.3', 'fast')).toBeUndefined()
    const afterProviderSwitch = fastFor('claude', 'claude-opus-5', 'fast')
    expect(fastFor('codex', 'gpt-6.1-sol', afterProviderSwitch)).toBeUndefined()
    const afterModelSwitch = fastFor('cursor', 'cursor-muse-spark-1.3', 'fast')
    expect(fastFor('cursor', 'cursor-composer-2.5', afterModelSwitch)).toBeUndefined()
  })

  it('never revives a stale Fast pin when a later provider or model supports it', () => {
    expect(withDriver(agent('claude', 'claude-opus-5'), { speed: 'fast' }, 'cursor')).toEqual({
      driver: 'cursor',
      model: 'cursor-grok-4.6',
    })
    expect(withModel(
      cursor,
      { model: 'cursor-claude-fable-5-2', speed: 'fast' },
      'cursor-composer-2.5',
    )).toEqual({ model: 'cursor-composer-2.5' })
  })
})

describe('picking a provider', () => {
  const sage = agent('claude', 'claude-opus-5')

  it('drops the old provider model, names the new first model, and keeps the effort', () => {
    expect(withDriver(sage, { model: 'claude-sonnet-5', effort: 'max' }, 'codex')).toEqual({
      driver: 'codex',
      model: 'gpt-6-luna',
      effort: 'max',
    })
  })

  it('clears the whole pin when her own provider is picked back', () => {
    // The way out, and on the server the same move that ends the pinned session.
    expect(withDriver(sage, { driver: 'codex', model: 'gpt-5.6-sol' }, 'claude')).toEqual({})
  })

  it('changes nothing when the provider already in charge is picked again', () => {
    const pinned = { driver: 'codex' as const, model: 'gpt-5.6-sol' }
    expect(withDriver(sage, pinned, 'codex')).toBe(pinned)
    expect(withDriver(sage, { model: 'claude-sonnet-5' }, 'claude')).toEqual({ model: 'claude-sonnet-5' })
  })

  it('can still be cleared once her default has caught up with it', () => {
    // A roster edit after the pin leaves the two naming the same provider. Nothing
    // re-normalises that on its own, so the reading side has to treat it as no pin and
    // the clicking side has to keep offering the way out.
    const onCodex: AgentConfig = { ...agent('codex', 'gpt-5.6-sol') }
    const stale = { driver: 'codex' as const }

    // Her own model is hers again, and the roster dot stops pointing at nothing.
    expect(activeModel(onCodex, stale)).toBe('gpt-5.6-sol')
    expect(modelRowsFor(onCodex, stale).map((row) => row.value)).toContain('gpt-5.6-sol')
    expect(differsFromRoster(onCodex, stale)).toBe(false)
    expect(isPinned(stale)).toBe(true)

    // And the click that removes it is not swallowed as a no-op.
    expect(withDriver(onCodex, stale, 'codex')).toEqual({})
    expect(withEffort(onCodex, stale, 'low')).toEqual({ effort: 'low' })
  })

  it('drops only the levels the new provider would silently clamp', () => {
    // Grok's first model is 4.7: it accepts xhigh but still caps max.
    expect(withDriver(sage, { effort: 'max' }, 'grok')).toEqual({
      driver: 'grok',
      model: 'grok-4.7',
    })
    expect(withDriver(sage, { effort: 'xhigh' }, 'grok')).toEqual({
      driver: 'grok',
      model: 'grok-4.7',
      effort: 'xhigh',
    })
    // Everything Grok honours survives, and Codex honours all five.
    expect(withDriver(sage, { effort: 'low' }, 'grok')).toEqual({
      driver: 'grok',
      model: 'grok-4.7',
      effort: 'low',
    })
    expect(withDriver(sage, { effort: 'max' }, 'codex')).toEqual({
      driver: 'codex',
      model: 'gpt-6-luna',
      effort: 'max',
    })
  })

  it('shows the level that will actually run, not the one that was picked', () => {
    // A persona configured at Max, pinned to Grok: High is what the CLI does, so High
    // is what the label says.
    const deep: AgentConfig = { ...agent('claude', 'claude-opus-5'), effort: 'max' }
    expect(activeEffort(deep, { driver: 'grok' })).toBe('high')
    expect(activeEffort(deep, {})).toBe('max')
    expect(effortsFor('grok', 'grok-4.6').map((option) => option.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    expect(effortsFor('grok', 'grok-4.7')).toEqual(effortsFor('grok', 'grok-4.6'))
    expect(effortsFor('grok', 'grok-4.5').map((option) => option.value)).toEqual([
      'low',
      'medium',
      'high',
    ])
  })

  it('keeps the provider through a later model or effort pick', () => {
    expect(withModel(sage, { driver: 'codex' }, 'gpt-5.6-sol')).toEqual({
      driver: 'codex',
      model: 'gpt-5.6-sol',
    })
    expect(withEffort(sage, { driver: 'codex' }, 'low')).toEqual({ driver: 'codex', effort: 'low' })
    expect(withEffort(sage, { driver: 'codex', speed: 'fast' }, 'low')).toEqual({
      driver: 'codex',
      effort: 'low',
      speed: 'fast',
    })
  })

  it.each(['grok-4.6', 'grok-4.7'])('drops Extra when a Grok chat switches from %s to 4.5', (model) => {
    expect(withModel(sage, { driver: 'grok', model, effort: 'xhigh' }, 'grok-4.5')).toEqual({
      driver: 'grok',
      model: 'grok-4.5',
    })
  })

  it('names the picked model under a pinned provider rather than leaving it blank', () => {
    expect(withModel(sage, { driver: 'codex', model: 'gpt-5.6-sol' }, 'gpt-6-luna')).toEqual({
      driver: 'codex',
      model: 'gpt-6-luna',
    })
    // Her own model id is not the way out under a pinned provider: it is a Claude id
    // being picked under Codex, which only happens if a list offered it wrongly.
    expect(withModel(sage, { driver: 'codex' }, 'claude-opus-5')).toEqual({
      driver: 'codex',
      model: 'claude-opus-5',
    })
  })

  it('treats the driver first model as the way out for a persona with no roster model', () => {
    const blank: AgentConfig = { ...agent('claude', 'claude-opus-5'), model: undefined }

    expect(modelRowsFor(blank, { model: 'claude-sonnet-5' }).map((row) => row.value)).not.toContain(undefined)
    expect(withModel(blank, { model: 'claude-sonnet-5' }, defaultModel('claude'))).toEqual({})
  })
})
