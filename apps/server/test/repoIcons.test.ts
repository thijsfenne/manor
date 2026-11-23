import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest, createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import { deflateSync } from 'node:zlib'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project } from '@manor/contracts'
import { REPO_ICON_PREFIX, createRepoIconMedia, findRepoIcon, isRepoIconPath } from '../src/repoIcons.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { createSqliteStore } from '../src/stores/sqliteStore.js'

const chunk = (type: string, body: Buffer) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  return Buffer.concat([length, Buffer.from(type, 'latin1'), body, Buffer.alloc(4)])
}
/**
 * A PNG of the given size whose first row starts with one white pixel: RGB without
 * `corner`, else RGBA with that alpha, so 0 is an icon without a background.
 */
const png = (side: number, corner?: number) => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(side, 0)
  header.writeUInt32BE(side, 4)
  header[8] = 8
  header[9] = corner === undefined ? 2 : 6
  const pixel = corner === undefined ? [255, 255, 255] : [255, 255, 255, corner]
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([1, ...pixel]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 32, 32])
const SVG = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'

let roots: string[] = []
const folder = (files: Record<string, string | Buffer>) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'manor-repoicon-'))
  roots.push(root)
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    writeFileSync(path.join(root, name), content)
  }
  return root
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

describe('findRepoIcon', () => {
  it('prefers an icon without a background, then an SVG, the largest PNG and an ICO', async () => {
    const all = folder({ 'public/favicon.ico': ICO, 'assets/favicon.png': png(48, 0), 'assets/icon.png': png(1024), 'public/favicons/favicon.svg': SVG })
    expect(await findRepoIcon([all])).toEqual({ folder: all, path: 'public/favicons/favicon.svg' })

    const bare = folder({ 'public/favicon.ico': ICO, 'assets/favicon.png': png(48, 0), 'favicon-32.png': png(32, 0), 'assets/icon.png': png(1024) })
    expect(await findRepoIcon([bare])).toEqual({ folder: bare, path: 'assets/favicon.png' })

    const ico = folder({ 'public/favicon.ico': ICO, 'assets/icon.png': png(1024) })
    expect(await findRepoIcon([ico])).toEqual({ folder: ico, path: 'public/favicon.ico' })

    // Only pictures that fill their square, an alpha channel with a solid corner among them.
    const solid = folder({ 'assets/favicon.png': png(48), 'assets/icon.png': png(1024, 255), 'apple-touch-icon.png': png(180) })
    expect(await findRepoIcon([solid])).toEqual({ folder: solid, path: 'assets/icon.png', opaque: true })
  })

  it('reads only the start of a PNG stream for its corner', async () => {
    // The corner sits in the first KiB; a stream broken after it fails only a full inflate.
    const stream = deflateSync(Buffer.concat([Buffer.from([1, 255, 255, 255, 0]), randomBytes(8192)]))
    stream.fill(0xff, 2048)
    const header = png(64, 0).subarray(0, 33)
    const bare = Buffer.concat([header, chunk('IDAT', stream), chunk('IEND', Buffer.alloc(0))])
    const root = folder({ 'favicon.png': bare, 'icon.png': png(1024) })
    expect(await findRepoIcon([root])).toEqual({ folder: root, path: 'favicon.png' })
  })

  it('takes the first linked folder that holds an icon', async () => {
    const none = folder({ 'README.md': '# notes' })
    const second = folder({ 'favicon.ico': ICO })
    const third = folder({ 'icon.svg': SVG })
    expect(await findRepoIcon([none, second, third])).toEqual({ folder: second, path: 'favicon.ico' })
  })

  it('finds nothing in build output, dependencies, dot-folders or files that only carry the name', async () => {
    const root = folder({
      'node_modules/pkg/favicon.svg': SVG,
      'dist/favicon.svg': SVG,
      '.next/favicon.svg': SVG,
      'public/favicon.png': 'not a picture',
      'logo.svg': SVG,
    })
    expect(await findRepoIcon([root])).toBeUndefined()
    expect(await findRepoIcon([])).toBeUndefined()
  })

  it('looks inside a monorepo\'s packages only when its root has no icon', async () => {
    const mono = folder({
      'apps/web/public/icons/apple-touch-icon.png': png(180),
      'apps/desktop/assets/icon.png': png(1024),
      'apps/mobile/assets/images/icon.png': png(1024, 0),
      'apps/web/node_modules/pkg/favicon.svg': SVG,
      'apps/.cache/favicon.svg': SVG,
      'node_modules/pkg/apps/x/favicon.svg': SVG,
    })
    expect(await findRepoIcon([mono])).toEqual({ folder: mono, path: 'apps/mobile/assets/images/icon.png' })
    const solid = folder({ 'packages/ui/static/favicon.ico': ICO, 'apps/web/public/icon.png': png(512) })
    expect(await findRepoIcon([solid])).toEqual({ folder: solid, path: 'packages/ui/static/favicon.ico' })
    const rooted = folder({ 'public/icon.png': png(64), 'apps/web/public/favicon.svg': SVG })
    expect(await findRepoIcon([rooted])).toEqual({ folder: rooted, path: 'public/icon.png', opaque: true })
  })

  it('accepts only the known icon places as a path', () => {
    expect(isRepoIconPath('favicon.svg')).toBe(true)
    expect(isRepoIconPath('public/favicons/apple-touch-icon-180x180.png')).toBe(true)
    expect(isRepoIconPath('src/app/icon.png')).toBe(true)
    expect(isRepoIconPath('apps/web/public/icons/apple-touch-icon.png')).toBe(true)
    expect(isRepoIconPath('packages/ui/favicon.svg')).toBe(true)
    expect(isRepoIconPath('apps/My App/favicon.svg')).toBe(true)
    for (const bad of ['../favicon.svg', 'public/../favicon.svg', 'node_modules/favicon.svg', '.env', 'public/.env', 'README.md', '/favicon.svg', 'icon.ico',
      'apps/favicon.svg', 'apps/../favicon.svg', 'apps/.git/favicon.svg', 'apps/node_modules/favicon.svg', 'apps/Node_Modules/favicon.svg', `apps/${'x'.repeat(500)}/favicon.svg`, 'apps/web/node_modules/favicon.svg', 'apps/web/apps/ui/favicon.svg', 'lib/web/favicon.svg']) {
      expect(isRepoIconPath(bad), bad).toBe(false)
    }
  })
})

