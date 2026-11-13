import {
  SIDE_CHAT_DEFAULTS,
  SIDE_CHAT_VOICE,
  driverForModel,
  type AgentConfig,
  type Chat,
} from '@manor/contracts'

/**
 * What answers in a side chat, built per turn from the chat's own model and effort.
 *
 * A function rather than a roster row (2026-08-17, superseding the hidden
 * `aside` persona). A panel is not a member of the household: nothing about it is
 * configured per persona, so a row there only meant a name to keep out of the Agents
 * screen and a runtime that took a database edit to change. What is left is a
 * character with no toolset, which is code, and a model with an effort, which is two
 * columns on the chat.
 *
 * Built here rather than merged into whatever the caller holds, so there is exactly
 * one description of what a panel may do. It holds no tools, no MCP, no skills and no
 * memory scope, and nothing downstream removes any of those: they are simply never
 * put in.
 */
export function sideAgentFor(chat: Pick<Chat, 'sideModel' | 'sideEffort'>): AgentConfig {
  const model = chat.sideModel ?? SIDE_CHAT_DEFAULTS.model
  return {
    id: SIDE_CHAT_VOICE.id,
    name: SIDE_CHAT_VOICE.name,
    color: SIDE_CHAT_VOICE.color,
    // A model the installed CLIs do not offer would leave the provider unknown, and a
    // turn has to run on something; the default's provider is the honest fallback,
    // since the default model is what the panel falls back to anyway.
    driver: driverForModel(model) ?? driverForModel(SIDE_CHAT_DEFAULTS.model) ?? 'claude',
    model,
    effort: chat.sideEffort ?? SIDE_CHAT_DEFAULTS.effort,
    allowedTools: [],
    mcpServers: [],
    skillIds: [],
    mentionAllowlist: [],
    memoryScope: false,
    role: '',
    description: '',
    isCos: false,
    character: SIDE_CHAT_CHARACTER,
  }
}

/**
 * The whole prompt a side chat's voice gets, beside the house style and the parent
 * transcript. It says three things the lines themselves cannot: whose conversation it
 * is reading, that it cannot act, and that it cannot be heard over there.
 */
export const SIDE_CHAT_CHARACTER = [
  "You are the side chat: a quick second read in the panel beside one of the user's chats.",
  'You are shown that conversation as context. It is a chat between the user and the agents in their workspace, and you are reading over their shoulder; they cannot hear you and nothing you say reaches their thread.',
  'Answer the question they ask you here, from that conversation and from what you know.',
  'You have no tools of any kind. You cannot open files, run commands, search the web, or change anything, and you know a file or a page only by what the conversation itself quotes of it.',
  'When an answer genuinely needs one of those, say so in one line and leave it to whoever is in the main chat, rather than guessing at the contents.',
  'Never write a reply on behalf of anyone in that conversation and never address them.',
  'You are here for speed: answer in a sentence or two, no preamble.',
].join(' ')
