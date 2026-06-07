/**
 * useDeepLink — Listens for denchat:// deep link URLs from the Tauri deep-link plugin
 * and navigates the app accordingly.
 *
 * Supported patterns:
 *   denchat://hub/<naddr1...>  → navigate to the hub (if joined) or Discover page (if not)
 *
 * Handles cold-launch: if the user isn't logged in yet, the URL is queued
 * and processed once authentication completes.
 */
import { useEffect, useRef } from 'react'
import { useNavigationStore } from '@/stores/navigationStore'
import { useHubStore } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'

/** Parse a denchat:// URL into an action */
function parseDeepLink(url: string): { type: 'hub'; naddr: string } | null {
  // Normalise: strip trailing slashes, handle both denchat:// and denchat:///
  const cleaned = url.replace(/^denchat:\/\//, '').replace(/^\/+/, '')

  // Match: hub/<naddr1...>
  const hubMatch = cleaned.match(/^hub\/(naddr1\S+)$/)
  if (hubMatch) {
    return { type: 'hub', naddr: hubMatch[1] }
  }

  return null
}

/** Deduplicate handling — avoid processing the same URL twice */
let lastHandledUrl = ''
let lastHandledTime = 0

/** Pending deep link URL waiting for authentication */
let pendingDeepLinkUrl: string | null = null

/**
 * Handle a deep link URL.
 * For hub links: navigate directly if already joined, otherwise go to Discover with search.
 * If the user isn't authenticated, queue the URL for later.
 */
function handleDeepLinkUrl(url: string) {
  // Deduplicate: ignore if we just handled this exact URL within 2 seconds
  const now = Date.now()
  if (url === lastHandledUrl && now - lastHandledTime < 2000) return
  lastHandledUrl = url
  lastHandledTime = now

  // If user isn't logged in yet, queue the URL for after authentication
  if (!useUserStore.getState().isAuthenticated) {
    console.log('[DeepLink] User not authenticated, queuing URL:', url)
    pendingDeepLinkUrl = url
    return
  }

  processDeepLink(url)
}

/** Actually process the deep link (user must be authenticated) */
function processDeepLink(url: string) {
  const action = parseDeepLink(url)
  if (!action) {
    console.warn('[DeepLink] Unrecognised deep link URL:', url)
    return
  }

  console.log('[DeepLink] Handling:', action.type, action)

  if (action.type === 'hub') {
    const { naddr } = action

    // Check if this hub is already in the user's hub list by decoding the naddr
    import('nostr-tools').then(({ nip19 }) => {
      try {
        const decoded = nip19.decode(naddr)
        if (decoded.type === 'naddr') {
          const addr = decoded.data as { kind: number; pubkey: string; identifier: string }
          const hubData = useHubStore.getState().hubData[addr.identifier]

          if (hubData) {
            // Hub already joined — navigate directly to it
            console.log('[DeepLink] Hub already joined, navigating to:', addr.identifier)
            useHubStore.getState().setActiveHub(addr.identifier)
            useNavigationStore.getState().setActivePage('hubs')
            return
          }
        }
      } catch {
        // naddr decode failed — fall through to discover
      }

      // Hub not in list — navigate to Discover page with the naddr as search
      console.log('[DeepLink] Hub not joined, opening Discover with search')
      useNavigationStore.getState().setActivePage('discover')

      // Dispatch a custom event so the DiscoverPage can pick up the search query
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('deep-link-hub-search', { detail: { naddr } }))
      }, 300) // small delay for the Discover page to mount
    }).catch(() => {
      // nostr-tools import failed — just navigate to discover
      useNavigationStore.getState().setActivePage('discover')
    })
  }
}

export function useDeepLink() {
  const isAuthenticated = useUserStore((s) => s.isAuthenticated)
  const wasAuthenticated = useRef(isAuthenticated)

  // ── Process pending deep link after login ──
  useEffect(() => {
    if (!wasAuthenticated.current && isAuthenticated && pendingDeepLinkUrl) {
      console.log('[DeepLink] User authenticated, processing pending URL:', pendingDeepLinkUrl)
      const url = pendingDeepLinkUrl
      pendingDeepLinkUrl = null
      // Delay to let the app UI settle after login transition
      setTimeout(() => processDeepLink(url), 1500)
    }
    wasAuthenticated.current = isAuthenticated
  }, [isAuthenticated])

  // ── Set up Tauri listeners ──
  useEffect(() => {
    // Only run in Tauri environment
    if (!('__TAURI__' in window)) return

    const unlisteners: (() => void)[] = []

    // Method 1: Plugin API — onOpenUrl (listens for deep-link://new-url events)
    import('@tauri-apps/plugin-deep-link').then(({ onOpenUrl }) => {
      onOpenUrl((urls: string[]) => {
        console.log('[DeepLink] onOpenUrl fired:', urls)
        if (urls.length > 0) {
          handleDeepLinkUrl(urls[0])
        }
      }).then((fn) => {
        unlisteners.push(fn)
      })
    }).catch(() => { /* plugin not available (web build) */ })

    // Method 2: Retrieve cold-launch URL from Rust state (reliable, no race condition)
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<string | null>('consume_pending_deep_link').then((url) => {
        if (url) {
          console.log('[DeepLink] Cold-launch URL from backend:', url)
          handleDeepLinkUrl(url)
        }
      }).catch(() => { /* command not available */ })
    }).catch(() => { /* tauri api not available */ })

    // Method 3: Direct Tauri event listener (deep-link://new-url from single-instance)
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<string[]>('deep-link://new-url', (event) => {
        console.log('[DeepLink] deep-link://new-url event:', event.payload)
        const urls = event.payload
        if (Array.isArray(urls) && urls.length > 0) {
          handleDeepLinkUrl(urls[0])
        }
      }).then((fn) => {
        unlisteners.push(fn)
      })

      // Method 4: Simple event name (avoids potential issues with :// in event names)
      listen<string>('den-deep-link', (event) => {
        console.log('[DeepLink] den-deep-link event:', event.payload)
        if (event.payload) {
          handleDeepLinkUrl(event.payload)
        }
      }).then((fn) => {
        unlisteners.push(fn)
      })
    }).catch(() => { /* tauri api not available */ })

    // Method 5: Check for pending deep link when window gains focus
    // Catches warm-launch case where the single-instance plugin stores the URL
    // in AppState but events don't reach the webview in release builds
    const handleFocus = () => {
      if (!('__TAURI__' in window)) return
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke<string | null>('consume_pending_deep_link').then((url) => {
          if (url) {
            console.log('[DeepLink] Pending URL found on focus:', url)
            handleDeepLinkUrl(url)
          }
        }).catch(() => {})
      }).catch(() => {})
    }
    window.addEventListener('focus', handleFocus)

    return () => {
      unlisteners.forEach(fn => fn())
      window.removeEventListener('focus', handleFocus)
    }
  }, [])

  // ── Web: check URL hash for #hub/<naddr> (works in browser + Tauri) ──
  useEffect(() => {
    const hash = window.location.hash // e.g. "#hub/naddr1..."
    if (!hash) return

    const match = hash.match(/^#hub\/(naddr1\S+)$/)
    if (match) {
      const naddr = match[1]
      console.log('[DeepLink] Web hash detected:', naddr)
      // Convert to a denchat:// URL and handle it through the same flow
      handleDeepLinkUrl(`denchat://hub/${naddr}`)
      // Clear the hash so it doesn't re-trigger on hot reload
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [])
}
