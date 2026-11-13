import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'
import type { AgentConfig, SkillConfig } from '@manor/contracts'
import { activeMention, activeSkill, applySkill, composerShowsRecipients, draftRecipients, eligibleSkills, insertTrigger, matchFiles, matchSkills, mentionSegments, parseMentions, remarkMessageChips, shieldMessageRefs } from '../src/mentions'

const agent = (name: string): AgentConfig =>
  ({ id: name.toLowerCase(), name, color: '#ffffff' }) as AgentConfig

const ROSTER = [agent('Sage'), agent('Smith')]
const SKILLS: SkillConfig[] = [
  { id: 'brainstorm', name: 'Brainstorm screen', description: 'Explore alternatives.', instructions: 'Do it.', sources: ['claude'] },
  { id: 'review', name: 'Design review', description: 'Critique the result.', instructions: 'Review it.', sources: ['codex'] },
]

/** The kinds in order, which is what both surfaces actually render off. */
const kinds = (text: string) => mentionSegments(text, ROSTER).map((segment) => segment.kind)

describe('mentionSegments', () => {
  it('paints reserved destinations independently of the persona roster', () => {
    expect(mentionSegments('@browser and @computer and @Work', [agent('Browser'), agent('Computer'), agent('Work')])).toEqual([
      { kind: 'browser', text: '@browser' },
      { kind: 'text', text: ' and ' },
      { kind: 'computer', text: '@computer' },
      { kind: 'text', text: ' and ' },
      { kind: 'work', text: '@Work' },
    ])
  })

  it('tints a known persona and leaves an unknown handle alone', () => {
    expect(kinds('hi @Sage')).toEqual(['text', 'agent'])
    expect(kinds('hi @Nobody')).toEqual(['text'])
  })

  it('matches a persona case-insensitively, the way the server resolves it', () => {
    const [segment] = mentionSegments('@sage', ROSTER)
    expect(segment).toMatchObject({ kind: 'agent', text: '@sage' })
  })

  it('reads a path-shaped token as a file without consulting any listing', () => {
    const segments = mentionSegments('see @Manor/apps/web/src/mentions.ts please', ROSTER)
    expect(segments).toMatchObject([
      { kind: 'text', text: 'see ' },
      { kind: 'file', path: 'Manor/apps/web/src/mentions.ts' },
      { kind: 'text', text: ' please' },
    ])
  })

  it('keeps sentence punctuation out of the mention', () => {
    const segments = mentionSegments('ask @Sage, then read @Manor/README.md.', ROSTER)
    expect(segments).toMatchObject([
      { kind: 'text' },
      { kind: 'agent', text: '@Sage' },
      { kind: 'text', text: ', then read ' },
      { kind: 'file', path: 'Manor/README.md' },
      { kind: 'text', text: '.' },
    ])
  })

  it('ignores a mid-word @, so an email address tints nothing', () => {
    expect(kinds('mail sam@Sage')).toEqual(['text'])
  })

  it('covers the whole message, so nothing is dropped on the way to the screen', () => {
    const text = 'a @Sage b @Manor/x/y.ts c @Nobody d'
    expect(mentionSegments(text, ROSTER).map((segment) => segment.text).join('')).toBe(text)
  })

  it('renders the message unchanged when the roster is empty', () => {
    expect(mentionSegments('hi @Sage', []).map((segment) => segment.text).join('')).toBe('hi @Sage')
  })

  it('renders an imported skill and leaves an unknown dollar token as prose', () => {
    expect(mentionSegments('use $brainstorm, not $unknown', ROSTER, SKILLS)).toMatchObject([
      { kind: 'text', text: 'use ' },
      { kind: 'skill', text: '$brainstorm' },
      { kind: 'text', text: ', not $unknown' },
    ])
  })

  // The typo this exists for: punctuation glued to the handle still summons on the
  // server, so it has to tint — and the recipient label has to say so.
  it('reads a mention out of glued punctuation, the way the server routes it', () => {
    expect(mentionSegments('@Sage,kun je hier naar kijken', ROSTER)).toMatchObject([
      { kind: 'agent', text: '@Sage' },
      { kind: 'text', text: ',kun je hier naar kijken' },
    ])
    expect(kinds('@Sage,@Smith overleg even')).toEqual(['agent', 'text', 'agent', 'text'])
  })

  // These three used to be a second parser. They are now spans from the same
  // scan the server routes on, clipped into chips.
  it('derives chips from the shared spans, including the compound cases', () => {
    expect(mentionSegments('@@Sage', ROSTER)).toMatchObject([
      { kind: 'text', text: '@' },
      { kind: 'agent', text: '@Sage' },
    ])
    expect(mentionSegments('@Sage/@Smith', ROSTER)).toMatchObject([
      { kind: 'file', path: 'Sage/' },
      { kind: 'agent', text: '@Smith' },
    ])
    expect(mentionSegments('@Manor/foo,@Sage', ROSTER)).toMatchObject([
      { kind: 'file', path: 'Manor/foo' },
      { kind: 'text', text: ',' },
      { kind: 'agent', text: '@Sage' },
    ])
  })
})