describe('repo icon serving', () => {
  let server: Server
  let port: number
  let projects: Map<string, Project>
  const media = () => createRepoIconMedia({ getProject: async (id) => projects.get(id), key: Buffer.alloc(32, 3) })
  const project = (id: string, repoPaths: string[], repoIcon?: Project['repoIcon']): Project =>
    ({ id, name: id, icon: 'code', color: '#8A8F98', memoryScope: 'project', repoPaths, ...(repoIcon === undefined ? {} : { repoIcon }) })

  beforeEach(async () => {
    projects = new Map()
    const served = media()
    server = createServer((request, response) => {
      if (!served.handle(request, response)) {
        response.writeHead(418)
        response.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const get = (rawPath: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: rawPath, headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      })
      req.on('error', reject)
      req.end()
    })

  it('serves the linked icon as a sandboxed image that revalidates', async () => {
    const root = folder({ 'public/favicon.svg': SVG })
    projects.set('p1', project('p1', [root]))
    const link = media().src('p1', { folder: root, path: 'public/favicon.svg' })
    expect(link.startsWith(REPO_ICON_PREFIX)).toBe(true)

    const first = await get(link)
    expect(first.status).toBe(200)
    expect(first.headers['content-type']).toBe('image/svg+xml')
    expect(first.headers['content-security-policy']).toContain('sandbox')
    expect(first.headers['cache-control']).toBe('private, no-cache')
    expect(first.body.toString()).toBe(SVG)
    expect((await get(link, { 'if-none-match': String(first.headers.etag) })).status).toBe(304)
  })

  it('marks the link of an icon that fills its square, so clients round its corners', async () => {
    const root = folder({ 'assets/icon.png': png(64) })
    projects.set('p1', project('p1', [root]))
    const link = media().src('p1', { folder: root, path: 'assets/icon.png', opaque: true })
    expect(link.endsWith('?tile')).toBe(true)
    expect(media().src('p1', { folder: root, path: 'assets/icon.png' }).endsWith('?tile')).toBe(false)
    expect((await get(link)).status).toBe(200)
  })

  it('serves an icon from a monorepo package', async () => {
    const root = folder({ 'apps/web/public/favicon.svg': SVG })
    projects.set('p1', project('p1', [root]))
    expect((await get(media().src('p1', { folder: root, path: 'apps/web/public/favicon.svg' }))).status).toBe(200)
    // A package folder linked out of the repo serves nothing, even signed.
    const outside = folder({ 'public/favicon.svg': SVG })
    symlinkSync(outside, path.join(root, 'apps', 'site'))
    expect((await get(media().src('p1', { folder: root, path: 'apps/site/public/favicon.svg' }))).status).toBe(404)
  })

  it('opens nothing but a signed icon path inside a folder the project still links', async () => {
    const root = folder({ 'favicon.ico': ICO, 'secret.png': png(16), 'public/.env.png': png(16) })
    const outside = folder({ 'favicon.ico': ICO })
    symlinkSync(path.join(outside, 'favicon.ico'), path.join(root, 'icon.png'))
    projects.set('p1', project('p1', [root]))
    projects.set('p2', project('p2', [outside]))
    const signer = media()
    const good = signer.src('p1', { folder: root, path: 'favicon.ico' })
    expect((await get(good)).status).toBe(200)

    // Tampered: another file under the same signature, or another project's folder.
    expect((await get(good.replace('favicon.ico', 'secret.png'))).status).toBe(404)
    expect((await get(good.replace(encodeURIComponent(root), encodeURIComponent(outside)))).status).toBe(404)
    // Signed, but not a known icon place, a link out of the folder, or a folder of another project.
    expect((await get(signer.src('p1', { folder: root, path: 'secret.png' }))).status).toBe(404)
    expect((await get(signer.src('p1', { folder: root, path: '../' + path.basename(outside) + '/favicon.ico' }))).status).toBe(404)
    expect((await get(signer.src('p1', { folder: root, path: 'icon.png' }))).status).toBe(404)
    expect((await get(signer.src('p1', { folder: outside, path: 'favicon.ico' }))).status).toBe(404)
    // Unlinked after the link went out.
    projects.set('p1', project('p1', []))
    expect((await get(good)).status).toBe(404)
  })

  it('stops serving once the file is gone, so the client falls back to the glyph', async () => {
    const root = folder({ 'favicon.ico': ICO })
    projects.set('p1', project('p1', [root]))
    const link = media().src('p1', { folder: root, path: 'favicon.ico' })
    unlinkSync(path.join(root, 'favicon.ico'))
    expect((await get(link)).status).toBe(404)
  })

  it('refuses a pipe put where the icon was, without waiting for a writer', async () => {
    const root = folder({})
    execFileSync('mkfifo', [path.join(root, 'favicon.ico')])
    projects.set('p1', project('p1', [root]))
    expect((await get(media().src('p1', { folder: root, path: 'favicon.ico' }))).status).toBe(404)
  })

  it('links a directory project only while its icon folder is linked, and never trusts a stored link', () => {
    const root = folder({})
    const message = media().forClient({
      type: 'directory',
      projects: [
        project('linked', [root], { folder: root, path: 'favicon.ico' }),
        { ...project('unlinked', [], { folder: root, path: 'favicon.ico' }), repoIconSrc: '/elsewhere' },
        project('plain', [root]),
      ],
      chats: [],
      workHandoffs: [],
    })
    if (message.type !== 'directory') throw new Error('expected a directory')
    const [linked, unlinked, plain] = message.projects
    expect(linked?.repoIconSrc?.startsWith(REPO_ICON_PREFIX)).toBe(true)
    expect(unlinked?.repoIconSrc).toBeUndefined()
    expect(plain?.repoIconSrc).toBeUndefined()
  })
})

describe('stored repo icon', () => {
  it('survives an edit that keeps its folder and falls back to the glyph when the folder is unlinked', async () => {
    const store = createMemoryStore()
    const root = folder({ 'favicon.ico': ICO })
    const other = folder({})
    const { id } = await store.createProject('Site', [root], 'code')
    await store.updateProject(id, 'Site', [root], 'code', undefined, undefined, { folder: root, path: 'favicon.ico' })
    expect((await store.getProject(id))?.repoIcon).toEqual({ folder: root, path: 'favicon.ico' })

    await store.updateProject(id, 'Site renamed', [root, other])
    expect((await store.getProject(id))?.repoIcon).toEqual({ folder: root, path: 'favicon.ico' })

    await store.updateProject(id, 'Site renamed', [other])
    const after = await store.getProject(id)
    expect(after?.repoIcon).toBeUndefined()
    expect(after?.icon).toBe('code')
  })

  it('survives a restart of the database, letters too', async () => {
    const root = folder({ 'favicon.ico': ICO })
    const filename = path.join(folder({}), 'manor.sqlite')
    const first = createSqliteStore({ filename, seed: true })
    const { id } = await first.createProject('Site', [root])
    await first.updateProject(id, 'Site', [root], 'code', undefined, undefined, { folder: root, path: 'favicon.ico' })
    const lettered = await first.createProject('Shot Journal', [], 'code', undefined, undefined, true)
    first.close()
    const reopened = createSqliteStore({ filename })
    expect((await reopened.getProject(id))?.repoIcon).toEqual({ folder: root, path: 'favicon.ico' })
    expect((await reopened.getProject(lettered.id))?.letters).toBe(true)
    reopened.close()
  })

  it('drops the repo icon when the user picks a glyph', async () => {
    const store = createMemoryStore()
    const root = folder({ 'favicon.ico': ICO })
    const { id } = await store.createProject('Site', [root])
    await store.updateProject(id, 'Site', [root], 'code', undefined, undefined, { folder: root, path: 'favicon.ico' })
    await store.updateProject(id, 'Site', [root], 'rocket', undefined, undefined, null)
    expect(await store.getProject(id)).toMatchObject({ icon: 'rocket' })
    expect((await store.getProject(id))?.repoIcon).toBeUndefined()
  })
})
