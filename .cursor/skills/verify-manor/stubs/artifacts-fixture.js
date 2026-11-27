// Stand-in for a connected mymind library, so the headless spike shows the Artifacts door.
// The spike's server runs without the library's keys and reports it as unavailable; this
// script answers for it inside the page. Load it with
// `MANOR_VERIFY_INIT_SCRIPT=$PWD/.cursor/skills/verify-manor/stubs/artifacts-fixture.js`
// on `launch`. Nothing leaves the page: the list request is answered here with four fixed
// objects without pictures, and a search narrows them by title.
(() => {
  const STATUS = { type: 'mymind_status', available: true, env: [], problem: null, check: null }
  const DAY = '2026-11-20T09:00:00.000Z'
  const object = (id, title, kind, summary) => ({ id, title, kind, summary, tags: [], spaces: [], created: DAY, bumped: DAY })
  const OBJECTS = [
    object('fixture-1', 'Notes on a calm settings page', 'note', 'One option per row, and nothing that needs explaining.'),
    object('fixture-2', 'Field guide to list density', 'article', 'How much a row can hold before it stops being scannable.'),
    object('fixture-3', 'Checklist for a release day', 'note', 'Tag, notes, build, smoke test.'),
    object('fixture-4', 'A study of quiet toolbars', 'article', 'Primary first, the rest in the order they are used.'),
  ]

  const Real = window.WebSocket
  class FixtureSocket extends Real {
    constructor(...args) {
      super(...args)
      const deliver = (message) => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
      this.fixtureDeliver = deliver
      // Registered before the app's own listener, so the server's "unavailable" never reaches it.
      this.addEventListener('message', (event) => {
        if (typeof event.data !== 'string' || !event.data.includes('"type":"mymind_status"') || event.data.includes('"available":true')) return
        event.stopImmediatePropagation()
        deliver(STATUS)
      })
      this.addEventListener('open', () => setTimeout(() => deliver(STATUS), 200))
    }

    send(data) {
      let message
      try {
        message = JSON.parse(data)
      } catch {
        return super.send(data)
      }
      if (message.type === 'verify_mymind' || message.type === 'load_more_mymind_objects') return undefined
      if (message.type !== 'list_mymind_objects') return super.send(data)
      const query = (message.query ?? '').trim().toLowerCase()
      const objects = OBJECTS.filter((entry) => entry.title.toLowerCase().includes(query))
      setTimeout(() => this.fixtureDeliver({
        type: 'mymind_objects', requestId: message.requestId, query: message.query ?? '', append: false,
        result: { status: 'ready', objects, spaces: [], hasMore: false },
      }), 50)
      return undefined
    }
  }
  window.WebSocket = FixtureSocket
})()
