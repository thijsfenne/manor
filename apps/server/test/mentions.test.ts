import { describe, expect, it } from 'vitest'
import { hasBrowserMention, hasComputerMention, parseMentions, type AgentConfig } from '@manor/contracts'

const agent = (name: string): AgentConfig =>
  ({ id: name.toLowerCase(), name, color: '#ffffff' }) as AgentConfig

const ROSTER = [agent('Sage'), agent('Smith'), agent('Manor')]

describe('parseMentions', () => {
  it('resolves a handle case-insensitively, in order, deduplicated', () => {
    expect(parseMentions('@smith and @Sage, then @Smith again', ROSTER)).toEqual(['smith', 'sage'])
  })

  it('ignores an unknown handle and a mid-word @', () => {
    expect(parseMentions('@Nobody mail sam@Sage', ROSTER)).toEqual([])
  })

  // The reason the regex grew two lookaheads: the composer inserts file mentions
  // prefixed with the folder's own name, and a persona may share that name.
  it('does not summon a persona from the first segment of a file mention', () => {
    expect(parseMentions('read @Manor/apps/server/src/main.ts', ROSTER)).toEqual([])
  })

  it('does not let the class backtrack into a shorter handle', () => {
    expect(parseMentions('@Manorx/y', [agent('Manor'), agent('Mano')])).toEqual([])
  })

  it('still mentions a persona at the end of a sentence', () => {
    expect(parseMentions('over to you @Sage.', ROSTER)).toEqual(['sage'])
  })

  it('treats a handle with a file extension as a path, not a persona', () => {
    expect(parseMentions('@Sage.ts is a file', ROSTER)).toEqual([])
  })

  it('still reads a mention that follows a file mention', () => {
    expect(parseMentions('@Manor/README.md then @Smith', ROSTER)).toEqual(['smith'])
  })

  it('reads a handle after a doubled @, a path slash, or a path token', () => {
    expect(parseMentions('@@Sage', ROSTER)).toEqual(['sage'])
    expect(parseMentions('@Sage/@Smith', ROSTER)).toEqual(['smith'])
    expect(parseMentions('@Manor/foo,@Sage', ROSTER)).toEqual(['sage'])
    expect(parseMentions('@a/@sage', ROSTER)).toEqual(['sage'])
  })
})

describe('explicit browser mentions', () => {
  it.each(['@browser', 'Use (@BROWSER), please', '@Sage use @browser.'])('recognizes %s', (text) => {
    expect(hasBrowserMention(text)).toBe(true)
  })

  it.each(['person@browser', '@browser/file.ts', '@browser.ts', '@browsers', 'browser'])('ignores %s', (text) => {
    expect(hasBrowserMention(text)).toBe(false)
  })

  it('reserves browser without changing the addressed personas', () => {
    expect(parseMentions('@Browser @Smith @Sage', [...ROSTER, agent('Browser')])).toEqual(['smith', 'sage'])
  })
})

describe('explicit computer mentions', () => {
  it.each(['@computer', 'Use (@COMPUTER), please', '@Sage use @computer.'])('recognizes %s', (text) => {
    expect(hasComputerMention(text)).toBe(true)
  })

  it.each(['person@computer', '@computer/file.ts', '@computer.ts', '@computers', 'computer'])('ignores %s', (text) => {
    expect(hasComputerMention(text)).toBe(false)
  })

  it('reserves computer without changing the addressed personas', () => {
    expect(parseMentions('@Computer @Smith @Sage', [...ROSTER, agent('Computer')])).toEqual(['smith', 'sage'])
  })
})
