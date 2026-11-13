import type { AgentConfig, ClientMessage, ServerMessage, SkillConfig } from '@manor/contracts'
import { checkAgentDraft } from './agentDraft.js'
import { AgentInterviews, INSTRUCTIONS_CLOSED } from './agentInterview.js'
import type { Store } from './store.js'

type AgentMessage = Extract<ClientMessage, { type: 'save_agent' | 'delete_agent' }>

type AgentStore = Pick<
  Store,
  | 'clearSession'
  | 'deleteAgent'
  | 'getProject'
  | 'listChats'
  | 'listRoutines'
  | 'loadRoster'
  | 'saveAgent'
>

interface AgentModuleOptions {
  store: AgentStore
  agents: () => readonly AgentConfig[]
  setAgents: (agents: readonly AgentConfig[]) => void
  skills?: () => readonly SkillConfig[]
  broadcast: (message: ServerMessage) => void
  discardRoutineWork: (agentId: string) => Promise<string[]>
  broadcastRoutines: () => Promise<void>
  broadcastDirectory: () => Promise<void>
  /** Opens a new chat agent's DM on the interview that writes its instructions. */
  startInterview?: (agent: AgentConfig) => Promise<void>
  onChatsDeleted?: (chatIds: readonly string[]) => void
}

/**
 * Owns the live persona household. Validation, relational guards, session resets,
 * delete cascades and roster publication all cross this one interface.
 */
export class AgentModule {
  /** Open interviews, each the one path by which an agent writes its own instructions. */
  readonly interviews = new AgentInterviews()

  constructor(private readonly options: AgentModuleOptions) {}

  document(): ServerMessage {
    return { type: 'roster', agents: [...this.options.agents()] }
  }

  /** Absorbs the Realtime echo of Manor's own writes and publishes external ones. */
  async refresh(): Promise<void> {
    const agents = await this.options.store.loadRoster()
    if (JSON.stringify(agents) === JSON.stringify(this.options.agents())) return
    this.publish(agents)
  }

  /** Reloads after a confirmed write, including derived ids and chief-of-staff changes. */
  async reload(): Promise<void> {
    this.publish(await this.options.store.loadRoster())
  }

  async handle(
    message: AgentMessage,
    reply: (message: ServerMessage) => void,
    ack: () => void,
  ): Promise<void> {
    switch (message.type) {
      case 'save_agent': {
        const previous = message.agent.id === undefined
          ? undefined
          : this.options.agents().find((agent) => agent.id === message.agent.id)
        const checked = checkAgentDraft(message.agent, this.options.agents())
        if (!checked.ok) {
          reply({ type: 'notice', kind: 'error', text: checked.message })
          return
        }
        if (message.interview === true && (checked.draft.id !== undefined || checked.draft.placement === 'session')) {
          reply({ type: 'notice', kind: 'error', text: 'Only a new chat agent starts with an interview.' })
          return
        }
        const skillIds = [...new Set(checked.draft.skillIds ?? [])]
        const unknownSkill = skillIds.find(
          (skillId) => !(this.options.skills?.() ?? []).some((skill) => skill.id === skillId),
        )
        if (unknownSkill !== undefined) {
          reply({ type: 'notice', kind: 'error', text: `$${unknownSkill} is not an imported skill, so it cannot be attached.` })
          return
        }
        if (checked.draft.placement === 'session' && previous?.placement !== 'session') {
          const group = (await this.options.store.listChats()).find((chat) =>
            chat.kind === 'group' && chat.memberIds.includes(previous?.id ?? ''))
          const routine = (await this.options.store.listRoutines()).find((row) => row.agentId === previous?.id)
          if (group !== undefined || routine !== undefined) {
            reply({ type: 'notice', kind: 'error', text: 'Remove this persona from groups and routines before moving it to Sessions.' })
            return
          }
        }
        const saved = await this.options.store.saveAgent({ ...checked.draft, skillIds })
        await this.reload()
        // The agent stands on its starter instructions either way, so a failed start costs only the interview.
        if (message.interview === true) {
          await this.options.startInterview?.(saved).catch((error: unknown) => console.warn('[manor] the interview could not start', error))
        }
        ack()
        return
      }
      case 'delete_agent': {
        if (!this.options.agents().some((agent) => agent.id === message.agentId)) {
          reply({
            type: 'notice',
            kind: 'error',
            text: `There is no persona to delete: ${message.agentId} is not on the roster.`,
          })
          return
        }
        const deletedRunIds = await this.options.discardRoutineWork(message.agentId)
        await this.options.store.deleteAgent(message.agentId)
        this.options.onChatsDeleted?.(deletedRunIds)
        await this.reload()
        await this.options.broadcastRoutines()
        await this.options.broadcastDirectory()
        ack()
        return
      }
    }
  }

  /**
   * The interview's one write of the agent's instructions (agent setup 2/4). Refused unless
   * the agent's interview is open; the write closes it, so a second one is refused too.
   */
  async writeInstructions(agentId: string, instructions: string): Promise<void> {
    const agent = this.options.agents().find((row) => row.id === agentId)
    const kickoffId = agent === undefined ? undefined : this.interviews.claim(agentId)
    if (agent === undefined || kickoffId === undefined) throw new Error(INSTRUCTIONS_CLOSED)
    try {
      await this.options.store.saveAgent({ ...agent, character: instructions })
    } catch (error: unknown) {
      // Nothing was written, so the interview keeps its one write; its turn's end still closes it.
      this.interviews.begin(agentId, kickoffId)
      throw error
    }
    await this.reload()
  }

  private publish(agents: readonly AgentConfig[]): void {
    this.options.setAgents(agents)
    this.options.broadcast({ type: 'roster', agents: [...agents] })
  }
}
