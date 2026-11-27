import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react'
import { DEFAULT_USER_PROFILE, MAIL_LABEL_NAME, MAIL_LABELS, type HouseSettings, type SystemInfo, type UserProfile } from '@manor/contracts'
import { AVATAR_ACCEPT, shrinkToAvatar } from '../../avatar'
import { DEFAULT_THEMES, type ThemePair } from '../../colorThemes'
import type { Notice } from '../../state'
import type { ThemeChoice as Choice } from '../../useTheme'
import { useRequest, type RequestEvents } from '../../useRequest'
import { DEFAULT_PROFILE_PHOTO } from '../AccountPopover'
import { Button } from '../ui/Button'
import { formInputClass } from '../ui/FormField'
import { RequestNotice } from '../ui/RequestNotice'
import { SettingsGroup, SettingsPage, SettingsRow } from './SettingsLayout'
import { FontGroup } from './FontSettings'
import { PowerGroup } from './PowerSettings'
import { ModePicker, ThemeGrid } from './ThemePicker'

const OFFLINE = 'Nothing was sent, the connection is down. Try again once it is back.'

/** The server's answer to the last save, under the page that made it. */
function PageNotice({ notice, problem, onDismiss }: { notice: Notice | null; problem?: string | null; onDismiss: () => void }) {
  if (notice !== null) return <RequestNotice notice={notice} onDismiss={onDismiss} />
  if (problem === null || problem === undefined) return null
  return <p className="m-0 text-label text-danger" role="status">{problem}</p>
}

export function GeneralPage({ profile, notice, requestEvents, onSaveProfile, onDismissNotice, settings, onSaveSettings, info, onRequestInfo }: {
  /** Null until the server's connect message lands; nothing is saved over an unread profile. */
  profile: UserProfile | null
  notice: Notice | null
  requestEvents: RequestEvents
  onSaveProfile: (profile: UserProfile, requestId: string) => boolean
  onDismissNotice: () => void
  /** Null until the server has sent them; the groups that save them wait. */
  settings: HouseSettings | null
  onSaveSettings: (settings: HouseSettings) => void
  info: SystemInfo | null
  onRequestInfo: () => void
}) {
  const [problem, setProblem] = useState<string | null>(null)
  return (
    <SettingsPage title="General">
      <ProfileGroup profile={profile} requestEvents={requestEvents} onSave={onSaveProfile} onProblem={setProblem} onDismissNotice={onDismissNotice} />
      <PowerGroup settings={settings} info={info} onSaveSettings={onSaveSettings} onRequestInfo={onRequestInfo} />
      <PageNotice notice={notice} problem={problem} onDismiss={onDismissNotice} />
    </SettingsPage>
  )
}

/** How Manor shows you in the rail and the account menu. Display only: agents keep your first name. */
function ProfileGroup({ profile, requestEvents, onSave, onProblem, onDismissNotice }: {
  profile: UserProfile | null
  requestEvents: RequestEvents
  onSave: (profile: UserProfile, requestId: string) => boolean
  onProblem: (problem: string | null) => void
  onDismissNotice: () => void
}) {
  const request = useRequest(requestEvents)
  const nameId = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(profile?.name ?? '')
  const [shrinking, setShrinking] = useState(false)
  const savedName = profile?.name ?? ''

  // A save from another window, or the echo of this one, moves the field along.
  useEffect(() => setName(savedName), [savedName])

  const save = (next: UserProfile) => {
    onProblem(null)
    onDismissNotice()
    if (!request.start((requestId) => onSave(next, requestId))) onProblem(OFFLINE)
  }

  const commitName = () => {
    if (profile === null) return
    const trimmed = name.trim()
    if (trimmed === savedName) return
    if (trimmed === '') {
      setName(savedName)
      onProblem('A name is needed, so the previous one stays.')
      return
    }
    save({ ...profile, name: trimmed })
  }

  const pickFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined || profile === null) return
    setShrinking(true)
    try {
      save({ ...profile, avatar: await shrinkToAvatar(file) })
    } catch (failure) {
      onProblem(failure instanceof Error ? failure.message : 'That picture could not be used.')
    } finally {
      setShrinking(false)
    }
  }

  if (profile === null) return <p className="m-0 text-label text-dim">Reading your profile…</p>
  const atDefaults = profile.name === DEFAULT_USER_PROFILE.name && profile.avatar === undefined

  return (
    <SettingsGroup title="Profile" onRestore={() => save(DEFAULT_USER_PROFILE)} restoreDisabled={atDefaults || request.pending}>
      <SettingsRow label="Photo">
        <img className="h-10 w-10 rounded-full object-cover" src={profile.avatar ?? DEFAULT_PROFILE_PHOTO} alt="" aria-hidden="true" />
        <Button size="compact" variant="secondary" disabled={shrinking || request.pending} onClick={() => fileRef.current?.click()}>
          {shrinking ? 'Resizing…' : 'Upload'}
        </Button>
        {profile.avatar === undefined ? null : (
          <Button size="compact" variant="ghost" disabled={request.pending} onClick={() => save({ name: profile.name })}>
            Remove
          </Button>
        )}
        <input ref={fileRef} className="hidden" type="file" aria-label="Choose a picture" accept={AVATAR_ACCEPT} tabIndex={-1} onChange={(event) => void pickFile(event)} />
      </SettingsRow>
      <SettingsRow label={<label htmlFor={nameId}>Name</label>} description="Agents keep calling you by your first name.">
        <input
          id={nameId}
          className={`${formInputClass} w-[220px]`}
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitName()
          }}
        />
      </SettingsRow>
    </SettingsGroup>
  )
}

