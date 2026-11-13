import type { McpServerDraft } from '@manor/contracts'
import { COMPUTER_MCP_NAME } from '../computerPolicy.js'

/** Installed by `scripts/provision-computer.sh`; the grants belong to this app. */
export const CUA_DRIVER_PATH = '/Applications/CuaDriver.app/Contents/MacOS/cua-driver'

/**
 * Upstream Cua's own MCP mode. It launches the driver daemon through LaunchServices,
 * so macOS attributes Accessibility and Screen Recording to CuaDriver.app rather
 * than to Manor. Multiple uses persona attachments; a Single session receives every
 * registered connector, this one included. The lease is per turn.
 */
export function computerMcpDraft(): McpServerDraft {
  return {
    name: COMPUTER_MCP_NAME,
    command: CUA_DRIVER_PATH,
    args: ['mcp'],
    // The driver finds its daemon socket and its persisted telemetry-off setting under
    // HOME; without it every call waits ten seconds and fails.
    envKeys: ['HOME'],
    description: 'Use Mac apps in the background (Cua driver). The first action of a turn asks to borrow the Mac; Escape stops it. When a canvas app drops background input, retry that one call with delivery_mode foreground and its window_id.',
    writes: true,
    effectPolicy: 'confirm_writes',
  }
}
