import {
  SKIPPED_ANSWER,
  USER_INPUT_ANSWER_MAX,
  userInputAnswerLines,
  type UserInputAnswerValue,
  type UserInputAnswers,
  type UserInputQuestion,
} from '@manor/contracts'

/**
 * Where the free-text row sits: one past the last option the model offered, so the
 * number on its key follows the options rather than standing apart from them.
 */
export const otherIndexOf = (question: UserInputQuestion) => question.options.length

/**
 * Whether the free-text row is on this question at all. A permission card says no:
 * the options it offers are the whole decision, and a typed answer to "Allow this
 * call?" is one the broker would have to read as a refusal anyway.
 */
export const hasOther = (question: UserInputQuestion): boolean => question.optionsOnly !== true

/** How many rows the keyboard can answer, the free line included when there is one. */
export const rowCount = (question: UserInputQuestion): number =>
  question.options.length + (hasOther(question) ? 1 : 0)

/** Whether this question takes more than one row. */
export const isMulti = (question: UserInputQuestion): boolean => question.multi === true

/** What the card holds while it is being filled in, one entry per question touched. */
export interface AskDraft {
  /**
   * The rows a question is holding, in the order they were picked. Always a list,
   * even for a single choice, which is then a list of one: one shape for both kinds
   * of question beats a field that changes type with a flag. `otherIndexOf` is the
   * free-text row.
   */
  picked: Record<string, number[]>
  /** What was typed on the free-text row, per question id. */
  typed: Record<string, string>
}

export const EMPTY_DRAFT: AskDraft = { picked: {}, typed: {} }

/** The rows this question is holding right now, in the order they were picked. */
export const rowsOf = (question: UserInputQuestion, draft: AskDraft): number[] =>
  draft.picked[question.id] ?? []

export const isPicked = (question: UserInputQuestion, draft: AskDraft, index: number): boolean =>
  rowsOf(question, draft).includes(index)

/**
 * The answer a question is currently holding, or null while it has none. A single
 * choice answers with the label itself; a multi answers with the list, which is what
 * the contract's list form is for. The free line only counts once it has words in it,
 * so a row that is ticked and empty adds nothing rather than an empty string.
 */
export function answerOf(question: UserInputQuestion, draft: AskDraft): UserInputAnswerValue | null {
  const lines: string[] = []
  for (const index of rowsOf(question, draft)) {
    const option = question.options[index]
    if (option !== undefined) {
      lines.push(option.label)
      continue
    }
    const typed = draft.typed[question.id]?.trim() ?? ''
    if (typed.length > 0) lines.push(typed)
  }
  if (lines.length === 0) return null
  return isMulti(question) ? lines : lines[0]!
}

/** Whether the free line is ticked but still has nothing in it. */
export const otherIsEmpty = (question: UserInputQuestion, draft: AskDraft): boolean =>
  isPicked(question, draft, otherIndexOf(question)) &&
  (draft.typed[question.id]?.trim() ?? '').length === 0

/**
 * A picked option, or a free line with words in it, is what lets a step be left.
 *
 * A ticked but empty free line holds the step even when an option is picked beside
 * it. On a single choice it always did, because it is the whole answer there; on a
 * multi it would otherwise pass with the ticked row silently missing from what goes
 * out, and a row you can see ticked has to be a row the agent reads.
 */
export const stepReady = (question: UserInputQuestion, draft: AskDraft): boolean =>
  !otherIsEmpty(question, draft) && answerOf(question, draft) !== null

/**
 * Picking a row. A single choice replaces whatever was there, which is what makes it
 * single; a multi toggles, so the same click or the same digit takes a row back off.
 */
export function pick(draft: AskDraft, question: UserInputQuestion, index: number): AskDraft {
  const current = rowsOf(question, draft)
  const next = !isMulti(question)
    ? [index]
    : current.includes(index)
      ? current.filter((row) => row !== index)
      : [...current, index]
  return { picked: { ...draft.picked, [question.id]: next }, typed: draft.typed }
}

export const write = (draft: AskDraft, questionId: string, text: string): AskDraft => ({
  picked: draft.picked,
  typed: { ...draft.typed, [questionId]: text },
})

/**
 * Drops the row a question was holding. What skipping does, so that stepping back to
 * a skipped question shows nothing picked: the payload says "Skipped" either way, and
 * a row still sitting there highlighted would be the card claiming otherwise.
 */
export function unpick(draft: AskDraft, questionId: string): AskDraft {
  if (draft.picked[questionId] === undefined) return draft
  const picked = { ...draft.picked }
  delete picked[questionId]
  return { picked, typed: draft.typed }
}

/**
 * Everything answered so far, with a skip standing in for every question still open.
 * The same payload whichever way the card ends: Send on the last step has them all,
 * and dismissing keeps the answers already given instead of throwing them away.
 */
export function payloadOf(
  questions: readonly UserInputQuestion[],
  draft: AskDraft,
  skipped: readonly string[],
): UserInputAnswers {
  const answers: UserInputAnswers = {}
  for (const question of questions) {
    const given = skipped.includes(question.id) ? null : answerOf(question, draft)
    answers[question.id] = given ?? SKIPPED_ANSWER
  }
  return answers
}

/** What a keystroke does to the card, or nothing at all. */
export type AskKeyAction = { kind: 'next' } | { kind: 'pick'; index: number } | null

/**
 * The card's whole keyboard, as a decision rather than a listener.
 *
 * Two things it must never do. Answer while another box has the keyboard, because a
 * digit typed into the composer is a digit. And touch its own free line: that input
 * handles its own Enter, and a window listener acting on the same keystroke ran the
 * step forward twice, which is one question silently skipped or one answer sent twice.
 */
export function askKeyAction(
  key: string,
  where: { inOurLine: boolean; typingElsewhere: boolean; ready: boolean; rows: number },
): AskKeyAction {
  if (where.typingElsewhere || where.inOurLine) return null
  if (key === 'Enter') return where.ready ? { kind: 'next' } : null
  const digit = Number(key)
  if (!Number.isInteger(digit) || digit < 1 || digit > where.rows) return null
  return { kind: 'pick', index: digit - 1 }
}

/**
 * Whether an act that is already in motion may still reach the wire.
 *
 * The card schedules a step forward 160ms after a row is picked, and a lot can happen
 * in 160ms: the socket can drop, or a second act can already have sent. Both leave a
 * timer holding a decision that was true when it was made and is not any more, so the
 * timer asks this at the moment it fires rather than trusting what it captured.
 */
export const mayLeave = (now: { connected: boolean; sent: boolean }): boolean =>
  now.connected && !now.sent

/** The one failure the card can see before it sends: a free line past the limit. */
export const tooLong = (answers: UserInputAnswers): boolean =>
  Object.values(answers).some((answer) =>
    userInputAnswerLines(answer).some((line) => line.length > USER_INPUT_ANSWER_MAX),
  )
