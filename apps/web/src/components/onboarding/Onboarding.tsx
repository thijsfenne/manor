import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { DEFAULT_USER_PROFILE, type AgentConfig, type AgentDraft, type ProviderConnection, type UserProfile } from '@manor/contracts'
import { MODELS, PROVIDERS } from '@manor/client-runtime/runtimes'
import { cleanDraft, PERSONA_COLOR_OPTIONS } from '../../persona'
import { useRequest, type RequestEvents } from '../../useRequest'
import { Avatar } from '../Avatar'
import { Modal, ModalFooter } from '../Modal'
import { ProviderMark } from '../ProviderMark'
import { ProviderConnectionStatus } from '../settings/SystemPages'
import { Button } from '../ui/Button'
import { FormField, formInputClass } from '../ui/FormField'
import { Select } from '../ui/Select'
import { firstAgentDraft, usableProviders, withName, withProvider } from './firstAgent'

type Provider = ProviderConnection['provider']

const providerName = (provider: Provider): string => PROVIDERS.find((option) => option.value === provider)?.label ?? provider

/** What each provider runs on, in the user's words rather than a plan name that changes. */
const SUBSCRIPTION: Record<Provider, string> = {
  claude: 'Your Claude subscription',
  codex: 'Your ChatGPT subscription',
  grok: 'Your Grok subscription',
  cursor: 'Your Cursor subscription',
}

/** Shown first; the others wait behind "More agents" unless an agent could already run on them. */
const LEADING: readonly Provider[] = ['claude', 'codex']

export interface OnboardingProps {
  profile: UserProfile | null
  connections: readonly ProviderConnection[]
  agents: AgentConfig[]
  requestEvents: RequestEvents
  onSaveProfile: (profile: UserProfile) => boolean
  onCheckProviders: () => void
  onSignIn: (provider: Provider) => void
  onCancelSignIn: (provider: Provider) => void
  onInstall: (provider: Provider) => void
  onSaveAgent: (draft: AgentDraft, requestId: string) => boolean
}

/**
 * The first minutes in an empty workspace: a name, one provider that is signed in, and
 * one agent to talk to. One decision per screen. It shows while the house has no
 * agent, and saving the agent is what ends it; the workspace then opens that DM.
 */
