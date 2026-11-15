import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  CheckoutRow,
  checkoutView,
  pickBranch,
  type CheckoutStatus,
} from '../src/components/CheckoutRow'
import { MenuRow } from '../src/components/RuntimeMenu'

const status = (partial: Partial<CheckoutStatus>): CheckoutStatus => ({
  type: 'checkout_status',
  chatId: 'chat',
  mode: 'current',
  branch: 'main',
  dirty: false,
  gitRoots: ['/Users/sam/Manor'],
  branches: [],
  ...partial,
})

describe('what the row reads', () => {
  it('names the shared checkout and still offers its branch as a picker', () => {
    const planned = checkoutView({ mode: 'current', branch: 'main' }, null, true)
    const live = checkoutView({ mode: 'current', branch: 'main' }, null, false)

    expect(planned.label).toBe('Current checkout')
    expect(live.label).toBe('Local checkout')
    expect(planned.branch).toBe('main')
    expect(planned.modeEditable).toBe(true)
    // New chat: picking a different name isolates. A live chat does not switch maps.
    expect(planned.branchEditable).toBe(true)
    expect(live.modeEditable).toBe(false)
    expect(live.branchEditable).toBe(false)
  })

  it('names the branch a leftover still holds on the option that would resume it', () => {
    const view = checkoutView(
      { mode: 'current', branch: 'main' },
      status({ leftover: { branch: 'manor/ab12cd34', dirty: false } }),
      false,
    )

    expect(view.worktreeOption).toBe('New worktree, manor/ab12cd34')
  })

  it('keeps a null live branch, rather than filling it from the stored mapping', () => {
    const view = checkoutView(
      { mode: 'worktree', branch: 'manor/ab12cd34' },
      status({ mode: 'worktree', branch: null }),
      false,
    )

    expect(view.branch).toBeNull()
  })

  it('drops a status from before the switch whole, rather than merging half of it', () => {
    // The directory lands first and the fresh status a round trip later. Merging the
    // two would pair the new mode with the old branch for a frame, which is the one
    // thing this row may never do.
    const view = checkoutView(
      { mode: 'worktree', branch: 'manor/ab12cd34' },
      status({ mode: 'current', branch: 'main', leftover: { branch: 'old', dirty: true } }),
      false,
    )

    expect(view.branch).toBe('manor/ab12cd34')
  })

  it('offers a branch list only where a name cannot simply be typed', () => {
    const branches = [
      { name: 'main', available: false, reason: 'already checked out in Manor' },
      { name: 'manor/ab12cd34', available: true },
    ]
    const isolated = checkoutView(
      { mode: 'worktree', branch: 'manor/ab12cd34' },
      status({ mode: 'worktree', branch: 'manor/ab12cd34', branches }),
      false,
    )
    // A live worktree can only be switched onto a branch that already exists, so the
    // list is the whole truth there. The new-chat stage may name anything.
    expect(isolated.branchRows).toEqual(branches)
    expect(checkoutView({ mode: 'worktree', branch: null }, null, true).branchRows).toBeNull()
    expect(checkoutView({ mode: 'current', branch: 'main' }, status({ branches }), true).branchRows).toEqual(
      branches,
    )
    // Live current checkout still receives the list, but the chip is a label so it
    // is never opened. Isolation is chosen on the new-chat stage, not mid-session.
    expect(checkoutView({ mode: 'current', branch: 'main' }, status({ branches }), false).branchRows).toEqual(
      branches,
    )
  })

  it('falls back to the typed field rather than an empty menu', () => {
    // An older server sends no list at all. A menu with no rows is a dead end; the
    // field still works, and the server refuses a name it cannot honour.
    const view = checkoutView(
      { mode: 'worktree', branch: 'manor/ab12cd34' },
      status({ mode: 'worktree', branch: 'manor/ab12cd34', branches: [] }),
      false,
    )

    expect(view.branchRows).toBeNull()
  })

  it('reads as intent on the new-chat stage, where nothing is on disk to discard', () => {
    const view = checkoutView({ mode: 'worktree', branch: null }, null, true)
    const live = checkoutView({ mode: 'worktree', branch: 'manor/ab12cd34' }, null, false)

    expect(live.label).toBe('manor/ab12cd34')
    expect(view.label).toBe('New worktree')
    expect(view.worktreeOption).toBe('New worktree')
    expect(view.branch).toBeNull()
  })
})

