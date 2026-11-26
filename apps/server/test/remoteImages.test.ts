import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { REMOTE_FAVICON_PATH, REMOTE_IMAGE_PATH } from '@manor/contracts'
import { createRemoteImages, isPrivateAddress, linkedSites, mailImageUrls, markdownImageUrls, type RemoteImages } from '../src/remoteImages.js'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

const listen = async (handler: Parameters<typeof createServer>[1]) => {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** A third-party host: one real picture, a page, a picture too big, and a page that claims to be a picture. */
const upstream = () => listen((request, response) => {
  if (request.url?.split('?')[0] === '/photo.png') {
    response.writeHead(200, { 'content-type': 'image/png', 'set-cookie': 'tracker=1' })
    response.end(PNG)
  } else if (request.url === '/page') {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<p>not a picture</p>')
  } else if (request.url === '/big.png') {
    response.writeHead(200, { 'content-type': 'image/png' })
    response.end(Buffer.concat([PNG, Buffer.alloc(4_096)]))
  } else if (request.url === '/lying.png') {
    response.writeHead(200, { 'content-type': 'image/png' })
    response.end('<svg xmlns="http://www.w3.org/2000/svg"/>')
  } else if (request.url === '/moved') {
    response.writeHead(302, { location: '/photo.png' })
    response.end()
  } else if (request.url === '/bad-redirect') {
    response.writeHead(302, { location: 'http://[' })
    response.end()
  } else {
    response.writeHead(404)
    response.end()
  }
})

const proxy = async (images: RemoteImages) => {
  const origin = await listen((request, response) => {
    if (!images.handle(request, response)) {
      response.writeHead(418)
      response.end()
    }
  })
  return (url: string, init?: RequestInit) => fetch(`${origin}${REMOTE_IMAGE_PATH}?url=${encodeURIComponent(url)}`, init)
}

const shown = (images: RemoteImages, text: string) =>
  images.observe({ type: 'event', chatId: 'c1', event: { id: 'e1', ts: 1, type: 'agent_message', agentId: 'smith', turnId: 't1', text } })

describe('markdownImageUrls', () => {
  it('reads image destinations, not plain links', () => {
    expect(markdownImageUrls('[a link](https://example.com/page) and ![a bed bug](https://example.com/bug.jpg "Title")'))
      .toEqual(['https://example.com/bug.jpg'])
  })

  it('keeps balanced parentheses and reads an image inside a link', () => {
    expect(markdownImageUrls('[![Bed](https://en.wikipedia.org/wiki/Bed_(insect).jpg)](https://example.com)'))
      .toEqual(['https://en.wikipedia.org/wiki/Bed_(insect).jpg'])
    expect(markdownImageUrls('![bed bug](<https://example.com/bed bug.jpg>)')).toEqual(['https://example.com/bed%20bug.jpg'])
  })

  it('refuses an address carrying credentials', () => {
    expect(markdownImageUrls('![x](https://user:secret@example.com/x.png)')).toEqual([])
  })
})

describe('mailImageUrls', () => {
  it('reads every img src in any attribute form and order, decoding character references', () => {
    const html = [
      '<IMG alt="a > b" SRC="https://example.com/a.png?x=1&amp;y=2">',
      "<img width=10 src='https://example.com/b.png?x=1&#38;y=2' />",
      '<img src=https://example.com/c.png?x=1&#x26;y=2 alt=c>',
      '<img data-src="https://example.com/lazy.png" alt="src=https://example.com/alt.png" src="https://example.com/d.png" src="https://example.com/second.png">',
    ].join('\n')
    expect(mailImageUrls(html)).toEqual([
      'https://example.com/a.png?x=1&y=2',
      'https://example.com/b.png?x=1&y=2',
      'https://example.com/c.png?x=1&y=2',
      'https://example.com/d.png',
    ])
  })

  it('reads only img src: no srcset, CSS, link, local or credentialed address', () => {
    const html = [
      '<img srcset="https://example.com/set.png 2x" src="cid:logo@mail">',
      '<div style="background:url(https://example.com/css.png)"></div>',
      '<a href="https://example.com/link.png">https://example.com/text.png</a>',
      '<img src="https://user:secret@example.com/x.png">',
      '<!-- <img src="https://example.com/comment.png" alt="it\'s"> -->',
    ].join('\n')
    expect(mailImageUrls(html)).toEqual([])
    expect(mailImageUrls(`<!-- <img alt="don't -->\n<img src="https://example.com/after.png">`)).toEqual(['https://example.com/after.png'])
  })

  it('reads a mail of unclosed tags in one pass', () => {
    const started = performance.now()
    expect(mailImageUrls('<img "'.repeat(50_000))).toEqual([])
    expect(mailImageUrls(`<img src="https://example.com/a.png">${'<img a'.repeat(50_000)}`)).toEqual(['https://example.com/a.png'])
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('isPrivateAddress', () => {
  it('treats loopback, LAN, tailnet and link-local as private', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '100.101.102.103', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(address), address).toBe(true)
    }
    expect(isPrivateAddress('93.184.216.34')).toBe(false)
  })
})

describe('createRemoteImages', () => {
  it('serves a picture a message showed, without passing on its cookies', async () => {
    const host = await upstream()
    const images = createRemoteImages({ allowPrivateHosts: true })
    shown(images, `![bed bug](${host}/photo.png)`)
    const response = await (await proxy(images))(`${host}/photo.png`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG)
  })

  it('refuses an address no message showed', async () => {
    const host = await upstream()
    const response = await (await proxy(createRemoteImages({ allowPrivateHosts: true })))(`${host}/photo.png`)
    expect(response.status).toBe(404)
  })

  it('serves a picture a mail\'s HTML showed, not an address it only linked to or wrote out', async () => {
    const host = await upstream()
    const images = createRemoteImages({ allowPrivateHosts: true })
    const message = (id: string, html?: string) => ({
      id, from: { name: '', address: 'news@shop.example' }, to: [], cc: [], at: 1, text: `${host}/moved`, truncated: false, attachments: [], mine: false,
      ...(html === undefined ? {} : { html }),
    })
    images.observe({
      type: 'mail_thread',
      requestId: 'r1',
      threadId: 't1',
      result: {
        status: 'ready',
        thread: {
          threadId: 't1',
          subject: 'News',
          messages: [message('m1'), message('m2', `<p><img alt="x" src="${host}/photo.png?a=1&amp;b=2"> <a href="${host}/big.png">offers</a></p>`)],
          reply: { to: '', cc: '', subject: '' },
        },
      },
    })
    const fetchVia = await proxy(images)
    // The client asks with the src as the DOM decodes it.
    expect((await fetchVia(`${host}/photo.png?a=1&b=2`)).status).toBe(200)
    expect((await fetchVia(`${host}/big.png`)).status).toBe(404)
    expect((await fetchVia(`${host}/moved`)).status).toBe(404)
  })

  it('learns an address that arrives split over streamed deltas', async () => {
    const host = await upstream()
    const images = createRemoteImages({ allowPrivateHosts: true })
    for (const text of ['Here: ![bed', ` bug](${host}/pho`, 'to.png) done']) {
      images.observe({ type: 'delta', chatId: 'c1', turnId: 't1', agentId: 'smith', messageId: 'm1', text })
    }
    expect((await (await proxy(images))(`${host}/photo.png`)).status).toBe(200)
  })

  it('refuses a page that is not a picture, and a page that only claims to be one', async () => {
    const host = await upstream()
    const images = createRemoteImages({ allowPrivateHosts: true })
    shown(images, `![a](${host}/page) ![b](${host}/lying.png)`)
    const get = await proxy(images)
    expect((await get(`${host}/page`)).status).toBe(415)
    expect((await get(`${host}/lying.png`)).status).toBe(415)
  })

  it('refuses a picture over the size cap', async () => {
    const host = await upstream()
    const images = createRemoteImages({ allowPrivateHosts: true, maxBytes: 1_024 })
    shown(images, `![big](${host}/big.png)`)
    expect((await (await proxy(images))(`${host}/big.png`)).status).toBe(413)
  })

  it('refuses a private host, by address and by name', async () => {
    const host = await upstream()
    const named = host.replace('127.0.0.1', 'localhost')
    const images = createRemoteImages()
    shown(images, `![local](${host}/photo.png) ![named](${named}/photo.png)`)
    const get = await proxy(images)
    expect((await get(`${host}/photo.png`)).status).toBe(403)
    expect((await get(`${named}/photo.png`)).status).toBe(403)
  })

  it('follows a redirect to a picture', async () => {
    const host = await upstream()
    const images = createRemoteImages({ allowPrivateHosts: true })
    shown(images, `![moved](${host}/moved)`)
    expect((await (await proxy(images))(`${host}/moved`)).status).toBe(200)
  })

  it('fails a redirect whose target does not parse, without throwing', async () => {
    const host = await upstream()
    const images = createRemoteImages({ allowPrivateHosts: true })
    shown(images, `![bad](${host}/bad-redirect)`)
    expect((await (await proxy(images))(`${host}/bad-redirect`)).status).toBe(502)
  })
})

describe('linkedSites', () => {
  it('keeps the site of every web link, markdown or bare, and nothing local', () => {
    expect(linkedSites('Zie ([Healio](https://www.healio.com/news/x?a=1), https://pmc.ncbi.nlm.nih.gov/articles/1/) en [mail](mailto:a@b.nl), http://localhost:43179/x, [file](apps/web/a.ts)'))
      .toEqual(['https://www.healio.com', 'https://pmc.ncbi.nlm.nih.gov'])
  })

  it('learns the site a rendered link asks for, whatever surrounds the address', () => {
    expect(linkedSites('Zie https://example.com, of HTTPS://Upper.Example.org. En www.gfm.example.com; [x](https://port.example.com:8443/a)'))
      .toEqual(['https://example.com', 'https://upper.example.org', 'http://www.gfm.example.com', 'https://port.example.com:8443'])
    expect(linkedSites('[a](https://escaped\\.example\\.com/x) en [b](https://dotted.example.com./x)'))
      .toEqual(['https://escaped.example.com', 'https://dotted.example.com.'])
  })
})

describe('site icons', () => {
  const ICO = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x00]), Buffer.alloc(64)])

  /** Two fake sites on one loopback server, told apart by Host: one with an icon, one answering HTML. */
  const sites = async () => {
    let iconHits = 0
    const origin = await listen((request, response) => {
      const site = (request.headers.host ?? '').split(':')[0]
      if (request.url === '/favicon.ico' && site === 'icons.example') {
        iconHits += 1
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end(ICO)
      } else {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<p>no icon here</p>')
      }
    })
    const port = new URL(origin).port
    const images = createRemoteImages({
      allowPrivateHosts: true,
      lookup: ((_host: string, _options: unknown, callback: (error: null, addresses: { address: string; family: number }[]) => void) =>
        callback(null, [{ address: '127.0.0.1', family: 4 }])) as never,
    })
    const manor = await listen((request, response) => void images.handle(request, response))
    const ask = (site: string) => fetch(`${manor}${REMOTE_FAVICON_PATH}?site=${encodeURIComponent(site)}`)
    return { images, port, ask, hits: () => iconHits }
  }

  it('serves the icon of a site a message linked to, judged by its bytes, and fetches it once', async () => {
    const { images, port, ask, hits } = await sites()
    const site = `http://icons.example:${port}`
    expect((await ask(site)).status).toBe(404)
    shown(images, `Bron: [Healio](${site}/news/1).`)
    const first = await ask(site)
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('image/x-icon')
    expect(Buffer.from(await first.arrayBuffer())).toEqual(ICO)
    expect((await ask(site)).status).toBe(200)
    expect(hits()).toBe(1)
  })

  it('fails a site whose icon address answers with a page, and refuses anything but an origin', async () => {
    const { images, port, ask } = await sites()
    const site = `http://plain.example:${port}`
    shown(images, `${site}/article`)
    expect((await ask(site)).status).toBe(415)
    expect((await ask(`${site}/article`)).status).toBe(404)
  })
})
