import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as line from '@hugeicons/core-free-icons'
import * as solid from '@manor/client-runtime/solid-icons'
import sharp from 'sharp'

import { AiBotHeadLookingIcon, AiBotHeadLookingSolidIcon } from '../src/components/customIcons.ts'

/**
 * The tab bar's glyphs as template PNGs at 1x, 2x and 3x. The native tab bar takes
 * images, not React components, and tints a template image itself: the line glyph at
 * rest, the solid one on the current tab, in either colour scheme.
 *
 * Run `pnpm --filter @manor/mobile generate:tab-icons` after changing a glyph here. The
 * output is committed, so nothing at build or run time depends on this script.
 */
const ICONS = {
  agents: AiBotHeadLookingIcon,
  'agents-selected': AiBotHeadLookingSolidIcon,
  sessions: line.CellsIcon,
  'sessions-selected': solid.CellsIcon,
  knowledge: line.BookOpen01Icon,
  'knowledge-selected': solid.BookOpen01Icon,
  search: line.Search01Icon,
  'search-selected': solid.Search01Icon,
}

const OUT_DIR = path.join(import.meta.dirname, '..', 'assets', 'images', 'tab-icons')
/** Points, the icon set's own grid. */
const SIZE = 24
/** The line weight the house menu draws the same glyphs at. */
const STROKE = 1.7

const kebab = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

const svgOf = (elements) => {
  const body = elements.map(([tag, attrs]) => {
    const pairs = Object.entries(attrs)
      .filter(([key]) => key !== 'key')
      .map(([key, value]) => `${kebab(key)}="${key === 'strokeWidth' ? STROKE : String(value).replace(/currentColor/g, '#000')}"`)
    return `<${tag} ${pairs.join(' ')}/>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" fill="none">${body}</svg>`
}

await mkdir(OUT_DIR, { recursive: true })
for (const [name, icon] of Object.entries(ICONS)) {
  const svg = Buffer.from(svgOf(icon))
  for (const [suffix, scale] of [['', 1], ['@2x', 2], ['@3x', 3]]) {
    const px = SIZE * scale
    const png = await sharp(svg, { density: 72 * scale }).resize(px, px).png().toBuffer()
    await writeFile(path.join(OUT_DIR, `${name}${suffix}.png`), png)
  }
}
console.log(`${Object.keys(ICONS).length} tab icons written to ${OUT_DIR}`)
