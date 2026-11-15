import { agentFitsChat, formatImageRef, mentionSpans, parseMentions, sessionFallbackAgent, type AgentConfig, type Chat, type MessageReply, type SkillConfig, type ThreadEvent } from '@manor/contracts'

/** Persona chips on both clients exclude reserved tool targets. */
export function agentMentionSpans(text: string, agents: readonly AgentConfig[]) {
  const names = new Set(agents.map((agent) => agent.name.toLowerCase()))
  return mentionSpans(text).filter((span) => {
    const handle = span.handle.toLowerCase()
    return handle !== 'browser' && handle !== 'computer' && names.has(handle)
  })
}

/**
 * A staged reply replaces the history fallback for an un-mentioned draft. Explicit
 * mentions still win inside `draftRecipients`; this only supplies its fallback and
 * the matching skill eligibility input.
 */
export function replyFallbackTargets(
  replyTo: Pick<MessageReply, 'agentId'> | undefined,
  agents: readonly AgentConfig[],
  fallback?: readonly AgentConfig[],
  memberIds?: readonly string[],
): readonly AgentConfig[] | undefined {
  if (replyTo === undefined) return fallback
  const target = agents.find((agent) => agent.id === replyTo.agentId)
  return target === undefined || (memberIds !== undefined && !memberIds.includes(target.id)) ? [] : [target]
}

/**
 * Who this draft reaches when sent, mirroring the server's routing: parse
 * against the whole household, then drop anyone the room cannot seat (`seats`,
 * by placement) or outside `memberIds`. A mention of only those is "no one", not a
 * silent fall back: the server recognises `@Smith` in a Session and refuses it, and
 * the label must say so. Pass the room's eligible personas as `seats` and the full
 * roster as `agents`; the picker offers `seats` only.
 *
 * With no mention at all, `fallback` is the DM's recipient or the chat's
 * follow-up target, or the chief of staff when the caller passes none. An
 * explicitly empty fallback stays empty: that is a room the message lands in
 * without summoning anyone, and the caller said so.
 */
export function draftRecipients(
  text: string,
  agents: readonly AgentConfig[],
  fallback?: readonly AgentConfig[],
  memberIds?: readonly string[],
  seats: readonly AgentConfig[] = agents,
): AgentConfig[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const mentioned = parseMentions(text, agents).flatMap((id) => {
    const agent = byId.get(id)
    return agent === undefined ? [] : [agent]
  })
  const seated = new Set(seats.map((agent) => agent.id))
  const inRoom = mentioned.filter((agent) => seated.has(agent.id) && (memberIds === undefined || memberIds.includes(agent.id)))
  if (mentioned.length > 0) return inRoom
  return [...(fallback ?? agents.filter((agent) => agent.isCos).slice(0, 1))]
}

/**
 * Who the label next to the plus names for this draft. `'unknown'` is an unmarked
 * follow-up while a turn runs or a message is queued (`busy`): the server picks its
 * target from who answered last, and that is not known yet. A mention or a targeted
 * reply names the target itself, so neither is ever unknown. The rest is
 * `draftRecipients`, whose arguments `room` carries.
 */
export function composerRecipients(
  text: string,
  agents: readonly AgentConfig[],
  room: {
    fallback?: readonly AgentConfig[] | undefined
    memberIds?: readonly string[] | undefined
    seats?: readonly AgentConfig[] | undefined
    busy: boolean
    replying: boolean
  },
): AgentConfig[] | 'unknown' {
  if (room.busy && !room.replying && parseMentions(text, agents).length === 0) return 'unknown'
  return draftRecipients(text, agents, room.fallback, room.memberIds, room.seats)
}

/**
 * The recipient label only where routing is history-dependent and the thread
 * has actually started. A DM already names its addressee in the header; a
 * freshly created group has a snapshot and no messages, and showing a target
 * there is a guess.
 */
export function composerShowsRecipients(
  kind: Chat['kind'] | undefined,
  events: readonly { type: string }[],
  queued = 0,
): boolean {
  if (kind === undefined || kind === 'dm') return false
  return queued > 0 || events.some((event) => event.type === 'user_message')
}

