import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_DELIVERED_FILE_BYTES } from '@manor/contracts'
import { FileDeliveryError, readDeliverable, readEvidenceImage } from '../src/fileDelivery.js'

describe('reading a file a persona delivers', () => {
  it('reads a finished file from scratch with its name, type and size', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'manor-home-'))
    const scratch = path.join(home, '.manor', 'scratch', 'chat_1')
    await mkdir(scratch, { recursive: true })
    await writeFile(path.join(scratch, 'report.xlsx'), 'PK-bytes')

    const { file, bytes } = await readDeliverable(path.join(scratch, 'report.xlsx'), 'Q3 cijfers', home)
    expect(file).toMatchObject({
      name: 'Q3 cijfers.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 8,
    })
    expect(file.id).toMatch(/^file_/)
    expect(Buffer.from(bytes).toString()).toBe('PK-bytes')
    expect((await readDeliverable(path.join(scratch, 'report.xlsx'), 'a/b.xlsx', home)).file.name).toBe('a-b.xlsx')
  })

  it('keeps a mockup viewport on HTML only, and leaves a visual answer without one', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'manor-home-'))
    const scratch = path.join(home, '.manor', 'scratch', 'chat_1')
    await mkdir(scratch, { recursive: true })
    await writeFile(path.join(scratch, 'mockup.html'), '<p>hi</p>')
    await writeFile(path.join(scratch, 'report.xlsx'), 'PK-bytes')

    expect((await readDeliverable(path.join(scratch, 'mockup.html'), undefined, home, 'phone')).file).toMatchObject({ mime: 'text/html', viewport: 'phone' })
    expect((await readDeliverable(path.join(scratch, 'mockup.html'), undefined, home, 'desktop')).file).toMatchObject({ viewport: 'desktop' })
    expect((await readDeliverable(path.join(scratch, 'mockup.html'), undefined, home)).file).not.toHaveProperty('viewport')
    expect((await readDeliverable(path.join(scratch, 'report.xlsx'), undefined, home, 'phone')).file).not.toHaveProperty('viewport')
  })

  it('refuses with a sentence the persona can pass on', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'manor-home-'))
    const refusal = (target: string) => readDeliverable(target, undefined, home).catch((error: unknown) => error)
    await mkdir(path.join(home, '.claude'), { recursive: true })
    await mkdir(path.join(home, 'work'), { recursive: true })
    await writeFile(path.join(home, '.claude', 'settings.json'), '{}')
    await writeFile(path.join(home, 'work', '.env'), 'KEY=1')
    await writeFile(path.join(home, 'work', 'empty.txt'), '')
    await writeFile(path.join(home, 'work', 'huge.pdf'), '')
    await truncate(path.join(home, 'work', 'huge.pdf'), MAX_DELIVERED_FILE_BYTES + 1)

    const cases: [string, RegExp][] = [
      ['report.pdf', /not an absolute path/],
      [path.join(home, 'work', 'missing.pdf'), /does not exist/],
      [path.join(home, 'work'), /is not a file/],
      [path.join(home, 'work', 'empty.txt'), /is empty/],
      [path.join(home, 'work', 'huge.pdf'), /the limit is 25\.0 MB/],
      [path.join(home, '.claude', 'settings.json'), /private or credentials folder/],
      [path.join(home, 'work', '.env'), /private or credentials folder/],
    ]
    for (const [target, message] of cases) {
      const error = await refusal(target)
      expect(error, target).toBeInstanceOf(FileDeliveryError)
      expect((error as Error).message, target).toMatch(message)
    }
  })

  it('keeps a provider folder private when it lives elsewhere behind a symlink', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'manor-home-'))
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'manor-codex-'))
    await writeFile(path.join(elsewhere, 'auth.json'), '{"token":1}')
    await symlink(elsewhere, path.join(home, '.codex'))
    await mkdir(path.join(home, '.manor', 'scratch'), { recursive: true })
    await symlink(path.join(elsewhere, 'auth.json'), path.join(home, '.manor', 'scratch', 'notes.json'))

    for (const target of [
      path.join(home, '.codex', 'auth.json'),
      path.join(elsewhere, 'auth.json'),
      path.join(home, '.manor', 'scratch', 'notes.json'),
    ]) {
      const error = await readDeliverable(target, undefined, home).catch((caught: unknown) => caught)
      expect((error as Error).message, target).toMatch(/private or credentials folder/)
    }
  })

  it('keeps a provider folder private when scratch itself points into it', async () => {
    // `.codex` in home, and Manor's own driver home, which also sits under `.manor`.
    for (const provider of ['.codex', path.join('.manor', 'codex-home')]) {
      const home = await mkdtemp(path.join(tmpdir(), 'manor-home-'))
      await mkdir(path.join(home, provider), { recursive: true })
      await mkdir(path.join(home, '.manor'), { recursive: true })
      await writeFile(path.join(home, provider, 'auth.json'), '{"token":1}')
      await symlink(path.join(home, provider), path.join(home, '.manor', 'scratch'))

      const error = await readDeliverable(path.join(home, '.manor', 'scratch', 'auth.json'), undefined, home)
        .catch((caught: unknown) => caught)
      expect((error as Error).message, provider).toMatch(/private or credentials folder/)
    }
  })

  it('refuses a named pipe instead of waiting on it', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'manor-home-'))
    const pipe = path.join(home, 'report.csv')
    execFileSync('mkfifo', [pipe])

    const error = await readDeliverable(pipe, undefined, home).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(FileDeliveryError)
    expect((error as Error).message).toMatch(/is not a file/)
  }, 2_000)
})

