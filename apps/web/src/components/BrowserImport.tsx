import { useState } from 'react'
import type { BrowserImportStatus, ImportBrowserId } from '@manor/contracts'
import { Button } from './ui/Button'
import { Switch } from './ui/Switch'

const HINT_KEY = 'manor.browserImportHint'

/** Whether the one-time offer was answered on this Mac, either way. */
export function importHintAnswered(): boolean {
  try {
    return window.localStorage.getItem(HINT_KEY) !== null
  } catch {
    return true
  }
}

export function answerImportHint(): void {
  try {
    window.localStorage.setItem(HINT_KEY, 'answered')
  } catch {
    // Without storage the hint shows again next time, which is the lesser problem.
  }
}

const nameOf = (status: BrowserImportStatus, id: ImportBrowserId): string =>
  status.browsers.find((browser) => browser.id === id)?.name ?? id

/** What the browser menu calls the profile in use. */
export const importProfileLabel = (status: BrowserImportStatus | null): string =>
  status?.enabled !== true
    ? 'Default'
    : `${nameOf(status, status.browser)}${status.profileName === undefined ? '' : ` · ${status.profileName}`}`

/**
 * The opt-in copy of another browser's logins. The switch turns it on for the browser
 * that is picked; picking another one while it is on replaces the copy. Only browsers
 * found on this Mac are offered, and with none there is nothing to switch on.
 */
export function BrowserImportCard({ status, syncing, onChange }: {
  status: BrowserImportStatus
  syncing: boolean
  onChange: (enabled: boolean, browser: ImportBrowserId) => void
}) {
  const installed = status.browsers.filter((browser) => browser.installed)
  // While it is off a pick is only a choice, kept here until the switch is thrown:
  // telling the desktop would swap the browser profile for nothing.
  const [choice, setChoice] = useState<ImportBrowserId | null>(null)
  const picked = status.enabled || choice === null ? status.browser : choice
  const source = nameOf(status, picked)
  const note = syncing
    ? status.enabled ? 'Removing the copied profile…' : `Copying your ${source} profile…`
    : status.error
      ?? status.warning
      ?? (status.enabled
        ? `Using a managed copy of ${source}${status.profileName === undefined ? '' : ` (${status.profileName})`}.`
        : installed.length === 0
          ? `None of ${status.browsers.map((browser) => browser.name).join(', ')} was found on this Mac.`
          : 'Off by default. macOS asks for your login password once, to read the key of that browser. Turning this off deletes the copy.')
  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <span>
          <span className="block text-[13px] font-medium text-text">Use logins from another browser</span>
          <span className="mt-0.5 block text-[12px] leading-relaxed text-dim">
            Manor copies the active profile of a browser you already use into its own browser, so sites know you. It never opens or drives that browser.
          </span>
        </span>
        <Switch
          label="Use logins from another browser"
          checked={status.enabled}
          disabled={syncing || (!status.enabled && !installed.some((browser) => browser.id === picked))}
          onChange={(enabled) => onChange(enabled, picked)}
        />
      </div>
      {installed.length === 0 || (installed.length === 1 && installed[0]?.id === picked) ? null : (
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Browser to copy from">
          {installed.map((browser) => (
            <Button
              key={browser.id}
              size="compact"
              variant={browser.id === picked ? 'secondary' : 'ghost'}
              aria-pressed={browser.id === picked}
              disabled={syncing}
              // On, a pick replaces the copy with that browser's.
              onClick={() => {
                if (browser.id === picked) return
                if (status.enabled) onChange(true, browser.id)
                else setChoice(browser.id)
              }}
            >
              {browser.name}
            </Button>
          ))}
        </div>
      )}
      <p className={`mt-2 mb-0 text-[12px] leading-relaxed ${status.error === undefined || syncing ? 'text-dim' : 'text-danger'}`}>{note}</p>
    </>
  )
}

/** The first time the browser opens with a known browser on this Mac and no copy yet. */
export function BrowserImportHint({ status, onSetUp, onDismiss }: {
  status: BrowserImportStatus
  onSetUp: () => void
  onDismiss: () => void
}) {
  const first = status.browsers.find((browser) => browser.installed)
  if (status.enabled || first === undefined) return null
  return (
    <div className="flex min-w-0 items-center gap-1.5 border-t border-line py-1.5 pr-2 pl-4 text-[12px] text-muted" role="group" aria-label="Bring your logins">
      <span className="min-w-0 flex-1 truncate">Already signed in to sites in {first.name}? Manor can copy those logins.</span>
      <Button size="compact" variant="secondary" onClick={onSetUp}>Set up</Button>
      <Button size="compact" variant="ghost" onClick={onDismiss}>Not now</Button>
    </div>
  )
}
