import { SKIPPED_ANSWER, type UserInputAnswerValue, type UserInputAnswers, type UserInputQuestion } from '@manor/contracts'

/** What one question holds while the card is open: picked option labels and the free line. */
export interface AskDraft {
  selected: string[]
  custom: string
}

/** The phone ask card, one question on screen at a time. */
export interface AskSteps {
  step: number
  /** A skipped question has no draft, which is what makes it skipped. */
  drafts: Record<string, AskDraft>
  /** Which way the last step change went, so the next question slides in from that side. */
  forward: boolean
}

export type AskAction =
  | { kind: 'pick'; label: string }
  | { kind: 'type'; text: string }
  | { kind: 'next' }
  | { kind: 'skip' }
  | { kind: 'back' }

export const EMPTY_DRAFT: AskDraft = { selected: [], custom: '' }
export const FIRST_STEP: AskSteps = { step: 0, drafts: {}, forward: true }

export const draftOf = (steps: AskSteps, questionId: string): AskDraft => steps.drafts[questionId] ?? EMPTY_DRAFT

/**
 * The answer a question holds, or null while it has none. A typed line wins over a
 * single pick and joins a multi's picks, as the card has always sent it.
 */
export function answerOf(question: UserInputQuestion, draft: AskDraft): UserInputAnswerValue | null {
  const custom = draft.custom.trim()
  if (question.multi === true) {
    // A typed line that repeats a picked label counts once: the server refuses a list with duplicates.
    const picked = [...new Set([...draft.selected, ...(custom === '' ? [] : [custom])])]
    return picked.length > 0 ? picked : null
  }
  const answer = custom === '' ? draft.selected[0] : custom
  return answer === undefined || answer === '' ? null : answer
}

/**
 * Everything the card sends, once, when the last step is left. A skipped question tells
 * the agent to decide it; on a card that only replaces earlier answers (`keep`), a
 * skipped or empty one is left out, so it stays as it was. Null means nothing to send.
 */
export function payloadOf(questions: readonly UserInputQuestion[], steps: AskSteps, keep: boolean): UserInputAnswers | null {
  const answers: UserInputAnswers = {}
  for (const question of questions) {
    const given = answerOf(question, draftOf(steps, question.id))
    if (given !== null) answers[question.id] = given
    else if (!keep) answers[question.id] = SKIPPED_ANSWER
  }
  return Object.keys(answers).length === 0 ? null : answers
}

/**
 * Whether picking this option also moves on. Only a single choice short of the last
 * step does: a multi needs a separate "done", the last step waits for Send, and a card
 * that replaces an answer has nothing blocked on it, so it waits for Send as well.
 */
export const pickAdvances = (question: UserInputQuestion, last: boolean, keep: boolean): boolean =>
  question.multi !== true && !last && !keep

/**
 * One act on the card. `send` is set when the act leaves the last step: the answers of
 * every step, together. Acts that cannot apply return the same state.
 */
export function reduceAsk(
  questions: readonly UserInputQuestion[],
  keep: boolean,
  steps: AskSteps,
  action: AskAction,
): { steps: AskSteps; send: UserInputAnswers | null } {
  const question = questions[steps.step]
  const same = { steps, send: null }
  if (question === undefined) return same
  const last = steps.step >= questions.length - 1
  const multi = question.multi === true
  const draft = draftOf(steps, question.id)
  const answered = (next: AskDraft): AskSteps => ({ ...steps, drafts: { ...steps.drafts, [question.id]: next } })
  // Forward while questions remain, out the door on the last one.
  const leave = (from: AskSteps) =>
    last ? { steps: from, send: payloadOf(questions, from, keep) } : { steps: { ...from, step: from.step + 1, forward: true }, send: null }

  switch (action.kind) {
    case 'pick': {
      const selected = !multi
        ? [action.label]
        : draft.selected.includes(action.label)
          ? draft.selected.filter((label) => label !== action.label)
          : [...draft.selected, action.label]
      // A single pick replaces a typed line, so the row you see lit is the answer.
      return { steps: answered({ selected, custom: multi ? draft.custom : '' }), send: null }
    }
    case 'type':
      return { steps: answered({ selected: multi ? draft.selected : [], custom: action.text }), send: null }
    case 'next':
      return answerOf(question, draft) === null ? same : leave(steps)
    case 'skip': {
      // The pick goes with it, so stepping back shows nothing lit for a question the
      // payload calls skipped.
      const drafts = { ...steps.drafts }
      delete drafts[question.id]
      return leave({ ...steps, drafts })
    }
    case 'back':
      return steps.step === 0 ? same : { steps: { ...steps, step: steps.step - 1, forward: false }, send: null }
  }
}
