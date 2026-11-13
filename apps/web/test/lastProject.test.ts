import { describe, expect, it } from 'vitest'
import { lastCreatedProjectId } from '../src/lastProject'

const projects = [{ id: 'manor' }, { id: 'life' }]
const chat = (
  projectId: string | null,
  kind: 'project' | 'dm' | 'group' | 'run',
  createdAt: number,
) => ({ projectId, kind, createdAt })

describe('the project for a new chat', () => {
  it('uses the project of the newest created project thread', () => {
    expect(
      lastCreatedProjectId(
        [chat('life', 'project', 200), chat('manor', 'project', 100)],
        projects,
      ),
    ).toBe('life')
  })

  it('ignores newer DMs, groups and routine runs', () => {
    expect(
      lastCreatedProjectId(
        [
          chat('manor', 'project', 100),
          chat(null, 'dm', 200),
          chat(null, 'group', 300),
          chat('life', 'run', 400),
        ],
        projects,
      ),
    ).toBe('manor')
  })

  it('falls back to the first project when there is no valid project thread', () => {
    expect(lastCreatedProjectId([chat('gone', 'project', 500)], projects)).toBe('manor')
    expect(lastCreatedProjectId([], [])).toBeUndefined()
  })

  it('ignores an archived thread when choosing the room for new work', () => {
    expect(
      lastCreatedProjectId(
        [
          { ...chat('life', 'project', 200), archivedAt: 300 },
          { ...chat('manor', 'project', 100), archivedAt: null },
        ],
        projects,
      ),
    ).toBe('manor')
  })
})
