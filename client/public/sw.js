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
  const url = new URL(event.request.url)

  // Only handle same-origin navigation/asset requests
  if (url.origin !== self.location.origin) return

  // Don't cache API-like or WebSocket-upgrade requests
  if (event.request.method !== 'GET') return

  // Network-first strategy: try network, fall back to cache for offline shell
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful responses for offline fallback
        if (response.ok) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone)
          })
        }
        return response
      })
      .catch(() => {
        // Offline — serve from cache if available
        return caches.match(event.request).then((cached) => {
          if (cached) return cached
          // For navigation requests, serve the cached index.html (SPA fallback)
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html')
          }
          return new Response('Offline', { status: 503 })
        })
      })
  )
})
