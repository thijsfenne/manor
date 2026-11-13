import { describe, expect, it } from 'vitest'
import { parseMcpPaste, pasteNote, type McpPasteOutcome } from '../src/mcpPaste'

/**
 * The snippet shapes real READMEs hand out, and the one rule that is not cosmetic:
 * a value pasted in never survives into the draft.
 */

const ok = (text: string): McpPasteOutcome => {
  const result = parseMcpPaste(text)
  if (!result.ok) throw new Error(`expected a parse, got: ${result.message}`)
  return result.outcome
}

const failure = (text: string): string => {
  const result = parseMcpPaste(text)
  if (result.ok) throw new Error('expected a refusal')
  return result.message
}

describe('parseMcpPaste, the shapes people paste', () => {
  it('reads the Claude Code and Claude Desktop mcpServers block', () => {
    const outcome = ok(`{
      "mcpServers": {
        "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }
      }
    }`)
    expect(outcome.draft).toMatchObject({
      name: 'context7',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      effectPolicy: 'confirm_writes',
    })
  })

  it('reads the VS Code servers spelling', () => {
    expect(ok('{"servers":{"files":{"command":"/bin/mcp-files"}}}').draft.name).toBe('files')
  })

  it('reads a bare server object, which is what a one-server README shows', () => {
    const outcome = ok('{"command":"/bin/mcp-files","args":["/data"]}')
    expect(outcome.draft.command).toBe('/bin/mcp-files')
    // No name in the snippet to take, so the form asks for one.
    expect(outcome.draft.name).toBe('')
  })

  it('reads a named map with no wrapper', () => {
    expect(ok('{"supabase":{"command":"npx","args":["-y","@supabase/mcp-server-supabase"]}}').draft.name).toBe(
      'supabase',
    )
  })

  it('survives the comments and trailing commas an editor leaves in mcp.json', () => {
    const outcome = ok(`{
      // the docs server
      "mcpServers": {
        "context7": {
          "command": "npx",
          "args": ["-y", "@upstash/context7-mcp"], /* pinned later */
        },
      },
    }`)
    expect(outcome.draft.args).toEqual(['-y', '@upstash/context7-mcp'])
  })

  it('does not mistake a // inside a string for a comment', () => {
    const outcome = ok('{"mcpServers":{"x":{"command":"node","args":["https://example.com/mcp"]}}}')
    expect(outcome.draft.args).toEqual(['https://example.com/mcp'])
  })

  it('slugifies a name that could not carry the mcp__<name>__ prefix', () => {
    expect(ok('{"mcpServers":{"Supa Base":{"command":"/bin/x"}}}').draft.name).toBe('supa-base')
  })
})

