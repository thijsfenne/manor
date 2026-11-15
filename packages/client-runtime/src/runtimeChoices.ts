import {
  SINGLE_CHAT_VOICE,
  SingleRuntimeSchema,
  autoRequested,
  contextWindowFor,
  effectiveSpeed,
  supportsFastMode,
  type AgentConfig,
  type ChatOverride,
  type DriverName,
  type Effort,
  type SingleRuntime,
} from '@manor/contracts'
import { EFFORTS, MODELS, PROVIDERS, defaultModel, effortsFor, modelLabel, type Option } from './runtimes'

/**
 * The rules behind the composer's runtime controls, kept out of the components
 * because two surfaces render them: one menu per persona while the chat is small,
 * and a folded roster panel once it is not. Two copies of "what does picking this
 * mean" is how the two surfaces would quietly start disagreeing.
 */

export interface ModelRow {
  value: string
  label: string
}

export { SINGLE_DRIVERS, defaultSingleRuntime, isSingleDriver } from '@manor/contracts'

export function readSingleRuntime(override: ChatOverride | undefined, fallback: SingleRuntime): SingleRuntime {
  const parsed = SingleRuntimeSchema.safeParse(override)
  return parsed.success ? parsed.data : fallback
}

/** The anonymous runtime as the existing picker primitives expect to receive it. */
export function singleRuntimeVoice(runtime: SingleRuntime): AgentConfig {
  return {
    ...SINGLE_CHAT_VOICE,
    color: '',
    character: '',
    driver: runtime.driver,
    model: runtime.model,
    effort: runtime.effort,
    ...(runtime.speed === 'fast' ? { speed: 'fast' as const } : {}),
    allowedTools: [],
    mcpServers: [],
    memoryScope: false,
    description: '',
    role: '',
    isCos: false,
  }
}

export type RuntimeSpeed = 'standard' | 'fast'

/**
 * Whether the host this client talks to has Auto at all. A fact about the one host,
 * not about a chat, so it is one small store instead of a field on every override.
 * The connection sets it from `host_capabilities`, which the server sends before the
 * directory. A screen reads it with `useSyncExternalStore` and hands it to the
 * functions below as `hostAuto`, so they stay pure and a changed answer redraws.
 */
let hostAuto = true
const hostAutoListeners = new Set<() => void>()
export const readHostAuto = (): boolean => hostAuto
export function subscribeHostAuto(listener: () => void): () => void {
  hostAutoListeners.add(listener)
  return () => { hostAutoListeners.delete(listener) }
}
export function setHostAuto(available: boolean): void {
  if (available === hostAuto) return
  hostAuto = available
  for (const listener of hostAutoListeners) listener()
}

/**
 * Whether Auto is armed for this persona in this chat. Undecided reads as on here,
 * because a chat nobody has touched is the one Auto exists for; the server fills the
 * same gap in with its own conditions.
 */
export const isAutoOn = (override: ChatOverride, hostAuto: boolean): boolean => hostAuto && (autoRequested(override) ?? true)

/**
 * Auto has not chosen a provider yet, so showing the current provider would lie.
 * The persona is the other half of the question: the server skips a mock persona, so
 * her own runtime is what runs and the label says so. Side chats hand in an override
 * that says `auto: false`, the same value their own picks write. Single can run Auto
 * until the first turn resolves.
 */
export const isAutoPending = (agent: AgentConfig, override: ChatOverride, hostAuto: boolean): boolean =>
  isAutoOn(override, hostAuto) && override.autoResolved !== true && agent.driver !== 'mock'

/**
 * Auto leaves runtime pins untouched; the server snapshots settings at the first turn.
 * Both values are written rather than off being an absence: absent is what an untouched
 * chat carries and that now means on, so a switch-off with nothing behind it would read
 * back as on the next time the chat is opened.
 */
export function withAuto(override: ChatOverride, enabled: boolean): ChatOverride {
  return { ...override, auto: enabled }
}

export { supportsFastMode }

