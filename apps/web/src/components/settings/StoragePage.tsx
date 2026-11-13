import { useState } from 'react'
import { DEFAULT_HOUSE_SETTINGS, daysToMs, type HouseSettings } from '@manor/contracts'
import type { Notice } from '../../state'
import { useRequest, type RequestEvents } from '../../useRequest'
import { ConfirmStrip } from '../Confirm'
import { RequestNotice } from '../ui/RequestNotice'
import { Select } from '../ui/Select'
import { SettingsGroup, SettingsPage, SettingsRow } from './SettingsLayout'

const OFFLINE = 'Nothing was sent, the connection is down. Try again once it is back.'
const NEVER = 'never'

/** The settings counted in days; the folders and the note AI live on the Memory page. */
type DaysKey = Exclude<keyof HouseSettings, 'memoryDir' | 'knowledgeDir' | 'noteAiModel' | 'noteAiEffort'>

/** The day counts each row offers. A value saved outside these still shows as itself. */
const CHOICES: Record<DaysKey, readonly number[]> = {
  autoSettleDays: [1, 2, 3, 7, 14],
  archiveRetentionDays: [3, 7, 10, 14, 30, 60, 90],
  attachmentRetentionDays: [3, 7, 14, 30, 90],
  backupRetentionDays: [7, 14, 30, 90],
}

const dayLabel = (days: number) => (days === 1 ? '1 day' : days % 7 === 0 && days <= 14 ? `${days / 7} ${days === 7 ? 'week' : 'weeks'}` : `${days} days`)

function options(key: DaysKey, current: number | null, never: string | undefined) {
  const days = CHOICES[key].includes(current ?? -1) || current === null ? CHOICES[key] : [...CHOICES[key], current].sort((a, b) => a - b)
  return [
    ...days.map((value) => ({ value: String(value), label: dayLabel(value) })),
    ...(never === undefined ? [] : [{ value: NEVER, label: never }]),
  ]
}

/** How long Manor keeps things before it tidies up. The hourly sweep reads these. */
export function StoragePage({ settings, archivedAt, notice, requestEvents, onSave, onDismissNotice }: {
  /** Null until the server's connect message lands; nothing is saved over unread settings. */
  settings: HouseSettings | null
  /** When each archived chat was archived, to say what a shorter window deletes. */
  archivedAt: readonly number[]
  notice: Notice | null
  requestEvents: RequestEvents
  onSave: (settings: HouseSettings, requestId: string) => boolean
  onDismissNotice: () => void
}) {
  const request = useRequest(requestEvents)
  const [problem, setProblem] = useState<string | null>(null)
  // Settings whose shorter archive window would delete chats wait here for a second click.
  const [pending, setPending] = useState<{ next: HouseSettings; count: number } | null>(null)

  if (settings === null) {
    return (
      <SettingsPage title="Storage">
        <p className="m-0 text-label text-dim">Reading the settings…</p>
      </SettingsPage>
    )
  }

  const save = (next: HouseSettings) => {
    setProblem(null)
    onDismissNotice()
    if (!request.start((requestId) => onSave(next, requestId))) setProblem(OFFLINE)
  }

  // Every change goes through here, a picked value and Restore defaults alike, so no
  // path shortens the archive window past existing chats without asking.
  const propose = (next: HouseSettings) => {
    const now = Date.now()
    const count = next.archiveRetentionDays >= settings.archiveRetentionDays
      ? 0
      : archivedAt.filter((at) => now - at >= daysToMs(next.archiveRetentionDays)).length
    if (count > 0) {
      setPending({ next, count })
      return
    }
    setPending(null)
    save(next)
  }

  const restore = (keys: readonly DaysKey[]) => ({
    onRestore: () => propose({ ...settings, ...Object.fromEntries(keys.map((key) => [key, DEFAULT_HOUSE_SETTINGS[key]])) }),
    restoreDisabled: request.pending || keys.every((key) => settings[key] === DEFAULT_HOUSE_SETTINGS[key]),
  })

  const control = (key: DaysKey, label: string, never?: string) => (
    <div className="w-[160px]">
      <Select
        label={label}
        value={settings[key] === null ? NEVER : String(settings[key])}
        disabled={request.pending}
        options={options(key, settings[key], never)}
        onChange={(value) => propose({ ...settings, [key]: value === NEVER ? null : Number(value) })}
      />
    </div>
  )

  return (
    <SettingsPage title="Storage" description="How long Manor keeps things before it tidies up. Checked every hour.">
      <SettingsGroup title="Chats" {...restore(['autoSettleDays', 'archiveRetentionDays'])}>
        <SettingsRow label="Settle quiet Sessions" description="A Session with no new messages for this long moves to Settled.">
          {control('autoSettleDays', 'Settle quiet Sessions', 'Never')}
        </SettingsRow>
        {pending === null ? (
          <SettingsRow label="Delete archived chats" description="An archived chat can be restored until then. After that it is deleted with its worktrees.">
            {control('archiveRetentionDays', 'Delete archived chats')}
          </SettingsRow>
        ) : (
          <div className="flex min-h-14 items-center py-3">
            <ConfirmStrip
              question={`${pending.count === 1 ? '1 archived chat is' : `${pending.count} archived chats are`} older than ${dayLabel(pending.next.archiveRetentionDays)} and will be deleted within the hour.`}
              confirmLabel="Shorten"
              onConfirm={() => {
                setPending(null)
                save(pending.next)
              }}
              onCancel={() => setPending(null)}
            />
          </div>
        )}
      </SettingsGroup>
      <SettingsGroup title="Files" {...restore(['attachmentRetentionDays', 'backupRetentionDays'])}>
        <SettingsRow label="Keep picture copies" description="Copies agents read from a chat's working folder. The chat keeps the picture itself.">
          {control('attachmentRetentionDays', 'Keep picture copies', 'Keep all')}
        </SettingsRow>
        <SettingsRow label="Keep backups" description="Nightly copies of Manor's database in ~/.manor/backups. Each copy is the full database.">
          {control('backupRetentionDays', 'Keep backups', 'Keep all')}
        </SettingsRow>
      </SettingsGroup>
      {notice !== null ? <RequestNotice notice={notice} onDismiss={onDismissNotice} /> : null}
      {notice === null && problem !== null ? <p className="m-0 text-label text-danger" role="status">{problem}</p> : null}
    </SettingsPage>
  )
}
