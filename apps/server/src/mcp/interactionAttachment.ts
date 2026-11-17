import type { AttachedMcpServer } from '@manor/contracts'
import type { SubagentToolCatalog } from './interactionServer.js'

export const USER_INPUT_CAPABILITY_ENV = 'MANOR_USER_INPUT_CAPABILITY'
export const BUILT_IN_INTERACTION_MCP_NAME = 'manor'
export const INTERACTION_TOOL_NAMES = [
  'ask_user', 'request_secret', 'prepare_outbound_draft', 'message_agent',
  'delegate_task', 'task_result', 'task_cancel', 'subagent_capabilities',
  'deliver_file', 'goal_reached', 'review_passed',
  'update_project_file', 'update_notes', 'answer_session_question', 'report_to_project', 'send_to_session', 'set_session_status',
  'write_instructions', 'offer_instructions_line',
] as const
export const SUBAGENT_TOOLS = ['delegate_task', 'task_result', 'task_cancel', 'subagent_capabilities'] as const

/**
 * How `ask_user` and `request_secret` return on each driver. Claude Code waits up to ~27.8 h on an MCP
 * call and Grok up to its configured `tool_timeouts`, so they hold the call. Codex
 * runs tools in code-mode cells that hand control back after ~30 s, and Cursor's MCP
 * client times a call out after 60 s; there the call returns at once and the answer
 * starts the turn's next attempt.
 */
export const askModeFor = (driver: string | undefined): 'blocking' | 'deferred' =>
  driver === 'codex' || driver === 'cursor' ? 'deferred' : 'blocking'

/**
 * The launch call Manor records itself, as a `spawn_subagent` row with its child
 * thread. Every driver reports the raw MCP call too; that duplicate is dropped.
 */
export const isSubagentLaunchTool = (tool: string): boolean =>
  ['delegate_task', `${BUILT_IN_INTERACTION_MCP_NAME}__delegate_task`, `mcp__${BUILT_IN_INTERACTION_MCP_NAME}__delegate_task`]
    .includes(tool.toLowerCase())

