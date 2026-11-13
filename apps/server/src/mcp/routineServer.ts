import { isRecord, option, type JsonRecord, type McpToolServer } from './stdio.js'
import { ROUTINE_TOOL_CALL_LIMIT } from '../routineCapability.js'
import {
  ROUTINE_TOOL_NAMES,
  RoutineToolCancelInputSchema,
  RoutineToolSaveInputSchema,
  type RoutineToolName,
} from '../routineTool.js'

/**
 * When a persona may put scheduled work on the user's calendar, in the tool text every
 * driver shows its model each turn. Proposing is conversation, not a monitor: the
 * persona notices the moment in the turn it is already having, names the reminder or
 * check and its time, and saves only on a yes or a direct request.
 */
const SCHEDULING_RULES = [
  'Save only when the user asks directly ("remind me tomorrow at ten") or says yes to your proposal. A clear request needs no second confirmation.',
  'You may propose one reminder or check, in plain words with what and when, when the conversation gives a concrete reason: they are waiting for a reply, or they put off a concrete action to a later moment. Advice, doubt or a loose intention is not a task. Do not offer a reminder by default at the end of replies.',
  'If they decline, drop it; do not propose the same again unless something new gives a reason.',
  'Use action "remind" for a literal reminder, posted verbatim at the time with no model call; write the prompt as the message they should read. Use "run" when you must check sources at that time.',
  'Ask only when what to do or when is materially unclear. For a time-sensitive check, set lateUntil when the request says how long it stays useful; if a run after a sleeping Mac could be pointless or wrong and that does not follow from the request, ask them.',
  'After saving, Manor itself posts the exact moment and timezone in the chat (the result\'s confirm field). Confirm in one short line in their language with the same day and time; do not contradict it.',
].join(' ')

const tools = [
  {
    name: 'routine_list',
    description:
      'List the routines and one-time reminders or checks of your current direct message, with their status (scheduled, running, done, failed, expired, cancelled, active, off). Use this before changing or cancelling one so you have its routineId, and to answer what is scheduled.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'routine_save',
    description:
      `Create or update scheduled work in your current direct message: recurring with cron, or one time with runAt. ${SCHEDULING_RULES} Omit routineId to create; include the id from routine_list to update, and omitted fields keep their value. A one-time result lands in this DM once and then shows its end state. If the user gives no timezone, omit it and Manor uses Europe/Amsterdam.`,
    inputSchema: {
      type: 'object',
      properties: {
        routineId: { type: 'string', description: 'Existing id from routine_list; omit to create.' },
        name: { type: 'string', description: 'Short row name.' },
        prompt: { type: 'string', description: 'For run: the complete instruction. For remind: the exact reminder text the user will read.' },
        cron: { type: 'string', description: 'Recurring only: five-field cron expression, minute first.' },
        runAt: { type: 'string', description: 'One time only: local wall-clock time in the timezone, like 2026-09-28T10:00.' },
        lateUntil: { type: 'string', description: 'One time only: the latest local time a late run is still useful. Omit when a late run is always fine.' },
        action: { type: 'string', enum: ['run', 'remind'], description: 'run starts your turn at that time; remind posts the prompt verbatim without a model call.' },
        timezone: { type: 'string', description: 'IANA timezone; omit for Europe/Amsterdam.' },
        enabled: { type: 'boolean', description: 'Whether the schedule is active.' },
        notify: { type: 'boolean', description: 'Whether a finished run should ask the user for attention. One-time work notifies by default.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'routine_cancel',
    description:
      'Cancel a pending one-time reminder or check in your current direct message, when the user asks. It stays listed as cancelled. On a recurring routine this turns it off.',
    inputSchema: {
      type: 'object',
      properties: { routineId: { type: 'string', description: 'The id from routine_list.' } },
      required: ['routineId'],
      additionalProperties: false,
    },
  },
] as const

const toolNames = new Set<string>(ROUTINE_TOOL_NAMES)

async function callBroker(
  brokerUrl: string,
  capability: string,
  tool: RoutineToolName,
  arguments_: JsonRecord,
): Promise<unknown> {
  const response = await fetch(brokerUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-manor-routine-capability': capability,
    },
    body: JSON.stringify({ tool, arguments: arguments_ }),
    signal: AbortSignal.timeout(15_000),
  })
  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.error === 'string'
      ? payload.error
      : `Routine broker returned HTTP ${response.status}.`
    throw new Error(message)
  }
  return isRecord(payload) ? payload.result : undefined
}

export function routineMcpServer(argv: readonly string[]): McpToolServer {
  const brokerUrl = option('--broker-url', argv)
  return {
    name: 'manor-routines',
    tools,
    failureMessage: 'The routine action failed.',
    instructions: [
      'These tools manage only your own current direct-message routines and one-time reminders or checks.',
      SCHEDULING_RULES,
      'List before updating or cancelling so you preserve the intended routine.',
      `One turn may make at most ${ROUTINE_TOOL_CALL_LIMIT} routine tool calls.`,
    ].join(' '),
    async callTool(rawName, arguments_, capability) {
      const name = typeof rawName === 'string' ? rawName : ''
      if (!toolNames.has(name)) throw new Error(`Unknown routine tool ${name}.`)
      if (name === 'routine_save' && !RoutineToolSaveInputSchema.safeParse(arguments_).success) {
        throw new Error('routine_save received invalid fields.')
      }
      if (name === 'routine_cancel' && !RoutineToolCancelInputSchema.safeParse(arguments_).success) {
        throw new Error('routine_cancel needs a routineId.')
      }
      const result = await callBroker(brokerUrl, capability, name as RoutineToolName, arguments_)
      return [{ type: 'text', text: JSON.stringify(result) }]
    },
  }
}
