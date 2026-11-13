import type { McpServerConfig, McpServerDraft } from '@manor/contracts'

type McpServerLike = Pick<McpServerConfig | McpServerDraft, 'envKeys' | 'httpHeaders'>

/** Every host variable this MCP attachment deliberately grants to a probe or CLI. */
export function mcpEnvironmentKeys(server: McpServerLike): string[] {
  return [...new Set([
    ...server.envKeys,
    ...(server.httpHeaders ?? []).map(({ envKey }) => envKey),
  ])]
}

/** Resolves header values only at the process boundary; registry rows keep names. */
export function resolveMcpHttpHeaders(
  server: McpServerLike,
  hostEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const { name, envKey } of server.httpHeaders ?? []) {
    const value = hostEnv[envKey]
    if (value === undefined || value.length === 0) {
      throw new Error(
        `the environment of this server has no value for ${envKey}; ` +
        'set it on the machine Manor runs on, it is never stored by Manor',
      )
    }
    headers[name] = value
  }
  return headers
}

/** Provider configs reference the variable; they never receive its resolved value. */
export function mcpHttpHeaderEnvMap(server: McpServerLike): Record<string, string> {
  return Object.fromEntries((server.httpHeaders ?? []).map(({ name, envKey }) => [name, envKey]))
}