export function interactionMcpAttachment(
  brokerUrl: string,
  capability: string,
  runtime: {
    draftBrokerUrl?: string
    relayBrokerUrl?: string
    subagentBrokerUrl?: string
    deliverBrokerUrl?: string
    goalBrokerUrl?: string
    secretBrokerUrl?: string
    projectBrokerUrl?: string
    instructionsBrokerUrl?: string
    allowAsk?: boolean
    /** A turn with the user present, outside a project thread's own decisions: the secret card. */
    allowSecret?: boolean
    /** `deferred` where the driver's tool calls time out before the user answers; see `AskMode`. */
    askMode?: 'blocking' | 'deferred'
    allowDraft?: boolean
    allowRelay?: boolean
    /**
     * What this turn may delegate to; absent means no subagent tools. An empty model
     * list withholds only delegate_task, so children already running stay collectable.
     */
    subagents?: SubagentToolCatalog
    /** Off where the user would never see the result: quiet routine fires and agent pairs. */
    allowDeliver?: boolean
    /** Only the goal owner's turn in a goal Session; the call itself ends that chain. */
    allowGoal?: boolean
    /** Only Argus's turn in a goal Session; a passed review unlocks `goal_reached`. */
    allowReview?: boolean
    /** A project thread turn writes its two files (2026-10-10). */
    allowProjectFiles?: boolean
    /** A DM or group turn of an agent with memory on keeps its own notes with `update_notes`. */
    allowNotes?: boolean
    /** A project thread turn answers its sessions' questions from preferences. */
    allowSessionAnswer?: boolean
    /** Only a project thread turn the user's own message started sends it on to a Session. */
    allowSessionForward?: boolean
    /** A chat persona reports preferences to a project thread instead of writing them. */
    allowProjectReport?: boolean
    /** The goal turn of a Session in a project with a thread writes its own notes.md line. */
    allowSessionStatus?: boolean
    /** Only a new agent's interview turn writes its instructions, once. */
    allowInstructions?: boolean
    /** A memory-off persona's attended turn offers a lasting rule as a line for its instructions. */
    allowInstructionsOffer?: boolean
    relayMode?: 'async' | 'sync'
  } = {},
): AttachedMcpServer {
  const draftUrl = runtime.draftBrokerUrl ?? brokerUrl.replace(/\/internal\/user-input$/, '/internal/outbound-draft')
  const relayUrl = runtime.relayBrokerUrl ?? brokerUrl.replace(/\/internal\/user-input$/, '/internal/agent-relay')
  const subagentUrl = runtime.subagentBrokerUrl ?? brokerUrl.replace(/\/internal\/user-input$/, '/internal/subagent')
  const subagents = runtime.subagents
  const mayStart = subagents !== undefined && subagents.models.length > 0
  const deliverUrl = runtime.deliverBrokerUrl ?? brokerUrl.replace(/\/internal\/user-input$/, '/internal/deliver-file')
  const goalUrl = runtime.goalBrokerUrl ?? brokerUrl.replace(/\/internal\/user-input$/, '/internal/goal-claims')
  const secretUrl = runtime.secretBrokerUrl ?? brokerUrl.replace(/\/internal\/user-input$/, '/internal/secret-request')
  const projectUrl = runtime.projectBrokerUrl ?? brokerUrl.replace(/\/internal\/user-input$/, '/internal/project-thread')
  const instructionsUrl = runtime.instructionsBrokerUrl ?? brokerUrl.replace(/\/internal\/user-input$/, '/internal/agent-instructions')
  const enabledTools = [
    ...(runtime.allowAsk === false ? [] : ['ask_user']),
    ...(runtime.allowSecret === true ? ['request_secret'] : []),
    ...(runtime.allowDraft === false ? [] : ['prepare_outbound_draft']),
    ...(runtime.allowRelay === true ? ['message_agent'] : []),
    ...(subagents === undefined ? [] : SUBAGENT_TOOLS.filter((tool) => mayStart || tool !== 'delegate_task')),
    ...(runtime.allowDeliver === true ? ['deliver_file'] : []),
    ...(runtime.allowGoal === true ? ['goal_reached'] : []),
    ...(runtime.allowReview === true ? ['review_passed'] : []),
    ...(runtime.allowProjectFiles === true ? ['update_project_file'] : []),
    ...(runtime.allowNotes === true ? ['update_notes'] : []),
    ...(runtime.allowSessionAnswer === true ? ['answer_session_question'] : []),
    ...(runtime.allowSessionForward === true ? ['send_to_session'] : []),
    ...(runtime.allowProjectReport === true ? ['report_to_project'] : []),
    ...(runtime.allowSessionStatus === true ? ['set_session_status'] : []),
    ...(runtime.allowInstructions === true ? ['write_instructions'] : []),
    ...(runtime.allowInstructionsOffer === true ? ['offer_instructions_line'] : []),
  ]
  return {
    server: {
      id: 'builtin_manor',
      name: BUILT_IN_INTERACTION_MCP_NAME,
      command: '',
      args: [
        '--broker-url',
        brokerUrl,
        '--draft-url',
        draftUrl,
        '--relay-url',
        relayUrl,
        '--subagent-url',
        subagentUrl,
        ...(subagents === undefined ? [] : ['--subagent-catalog', JSON.stringify(subagents)]),
        '--deliver-url',
        deliverUrl,
        '--goal-url',
        goalUrl,
        '--project-url',
        projectUrl,
        '--secret-url',
        secretUrl,
        ...(runtime.allowInstructions === true || runtime.allowInstructionsOffer === true ? ['--instructions-url', instructionsUrl] : []),
        ...(runtime.allowRelay === true ? ['--relay-mode', runtime.relayMode ?? 'async'] : []),
        ...((runtime.allowAsk !== false || runtime.allowSecret === true) && runtime.askMode === 'deferred' ? ['--ask-mode', 'deferred'] : []),
        ...enabledTools.flatMap((tool) => ['--tool', tool]),
      ],
      envKeys: [],
      description: [
        ...(runtime.allowAsk === false ? [] : ['Ask the user a short question.']),
        ...(runtime.allowSecret === true ? ['Ask the user for a login, code or token on a private card with request_secret.'] : []),
        ...(runtime.allowDraft === false ? [] : ['Prepare an outbound draft.']),
        ...(runtime.allowRelay === true ? ['Consult an allowed agent in this workspace with message_agent.'] : []),
        ...(subagents === undefined ? [] : [mayStart
          ? 'Delegate a task to a subagent on another model with delegate_task.'
          : 'Collect or cancel subagents started earlier with task_result and task_cancel.']),
        ...(runtime.allowDeliver === true ? ['Hand the user a finished file with deliver_file.'] : []),
        ...(runtime.allowGoal === true ? ['Mark this Session\'s goal reached with goal_reached.'] : []),
        ...(runtime.allowReview === true ? ['Pass a clean review of this Session\'s diff with review_passed.'] : []),
        ...(runtime.allowProjectFiles === true ? ['Write this project\'s preferences.md and notes.md with update_project_file.'] : []),
        ...(runtime.allowNotes === true ? ['Keep your own standing notes with update_notes.'] : []),
        ...(runtime.allowSessionAnswer === true ? ['Answer a waiting session question from preferences with answer_session_question.'] : []),
        ...(runtime.allowSessionForward === true ? ['Send the user\'s follow-up on to the Session it is about with send_to_session.'] : []),
        ...(runtime.allowProjectReport === true ? ['Report a preference to its project thread with report_to_project.'] : []),
        ...(runtime.allowSessionStatus === true ? ['Keep this Session\'s status line in notes.md with set_session_status.'] : []),
        ...(runtime.allowInstructions === true ? ['Write your own instructions once, after the interview, with write_instructions.'] : []),
        ...(runtime.allowInstructionsOffer === true ? ['Offer a lasting rule you cannot keep as a line for your instructions with offer_instructions_line.'] : []),
      ].join(' '),
      writes: false,
      effectPolicy: 'trusted',
      tools: enabledTools,
      readOnlyTools: [],
      schemaChars: 0,
    },
    // The Manor-owned server advertises and accepts only this turn's enabled tools.
    // Provider-level exclusions remain for registered servers whose process we do not own.
    disabledTools: [],
    runtimeEnv: { [USER_INPUT_CAPABILITY_ENV]: capability },
  }
}
