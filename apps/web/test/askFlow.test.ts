import { SKIPPED_ANSWER, isSkippedAnswer, type UserInputQuestion } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import {
  EMPTY_DRAFT,
  answerOf,
  askKeyAction,
  hasOther,
  isPicked,
  mayLeave,
  otherIndexOf,
  otherIsEmpty,
  payloadOf,
  pick,
  rowCount,
  stepReady,
  tooLong,
  unpick,
  write,
} from '../src/askFlow'

/**
 * The walk through an ask card, without a card. Every rule that decides what the
 * agent ends up reading lives here: what a step is holding, when it may be left,
 * and what goes out when the user answers two of three questions and closes the rest.
 */

const dir: UserInputQuestion = {
  id: 'dir',
  question: 'Which way?',
  options: [{ label: 'Left' }, { label: 'Right' }],
}
const pace: UserInputQuestion = {
  id: 'pace',
  question: 'How fast?',
  options: [{ label: 'Now' }, { label: 'Later' }],
}
const parts: UserInputQuestion = {
  id: 'parts',
  question: 'What belongs in it?',
  options: [{ label: 'Sleep' }, { label: 'Outside' }, { label: 'Build' }],
  multi: true,
}
const permission: UserInputQuestion = {
  id: 'allow_effect',
  header: 'gmail',
  question: 'gmail.send_message may change external state. Allow this call?',
  options: [{ label: 'Allow once' }, { label: 'Deny' }],
  optionsOnly: true,
}

describe('a question being answered', () => {
  it('holds nothing until a row is picked', () => {
    expect(answerOf(dir, EMPTY_DRAFT)).toBeNull()
    expect(stepReady(dir, EMPTY_DRAFT)).toBe(false)
  })

  it('answers with the option label a row carries', () => {
    expect(answerOf(dir, pick(EMPTY_DRAFT, dir, 1))).toBe('Right')
  })

  // The free line is one past the last option, which is also the number on its key.
  it('puts the free line one past the options', () => {
    expect(otherIndexOf(dir)).toBe(2)
  })

  it('stays unanswered while the free line is picked but empty', () => {
    const draft = pick(EMPTY_DRAFT, dir, otherIndexOf(dir))

    expect(answerOf(dir, draft)).toBeNull()
    expect(answerOf(dir, write(draft, 'dir', '   '))).toBeNull()
    expect(answerOf(dir, write(draft, 'dir', ' Neither '))).toBe('Neither')
  })

  // Typing used to clear the picked option without saying so. Picking is what
  // decides now, and the two live in separate fields so neither can eat the other.
  it('keeps what was typed while an option is picked instead', () => {
    const draft = write(pick(EMPTY_DRAFT, dir, otherIndexOf(dir)), 'dir', 'Neither')

    expect(answerOf(dir, pick(draft, dir, 0))).toBe('Left')
    expect(answerOf(dir, pick(draft, dir, otherIndexOf(dir)))).toBe('Neither')
  })

  it('answers each question on its own', () => {
    const draft = pick(pick(EMPTY_DRAFT, dir, 0), pace, 1)

    expect(answerOf(dir, draft)).toBe('Left')
    expect(answerOf(pace, draft)).toBe('Later')
  })
})

/**
 * A permission card. Its two options are the whole decision, so it has no free line
 * and the keyboard has one row fewer to reach.
 */
describe('a question its own options answer', () => {
  it('drops the free line the ordinary question keeps', () => {
    expect(hasOther(dir)).toBe(true)
    expect(hasOther(permission)).toBe(false)
  })

  it('leaves the keyboard nothing past the last option', () => {
    expect(rowCount(dir)).toBe(3)
    expect(rowCount(permission)).toBe(2)
    expect(askKeyAction('3', { inOurLine: false, typingElsewhere: false, ready: true, rows: rowCount(permission) }))
      .toBeNull()
  })

  it('still answers with the label the row carries', () => {
    const draft = pick(EMPTY_DRAFT, permission, 0)

    expect(stepReady(permission, draft)).toBe(true)
    expect(payloadOf([permission], draft, [])).toEqual({ allow_effect: 'Allow once' })
  })
})

/**
 * A question that takes several answers. The same draft holds both kinds: a single
 * choice is a list of one, so nothing about the card has to know which it is until
 * the answer is built.
 */