type RoomShape = Pick<Chat, 'kind'> & Partial<Pick<Chat, 'mode' | 'legacySessionAgentIds'>>

/**
 * The personas this room can seat by placement, before membership. Chat personas
 * talk in DMs and groups, Session personas work in project rooms; a Single, side or
 * child thread has no persona seats, so it keeps the whole roster as before.
 */
export function roomAgents<T extends AgentConfig>(agents: readonly T[], chat: RoomShape | null | undefined): T[] {
  if (chat == null || chat.mode === 'single' || chat.kind === 'side' || chat.kind === 'subagent') return [...agents]
  return agents.filter((agent) => agentFitsChat(agent, chat))
}

/**
 * Who an un-mentioned message in this chat will reach, mirroring the server's
 * follow-up rule: the sole persona that answered since the user last spoke.
 * Undefined means no such persona, and the chief-of-staff default applies.
 */
export function followUpTargets(
  events: readonly ThreadEvent[],
  agents: readonly AgentConfig[],
): AgentConfig[] | undefined {
  const repliers = new Set<string>()
  for (const event of [...events].reverse()) {
    if (event.type === 'user_message') break
    if (event.type === 'agent_message') repliers.add(event.agentId)
  }
  if (repliers.size !== 1) return undefined
  const agent = agents.find((candidate) => repliers.has(candidate.id))
  return agent === undefined ? undefined : [agent]
}

/**
 * Who an un-mentioned draft falls back to in this chat, membership included: the
 * follow-up target while still in the room, else the chief of staff, and in a group
 * the chief of staff is not part of explicitly nobody. A Session falls back to its
 * lead, then the chief of staff if it works there, then the roster's first Session
 * persona the room seats (`sessionFallbackAgent`, as the server routes). Undefined
 * leaves the default inside `draftRecipients` to apply.
 */
export function chatFallbackTargets(
  chat: RoomShape & { memberIds?: readonly string[] },
  events: readonly ThreadEvent[],
  agents: readonly AgentConfig[],
  leadAgentId?: string,
): AgentConfig[] | undefined {
  const reachable = roomAgents(agents, chat)
  const members = chat.kind === 'group' ? chat.memberIds : undefined
  const inRoom = (agent: AgentConfig) => members === undefined || members.includes(agent.id)
  const followUp = followUpTargets(events, reachable)?.filter(inRoom)
  if (followUp !== undefined && followUp.length > 0) return followUp
  if (chat.kind === 'project' && chat.mode !== 'single') {
    const fallback = [leadAgentId, agents.find((agent) => agent.isCos)?.id]
      .map((id) => reachable.find((agent) => agent.id === id))
      .find((agent) => agent !== undefined) ?? sessionFallbackAgent(reachable, chat)
    return fallback === undefined ? [] : [fallback]
  }
  if (members === undefined) return undefined
  const cos = reachable.find((agent) => agent.isCos)
  return cos !== undefined && inRoom(cos) ? [cos] : []
}

export interface MentionQuery {
  /** Index of the trigger character that opened this query. */
  start: number
  /** Text typed after the trigger, possibly empty. */
  query: string
}

/**
 * The boundary test is the third copy of one rule, and the loosest of the three is
 * the one that decides: a menu that refuses to open where `parseMentions` would
 * still summon leaves the mention typeable but undiscoverable. So all three read
 * "not preceded by a word character".
 */
const WORD_BEFORE = /[\p{L}\p{N}_-]/u

function activeToken(text: string, caret: number, trigger: '@' | '$' | '#'): MentionQuery | null {
  const upto = text.slice(0, caret)
  const start = upto.lastIndexOf(trigger)
  if (start === -1) return null
  const before = start === 0 ? '' : (upto[start - 1] ?? '')
  if (before !== '' && WORD_BEFORE.test(before)) return null
  const query = upto.slice(start + 1)
  if (query.includes(trigger) || /\s/.test(query)) return null
  return { start, query }
}