describe('reading a goal screenshot', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAC0lEQVR4nGNgwAUAABoAAbw84EEAAAAASUVORK5CYII=', 'base64')

  it("reads verify-manor evidence from the Session's own worktree, with its pixel size, and nothing else under Manor's state", async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'manor-home-'))
    const own = path.join(home, '.manor', 'worktrees', 'p', 'chat_1', 'Manor')
    const other = path.join(home, '.manor', 'worktrees', 'p', 'chat_2', 'Manor')
    const shot = (root: string) => path.join(root, '.cursor', 'skills', 'verify-manor', 'evidence', 'after.png')
    for (const root of [own, other]) {
      await mkdir(path.dirname(shot(root)), { recursive: true })
      await writeFile(shot(root), PNG)
    }
    await mkdir(path.join(home, '.codex'), { recursive: true })
    await writeFile(path.join(home, '.codex', 'auth.png'), PNG)
    await symlink(path.join(home, '.codex', 'auth.png'), path.join(own, 'linked.png'))

    expect(await readEvidenceImage(shot(own), [own], home)).toEqual({ name: 'after.png', bytes: PNG, width: 3, height: 2 })
    for (const [target, roots] of [[shot(other), [own]], [shot(own), []], [path.join(own, 'linked.png'), [own]]] as const) {
      const error = await readEvidenceImage(target, roots, home).catch((caught: unknown) => caught)
      expect((error as Error).message, target).toMatch(/private or credentials folder/)
    }
  })

  it("refuses another Session's screenshots when the mapped worktree has been swapped for a symlink to it", async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'manor-home-'))
    const own = path.join(home, '.manor', 'worktrees', 'p', 'chat_1', 'Manor')
    const other = path.join(home, '.manor', 'worktrees', 'p', 'chat_2', 'Manor')
    await mkdir(other, { recursive: true })
    await mkdir(path.dirname(own), { recursive: true })
    await writeFile(path.join(other, 'personal.png'), PNG)
    await symlink(other, own)

    for (const target of [path.join(other, 'personal.png'), path.join(own, 'personal.png')]) {
      const error = await readEvidenceImage(target, [own], home).catch((caught: unknown) => caught)
      expect((error as Error).message, target).toMatch(/private or credentials folder/)
    }
  })

  it('refuses a file whose bytes are not a whole PNG, JPEG or WebP header, whatever its name says', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'manor-home-'))
    await writeFile(path.join(home, 'screenshot.png'), 'not a picture')
    await writeFile(path.join(home, 'cut.png'), PNG.subarray(0, 4))

    for (const name of ['screenshot.png', 'cut.png']) {
      const error = await readEvidenceImage(path.join(home, name), [], home).catch((caught: unknown) => caught)
      expect(error, name).toBeInstanceOf(FileDeliveryError)
      expect((error as Error).message).toBe(`${name} is not a PNG, JPEG or WebP picture.`)
    }
  })
})
