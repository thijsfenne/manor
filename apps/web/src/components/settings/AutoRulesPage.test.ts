import { describe, expect, it } from 'vitest'
import { problemsFor, ruleWithFastMode, settled, type RuleRow } from './AutoRulesPage'

const row = (id: string, key: string, rule: Partial<RuleRow['rule']> = {}): RuleRow => ({
  id,
  key,
  rule: {
    description: 'Diagnose or fix a defect.',
    driver: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'high',
    ...rule,
  },
})

describe('the auto rule form', () => {
  it('passes a rule the server would accept', () => {
    expect(problemsFor([row('a', 'bug-fix-performance')]).size).toBe(0)
  })

  it('names both rows that share a key, which a save would collapse into one', () => {
    const problems = problemsFor([row('a', 'routine'), row('b', 'routine')])

    expect(problems.get('a')?.key).toBe('another rule already uses this key')
    expect(problems.get('b')?.key).toBe('another rule already uses this key')
  })

  it('refuses the classifier’s own key, and a key that is not lowercase', () => {
    expect(problemsFor([row('a', 'defer')]).get('a')?.key).toBe('defer is reserved for the classifier')
    expect(problemsFor([row('a', 'Bug Fix')]).get('a')?.key).toBeDefined()
  })

  it('reports a runtime the driver cannot run, in the words the refusal uses', () => {
    const problems = problemsFor([row('a', 'hardest', { driver: 'claude' })])

    expect(problems.get('a')?.model).toBe('gpt-6.1-sol is not a claude model')
  })

  it('wants a description, and a key, before anything is typed', () => {
    const problems = problemsFor([row('a', '', { description: '   ' })])

    expect(problems.get('a')?.key).toBe('a rule needs a key')
    expect(problems.get('a')?.description).toBe('a rule needs a description')
  })

  it('removes Fast mode from a rule when it is switched off', () => {
    const rule = row('a', 'routine', { speed: 'fast' }).rule

    expect(ruleWithFastMode(rule, false)).not.toHaveProperty('speed')
    expect(ruleWithFastMode(rule, true).speed).toBe('fast')
  })

  it('drops Fast mode when the model changes to one without it, so Save stays open', () => {
    const fast = row('a', 'bug-fix-performance', { driver: 'cursor', model: 'cursor-grok-4.7', speed: 'fast' }).rule
    const switched = settled({ ...fast, model: 'cursor-claude-sonnet-5-5' })

    expect(settled(fast).speed).toBe('fast')
    expect(switched).not.toHaveProperty('speed')
    expect(problemsFor([{ id: 'a', key: 'bug-fix-performance', rule: switched }]).size).toBe(0)
  })
})