/**
 * Reads the mention the caret currently sits in, or null when it sits nowhere
 * near one. A mention only counts at a word boundary, so an email address or a
 * mid-word '@' never opens the menu.
 */
export function activeMention(text: string, caret: number): MentionQuery | null {
  return activeToken(text, caret, '@')
}

/** Reads the `$slug` token the caret currently sits in. */
export function activeSkill(text: string, caret: number): MentionQuery | null {
  return activeToken(text, caret, '$')
}

/** Replaces the partial mention with "@handle " and reports where the caret goes. */
export function applyMention(text: string, caret: number, start: number, handle: string) {
  const inserted = `@${handle} `
  return {
    text: text.slice(0, start) + inserted + text.slice(caret),
    caret: start + inserted.length,
  }
}

/**
 * The composer's recipient menu: "@handle " takes the place of the agent mentions that
 * open the draft, so a pick changes who hears it rather than adding a second recipient.
 * Mentions later in the text stay where they are.
 */
export function addressDraft(text: string, agents: readonly AgentConfig[], handle: string) {
  let end = 0
  for (const span of agentMentionSpans(text, agents)) {
    if (!/^[\s,&]*$/.test(text.slice(end, span.start))) break
    end = span.start + 1 + span.handle.length
  }
  const inserted = `@${handle} `
  return { text: inserted + text.slice(end).replace(/^[\s,&]+/, ''), caret: inserted.length }
}

/** Replaces a partial skill token with `$slug `. */
export function applySkill(text: string, caret: number, start: number, skillId: string) {
  const inserted = `$${skillId} `
  return {
    text: text.slice(0, start) + inserted + text.slice(caret),
    caret: start + inserted.length,
  }
}

/**
 * Reads the `#n` token the caret sits in, which picks one of the draft's own staged
 * pictures. Only while there are pictures and only digits after the `#`, so a
 * heading, a hashtag or an issue number in a draft with no pictures stays text.
 */
export function activeImageRef(text: string, caret: number, imageCount: number): MentionQuery | null {
  if (imageCount === 0) return null
  const token = activeToken(text, caret, '#')
  // `##` is a heading on its way, never a picture.
  return token === null || !/^\d*$/.test(token.query) || text[token.start - 1] === '#' ? null : token
}

/** The staged picture numbers a `#` query offers, in tray order. */
export function matchImageRefs(imageCount: number, query: string): number[] {
  return Array.from({ length: imageCount }, (_, index) => index + 1).filter((number) => String(number).startsWith(query))
}

/** Replaces a partial `#n` token with the picture's reference, `[Image #n] `. */
export function applyImageRef(text: string, caret: number, start: number, number: number) {
  const inserted = `${formatImageRef(number)} `
  return {
    text: text.slice(0, start) + inserted + text.slice(caret),
    caret: start + inserted.length,
  }
}

/**
 * Types a bare trigger at the caret, for the plus menu's way in. A trigger glued
 * to the previous word is not a trigger — `activeMention` and `activeSkill` both
 * refuse one — so the space that makes it a word boundary comes with it.
 */
export function insertTrigger(text: string, caret: number, trigger: '@' | '$' | '#') {
  const at = Math.min(Math.max(caret, 0), text.length)
  const before = text.slice(0, at)
  const inserted = before === '' || /\s$/.test(before) ? trigger : ` ${trigger}`
  return {
    text: before + inserted + text.slice(at),
    caret: at + inserted.length,
  }
}

/** Roster order, prefix matches first, so the obvious candidate is preselected. */
export function matchAgents(agents: readonly AgentConfig[], query: string): AgentConfig[] {
  const needle = query.toLowerCase()
  const mentionable = agents.filter((agent) => !['browser', 'computer'].includes(agent.name.toLowerCase()))
  if (needle === '') return mentionable
  const matches = mentionable.filter((agent) => agent.name.toLowerCase().includes(needle))
  return [
    ...matches.filter((agent) => agent.name.toLowerCase().startsWith(needle)),
    ...matches.filter((agent) => !agent.name.toLowerCase().startsWith(needle)),
  ]
}

