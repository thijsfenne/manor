import type {
  AgentConfig,
  WorkflowSuggestion,
  ClientMessage,
  McpHostStatus,
  McpServerConfig,
  McpServerDraft,
  ServerMessage,
  SkillConfig,
} from '@manor/contracts'
import { mcpHttpUrl } from '@manor/contracts'
import { checkMcpDraft } from './mcp/draft.js'
import { COMPOSIO_MCP_NAME } from './mcp/composioAttachment.js'
import { reconcileComposioServer } from './mcp/composioRegistration.js'
import { mcpEnvironmentKeys } from './mcp/httpHeaders.js'
import { beginMcpOAuth, isOauthRequired, openLoginBrowser } from './mcp/oauth.js'
import type { DiscoveredSkill } from './skills/discovery.js'
import { withSkillUsage, type SkillUsage } from './skills/usage.js'
import type { Store } from './store.js'

type ConnectionStore = Pick<
  Store,
  | 'deleteMcpServer'
  | 'deleteSkill'
  | 'listMcpServers'
  | 'listSkills'
  | 'saveAgent'
  | 'saveMcpServer'
  | 'saveSkill'
>

type ConnectionMessage = Extract<
  ClientMessage,
  {
    type:
      | 'save_mcp_server'
      | 'verify_mcp_server'
      | 'delete_mcp_server'
      | 'list_skill_candidates'
      | 'list_workflow_suggestions'
      | 'import_skill'
      | 'delete_skill'
  }
>

interface ConnectionModuleOptions {
  store: ConnectionStore
  agents: () => readonly AgentConfig[]
  mcpServers: () => readonly McpServerConfig[]
  setMcpServers: (servers: readonly McpServerConfig[]) => void
  skills?: () => readonly SkillConfig[]
  setSkills?: (skills: readonly SkillConfig[]) => void
  probeMcpServer?: (draft: McpServerDraft) => Promise<{
    tools: string[]
    readOnlyTools: string[]
    schemaChars: number
    verifiedBy?: string
  }>
  hostEnv?: NodeJS.ProcessEnv
  skillUsage?: () => Promise<ReadonlyMap<string, SkillUsage> | null>
  discoverSkills?: () => Promise<DiscoveredSkill[]>
  workflowSuggestions?: () => Promise<WorkflowSuggestion[] | null>
  broadcast: (message: ServerMessage) => void
  reloadRoster: () => Promise<void>
}

/**
 * Owns the household's provider-neutral skill and MCP registries. Persistence,
 * host verification and registry broadcasts stay behind the same protocol seam.
 */
export class ConnectionModule {
  private readonly mcpChecks = new Map<string, NonNullable<McpHostStatus['check']>>()

  constructor(private readonly options: ConnectionModuleOptions) {}

  registry(): ServerMessage {
    return { type: 'mcp_servers', servers: [...this.options.mcpServers()] }
  }

  hostStatuses(): ServerMessage {
    const env = this.options.hostEnv ?? process.env
    return {
      type: 'mcp_host_statuses',
      statuses: this.options.mcpServers().map((server) => ({
        serverId: server.id,
        env: mcpEnvironmentKeys(server).map((key) => ({ key, present: Boolean(env[key]) })),
        check: this.mcpChecks.get(server.id) ?? null,
      })),
    }
  }

  async skillRegistry(skills = this.options.skills?.() ?? []): Promise<ServerMessage> {
    const usage = (await this.options.skillUsage?.()) ?? null
    return { type: 'skills', skills: withSkillUsage(skills, usage) }
  }