describe('parseMcpPaste, what it refuses to keep', () => {
  it('keeps env key names and drops the values', () => {
    const outcome = ok(`{
      "mcpServers": {
        "supabase": {
          "command": "npx",
          "env": { "SUPABASE_ACCESS_TOKEN": "sbp_live_reallysecret", "REGION": "eu" }
        }
      }
    }`)
    expect(outcome.draft.envKeys).toEqual(['SUPABASE_ACCESS_TOKEN', 'REGION'])
    // The one assertion that matters: nothing anywhere in the draft is the value.
    expect(JSON.stringify(outcome.draft)).not.toContain('sbp_live_reallysecret')
    expect(outcome.droppedValues).toEqual(['SUPABASE_ACCESS_TOKEN', 'REGION'])
  })

  it('says nothing was dropped when the snippet already used a placeholder', () => {
    const outcome = ok('{"mcpServers":{"x":{"command":"/bin/x","env":{"TOKEN":"${TOKEN}","OTHER":"$OTHER"}}}}')
    expect(outcome.draft.envKeys).toEqual(['TOKEN', 'OTHER'])
    expect(outcome.droppedValues).toEqual([])
  })

  it('names the dropped keys without ever quoting the value', () => {
    const outcome = ok('{"mcpServers":{"x":{"command":"/bin/x","env":{"TOKEN":"sbp_live_reallysecret"}}}}')
    const note = pasteNote(outcome) ?? ''
    expect(note).toContain('TOKEN')
    expect(note).not.toContain('sbp_live_reallysecret')
  })

  it('flags a credential glued to an argument, by position and never by text', () => {
    // READMEs put tokens in args at least as often as in env. Dropping the arg would
    // break the command, so it is kept and named instead.
    const outcome = ok(`{"mcpServers":{"sentry":{"command":"npx","args":[
      "@sentry/mcp-server@latest", "--access-token=sntrys_LIVE_SECRET", "--host=sentry.io"
    ]}}}`)
    expect(outcome.draft.args).toHaveLength(3)
    expect(outcome.credentialArgs).toEqual([2])
    const note = pasteNote(outcome) ?? ''
    expect(note).toContain('Argument 2')
    expect(note).not.toContain('sntrys_LIVE_SECRET')
  })

  it('flags the password half of a connection string', () => {
    const outcome = ok(`{"mcpServers":{"pg":{"command":"npx","args":[
      "-y", "@modelcontextprotocol/server-postgres", "postgresql://user:hunter2@db.example.com/app"
    ]}}}`)
    expect(outcome.credentialArgs).toEqual([3])
    expect(pasteNote(outcome) ?? '').not.toContain('hunter2')
  })

  it('flags the argument after a credential-shaped flag', () => {
    const outcome = ok('{"mcpServers":{"x":{"command":"npx","args":["--api-key","sk_live_secret"]}}}')
    expect(outcome.credentialArgs).toEqual([2])
  })

  it('leaves ordinary arguments alone', () => {
    // A warning that fires on --read-only is a warning nobody reads.
    const outcome = ok(`{"mcpServers":{"x":{"command":"npx","args":[
      "-y", "@supabase/mcp-server-supabase", "--read-only", "--project-ref=abcdef"
    ]}}}`)
    expect(outcome.credentialArgs).toEqual([])
    expect(pasteNote(outcome)).toBeUndefined()
  })

  it('never guesses that a server writes', () => {
    // Nothing in a config says this, and a wrong "safe" is the expensive way to be wrong.
    expect(ok('{"mcpServers":{"x":{"command":"/bin/x","args":["--write"]}}}').draft.writes).toBe(false)
  })
})

describe('parseMcpPaste, what it refuses outright', () => {
  it('refuses an empty paste', () => {
    expect(failure('   ')).toContain('Paste a server')
  })

  it('refuses text that is not JSON at all', () => {
    expect(failure('npx -y @upstash/context7-mcp')).toContain('not JSON')
  })

  it('accepts a streamable HTTP server and stores the URL, not a command', () => {
    const outcome = ok('{"mcpServers":{"figma":{"url":"http://127.0.0.1:3845/mcp"}}}')
    expect(outcome.draft.name).toBe('figma')
    expect(outcome.draft.url).toBe('http://127.0.0.1:3845/mcp')
    expect(outcome.draft.command).toBe('')
  })

  it('refuses an SSE server rather than half-importing it as HTTP', () => {
    expect(failure('{"mcpServers":{"sentry":{"type":"sse","url":"https://mcp.sentry.dev/sse"}}}')).toContain(
      'not SSE',
    )
  })

  it('refuses a snippet that names both a command and a URL', () => {
    expect(
      failure('{"mcpServers":{"x":{"command":"npx","url":"http://127.0.0.1:3845/mcp"}}}'),
    ).toContain('both a command and a URL')
  })

  it('refuses credentials inside an HTTP URL', () => {
    expect(
      failure('{"mcpServers":{"x":{"url":"https://user:secret@mcp.example.com/mcp"}}}'),
    ).toContain('credentials in the URL')
  })

  it('refuses a snippet with no command', () => {
    expect(failure('{"mcpServers":{"x":{"args":["-y"]}}}')).toContain('no command')
  })

  it('refuses a snippet with no server in it', () => {
    expect(failure('{"unrelated":"thing"}')).toContain('No MCP server')
  })
})

describe('parseMcpPaste, more than one server', () => {
  it('takes the first and names the rest rather than dropping them quietly', () => {
    const outcome = ok(`{
      "mcpServers": {
        "context7": { "command": "npx" },
        "supabase": { "command": "npx" },
        "files": { "command": "/bin/files" }
      }
    }`)
    expect(outcome.draft.name).toBe('context7')
    expect(outcome.ignored).toEqual(['supabase', 'files'])
    expect(pasteNote(outcome)).toContain('supabase, files')
  })

  it('has nothing to say about a clean single-server paste', () => {
    expect(pasteNote(ok('{"mcpServers":{"x":{"command":"/bin/x"}}}'))).toBeUndefined()
  })
})
