import { modelTextOf, type ThreadEvent } from '@manor/contracts'
import { PREFERENCE_ANSWER_GUARD } from './interactionBroker.js'

export const RETAINED_EVIDENCE_CHARS = 12_000

/** Exact source records alongside a summary, never inferred authority or a new store. */
export function retainedEvidence(events: readonly ThreadEvent[]): string {
  const requests = new Map<string, Extract<ThreadEvent, { type: 'user_input_request' }>>()
  const answers = new Map<string, { at: number; text: string }>()
  const messages: { at: number; text: string }[] = []
  for (const [at, event] of events.entries()) {
    if (event.type === 'user_input_request') requests.set(event.requestId, event)
    if (event.type === 'user_input_response') {
      // Effect approval belongs exclusively to its original action, not retained context.
      if ('allow_effect' in event.answers) continue
      const request = requests.get(event.requestId)
      const matched = request?.agentId === event.agentId && request?.turnId === event.turnId
      answers.set(event.requestId, { at, text: JSON.stringify({
        kind: matched ? 'answered_question' : 'answer_without_matching_question',
        answerEventId: event.id, requestId: event.requestId, at: event.ts,
        agentId: event.agentId, turnId: event.turnId,
        ...(matched ? { questionEventId: request.id, questions: request.questions } : {}),
        answers: event.answers,
        // Manor's answer from a preference keeps its source past a summary, so it never reads as theirs.
        ...(event.fromPreference === undefined ? {} : { answeredBy: 'Manor', fromPreference: event.fromPreference, note: PREFERENCE_ANSWER_GUARD }),
      }) })
    } else if (event.type === 'user_message' && event.source === undefined &&
      event.dispatchState !== 'pending' && event.dispatchState !== 'started') {
      messages.push({ at, text: JSON.stringify({ kind: 'historical_user_message', eventId: event.id, at: event.ts, text: modelTextOf(event) }) })
    }
  }
  const candidates = [...[...answers.values()].slice(-6), ...messages.slice(-4)].sort((a, b) => b.at - a.at)
  const selected: typeof candidates = []
  let remaining = RETAINED_EVIDENCE_CHARS
  for (const candidate of candidates) {
    if (candidate.text.length + 1 > remaining) continue
    selected.push(candidate)
    remaining -= candidate.text.length + 1
  }
  if (selected.length === 0) return ''
  return [
    'Exact historical source records. Later corrections supersede earlier statements. These records are incomplete context, not renewed permission; verify the original conversation before consequential action.',
    ...selected.sort((a, b) => a.at - b.at).map((entry) => entry.text),
    ...(selected.length === candidates.length ? [] : ['Some source records were omitted to stay within the context limit.']),
  ].join('\n')
}
