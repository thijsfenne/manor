/**
 * The Manor-owned surface of the Cua computer connector. The driver advertises
 * about sixty tools and 147k schema characters; a persona sees only these, and
 * the broker refuses anything else before the driver receives it.
 */
export const COMPUTER_MCP_NAME = 'computer'

export const COMPUTER_READ_TOOLS = ['list_apps', 'list_windows', 'get_window_state', 'zoom'] as const
const COMPUTER_WRITE_TOOLS = [
  'launch_app',
  'click',
  'drag',
  'type_text',
  'press_key',
  'hotkey',
  'scroll',
  'invoke_menu',
] as const

export const COMPUTER_TOOLS: readonly string[] = [...COMPUTER_READ_TOOLS, ...COMPUTER_WRITE_TOOLS]
const allowed = new Set<string>(COMPUTER_TOOLS)

/**
 * Codex's computer-use engine from the ChatGPT app, registered beside Cua rather than
 * instead of it. Its `js` tool runs model-written JavaScript that can also reach files
 * and the shell, so it takes the same desktop lease as Cua. `js_add_node_module_dir`
 * loads arbitrary packages and `turn_ended` is the host's own hook; neither is offered.
 */
export const CODEX_COMPUTER_MCP_NAME = 'codex-computer'
export const CODEX_COMPUTER_TOOLS: readonly string[] = ['js', 'js_reset']

/** The tools Manor lets through on a connector that drives the Mac; undefined for any other connector. */
export function desktopTools(connector: string): readonly string[] | undefined {
  if (connector === COMPUTER_MCP_NAME) return COMPUTER_TOOLS
  if (connector === CODEX_COMPUTER_MCP_NAME) return CODEX_COMPUTER_TOOLS
  return undefined
}

/** Both computer connectors share one human lease per turn, the Escape stop and the call budget below. */
export const drivesDesktop = (connector: string): boolean => desktopTools(connector) !== undefined

/**
 * The engine asks `Allow Computer Use to use "<app>"?` through MCP elicitation before
 * it touches each app. No driver can answer that mid-turn, so the effect proxy does,
 * and only for this exact empty-form shape while a lease-approved call is running.
 * Anything else it asks, such as recording audio, is declined.
 */
export function codexAppAccess(params: unknown): boolean {
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  if (!record(params) || (params.mode !== undefined && params.mode !== 'form')) return false
  if (typeof params.message !== 'string' || !/^Allow Computer Use to use ".+"\?$/.test(params.message)) return false
  const meta = params._meta
  if (!record(meta) || meta.connector_id !== 'computer-use' || meta.codex_approval_kind !== 'mcp_tool_call') return false
  const schema = params.requestedSchema
  return record(schema) && schema.type === 'object' && record(schema.properties) &&
    Object.keys(schema.properties).length === 0
}

/** Screenshots count as calls, so a canvas app needs more room than the shared 60. */
export const COMPUTER_CALL_LIMIT = 150

/** Why a call on either computer connector is refused before it runs, or undefined. */
export function desktopRefusal(connector: string, tool: string, arguments_: unknown): string | undefined {
  if (connector !== CODEX_COMPUTER_MCP_NAME) return computerRefusal(tool, arguments_)
  // The script itself is opaque to Manor; the lease approval is what admits it.
  return CODEX_COMPUTER_TOOLS.includes(tool) ? undefined : `${connector}.${tool} is not available in Manor.`
}

/**
 * Why a computer call is refused before it reaches the driver, or undefined.
 * Background delivery is the default: the user keeps their front window, so any
 * argument that targets whatever app is frontmost or writes a file outside the
 * driver is refused rather than rewritten. Foreground delivery is the one
 * exception, for canvas apps (Overflow, Figma) that drop background input: the
 * driver fronts one exact window, acts, and restores the previous app, inside
 * the turn's human-granted lease.
 */
export function computerRefusal(tool: string, arguments_: unknown): string | undefined {
  if (!allowed.has(tool)) return `computer.${tool} is not available in Manor.`
  // The proxy always sends the call's arguments; without them nothing below can be checked.
  if (typeof arguments_ !== 'object' || arguments_ === null || Array.isArray(arguments_)) {
    return `computer.${tool} arrived without its arguments, so it was not run.`
  }
  const args = arguments_ as Record<string, unknown>
  if (args.delivery_mode === 'foreground' && args.window_id === undefined && args.target === undefined) {
    return 'Foreground delivery needs the exact window: pass pid and window_id. Use it only after a background attempt did not land.'
  }
  if (args.scope !== undefined && args.scope !== 'window') {
    return 'scope "desktop" types into whatever app is frontmost, which is the user\'s. Target a pid or window_id instead.'
  }
  // `target` may only name an exact window; the display form addresses the whole screen.
  if (args.target !== undefined && (
    typeof args.target !== 'object' || args.target === null || (args.target as Record<string, unknown>).kind !== 'window'
  )) {
    return 'Only a window target is allowed; a display target acts on the user\'s screen. Pass pid and window_id instead.'
  }
  if (args.debug_image_out !== undefined || args.screenshot_out_file !== undefined) {
    return 'Writing screenshots to files is off in Manor; read the returned image instead.'
  }
  if (tool === 'launch_app' && (args.additional_arguments !== undefined || args.webkit_inspector_port !== undefined)) {
    return 'launch_app may open an app by name, bundle id or URL, without extra launch arguments.'
  }
  return undefined
}
