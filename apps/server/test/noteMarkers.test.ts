import { describe, expect, it } from 'vitest'
import { dehydrateNotes, hydrateNotes, noteFingerprint, notesRows } from '../src/noteMarkers.js'

describe('note markers', () => {
  it('writes a Session row with its short id on disk and returns its age', () => {
    const row = '- [ ] Export button: Working'
    const disk = `# Notes\n\n${row} <!-- manor-note abcd1234 -->\n`
    const ages = { abcd1234: { updatedAt: 100, fingerprint: noteFingerprint(row) } }
    const working = hydrateNotes(disk, ages, 999)
    expect(working).toContain(`${row} <!-- manor-note handoff=abcd1234 updated=100 text=${noteFingerprint(row)} -->`)
    expect(dehydrateNotes(working)).toEqual({ content: disk, ages })
  })

  it('leaves a plain task row bare on disk and keeps its age under its fingerprint', () => {
    const row = '- [ ] Call the printer'
    const key = `t:${noteFingerprint(row)}`
    const ages = { [key]: { updatedAt: 50, fingerprint: noteFingerprint(row) } }
    const working = hydrateNotes(`${row}\n`, ages, 999)
    expect(working).toContain('handoff=- updated=50')
    expect(dehydrateNotes(working)).toEqual({ content: `${row}\n`, ages })
    // A row the store has never seen stays bare, so nothing invents an age for it.
    expect(hydrateNotes(`${row}\n`, {}, 999)).toBe(`${row}\n`)
  })

  it('reads the long form of an older file and writes it back in the short form', () => {
    const row = '- [ ] Export button: Ready'
    const fingerprint = noteFingerprint(row)
    const legacy = `${row} <!-- manor-note handoff=handoff_12345 updated=5 text=${fingerprint} -->\n`
    expect(hydrateNotes(legacy, {}, 999)).toBe(legacy)
    expect(dehydrateNotes(legacy)).toEqual({
      content: `${row} <!-- manor-note handoff_ -->\n`,
      ages: { handoff_: { updatedAt: 5, fingerprint } },
    })
    // A long-form row without a Session loses its marker altogether.
    const bare = '- [ ] Call the printer'
    expect(dehydrateNotes(`${bare} <!-- manor-note handoff=- updated=7 text=${noteFingerprint(bare)} -->\n`).content).toBe(`${bare}\n`)
  })
})

describe('notes rows for the panel', () => {
  it('shows rows without marker text, with their Session, age and state', () => {
    const day = 86_400_000
    const open = '- [ ] Export button: CSV ships'
    const content = `---\nowner: project-thread\n---\n# Notes\n\n${open} <!-- manor-note abcd1234 -->\n- [x] Old task\n- Launch is Friday\n`
    const ages = { abcd1234: { updatedAt: 0, fingerprint: noteFingerprint(open) } }
    const sessions = new Map([['abcd1234', { chatId: 'chat_9', title: 'Export button' }]])
    const rows = notesRows(content, ages, sessions, 5 * day)
    expect(rows).toEqual([
      { text: 'CSV ships', done: false, age: 'open 5d', session: { chatId: 'chat_9', title: 'Export button' } },
      { text: 'Old task', done: true },
      { text: 'Launch is Friday' },
    ])
    expect(JSON.stringify(rows)).not.toContain('manor-note')
  })
})
