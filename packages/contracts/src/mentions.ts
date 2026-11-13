/**
 * `@name` where name is the persona's display name; trailing punctuation ends the
 * match.
 *
 * The lookbehind puts this rule at a word boundary. Without it `sam@Sage`
 * summoned Sage, which an earlier comment claimed was impossible while only being
 * true for handles nobody in the roster answered to. A '(' or a newline before
 * the '@' is still a boundary, so "(@Sage kun je…)" keeps working.
 *
 * The two lookaheads exist because the composer also inserts file mentions like
 * `@Manor/apps/web/src/mentions.ts`, whose first segment would otherwise summon a
 * persona that happened to be called Manor. The first is what makes the second
 * hold: without it the greedy class simply backtracks — `@Manor/` would fail on
 * `Manor`, retry `Mano`, and match — so refusing a word character here is what
 * turns the class atomic.
 *
 * `@Sage.` still mentions Sage, because a dot with no word character after it is a
 * sentence ending rather than a file extension. The known cost is `@Sage.Kun je`,
 * written with no space after the dot, which reads as a path and summons nobody.
 *
 * This is the only mention scanner. Server routing and the web tokenizer both
 * derive from `mentionSpans`; a second regex is how the recipient label started
 * lying.
 */
const MENTION = /(?<![\p{L}\p{N}_-])@([\p{L}\p{N}_-]+)(?![\p{L}\p{N}_-])(?![/\\]|\.[\p{L}\p{N}])/gu

/** One `@handle` the scanner accepted, at the index of the `@`. */
export interface MentionSpan {
  start: number
  handle: string
}

/**
 * Persona mention spans in `text`, roster-blind. Callers resolve handles against
 * the agents they care about; this function only finds the spans.
 */
export function mentionSpans(text: string): MentionSpan[] {
  const spans: MentionSpan[] = []
  for (const match of text.matchAll(MENTION)) {
    const handle = match[1]
    if (handle === undefined) continue
    spans.push({ start: match.index, handle })
  }
  return spans
}

/** Explicit targeting uses the same boundaries as persona and file mentions. */
export function hasBrowserMention(text: string): boolean {
  return mentionSpans(text).some((span) => span.handle.toLowerCase() === 'browser')
}

export function hasComputerMention(text: string): boolean {
  return mentionSpans(text).some((span) => span.handle.toLowerCase() === 'computer')
}

/**
 * Agent ids for the personas mentioned in a user message, in order of first
 * appearance and deduplicated. Matching is on the display name, case-insensitive,
 * so "@sage" and "@Sage" are the same persona. Unknown handles are ignored, which
 * is also what keeps an email address from summoning anybody.
 */
export function parseMentions(
  text: string,
  agents: readonly { id: string; name: string }[],
): string[] {
  const byName = new Map(agents.map((agent) => [agent.name.toLowerCase(), agent.id]))
  const found: string[] = []
  for (const span of mentionSpans(text)) {
    if (span.handle.toLowerCase() === 'browser' || span.handle.toLowerCase() === 'computer') continue
    const agentId = byName.get(span.handle.toLowerCase())
    if (agentId !== undefined && !found.includes(agentId)) found.push(agentId)
  }
  return found
}

/**
 * Whether `next` names a persona that `previous` did not. Lets a composer react to a
 * fresh tag without re-firing on every edit around a tag that was already there.
 */
export function addsAgentMention(
  previous: string,
  next: string,
  agents: readonly { id: string; name: string }[],
): boolean {
  const before = parseMentions(previous, agents)
  return parseMentions(next, agents).some((id) => !before.includes(id))
}
