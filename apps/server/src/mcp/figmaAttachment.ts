import type { McpServerDraft } from '@manor/contracts'

export const FIGMA_MCP_NAME = 'figma'
export const FIGMA_REMOTE_URL = 'https://mcp.figma.com/mcp'

/**
 * Tool names Figma documents for the remote server. Used only when Manor's own
 * probe gets 401 (OAuth lives in the CLI, not here) so the persona form is not
 * empty. The CLI advertises the live list on a turn. schemaChars stays 0 until
 * a probe with credentials succeeds.
 */
export const FIGMA_REMOTE_TOOLS = [
  'get_metadata',
  'get_design_context',
  'get_screenshot',
  'get_variable_defs',
  'use_figma',
] as const

/**
 * The registry row for Figma's remote MCP, the same endpoint Cursor uses.
 *
 * A registry row rather than a built-in: which personas may talk to Figma is a
 * per-persona decision. There is no credential in the row. OAuth is the CLI's
 * (Claude/Codex/Grok authenticate once against this URL). Manor's probe will
 * 401, which register:figma treats as "the server is there, login is elsewhere".
 */
export function figmaMcpDraft(): McpServerDraft {
  return {
    name: FIGMA_MCP_NAME,
    command: '',
    args: [],
    envKeys: [],
    url: FIGMA_REMOTE_URL,
    description:
      'Official Figma MCP. File-key plus node-id from a Figma URL. OAuth lives in the CLI, not in Manor. Can write via use_figma.',
    writes: true,
    effectPolicy: 'confirm_writes',
  }
}
