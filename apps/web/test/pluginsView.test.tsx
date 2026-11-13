import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PluginsTabs, PluginsView, type PluginSection } from '../src/components/plugins/PluginsView'

const render = (section: PluginSection) =>
  renderToStaticMarkup(
    <>
      <PluginsTabs
        section={section}
        onOpenConnectors={() => {}}
        onOpenSkills={() => {}}
        onOpenSuggestions={() => {}}
      />
      <PluginsView section={section}>
        <span>Registry content</span>
      </PluginsView>
    </>,
  )

describe('the plugins view', () => {
  it('groups connectors, skills, and suggestions in one accessible segmented control', () => {
    const html = render('connectors')

    expect(html).toContain('role="tablist" aria-label="Plugin section"')
    expect(html).toContain('id="plugins-tab-connectors" type="button" role="tab" aria-selected="true"')
    expect(html).toContain('id="plugins-tab-skills" type="button" role="tab" aria-selected="false"')
    expect(html).toContain('id="plugins-tab-suggestions" type="button" role="tab" aria-selected="false"')
    expect(html).toContain('id="plugins-connectors" role="tabpanel" aria-labelledby="plugins-tab-connectors"')
    expect(html).toContain('>Registry content<')
  })

  it('moves the selected state and panel identity to skills', () => {
    const html = render('skills')

    expect(html).toContain('id="plugins-tab-connectors" type="button" role="tab" aria-selected="false"')
    expect(html).toContain('id="plugins-tab-skills" type="button" role="tab" aria-selected="true"')
    expect(html).toContain('id="plugins-skills" role="tabpanel" aria-labelledby="plugins-tab-skills"')
  })

  it('moves the selected state and panel identity to suggestions', () => {
    const html = render('suggestions')

    expect(html).toContain('id="plugins-tab-suggestions" type="button" role="tab" aria-selected="true"')
    expect(html).toContain('id="plugins-suggestions" role="tabpanel" aria-labelledby="plugins-tab-suggestions"')
  })
})
