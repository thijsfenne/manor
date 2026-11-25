import { useEffect, useMemo, useState } from 'react'
import { encode } from 'uqr'
import { appPairingLink, parsePairingLink, type PairedDevice, type PairingLink, type PhoneAccess, type TailscaleStatus } from '@manor/contracts'
import { copyText } from '../../clipboard'
import { relativeTime } from '../../relativeTime'
import type { Notice } from '../../state'
import { useRequest, type RequestEvents } from '../../useRequest'
import { Button } from '../ui/Button'
import { RequestNotice } from '../ui/RequestNotice'
import { Switch } from '../ui/Switch'
import { SettingsGroup, SettingsPage, SettingsRow } from './SettingsLayout'

const OFFLINE = 'Nothing was sent, the connection is down. Try again once it is back.'

/** What the switch row says under its label, per Tailscale state. */
function tailscaleLine(status: TailscaleStatus): string {
  switch (status.state) {
    case 'checking': return 'Checking Tailscale…'
    case 'missing': return 'Tailscale is not installed on this Mac. Install it from tailscale.com, sign in, then come back here.'
    case 'stopped': return 'Tailscale is turned off on this Mac. Turn it on in the Tailscale app.'
    case 'logged_out': return 'Tailscale is not signed in on this Mac. Sign in from the Tailscale app.'
    case 'no_https':
      return status.serving
        ? 'Your tailnet lost MagicDNS or HTTPS certificates, so your phone cannot reach this Mac. Turn both on again under DNS in the Tailscale admin console, or turn this off.'
        : 'Your tailnet needs MagicDNS and HTTPS certificates. Turn both on in the Tailscale admin console, under DNS.'
    case 'conflict':
      return status.funnel
        ? 'Tailscale Funnel is on for this Mac, which makes it public. Manor stays off until Funnel is off.'
        : `Something else already serves ${status.address}. Manor leaves that mapping alone; remove it first.`
    case 'ready':
      return status.serving
        ? `Your phone reaches this Mac at ${status.address}. Only devices in your tailnet can open it.`
        : `Turn on so your phone can reach this Mac at ${status.address}.`
    case 'error': return status.message
  }
}

/** The code as squares on a fixed white plate: a camera reads dark on light in either theme. */
function QrCode({ text }: { text: string }) {
  const { path, size } = useMemo(() => {
    const { data, size } = encode(text, { ecc: 'M', border: 2 })
    return { size, path: data.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : []))).join('') }
  }, [text])
  return (
    <svg
      role="img"
      aria-label="Pairing QR code"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="size-[184px] flex-none rounded-md bg-page text-on-page"
    >
      <path d={path} fill="currentColor" />
    </svg>
  )
}

const minutesLeft = (expiresAt: number, now: number) => Math.max(0, Math.ceil((expiresAt - now) / 60_000))

function PairingPanel({ link, pairedName, onDone }: { link: PairingLink; pairedName: string | null; onDone: () => void }) {
  const [now, setNow] = useState(() => Date.now())
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)
  // The QR opens the installed app when the iPhone camera scans it; a browser pairs only
  // when the person asks for that link instead.
  const [forBrowser, setForBrowser] = useState(false)
  const appLink = useMemo(() => {
    const parsed = parsePairingLink(link.link)
    return parsed === null ? link.link : appPairingLink(parsed.origin, parsed.code)
  }, [link.link])
  const shownLink = forBrowser ? link.link : appLink
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [])

  const left = minutesLeft(link.expiresAt, now)
  const ended = pairedName !== null ? `${pairedName} is paired. This link is used up.` : left === 0 ? 'This link has expired. Make a new one.' : null

  return (
    <div className="flex gap-5 py-3 @max-[480px]:flex-col">
      {ended === null ? <QrCode text={shownLink} /> : null}
      <div className="flex min-w-0 flex-col gap-2">
        {ended === null ? (
          <>
            <span className="text-[14px] text-text">
              {forBrowser
                ? 'Open this link in the browser on your phone.'
                : 'Scan this with the camera on your iPhone to open the Manor app.'}
            </span>
            <code className="block truncate font-mono text-label text-muted" title={shownLink}>{shownLink}</code>
            <span className="text-label text-muted tabular-nums">
              Works once, for {left === 1 ? '1 more minute' : `${left} more minutes`}.
            </span>
          </>
        ) : (
          <span className="text-[14px] text-text">{ended}</span>
        )}
        <div className="flex items-center gap-2">
          {ended === null ? (
            <>
              <Button size="small" onClick={() => { void copyText(shownLink).then((ok) => setCopied(ok ? 'yes' : 'failed')) }}>
                {copied === 'yes' ? 'Copied' : 'Copy link'}
              </Button>
              <Button size="small" onClick={() => { setCopied(null); setForBrowser(!forBrowser) }}>
                {forBrowser ? 'Use the app instead' : 'Pair a browser instead'}
              </Button>
            </>
          ) : null}
          <Button size="small" onClick={onDone}>Done</Button>
          {copied === 'failed' ? <span className="text-label text-danger">Could not copy.</span> : null}
        </div>
      </div>
    </div>
  )
}

