import { UserInputQuestionSchema, UserInputQuestionsSchema } from '@manor/contracts'
import { describe, expect, it } from 'vitest'

const option = { label: 'A' }
const question = (id: string) => ({
  id,
  question: 'Which way?',
  options: [option, { label: 'B' }],
})

describe('UserInputQuestionsSchema', () => {
  it('accepts unique snake_case ids', () => {
    expect(UserInputQuestionsSchema.parse([question('direction'), question('other_path')])).toHaveLength(2)
  })

  it('rejects a duplicate id so one answer cannot stand for two questions', () => {
    const parsed = UserInputQuestionsSchema.safeParse([question('direction'), question('direction')])
    expect(parsed.success).toBe(false)
  })

  it('rejects an id that is not snake_case', () => {
    expect(UserInputQuestionsSchema.safeParse([question('Direction')]).success).toBe(false)
    expect(UserInputQuestionsSchema.safeParse([question('1start')]).success).toBe(false)
    expect(UserInputQuestionsSchema.safeParse([question('has-dash')]).success).toBe(false)
    expect(UserInputQuestionsSchema.safeParse([question('next__step')]).success).toBe(false)
    expect(UserInputQuestionsSchema.safeParse([question('next_step_')]).success).toBe(false)
  })

  it('accepts up to four model options and an optional multi flag', () => {
    const four = {
      id: 'picks',
      question: 'Which?',
      multi: true,
      options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }],
    }
    expect(UserInputQuestionSchema.parse(four).multi).toBe(true)
    expect(
      UserInputQuestionSchema.safeParse({
        ...four,
        options: [...four.options, { label: 'E' }],
      }).success,
    ).toBe(false)
  })
})
