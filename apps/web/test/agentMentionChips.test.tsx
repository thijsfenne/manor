import type { AgentConfig, SkillConfig } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentBubble, UserBubble } from '../src/components/Bubbles'
import { Transcript } from '../src/components/Transcript'

const agent = (name: string, color: string): AgentConfig =>
  ({ id: name.toLowerCase(), name, color }) as AgentConfig

const ROSTER = [agent('Sage', '#8b5cf6'), agent('Smith', '#f59e0b')]
const SKILLS: SkillConfig[] = [
  { id: 'job-application', name: 'job-application', description: 'Help with an application.', instructions: 'Do it.', sources: ['claude'] },
]

const render = (text: string) =>
  renderToStaticMarkup(<AgentBubble color="#3b82f6" text={text} agents={ROSTER} />)

/** The chip's own padding, which nothing else in a bubble wears (its avatar included). */
const chips = (html: string) => html.match(/pr-\[7px\] pl-\[4px\]/g)?.length ?? 0

describe('mentions inside an agent reply', () => {
  it('draws a chip when one persona hands work to another', () => {
    const html = render('@Smith kun jij hiernaar kijken?')
    expect(chips(html)).toBe(1)
    // The handle became the chip, so the raw '@' is gone from the prose.
    expect(html).not.toContain('@Smith')
    expect(html).toContain('Smith')
    // The chip carries the mentioned persona's accent, not the speaker's.
    expect(html).toContain('#f59e0b')
  })

  it('chips every mention in a delegation to more than one persona', () => {
    expect(chips(render('@Sage denk mee, @Smith bouwt het.'))).toBe(2)
  })

  it('leaves an unknown handle and a mention inside code as prose', () => {
    expect(chips(render('@Nobody is not on the roster'))).toBe(0)
    const code = render('type `@Smith` to summon him')
    expect(chips(code)).toBe(0)
    expect(code).toContain('@Smith')
  })

  it('still renders the markdown around a chip', () => {
    const html = render('**Plan**\n\n- ask @Sage')
    expect(html).toContain('<strong')
    expect(html).toContain('<li')
    expect(chips(html)).toBe(1)
  })
})

describe('skills inside a sent message', () => {
  it('uses the dedicated purple skill treatment for its name and icon', () => {
    const html = renderToStaticMarkup(<UserBubble text="$job-application" agents={ROSTER} skills={SKILLS} />)

    expect(html).toContain('var(--color-skill)')
    expect(html).toContain('var(--color-skill)_20%')
    expect(html).toContain('job-application')
  })
})

describe('destinations inside a sent message', () => {
  it('renders Browser, Computer Use and Work as pills instead of raw handles', () => {
    const html = renderToStaticMarkup(
      <UserBubble text="Open this in @browser, use @computer and send it to @Work" agents={ROSTER} skills={SKILLS} />,
    )

    expect(html).toContain('data-mention-target="browser"')
    expect(html).toContain('data-mention-target="computer"')
    expect(html).toContain('Computer Use')
    expect(html).toContain('data-mention-target="work"')
    expect(html).not.toContain('@browser')
    expect(html).not.toContain('@computer')
    expect(html).not.toContain('@Work')
  })
})

