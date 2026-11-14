import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DOCK_FLOAT, dockPanelLayoutClass } from '../src/components/ui/dockPanel'

// BrowserWebviewHost writes a guest's z-index inline as `var(--z-browser-${presentation})`,
// so no class names these layers and a dead-code sweep cannot see that they are used.
const styles = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8')
const layer = (name: string) => Number(styles.match(new RegExp(`--${name}:\\s*(-?\\d+);`))?.[1])
const zOf = (classes: string) => Number(classes.match(/\bz-\[(\d+)\]/)?.[1])

describe('browser page layers', () => {
  it('defines a layer for every presentation a guest is shown in', () => {
    expect(layer('z-browser-sidebar')).not.toBeNaN()
    expect(layer('z-browser-floating')).not.toBeNaN()
  })

  it('draws the page above an expanded or floating panel, under a tile drag and Settings', () => {
    const page = layer('z-browser-sidebar')
    expect(page).toBeGreaterThan(zOf(dockPanelLayoutClass('', true)))
    expect(page).toBeGreaterThan(zOf(DOCK_FLOAT))
    expect(page).toBeLessThan(layer('z-panel-drag'))
    expect(page).toBeLessThan(layer('z-settings'))
  })
})
