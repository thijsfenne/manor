import { readFileSync } from 'node:fs'
import path from 'node:path'
import { transformSync } from '@babel/core'
import reactCompiler from 'babel-plugin-react-compiler'
import { describe, expect, it } from 'vitest'

const phone = path.resolve(import.meta.dirname, '../../mobile/src')

/**
 * The phone's hottest components, which render on every keystroke and every streamed
 * frame. Expo runs the React Compiler over the whole app and skips a component without a
 * word when it cannot keep that component's manual memoization, so a `useMemo` whose
 * dependencies name less than its body reads costs the component all of its caching.
 * This test sits with the web tests because the phone package has no Babel of its own.
 */
const HOT: Record<string, readonly string[]> = {
  'app/(tabs)/(agents,sessions,knowledge,search)/chat/[id].tsx': ['ChatContent', 'ChatComposer', 'LiveTranscript', 'useTranscriptRows', 'TranscriptRowBody'],
  'components/SubagentConversation.tsx': ['ChildConversation'],
  'components/Composer.tsx': ['Composer'],
  'components/Turn.tsx': ['Turn'],
  'app/(tabs)/(sessions)/index.tsx': ['ProjectInbox'],
  'app/(tabs)/(agents)/agents.tsx': ['DirectList'],
}

/** What the compiler said about one phone file, with the options Expo's preset gives it. */
function compile(file: string) {
  const compiled: string[] = []
  const skipped: string[] = []
  transformSync(readFileSync(path.join(phone, file), 'utf8'), {
    filename: path.join(phone, file),
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ['jsx', 'typescript'] },
    plugins: [[reactCompiler, {
      target: '19',
      panicThreshold: 'none',
      logger: {
        logEvent(_filename: string | null, event: { kind: string; fnName?: string | null; fnLoc?: { start: { line: number } } | null; detail?: { reason?: string; options?: { reason?: string } } }) {
          if (event.kind === 'CompileSuccess') compiled.push(event.fnName ?? 'anonymous')
          if (event.kind === 'CompileError' || event.kind === 'PipelineError') {
            skipped.push(`line ${event.fnLoc?.start.line ?? '?'}: ${event.detail?.options?.reason ?? event.detail?.reason ?? event.kind}`)
          }
        },
      },
    }]],
  })
  return { compiled, skipped }
}

describe('the phone components the React Compiler must keep', () => {
  it.each(Object.entries(HOT))('%s compiles its hot components', (file, components) => {
    const { compiled, skipped } = compile(file)
    expect(components.filter((name) => !compiled.includes(name)), skipped.join('\n')).toEqual([])
  }, 30_000)
})
