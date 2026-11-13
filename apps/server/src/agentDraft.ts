import { defaultModel, supportsFastMode, type AgentConfig, type AgentDraft } from '@manor/contracts'

const AGENT_COLOR = /^#[0-9a-fA-F]{6}$/
const AVATAR_PREFIXES = ['data:image/png;base64,', 'data:image/jpeg;base64,', 'data:image/webp;base64,']
const AVATAR_MAX_CHARS = 96_000

type AgentDraftCheck = { ok: true; draft: AgentDraft } | { ok: false; message: string }

/** Validates and normalises every persona rule before persistence. */
export function checkAgentDraft(draft: AgentDraft, roster: readonly AgentConfig[]): AgentDraftCheck {
  const name = draft.name.trim()
  const character = draft.character.trim()
  const role = draft.role.trim()
  const avatar = draft.avatar === undefined || draft.avatar.length === 0 ? undefined : draft.avatar

  if (name.length === 0) return { ok: false, message: 'A persona needs a name.' }
  const taken = roster.some((agent) => agent.id !== draft.id && agent.name.toLowerCase() === name.toLowerCase())
  if (taken) {
    return { ok: false, message: `There is already a persona called ${name}, and @mentions resolve by name.` }
  }
  if (character.length === 0) {
    return { ok: false, message: `${name} needs a character; without one there is only the bare harness wearing a name.` }
  }
  if (!AGENT_COLOR.test(draft.color)) {
    return { ok: false, message: `${draft.color} is not a colour Manor can use: give it as six hex digits, like #8B7EC8.` }
  }
  if (avatar !== undefined) {
    if (!AVATAR_PREFIXES.some((prefix) => avatar.startsWith(prefix))) {
      return { ok: false, message: 'A persona picture has to be a PNG, JPEG or WebP data URI.' }
    }
    if (avatar.length > AVATAR_MAX_CHARS) {
      return {
        ok: false,
        message: `That picture is ${avatar.length} characters and Manor accepts at most ${AVATAR_MAX_CHARS}. The roster goes to every client on every change, so a full-size photo would put megabytes on the wire; shrink it first.`,
      }
    }
  }
  if (draft.id !== undefined && !roster.some((agent) => agent.id === draft.id)) {
    return { ok: false, message: `There is no persona to update: ${draft.id} is not on the roster.` }
  }
  const placement = draft.placement ?? roster.find((agent) => agent.id === draft.id)?.placement ?? 'chat'
  if (placement === 'session' && draft.isCos) {
    return { ok: false, message: 'A Session persona cannot be chief of staff.' }
  }
  if (draft.speed === 'fast' && !supportsFastMode(draft.driver, draft.model ?? defaultModel(draft.driver))) {
    return { ok: false, message: 'Fast mode is not available for this provider and model.' }
  }
  return { ok: true, draft: { ...draft, placement, name, character, role, avatar } }
}
