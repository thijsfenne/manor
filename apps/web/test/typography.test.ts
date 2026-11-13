import { readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src', import.meta.url))
const TINY_TEXT = /text-\[(?:10|10\.5|11|11\.5)px\]|font-size:\s*(?:10|10\.5|11|11\.5)px/
/**
 * Tab titles in the browser strip, documented in `desktop-and-browser.md`, and the role
 * chip, documented in `interface-and-visuals.md`: worn beside a name it is a mark on a
 * person rather than a line of its own, and at 12px it read as a second label.
 */
const TINY_TEXT_EXCEPTIONS = new Set(['components/BrowserPanel.tsx', 'components/ui/RoleBadge.tsx'])

describe('the compact typography floor', () => {
  it('keeps readable text at 12px or larger', () => {
    const offenders = (readdirSync(SRC, { recursive: true }) as string[])
      .filter((path) => ['.css', '.ts', '.tsx'].includes(extname(path)))
      .filter((path) => !TINY_TEXT_EXCEPTIONS.has(path.replaceAll('\\', '/')))
      .filter((path) => TINY_TEXT.test(readFileSync(join(SRC, path), 'utf8')))

    expect(offenders).toEqual([])
  })

  it('names compact text by its role', () => {
    const styles = readFileSync(join(SRC, 'styles.css'), 'utf8')

    expect(styles).toContain('--text-meta: 12px')
    expect(styles).toContain('--text-label: 13px')
    expect(styles).toContain('font-size-adjust: ex-height 0.55')
  })
})