describe('markdown in what the user sends and in a Session kickoff', () => {
  const BRIEF = '## Outcome\n\n- **one** item\n- ask @Smith'

  it('renders a sent message as markdown with its chips and typed line breaks', () => {
    const html = renderToStaticMarkup(<UserBubble text={`${BRIEF}\nnext line`} agents={ROSTER} skills={SKILLS} />)
    expect(html).toContain('<h3')
    expect(html).toContain('<li')
    expect(html).toContain('<strong')
    expect(html).not.toContain('##')
    expect(html).not.toContain('**')
    // The mention inside a list item is still the persona chip, not prose.
    expect(chips(html)).toBe(1)
    expect(html).not.toContain('@Smith')

    const lines = renderToStaticMarkup(<UserBubble text={'eerste regel\ntweede regel'} agents={ROSTER} skills={SKILLS} />)
    expect(lines).toMatch(/eerste regel<br\/>\s*tweede regel/)
  })

  it('reads the composer bullet as a list item, not a bullet inside one', () => {
    const html = renderToStaticMarkup(<UserBubble text={'• een\n• twee'} agents={ROSTER} skills={SKILLS} />)
    expect(html.match(/<li/g)).toHaveLength(2)
    expect(html).not.toContain('•')
  })

  it('renders the Session kickoff as markdown', () => {
    const html = renderToStaticMarkup(<Transcript rows={[{
      kind: 'event',
      key: 'kickoff',
      event: { id: 'kickoff', ts: 1, type: 'user_message', source: 'work_handoff', text: BRIEF, mentions: [] },
    }]} agents={ROSTER} skills={[]} hasSnapshot />)
    expect(html).toContain('<h3')
    expect(html).toContain('<li')
    expect(html).toContain('<strong')
    expect(html).not.toContain('## Outcome')
    expect(chips(html)).toBe(1)
  })

  it('keeps a file chip whole when its path reads as markup', () => {
    const files = (html: string) => [...html.matchAll(/title="([^"]+)" data-inline-chip/g)].map((match) => match[1])
    const html = renderToStaticMarkup(<UserBubble text={'see @Manor/src/__x__.ts and **@Manor/a_b.ts**'} agents={ROSTER} skills={SKILLS} />)
    expect(files(html)).toEqual(['Manor/src/__x__.ts', 'Manor/a_b.ts'])
    expect(html).toContain('<strong')
    expect(html).not.toContain('**')

    // Underscores and brackets that belong to the path stay in the chip, and a link
    // wrapped around one keeps its own syntax.
    const edges = renderToStaticMarkup(<UserBubble text={'@Manor/src/__tests__ en @Manor/app/[id]_x_.tsx\n\n[@Manor/a_b.ts][ref]\n\n[ref]: https://example.com'} agents={ROSTER} skills={SKILLS} />)
    expect(files(edges)).toEqual(['Manor/src/__tests__', 'Manor/app/[id]_x_.tsx'])
    expect(edges).toMatch(/<a [^>]*href="https:\/\/example.com">@Manor\/a_b.ts<\/a>/)

    // Bold opened words earlier still closes after the path, and a closed pair
    // earlier in the line does not eat the path's own underscores.
    const phrase = renderToStaticMarkup(<UserBubble text={'**see @Manor/a_b.ts** and **ask @Manor/src/__tests__**\n\n__init__ in @Manor/src/__tests__'} agents={ROSTER} skills={SKILLS} />)
    expect(files(phrase)).toEqual(['Manor/a_b.ts', 'Manor/src/__tests__', 'Manor/src/__tests__'])
    expect(phrase.match(/<strong/g)).toHaveLength(3)
    expect(phrase).not.toContain('**')

    // In code the path stays the text it was typed as.
    const code = renderToStaticMarkup(<UserBubble text={'`@Manor/src/__x__.ts`\n\n```\n@Manor/src/__y__.ts\n```'} agents={ROSTER} skills={SKILLS} />)
    expect(files(code)).toEqual([])
    expect(code).toMatch(/<code[^>]*>@Manor\/src\/__x__.ts<\/code>/)
    expect(code).toContain('@Manor/src/__y__.ts')
    expect(code).not.toContain('\uE000')
  })

  it('keeps a typed line break inside a link label', () => {
    const html = renderToStaticMarkup(<UserBubble text={'[line one\nline two](https://example.com)'} agents={ROSTER} skills={SKILLS} />)
    expect(html).toMatch(/line one<br\/>\s*line two<\/a>/)
  })

  it('keeps raw html as text', () => {
    const html = renderToStaticMarkup(<UserBubble text={'<img src=x onerror=alert(1)>'} agents={ROSTER} skills={SKILLS} />)
    expect(html).not.toContain('<img')
  })
})
