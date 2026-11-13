import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProjectFileWriteCard } from '../src/components/Bubbles'

/** A project thread's own file write reads as a small English card, the line clamped. */
describe('ProjectFileWriteCard', () => {
  it('labels each action in English and clamps the line it touched', () => {
    const saved = renderToStaticMarkup(<ProjectFileWriteCard write={{ file: 'preferences.md', action: 'add', line: 'Corners are round', by: 'Project thread' }} />)
    expect(saved).toContain('Saved to preferences.md')
    expect(saved).toContain('line-clamp-2')
    expect(saved).toContain('title="Corners are round"')
    const removed = renderToStaticMarkup(<ProjectFileWriteCard write={{ file: 'notes.md', action: 'remove', old: 'Old note', by: 'Project thread' }} />)
    expect(removed).toContain('Removed from notes.md')
    expect(removed).toContain('Old note')
    const updated = renderToStaticMarkup(<ProjectFileWriteCard write={{ file: 'notes.md', action: 'replace', old: 'Old', line: 'New', by: 'Project thread' }} />)
    expect(updated).toContain('Updated in notes.md')
    expect(updated).toContain('>New<')
  })
})
