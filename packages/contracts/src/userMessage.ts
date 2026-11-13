/**
 * The two readers of a user message. Manor writes some of them for the model alone (a
 * Single kickoff's opening line, a Confirm request, a project thread's wake). That
 * wording lives in `instruction`; `text` holds only what the user may read, and is empty
 * when the whole message is for the model. The model reads `instruction` followed by
 * `text`, joined as stored, so a separator belongs at the end of the instruction.
 *
 * Rows written before `instruction` existed hold the same wording inside `text`,
 * opening with "[Manor]". `splitUserMessage` is the one place that tells the two
 * apart, so a surface that shows or previews a message never needs to know which kind
 * of row it was handed.
 */

interface UserMessageParts {
  text: string
  instruction?: string | undefined
  source?: 'routine' | 'work_handoff' | 'agent_relay' | 'subagent_task' | 'background_wake' | 'project_thread' | undefined
  threadReason?: string | undefined
  confirmRequest?: unknown
  mergeTrouble?: unknown
}

/** What the model reads for this message: the instruction first, then the text. */
export const modelTextOf = (event: Pick<UserMessageParts, 'text' | 'instruction'>): string =>
  event.instruction === undefined ? event.text : `${event.instruction}${event.text}`

const LEGACY_MARK = '[Manor]'
/** The lines a Single kickoff opened with before `instruction` existed. */
const LEGACY_KICKOFF_HEAD = /^(?:\[Manor\][^\n]*(?:\n+|$))+/
/** Where a project thread's brief wake handed over the task, after its own instructions. */
const LEGACY_BRIEF_MARK = '\nTask:\n'
/**
 * How a Confirm request opens, in every wording the server has stored. Before
 * 2026-10-12 it confirmed "the goal", and before 2026-11-10 it named the person and
 * said "his approval", so the opening is matched by shape rather than by a name.
 */
export const CONFIRM_REQUEST_PREFIX = /^\[Manor\] [^\n]{1,60}? confirmed the (?:ready result|goal), and that is \w+ approval to commit/
const LEGACY_CONFIRM = CONFIRM_REQUEST_PREFIX

/**
 * The part of a user message the user reads, and the part only the model reads. A message
 * with no model-only wording returns its text and an empty instruction.
 */
export function splitUserMessage(event: UserMessageParts): { visible: string; instruction: string } {
  if (event.instruction !== undefined) return { visible: event.text, instruction: event.instruction }
  if (!event.text.startsWith(LEGACY_MARK)) return { visible: event.text, instruction: '' }
  const all = { visible: '', instruction: event.text }
  if (event.source === 'work_handoff') {
    const head = LEGACY_KICKOFF_HEAD.exec(event.text)?.[0] ?? ''
    return { visible: event.text.slice(head.length), instruction: head }
  }
  if (event.source === 'project_thread') {
    const at = event.threadReason === 'brief' ? event.text.indexOf(LEGACY_BRIEF_MARK) : -1
    return at === -1 ? all : { visible: event.text.slice(at + LEGACY_BRIEF_MARK.length), instruction: event.text.slice(0, at + LEGACY_BRIEF_MARK.length) }
  }
  // A message the user typed themselves may open with "[Manor]"; only Manor's own requests are hidden.
  if (event.source === undefined && (event.confirmRequest !== undefined || event.mergeTrouble !== undefined || LEGACY_CONFIRM.test(event.text))) return all
  return { visible: event.text, instruction: '' }
}

/** Whether the message is Manor talking to the model and nothing the user wrote or should read. */
export function isModelOnlyMessage(event: UserMessageParts): boolean {
  const { visible, instruction } = splitUserMessage(event)
  return instruction !== '' && visible === ''
}