describe('the row on screen', () => {
  const render = (props: Partial<Parameters<typeof CheckoutRow>[0]>) =>
    renderToStaticMarkup(
      <CheckoutRow
        base={{ mode: 'current', branch: 'main' }}
        status={null}
        planned={false}
        disabled={false}
        onChoose={() => {}}
        {...props}
      />,
    )

  it('gives current checkout a branch menu, not a dim label', () => {
    const html = render({
      planned: true,
      status: status({
        branches: [
          { name: 'main', available: false, reason: 'already checked out in Manor' },
          { name: 'topic', available: true },
        ],
      }),
    })

    expect(html).toContain('Current checkout')
    expect(html).toContain('bg-composer-tray')
    expect(html).toContain('main')
    expect(html.match(/aria-haspopup/g)).toHaveLength(2)
  })

  it('locks a live current checkout so a pick cannot isolate mid-session', () => {
    const html = render({
      status: status({
        branches: [
          { name: 'main', available: false, reason: 'already checked out in Manor' },
          { name: 'topic', available: true },
        ],
      }),
    })

    expect(html).toContain('Local checkout')
    expect(html).toContain('main')
    expect(html.match(/aria-haspopup/g)).toBeNull()
  })

  it('gives an isolated chat its branch as the second half of the sentence', () => {
    const html = render({
      base: { mode: 'worktree', branch: 'manor/ab12cd34' },
      status: status({ mode: 'worktree', branch: 'manor/ab12cd34' }),
    })

    // Live isolation is the worktree's name, not the word "worktree".
    expect(html).not.toContain('Local worktree')
    expect(html).not.toContain('New worktree')
    expect(html).toContain('manor/ab12cd34')
    expect(html).not.toContain('Discard')
    expect(html.match(/aria-haspopup/g)).toHaveLength(1)
  })

  it('says the worktrees do not share a branch when status has none', () => {
    const html = render({
      base: { mode: 'worktree', branch: 'manor/ab12cd34' },
      status: status({ mode: 'worktree', branch: null }),
    })

    expect(html).toContain('No shared branch')
    expect(html).not.toContain('manor/ab12cd34')
  })

  it('says what the branch will be called before there is a worktree to name', () => {
    const html = render({ base: { mode: 'worktree', branch: null }, planned: true })

    expect(html).toContain('New worktree')
    expect(html).toContain('New branch')
  })
})

describe('picking a branch', () => {
  it('returns to current checkout when the name is the linked folders’ own', () => {
    const home = { name: 'main', available: false, home: true, reason: 'already checked out in Manor' }
    const topic = { name: 'topic', available: true }
    const occupied = { name: 'other', available: false, reason: 'already checked out in another-app' }

    expect(pickBranch(home, { mode: 'worktree', branch: 'topic' })).toEqual({ mode: 'current' })
    expect(pickBranch(home, { mode: 'current', branch: 'main' })).toBe('stay')
    expect(pickBranch(topic, { mode: 'current', branch: 'main' })).toEqual({ mode: 'worktree', branch: 'topic' })
    expect(pickBranch(occupied, { mode: 'worktree', branch: 'topic' })).toBe('blocked')
    // A live chat does not change maps. `home` stays grey, a pick that would isolate
    // is blocked, and a pick inside an existing worktree still switches the branch.
    expect(pickBranch(home, { mode: 'worktree', branch: 'topic' }, true)).toBe('blocked')
    expect(pickBranch(topic, { mode: 'current', branch: 'main' }, true)).toBe('blocked')
    expect(pickBranch(topic, { mode: 'worktree', branch: 'other' }, true)).toEqual({
      mode: 'worktree',
      branch: 'topic',
    })
  })
})

describe('a branch the menu may not offer', () => {
  it('is greyed with the reason next to it, rather than silently dropped', () => {
    // The branch list is inside a menu that opens on a press, so this is where the
    // greyed state can be read: same row component, one prop for why it is off.
    const html = renderToStaticMarkup(
      <MenuRow
        label="main"
        selected={false}
        isDefault={false}
        unavailable="already checked out in Manor"
        onSelect={() => {}}
      />,
    )

    expect(html).toContain('main')
    expect(html).toContain('already checked out in Manor')
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('title="already checked out in Manor"')
  })
})
