import { supportsFastMode, type AgentConfig, type AgentDraft } from '@manor/contracts'

export interface PersonaColorOption {
  value: string
  label: string
}

/**
 * The colours a persona is offered, in order. The same hues a project picks from,
 * so a room and an agent never sit beside each other in two shades of nearly the
 * same blue. Not a set anyone is held to: the form keeps a custom swatch, and a
 * character brings its own clay colour along, which is offered as itself.
 */
export const PERSONA_COLOR_OPTIONS: readonly PersonaColorOption[] = [
  { value: '#8B7EC8', label: 'Purple' },
  { value: '#6FA8A0', label: 'Teal' },
  { value: '#D08A3E', label: 'Orange' },
  { value: '#7AA2F7', label: 'Blue' },
  { value: '#9ECE6A', label: 'Green' },
  { value: '#E0AF68', label: 'Amber' },
  { value: '#C77DBB', label: 'Pink' },
  { value: '#E5817C', label: 'Red' },
]

const FIRST_COLOR = '#8B7EC8'
const PALETTE = PERSONA_COLOR_OPTIONS.map(({ value }) => value)

const sameColor = (one: string, other: string) => one.toLowerCase() === other.toLowerCase()

/**
 * The swatches offered to a persona already wearing `color`. The set is fixed, and
 * a colour from outside it (a picked character's clay, or a hex typed before the
 * set existed) keeps its place on the end rather than leaving the row with nothing
 * selected while the avatar plainly wears something.
 */
export function personaColorChoices(color: string): readonly PersonaColorOption[] {
  const own = safeHex(color)
  if (PERSONA_COLOR_OPTIONS.some((option) => sameColor(option.value, own))) return PERSONA_COLOR_OPTIONS
  return [...PERSONA_COLOR_OPTIONS, { value: own, label: 'Its own colour' }]
}

/** The first colour nobody in the house is wearing, or the next one round the ring. */
export function nextColor(agents: AgentConfig[]): string {
  const taken = new Set(agents.map((agent) => agent.color.toLowerCase()))
  const free = PALETTE.find((color) => !taken.has(color.toLowerCase()))
  return free ?? PALETTE[agents.length % PALETTE.length] ?? FIRST_COLOR
}

/**
 * A persona that does not exist yet. No id: that is what makes the save a create,
 * and the server mints the real one.
 */
export const emptyDraft = (agents: AgentConfig[]): AgentDraft => ({
  name: '',
  color: nextColor(agents),
  character: '',
  driver: 'claude',
  effort: 'high',
  allowedTools: [],
  mcpServers: [],
  skillIds: [],
  memoryScope: false,
  description: '',
  role: '',
  isCos: false,
  placement: 'chat',
})

/** An existing persona, opened for editing. Every field the form owns is copied. */
export const draftOf = (agent: AgentConfig): AgentDraft => ({
  id: agent.id,
  name: agent.name,
  color: agent.color,
  character: agent.character,
  driver: agent.driver,
  model: agent.model,
  effort: agent.effort,
  ...(agent.speed === 'fast' ? { speed: 'fast' as const } : {}),
  allowedTools: agent.allowedTools,
  mcpServers: agent.mcpServers,
  skillIds: agent.skillIds ?? [],
  mentionAllowlist: [...(agent.mentionAllowlist ?? [])],
  memoryScope: agent.memoryScope,
  description: agent.description,
  role: agent.role,
  isCos: agent.isCos,
  ...(agent.placement === undefined ? {} : { placement: agent.placement }),
  pinned: agent.pinned ?? false,
  railPinned: agent.railPinned ?? false,
  avatar: agent.avatar,
  avatarShape: agent.avatarShape,
  avatarTone: agent.avatarTone,
})

/**
 * What actually goes on the wire: trimmed, and absent rather than empty. A model
 * of '' is not "no model", it is a model named nothing, and the driver would pass
 * it straight to the CLI.
 */
export function cleanDraft(draft: AgentDraft): AgentDraft {
  const clean: AgentDraft = {
    ...draft,
    name: draft.name.trim(),
    description: draft.description.trim(),
    role: draft.role.trim(),
    character: draft.character.trim(),
    color: expandHex(draft.color.trim()),
  }
  const model = draft.model?.trim() ?? ''
  if (model === '') delete clean.model
  else clean.model = model
  if (draft.avatar === undefined || draft.avatar === '') delete clean.avatar
  // Absent, not empty: '' would be a shape named nothing, and the fallback reads
  // "she has not chosen one" off the field being missing.
  if (draft.avatarShape === undefined || draft.avatarShape === '') delete clean.avatarShape
  if ((draft.mentionAllowlist ?? []).length === 0) delete clean.mentionAllowlist
  if (draft.id === undefined) delete clean.id
  if (draft.speed !== 'fast') delete clean.speed
  return clean
}

/**
 * The Fast default a runtime can keep. A model without Fast drops it for good, so
 * switching back never revives a checkbox nobody saw ticked.
 */
export const fastFor = (driver: AgentConfig['driver'], model: string | undefined, speed: AgentDraft['speed']) =>
  speed === 'fast' && supportsFastMode(driver, model) ? ('fast' as const) : undefined

/**
 * Reads a toolset the way a person types one: commas, spaces, or newlines, in any
 * mixture. Order is kept because the toolset reads as a list, and duplicates are
 * dropped because a tool named twice is still one tool.
 */
export function parseTools(text: string): string[] {
  const seen = new Set<string>()
  const tools: string[] = []
  for (const raw of text.split(/[\s,]+/)) {
    if (raw === '' || seen.has(raw)) continue
    seen.add(raw)
    tools.push(raw)
  }
  return tools
}

export const formatTools = (tools: string[]) => tools.join(', ')

/** Who holds the chief-of-staff flag, or nobody. At most one agent ever does. */
export const cosOf = (agents: AgentConfig[]): AgentConfig | null =>
  agents.find((agent) => agent.isCos) ?? null

/**
 * #abc and #aabbcc are the same colour, but only the long form gets past the
 * server's check, so the short one is grown rather than refused. Anything that is
 * not a hex at all is left exactly as typed for the server to answer for.
 */
function expandHex(value: string): string {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value)
  if (!short) return value
  const [, r = '', g = '', b = ''] = short
  return `#${r}${r}${g}${g}${b}${b}`
}

/**
 * A hex the browser's colour input will accept, for a field the user can type
 * anything into. The typed value is what gets saved; this only keeps the swatch
 * beside it from resetting itself to black halfway through "#7aa".
 */
export function safeHex(value: string, fallback = '#8b93a1'): string {
  const clean = expandHex(value.trim())
  return /^#[0-9a-f]{6}$/i.test(clean) ? clean : fallback
}
