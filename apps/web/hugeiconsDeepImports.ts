import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type * as TS from 'typescript'
import type { Plugin } from 'vite'

const PACKAGES = ['@hugeicons/core-free-icons']
const BARREL_LINE = /export\s*\{([^}]*)\}\s*from\s*'\.\/([^']+)\.js'/g

/**
 * Rewrites `import { XIcon } from '@hugeicons/core-free-icons'` to one deep import per
 * icon. The barrel re-exports about 6,000 files, and Rollup loads every one before tree
 * shaking drops them, which was most of the modules a web build read. The bundle keeps
 * the same icons; only the files Rollup has to open change.
 */
export function hugeiconsDeepImports(root: string): Plugin {
  const require = createRequire(path.join(root, 'package.json'))
  const barrels = new Map<string, Map<string, string>>()
  let ts: typeof TS | undefined
  const fileOf = (pkg: string): Map<string, string> => {
    const known = barrels.get(pkg)
    if (known !== undefined) return known
    // Names with their target file; aliases (`Braces`, `…StrokeRounded`) share one file.
    const files = new Map<string, string>()
    const index = readFileSync(require.resolve(pkg).replace(/cjs\/index\.js$/, 'esm/index.js'), 'utf8')
    for (const [, names, file] of index.matchAll(BARREL_LINE)) {
      for (const name of names!.split(',')) {
        const exported = /default\s+as\s+(\w+)/.exec(name)?.[1]
        if (exported !== undefined) files.set(exported, file!)
      }
    }
    barrels.set(pkg, files)
    return files
  }
  return {
    name: 'manor:hugeicons-deep-imports',
    enforce: 'pre',
    apply: 'build',
    transform(code, id) {
      if (id.includes('/node_modules/') || !/\.[cm]?[jt]sx?$/.test(id) || !PACKAGES.some((pkg) => code.includes(pkg))) return null
      // Parsed, not matched: an import-shaped line inside a string stays a string.
      ts ??= require('typescript') as typeof TS
      const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, false, /x$/.test(id) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      let next = code
      for (const statement of [...source.statements].reverse()) {
        const replacement = deepImports(ts, statement, fileOf)
        if (replacement === undefined) continue
        const start = statement.getStart(source)
        const whole = code.slice(start, statement.end)
        // Same line count as the import it replaces, so later lines keep their numbers.
        next = next.slice(0, start) + replacement + '\n'.repeat(whole.split('\n').length - 1) + next.slice(statement.end)
      }
      return next === code ? null : { code: next, map: null }
    },
  }
}

/** One deep import per named icon, or undefined to keep the statement as it is. */
function deepImports(ts: typeof TS, statement: TS.Statement, fileOf: (pkg: string) => Map<string, string>): string | undefined {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return undefined
  const pkg = statement.moduleSpecifier.text
  const clause = statement.importClause
  if (!PACKAGES.includes(pkg) || clause === undefined || clause.isTypeOnly || clause.name !== undefined) return undefined
  if (clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) return undefined
  const files = fileOf(pkg)
  const lines: string[] = []
  for (const element of clause.namedBindings.elements) {
    const file = files.get((element.propertyName ?? element.name).text)
    // Anything unexpected (a type import, an unknown name) keeps the barrel import whole.
    if (element.isTypeOnly || file === undefined) return undefined
    lines.push(`import ${element.name.text} from '${pkg}/${file}';`)
  }
  return lines.length === 0 ? undefined : lines.join(' ')
}
