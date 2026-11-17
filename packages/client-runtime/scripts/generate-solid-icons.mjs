import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as lineIcons from '@hugeicons/core-free-icons'

/**
 * Filled glyphs for selected states, made from the line icons of the free MIT set.
 *
 * HugeIcons sells a solid style, but its Pro licence does not allow those glyphs in a
 * public repository. The free set is line icons only. So the filled ones are derived
 * here, by rule, from the free line data: a closed shape is filled, a detail drawn on
 * top of a filled shape is cut out of it at the line weight, and a stroke that lies on
 * nothing stays a stroke, a little heavier. No Pro glyph is read or copied.
 *
 * Run `pnpm --filter @manor/client-runtime generate:solid-icons` after adding a name
 * to ICONS, look at the result next to its line icon, and add a recipe when the rule
 * needs help. The output is committed, so nothing at build or run time depends on this.
 */
const ICONS = [
  'Archive02Icon', 'BookOpen01Icon', 'Brain02Icon', 'BubbleChatQuestionIcon', 'CellsIcon',
  'CheckListIcon', 'CheckmarkCircle02Icon', 'Clock01Icon', 'DashboardSpeed02Icon', 'Files01Icon',
  'FlashIcon', 'Folder01Icon', 'GitCompareIcon', 'Globe02Icon', 'PuzzleIcon', 'Search01Icon', 'Settings01Icon', 'StarIcon', 'UserIcon',
]

/** Where the rule alone gives the wrong picture. Indexes are the line icon's elements. */
const RECIPES = {
  // The head is drawn open at the neck. Closed along the bottom it is a shape to fill.
  Brain02Icon: { append: { 0: 'V21.9948H4.22222Z' }, roles: { 1: 'cut' } },
  // Two pages that share the spine; without a gap the pair fills into one slab.
  BookOpen01Icon: { extraCuts: [{ d: 'M12 5.5V20.5', width: 1.1 }] },
  // A lens filled to the rim reads as a blot. The ring stays, the lens fills inside it,
  // and a gap of one line weight runs evenly between them.
  Search01Icon: { extraCuts: [{ d: 'M17.5 11A6.5 6.5 0 1 1 4.5 11A6.5 6.5 0 1 1 17.5 11Z', width: 1.5 }] },
}

/** The line weight of the set, which the cut-outs keep. */
const LINE = 1.5
/** A stroke with nothing to fill gets this weight, so the selected glyph still reads heavier. */
const BOLD = 2

const require = createRequire(import.meta.url)
const pathKitDir = path.dirname(require.resolve('pathkit-wasm/bin/pathkit.js'))
const PathKit = await require('pathkit-wasm/bin/pathkit.js')({ wasmBinary: readFileSync(path.join(pathKitDir, 'pathkit.wasm')) })

/** One element as paths, one per sub-path, so the open and closed parts of a `d` can differ. */
function subpaths(tag, attrs) {
  if (tag === 'circle') {
    const circle = PathKit.NewPath()
    circle.ellipse(Number(attrs.cx), Number(attrs.cy), Number(attrs.r), Number(attrs.r), 0, 0, Math.PI * 2)
    circle.closePath()
    return [{ path: circle, closed: true }]
  }
  if (tag !== 'path') throw new Error(`cannot fill a <${tag}> yet`)
  return attrs.d.split(/(?=M)/).filter((part) => part.trim() !== '')
    .map((d) => ({ path: PathKit.FromSVGString(d), closed: /Z\s*$/i.test(d.trim()) }))
}

const stroked = (shape, width) => shape.copy().stroke({ width, join: PathKit.StrokeJoin.ROUND, cap: PathKit.StrokeCap.ROUND })
const area = (bounds) => (bounds.fRight - bounds.fLeft) * (bounds.fBottom - bounds.fTop)
const within = (outer, inner) => {
  const o = outer.getBounds()
  const i = inner.getBounds()
  return o.fLeft <= i.fLeft && o.fTop <= i.fTop && o.fRight >= i.fRight && o.fBottom >= i.fBottom
}

function solidify(elements, recipe = {}) {
  const parts = elements.flatMap(([tag, attrs], index) => {
    const extra = recipe.append?.[index]
    return subpaths(tag, extra === undefined ? attrs : { ...attrs, d: `${attrs.d}${extra}` }).map((part) => ({ ...part, index, role: recipe.roles?.[index] ?? null }))
  })
  // A closed shape fills, unless it sits inside another closed shape: then it is a detail.
  for (const part of parts) {
    if (part.role !== null || !part.closed) continue
    part.role = parts.some((other) => other !== part && other.closed && within(other.path, part.path)) ? 'cut' : 'fill'
  }
  const shape = PathKit.NewPath()
  for (const part of parts) {
    if (part.role !== 'fill') continue
    shape.op(part.path, PathKit.PathOp.UNION)
    // With its own outline, so the filled glyph is as large as the line one.
    shape.op(stroked(part.path, LINE), PathKit.PathOp.UNION)
  }
  const silhouette = shape.copy()
  for (const part of parts) {
    if (part.role !== null) continue
    const probe = stroked(part.path, 0.2)
    const covered = area(probe.copy().op(silhouette, PathKit.PathOp.INTERSECT).getBounds()) / Math.max(0.0001, area(probe.getBounds()))
    part.role = covered > 0.6 ? 'cut' : 'bold'
  }
  for (const part of parts) if (part.role === 'cut') shape.op(stroked(part.path, LINE), PathKit.PathOp.DIFFERENCE)
  for (const cut of recipe.extraCuts ?? []) shape.op(stroked(PathKit.FromSVGString(cut.d), cut.width), PathKit.PathOp.DIFFERENCE)
  for (const part of parts) if (part.role === 'bold') shape.op(stroked(part.path, BOLD), PathKit.PathOp.UNION)
  shape.simplify()
  return shape.toSVGString().replace(/(-?\d+\.\d{3})\d+/g, '$1')
}

const body = ICONS.map((name) => {
  const line = lineIcons[name]
  if (line === undefined) throw new Error(`${name} is not in the free set`)
  const d = solidify(line, RECIPES[name])
  return `export const ${name}: SolidIcon = [['path', { d: '${d}', fill: 'currentColor', fillRule: 'evenodd', clipRule: 'evenodd', key: '0' }]]\n`
}).join('\n')

const out = fileURLToPath(new URL('../src/solidIcons.ts', import.meta.url))
writeFileSync(out, `// Generated by scripts/generate-solid-icons.mjs from the line icons of
// @hugeicons/core-free-icons (MIT). Do not edit: change the script and run it again.

/** The HugeIcons data shape, so these render through the same icon component as the line glyphs. */
export type SolidIcon = readonly (readonly [string, { readonly [key: string]: string | number }])[]

${body}`)
console.log(`${ICONS.length} solid icons written to ${out}`)