/** What the chat actually asks for; unsupported stale pins always read as Standard. */
export function activeSpeed(agent: AgentConfig, override: ChatOverride): RuntimeSpeed {
  return effectiveSpeed(agent, override) ?? 'standard'
}

/**
 * The pin's provider, or nothing when it names the one she is already on.
 *
 * A pin equal to the roster value is not a pin, and saying so in one place is what
 * keeps a reachable dead end out of the menu: pin a chat to Codex, later make Codex
 * her default, and the Codex row is both the selection and the default, with nothing
 * left to click that removes the pin. Everything downstream of a *pinned* provider —
 * the model rows, the way out, whether she counts as off her own settings — reads this
 * rather than `override.driver`, so the redundant state simply is not one. The server's
 * merge holds the same rule, where the same pin would otherwise keep suppressing her
 * roster model.
 */
export const pinnedDriver = (agent: AgentConfig, override: ChatOverride): DriverName | undefined =>
  override.driver === agent.driver ? undefined : override.driver

/** The provider this chat runs her on, which every other choice here reads first. */
export const effectiveDriver = (agent: AgentConfig, override: ChatOverride): DriverName =>
  override.driver ?? agent.driver

/**
 * A pinned provider takes the persona's own model with it, exactly as the server's
 * merge does and as the persona form does when the provider changes there: a model
 * id belongs to one CLI, so hers means nothing under another one. An unpinned
 * model under a pinned provider, or a leftover persona with none, names that
 * driver's default model rather than an unnamed default.
 */
export const activeModel = (agent: AgentConfig, override: ChatOverride): string | undefined =>
  override.model ??
  (pinnedDriver(agent, override) === undefined ? agent.model : undefined) ??
  defaultModel(effectiveDriver(agent, override))

/**
 * A pinned effort the effective model does not honour is not what will run. Shown as
 * what the CLI will actually do, so the label agrees with the turn rather than with
 * the pick.
 */
export const activeEffort = (agent: AgentConfig, override: ChatOverride): Effort => {
  const chosen = override.effort ?? agent.effort
  const offered = effortsFor(effectiveDriver(agent, override), activeModel(agent, override))
  return offered.some((option) => option.value === chosen) ? chosen : 'high'
}

/**
 * The usable context of what this chat actually runs her on, provider pin included.
 * The table itself lives in `@manor/contracts`, because the server measures against
 * it too: the note a routine posts when its thread crosses two thirds of the window
 * is decided where the run finishes, and two copies of these numbers would be two
 * things to keep in agreement. Every reader marks the result as an estimate.
 *
 * Here rather than beside that table's other reader, so it reads the pin through the
 * same two rules every label does: a provider pinned without a model is that
 * provider's default window, never the roster model's.
 */
export const contextWindow = (agent: AgentConfig, override: ChatOverride = {}): number =>
  contextWindowFor(effectiveDriver(agent, override), activeModel(agent, override))

/**
 * True when this override carries anything at all. Structural, and the question the
 * new-chat draft asks: an override with nothing in it has no key on the wire.
 */
export const isPinned = (override: ChatOverride): boolean =>
  override.driver !== undefined ||
  override.model !== undefined ||
  override.effort !== undefined ||
  override.speed !== undefined ||
  // Either value, because switching Auto off is itself a decision this chat holds.
  override.auto !== undefined ||
  override.autoResolved === true

/**
 * True when this chat is actually running her on something other than her own
 * settings, which is the question a badge answers. Not the same as `isPinned`: a pin
 * naming the provider she is already on is a leftover, not a difference, and marking
 * her as off her own settings for it would be a dot pointing at nothing.
 */
export const differsFromRoster = (agent: AgentConfig, override: ChatOverride): boolean =>
  pinnedDriver(agent, override) !== undefined ||
  override.model !== undefined ||
  override.effort !== undefined ||
  activeSpeed(agent, override) !== activeSpeed(agent, {})

/**
 * What this chat runs her on, kept apart because the interface weights the model
 * and its reasoning/speed qualifiers differently. `RuntimeLabel` renders the parts.
 */