describe('a question that takes more than one', () => {
  it('adds rows instead of replacing them', () => {
    const draft = pick(pick(EMPTY_DRAFT, parts, 0), parts, 2)

    expect(answerOf(parts, draft)).toEqual(['Sleep', 'Build'])
  })

  it('takes a row back off when it is picked again', () => {
    const draft = pick(pick(pick(EMPTY_DRAFT, parts, 0), parts, 2), parts, 0)

    expect(answerOf(parts, draft)).toEqual(['Build'])
    expect(isPicked(parts, draft, 0)).toBe(false)
  })

  it('has nothing left to send once every row is off again', () => {
    const draft = pick(pick(EMPTY_DRAFT, parts, 1), parts, 1)

    expect(answerOf(parts, draft)).toBeNull()
    expect(stepReady(parts, draft)).toBe(false)
  })

  // A single choice still answers with the label itself, which is what every thread
  // written before lists existed holds, and what a skip and a free line still are.
  it('answers with a list where a single choice answers with the label', () => {
    expect(answerOf(dir, pick(EMPTY_DRAFT, dir, 0))).toBe('Left')
    expect(answerOf(parts, pick(EMPTY_DRAFT, parts, 0))).toEqual(['Sleep'])
  })

  it('carries the free line as one of the rows', () => {
    const draft = write(pick(pick(EMPTY_DRAFT, parts, 1), parts, otherIndexOf(parts)), 'parts', 'Coffee')

    expect(answerOf(parts, draft)).toEqual(['Outside', 'Coffee'])
  })

  /**
   * The row is ticked and the line is empty. It cannot go out as an empty string,
   * which the contract refuses, and it cannot quietly go missing either: a row you
   * can see ticked has to be a row the agent reads. So the step holds until there
   * are words in it or the row is unticked, even with another option beside it.
   */
  it('holds the step while a ticked free line is still empty', () => {
    const draft = pick(pick(EMPTY_DRAFT, parts, 1), parts, otherIndexOf(parts))

    expect(otherIsEmpty(parts, draft)).toBe(true)
    expect(stepReady(parts, draft)).toBe(false)
    expect(answerOf(parts, draft)).toEqual(['Outside'])

    const filled = write(draft, 'parts', 'Coffee')
    expect(stepReady(parts, filled)).toBe(true)
    expect(answerOf(parts, filled)).toEqual(['Outside', 'Coffee'])

    // Unticking it is the other way out, and leaves the option that was already there.
    const untouched = pick(draft, parts, otherIndexOf(parts))
    expect(stepReady(parts, untouched)).toBe(true)
    expect(answerOf(parts, untouched)).toEqual(['Outside'])
  })

  // A multi always answers with the list, free line and all. "Free input stays a
  // string" only ever held while single-select was the one thing that carried a free
  // line; making the shape depend on whether an option happens to be ticked beside it
  // would be a seam with nothing behind it.
  it('answers with a list even when the free line is all there is', () => {
    const draft = write(pick(EMPTY_DRAFT, parts, otherIndexOf(parts)), 'parts', 'Coffee')

    expect(answerOf(parts, draft)).toEqual(['Coffee'])
    expect(payloadOf([parts], draft, [])).toEqual({ parts: ['Coffee'] })
  })

  it('sends a skip as the same one line a single choice does', () => {
    expect(payloadOf([parts], pick(EMPTY_DRAFT, parts, 0), ['parts'])).toEqual({
      parts: SKIPPED_ANSWER,
    })
  })
})

