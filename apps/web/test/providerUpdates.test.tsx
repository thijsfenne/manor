import type { ProviderUpdate } from '@manor/contracts'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { useProviderUpdates } from '../src/components/ProviderUpdates'

type Notice = ReturnType<typeof useProviderUpdates>

const claude = (state: ProviderUpdate['state'], extra: Partial<ProviderUpdate> = {}): ProviderUpdate => ({
  provider: 'claude',
  currentVersion: '2.3.0',
  latestVersion: '2.4.0',
  canUpdate: true,
  state,
  ...extra,
})

function mount(initial: ProviderUpdate[]) {
  let seen: Notice | undefined
  function Probe({ updates }: { updates: ProviderUpdate[] }) {
    seen = useProviderUpdates(updates)
    return null
  }
  let renderer!: ReturnType<typeof create>
  act(() => { renderer = create(<Probe updates={initial} />) })
  return {
    get: () => seen!,
    send: (updates: ProviderUpdate[]) => act(() => renderer.update(<Probe updates={updates} />)),
  }
}

describe('provider update notice', () => {
  it('moves a dismissed release to the rail and keeps it there', () => {
    const view = mount([claude('available')])
    expect(view.get().toast).toMatchObject({ kind: 'available' })
    expect(view.get().railEntries).toEqual([])

    act(() => view.get().dismissToast())
    expect(view.get().toast).toBeNull()
    expect(view.get().railEntries).toHaveLength(1)

    // A newer release is a new question.
    view.send([claude('available', { latestVersion: '2.5.0' })])
    expect(view.get().toast).toMatchObject({ kind: 'available' })
  })

  it('keeps a dismissed release in the rail when another provider brings the card back', () => {
    const view = mount([claude('available')])
    act(() => view.get().dismissToast())
    const grok: ProviderUpdate = { provider: 'grok', currentVersion: '1.0.41', latestVersion: '1.0.42', canUpdate: true, state: 'available' }
    view.send([claude('available'), grok])
    expect(view.get().toast).toMatchObject({ kind: 'available', entries: [grok] })
    expect(view.get().railEntries.map((update) => update.provider)).toEqual(['claude'])
  })

  it('turns the progress pill into a check naming what this run updated', () => {
    const view = mount([claude('available')])
    view.send([claude('updating')])
    expect(view.get().toast).toEqual({ kind: 'progress', label: 'Updating Claude Code…' })

    view.send([claude('updated')])
    expect(view.get().toast).toEqual({ kind: 'done', label: 'Claude Code updated' })
    expect(view.get().railEntries).toEqual([])
  })

  it('says installing for a runtime Manor had none of', () => {
    const codex: ProviderUpdate = { provider: 'codex', currentVersion: '', latestVersion: '0.164.0', canUpdate: true, state: 'updating' }
    const view = mount([codex])
    expect(view.get().toast).toEqual({ kind: 'progress', label: 'Installing Codex…' })
    view.send([{ ...codex, currentVersion: '0.164.0', state: 'updated' }])
    expect(view.get().toast).toEqual({ kind: 'done', label: 'Codex installed' })
  })

  it('shows a failure instead of a check, and a retry forgets its dismissal', () => {
    const view = mount([claude('updating')])
    view.send([claude('failed', { error: 'npm exited 1' })])
    expect(view.get().toast).toMatchObject({ kind: 'failed' })

    act(() => view.get().dismissToast())
    expect(view.get().toast).toBeNull()
    expect(view.get().railEntries).toHaveLength(1)

    view.send([claude('updating')])
    view.send([claude('failed', { error: 'npm exited 1' })])
    expect(view.get().toast).toMatchObject({ kind: 'failed' })
  })
})
