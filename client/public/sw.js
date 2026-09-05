// DEN Chat Service Worker — minimal network-first SW for PWA installability.
// All requests go to the network; the SW exists primarily so Chrome/browsers
// show the "Install as app" prompt and the app can run in standalone mode.

// Bump this on any SW/cache change: the activate handler deletes every cache whose name != this,
// so a version bump purges a stale/broken cached build for users whose SW updates.
const CACHE_NAME = 'den-chat-v2'

self.addEventListener('install', (event) => {
  // Skip waiting so new SW activates immediately
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  // Claim all open clients immediately
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)

  // Only handle same-origin GET requests
  if (url.origin !== self.location.origin) return
  if (req.method !== 'GET') return

  const isNavigation = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html')

  if (isNavigation) {
    // Navigations (the app shell / index.html) MUST always be fresh. GitHub Pages caps every file at
    // Cache-Control: max-age=600 and offers no way to override it, so a normal fetch can serve a
    // 10-min-stale index.html that points at asset hashes a later deploy deleted → those chunks 404 →
    // blank page. `cache: 'no-store'` bypasses the HTTP cache so we always get the current index;
    // fall back to a cached shell only when genuinely offline.
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((response) => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', clone))
          }
          return response
        })
        .catch(() =>
          caches.match('/index.html').then((cached) => cached || new Response('Offline', { status: 503 }))
        )
    )
    return
  }

  // Assets (content-addressed hashed filenames) — network-first, cache for offline fallback.
  event.respondWith(
    fetch(req)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone))
        }
        return response
      })
      .catch(() =>
        caches.match(req).then((cached) => cached || new Response('Offline', { status: 503 }))
      )
  )
})