export function AppearancePage({ choice, onChange, settings, onSaveSettings }: {
  choice: Choice
  onChange: (choice: Choice) => void
  /** Null until the server has sent them; the theme cards wait, the mode does not. */
  settings: HouseSettings | null
  onSaveSettings: (settings: HouseSettings) => void
}) {
  const themes = settings === null ? DEFAULT_THEMES : { light: settings.lightTheme, dark: settings.darkTheme }
  const saveThemes = ({ light, dark }: ThemePair) => {
    if (settings !== null) onSaveSettings({ ...settings, lightTheme: light, darkTheme: dark })
  }
  return (
    <SettingsPage title="Appearance">
      <SettingsGroup title="Mode" onRestore={() => onChange('system')} restoreDisabled={choice === 'system'}>
        <div className="flex flex-col gap-3 pt-2">
          <ModePicker choice={choice} themes={themes} onChange={onChange} />
          <p className="m-0 text-label text-muted">System follows macOS. Remembered per device.</p>
        </div>
      </SettingsGroup>
      {settings === null ? null : (
        <SettingsGroup
          title="Themes"
          onRestore={() => saveThemes(DEFAULT_THEMES)}
          restoreDisabled={themes.light === DEFAULT_THEMES.light && themes.dark === DEFAULT_THEMES.dark}
        >
          <div className="flex flex-col gap-3 pt-2">
            <ThemeGrid themes={themes} onChange={saveThemes} />
            <p className="m-0 text-label text-muted">The left orb sets the light theme, the right orb the dark one. They can come from different themes.</p>
          </div>
        </SettingsGroup>
      )}
      <FontGroup />
    </SettingsPage>
  )
}

/**
 * Read from the handlers as they stand. Rebinding is parked, so this is a reference
 * card: when a handler's key changes, this list changes with it.
 */
const KEYBINDINGS: readonly { title: string; keys: readonly { keys: string; act: string }[] }[] = [
  {
    title: 'Workspace',
    keys: [
      { keys: '⌘1 – ⌘8', act: 'Open a rail destination, counted down the rail' },
      { keys: '⌘K', act: 'Search chats' },
      { keys: '⌘N', act: 'New Session' },
      { keys: '⌘D', act: 'Switch between the Agents and Sessions lists' },
      { keys: '⌘[  ⌘]', act: 'Back and forward' },
      { keys: '⌘S', act: 'Show or hide the sidebar' },
      { keys: '⌘B', act: 'Show or hide the right panel' },
      { keys: '⌘;', act: 'Open the side chat' },
      { keys: '⌥⇧⌘O', act: 'Change the project on the new session screen' },
      { keys: '⌃Tab', act: 'Switch between live chats (desktop app)' },
      { keys: '⌘,', act: 'Open Settings' },
      { keys: 'Esc', act: 'Leave Settings' },
    ],
  },
  {
    title: 'Files and Knowledge',
    keys: [
      { keys: '⌘S', act: 'Save the open file or note' },
      { keys: '/', act: 'Search notes in Knowledge' },
      { keys: '⌘B', act: 'Make text bold, inside a note' },
    ],
  },
  {
    title: 'Mail',
    keys: [
      { keys: 'J  K  ↓  ↑', act: 'Next and previous mail' },
      { keys: '1 – 4', act: `Label the open mail: ${MAIL_LABELS.map((label) => MAIL_LABEL_NAME[label]).join(', ')}` },
      { keys: 'R', act: 'Reply to the open mail' },
      { keys: 'F', act: 'Forward the open mail' },
      { keys: 'E', act: 'Archive the open mail, or the selected mails' },
      { keys: 'A', act: 'Add the open mail to a chat' },
      { keys: '/', act: 'Search mail' },
      { keys: 'Esc', act: 'Clear a selection of several mails, else close the reply or forward' },
      { keys: '⌘ click', act: 'Add a mail to the selection, or take it out' },
      { keys: '⇧ click', act: 'Select every mail from the last one clicked or opened to this one' },
    ],
  },
  {
    title: 'Browser, while a page has focus (desktop app)',
    keys: [
      { keys: '⌘T', act: 'New tab' },
      { keys: '⌘W', act: 'Close tab' },
      { keys: '⌘L', act: 'Focus the address bar' },
      { keys: '⌘R', act: 'Reload' },
      { keys: '⌘D', act: 'Bookmark the page' },
      { keys: '⌘[  ⌘]', act: 'Back and forward' },
      { keys: '⌃Tab  ⌃⇧Tab', act: 'Next and previous tab' },
    ],
  },
]

export function KeybindingsPage() {
  return (
    <SettingsPage title="Keybindings" description="Ctrl stands in for ⌘ in a browser tab.">
      {KEYBINDINGS.map((group) => (
        <SettingsGroup key={group.title} title={group.title}>
          {group.keys.map((entry) => (
            <div key={`${entry.keys}-${entry.act}`} className="flex items-center justify-between gap-6 py-2.5">
              <span className="text-[14px] text-text">{entry.act}</span>
              <kbd className="flex-none font-sans text-label whitespace-pre text-muted tabular-nums">{entry.keys}</kbd>
            </div>
          ))}
        </SettingsGroup>
      ))}
    </SettingsPage>
  )
}
