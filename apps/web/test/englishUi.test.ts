import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
// Distinctive Dutch copy, rather than ambiguous words like "in", "menu" or "via".
const dutch = /\b(wacht|bevestigen|bevestigd|afgerond|klaar|loopt|projectthread|leerpunten|sessie|sessies|melding|vraagt|meldt|voorkeur|notitie|verwijder|opslaan|annuleren|beantwoord|beëindigd|geantwoord|resultaat|openen)\b/i
const nativeProjectWords = /\bprojectthread\b|wacht op jou|bevestigen in de|wacht op keuze|leerpunten|start van de projectthread/i
const nativeStates = /\b(vraag|loopt|lopen)\b/i

function violations(source: string, file: string, words = dutch): string[] {
  if (!words.test(source) && !source.includes('\\')) return []
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const hits: string[] = []
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
      || ts.isJsxText(node)) && words.test(node.text)) {
      const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
      hits.push(`${file}:${line}: ${node.text.trim()}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return hits
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(dir, entry.name)
    return entry.isDirectory() ? sources(file)
      : /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [file] : []
  })
}

describe('English interface copy', () => {
  it('rejects planted Dutch JSX, attributes, and template text, while ignoring comments', () => {
    expect(violations('const label = <span>Wacht op jou</span>', 'planted.tsx')).toHaveLength(1)
    expect(violations('const label = <button title="Bevestigen">Confirm</button>', 'planted.tsx')).toHaveLength(1)
    expect(violations('const label = `Sessie ${name}`', 'planted.tsx')).toHaveLength(1)
    expect(violations('const label = "\\u0057acht op jou"', 'planted.tsx')).toHaveLength(1)
    expect(violations('// wacht op jou\nconst label = "Needs you"', 'planted.tsx')).toEqual([])
  })

  it('keeps the English web interface and generated project receipts free of Dutch copy', () => {
    const files = [
      ...sources(resolve(root, 'apps/web/src')),
      resolve(root, 'apps/server/src/projectThreads.ts'),
      resolve(root, 'apps/server/src/pushNotifications.ts'),
      resolve(root, 'packages/client-runtime/src/transcriptState.ts'),
    ]
    expect(files.flatMap((file) => violations(readFileSync(file, 'utf8'), relative(root, file))),
      'Translate these strings into English. Keep user-authored text and comments out of the detector.').toEqual([])
  }, 15_000)

  it('keeps project thread copy English on the otherwise Dutch native interface', () => {
    expect(sources(resolve(root, 'apps/mobile/src')).flatMap((file) =>
      violations(readFileSync(file, 'utf8'), relative(root, file), nativeProjectWords))).toEqual([])
    // These two surfaces contain thread state labels; the rest of the native app remains Dutch.
    for (const file of ['apps/mobile/src/app/(tabs)/(sessions)/index.tsx', 'apps/mobile/src/components/WorkDecisionDock.tsx']) {
      expect(violations(readFileSync(resolve(root, file), 'utf8'), file, nativeStates)).toEqual([])
    }
  })

  it.each(['Vraag', 'Loopt', 'loopt', 'lopen'])('rejects the planted native thread state %s', (label) => {
    expect(violations(`const label = '${label}'`, 'native-thread.tsx', nativeStates)).toHaveLength(1)
    expect(violations('const label = "Bericht…"', 'native-chat.tsx', nativeProjectWords)).toEqual([])
  })
})
