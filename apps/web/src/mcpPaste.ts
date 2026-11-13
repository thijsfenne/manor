import { parseHttpMcpUrl, type McpServerDraft } from '@manor/contracts'

/**
 * Reads the config snippet an MCP server's README hands out and fills the registry
 * form from it, so registering a server is a paste rather than five fields typed by
 * hand. The same job `claude mcp add-json` and Cursor's `mcp.json` do.
 *
 * The load-bearing part is what it throws away. Those snippets carry real credentials
 * inline (`"env": {"SUPABASE_ACCESS_TOKEN": "sbp_live_..."}`), and Manor stores env
 * variable NAMES and never values. So the values are dropped here rather than at the
 * server, and the caller is told which ones were dropped: a paste that silently kept
 * a token would put it in the database and in every rendered argv, which is the one
 * thing this whole design exists to prevent.
 */

export interface McpPasteOutcome {
  draft: McpServerDraft
  /**
   * Env keys whose value was a real one and was not kept. Names only, never the
   * value itself, because this list is shown on screen.
   */
  droppedValues: string[]
  /**
   * 1-based positions of arguments that look like they carry a credential. Positions
   * rather than text, for the same reason as above.
   */
  credentialArgs: number[]
  /** Further servers in the same snippet. One form holds one server. */
  ignored: string[]
}

export type McpPasteResult = { ok: true; outcome: McpPasteOutcome } | { ok: false; message: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * An argument carrying a credential inline, in the two shapes READMEs use: glued to a
 * flag (`--access-token=sntrys_...`) or as the password half of a URL. Arguments are
 * kept exactly as pasted, because silently dropping one would break the command, but
 * they do land in the database and in the rendered argv where `ps` on the VPS shows
 * them. So this exists to say so rather than to let the paste look clean.
 */
const CREDENTIAL_ARG = /(?:token|key|secret|password|passwd|auth|bearer)\s*[=:]\s*\S|:\/\/[^/\s:@]+:[^/\s@]+@/i

/** The flag half of the other shape, where the credential is the argument after it. */
const CREDENTIAL_FLAG = /^--?(?:[a-z0-9-]*-)?(?:token|key|secret|password|passwd|auth|bearer)$/i

/**
 * A value that is already a placeholder rather than a secret, so nothing was dropped
 * when it was left behind. Both spellings appear in the wild.
 */
const isPlaceholder = (value: string): boolean => /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value.trim())

/**
 * JSON as people actually paste it. Editors let `mcp.json` carry comments and trailing
 * commas, and a snippet copied out of one keeps them, so a strict parse would reject
 * a config that is correct everywhere else. Strings are walked over rather than
 * regexed around, so a `//` inside a path or a token is not mistaken for a comment.
 */
function parseLoose(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // Fall through to the tolerant pass rather than failing on a comma.
  }
  let stripped = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ''
    if (inString) {
      stripped += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      stripped += char
      continue
    }
    const pair = `${char}${text[index + 1] ?? ''}`
    if (pair === '//') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    if (pair === '/*') {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? text.length : end + 1
      continue
    }
    stripped += char
  }
  try {
    return JSON.parse(stripped.replace(/,(\s*[}\]])/g, '$1'))
  } catch {
    return undefined
  }
}

/** The server name as an `mcp__<name>__` prefix can carry it. Shown, so it is editable. */
const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')

const asStringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/**
 * Pulls the one server out of whatever wrapper the snippet used. Returns its name when
 * the snippet gave one, plus any further servers the form cannot hold.
 */
function locateServer(parsed: unknown): { name: string; server: Record<string, unknown>; ignored: string[] } | undefined {
  if (!isRecord(parsed)) return undefined
  // A bare server object, which is what a README shows when it documents one server.
  if (typeof parsed['command'] === 'string' || typeof parsed['url'] === 'string') {
    return { name: '', server: parsed, ignored: [] }
  }
  // `mcpServers` is Claude Code and Claude Desktop; `servers` is the VS Code spelling.
  const wrapper = isRecord(parsed['mcpServers'])
    ? parsed['mcpServers']
    : isRecord(parsed['servers'])
      ? parsed['servers']
      : parsed
  const entries = Object.entries(wrapper).filter((entry): entry is [string, Record<string, unknown>] =>
    isRecord(entry[1]),
  )
  const first = entries[0]
  if (first === undefined) return undefined
  return { name: first[0], server: first[1], ignored: entries.slice(1).map(([name]) => name) }
}

