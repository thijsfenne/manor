import type { Driver, McpServerConfig, TurnHandle, TurnInput } from '@manor/contracts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TokenGate } from './auth.js'

type Stage = 'inputPrepared' | 'processStarted' | 'processInitialized' | 'threadReady' | 'firstEvent' | 'firstVisibleText' | 'finished'
interface TurnReport {
  provider: TurnInput['agent']['driver']
  model: string | null
  effort: string
  speed: string
  reportedModel: string | null
  observedSpeed: 'fast' | null
  resumed: boolean
  single: boolean
  connections: string[]
  registeredSchemaChars: number
  enabledToolCount: number
  unmeasuredConnections: number
  stagesMs: Partial<Record<Stage, number>>
  outcome: 'running' | 'completed' | 'error' | 'stopped'
}

/** Bounded in-memory measurements. No prompts, tool arguments, paths or credentials. */
export class RuntimeDiagnostics {
  private turns: TurnReport[] = []

  /**
   * `onFinished` gets each finished turn as one JSON line, so timings outlive the 50-turn
   * ring and a restart. It carries the same fields as `report()`, never content.
   */
  constructor(private readonly onFinished?: (line: string) => void) {}

  start(input: TurnInput, startedAt: number) {
    const attachments = input.mcpServers ?? []
    const report: TurnReport = {
      provider: input.agent.driver, model: input.agent.model ?? null, effort: input.agent.effort,
      speed: input.speed ?? 'standard', resumed: input.sessionId !== undefined, single: input.singleSession === true,
      reportedModel: null, observedSpeed: null,
      connections: attachments.map(({ server }) => server.name),
      registeredSchemaChars: attachments.reduce((sum, { server }) => sum + server.schemaChars, 0),
      enabledToolCount: attachments.reduce((sum, { server, disabledTools }) => sum + server.tools.filter((tool) => !disabledTools.includes(tool)).length, 0),
      unmeasuredConnections: attachments.filter(({ server }) => server.schemaChars === 0).length,
      stagesMs: {}, outcome: 'running',
    }
    this.turns.push(report)
    if (this.turns.length > 50) this.turns.shift()
    const stage = (name: Stage) => { report.stagesMs[name] ??= Math.max(0, Date.now() - startedAt) }
    stage('inputPrepared')
    const onFinished = this.onFinished
    return {
      stage,
      observe(handle: TurnHandle): TurnHandle {
        return {
          ...(handle.steer === undefined ? {} : { steer: (event) => handle.steer!(event) }),
          stop() { if (report.outcome === 'running') report.outcome = 'stopped'; handle.stop() },
          events: (async function* () {
            try {
              for await (const event of handle.events) {
                stage('firstEvent')
                if ((event.type === 'delta' || event.type === 'message') && event.text.trim().length > 0) stage('firstVisibleText')
                if (event.type === 'error') report.outcome = 'error'
                if (event.type === 'result') {
                  report.reportedModel = event.reportedModel ?? null
                  report.observedSpeed = event.observedSpeed ?? null
                  if (report.outcome === 'running') report.outcome = 'completed'
                }
                yield event
              }
            } catch (error) {
              report.outcome = 'error'
              throw error
            } finally {
              if (report.outcome === 'running') report.outcome = 'stopped'
              stage('finished')
              onFinished?.(JSON.stringify({ at: new Date().toISOString(), ...report }))
            }
          })(),
        }
      },
    }
  }

  async report(providers: Partial<Record<string, Driver>>, connections: readonly McpServerConfig[], browserReady: boolean) {
    return {
      version: 1,
      providers: await Promise.all(Object.entries(providers).map(async ([provider, driver]) => ({
        provider, ...await driver?.describeRuntime?.() ?? { command: null, version: null },
      }))),
      browser: { ready: browserReady, error: browserReady ? null : 'no_desktop_host' },
      connections: connections.map((server) => ({
        name: server.name, available: server.unavailable === undefined,
        error: server.unavailable === undefined ? null : 'connection_unavailable',
        toolCount: server.tools.length, registeredSchemaChars: server.schemaChars,
      })),
      schemaMeasurement: 'Registered full schemas from existing probes; filtered provider delivery is not measured.',
      turns: this.turns.map((turn) => ({ ...turn, stagesMs: { ...turn.stagesMs } })),
    }
  }
}

export async function handleDiagnostics(request: IncomingMessage, response: ServerResponse, gate: TokenGate, report: () => Promise<unknown>): Promise<void> {
  response.setHeader('content-type', 'application/json')
  response.setHeader('cache-control', 'no-store')
  try {
    const token = request.headers.authorization?.replace(/^Bearer /i, '')
    if (!await gate.allow(token)) { response.writeHead(401); response.end('{"error":"unauthorized"}'); return }
    response.end(JSON.stringify(await report()))
  } catch {
    response.writeHead(503)
    response.end('{"error":"diagnostics_unavailable"}')
  }
}
