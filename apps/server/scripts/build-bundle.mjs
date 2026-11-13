import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * The server as something that runs without this checkout: one entry file with every
 * dependency folded in, and beside it the few files the server reads at run time. The
 * desktop app ships this folder and starts `dist/main.mjs` with its own Node runtime.
 *
 *   <out>/dist/main.mjs      the server
 *   <out>/mcp/*.mjs          the connector servers a provider CLI starts as processes
 *   <out>/sqlite/migrations  the schema
 *   <out>/auto-runtime.json  the default Auto rules
 *   <out>/assets             the font that link previews embed
 *   <out>/build-info.json    what this was built from; its presence means "bundled"
 *
 * `src/serverRoot.ts` is the other half of this layout.
 */
const server = fileURLToPath(new URL('..', import.meta.url))
const out = resolve(server, process.argv[2] ?? '.bundle')
const contracts = fileURLToPath(new URL('../../../packages/contracts/src/index.ts', import.meta.url))
const connectors = ['mail', 'calendar', 'reminders', 'codexComputer', 'effectProxy']

// Bundled CommonJS dependencies call `require` for Node's own modules; an ES module has none.
const banner = {
  js: "import { createRequire as __manorCreateRequire } from 'node:module'; const require = __manorCreateRequire(import.meta.url);",
}
const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner,
  alias: { '@manor/contracts': contracts },
  // Optional speed-ups `ws` looks for and works without.
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
}

await rm(out, { recursive: true, force: true })
await mkdir(resolve(out, 'assets'), { recursive: true })

await build({ ...shared, entryPoints: [resolve(server, 'src/main.ts')], outfile: resolve(out, 'dist/main.mjs') })
await build({
  ...shared,
  entryPoints: connectors.map((name) => resolve(server, `src/mcp/${name}Mcp.ts`)),
  outdir: resolve(out, 'mcp'),
  entryNames: '[name]',
  outExtension: { '.js': '.mjs' },
})

await cp(resolve(server, 'sqlite/migrations'), resolve(out, 'sqlite/migrations'), { recursive: true })
await cp(resolve(server, 'auto-runtime.json'), resolve(out, 'auto-runtime.json'))
await cp(
  createRequire(import.meta.url).resolve('@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2'),
  resolve(out, 'assets/figtree-latin-wght-normal.woff2'),
)

const version = JSON.parse(await readFile(resolve(server, '../desktop/package.json'), 'utf8')).version
let commit = 'unknown'
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: server, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
} catch {
  // Built outside a checkout; the version still says what this is.
}
await writeFile(resolve(out, 'build-info.json'), `${JSON.stringify({ version, commit }, null, 2)}\n`)
console.log(`[manor] server bundle ${version} (${commit.slice(0, 7)}) written to ${out}`)