export function runtimeParts(
  agent: AgentConfig,
  override: ChatOverride,
  hostAuto: boolean,
): { model: string; effort: string; speed?: 'Fast' } {
  if (isAutoPending(agent, override, hostAuto)) return { model: 'Auto', effort: '' }
  const effort = activeEffort(agent, override)
  const speed = activeSpeed(agent, override)
  return {
    model: modelLabel(effectiveDriver(agent, override), activeModel(agent, override)),
    effort: EFFORTS.find((option) => option.value === effort)?.label ?? effort,
    ...(speed === 'fast' ? { speed: 'Fast' as const } : {}),
  }
}

/** The runtime parts as one string for a title or screen reader, with Fast when active. */
export function runtimeLabel(agent: AgentConfig, override: ChatOverride, hostAuto: boolean): string {
  const { model, effort, speed } = runtimeParts(agent, override, hostAuto)
  return [model, effort, speed].filter((part) => part !== undefined && part !== '').join(', ')
}

/**
 * The providers this persona's menu offers. The mock is configuration, not a thing
 * to put a live thread on by accident, so it is offered only to a persona who is
 * already on it — where it is the way out of a pin and has to have its row.
 */
export function providerRowsFor(agent: AgentConfig): Option<DriverName>[] {
  return PROVIDERS.filter((option) => option.value !== 'mock' || agent.driver === 'mock')
}

/**
 * The model rows this persona's menu offers, for the provider this chat runs her on.
 * A persona can be configured with a model the curated list does not know (typed
 * before the list existed, or added to a CLI since). That value gets its own row,
 * because the roster value is the way out of a pin: without its row, a pin could
 * never be cleared.
 *
 * Under a pinned provider none of that applies, her own model belongs to the other
 * CLI, so the list is that provider's. There is no unnamed default row. The driver's
 * default model is what a switch lands on, and a leftover provider-only pin shows
 * it as selected.
 */
export function modelRowsFor(agent: AgentConfig, override: ChatOverride = {}): ModelRow[] {
  const models = MODELS[effectiveDriver(agent, override)]
  const own = pinnedDriver(agent, override) === undefined ? agent.model : undefined
  if (own !== undefined && !models.some((option) => option.value === own)) {
    return [{ value: own, label: own }, ...models]
  }
  return models
}

/**
 * The whole next override after picking a provider. The model does not travel to a
 * CLI that has never heard of it, so a switch lands on the new provider's default
 * model, named, and the next model pick is a fresh choice from its own list.
 *
 * Effort survives where the new model honours it. It is one shared field by design
 * rather than a per-provider id, so resetting it on every switch would throw away a
 * deliberate setting; dropping only what would be silently clamped keeps the stored
 * pin equal to what actually runs.
 *
 * Picking the persona's own provider back drops the whole provider half, which is
 * what makes her own row the way out, and on the server is what stops her pinned
 * session being resumed and hands the thread back to her own CLI.
 */
export function withDriver(
  agent: AgentConfig,
  override: ChatOverride,
  value: DriverName,
): ChatOverride {
  // Picking the row that is already *pinned* changes nothing, rather than dropping a
  // model pin under it: a stray click on the current provider should cost nothing.
  // Deliberately not "already effective", which would also swallow the click that
  // clears a pin naming the provider she has since been given as her default — the one
  // click that has to keep working, because it is the only way out of that state.
  if (value === effectiveDriver(agent, override) && pinnedDriver(agent, override) === override.driver) {
    // A stray click on the current provider costs nothing, except that it is still a
    // pick: an Auto switched on by hand is switched off by it.
    return override.auto === true ? { ...override, auto: false } : override
  }
  // A pinned level the new provider's default model does not honour goes with the old
  // model, for the same reason: keeping it would store a setting that quietly becomes
  // another one. Grok's default is 4.7, so a switch to Grok still accepts xhigh.
  const nextModel = defaultModel(value)
  const keepsEffort =
    override.effort !== undefined && effortsFor(value, nextModel).some((option) => option.value === override.effort)
  const keepsSpeed = activeSpeed(agent, override) === 'fast' && supportsFastMode(value, nextModel)
  return {
    ...(value === agent.driver
      ? {}
      : { driver: value, ...(nextModel === undefined ? {} : { model: nextModel }) }),
    ...(keepsEffort ? { effort: override.effort } : {}),
    ...speedPin(agent, keepsSpeed, value, value === agent.driver ? agent.model : nextModel),
    ...(override.autoResolved ? { autoResolved: true } : {}),
  }
}

