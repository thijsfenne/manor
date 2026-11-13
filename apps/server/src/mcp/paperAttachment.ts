import type { McpServerDraft } from '@manor/contracts'

export const PAPER_MCP_NAME = 'paper'
export const PAPER_DESKTOP_URL = 'http://127.0.0.1:29979/mcp'

/**
 * Paper exposes its MCP from the desktop app while a document is open.
 * There is no credential in the row; attachment remains the per-persona gate.
 */
export function paperMcpDraft(): McpServerDraft {
  return {
    name: PAPER_MCP_NAME,
    command: '',
    args: [],
    envKeys: [],
    url: PAPER_DESKTOP_URL,
    description: 'Create and edit designs in the open Paper Desktop file. Requires Paper Desktop to have a file open.',
    writes: true,
    effectPolicy: 'trusted',
  }
}