/** The integrated browser stays discoverable even when its desktop host is offline. */
export function matchesBrowserMention(query: string): boolean {
  return 'browser'.includes(query.toLowerCase())
}

/** The Sessions destination answers to its label and to the `@work` handle it inserts. */
export function matchesWorkMention(query: string): boolean {
  const needle = query.toLowerCase()
  return 'work'.startsWith(needle) || 'sessions'.startsWith(needle)
}

/** Name and slug search, with a prefix on either ahead of a description hit. */
export function matchSkills(skills: readonly SkillConfig[], query: string): SkillConfig[] {
  const needle = query.toLowerCase()
  if (needle === '') return [...skills]
  const matches = skills.filter((skill) =>
    `${skill.id} ${skill.name} ${skill.description}`.toLowerCase().includes(needle),
  )
  return [
    ...matches.filter((skill) => skill.id.startsWith(needle) || skill.name.toLowerCase().startsWith(needle)),
    ...matches.filter((skill) => !skill.id.startsWith(needle) && !skill.name.toLowerCase().startsWith(needle)),
  ]
}

/**
 * Below this many characters the menu offers personas only. A roster is a handful of
 * names and stays readable under an empty query; a repo is thousands of files and
 * would bury them.
 */
export const FILE_QUERY_MIN = 2

/** How many file rows one menu may hold. The list scrolls, but a picker is not an index. */
export const FILE_MATCH_LIMIT = 10

/**
 * Repo files for a query, best guess first. The file name is what someone is
 * typing from, so a hit in the basename outranks one in the directory part; within
 * each of those, a prefix outranks a substring. Everything is scored before it is
 * cut, so the limit removes the worst matches rather than whichever the walk found
 * last.
 *
 * A path holding whitespace is never offered. A mention ends at the first space, so
 * inserting one would hand the persona a pointer to `docs/mijn` and leave `plan.md`
 * sitting in the prose: a menu row that cannot survive being picked is worse than a
 * file that has to be typed out by hand.
 */
export function matchFiles(files: readonly string[], query: string): string[] {
  const needle = query.toLowerCase()
  if (needle.length < FILE_QUERY_MIN) return []

  const scored: { path: string; rank: number; base: number }[] = []
  for (const path of files) {
    if (/\s/.test(path)) continue
    const lower = path.toLowerCase()
    const base = lower.slice(lower.lastIndexOf('/') + 1)
    const rank = base.startsWith(needle)
      ? 0
      : base.includes(needle)
        ? 1
        : lower.includes(needle)
          ? 2
          : 3
    if (rank < 3) scored.push({ path, rank, base: base.length })
  }

  // Inside a rank, the closest file name wins before the shortest path does. Someone
  // typing "state" wants `state.ts`, and ordering on the whole path would hand the user
  // `docs/state-machine.md` first for having fewer characters in front of it.
  scored.sort((left, right) =>
    left.rank !== right.rank
      ? left.rank - right.rank
      : left.base !== right.base
        ? left.base - right.base
        : left.path.length !== right.path.length
          ? left.path.length - right.path.length
          : left.path.localeCompare(right.path, 'en'),
  )
  return scored.slice(0, FILE_MATCH_LIMIT).map(({ path }) => path)
}

/**
 * Skills every addressed agent holds, addressed as `draftRecipients` reads it.
 * With several agents only the intersection is offered, so picking a row never
 * produces a half-applied instruction.
 */
export function eligibleSkills(
  text: string,
  agents: readonly AgentConfig[],
  skills: readonly SkillConfig[],
  fallback?: readonly AgentConfig[],
  memberIds?: readonly string[],
  seats: readonly AgentConfig[] = agents,
): SkillConfig[] {
  const targets = draftRecipients(text, agents, fallback, memberIds, seats)
  if (targets.length === 0) return []
  return skills.filter((skill) => targets.every((agent) => (agent.skillIds ?? []).includes(skill.id)))
}