/**
 * Segmentation must not drop a span the shared scanner found. Same function
 * underneath, so this is a derivation check, not a two-parser parity net.
 */
describe('mentionSegments follows parseMentions', () => {
  const CASES = [
    'hi @Sage',
    'hi @Nobody',
    'mail sam@Sage',
    '@Sage, then @Smith.',
    '@Sage,kun je hier naar kijken',
    '@Sage,@Smith overleg even',
    '@Sage.Kun je verder',
    'vraag het @Sage.',
    '(@Sage kun je hier naar kijken?)',
    '@Sage/notes versus @Manor/apps/web/src/mentions.ts',
    "@Sage's plan, en @smith-en-co",
    'dubbel @sage en @SAGE en dan @Smith',
    '$brainstorm,@Sage aan jou',
    '@@Sage',
    '@Sage/@Smith',
    '@Manor/foo,@Sage',
    '@a/@sage',
  ]

  for (const text of CASES) {
    it(`keeps every routed persona in "${text}"`, () => {
      const tinted = mentionSegments(text, ROSTER, SKILLS)
        .flatMap((segment) => (segment.kind === 'agent' ? [segment.agent.id] : []))
      const deduped = tinted.filter((id, index) => tinted.indexOf(id) === index)
      expect(deduped).toEqual(parseMentions(text, ROSTER))
    })
  }
})

describe('draftRecipients', () => {
  const agents = [
    { ...agent('Marlow'), isCos: true },
    { ...agent('Sage'), isCos: false },
    { ...agent('Smith'), isCos: false },
  ]

  it('lets a mention win over the fallback', () => {
    expect(draftRecipients('@Smith pak jij dit op', agents, [agents[1]!]).map((a) => a.name)).toEqual(['Smith'])
  })

  it('falls back to the follow-up target, then the chief of staff', () => {
    expect(draftRecipients('en dan?', agents, [agents[1]!]).map((a) => a.name)).toEqual(['Sage'])
    expect(draftRecipients('en dan?', agents).map((a) => a.name)).toEqual(['Marlow'])
  })

  // A group whose chief of staff is not in the room: the message lands and
  // summons nobody, and an explicitly empty fallback must stay empty.
  it('keeps an explicitly empty fallback empty', () => {
    expect(draftRecipients('en dan?', agents, [])).toEqual([])
  })

  it('drops an outsider mention and does not fall back to the chief of staff', () => {
    expect(draftRecipients('@Sage kijk je mee', agents, [agents[0]!], ['marlow', 'smith'])).toEqual([])
  })

  it('keeps a member mention after the room filter', () => {
    expect(
      draftRecipients('@Smith pak jij dit op', agents, [agents[0]!], ['marlow', 'smith']).map((a) => a.name),
    ).toEqual(['Smith'])
  })
})

describe('composerShowsRecipients', () => {
  const spoken = [{ type: 'user_message' as const }]

  it('hides on a DM and on a thread that has not started', () => {
    expect(composerShowsRecipients('dm', spoken)).toBe(false)
    expect(composerShowsRecipients('group', [])).toBe(false)
    expect(composerShowsRecipients('project', [])).toBe(false)
    expect(composerShowsRecipients(undefined, spoken)).toBe(false)
  })

  it('shows once a group or project has a user message, including a queued one', () => {
    expect(composerShowsRecipients('group', spoken)).toBe(true)
    expect(composerShowsRecipients('project', spoken)).toBe(true)
    expect(composerShowsRecipients('group', [], 1)).toBe(true)
  })
})

describe('$ skill autocomplete', () => {
  it('opens only at a word boundary and inserts the stable slug', () => {
    expect(activeSkill('try $brain', 10)).toEqual({ start: 4, query: 'brain' })
    expect(activeSkill('cash$brain', 10)).toBeNull()
    expect(applySkill('try $brain now', 10, 4, 'brainstorm')).toEqual({
      text: 'try $brainstorm  now',
      caret: 16,
    })
  })

  it('searches names and slugs with prefixes first', () => {
    expect(matchSkills(SKILLS, 'design').map((skill) => skill.id)).toEqual(['review'])
    expect(matchSkills(SKILLS, 'brain').map((skill) => skill.id)).toEqual(['brainstorm'])
  })

  it('uses the chief of staff by default and the intersection for several mentions', () => {
    const agents = [
      { ...agent('Marlow'), isCos: true, skillIds: ['brainstorm', 'review'] },
      { ...agent('Sage'), isCos: false, skillIds: ['brainstorm', 'review'] },
      { ...agent('Smith'), isCos: false, skillIds: ['review'] },
    ]
    expect(eligibleSkills('shape this', agents, SKILLS).map((skill) => skill.id)).toEqual(['brainstorm', 'review'])
    expect(eligibleSkills('@Sage @Smith shape this', agents, SKILLS).map((skill) => skill.id)).toEqual(['review'])
  })
})

