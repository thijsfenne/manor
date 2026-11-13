import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { inboxRowMotionClass } from '../src/components/inbox/InboxView'

describe('inbox settle motion', () => {
  it('names the active-row exit and its reverse entrance', () => {
    expect(inboxRowMotionClass({ chatId: 'a', kind: 'settle-out' }, 'a')).toBe('inbox-row-settle-out')
    expect(inboxRowMotionClass({ chatId: 'a', kind: 'unsettle-in' }, 'a')).toBe('inbox-row-unsettle-in')
    expect(inboxRowMotionClass({ chatId: 'a', kind: 'settle-out' }, 'b')).toBe('')
  })

  it('keeps every movement behind the reduced-motion guard', () => {
    const styles = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8')
    const guarded = styles.match(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?inbox-row-unsettle-in[\s\S]*?\n\}/)?.[0]

    expect(guarded).toContain('.inbox-row-settle-out')
    expect(guarded).toContain('.inbox-row-unsettle-in')
    expect(styles).toContain('grid-template-rows: 0fr')
    expect(styles).toContain('margin-bottom: 0')
    expect(styles).toContain('transform: translateX(12px) scale(0.98)')
  })
})
