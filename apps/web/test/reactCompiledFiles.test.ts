import { readFileSync } from 'node:fs'
import path from 'node:path'
import { transformSync } from '@babel/core'
import reactCompiler from 'babel-plugin-react-compiler'
import { describe, expect, it } from 'vitest'
import { PURE_MODULES, REACT_COMPILED_FILES, pureModuleKey, reactCompilerOptions } from '../reactCompiler'

const root = path.resolve(import.meta.dirname, '..')
const options = reactCompilerOptions()

/** What the compiler said about each function in one file: compiled names and the reasons it skipped any. */
function compile(file: string) {
  const compiled: string[] = []
  const skipped: string[] = []
  transformSync(readFileSync(path.join(root, file), 'utf8'), {
    filename: path.join(root, file),
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ['jsx', 'typescript'] },
    plugins: [[reactCompiler, {
      ...options,
      // Collect every reason instead of stopping at the first.
      panicThreshold: 'none',
      logger: {
        logEvent(_filename: string | null, event: { kind: string; fnName?: string | null; fnLoc?: { start: { line: number } } | null; detail?: { reason?: string; options?: { reason?: string } } }) {
          if (event.kind === 'CompileSuccess') compiled.push(event.fnName ?? 'anonymous')
          if (event.kind === 'CompileError' || event.kind === 'PipelineError') {
            skipped.push(`${event.fnName ?? 'function'} at line ${event.fnLoc?.start.line ?? '?'}: ${event.detail?.options?.reason ?? event.detail?.reason ?? event.kind}`)
          }
        },
      },
    }]],
  })
  return { compiled, skipped }
}

describe('React Compiler file list', () => {
  it.each(REACT_COMPILED_FILES)('%s compiles with no manual memoization', (file) => {
    const source = readFileSync(path.join(root, file), 'utf8')
    const { compiled, skipped } = compile(file)
    expect(skipped).toEqual([])
    expect(compiled.length).toBeGreaterThan(0)
    expect(source).not.toMatch(/\buse(Memo|Callback)\s*\(/)
    // A hook that calls no other hook is not inferred as one and would lose its caching
    // without a word; such a hook says 'use memo'.
    const hooks = [...source.matchAll(/(?:function|const)\s+(use[A-Z]\w*)/g)].map((match) => match[1])
    expect(hooks.filter((hook) => !compiled.includes(hook!))).toEqual([])
  }, 30_000)

  it.each(REACT_COMPILED_FILES)('%s imports pure modules from the files they name', (file) => {
    const source = readFileSync(path.join(root, file), 'utf8')
    for (const [, specifier] of source.matchAll(/^import\s[^']*?from '([^']+)'/gm)) {
      const declared = PURE_MODULES[pureModuleKey(specifier!)]
      if (declared === undefined || !specifier!.startsWith('.')) continue
      const resolved = path.resolve(path.dirname(path.join(root, file)), specifier!)
      expect(`${resolved}.ts`, specifier).toBe(path.resolve(root, declared.file))
    }
  })

  it.each(Object.entries(PURE_MODULES))('%s exports every function declared pure', async (_key, { file, functions }) => {
    const exports: Record<string, unknown> = await import(path.resolve(root, file))
    expect(functions.filter((name) => typeof exports[name] !== 'function')).toEqual([])
  })
})
