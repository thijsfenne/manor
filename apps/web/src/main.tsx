import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ShellBoundary } from './components/RecoveryBoundary'
import { desktopTitleBarIsInset, listenDesktopZoom } from './desktopBrowser'
import './styles.css'

// Set before the first paint, so the corner the traffic lights land in is already
// reserved rather than reflowing once React mounts.
if (desktopTitleBarIsInset()) {
  document.documentElement.dataset.titlebar = 'inset'
  listenDesktopZoom()
}

const host = document.getElementById('root')
if (!host) throw new Error('manor: #root is missing from index.html')

createRoot(host).render(
  <StrictMode>
    <ShellBoundary>
      <App />
    </ShellBoundary>
  </StrictMode>,
)
