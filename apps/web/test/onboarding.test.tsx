import { DEFAULT_USER_PROFILE, type AgentDraft, type ProviderConnection } from '@manor/contracts'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { Onboarding, type OnboardingProps } from '../src/components/onboarding/Onboarding'
import { firstAgentDraft, firstAgentToCreate, usableProviders } from '../src/components/onboarding/firstAgent'

vi.mock('motion/react', () => ({
  motion: { div: ({ initial: _initial, animate: _animate, transition: _transition, ...rest }: Record<string, unknown>) => <div {...rest} /> },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReducedMotion: () => true,
}))
// The suite runs without a DOM; an EventTarget is all the focus listener needs.
vi.stubGlobal('window', new EventTarget())
vi.mock('../src/components/Avatar', () => ({ Avatar: ({ name }: { name: string }) => <span>{name}</span> }))

const row = (provider: ProviderConnection['provider'], state: ProviderConnection['state']): ProviderConnection =>
  ({ provider, installed: state !== 'install', version: '1.0.0', signedIn: state === 'ready' ? true : state === 'attention' ? null : false, state, canSignIn: state !== 'install', canInstall: false })

describe('the first agent', () => {
  it('runs on the first provider that is ready, takes every unaddressed message, and has no name yet', () => {
    const connections = [row('claude', 'sign_in'), row('cursor', 'ready'), row('codex', 'ready')]
    expect(usableProviders(connections)).toEqual(['codex', 'cursor'])
    // Installed but silent about its login still counts, behind the ones that are signed in.
    expect(usableProviders([row('claude', 'attention'), row('grok', 'ready'), row('codex', 'install')])).toEqual(['grok', 'claude'])
    expect(firstAgentDraft([], 'codex')).toMatchObject({ name: '', role: '', driver: 'codex', isCos: true, memoryScope: true })
  })

  it('starts with instructions from its name, and a blank job routes as the catch-all', () => {
    const created = firstAgentToCreate({ ...firstAgentDraft([], 'claude'), name: ' Iris ' })
    expect(created).toMatchObject({ name: 'Iris', description: 'Takes anything not addressed to someone specific.' })
    expect(created.character).toContain('You are Iris')
    expect(created.character).toContain('Every message that is not addressed to someone else comes to you.')
    expect(created.character).not.toContain('Takes anything')
  })
})

describe('onboarding', () => {
  const props = (over: Partial<OnboardingProps> = {}): OnboardingProps => ({
    profile: DEFAULT_USER_PROFILE,
    connections: [row('claude', 'install'), row('codex', 'sign_in')],
    agents: [],
    requestEvents: { subscribe: () => () => undefined },
    onSaveProfile: vi.fn(() => true),
    onCheckProviders: vi.fn(() => true),
    onInstall: vi.fn(),
    onSignIn: vi.fn(),
    onCancelSignIn: vi.fn(),
    onSaveAgent: vi.fn(() => true),
    ...over,
  })
  const button = (page: ReactTestRenderer, label: string) => {
    const found = page.root.findAllByType('button').find((node) => node.children.join('') === label)
    if (found === undefined) throw new Error(`no button "${label}"`)
    return found
  }

  it('asks for a name, waits for one provider, and creates the agent the user named', async () => {
    const first = props()
    let page!: ReactTestRenderer
    await act(async () => { page = create(<Onboarding {...first} />) })
    expect(first.onCheckProviders).toHaveBeenCalledTimes(1)

    // The placeholder profile is not a name, so the field starts empty and Continue waits.
    const field = page.root.findByType('input')
    expect(field.props.value).toBe('')
    expect(button(page, 'Continue').props.disabled).toBe(true)
    act(() => field.props.onChange({ target: { value: ' Robin ' } }))
    act(() => page.root.findByType('form').props.onSubmit({ preventDefault: () => undefined }))
    expect(first.onSaveProfile).toHaveBeenCalledWith({ name: 'Robin' })

    // Nothing is signed in yet: the row offers Sign in and the step holds.
    expect(button(page, 'Continue').props.disabled).toBe(true)
    act(() => button(page, 'Sign in').props.onClick())
    expect(first.onSignIn).toHaveBeenCalledWith('codex')

    const signedIn = props({ ...first, connections: [row('claude', 'install'), row('codex', 'ready')] })
    await act(async () => { page.update(<Onboarding {...signedIn} />) })
    act(() => button(page, 'Continue').props.onClick())

    // The agent's name is the user's to invent: nothing is created until there is one.
    const submit = () => page.root.findByType('form').props.onSubmit({ preventDefault: () => undefined })
    expect(button(page, 'Create agent').props.disabled).toBe(true)
    act(() => submit())
    expect(first.onSaveAgent).not.toHaveBeenCalled()
    // Four things only: a face, a name, a job and a model. No Role field any more.
    const nameField = page.root.findAllByType('input').find((node) => node.props.type !== 'color')
    expect(nameField?.props.value).toBe('')
    act(() => nameField?.props.onChange({ target: { value: 'Iris' } }))
    act(() => page.root.findByType('textarea').props.onChange({ target: { value: 'Research and reading lists.' } }))
    act(() => submit())
    const [draft] = (first.onSaveAgent as ReturnType<typeof vi.fn>).mock.calls[0] as [AgentDraft, string]
    expect(draft).toMatchObject({ name: 'Iris', role: '', description: 'Research and reading lists.', driver: 'codex', isCos: true, memoryScope: true })
    expect(draft.character).toContain('You are Iris')
    expect(draft.character).toContain('Research and reading lists.')
    // Saving ends the onboarding; leaving must not trip over what the check action returned.
    expect(() => act(() => page.unmount())).not.toThrow()
  })

  it('lets the user continue on a provider that did not say whether it is signed in', async () => {
    // Grok has no sign-in Manor can start, so its row has no button: without this the step has no way out.
    const silent = props({ profile: { name: 'Robin' }, connections: [row('claude', 'install'), { ...row('grok', 'attention'), canSignIn: false }] })
    let page!: ReactTestRenderer
    await act(async () => { page = create(<Onboarding {...silent} />) })
    act(() => page.root.findByType('form').props.onSubmit({ preventDefault: () => undefined }))
    expect(button(page, 'Continue').props.disabled).toBe(false)
    act(() => button(page, 'Continue').props.onClick())
    act(() => page.root.findAllByType('input').find((node) => node.props.type !== 'color')?.props.onChange({ target: { value: 'Iris' } }))
    act(() => page.root.findByType('form').props.onSubmit({ preventDefault: () => undefined }))
    const [draft] = (silent.onSaveAgent as ReturnType<typeof vi.fn>).mock.calls[0] as [AgentDraft, string]
    expect(draft.driver).toBe('grok')
  })

  it('asks for the rows again when the window comes back to the front', async () => {
    const first = props()
    let page!: ReactTestRenderer
    await act(async () => { page = create(<Onboarding {...first} />) })
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(first.onCheckProviders).toHaveBeenCalledTimes(2)
    act(() => page.unmount())
    window.dispatchEvent(new Event('focus'))
    expect(first.onCheckProviders).toHaveBeenCalledTimes(2)
  })

  it('offers back a name the house already knows', async () => {
    let page!: ReactTestRenderer
    await act(async () => { page = create(<Onboarding {...props({ profile: { name: 'Robin' } })} />) })
    expect(page.root.findByType('input').props.value).toBe('Robin')
    expect(button(page, 'Continue').props.disabled).toBe(false)
  })
})
