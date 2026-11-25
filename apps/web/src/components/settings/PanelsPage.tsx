import type { HouseSettings, SimulatorAction, SimulatorState } from '@manor/contracts'
import type { Notice } from '../../state'
import { RequestNotice } from '../ui/RequestNotice'
import { BrowserGroup } from './BrowserSettings'
import { SettingsPage } from './SettingsLayout'
import { SimulatorGroup } from './SimulatorSettings'

/** Settings → Browser & Simulator: the two panels that open beside a chat. */
export function PanelsPage({ settings, simulator, connected, notice, onSave, onSimulatorAction, onDismissNotice }: {
  /** Null until the server has sent them; both groups wait. */
  settings: HouseSettings | null
  /** The device list the Simulator group picks from. */
  simulator: SimulatorState | null
  connected: boolean
  /** The server's answer to a refused save, such as a server older than this app. */
  notice: Notice | null
  /** False when the socket was down and nothing left. */
  onSave: (settings: HouseSettings) => boolean
  onSimulatorAction: (action: SimulatorAction, udid?: string) => boolean
  onDismissNotice: () => void
}) {
  return (
    <SettingsPage title="Browser & Simulator">
      {settings === null ? <p className="m-0 text-label text-dim">Reading the settings…</p> : null}
      <BrowserGroup settings={settings} onSave={onSave} />
      <SimulatorGroup settings={settings} simulator={simulator} connected={connected} onSave={onSave} onAction={onSimulatorAction} />
      {notice === null ? null : <RequestNotice notice={notice} onDismiss={onDismissNotice} />}
    </SettingsPage>
  )
}
