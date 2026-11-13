import type { AgentConfig, Effort } from './index.js'

export interface Option<T extends string> {
  value: T
  label: string
}

/** Alphabetical by label within a provider. Empty for the mock, which never reaches a model at all. */
export const MODELS: Record<AgentConfig['driver'], Option<string>[]> = {
  claude: [
    { value: 'claude-fable-5-2', label: 'Fable 5.2' },
    { value: 'claude-haiku-5-5', label: 'Haiku 5.5' },
    { value: 'claude-opus-5-5', label: 'Opus 5.5' },
    { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  ],
  codex: [
    { value: 'gpt-6-astra', label: 'GPT-6 Astra' },
    { value: 'gpt-6-luna', label: 'GPT-6 Luna' },
    { value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    { value: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' },
  ],
  grok: [
    { value: 'grok-4.5', label: 'Grok 4.5' },
    { value: 'grok-4.6', label: 'Grok 4.6' },
    { value: 'grok-4.7', label: 'Grok 4.7' },
  ],
  cursor: [
    { value: 'cursor-claude-fable-5-2', label: 'Claude Fable 5.2' },
    { value: 'cursor-claude-opus-5-5', label: 'Claude Opus 5.5' },
    { value: 'cursor-claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { value: 'cursor-grok-4.6', label: 'Cursor Grok 4.6' },
    { value: 'cursor-grok-4.7', label: 'Cursor Grok 4.7' },
    { value: 'cursor-muse-wonder-1.0', label: 'Muse Wonder' },
  ],
  mock: [],
}

const DEFAULT_MODELS: Record<AgentConfig['driver'], string | undefined> = {
  claude: 'claude-fable-5-2',
  codex: 'gpt-6-luna',
  grok: 'grok-4.7',
  cursor: 'cursor-grok-4.6',
  mock: undefined,
}

/**
 * What a driver runs when nobody has said otherwise. Named per driver rather than
 * read off the list, which is sorted for reading. The menus no longer offer "whatever
 * the CLI defaults to": that setting was a label that could not say which model
 * answered. The mock driver reaches no provider and has none.
 */
export const defaultModel = (driver: AgentConfig['driver']): string | undefined => DEFAULT_MODELS[driver]

const LEGACY_MODEL_LABELS: Record<string, string> = {
  'claude-fable-5-1': 'Fable 5.1',
  'cursor-claude-fable-5-1': 'Claude Fable 5.1',
  'claude-opus-5': 'Opus 5',
  'claude-sonnet-5': 'Sonnet 5',
  'cursor-claude-opus-5': 'Claude Opus 5',
  'cursor-composer-2.5': 'Composer 2.5',
  'cursor-muse-spark-1.3': 'Muse Spark 1.3',
  'cursor-gemini-3.8-flash': 'Gemini 3.8 Flash',
  'cursor-kimi-k3': 'Kimi K3',
  'cursor-glm-5.2': 'GLM 5.2',
  'cursor-gpt-5.6-luna': 'GPT-5.6 Luna',
  'cursor-gpt-5.6-sol': 'GPT-5.6 Sol',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'gpt-5.6-sol': 'GPT-5.6 Sol',
}

/** The label the composer shows for a model id the options list does not know. */
export const modelLabel = (driver: AgentConfig['driver'], model: string | undefined): string => {
  const id = model ?? defaultModel(driver)
  if (id === undefined) return 'No model'
  return MODELS[driver].find((option) => option.value === id)?.label ?? LEGACY_MODEL_LABELS[id] ?? id
}

export const EFFORTS: Option<Effort>[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra' },
  { value: 'max', label: 'Max' },
]

/**
 * The levels one model actually honours. Grok 4.6 and 4.7 offer Extra; 4.5 stops at High,
 * and no Grok model accepts Max. Offering a level the driver will lower is a
 * setting that lies, so the model joins the provider in this lookup.
 */
export const effortsFor = (driver: AgentConfig['driver'], model?: string): Option<Effort>[] => {
  if (driver === 'grok') {
    const supportsXhigh = model === undefined || model === 'grok-4.6' || model === 'grok-4.7'
    return EFFORTS.filter((option) => option.value !== 'max' && (supportsXhigh || option.value !== 'xhigh'))
  }
  if (driver !== 'cursor') return EFFORTS
  if (model === 'cursor-composer-2.5') return EFFORTS.filter((option) => option.value === 'high')
  if (model === 'cursor-grok-4.6' || model === 'cursor-grok-4.7') return EFFORTS.filter((option) => option.value !== 'max')
  if (model === 'cursor-gemini-3.8-flash') {
    return EFFORTS.filter((option) => option.value === 'low' || option.value === 'medium' || option.value === 'high')
  }
  if (model === 'cursor-kimi-k3') {
    return EFFORTS.filter((option) => option.value === 'low' || option.value === 'high' || option.value === 'max')
  }
  if (model === 'cursor-glm-5.2') {
    return EFFORTS.filter((option) => option.value === 'high' || option.value === 'max')
  }
  return EFFORTS
}

/** True when this model would quietly turn the chosen level into a lower one. */
export const clampsEffort = (driver: AgentConfig['driver'], effort: Effort, model?: string): boolean =>
  !effortsFor(driver, model).some((option) => option.value === effort)
