import { SKIPPED_ANSWER, type UserInputQuestion } from '@manor/contracts'
import { describe, expect, it } from 'vitest'

import { FIRST_STEP, pickAdvances, reduceAsk, type AskAction, type AskSteps } from './askSteps'

const questions: UserInputQuestion[] = [
  { id: 'corners', question: 'Round or square corners?', options: [{ label: 'Round' }, { label: 'Square' }] },
  { id: 'format', question: 'Which format?', options: [{ label: 'Markdown' }, { label: 'PDF' }, { label: 'HTML' }] },
  { id: 'where', question: 'Where does it go?', multi: true, options: [{ label: 'Menu' }, { label: 'Toolbar' }] },
]

/** Plays acts in order, as the card does, and keeps whatever the last one sent. */
function play(acts: AskAction[], keep = false, from: AskSteps = FIRST_STEP) {
  let steps = from
  let send = null
  for (const act of acts) ({ steps, send } = reduceAsk(questions, keep, steps, act))
  return { steps, send }
}

describe('reduceAsk', () => {
  it('advances a single pick short of the last step, and only then', () => {
    expect(pickAdvances(questions[0]!, false, false)).toBe(true)
    // The last step waits for Send, a multi for Next, a replacing card for Send.
    expect(pickAdvances(questions[1]!, true, false)).toBe(false)
    expect(pickAdvances(questions[2]!, false, false)).toBe(false)
    expect(pickAdvances(questions[0]!, false, true)).toBe(false)

    const { steps, send } = play([{ kind: 'pick', label: 'Round' }, { kind: 'next' }])
    expect(steps.step).toBe(1)
    expect(steps.forward).toBe(true)
    expect(send).toBeNull()
  })

  it('holds Next until the step has an answer, a typed line included', () => {
    expect(play([{ kind: 'next' }]).steps.step).toBe(0)
    expect(play([{ kind: 'type', text: '   ' }, { kind: 'next' }]).steps.step).toBe(0)
    expect(play([{ kind: 'type', text: 'Pill' }, { kind: 'next' }]).steps.step).toBe(1)
  })

  it('goes back with the earlier answer still held', () => {
    const { steps } = play([{ kind: 'pick', label: 'Square' }, { kind: 'next' }, { kind: 'back' }])
    expect(steps.step).toBe(0)
    expect(steps.forward).toBe(false)
    expect(steps.drafts.corners?.selected).toEqual(['Square'])
    expect(play([{ kind: 'back' }]).steps).toBe(FIRST_STEP)
  })

  it('skips one question and clears what it held', () => {
    const { steps } = play([{ kind: 'pick', label: 'Round' }, { kind: 'skip' }])
    expect(steps.step).toBe(1)
    expect(steps.drafts.corners).toBeUndefined()
    // Answering it after all takes the skip back.
    const { send } = play([{ kind: 'back' }, { kind: 'pick', label: 'Round' }, { kind: 'next' }, { kind: 'skip' }, { kind: 'skip' }], false, steps)
    expect(send?.corners).toBe('Round')
  })

  it('sends every step together only when the last one is left', () => {
    const { send } = play([
      { kind: 'skip' },
      { kind: 'type', text: 'Plain text' },
      { kind: 'next' },
      { kind: 'pick', label: 'Menu' },
      { kind: 'pick', label: 'Toolbar' },
      { kind: 'next' },
    ])
    expect(send).toEqual({ corners: SKIPPED_ANSWER, format: 'Plain text', where: ['Menu', 'Toolbar'] })
    // A typed line that repeats a pick goes out once.
    const repeat = play([{ kind: 'skip' }, { kind: 'skip' }, { kind: 'pick', label: 'Menu' }, { kind: 'type', text: 'Menu' }, { kind: 'next' }])
    expect(repeat.send?.where).toEqual(['Menu'])
    expect(play([{ kind: 'skip' }, { kind: 'skip' }, { kind: 'skip' }]).send).toEqual({
      corners: SKIPPED_ANSWER, format: SKIPPED_ANSWER, where: SKIPPED_ANSWER,
    })
  })

  it('leaves a kept question out of a replacing card, and sends nothing when all are kept', () => {
    const { send } = play([{ kind: 'skip' }, { kind: 'pick', label: 'PDF' }, { kind: 'next' }, { kind: 'skip' }], true)
    expect(send).toEqual({ format: 'PDF' })
    expect(play([{ kind: 'skip' }, { kind: 'skip' }, { kind: 'skip' }], true).send).toBeNull()
  })
})
