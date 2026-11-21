import { createHash } from 'node:crypto'
import { mcpHttpUrl, type AttachedMcpServer } from '@manor/contracts'
import { mcpEnvironmentKeys, mcpHttpHeaderEnvMap } from './httpHeaders.js'
import { mcpBearerEnvKey } from './oauth.js'
import { builtInMcpArgs, nodeRuntimeEnvKeys } from './browserAttachment.js'
import { desktopTools } from '../computerPolicy.js'

export const EFFECT_BROKER_CAPABILITY_PREFIX = 'MANOR_EFFECT_BROKER_CAPABILITY_'

export interface EffectProxyUpstream {
  name: string
  command: string
  args: string[]
  envKeys: string[]
  url?: string
  httpHeaders: Record<string, string>
  bearerEnvKey?: string
  /** Stdio only: the tools the model may see and call, owned by Manor code. */
  allowTools?: string[]
}

export function effectCapabilityEnvKey(serverId: string): string {
  const id = createHash('sha256').update(serverId).digest('hex').slice(0, 24).toUpperCase()
  return `${EFFECT_BROKER_CAPABILITY_PREFIX}${id}`
}

/** Connector secrets for the capability store. The CLI never receives these keys. */
export function proxySecretEnv(attached: AttachedMcpServer): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of mcpEnvironmentKeys(attached.server)) {
    const value = attached.runtimeEnv?.[key] ?? process.env[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  for (const [key, value] of Object.entries(attached.runtimeEnv ?? {})) {
    if (key.includes('CAPABILITY') || value === '') continue
    env[key] = value
  }
  return env
}

/**
 * Keeps the model-facing server and tool names stable while replacing the transport
 * with a Manor-owned pre-call gate. Secret values stay on the issued capability.
 * The provider CLI only receives the capability token.
 */
export function effectProxyAttachment(
  attached: AttachedMcpServer,
  brokerUrl: string,
  capability: string,
  runtime: { execPath?: string; execArgv?: readonly string[]; entryPath?: string } = {},
): AttachedMcpServer {
  const { server } = attached
  const upstream = effectProxyUpstream(attached)
  const capabilityEnv = effectCapabilityEnvKey(server.id)

  return {
    server: {
      ...server,
      command: runtime.execPath ?? process.execPath,
      args: [
        ...builtInMcpArgs('effectProxy', runtime),
        '--broker-url',
        brokerUrl,
        '--capability-env',
        capabilityEnv,
        '--upstream',
        Buffer.from(JSON.stringify(upstream)).toString('base64url'),
      ],
      envKeys: nodeRuntimeEnvKeys(),
      httpHeaders: undefined,
      url: undefined,
    },
    disabledTools: [...attached.disabledTools],
    runtimeEnv: { [capabilityEnv]: capability },
  }
}

/**
 * HTTP upstreams the Manor server forwards itself, so they cost no process. Stdio
 * upstreams still need one, and Executor keeps the proxy for its script permits.
 */
export function forwardsOverHttp(attached: AttachedMcpServer): boolean {
  const upstream = effectProxyUpstream(attached)
  return upstream.url !== undefined && upstream.allowTools === undefined && upstream.name !== 'executor'
}

/** What the gate needs to reach the real server; secret values stay on the capability. */
export function effectProxyUpstream(attached: AttachedMcpServer): EffectProxyUpstream {
  const { server } = attached
  const url = mcpHttpUrl(server)
  const bearerEnvKey = mcpBearerEnvKey(server.name)
  const envKeys = [...new Set([
    ...mcpEnvironmentKeys(server),
    ...Object.keys(attached.runtimeEnv ?? {}).filter((key) => !key.includes('CAPABILITY')),
  ])]
  const allowTools = desktopTools(server.name)
  return {
    name: server.name,
    command: server.command,
    args: [...server.args],
    envKeys,
    ...(url === undefined ? {} : { url }),
    httpHeaders: mcpHttpHeaderEnvMap(server),
    ...(attached.runtimeEnv?.[bearerEnvKey] === undefined ? {} : { bearerEnvKey }),
    ...(allowTools === undefined ? {} : { allowTools: [...allowTools] }),
  }
}