describe('what goes out', () => {
  it('sends every answer under its own question id', () => {
    const draft = write(pick(pick(EMPTY_DRAFT, dir, 0), pace, otherIndexOf(pace)), 'pace', 'Tomorrow')

    expect(payloadOf([dir, pace], draft, [])).toEqual({ dir: 'Left', pace: 'Tomorrow' })
  })

  // Skipping is an answer, never a silence: the turn is blocked until something
  // lands, so the payload has to say carry on without me in the model's own words.
  it('speaks for a question that was passed over', () => {
    const draft = pick(EMPTY_DRAFT, dir, 0)

    expect(payloadOf([dir, pace], draft, ['pace'])).toEqual({
      dir: 'Left',
      pace: SKIPPED_ANSWER,
    })
    expect(isSkippedAnswer(SKIPPED_ANSWER)).toBe(true)
  })

  // Dismissing the card is the same send with everything still open skipped, so the
  // two questions already answered are not thrown away with the third.
  it('keeps the answers already given when the rest are dismissed', () => {
    expect(payloadOf([dir, pace], pick(EMPTY_DRAFT, dir, 1), [])).toEqual({
      dir: 'Right',
      pace: SKIPPED_ANSWER,
    })
  })

  it('lets a skip be taken back by answering it after all', () => {
    const draft = pick(EMPTY_DRAFT, dir, 0)

    expect(payloadOf([dir], draft, [])['dir']).toBe('Left')
    expect(payloadOf([dir], draft, ['dir'])['dir']).toBe(SKIPPED_ANSWER)
  })

  it('refuses a free line past the contracts limit', () => {
    expect(tooLong({ dir: 'Left' })).toBe(false)
    expect(tooLong({ dir: 'x'.repeat(2_001) })).toBe(true)
  })

  // Skipping used to leave the pick behind: stepping back showed the old row lit
  // while the payload said "Skipped", so the card and what it sent disagreed.
  it('drops the row a skipped question was holding, so the screen agrees with the send', () => {
    const skippedDraft = unpick(pick(EMPTY_DRAFT, dir, 0), 'dir')

    expect(answerOf(dir, skippedDraft)).toBeNull()
    expect(payloadOf([dir], skippedDraft, ['dir'])).toEqual({ dir: SKIPPED_ANSWER })
  })

  it('leaves the other questions alone when one is dropped', () => {
    const draft = unpick(pick(pick(EMPTY_DRAFT, dir, 0), pace, 1), 'dir')

    expect(answerOf(pace, draft)).toBe('Later')
  })

  it('keeps what was typed, so a free line survives being picked again', () => {
    const draft = unpick(write(pick(EMPTY_DRAFT, dir, 2), 'dir', 'Neither'), 'dir')

    expect(answerOf(dir, pick(draft, dir, 2))).toBe('Neither')
  })
})

/**
 * The card picks a row and steps forward 160ms later, so every advance is a decision
 * made in the past acting in the present. What it captured is not what it may trust.
 */
describe('an advance that is already in motion', () => {
  it('goes through while the socket is up and nothing has gone out', () => {
    expect(mayLeave({ connected: true, sent: false })).toBe(true)
  })

  // The socket dropped inside those 160ms. On the last step this would have tried to
  // send into a dead connection; mid-card it stepped a locked card to the next
  // question, so the card showed one thing and was holding another.
  it('stops when the connection went while it was waiting', () => {
    expect(mayLeave({ connected: false, sent: false })).toBe(false)
  })

  it('stops when something already went out', () => {
    expect(mayLeave({ connected: true, sent: true })).toBe(false)
  })
})

describe('the keyboard', () => {
  const where = { inOurLine: false, typingElsewhere: false, ready: true, rows: 3 }

  it('picks the row a digit names', () => {
    expect(askKeyAction('1', where)).toEqual({ kind: 'pick', index: 0 })
    expect(askKeyAction('3', where)).toEqual({ kind: 'pick', index: 2 })
  })

  it('ignores a digit past the last row', () => {
    expect(askKeyAction('4', where)).toBeNull()
    expect(askKeyAction('0', where)).toBeNull()
  })

  it('leaves the step on Enter, but only once there is an answer', () => {
    expect(askKeyAction('Enter', where)).toEqual({ kind: 'next' })
    expect(askKeyAction('Enter', { ...where, ready: false })).toBeNull()
  })

  // A digit typed into the composer is a digit.
  it('does nothing while another box has the keyboard', () => {
    expect(askKeyAction('1', { ...where, typingElsewhere: true })).toBeNull()
    expect(askKeyAction('Enter', { ...where, typingElsewhere: true })).toBeNull()
  })

  /**
   * The free line handles its own Enter. Acting on the same keystroke here too ran
   * the step forward twice: mid-card that silently skipped the next question, and on
   * the last one it sent the whole payload twice.
   */
  it('keeps its hands off the free line entirely', () => {
    expect(askKeyAction('Enter', { ...where, inOurLine: true })).toBeNull()
    expect(askKeyAction('2', { ...where, inOurLine: true })).toBeNull()
  })
})
