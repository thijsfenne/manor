import { CODE_REVIEWER_ID, isProseFile, mentionSpans, type ThreadEvent } from '@manor/contracts'

/**
 * The rule (2026-09-30): a goal Session that changed files is reached only after
 * Argus has passed the current diff with no findings left. The reviewer is this
 * persona id; `review_passed` is the Manor tool only his goal-chain turns hold.
 */
export { CODE_REVIEWER_ID }
export const REVIEW_PASSED_TOOL = 'review_passed'

/** A Manor tool name as any provider reports it: bare, `mcp__manor__x` or `manor.x`. */
export const isManorTool = (tool: string, name: string): boolean => {
  const normalized = tool.toLocaleLowerCase()
  return normalized === name ||
    normalized.endsWith(`__${name}`) ||
    normalized.endsWith(`.${name}`)
}

/** Prose a research or writing Session leaves behind; every other changed file is code, `.mdx` included. */
export const isProse = isProseFile

/** Includes terminal notes, since a stopped turn has no turn_result. */
export function sessionChangedFiles(events: readonly ThreadEvent[]): string[] {
  return [...new Set(events.flatMap((event) => event.type === 'turn_result'
    ? [...(event.fileChanges ?? []).flatMap((file) => file.oldPath === undefined ? [file.path] : [file.path, file.oldPath]), ...(event.fileChangeUnmeasured ?? [])]
    : event.type === 'system_note' ? event.changedFiles ?? [] : []))]
}

/** `@browser` and `@computer` point a turn at a tool; every other handle hands work to someone. */
const handsOn = (text: string): boolean =>
  mentionSpans(text).some(({ handle }) => !['browser', 'computer'].includes(handle.toLowerCase()))

/**
 * Whether a turn changed code: its measured and unmeasured files, or a stopped or failed
 * turn's note. A checkout Manor could not measure counts as changed.
 */
function changedCode(event: ThreadEvent): boolean {
  if ((event.type === 'turn_result' || event.type === 'system_note') && event.fileChangesFailed === true) return true
  return sessionChangedFiles([event]).some((file) => !isProse(file))
}

/**
 * Written once per published result into the trace of the turn that changed only prose
 * after it; the user reads the same fact as Not included in the diff and on the bar row.
 * Confirm commits only the result's files: it refuses when one of them changed, and
 * leaves a new file out. Either way the change only lands after Request changes and a
 * new result. Code changed after the result reopens the goal instead (2026-10-06, an
 * Accept refused a reviewed commit nobody in the reached Session could republish).
 */
export const CHANGED_AFTER_RESULT_NOTE =
  'Changed after it was ready, so not part of it. Confirm leaves these files out; Request changes brings them into a new version.'

/** The events after this handoff's latest reached note, or undefined when it has none. */
function sinceResult(events: readonly ThreadEvent[], handoffId: string): readonly ThreadEvent[] | undefined {
  let reached = -1
  events.forEach((event, index) => {
    if (event.type === 'system_note' && event.workGoalHandoffId === handoffId) reached = index
  })
  return reached < 0 ? undefined : events.slice(reached + 1)
}

/** Whether a turn changed files after this handoff's reached note, with no note saying so yet. */
export function changedAfterResult(events: readonly ThreadEvent[], handoffId: string): boolean {
  const since = sinceResult(events, handoffId)
  if (since === undefined) return false
  if (since.some((event) => event.type === 'system_note' && event.text === CHANGED_AFTER_RESULT_NOTE)) return false
  return since.some((event) => (event.type === 'turn_result' || event.type === 'system_note') &&
    (event.fileChangesFailed === true || sessionChangedFiles([event]).length > 0))
}

/** Whether a turn changed code, or left a checkout Manor could not measure, after this handoff's reached note. */
export function codeChangedAfterResult(events: readonly ThreadEvent[], handoffId: string): boolean {
  return sinceResult(events, handoffId)?.some(changedCode) === true
}

/**
 * Why the owner may not mark this goal Session reached yet, or undefined when it may.
 * Reads the Session's own record, never the persona's claim: the snapshot of each turn,
 * committed changes included, and the terminal note of a stopped or failed turn. The
 * gate opens again only when the reviewer's latest turn called `review_passed` and no
 * turn changed code after it. A reviewer turn that neither passes nor hands anything on,
 * such as a status answer to the user, leaves their verdict standing; findings go to the author
 * with an @mention, so a turn with one and no pass withdraws it. Any handle counts, read
 * without the roster, so renaming or removing a persona later cannot restore a pass; a
 * stray handle errs toward another review. A Session that changed only prose or nothing
 * is not gated.
 */
export function goalReviewBlock(events: readonly ThreadEvent[], reviewerName: string): string | undefined {
  const toolNames = new Map<string, string>()
  const passed = new Set<string>()
  const handedOn = new Set<string>()
  for (const event of events) {
    if (event.type === 'agent_message' && event.agentId === CODE_REVIEWER_ID && handsOn(event.text)) {
      handedOn.add(event.turnId)
    }
    if (event.type === 'tool_use' && event.agentId === CODE_REVIEWER_ID && event.toolCallId !== undefined) {
      toolNames.set(event.toolCallId, event.tool)
    }
    if (event.type !== 'tool_result' || event.agentId !== CODE_REVIEWER_ID || event.outcome !== 'success') continue
    const tool = event.tool ?? toolNames.get(event.toolCallId)
    if (tool !== undefined && isManorTool(tool, REVIEW_PASSED_TOOL)) passed.add(event.turnId)
  }
  let changed = false
  let cleared = false
  for (const event of events) {
    const changes = changedCode(event)
    if (changes) changed = true
    if (event.type === 'turn_result' && event.agentId === CODE_REVIEWER_ID) {
      if (passed.has(event.turnId)) cleared = !changes
      else if (changes || handedOn.has(event.turnId)) cleared = false
    }
    // A stopped or failed review is a new review without a verdict: the earlier pass lapses.
    else if (event.type === 'system_note' && event.agentId === CODE_REVIEWER_ID && event.kind !== 'info' && event.turnId !== undefined) cleared = false
    else if (changes) cleared = false
  }
  if (!changed || cleared) return undefined
  return `The goal is not marked reached: this Session changed code and ${reviewerName}'s latest review has not passed the current diff. ` +
    `Process any open findings, then summon @${reviewerName} to review again; only a review they end with ${REVIEW_PASSED_TOOL} unlocks it. Do not commit before that.`
}