describe('matchFiles', () => {
  const FILES = [
    'Manor/apps/web/src/state.ts',
    'Manor/apps/web/src/chatState.test.ts',
    'Manor/apps/server/src/statements.ts',
    'Manor/docs/state-machine.md',
  ]

  it('says nothing until the query is worth a listing', () => {
    expect(matchFiles(FILES, 's')).toEqual([])
  })

  it('ranks a basename prefix over a substring, closest file name first', () => {
    // state.ts, statements.ts and state-machine.md all open with the query, so the
    // shortest file name leads; chatState.test.ts only contains it and comes last.
    expect(matchFiles(FILES, 'state')).toEqual([
      'Manor/apps/web/src/state.ts',
      'Manor/apps/server/src/statements.ts',
      'Manor/docs/state-machine.md',
      'Manor/apps/web/src/chatState.test.ts',
    ])
  })

  it('matches on the directory part too, ranked last', () => {
    expect(matchFiles(FILES, 'server')).toEqual(['Manor/apps/server/src/statements.ts'])
  })

  // A mention ends at the first space, so this row could not survive being picked.
  it('never offers a path it cannot insert whole', () => {
    expect(matchFiles(['Manor/docs/mijn plan.md', 'Manor/docs/plan.md'], 'plan')).toEqual([
      'Manor/docs/plan.md',
    ])
  })
})

/**
 * The plus menu types these for someone who does not know the keystroke, so what
 * it inserts has to be a trigger the menu will then actually open on. That is one
 * assertion, made twice: insert, then read it back with the parser.
 */
describe('inserting a trigger', () => {
  it('opens the menu it just typed', () => {
    const next = insertTrigger('ask Sage', 8, '@')

    expect(next.text).toBe('ask Sage @')
    expect(activeMention(next.text, next.caret)).toEqual({ start: 9, query: '' })
  })

  it('adds no space where the caret already sits at a boundary', () => {
    expect(insertTrigger('ask ', 4, '@')).toEqual({ text: 'ask @', caret: 5 })
    expect(insertTrigger('', 0, '$')).toEqual({ text: '$', caret: 1 })
  })

  it('types into the middle without eating what follows', () => {
    const next = insertTrigger('ask about the plan', 3, '@')

    expect(next.text).toBe('ask @ about the plan')
    expect(activeSkill(next.text, next.caret)).toBeNull()
  })

  // The caret is remembered from before the menu opened, and a draft can shrink
  // between the two — a clamp beats an insert past the end.
  it('survives a caret past the end of the draft', () => {
    expect(insertTrigger('hi', 99, '$')).toEqual({ text: 'hi $', caret: 4 })
  })
})

describe('quote references in a sent message', () => {
  const quote = { kind: 'note' as const, path: 'inbox/a.md', text: 'Words' }

  it('stay in place in the sentence and past the last quote stay prose', () => {
    expect(mentionSegments('is [Quote #1] or [Quote #2] it', [], [], 0, [quote])).toEqual([
      { kind: 'text', text: 'is ' },
      { kind: 'quote', text: '[Quote #1]', number: 1, quote },
      { kind: 'text', text: ' or [Quote #2] it' },
    ])
  })

  it('stay chips before brackets markdown would read as a link, and stay literal in code', () => {
    const processor = unified().use(remarkParse).use(remarkMessageChips([], [], [], 1, [quote]))
    const tree = JSON.stringify(processor.runSync(processor.parse(shieldMessageRefs('See [Quote #1](detail), [Image #1] and `[Quote #1]`', 1, 1))))
    expect(tree.match(/"data-quote":"1"/g)).toHaveLength(1)
    expect(tree.match(/"data-image":"1"/g)).toHaveLength(1)
    expect(tree).not.toContain('"type":"link"')
    expect(tree).toContain('"type":"inlineCode","value":"[Quote #1]"')
  })
})

describe('image references in a sent message', () => {
  it('stay chips before brackets markdown would read as a link, and stay literal in code and HTML', () => {
    const processor = unified().use(remarkParse).use(remarkMessageChips([], [], [], 2))
    const tree = JSON.stringify(processor.runSync(processor.parse(shieldMessageRefs('See [Image #1](detail) and `[Image #2]` or `[Image #1\\]`, <b>[Image #2]</b> not [Image #3]', 2))))
    expect(tree.match(/"data-image":"1"/g)).toHaveLength(1)
    expect(tree).not.toContain('"type":"link"')
    expect(tree).toContain('"type":"inlineCode","value":"[Image #2]"')
    expect(tree).toContain('not [Image #3]')
    expect(tree).toContain('"type":"inlineCode","value":"[Image #1\\\\]"')
    expect(tree).toContain('"type":"html","value":"<b>"')
    expect(tree).not.toContain('\uE002')
  })
})