export function parseMcpPaste(text: string): McpPasteResult {
  if (text.trim().length === 0) return { ok: false, message: 'Paste a server’s JSON config to fill this in.' }

  const parsed = parseLoose(text)
  if (parsed === undefined) {
    return { ok: false, message: 'That is not JSON Manor can read. Paste the whole snippet, braces included.' }
  }

  const located = locateServer(parsed)
  if (located === undefined) {
    return { ok: false, message: 'No MCP server in that snippet. It should hold a command, or an mcpServers block.' }
  }
  const { name, server, ignored } = located

  const transport = typeof server['type'] === 'string' ? server['type'] : undefined
  if (transport === 'sse') {
    return {
      ok: false,
      message: 'That is an SSE server. Manor speaks streamable HTTP, not SSE.',
    }
  }

  const rawUrl = typeof server['url'] === 'string' ? server['url'].trim() : ''
  const command = typeof server['command'] === 'string' ? server['command'].trim() : ''
  if (rawUrl.length > 0 && command.length > 0) {
    return {
      ok: false,
      message: 'That snippet has both a command and a URL. Manor needs one or the other.',
    }
  }

  let url: string | undefined
  if (rawUrl.length > 0 || transport === 'http') {
    const parsed = parseHttpMcpUrl(rawUrl)
    if (!parsed.ok) return { ok: false, message: parsed.message }
    url = parsed.url
  } else if (command.length === 0) {
    return { ok: false, message: 'That snippet has no command, so Manor would have nothing to start.' }
  }

  // The whole point. Keys are kept, values are read only to tell the difference
  // between a real credential and a placeholder, and neither is stored.
  const envKeys: string[] = []
  const droppedValues: string[] = []
  const env = server['env']
  if (isRecord(env)) {
    for (const [key, value] of Object.entries(env)) {
      envKeys.push(key)
      if (typeof value === 'string' && value.length > 0 && !isPlaceholder(value)) droppedValues.push(key)
    }
  }
  // Some snippets already list names rather than a table, which is the shape Manor wants.
  for (const key of asStringList(server['envKeys'])) {
    if (!envKeys.includes(key)) envKeys.push(key)
  }

  const args = asStringList(server['args']).map((arg) => arg.trim()).filter((arg) => arg.length > 0)
  // A flag names the credential, so the argument AFTER it is the one to point at.
  const credentialArgs = args
    .map((arg, index) => {
      if (CREDENTIAL_ARG.test(arg)) return index + 1
      const previous = args[index - 1]
      return previous !== undefined && CREDENTIAL_FLAG.test(previous) ? index + 1 : 0
    })
    .filter((position) => position > 0)

  return {
    ok: true,
    outcome: {
      draft: {
        name: slugify(name),
        command,
        args,
        envKeys,
        ...(url === undefined ? {} : { url }),
        description: typeof server['description'] === 'string' ? server['description'].trim() : '',
        // Never guessed from the snippet: nothing in the config says whether a server
        // writes, and a wrong "safe" here is the more expensive way to be wrong.
        writes: false,
        effectPolicy: 'confirm_writes',
      },
      droppedValues,
      credentialArgs,
      ignored,
    },
  }
}

/** One sentence about what the paste changed, or nothing when there is nothing to say. */
export function pasteNote(outcome: McpPasteOutcome): string | undefined {
  const parts: string[] = []
  if (outcome.droppedValues.length > 0) {
    parts.push(
      `Kept the name of ${outcome.droppedValues.join(', ')} and dropped the value that was in the snippet. Set it on the machine Manor runs on; Manor never stores it.`,
    )
  }
  if (outcome.credentialArgs.length > 0) {
    const which = outcome.credentialArgs.join(' and ')
    parts.push(
      `Argument ${which} looks like it carries a credential. Arguments are stored exactly as pasted and show up in the process list, so replace ${outcome.credentialArgs.length === 1 ? 'it' : 'them'} with an environment key if you can.`,
    )
  }
  if (outcome.ignored.length > 0) {
    parts.push(
      `That snippet also holds ${outcome.ignored.join(', ')}. One form holds one server, so add ${outcome.ignored.length === 1 ? 'it' : 'them'} separately.`,
    )
  }
  return parts.length === 0 ? undefined : parts.join(' ')
}
