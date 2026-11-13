import { reviewedConnectorRead } from '../effectPolicy.js'

/** What a stdio or HTTP probe learned; shared so both transports stay independent. */
export interface McpProbeResult {
  /** Tool names as the server reports them, without the `mcp__<name>__` prefix. */
  tools: string[]
  /** Tools exempted by Manor's exact, code-owned connector policy. */
  readOnlyTools: string[]
  /**
   * Wire size of what the CLI injects per turn: every tool's name, description and
   * input schema, plus the server's `instructions` block.
   */
  schemaChars: number
  /** A real side-effect-free tool call succeeded, not merely the MCP handshake. */
  verifiedBy?: string
}

/** Connector metadata is descriptive only; the read boundary stays Manor-owned. */
export const readOnlyToolNames = (
  serverName: string,
  tools: readonly Record<string, unknown>[],
): string[] =>
  tools.flatMap((tool) => {
    const name = tool['name']
    return typeof name === 'string' && reviewedConnectorRead(serverName, name) ? [name] : []
  })