function deviceLine(device: PairedDevice): string {
  const paired = `Paired ${new Date(device.pairedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
  if (device.connected) return `${paired}, connected now`
  if (device.lastSeenAt === null) return `${paired}, not seen since`
  const ago = relativeTime(device.lastSeenAt)
  return `${paired}, last seen ${ago === 'now' ? 'just now' : `${ago} ago`}`
}

/** A paired browser's way out. Only there: the local desktop app has nobody to sign out. */
function ForgetGroup({ onForget }: { onForget: () => void }) {
  return (
    <SettingsGroup title="This browser">
      <SettingsRow label="Forget this Mac" description="Removes this browser from Manor. Pair it again from Settings → Phone on your Mac.">
        <Button size="compact" variant="secondary" onClick={onForget}>Forget this Mac</Button>
      </SettingsRow>
    </SettingsGroup>
  )
}

/**
 * Settings → Phone: Tailscale HTTPS so a phone can reach this Mac, a one-time pairing
 * link with its QR code, the devices that paired, each with Revoke, and in a paired
 * browser the way to forget this Mac.
 */
export function PhonePage({ access, pairingLink, account, notice, requestEvents, onRequest, onSetServing, onCreateLink, onRevoke, onDismissNotice }: {
  access: PhoneAccess | null
  /** Present only where sign-in is on; the local desktop app has nobody to sign out. */
  account?: { onForget: () => void }
  pairingLink: PairingLink | null
  notice: Notice | null
  requestEvents: RequestEvents
  onRequest: () => void
  onSetServing: (on: boolean, requestId: string) => boolean
  onCreateLink: (requestId: string) => boolean
  onRevoke: (deviceId: string, requestId: string) => boolean
  onDismissNotice: () => void
}) {
  const serving = useRequest(requestEvents)
  const pairing = useRequest(requestEvents)
  const revoking = useRequest(requestEvents)
  const [problem, setProblem] = useState<string | null>(null)
  // The link shows once this page asked for it, with the devices known at that moment,
  // so a device that appears afterwards is the one that used it. Its name sticks, so a
  // later revoke of that device does not bring the spent code back.
  const [shown, setShown] = useState<{ before: ReadonlySet<string>; usedBy: string | null } | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const forget = account === undefined ? null : <ForgetGroup onForget={account.onForget} />

  // Tailscale can change outside Manor, so coming back to the window asks again.
  useEffect(() => {
    onRequest()
    window.addEventListener('focus', onRequest)
    return () => window.removeEventListener('focus', onRequest)
  }, [onRequest])

  if (access === null) {
    return (
      <SettingsPage title="Phone">
        <p className="m-0 text-label text-dim">Asking the Mac…</p>
        {forget}
      </SettingsPage>
    )
  }

  const { tailscale, devices } = access
  const failed = (text: string) => setProblem(text)
  const inPlace = { noticeInPlace: true, onNotice: (answer: { text: string }) => failed(answer.text) }

  const setServing = (on: boolean) => {
    setProblem(null)
    onDismissNotice()
    if (!serving.start((requestId) => onSetServing(on, requestId), inPlace)) failed(OFFLINE)
  }
  const createLink = () => {
    setProblem(null)
    onDismissNotice()
    const before = new Set(devices.map((device) => device.id))
    if (!pairing.start((requestId) => onCreateLink(requestId), { ...inPlace, onAck: () => setShown({ before, usedBy: null }) })) failed(OFFLINE)
  }
  const revoke = (deviceId: string) => {
    setProblem(null)
    onDismissNotice()
    setRevokingId(deviceId)
    const done = () => setRevokingId(null)
    if (!revoking.start((requestId) => onRevoke(deviceId, requestId), { noticeInPlace: true, onAck: done, onNotice: (answer) => { done(); failed(answer.text) } })) {
      done()
      failed(OFFLINE)
    }
  }

  const newDevice = shown === null || shown.usedBy !== null ? undefined : devices.find((device) => !shown.before.has(device.id))
  if (shown !== null && newDevice !== undefined) setShown({ ...shown, usedBy: newDevice.name })
  const shownNotice = problem === null ? notice : { kind: 'error' as const, text: problem }

  return (
    <SettingsPage title="Phone">
      <SettingsGroup title="Reach this Mac">
        <SettingsRow label="Tailscale HTTPS" description={tailscaleLine(tailscale)}>
          <Switch
            checked={(tailscale.state === 'ready' || tailscale.state === 'no_https') && tailscale.serving}
            label="Tailscale HTTPS"
            disabled={!(tailscale.state === 'ready' || (tailscale.state === 'no_https' && tailscale.serving)) || serving.pending}
            onChange={setServing}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Pair">
        <SettingsRow label="Pair phone" description="Makes a one-time link and QR code. It works for 10 minutes, on one device.">
          <Button size="small" disabled={pairing.pending} onClick={createLink}>{shown === null ? 'Make link' : 'New link'}</Button>
        </SettingsRow>
        {shown !== null && pairingLink !== null ? (
          <PairingPanel key={pairingLink.expiresAt} link={pairingLink} pairedName={shown.usedBy ?? newDevice?.name ?? null} onDone={() => setShown(null)} />
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Paired devices">
        {devices.length === 0 ? (
          <p className="m-0 py-3 text-label text-dim">No devices yet.</p>
        ) : devices.map((device) => (
          <SettingsRow key={device.id} label={device.name} description={deviceLine(device)}>
            <Button size="small" disabled={revokingId !== null} onClick={() => revoke(device.id)}>
              {revokingId === device.id ? 'Revoking…' : 'Revoke'}
            </Button>
          </SettingsRow>
        ))}
      </SettingsGroup>

      {forget}

      {shownNotice === null ? null : <RequestNotice notice={shownNotice} onDismiss={() => { setProblem(null); onDismissNotice() }} />}
    </SettingsPage>
  )
}
