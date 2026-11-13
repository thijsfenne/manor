import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { listStructuredProjectMemory } from '../src/structuredProjectFiles.js'
import { composeStructuredMemoryBundle } from '../src/structuredMemory.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'project-listing-'))
  roots.push(root)
  await mkdir(path.join(root, 'example-app'))
  return root
}

it('lists available evidence with the same project resolution as injection and refreshes edits', async () => {
  const root = await fixture()
  const index = path.join(root, 'example-app/MEMORY.md')
  const file = path.join(root, 'example-app/cloud.md')
  await writeFile(index, '- [Cloud hosting](cloud.md)\n- [Missing](missing.md)\n- [Personal](../MEMORY.md)\n- [Escape](escape.md)')
  await writeFile(file, 'Project evidence')
  await writeFile(path.join(root, 'MEMORY.md'), 'PERSONAL')
  await symlink(path.join(root, 'MEMORY.md'), path.join(root, 'example-app/escape.md'))
  const listing = await listStructuredProjectMemory(root, 'Example App')
  const injected = await composeStructuredMemoryBundle(root, 'Example App', 'cloud hosting')
  expect(listing.files.map(({ path: source }) => source)).toEqual([index, file])
  expect(listing.files[1]).toMatchObject({ kind: 'file', content: injected.sources[1]?.content, modifiedAt: expect.any(Number) })
  expect(listing.truncated).toBe(false)
  await writeFile(file, 'Updated evidence')
  expect((await listStructuredProjectMemory(root, 'Example App')).files[1]?.content).toBe('Updated evidence')
  await expect(listStructuredProjectMemory(root, 'Other project')).resolves.toEqual({ files: [], truncated: false })
  await expect(listStructuredProjectMemory(undefined, 'Example App')).resolves.toEqual({ files: [], truncated: false })
})

it('reports bounded output without returning partial file content', async () => {
  const root = await fixture()
  await writeFile(path.join(root, 'example-app/MEMORY.md'), '- [Large](large.md)')
  await writeFile(path.join(root, 'example-app/large.md'), 'x'.repeat(1_000_001))
  const listing = await listStructuredProjectMemory(root, 'Example App')
  expect(listing.files).toHaveLength(1)
  expect(listing.truncated).toBe(true)
})