export function Onboarding({ profile, connections, agents, requestEvents, onSaveProfile, onCheckProviders, onSignIn, onCancelSignIn, onInstall, onSaveAgent }: OnboardingProps) {
  const reduceMotion = useReducedMotion()
  const { start, pending } = useRequest(requestEvents)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [name, setName] = useState<string | null>(null)
  const [showMore, setShowMore] = useState(false)
  const [draft, setDraft] = useState<AgentDraft | null>(null)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A login can change outside Manor, so the rows are asked for again on the way in
  // and whenever the user comes back from the terminal or the browser they signed in with.
  useEffect(() => {
    onCheckProviders()
    const check = () => { onCheckProviders() }
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [onCheckProviders])

  // A name the house already knows is offered back; the placeholder default is not a name.
  const known = profile === null || profile.name === DEFAULT_USER_PROFILE.name ? '' : profile.name
  const typed = name ?? known
  const ready = usableProviders(connections)
  // The agent follows the providers until the user has edited it: a provider that
  // signs out while the card is open must not stay on the card.
  const agent = draft !== null && ready.includes(draft.driver as Provider)
    ? draft
    : ready[0] === undefined ? null : draft === null ? firstAgentDraft(agents, ready[0]) : withProvider(draft, ready[0])

  const saveName = () => {
    const trimmed = typed.trim()
    if (trimmed === '') return
    onSaveProfile({ ...(profile?.avatar === undefined ? {} : { avatar: profile.avatar }), name: trimmed })
    setStep(2)
  }

  const create = () => {
    if (agent === null || agent.name.trim() === '') return
    setError(null)
    const sent = start((requestId) => onSaveAgent(cleanDraft(agent), requestId), { onNotice: (notice) => setError(notice.text) })
    if (!sent) setError('Manor is not connected. Try again in a moment.')
  }

  const shown = connections.filter((row) => showMore || LEADING.includes(row.provider) || ready.includes(row.provider))
  const hidden = connections.filter((row) => !shown.includes(row))

  return (
    <main className="flex h-full flex-col bg-bg text-text">
      <div className="drag-region h-10 flex-none" />
      <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto px-5 pb-16">
        <motion.div
          key={step}
          className="flex w-full max-w-[460px] flex-col gap-6"
          initial={reduceMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
        >
          <div className="flex gap-1.5" role="img" aria-label={`Step ${step} of 3`}>
            {[1, 2, 3].map((dot) => (
              <span key={dot} className={`h-[3px] w-[22px] rounded-full ${dot <= step ? 'bg-text' : 'bg-line'}`} />
            ))}
          </div>

          {step === 1 ? (
            <form className="contents" onSubmit={(event) => { event.preventDefault(); saveName() }}>
              <Heading title="Welcome to Manor" text="A workspace of AI agents that runs on the subscriptions you already have. Three quick things and you are in." />
              <FormField label="What should your agents call you?">
                <input className={formInputClass} value={typed} onChange={(event) => setName(event.target.value)} placeholder="Your first name" autoFocus maxLength={80} />
              </FormField>
              <Footer>
                <span />
                <Button type="submit" variant="primary" disabled={typed.trim() === ''}>Continue</Button>
              </Footer>
            </form>
          ) : null}

          {step === 2 ? (
            <>
              <Heading title="Connect an agent" text="Manor uses the apps you sign in to yourself. One is enough to start." />
              {connections.length === 0 ? <p className="m-0 text-label text-dim">Asking this Mac…</p> : (
                <div className="flex flex-col gap-1">
                  <div className="divide-y divide-line rounded-xl border border-line bg-surface">
                    {shown.map((row) => (
                      <div key={row.provider} className="flex min-h-14 items-center gap-3 px-3.5 py-3">
                        <ProviderMark driver={row.provider} size={18} />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="text-[14px] font-medium">{providerName(row.provider)}</span>
                          <span className="text-label text-muted">{row.message ?? SUBSCRIPTION[row.provider]}</span>
                        </div>
                        <div className="flex flex-none items-center gap-2">
                          <ProviderConnectionStatus connection={row} onSignIn={onSignIn} onCancelSignIn={onCancelSignIn} onInstall={onInstall} />
                        </div>
                      </div>
                    ))}
                  </div>
                  {hidden.length === 0 ? null : (
                    <button type="button" className="cursor-pointer self-start border-0 bg-transparent px-0.5 py-2 text-label text-muted hover:text-text" onClick={() => setShowMore(true)}>
                      More agents ({hidden.map((row) => providerName(row.provider)).join(', ')})
                    </button>
                  )}
                </div>
              )}
              <Footer>
                <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
                <Button variant="primary" disabled={ready.length === 0} onClick={() => setStep(3)}>Continue</Button>
              </Footer>
            </>
          ) : null}

          {step === 3 ? (
            <form className="contents" onSubmit={(event) => { event.preventDefault(); create() }}>
              <Heading title="Create your first agent" text="Give it a name. Everything else is filled in and can change later." />
              {agent === null ? <p className="m-0 text-label text-muted">No provider is signed in any more. Go back and connect one.</p> : (
                <div className="flex flex-col gap-4">
                  <div className="flex items-center gap-3.5">
                    <Avatar name={agent.name} color={agent.color} size={44} />
                    <div className="grid min-w-0 flex-1 grid-cols-2 gap-3 @max-[420px]:grid-cols-1">
                      <FormField label="Name">
                        <input className={formInputClass} value={agent.name} onChange={(event) => setDraft(withName(agent, event.target.value))} placeholder="Name your agent" autoFocus maxLength={60} />
                      </FormField>
                      <FormField label="Role" optional>
                        <input className={formInputClass} value={agent.role ?? ''} onChange={(event) => setDraft({ ...agent, role: event.target.value })} placeholder="Assistant, researcher…" />
                      </FormField>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3.5 py-2.5">
                    <span className="flex min-w-0 items-center gap-2 text-label text-muted">
                      <ProviderMark driver={agent.driver} size={14} />
                      <span className="truncate">Runs on {providerName(agent.driver as Provider)}</span>
                    </span>
                    <Button size="compact" onClick={() => setEditing(true)}>More options</Button>
                  </div>
                </div>
              )}
              {error === null ? null : <p className="m-0 text-label text-danger" role="alert">{error}</p>}
              <Footer>
                <Button variant="ghost" onClick={() => setStep(2)}>Back</Button>
                <Button type="submit" variant="primary" disabled={agent === null || agent.name.trim() === '' || pending}>{pending ? 'Creating…' : 'Create agent'}</Button>
              </Footer>
            </form>
          ) : null}
        </motion.div>
      </div>
      {editing && agent !== null ? (
        <FirstAgentDialog initial={agent} providers={ready} onClose={() => setEditing(false)} onSave={(next) => { setDraft(next); setEditing(false) }} />
      ) : null}
    </main>
  )
}

const Heading = ({ title, text }: { title: string; text: string }) => (
  <div className="flex flex-col gap-1.5">
    <h1 className="m-0 text-[26px] font-semibold tracking-[-0.01em]">{title}</h1>
    <p className="m-0 text-[14px] text-muted">{text}</p>
  </div>
)

const Footer = ({ children }: { children: React.ReactNode }) => <div className="flex items-center justify-between gap-3">{children}</div>

/**
 * What the first agent is told and what it runs on, for the user who wants to look.
 * Tools, placement and memory keep their defaults here and live in Settings, where
 * the full agent form is.
 */
function FirstAgentDialog({ initial, providers, onClose, onSave }: {
  initial: AgentDraft
  providers: readonly Provider[]
  onClose: () => void
  onSave: (draft: AgentDraft) => void
}) {
  const [draft, setDraft] = useState(initial)
  const driver = draft.driver as Provider
  const usable = draft.character.trim() !== ''
  return (
    <Modal title="More options" subtitle="Filled in for you. Every field can change." onClose={onClose}>
      <div className="flex items-center gap-3.5">
        <Avatar name={draft.name} color={draft.color} size={44} />
        <div className="flex flex-wrap gap-2" role="group" aria-label="Agent colour">
          {PERSONA_COLOR_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-label={option.label}
              aria-pressed={option.value === draft.color}
              title={option.label}
              className={`size-[22px] cursor-pointer rounded-full border-2 ${option.value === draft.color ? 'border-text' : 'border-transparent'}`}
              style={{ backgroundColor: option.value }}
              onClick={() => setDraft({ ...draft, color: option.value })}
            />
          ))}
        </div>
      </div>
      <FormField label="Instructions">
        <textarea className={`${formInputClass} min-h-[110px] resize-y`} value={draft.character} onChange={(event) => setDraft({ ...draft, character: event.target.value })} />
      </FormField>
      <div className="grid grid-cols-2 gap-3 @max-[420px]:grid-cols-1">
        <FormField label="Provider" custom>
          <Select label="Provider" value={driver} options={providers.map((provider) => ({ value: provider, label: providerName(provider) }))} onChange={(next) => setDraft(withProvider(draft, next))} />
        </FormField>
        <FormField label="Model" custom>
          <Select label="Model" value={draft.model ?? ''} options={MODELS[driver]} onChange={(model) => setDraft({ ...draft, model })} placeholder="Choose…" />
        </FormField>
      </div>
      <p className="m-0 text-label text-dim">Tools, placement and memory are in Settings, under Agents.</p>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!usable} onClick={() => onSave(draft)}>Save</Button>
      </ModalFooter>
    </Modal>
  )
}
