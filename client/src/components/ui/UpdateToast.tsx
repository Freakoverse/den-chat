/**
 * UpdateToast — Detects when a newer version is available and prompts the user.
 *
 * Web mode:
 * - Fetches /version.json (cache-busted) every 5 minutes + on tab refocus
 * - Compares against __APP_VERSION__
 * - Shows "Refresh now" button → location.reload()
 *
 * Tauri (desktop) mode:
 * - Fetches latest build events (kind:30078) from Nostr relays
 * - Compares the latest build version against __APP_VERSION__
 * - Shows "View Update" button → navigates to Settings → Updates
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { RefreshCw, Download, X } from 'lucide-react'
import { isTauri } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigationStore'

const CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000   // 2 hours
const REFOCUS_COOLDOWN_MS = 60 * 60 * 1000      // 1 hour cooldown for tab refocus checks

/** Simple semver comparison: returns true if `remote` is newer than `local` */
function isNewerVersion(local: string, remote: string): boolean {
  const parse = (v: string) => v.split('.').map((s) => parseInt(s, 10) || 0)
  const l = parse(local)
  const r = parse(remote)
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    const lv = l[i] ?? 0
    const rv = r[i] ?? 0
    if (rv > lv) return true
    if (rv < lv) return false
  }
  return false
}

export function UpdateToast() {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [serverVersion, setServerVersion] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [mode, setMode] = useState<'web' | 'tauri'>('web')
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Web check: poll /version.json ──
  const checkWeb = useCallback(async () => {
    try {
      const res = await fetch(`/version.json?_=${Date.now()}`, { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      if (data.version && data.version !== __APP_VERSION__) {
        setServerVersion(data.version)
        setUpdateAvailable(true)
      }
    } catch {
      // Network error — silently ignore
    }
  }, [])

  // ── Tauri check: fetch build events from relays ──
  const checkTauri = useCallback(async () => {
    try {
      const { ADMIN_PUBKEY } = await import('@/lib/constants')
      const { fetchReplaceable, fetchEvents } = await import('@/lib/nostr/relay-pool')
      const { useUpdateStore } = await import('@/stores/updateStore')

      let latestVersion: string | null = null
      let latestBody = ''
      // Shape must match UpdatePlatform (incl. `hash`) — it's populated below and
      // consumed by setAvailable for download verification.
      let latestPlatforms: { platform: string; url: string; ext: string; hash: string }[] = []

      // Try the den-chat-latest pointer first (single event, fast)
      const latestEvent = await fetchReplaceable(ADMIN_PUBKEY, 30078, 'den-chat-latest')
      if (latestEvent) {
        try {
          const data = JSON.parse(latestEvent.content)
          if (data.version) latestVersion = data.version
        } catch { /* ignore */ }
      }

      // Fetch all build events to get the full details (platforms, release notes)
      const BUILD_DTAG_PREFIX = 'den-chat-build-'
      const events = await fetchEvents({ authors: [ADMIN_PUBKEY], kinds: [30078] })
      let latestTimestamp = 0
      for (const ev of events) {
        const dTag = ev.tags.find((t: string[]) => t[0] === 'd')?.[1]
        if (!dTag || !dTag.startsWith(BUILD_DTAG_PREFIX)) continue
        try {
          const data = JSON.parse(ev.content)
          if (data.deleted) continue
          if (ev.tags.some((t: string[]) => t[0] === 'deleted')) continue
          const publishedAt = data.published_at || ev.created_at
          if (data.version && publishedAt > latestTimestamp) {
            latestTimestamp = publishedAt
            if (!latestVersion) latestVersion = data.version
            // If this is the matching version, grab its details
            if (data.version === latestVersion) {
              latestBody = data.body || ''
              latestPlatforms = Array.isArray(data.platforms)
                ? data.platforms.map((p: Record<string, string>) => ({
                    platform: p.platform || '',
                    url: p.url || '',
                    ext: p.ext || '',
                    hash: p.hash || '',
                  }))
                : []
            }
          }
        } catch { /* ignore */ }
      }

      if (latestVersion && isNewerVersion(__APP_VERSION__, latestVersion)) {
        setServerVersion(latestVersion)
        setUpdateAvailable(true)

        // Populate the update store for the Updates tab
        useUpdateStore.getState().setAvailable(latestVersion, latestBody, latestPlatforms)
      }
    } catch {
      // Relay fetch failed — silently ignore
    }
  }, [])

  const lastCheckRef = useRef(0)

  useEffect(() => {
    const inTauri = isTauri()
    setMode(inTauri ? 'tauri' : 'web')

    const check = inTauri ? checkTauri : checkWeb
    const wrappedCheck = () => {
      lastCheckRef.current = Date.now()
      check()
    }

    // Initial check after startup delay
    const initialTimeout = setTimeout(wrappedCheck, 15_000)

    // Periodic checks every 2 hours
    intervalRef.current = setInterval(wrappedCheck, CHECK_INTERVAL_MS)

    // Check on tab refocus (with cooldown to avoid spamming)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        const elapsed = Date.now() - lastCheckRef.current
        if (elapsed >= REFOCUS_COOLDOWN_MS) wrappedCheck()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    // Web only: a failed lazy-chunk load (vite:preloadError) means the user is on a
    // stale build whose hashed assets no longer exist after a deploy — the most
    // immediate "new version is live" signal. Surface the existing toast now instead
    // of waiting for the next version.json poll. (Tauri bundles assets locally, so it
    // never fires there, and a reload wouldn't update a desktop build anyway.)
    const handlePreloadError = () => {
      setUpdateAvailable(true)
      checkWeb() // best-effort: fetch the new version string for the toast
    }
    if (!inTauri) window.addEventListener('vite:preloadError', handlePreloadError)

    return () => {
      clearTimeout(initialTimeout)
      if (intervalRef.current) clearInterval(intervalRef.current)
      document.removeEventListener('visibilitychange', handleVisibility)
      if (!inTauri) window.removeEventListener('vite:preloadError', handlePreloadError)
    }
  }, [checkWeb, checkTauri])

  if (!updateAvailable || dismissed) return null

  const handleAction = () => {
    if (mode === 'web') {
      location.reload()
    } else {
      // Navigate to Settings → Updates
      useNavigationStore.getState().setActivePage('settings')
      useNavigationStore.getState().setSettingsTab('updates')
      setDismissed(true)
    }
  }

  return (
    <div className="fixed bottom-4 right-4 z-[100] max-w-sm animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-card border border-border shadow-xl">
        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
          {mode === 'web' ? <RefreshCw size={16} className="text-primary" /> : <Download size={16} className="text-primary" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">Update available</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {mode === 'web'
              ? `A new version${serverVersion ? ` (v${serverVersion})` : ''} is ready. Refresh to get the latest features and fixes.`
              : `Version ${serverVersion || 'update'} is available. Head to Updates to download it.`
            }
          </p>
          <div className="flex items-center gap-2 mt-2.5">
            <button
              onClick={handleAction}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors cursor-pointer"
            >
              {mode === 'web' ? <RefreshCw size={12} /> : <Download size={12} />}
              {mode === 'web' ? 'Refresh now' : 'View Update'}
            </button>
            <button
              onClick={() => setDismissed(true)}
              className="px-2.5 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
            >
              Later
            </button>
          </div>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors cursor-pointer shrink-0"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
