import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// `start` passes `.mcp-build/<port>`, so a spike on 43180 rebuilding never swaps the
// MCP files under a server already running on 43179 from an older tree.
const server = fileURLToPath(new URL('..', import.meta.url))
const outdir = resolve(server, process.argv[2] ?? '.mcp-build')
const names = ['mail', 'calendar', 'reminders', 'codexComputer', 'effectProxy']

await build({
  entryPoints: names.map((name) => new URL(`../src/mcp/${name}Mcp.ts`, import.meta.url).pathname),
  outdir,
  entryNames: '[name]',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  alias: { '@manor/contracts': new URL('../../../packages/contracts/src/index.ts', import.meta.url).pathname },
})
