import {
  SINGLE_CHAT_VOICE,
  SingleRuntimeSchema,
  autoRequested,
  defaultSingleRuntime,
  driverForModel,
  type AgentConfig,
  type ChatOverride,
  type RoutineDraft,
  type SingleRuntime,
} from '@manor/contracts'

/** A hand pick, or Auto switched off, still needs a complete Single runtime. */
export const singleRuntimeRequired = (override: ChatOverride | undefined): boolean =>
  autoRequested(override) === false

export function singleRoutineRuntime(routine: RoutineDraft) {
  if (routine.chatId !== null) {
    throw new Error('A single-agent routine creates its own runs and cannot target a direct message.')
  }
  return singleRuntime({
    driver: driverForModel(routine.model ?? ''),
    model: routine.model ?? undefined,
    effort: routine.effort ?? undefined,
  })
}

/** Validate before creation and before changing a pin, never fall back to a persona. */
export function singleRuntime(override: ChatOverride | undefined) {
  const result = SingleRuntimeSchema.safeParse(override)
  if (!result.success) throw new Error('Choose a provider, model and effort for this session.')
  const runtime = result.data
  if (driverForModel(runtime.model) !== runtime.driver) {
    throw new Error('The selected model does not belong to the selected provider.')
  }
  return runtime
}

export function singleAgentFor(
  override: ChatOverride | undefined,
  agents: readonly AgentConfig[] = [],
): AgentConfig {
  const parsed = SingleRuntimeSchema.safeParse(override)
  if (parsed.success && driverForModel(parsed.data.model) === parsed.data.driver) {
    return buildSingleAgent(parsed.data)
  }
  if (singleRuntimeRequired(override)) {
    throw new Error('Choose a provider, model and effort for this session.')
  }
  return buildSingleAgent(defaultSingleRuntime(agents))
}

function buildSingleAgent(runtime: SingleRuntime): AgentConfig {
  return {
    ...SINGLE_CHAT_VOICE,
    driver: runtime.driver,
    model: runtime.model,
    effort: runtime.effort,
    ...(runtime.speed === 'fast' ? { speed: 'fast' as const } : {}),
    color: '',
    character: [
      'Help the user with their request. This is a single session without Manor personas, with access to the user’s memory.',
      // Drivers that hold delegate_task get the shared subagent rule from the turn runner.
      ...(runtime.driver === 'cursor' ? ['Delegate bounded independent parts of substantial work to manor-helper when parallel work or separate context materially helps; handle short or sequential tasks yourself. It inherits this session model; do not use specialized built-in subagents. Only report subagent work that actually ran.'] : []),
      'Do not summon Manor personas or use agent messaging. Agent mentions in quoted text are ordinary text.',
      'For a Work handoff, the user’s accepted Single mode takes precedence over persona assignments in the kickoff. Carry out the substantive task and keep its constraints; instructions to start as, delegate to, or confirm a proposed Manor persona do not apply. Judge completion against the task in Single mode, and report the actual runtime honestly. Never claim a proposed persona ran or a check passed without evidence.',
      'Skills selected by the user are supplied for this turn. Follow their instructions when relevant to the request.',
    ].join('\n'),
    allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Agent', 'Task'],
    mcpServers: [],
    skillIds: [],
    mentionAllowlist: [],
    memoryScope: true,
    description: '',
    role: '',
    isCos: false,
  }
}
