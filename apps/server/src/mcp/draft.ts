import type { McpServerConfig, McpServerDraft } from '@manor/contracts'
import { parseHttpMcpUrl } from '@manor/contracts'
import { BUILT_IN_ARTIFACT_MCP_NAME } from './artifactAttachment.js'
import { BUILT_IN_BROWSER_MCP_NAME } from './browserAttachment.js'
import { BUILT_IN_INTERACTION_MCP_NAME } from './interactionAttachment.js'
import { BUILT_IN_ROUTINE_MCP_NAME } from './routineAttachment.js'
import { BUILT_IN_SKILL_MCP_NAME } from './skillAttachment.js'
import { BUILT_IN_WORK_MCP_NAME } from './workAttachment.js'

type McpDraftCheck = { ok: true; draft: McpServerDraft } | { ok: false; message: string }

const MCP_NAME = /^[a-z0-9][a-z0-9_-]*$/
const RESERVED_MCP_NAMES = new Set([
  BUILT_IN_ARTIFACT_MCP_NAME,
  BUILT_IN_BROWSER_MCP_NAME,
  BUILT_IN_INTERACTION_MCP_NAME,
  BUILT_IN_ROUTINE_MCP_NAME,
  BUILT_IN_SKILL_MCP_NAME,
  BUILT_IN_WORK_MCP_NAME,
])
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** Validates and normalises every registry rule before a server is probed. */
export function checkMcpDraft(
  draft: McpServerDraft,
  registry: readonly McpServerConfig[],
): McpDraftCheck {
  const name = draft.name.trim()
  const command = draft.command.trim()
  const rawUrl = draft.url?.trim() ?? ''

  if (!MCP_NAME.test(name)) {
    return {
      ok: false,
      message: `${name.length === 0 ? 'A server' : name} needs a name of lowercase letters, digits, dashes or underscores: it becomes the mcp__<name>__ prefix on every tool it offers.`,
    }
  }
  const taken = registry.some((server) => server.id !== draft.id && server.name === name)
  if (taken) {
    return { ok: false, message: `There is already a server called ${name}, and tool names would collide.` }
  }
  // Built-ins share the mcp__<name>__ namespace with registry rows. A collision is
  // silently overwritten by one provider and becomes an invalid duplicate in another.
  if (RESERVED_MCP_NAMES.has(name)) {
    return { ok: false, message: `${name} is the name of a Manor built-in server. Pick another name.` }
  }
  if (command.length > 0 && rawUrl.length > 0) {
    return { ok: false, message: `${name} needs a command to start, or a URL for an HTTP server, not both.` }
  }
  if (command.length === 0 && rawUrl.length === 0) {
    return { ok: false, message: `${name} needs a command to start it, or a URL for an HTTP server.` }
  }
  let url: string | undefined
  if (rawUrl.length > 0) {
    const parsed = parseHttpMcpUrl(rawUrl)
    if (!parsed.ok) return parsed
    url = parsed.url
  }
  const notAName = draft.envKeys.findIndex((key) => !ENV_KEY.test(key.trim()))
  if (notAName !== -1) {
    // Never quote the offending text. It may be a pasted credential, and a refusal
    // must not copy that value onto the wire or into logs.
    return {
      ok: false,
      message: `Environment key ${notAName + 1} is not a variable name. Name the variable, like SUPABASE_ACCESS_TOKEN, and set its value on the machine Manor runs on; Manor never stores the value itself.`,
    }
  }
  const httpHeaders = (draft.httpHeaders ?? []).map(({ name, envKey }) => ({
    name: name.trim(),
    envKey: envKey.trim(),
  }))
  if (httpHeaders.length > 0 && url === undefined) {
    return { ok: false, message: `${name} can only send HTTP headers when it uses an HTTP URL.` }
  }
  const badHeader = httpHeaders.findIndex(({ name: header, envKey }) =>
    !HTTP_HEADER_NAME.test(header) || !ENV_KEY.test(envKey),
  )
  if (badHeader !== -1) {
    return {
      ok: false,
      message: `HTTP header ${badHeader + 1} needs a valid header name and an environment-variable name; Manor never stores the value itself.`,
    }
  }
  const headerNames = httpHeaders.map(({ name: header }) => header.toLowerCase())
  if (new Set(headerNames).size !== headerNames.length) {
    return { ok: false, message: `${name} has the same HTTP header more than once.` }
  }
  return {
    ok: true,
    draft: {
      ...draft,
      name,
      command,
      args: draft.args.map((arg) => arg.trim()).filter((arg) => arg.length > 0),
      envKeys: draft.envKeys.map((key) => key.trim()).filter((key) => key.length > 0),
      ...(httpHeaders.length === 0 ? { httpHeaders: undefined } : { httpHeaders }),
      ...(url === undefined ? { url: undefined } : { url }),
      description: draft.description.trim(),
    },
  }
}
