import { BROWSER_TOOL_NAMES } from '@manor/contracts'
import { isRecord, option, type JsonRecord, type McpToolServer } from './stdio.js'

const tools = [
  {
    name: 'browser_navigate',
    description: 'Navigate the shared browser to an HTTP or HTTPS URL, reusing a matching open tab. List tabs first and select a matching URL or title before navigating. To preserve an unrelated active page, use browser_tabs open.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The absolute HTTP or HTTPS URL to open.' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Read the current shared browser page as text: its visible content plus the controls you can act on. ' +
      'Prefer this over browser_screenshot for reading, comparing or judging a page.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_click',
    description: 'Click an element from the latest browser snapshot by its CSS selector.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_type',
    description: 'Replace the contents of an editable element and type text into it.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' }, text: { type: 'string' } },
      required: ['selector', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_press',
    description: 'Press a supported browser key such as Enter, Tab, Escape, Backspace or an arrow key.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the current page by horizontal and vertical CSS pixel deltas.',
    inputSchema: {
      type: 'object',
      properties: { deltaX: { type: 'number' }, deltaY: { type: 'number' } },
      required: ['deltaX', 'deltaY'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture the current shared browser page as an image. Only for questions about how a page looks; ' +
      'browser_snapshot answers questions about what it says at a fraction of the cost.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_tabs',
    description:
      'List this chat\'s tabs first. Match the requested URL or title, prefer the active tab when several fit, and select its id. Ask if the target remains ambiguous. ' +
      'Open a URL only when no tab fits. Open reuses an exact URL match; set forceNew only when the user explicitly asks for a new tab. ' +
      'Every other browser tool acts on the active tab.',
    inputSchema: {
      type: 'object',
      properties: {
        select: { type: 'string', description: 'The id of the tab to make active.' },
        open: { type: 'string', description: 'The absolute HTTP or HTTPS URL to reuse or open in a new active tab.' },
        forceNew: { type: 'boolean', description: 'With open, bypass reuse only for an explicit user request for a new tab.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_fill_login',
    description:
      'On a sign-in page, ask the user to fill the login Manor has saved for this exact site. They see a card naming the site and username and decides with Fill or Don\'t fill; ' +
      'you never see the password. The result says filled, declined or no_saved_login, with the username. ' +
      'On no_saved_login, ask the user to sign in themselves. After declined, do not ask again without new direction from them. ' +
      'Never type a password with browser_type.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Only when several logins are saved for this site: the one to fill.' },
      },
      additionalProperties: false,
    },
  },
] as const

const toolNames = new Set<string>(BROWSER_TOOL_NAMES)

/**
 * Pixels are their own tool now, so only the screenshot result ever carries an
 * image. A snapshot that shipped one too was charging every read of a page for a
 * picture of it, which is the whole reason reading felt expensive.
 */
function screenshotContent(raw: unknown): JsonRecord[] {
  if (!isRecord(raw)) return [{ type: 'text', text: JSON.stringify(raw) }]
  const screenshot = typeof raw.screenshot === 'string' ? raw.screenshot : ''
  const textPayload = { ...raw }
  delete textPayload.screenshot
  const content: JsonRecord[] = [{ type: 'text', text: JSON.stringify(textPayload) }]
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(screenshot)
  if (match !== null) content.push({ type: 'image', mimeType: match[1], data: match[2] })
  return content
}

async function callBroker(
  brokerUrl: string,
  capability: string,
  tool: string,
  arguments_: JsonRecord,
): Promise<unknown> {
  const response = await fetch(brokerUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-manor-browser-capability': capability,
    },
    body: JSON.stringify({ tool, arguments: arguments_ }),
    // Above the broker's own 30s answer budget plus its 15s wait for another
    // persona's action, so the process that owns the clearer message reports first.
    signal: AbortSignal.timeout(50_000),
  })
  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.error === 'string'
      ? payload.error
      : `Browser broker returned HTTP ${response.status}.`
    throw new Error(message)
  }
  return isRecord(payload) ? payload.result : undefined
}

export function browserMcpServer(argv: readonly string[]): McpToolServer {
  const brokerUrl = option('--broker-url', argv)
  return {
    name: 'manor-browser',
    tools,
    instructions: [
      'Use this browser for current web pages.',
      'It is shared: the user watches the same live page and may click, type or navigate',
      'between your actions, so take a fresh browser_snapshot before acting on selectors',
      'you read earlier.',
      'Before opening a page, list tabs and match its URL or title. Reuse a fitting tab; ask when the active tab does not resolve an ambiguous target.',
      'One agent drives at a time; if another holds it, say so instead of retrying in a loop.',
    ].join(' '),
    failureMessage: 'The browser action failed.',
    async callTool(rawName, arguments_, capability) {
      const name = typeof rawName === 'string' ? rawName : ''
      if (!toolNames.has(name)) throw new Error(`Unknown browser tool ${name}.`)
      if (name === 'browser_navigate' && typeof arguments_.url !== 'string') {
        throw new Error('browser_navigate needs an absolute HTTP or HTTPS URL.')
      }
      if (name === 'browser_click' && typeof arguments_.selector !== 'string') {
        throw new Error('browser_click needs a CSS selector from browser_snapshot.')
      }
      if (
        name === 'browser_type' &&
        (typeof arguments_.selector !== 'string' || typeof arguments_.text !== 'string')
      ) throw new Error('browser_type needs a CSS selector and text.')
      if (name === 'browser_press' && typeof arguments_.key !== 'string') {
        throw new Error('browser_press needs a key.')
      }
      if (
        name === 'browser_scroll' &&
        (typeof arguments_.deltaX !== 'number' || typeof arguments_.deltaY !== 'number')
      ) throw new Error('browser_scroll needs numeric deltaX and deltaY values.')
      if (
        name === 'browser_tabs' &&
        arguments_.select !== undefined &&
        typeof arguments_.select !== 'string'
      ) throw new Error('browser_tabs select must be a tab id.')
      if (
        name === 'browser_tabs' &&
        arguments_.open !== undefined &&
        typeof arguments_.open !== 'string'
      ) throw new Error('browser_tabs open must be an absolute HTTP or HTTPS URL.')
      if (
        name === 'browser_tabs' &&
        arguments_.select !== undefined &&
        arguments_.open !== undefined
      ) throw new Error('browser_tabs can select a tab or open a new one, not both at once.')
      if (name === 'browser_tabs' && arguments_.forceNew !== undefined &&
        (typeof arguments_.forceNew !== 'boolean' || typeof arguments_.open !== 'string')) {
        throw new Error('browser_tabs forceNew requires an open URL and a boolean.')
      }
      if (name === 'browser_fill_login' && arguments_.username !== undefined && typeof arguments_.username !== 'string') {
        throw new Error('browser_fill_login username must be a string.')
      }
      const result = await callBroker(brokerUrl, capability, name, arguments_)
      return name === 'browser_screenshot'
        ? screenshotContent(result)
        : [{ type: 'text', text: JSON.stringify(result) }]
    },
  }
}
