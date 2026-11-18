import { useEffect, useRef, useState } from 'react'
import type { HouseSettings, ProviderConnection } from '@manor/contracts'
import { CATALOG_DRIVERS, MODELS, everyModelOff } from '../../runtimes'
import type { Notice } from '../../state'
import { ProviderMark } from '../ProviderMark'
import { RequestNotice } from '../ui/RequestNotice'
import { Switch } from '../ui/Switch'
import { SettingsGroup, SettingsPage, SettingsRow } from './SettingsLayout'

const GROUP_NAME: Record<(typeof CATALOG_DRIVERS)[number], string> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  cursor: 'Cursor',
}

/** Why a provider's models cannot answer right now, or nothing when they can. */
function unavailableReason(connection: ProviderConnection | undefined): string | undefined {
  if (connection === undefined) return undefined
  switch (connection.state) {
    case 'ready':
      return undefined
    case 'signing_in':
      return 'Signing in…'
    case 'install':
    case 'installing':
      return 'Not installed'
    case 'sign_in':
      return 'Not signed in'
    case 'attention':
      return connection.message ?? 'Needs attention'
  }
}

const offKey = (off: readonly string[]) => JSON.stringify(off)

/**
 * Which models Manor may run. An off model leaves every picker, Auto skips it and
 * subagents may not use it; a chat already on one keeps it. Each switch applies at
 * once. A provider that cannot answer keeps its rows, muted, with the reason.
 */
export function ModelsPage({ settings, connections, notice, onCheck, onSave, onDismissNotice }: {
  /** Null until the server has sent them; nothing is saved over settings not yet read. */
  settings: HouseSettings | null
  connections: readonly ProviderConnection[]
  notice: Notice | null
  onCheck: () => void
  /** False when the socket was down and nothing left. */
  onSave: (settings: HouseSettings) => boolean
  onDismissNotice: () => void
}) {
  const [draft, setDraft] = useState(settings?.disabledModels ?? null)
  const [offline, setOffline] = useState(false)
  // Saves still on their way back. Their echoes are this page's own switches arriving
  // in order and must not flip a later switch back; anything else is another window.
  const inFlight = useRef<string[]>([])

  // A login can change outside Manor, so opening the page asks the CLIs again.
  useEffect(() => { onCheck() }, [onCheck])

  useEffect(() => {
    if (settings === null) return
    const key = offKey(settings.disabledModels)
    const at = inFlight.current.indexOf(key)
    if (at !== -1) {
      inFlight.current = inFlight.current.slice(at + 1)
      return
    }
    setDraft(settings.disabledModels)
  }, [settings])

  if (settings === null || draft === null) {
    return (
      <SettingsPage title="Models">
        <p className="m-0 text-label text-dim">Reading the settings…</p>
      </SettingsPage>
    )
  }

  const toggle = (model: string, on: boolean) => {
    const next = on ? draft.filter((value) => value !== model) : [...draft, model]
    if (everyModelOff(next)) return
    onDismissNotice()
    inFlight.current = [...inFlight.current, offKey(next)]
    const sent = onSave({ ...settings, disabledModels: next })
    setOffline(!sent)
    // Nothing left, so the switch stays where the server has it.
    if (sent) setDraft(next)
    else inFlight.current = inFlight.current.slice(0, -1)
  }

  return (
    <SettingsPage
      title="Models"
      description="An off model leaves every model picker, Auto skips it and subagents may not use it. A chat already on it keeps running."
    >
      {CATALOG_DRIVERS.map((driver) => {
        const reason = unavailableReason(connections.find((entry) => entry.provider === driver))
        return (
          <SettingsGroup key={driver} title={GROUP_NAME[driver]} {...(reason === undefined ? {} : { note: reason })}>
            {MODELS[driver].map((option) => {
              const on = !draft.includes(option.value)
              const last = on && everyModelOff([...draft, option.value])
              return (
                <SettingsRow
                  key={option.value}
                  label={
                    <span className={`flex items-center gap-2 ${reason === undefined ? '' : 'text-dim'}`}>
                      <ProviderMark driver={driver} size={14} />
                      {option.label}
                    </span>
                  }
                  {...(last ? { description: 'The last model on stays on.' } : {})}
                >
                  <Switch label={option.label} checked={on} disabled={last} onChange={(next) => toggle(option.value, next)} />
                </SettingsRow>
              )
            })}
          </SettingsGroup>
        )
      })}
      {notice !== null ? (
        <RequestNotice notice={notice} onDismiss={onDismissNotice} />
      ) : offline ? (
        <p className="m-0 text-label text-danger" role="status">Nothing was sent, the connection is down. Try again once it is back.</p>
      ) : null}
    </SettingsPage>
  )
}
