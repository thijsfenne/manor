import { useRef, useState, type FormEvent } from 'react'
import { LinkSquare02Icon } from '@hugeicons/core-free-icons'
import type { ComposioKeySource } from '@manor/contracts'
import { Icon } from '../Icon'
import { Modal, ModalFooter } from '../Modal'
import { Button, buttonClass } from '../ui/Button'
import { SIDE_SURFACE } from '../ui/dockPanel'
import { AppLogo } from './ComposioApps'

/** The API keys page of the open Composio project, where Composio's quickstart sends you. */
export const COMPOSIO_KEYS_URL = 'https://dashboard.composio.dev/~/project/settings/api-keys'

/** Well-known marks that make the promise concrete; every one is a Composio toolkit slug. */
export const SETUP_APPS: readonly { slug: string; name: string }[] = [
  { slug: 'gmail', name: 'Gmail' },
  { slug: 'googlecalendar', name: 'Google Calendar' },
  { slug: 'slack', name: 'Slack' },
  { slug: 'notion', name: 'Notion' },
  { slug: 'linear', name: 'Linear' },
  { slug: 'github', name: 'GitHub' },
  { slug: 'googledrive', name: 'Google Drive' },
  { slug: 'hubspot', name: 'HubSpot' },
]

/**
 * The Connectors page's lead while the host has no Composio key: Composio is the way
 * in to every app an agent can use, so the setup is the main thing on the page. It
 * wears the secret request card's surface, with the fields on the stage. The key goes
 * to the server once; it is checked with Composio there and never comes back.
 */
export function ComposioKeySetup({ live, pending, error, onSave }: {
  live: boolean
  pending: boolean
  error: string | null
  onSave: (key: string) => void
}) {
  const [value, setValue] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (value.trim() === '' || pending || !live) return
    onSave(value)
    input.current?.focus()
  }
  return (
    <section
      aria-labelledby="composio-setup-title"
      className={`@container mt-7 flex flex-col gap-6 rounded-2xl px-6 py-6 max-[640px]:px-4 max-[640px]:py-5 ${SIDE_SURFACE}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="flex max-w-[480px] min-w-[min(100%,280px)] flex-1 flex-col gap-1.5">
          <h2 id="composio-setup-title" className="m-0 text-[20px] leading-tight font-medium tracking-[-0.01em] text-text">
            Connect your apps
          </h2>
          <p className="m-0 text-[14px] leading-relaxed text-muted">
            Composio links Gmail, Calendar, Slack, Notion, Linear, GitHub and hundreds of other apps to your agents.
            Manor needs a Composio API key to do that, and creating one is free.
          </p>
        </div>
        {/* The tiles take the stage, so they read as wells in the card. */}
        <div aria-hidden="true" className="flex flex-wrap gap-2 [--color-surface:var(--color-stage)]">
          {SETUP_APPS.map((app) => <AppLogo key={app.slug} slug={app.slug} name={app.name} />)}
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-6 @max-[620px]:grid-cols-1 @max-[620px]:gap-5">
        <div className="flex min-w-0 flex-col gap-2.5">
          <StepTitle step={1}>Get a key</StepTitle>
          <div className="flex flex-col items-start gap-2 pl-8">
            <a
              href={COMPOSIO_KEYS_URL}
              target="_blank"
              rel="noreferrer noopener"
              className={`inline-flex items-center gap-2 no-underline ${buttonClass('secondary')}`}
            >
              Open Composio
              <Icon icon={LinkSquare02Icon} size={14} />
            </a>
            <span className="text-label text-dim">Sign in and copy your project’s API key.</span>
          </div>
        </div>

        <form className="flex min-w-0 flex-col gap-2.5" autoComplete="off" aria-label="Composio API key" onSubmit={submit}>
          <label htmlFor="composio-key-input" className="contents">
            <StepTitle step={2}>Paste it here</StepTitle>
          </label>
          <div className="flex flex-col gap-2 pl-8">
            <div className="flex items-center gap-2 @max-[360px]:flex-col @max-[360px]:items-stretch">
              <input
                ref={input}
                id="composio-key-input"
                type="password"
                value={value}
                placeholder="ak_..."
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                aria-invalid={error === null ? undefined : true}
                onChange={(event) => setValue(event.target.value)}
                className="h-9 w-full min-w-0 flex-1 rounded-lg border border-line bg-field px-2.5 text-[14px] text-text outline-none placeholder:text-dim focus:border-field-focus"
              />
              <Button type="submit" variant="primary" className="flex-none" disabled={!live || pending || value.trim() === ''}>
                {pending ? 'Checking…' : 'Save'}
              </Button>
            </div>
            {error === null ? null : <p className="m-0 text-label text-danger" role="status">{error}</p>}
            {live ? null : <span className="text-label text-dim">Reconnecting</span>}
          </div>
        </form>
      </div>

      <p className="m-0 text-label text-dim">
        The key is stored in Manor’s data folder on this Mac and is only ever sent to Composio.
      </p>
    </section>
  )
}

/** A numbered step: the round mark keeps both steps' titles on one line of sight. */
function StepTitle({ step, children }: { step: number; children: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <span aria-hidden="true" className="grid size-[22px] flex-none place-items-center rounded-full bg-stage text-label text-muted">
        {step}
      </span>
      <span className="text-[16px] font-medium text-text">
        <span className="sr-only">{step}. </span>
        {children}
      </span>
    </span>
  )
}

const SOURCE_TEXT: Record<Exclude<ComposioKeySource, 'none'>, string> = {
  manor: 'The Composio key is saved in Manor’s data folder.',
  environment: 'The Composio key is set outside Manor, in the environment Manor starts with. Change it there.',
  checkout: 'The Composio key is set outside Manor, in apps/server/.env. Change it there.',
}

/**
 * Where the key lives, under the catalogue; only Manor's own key has a way out here.
 * `notice` is the answer to a save that kept the key but could not start Composio.
 */
export function ComposioKeyNote({ source, notice, onRemove }: {
  source: Exclude<ComposioKeySource, 'none'>
  notice: string | null
  onRemove: () => void
}) {
  return (
    <div className="mt-6 flex flex-col gap-2 px-2">
      <div className="flex items-center gap-3">
        <span className="min-w-0 text-label text-dim">{SOURCE_TEXT[source]}</span>
        {source === 'manor' ? (
          <Button variant="ghost" size="compact" className="flex-none" onClick={onRemove}>Remove key</Button>
        ) : null}
      </div>
      {notice === null ? null : <p className="m-0 text-label text-danger" role="status">{notice}</p>}
    </div>
  )
}

/** Removing the key turns Composio off for every agent, so it is asked once. */
export function RemoveComposioKeyDialog({ pending, error, onConfirm, onClose }: {
  pending: boolean
  error: string | null
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal title="Remove the Composio key?" onClose={onClose}>
      <p className="m-0 text-[14px] leading-relaxed text-muted">
        Manor forgets the key and every agent loses its Composio apps until you enter a key again.
        Chats that are running keep access until they finish.
        Your connected apps stay in your Composio project; nothing is disconnected there.
      </p>
      {error === null ? null : <p className="m-0 text-label text-danger" role="status">{error}</p>}
      <ModalFooter>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={pending} onClick={onConfirm}>{pending ? 'Removing…' : 'Remove key'}</Button>
        </div>
      </ModalFooter>
    </Modal>
  )
}
