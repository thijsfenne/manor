import { useEffect, useState } from 'react'
import { CheckmarkCircle02Icon } from '@hugeicons/core-free-icons'
import type { DesktopPermissionId, DesktopPermissionsBridge, DesktopPermissionState, DesktopPermissionStatus } from '@manor/contracts'
import { Icon } from '../Icon'
import { Button } from '../ui/Button'
import { SettingsGroup, SettingsPage, SettingsRow } from './SettingsLayout'

/** Often enough that a grant shows while System Settings is still in front. */
const POLL_MS = 1_500

const ROWS: readonly { id: DesktopPermissionId; label: string; description: string }[] = [
  { id: 'accessibility', label: 'Accessibility', description: 'Lets agents click, type and read the apps you lend them.' },
  { id: 'screen-recording', label: 'Screen Recording', description: 'Lets agents see the windows they work in.' },
]

const PENDING_HINT = 'Waiting for System Settings. If Manor is already switched on there, switch it off and on again.'

function StateLabel({ state }: { state: DesktopPermissionState | undefined }) {
  switch (state) {
    case 'granted':
      return (
        <span className="flex items-center gap-1.5 text-label text-ok">
          <Icon icon={CheckmarkCircle02Icon} size={13} />
          Granted
        </span>
      )
    case 'pending':
      return <span className="text-label text-warn">Pending</span>
    case 'not-granted':
      return <span className="text-label text-dim">Not granted</span>
    case undefined:
      return <span className="text-label text-dim">Checking…</span>
  }
}

/**
 * Manor's own macOS permissions for computer use. Only the desktop app has them, so
 * a browser tab says that and nothing more. In the app each read asks macOS afresh,
 * which is how a grant shows up here without restarting Manor.
 */
export function PermissionsPage({ bridge }: { bridge: DesktopPermissionsBridge | undefined }) {
  const [status, setStatus] = useState<DesktopPermissionStatus | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (bridge === undefined) return
    let live = true
    const read = () => {
      bridge.status().then(
        (next) => { if (live) { setStatus(next); setFailed(false) } },
        () => { if (live) setFailed(true) },
      )
    }
    read()
    const timer = setInterval(read, POLL_MS)
    return () => { live = false; clearInterval(timer) }
  }, [bridge])

  if (bridge === undefined) {
    return (
      <SettingsPage title="Permissions">
        <p className="m-0 text-[14px] text-muted">Permissions only apply in the Manor desktop app on your Mac. Open Manor there to see and grant them.</p>
      </SettingsPage>
    )
  }

  return (
    <SettingsPage title="Permissions">
      <SettingsGroup title="Computer use">
        {ROWS.map(({ id, label, description }) => {
          const state = status?.[id]
          return (
            <SettingsRow key={id} label={label} description={state === 'pending' ? PENDING_HINT : description}>
              <StateLabel state={state} />
              <Button
                size="compact"
                variant={state === 'granted' ? 'ghost' : 'primary'}
                onClick={() => {
                  void bridge.open(id).then(() => bridge.status()).then(setStatus, () => setFailed(true))
                }}
              >
                Open System Settings
              </Button>
            </SettingsRow>
          )
        })}
      </SettingsGroup>
      {failed ? <p className="m-0 text-label text-danger" role="status">Manor could not read its permissions. It keeps trying.</p> : null}
    </SettingsPage>
  )
}
