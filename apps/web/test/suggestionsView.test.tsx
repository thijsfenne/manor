import type { WorkflowSuggestion } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { occurrenceCount, suggestionPrompt, SuggestionsView } from '../src/components/suggestions/SuggestionsView'

const suggestion = (
  id: string,
  status: WorkflowSuggestion['status'],
  overrides: Partial<WorkflowSuggestion> = {},
): WorkflowSuggestion => ({
  id,
  name: id.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' '),
  description: `Description for ${id}.`,
  occurrences: `Evidence for ${id}.`,
  corrections: `Correction for ${id}.`,
  existingCoverage: `Coverage for ${id}.`,
  status,
  statusDetail: status,
  ...overrides,
})

const ledger = () => ({
  available: true,
  suggestions: [
    suggestion('interview-prep-note', 'ready', { occurrences: '5 across companies (Visma, bol.com).' }),
    suggestion('routine-hang-watchdog', 'watching', { occurrences: '1: 07-28, dream routine found dead.' }),
    suggestion('offer-review', 'shipped', { statusDetail: 'shipped 2026-07-06 (`~/.claude/skills/offer-review/`)' }),
  ],
})

const render = () =>
  renderToStaticMarkup(
    <SuggestionsView ledger={ledger()} canDiscuss onRefresh={() => true} onDiscuss={() => undefined} />,
  )

describe('Suggestions', () => {
  it('lists every candidate in one grouped column and opens the first decision beside it', () => {
    const html = render()

    expect(html).toContain('role="listbox" aria-label="Skill candidates"')
    expect(html).toContain('aria-label="Needs a decision"')
    expect(html).toContain('aria-label="Watching"')
    expect(html).toContain('aria-label="History"')
    // Every candidate is a row, so nothing needs unfolding to be seen.
    expect(html).toContain('>Interview Prep Note<')
    expect(html).toContain('>Routine Hang Watchdog<')
    expect(html).toContain('>Offer Review<')
    // The ready candidate is selected, so the detail pane is never empty on arrival.
    expect(html).toContain('role="option" aria-selected="true"')
    expect(html).toContain('Ready for a go or no-go, seen 5 times')
    expect(html).toContain('>Discuss in chat<')
    expect(html).toContain('>Evidence</h3>')
    expect(html).toContain('>Corrections seen</h3>')
    expect(html).toContain('>Existing coverage</h3>')
  })

  it('shows how far each candidate is from the three-times bar', () => {
    const html = render()

    // Two tallies on screen: the selected row and the detail header it opened.
    expect(html.match(/5 of 3 occurrences/g)?.length).toBe(4)
    expect(html).toContain('1 of 3 occurrences')
    // Shipped work has no progress left to show, so its slot carries the date.
    expect(html).toMatch(/>(6 Jul|Jul 6)</)
  })

  it('sinks the thinnest evidence to the bottom of its group', () => {
    const html = renderToStaticMarkup(
      <SuggestionsView
        ledger={{
          available: true,
          suggestions: [
            suggestion('thin', 'watching', { occurrences: '1: 08-20 once.' }),
            suggestion('thick', 'watching', { occurrences: '4 across 3 projects: 06-04.' }),
            suggestion('middling', 'watching', { occurrences: '2: 07-28, 08-01.' }),
          ],
        }}
        canDiscuss
        onRefresh={() => true}
        onDiscuss={() => undefined}
      />,
    )

    expect(html.indexOf('>Thick<')).toBeLessThan(html.indexOf('>Middling<'))
    expect(html.indexOf('>Middling<')).toBeLessThan(html.indexOf('>Thin<'))
  })

  it('counts occurrences the way the ledger writes them', () => {
    expect(occurrenceCount('4 across 3 projects: 06-04 Radu; 06-05 rechtinjeoor.')).toBe(4)
    expect(occurrenceCount('5+: 06-28 Synthesia; 07-06 bol Garage.')).toBe(5)
    expect(occurrenceCount('1: 07-14 RAS takeover.')).toBe(1)
    expect(occurrenceCount('Raised speculatively 2026-07-10 (Sam); 0 organic occurrences yet.')).toBe(0)
    expect(occurrenceCount('Seen twice while pairing.')).toBeUndefined()
  })

  it('explains when there is no memory folder', () => {
    const html = renderToStaticMarkup(
      <SuggestionsView
        ledger={{ available: false, suggestions: [] }}
        canDiscuss={false}
        onRefresh={() => true}
        onDiscuss={() => undefined}
      />,
    )

    expect(html).toContain('No memory folder on this host')
    expect(html).toContain('Suggestions are read from the memory folder')
    expect(html).not.toContain('role="listbox"')
  })

  it('says what an empty ledger means rather than showing an empty column', () => {
    const html = renderToStaticMarkup(
      <SuggestionsView
        ledger={{ available: true, suggestions: [] }}
        canDiscuss
        onRefresh={() => true}
        onDiscuss={() => undefined}
      />,
    )

    expect(html).toContain('No suggestions yet')
    expect(html).toContain('A candidate appears once a session tags one.')
  })

  it('turns Discuss into a decision prompt rather than an automatic build request', () => {
    const prompt = suggestionPrompt(suggestion('interview-prep-note', 'ready'))

    expect(prompt).toContain('What it would encode')
    expect(prompt).toContain('Corrections already seen')
    expect(prompt).toContain('whether this should become a skill, automation, template')
    expect(prompt).toContain('Do not build it until we have made that decision.')
  })
})
