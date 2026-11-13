import type { AgentConfig } from '@manor/contracts'
import { InvalidUserInputCapabilityError, type UserInputCapabilities, type UserInputContext } from './interactionCapability.js'
import { isRecord } from './mcp/stdio.js'

/** The longest document the interview may write. The user's own edits in Settings have no such cap. */
export const INTERVIEW_INSTRUCTIONS_MAX = 12_000

/** What a refused write tells the model: the path is gone, and why. */
export const INSTRUCTIONS_CLOSED =
  'Your instructions are already written, or this is not your interview. Only the user can change them now, in your settings.'

/**
 * The interview a new chat agent opens its DM with (agent setup 2/4, 2026-11-13). The
 * agent asks a few questions, then writes its instructions once with `write_instructions`.
 * The path exists only for the turn the kickoff starts: it closes at the write or when that
 * turn ends, written or not. After that only the user changes the instructions. Held in
 * memory on purpose: a restart mid-interview closes the path too, and the agent keeps the
 * starter instructions the form wrote.
 */
export class AgentInterviews {
  /** Agent id to the kickoff message its interview turn answers. */
  private readonly open = new Map<string, string>()

  begin(agentId: string, kickoffId: string): void {
    this.open.set(agentId, kickoffId)
  }

  /** Whether this message starts the agent's interview turn, the only turn offered the write. */
  isKickoff(agentId: string, messageId: string): boolean {
    return this.open.get(agentId) === messageId
  }

  /** Takes the one write: the kickoff id the first time, undefined for good after. */
  claim(agentId: string): string | undefined {
    const kickoffId = this.open.get(agentId)
    this.open.delete(agentId)
    return kickoffId
  }

  /** The interview turn ended, with or without a write. */
  end(agentId: string, kickoffId: string): void {
    if (this.open.get(agentId) === kickoffId) this.open.delete(agentId)
  }
}

/** The kickoff the interview turn answers. Model-only: the DM shows the agent's cards, not this. */
export function interviewInstruction(agent: Pick<AgentConfig, 'name' | 'description'>): string {
  const job = agent.description.trim()
  return [
    `[Manor] The user just created you with a short form. Your name: ${agent.name}. What you should help with: ${job === '' ? '(left blank)' : job}`,
    '',
    'Before anything else, interview them so you can write your own instructions. Ask three short questions in one ask_user call that build on your name and job: what they most want from you, how you should sound and answer, and what you must always or never do. Give each two to four concrete options. Ask a fourth question in a second call only when an answer opens something that would change your instructions. Do not explain the process; the cards speak for themselves.',
    'An answer that says it was skipped leaves the choice to you: take a sensible default from the form. When every question is skipped, write the instructions from your name and job alone.',
    'Then call write_instructions once with the whole document: markdown, addressed to yourself ("You are …"), short and concrete, in English unless the user answered in another language, built only on the form and the answers. It becomes your whole system prompt from your next turn on; Manor adds its workspace rules around it. You may write it only in this turn and only once; after that only the user can change it.',
    'After writing, reply in at most two short sentences, in the user\'s language: that your instructions are set, and what you left out of them and why, or that you left nothing out. Call them your instructions, never AGENTS.md.',
  ].join('\n')
}

/**
 * The `write_instructions` call as the broker answers it, shared by the HTTP route and
 * its tests. Only a capability issued to an interview turn passes, and the agent's open
 * interview takes the write once.
 */
export async function answerInstructionsCall(
  capabilities: Pick<UserInputCapabilities, 'take'>,
  write: (context: UserInputContext, instructions: string) => Promise<void>,
  capability: string | undefined,
  body: unknown,
): Promise<{ status: number; payload: { note: string } | { error: string } }> {
  let context: UserInputContext
  try {
    context = capabilities.take(capability, 'instructions')
  } catch (error: unknown) {
    if (error instanceof InvalidUserInputCapabilityError) return { status: 404, payload: { error: 'Not found.' } }
    return { status: 409, payload: { error: error instanceof Error ? error.message : INSTRUCTIONS_CLOSED } }
  }
  const instructions = isRecord(body) && typeof body.instructions === 'string' ? body.instructions.trim() : ''
  if (instructions === '') return { status: 422, payload: { error: 'write_instructions needs the whole document in instructions.' } }
  if (instructions.length > INTERVIEW_INSTRUCTIONS_MAX) {
    return { status: 422, payload: { error: `Keep the instructions under ${INTERVIEW_INSTRUCTIONS_MAX} characters; shorter works better.` } }
  }
  try {
    await write(context, instructions)
  } catch (error: unknown) {
    return { status: 409, payload: { error: error instanceof Error ? error.message : INSTRUCTIONS_CLOSED } }
  }
  return { status: 200, payload: { note: 'Saved. These are your instructions from your next turn on. Now tell the user in a short message what you left out.' } }
}
