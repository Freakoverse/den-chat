import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from './providers/ThemeProvider'
import App from './App'
import { requestPersistentStorage } from './lib/cache/blossomMediaCache'
import './styles/index.css'

// Ask the browser to keep our media cache instead of evicting it between
// sessions. Auto-granted in the Tauri webview; on web, Chrome grants it based
// on engagement / install / bookmark. Fire-and-forget — never blocks startup.
requestPersistentStorage()

// ── Tauri: intercept external link clicks and open in system browser ──
// In Tauri, <a target="_blank"> does nothing — links must go through the
// opener plugin. This global handler catches all anchor clicks with
// http(s) URLs and routes them to the system browser.
if ('__TAURI__' in window) {
  document.addEventListener('click', (e) => {
    const anchor = (e.target as HTMLElement).closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href')
    if (!href) return
    // Only intercept external URLs (http/https), not internal hash or data links
    if (!href.startsWith('http://') && !href.startsWith('https://')) return

    e.preventDefault()
    e.stopPropagation()
    import('@tauri-apps/plugin-opener').then(({ openUrl }) => {
      openUrl(href).catch((err: unknown) => {
        console.error('[Tauri] Failed to open URL in browser:', err)
      })
    })
  }, true) // capture phase — runs before React event handlers
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
)