/**
 * The whole next override after picking a model. Picking the persona's own value
 * back drops that half of the pin, which is what makes her roster model the way out.
 * A leftover persona with no roster model treats the driver's default model
 * as that value, the same as the persona form does on open. Under a pinned provider
 * her own value is not on offer at all, so anything picked there is a pin.
 */
export function withModel(
  agent: AgentConfig,
  override: ChatOverride,
  value: string | undefined,
): ChatOverride {
  const pinned = pinnedDriver(agent, override)
  const ownModel = pinned === undefined ? (agent.model ?? defaultModel(agent.driver)) : undefined
  const keepsEffort =
    override.effort !== undefined &&
    effortsFor(effectiveDriver(agent, override), value).some((option) => option.value === override.effort)
  const keepsSpeed =
    activeSpeed(agent, override) === 'fast' && supportsFastMode(effectiveDriver(agent, override), value)
  return {
    ...(pinned === undefined ? {} : { driver: pinned }),
    ...(value === ownModel || value === undefined ? {} : { model: value }),
    ...(keepsEffort ? { effort: override.effort } : {}),
    ...speedPin(agent, keepsSpeed, effectiveDriver(agent, override), value),
    ...(override.autoResolved ? { autoResolved: true } : {}),
  }
}

/** The same, for reasoning effort. Drops a leftover provider half the way the others do. */
export function withEffort(agent: AgentConfig, override: ChatOverride, value: Effort): ChatOverride {
  const pinned = pinnedDriver(agent, override)
  const keepsSpeed = activeSpeed(agent, override) === 'fast'
  return {
    ...(pinned === undefined ? {} : { driver: pinned }),
    ...(override.model === undefined ? {} : { model: override.model }),
    ...(value === agent.effort ? {} : { effort: value }),
    ...speedPin(agent, keepsSpeed, effectiveDriver(agent, override), activeModel(agent, override)),
    ...(override.autoResolved ? { autoResolved: true } : {}),
  }
}

/** Standard needs an explicit pin only when the persona defaults to Fast. */
function speedPin(agent: AgentConfig, fast: boolean, driver: DriverName, model: string | undefined): Pick<ChatOverride, 'speed'> {
  if (!supportsFastMode(driver, model)) return {}
  if (fast) return { speed: 'fast' }
  return agent.speed === 'fast' ? { speed: 'standard' } : {}
}

/** Changes speed without changing the other runtime choices. */
export function withSpeed(
  agent: AgentConfig,
  override: ChatOverride,
  value: RuntimeSpeed,
): ChatOverride {
  const pinned = pinnedDriver(agent, override)
  const keepsSpeed =
    value === 'fast' &&
    supportsFastMode(effectiveDriver(agent, override), activeModel(agent, override))
  return {
    ...(pinned === undefined ? {} : { driver: pinned }),
    ...(override.model === undefined ? {} : { model: override.model }),
    ...(override.effort === undefined ? {} : { effort: override.effort }),
    ...speedPin(agent, keepsSpeed, effectiveDriver(agent, override), activeModel(agent, override)),
    ...(override.autoResolved ? { autoResolved: true } : {}),
  }
}

/**
 * The whole override set after one persona changed, for the new-chat stage, which
 * keeps its pins locally until `create_chat` carries them. An emptied override
 * drops its key, so "no pins" has exactly one representation on the wire.
 */
export function withOverride(
  overrides: Record<string, ChatOverride>,
  agentId: string,
  override: ChatOverride,
): Record<string, ChatOverride> {
  const next = { ...overrides }
  if (isPinned(override)) next[agentId] = override
  else delete next[agentId]
  return next
}

export { withOptimisticOverrides, type OptimisticChatOverride } from './optimisticOverrides'