  async handle(
    message: ConnectionMessage,
    reply: (message: ServerMessage) => void,
    ack: () => void,
  ): Promise<void> {
    switch (message.type) {
      case 'save_mcp_server': {
        const existing = this.options.mcpServers().find((server) => server.id === message.server.id)
        if (existing?.unavailable !== undefined) {
          reply({ type: 'notice', kind: 'error', text: `Reconnect ${existing.name} before editing its settings.` })
          return
        }
        const checked = checkMcpDraft(message.server, this.options.mcpServers())
        if (!checked.ok) {
          reply({ type: 'notice', kind: 'error', text: checked.message })
          return
        }
        const { probeMcpServer } = this.options
        if (probeMcpServer === undefined) {
          reply({ type: 'notice', kind: 'error', text: 'This Manor cannot start MCP servers, so it cannot register one.' })
          return
        }
        let probed: { tools: string[]; readOnlyTools: string[]; schemaChars: number; verifiedBy?: string }
        try {
          probed = await probeMcpServer(checked.draft)
        } catch (error: unknown) {
          reply({
            type: 'notice',
            kind: 'error',
            text: `${checked.draft.name} did not respond, so it was not saved: ${(error as Error).message}`,
          })
          return
        }
        const saved = await this.options.store.saveMcpServer(checked.draft, probed)
        this.mcpChecks.set(saved.id, {
          checkedAt: new Date().toISOString(),
          result: probed.verifiedBy === undefined ? 'server_only' : 'verified',
          ...(probed.verifiedBy === undefined ? {} : { tool: probed.verifiedBy }),
        })
        await this.reloadRegistry()
        ack()
        return
      }
      case 'verify_mcp_server': {
        const server = this.options.mcpServers().find((candidate) => candidate.id === message.serverId)
        if (server === undefined) {
          reply({ type: 'notice', kind: 'error', text: 'That MCP server is no longer in the registry.' })
          return
        }
        const { probeMcpServer } = this.options
        if (probeMcpServer === undefined) {
          reply({ type: 'notice', kind: 'error', text: 'This Manor cannot start MCP servers, so it cannot test one.' })
          return
        }
        if (server.name === COMPOSIO_MCP_NAME) {
          const reconciled = await reconcileComposioServer(this.options.store, this.options.mcpServers(), {
            env: this.options.hostEnv ?? process.env,
            probe: probeMcpServer,
            force: true,
          })
          const checked = reconciled.find((candidate) => candidate.id === server.id)!
          // Keep concurrent edits to other connectors; only this row was checked.
          this.options.setMcpServers(this.options.mcpServers().map((candidate) =>
            candidate.id === checked.id ? checked : candidate,
          ))
          this.mcpChecks.set(server.id, {
            checkedAt: new Date().toISOString(),
            result: checked.unavailable === undefined ? 'server_only' : 'failed',
          })
          await this.reloadRegistry()
          reply({
            type: 'notice',
            kind: checked.unavailable === undefined ? 'info' : 'error',
            text: checked.unavailable ?? 'Composio connected.',
          })
          if (checked.unavailable === undefined) ack()
          return
        }
        try {
          const probed = await probeMcpServer(server)
          // A successful Test is also the freshest security metadata. This matters
          // for OAuth connectors first registered before login: until this write,
          // every tool correctly remains an unknown write.
          await this.options.store.saveMcpServer(server, probed)
          this.mcpChecks.set(server.id, {
            checkedAt: new Date().toISOString(),
            result: probed.verifiedBy === undefined ? 'server_only' : 'verified',
            ...(probed.verifiedBy === undefined ? {} : { tool: probed.verifiedBy }),
          })
          await this.reloadRegistry()
          reply({
            type: 'notice',
            kind: 'info',
            text:
              probed.verifiedBy === undefined
                ? `${server.name} starts and lists its tools, but exposes no known safe call for checking its credentials.`
                : `${server.name} verified through ${probed.verifiedBy}.`,
          })
          ack()
        } catch (error: unknown) {
          const url = mcpHttpUrl(server)
          if (isOauthRequired(error) && url !== undefined) {
            try {
              await beginMcpOAuth(url, { open: openLoginBrowser })
              reply({
                type: 'notice',
                kind: 'info',
                text: `${server.name} needs a login. A browser window opened. Finish it there, then press Test again.`,
              })
              return
            } catch (oauthError: unknown) {
              reply({
                type: 'notice',
                kind: 'error',
                text: `${server.name} could not start a login: ${oauthError instanceof Error ? oauthError.message : 'failed'}`,
              })
              return
            }
          }
          this.mcpChecks.set(server.id, { checkedAt: new Date().toISOString(), result: 'failed' })
          this.options.broadcast(this.hostStatuses())
          reply({ type: 'notice', kind: 'error', text: `${server.name} failed verification: ${(error as Error).message}` })
        }
        return
      }
      case 'list_skill_candidates': {
        this.options.broadcast(await this.skillRegistry())
        const discovered = await this.options.discoverSkills?.() ?? []
        const imported = new Set((this.options.skills?.() ?? []).map((skill) => skill.id))
        reply({
          type: 'skill_candidates',
          skills: discovered
            .filter(({ candidate }) => !imported.has(candidate.slug))
            .map(({ candidate }) => candidate),
        })
        return
      }
      case 'list_workflow_suggestions': {
        const suggestions = (await this.options.workflowSuggestions?.()) ?? null
        reply({
          type: 'workflow_suggestions',
          available: suggestions !== null,
          suggestions: suggestions ?? [],
        })
        return
      }
      case 'import_skill': {
        const discover = this.options.discoverSkills
        if (discover === undefined) {
          reply({ type: 'notice', kind: 'error', text: 'This Manor has no local skill folders to import from.' })
          return
        }
        const found = (await discover()).find(({ candidate }) => candidate.candidateId === message.candidateId)
        if (found === undefined) {
          reply({ type: 'notice', kind: 'error', text: 'That local skill is no longer available. Refresh the import list.' })
          return
        }
        if ((this.options.skills?.() ?? []).some((skill) => skill.id === found.skill.id)) {
          reply({ type: 'notice', kind: 'info', text: `$${found.skill.id} is already imported.` })
          ack()
          return
        }
        await this.options.store.saveSkill(found.skill, found.files)
        const cos = this.options.agents().find((agent) => agent.isCos)
        if (cos !== undefined && (cos.skillIds ?? []).length === 0) {
          await this.options.store.saveAgent({
            ...cos,
            skillIds: [...(cos.skillIds ?? []), found.skill.id],
          })
        }
        await this.reloadSkills()
        if (cos !== undefined) await this.options.reloadRoster()
        reply({
          type: 'skill_candidates',
          skills: (await discover())
            .filter(({ candidate }) => !(this.options.skills?.() ?? []).some((skill) => skill.id === candidate.slug))
            .map(({ candidate }) => candidate),
        })
        ack()
        return
      }
      case 'delete_skill': {
        if (!(this.options.skills?.() ?? []).some((skill) => skill.id === message.skillId)) {
          reply({ type: 'notice', kind: 'error', text: `There is no skill to delete: $${message.skillId} is not imported.` })
          return
        }
        await this.options.store.deleteSkill(message.skillId)
        await this.reloadSkills()
        await this.options.reloadRoster()
        ack()
        return
      }
      case 'delete_mcp_server': {
        if (!this.options.mcpServers().some((server) => server.id === message.serverId)) {
          reply({ type: 'notice', kind: 'error', text: `There is no MCP server to delete: ${message.serverId} is not registered.` })
          return
        }
        await this.options.store.deleteMcpServer(message.serverId)
        this.mcpChecks.delete(message.serverId)
        await this.reloadRegistry()
        await this.options.reloadRoster()
        ack()
        return
      }
    }
  }

