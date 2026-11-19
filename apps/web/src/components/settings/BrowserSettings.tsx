import { BrowserSearchEngineSchema, DEFAULT_HOUSE_SETTINGS, type BrowserSearchEngine, type HouseSettings } from '@manor/contracts'
import { SEARCH_ENGINES } from '../../browserAddress'
import { desktopBrowser } from '../../desktopBrowser'
import { Select } from '../ui/Select'
import { SettingsGroup, SettingsRow } from './SettingsLayout'

const ENGINE_OPTIONS = BrowserSearchEngineSchema.options.map((value) => ({ value, label: SEARCH_ENGINES[value].label }))

/**
 * The Browser's search engine, on the General page. A pick saves at once. The Browser
 * lives only in the desktop app, so without its bridge the group is not drawn, nor
 * while the settings are still on their way.
 */
export function BrowserGroup({ settings, onSave }: {
  settings: HouseSettings | null
  onSave: (settings: HouseSettings) => void
}) {
  if (settings === null || desktopBrowser() === undefined) return null
  const pick = (browserSearchEngine: BrowserSearchEngine) => {
    if (browserSearchEngine !== settings.browserSearchEngine) onSave({ ...settings, browserSearchEngine })
  }
  return (
    <SettingsGroup
      title="Browser"
      onRestore={() => pick(DEFAULT_HOUSE_SETTINGS.browserSearchEngine)}
      restoreDisabled={settings.browserSearchEngine === DEFAULT_HOUSE_SETTINGS.browserSearchEngine}
    >
      <SettingsRow label="Search engine" description="Used when you type words into the Browser's address bar.">
        <div className="w-[200px]">
          <Select label="Search engine" value={settings.browserSearchEngine} options={ENGINE_OPTIONS} onChange={pick} />
        </div>
      </SettingsRow>
    </SettingsGroup>
  )
}
