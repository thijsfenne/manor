import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import { AvatarPlayground, PlaygroundPane } from './AvatarPlayground'

// The theme frames load this same page with `?theme=`. The tokens are scoped to the
// root element, so each room needs a document of its own to be drawn faithfully.
const theme = new URLSearchParams(window.location.search).get('theme')
document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'

const host = document.getElementById('root')
if (!host) throw new Error('manor: #root is missing from playground.html')

createRoot(host).render(
  <StrictMode>{theme === null ? <AvatarPlayground /> : <PlaygroundPane theme={theme === 'light' ? 'Light' : 'Dark'} />}</StrictMode>,
)