  /**
   * After the Composio key was saved or removed: the reconcile startup runs, so the
   * composio row is registered, renewed or marked unavailable without a restart.
   */
  async reconcileComposio(): Promise<void> {
    const { probeMcpServer } = this.options
    const reconciled = await reconcileComposioServer(this.options.store, this.options.mcpServers(), {
      env: this.options.hostEnv ?? process.env,
      ...(probeMcpServer === undefined ? {} : { probe: probeMcpServer }),
      force: true,
    })
    const row = reconciled.find((candidate) => candidate.name === COMPOSIO_MCP_NAME)
    if (row === undefined) return
    const current = this.options.mcpServers()
    this.options.setMcpServers(current.some((candidate) => candidate.id === row.id)
      ? current.map((candidate) => candidate.id === row.id ? row : candidate)
      : [...current, row])
    await this.reloadRegistry()
  }

  private async reloadRegistry(): Promise<void> {
    const stored = await this.options.store.listMcpServers()
    const live = new Map(this.options.mcpServers().map((server) => [server.id, server]))
    const servers = stored.map((server) => {
      const liveServer = live.get(server.id)
      if (liveServer === undefined) return server
      return {
        ...server,
        ...(liveServer.unavailable === undefined ? {} : { unavailable: liveServer.unavailable }),
        ...(liveServer.connectedApps === undefined ? {} : { connectedApps: liveServer.connectedApps }),
      }
    })
    this.options.setMcpServers(servers)
    this.options.broadcast({ type: 'mcp_servers', servers: [...servers] })
    this.options.broadcast(this.hostStatuses())
  }

  private async reloadSkills(): Promise<void> {
    const skills = await this.options.store.listSkills()
    this.options.setSkills?.(skills)
    this.options.broadcast(await this.skillRegistry(skills))
  }
}
