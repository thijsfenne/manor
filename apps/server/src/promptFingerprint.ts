import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { PromptFingerprint, TurnInput } from '@manor/contracts'
import { claudeBuiltInTools } from './drivers/claudeDriver.js'

const digest = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16)

/**
 * A Manor-owned MCP server's tool names, descriptions and schemas live in its entry
 * file, so the file's bytes stand in for them. Read per turn: the CLI spawns the
 * server per turn too, so an edited file is what the next turn's model is offered.
 */
const BUILT_IN_ENTRY = /Mcp\.(ts|mjs)$/
function entryDigest(args: readonly string[]): string | undefined {
  const entry = args.find((arg) => BUILT_IN_ENTRY.test(arg))
  if (entry === undefined) return undefined
  try {
    return digest(readFileSync(entry, 'utf8'))
  } catch {
    return undefined
  }
}

type OfferedInput = Pick<TurnInput, 'agent' | 'repoPaths' | 'imagePaths' | 'mcpServers'>

/** The tool configuration in offer order, each entry labelled for `prefixChanges`. */
function toolEntries(input: OfferedInput): { label: string; value: unknown }[] {
  // The built-in selection as Claude, the driver whose cache prefix this measures, renders it.
  return [
    { label: 'builtin', value: input.repoPaths.length > 0 ? { builtIn: 'default' } : { builtIn: claudeBuiltInTools(input) } },
    ...(input.mcpServers ?? []).map(({ server, disabledTools }) => ({
      label: `tools:${server.name}`,
      value: {
        name: server.name,
        command: server.command,
        args: server.args,
        url: server.url ?? null,
        headers: (server.httpHeaders ?? []).map((header) => header.name),
        tools: server.tools.filter((tool) => !disabledTools.includes(tool)),
        description: server.description,
        schemaChars: server.schemaChars,
        code: entryDigest(server.args) ?? null,
      },
    })),
  ]
}

/** A turn's prefix as labelled part hashes, kept per provider session to name what moved. */
export interface PrefixParts {
  model: string | undefined
  /** In prompt order, so a move shows as well as an edit. */
  parts: ReadonlyMap<string, string>
}

/**
 * What a turn offered the model, for investigating a warm prefix rebuild. Claude
 * orders its cache prefix as tools, then system prompt, then messages, so either
 * hash changing rewrites the whole conversation into the cache.
 *
 * The tools hash covers the built-in selection and every attached server in order.
 * It takes the config the CLI is given (secret values and per-turn capabilities ride
 * in `runtimeEnv` and stay out) and the enabled tool names. Manor's own servers add
 * the entry file that defines their descriptions and schemas, so any edit to that
 * file counts, a handler-only one too. A registered server's definitions are known
 * only by their probed size, so a same-size edit there goes unseen.
 *
 * `parts` names each piece for `prefixChanges`. The system prompt splits at each
 * `[Manor]` block, named by its heading up to the first comma, colon or full stop, so
 * a label says which block moved without carrying its content.
 */
export function offeredPrefix(input: OfferedInput): { fingerprint: Omit<PromptFingerprint, 'sessionId'>; parts: PrefixParts } {
  const tools = toolEntries(input)
  const parts = new Map<string, string>()
  const add = (label: string, value: string) => {
    let unique = label
    for (let n = 2; parts.has(unique); n += 1) unique = `${label} #${n}`
    parts.set(unique, digest(value))
  }
  for (const [index, section] of input.agent.character.split(/\n\n(?=\[Manor\])/).entries()) {
    const heading = /^\[Manor\] ([^\n]*)/.exec(section)?.[1]
    const name = heading === undefined ? (index === 0 ? 'persona' : 'section') : heading.split(/[,.:]/)[0]!.trim().slice(0, 60)
    add(`system:${name}`, section)
  }
  for (const entry of tools) add(entry.label, JSON.stringify(entry.value))
  return {
    fingerprint: {
      system: digest(input.agent.character),
      tools: digest(JSON.stringify(tools.map((entry) => entry.value))),
      ...(input.agent.model === undefined ? {} : { model: input.agent.model }),
    },
    parts: { model: input.agent.model, parts },
  }
}

/** What moved between two turns of one provider session; empty when the prefix held. */
export function prefixChanges(before: PrefixParts, after: PrefixParts): string[] {
  const changed = before.model === after.model ? [] : ['model']
  for (const label of new Set([...before.parts.keys(), ...after.parts.keys()])) {
    if (before.parts.get(label) !== after.parts.get(label)) changed.push(label)
  }
  // The same pieces in another order still change the prefix.
  for (const system of [true, false]) {
    const order = (parts: PrefixParts) => [...parts.parts.keys()]
      .filter((label) => label.startsWith('system:') === system && before.parts.has(label) && after.parts.has(label))
    if (order(before).join('\n') !== order(after).join('\n')) changed.push(system ? 'system:order' : 'tools:order')
  }
  return changed.slice(0, 40)
}
