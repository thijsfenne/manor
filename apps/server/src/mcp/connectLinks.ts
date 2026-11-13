import { COMPOSIO_ACCOUNT_ALIASES } from './composioAttachment.js'

/**
 * Turns a COMPOSIO_MANAGE_CONNECTIONS result into connect cards. Runs inside the effect
 * proxy, so the sign-in link goes to Manor and the model never sees it to paste.
 */

type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export interface ComposioConnectLink {
  toolkit: string
  alias?: string
  accountId?: string
  url: string
}

export type ConnectOutcome =
  | { status: 'connected' }
  | { status: 'pending' }
  | { status: 'failed'; reason: string }

/** Only Composio's own hosts open from a card; any other URL stays plain text. */
export function isComposioConnectUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (url.hostname === 'composio.dev' || url.hostname.endsWith('.composio.dev'))
  } catch {
    return false
  }
}

interface AddItem { name: string; alias?: string }

function addItems(args: unknown): AddItem[] {
  if (!isRecord(args) || !Array.isArray(args.toolkits)) return []
  return args.toolkits.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== 'string') return []
    if (item.action !== undefined && item.action !== 'add') return []
    return [{ name: item.name, ...(typeof item.alias === 'string' ? { alias: item.alias } : {}) }]
  })
}

/**
 * An `add` without a personal or work alias, which Manor refuses before Composio sees
 * it. Undefined when every add carries one.
 */
export function unaliasedComposioAdd(args: unknown): string | undefined {
  const aliases: readonly string[] = COMPOSIO_ACCOUNT_ALIASES
  const missing = addItems(args).find((item) => item.alias === undefined || !aliases.includes(item.alias))
  return missing?.name
}

const URL_PATTERN = /https:\/\/[^\s"'<>)\]]+/g

const stringField = (row: JsonRecord, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

export function composioConnectLinks(args: unknown, result: unknown): ComposioConnectLink[] {
  const adds = addItems(args)
  const found = new Map<string, ComposioConnectLink>()
  const fallbackToolkit = adds.length === 1 ? adds[0]?.name : undefined
  const aliasFor = (toolkit: string | undefined) => adds.find((item) => item.name === toolkit)?.alias

  const add = (url: string, toolkit: string | undefined, accountId?: string, alias?: string) => {
    if (!isComposioConnectUrl(url)) return
    const seen = found.get(url)
    if (seen !== undefined) {
      // The same link in structuredContent and in the text: keep what either one knew.
      if (seen.accountId === undefined && accountId !== undefined) seen.accountId = accountId
      if (seen.alias === undefined && alias !== undefined) seen.alias = alias
      return
    }
    const name = toolkit ?? fallbackToolkit
    if (name === undefined) return
    const chosen = alias ?? aliasFor(name)
    found.set(url, {
      toolkit: name,
      url,
      ...(chosen === undefined ? {} : { alias: chosen }),
      ...(accountId === undefined ? {} : { accountId }),
    })
  }

  const walk = (value: unknown, key: string | undefined, depth: number) => {
    if (depth > 8) return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key, depth + 1)
      return
    }
    if (!isRecord(value)) return
    const url = stringField(value, 'redirect_url', 'redirectUrl')
    if (url !== undefined) {
      const toolkit = isRecord(value.toolkit) ? stringField(value.toolkit, 'slug') : undefined
      const id = stringField(value, 'connected_account_id', 'connectedAccountId', 'account_id', 'id')
      add(
        url,
        toolkit ?? stringField(value, 'toolkit', 'toolkit_slug', 'name')
          ?? (key !== undefined && adds.some((item) => item.name === key) ? key : undefined),
        id?.startsWith('ca_') === true ? id : undefined,
        stringField(value, 'alias'),
      )
    }
    for (const [childKey, child] of Object.entries(value)) walk(child, childKey, depth + 1)
  }

  const texts: string[] = []
  if (isRecord(result)) {
    walk(result.structuredContent, undefined, 0)
    if (Array.isArray(result.content)) {
      for (const block of result.content) {
        if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      }
    }
  }
  for (const text of texts) {
    try {
      walk(JSON.parse(text), undefined, 0)
    } catch {
      // Not JSON: a lone link in prose still belongs to the one toolkit being added.
    }
    if (found.size === 0) for (const match of text.match(URL_PATTERN) ?? []) add(match, undefined)
  }
  return [...found.values()]
}

const label = (link: ComposioConnectLink) => `${link.toolkit}${link.alias === undefined ? '' : ` (${link.alias})`}`

function outcomeLine(link: ComposioConnectLink, outcome: ConnectOutcome): string {
  if (outcome.status === 'connected') {
    return `${label(link)} is connected now. Continue the task; its tools work in this turn.`
  }
  if (outcome.status === 'failed') {
    return `The ${label(link)} sign-in failed: ${outcome.reason} the user can retry from the card in the chat. Do not paste or repeat a sign-in link.`
  }
  return `Manor showed the user a connect card for ${label(link)} in the chat; they sign in from that card. Never paste or repeat a sign-in link. They have not finished yet: say in one line that the card is waiting, and continue once they confirm. Its tools work on their next message.`
}

/** The result the model sees: what happened to each card, without any link. */
export function connectCardResult(result: JsonRecord, links: readonly ComposioConnectLink[], outcomes: readonly ConnectOutcome[]): JsonRecord {
  const { structuredContent: _dropped, content: _content, ...rest } = result
  return {
    ...rest,
    content: [{ type: 'text', text: links.map((link, index) => outcomeLine(link, outcomes[index] ?? { status: 'pending' })).join('\n') }],
  }
}
