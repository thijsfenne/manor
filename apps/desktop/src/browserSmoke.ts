import { browserSmokeWindow, mountSmokeWebviews } from './browserSmokeWindow'
import { BrowserWebviews } from './browserWebviews'
import { app, session } from 'electron'
import { BrowserHost } from './browserHost'

app.whenReady().then(async () => {
  const window = browserSmokeWindow()
  const profile = session.fromPartition('manor-browserSmoke')
  const registry = new BrowserWebviews(window, profile)
  await mountSmokeWebviews(window, registry)
  const browser = new BrowserHost(window, profile, undefined, registry)
  try {
    await browser.setBounds({ x: 0, y: 0, width: 800, height: 600 })
    await browser.navigate('https://example.com')
    const [snapshot, screenshot] = await Promise.all([browser.snapshot(), browser.screenshot()])
    console.log(JSON.stringify({
      url: snapshot.url,
      title: snapshot.title,
      visibleText: snapshot.visibleText,
      interactiveElements: snapshot.interactiveElements.length,
      // The point of the split: what an agent pays to read a page against what it
      // pays to look at one.
      snapshotCharacters: JSON.stringify(snapshot).length,
      screenshotCharacters: screenshot.screenshot.length,
      tabs: browser.state().tabs.length,
    }, null, 2))
  } finally {
    await browser.close()
    window.close()
    app.quit()
  }
}).catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
