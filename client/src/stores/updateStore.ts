/**
 * updateStore — Manages in-app update state for the desktop (Tauri) build.
 *
 * Tracks the detected available version, platform-matched download URL,
 * download progress, and install status. Used by UpdateToast and UpdatesTab.
 */

import { create } from 'zustand'

export type UpdateDownloadStatus =
  | 'idle'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'failed'

export interface UpdatePlatform {
  platform: string
  url: string
  ext: string
  hash: string
}

interface UpdateState {
  /** The newer version detected from Nostr */
  availableVersion: string | null
  /** Release notes markdown */
  releaseNotes: string | null
  /** All platforms from the build event */
  allPlatforms: UpdatePlatform[]
  /** Auto-detected platform entry for this OS */
  matchedPlatform: UpdatePlatform | null
  /** Whether the user overrode the auto-detected platform */
  showAllPlatforms: boolean

  /** Download state */
  downloadStatus: UpdateDownloadStatus
  downloadProgress: number    // 0–100
  downloadSpeed: number       // bytes/sec
  downloadedBytes: number
  totalBytes: number
  downloadedPath: string | null
  error: string | null

  // Actions
  setAvailable: (version: string, notes: string, platforms: UpdatePlatform[]) => void
  setShowAllPlatforms: (show: boolean) => void
  setDownloading: (progress: number, speed: number, downloaded: number, total: number) => void
  setReady: (path: string) => void
  setInstalling: () => void
  setFailed: (error: string) => void
  reset: () => void
}

/**
 * Detect the current OS from navigator.userAgent
 */
export function detectOS(): 'windows' | 'linux' | 'macos' | null {
  if (typeof navigator === 'undefined') return null
  const ua = navigator.userAgent.toLowerCase()
  // Check platform first (more reliable in Tauri)
  const platform = (navigator.platform || '').toLowerCase()
  if (platform.includes('win') || ua.includes('windows')) return 'windows'
  if (platform.includes('linux') || ua.includes('linux')) return 'linux'
  if (platform.includes('mac') || ua.includes('macintosh')) return 'macos'
  return null
}

/**
 * Match a platform entry from the build event to the detected OS.
 * Prefers NSIS exe on Windows, .deb on Linux, .dmg on macOS.
 */
export function matchPlatform(
  platforms: UpdatePlatform[],
  os: string | null
): UpdatePlatform | null {
  if (!os || platforms.length === 0) return null

  const keywords: Record<string, string[]> = {
    windows: ['windows', 'win'],
    linux: ['linux', 'deb', 'appimage', 'rpm'],
    macos: ['mac', 'macos', 'dmg', 'apple'],
  }

  const search = keywords[os] || []
  // Prefer the first match (build events typically list the primary format first)
  return (
    platforms.find((p) =>
      search.some((k) => p.platform.toLowerCase().includes(k))
    ) || null
  )
}

export const useUpdateStore = create<UpdateState>((set) => ({
  availableVersion: null,
  releaseNotes: null,
  allPlatforms: [],
  matchedPlatform: null,
  showAllPlatforms: false,

  downloadStatus: 'idle',
  downloadProgress: 0,
  downloadSpeed: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  downloadedPath: null,
  error: null,

  setAvailable: (version, notes, platforms) => {
    const os = detectOS()
    const matched = matchPlatform(platforms, os)
    set({
      availableVersion: version,
      releaseNotes: notes,
      allPlatforms: platforms,
      matchedPlatform: matched,
      showAllPlatforms: false,
      downloadStatus: 'idle',
      downloadProgress: 0,
      downloadSpeed: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      downloadedPath: null,
      error: null,
    })
  },

  setShowAllPlatforms: (show) => set({ showAllPlatforms: show }),

  setDownloading: (progress, speed, downloaded, total) =>
    set({
      downloadStatus: 'downloading',
      downloadProgress: progress,
      downloadSpeed: speed,
      downloadedBytes: downloaded,
      totalBytes: total,
      error: null,
    }),

  setReady: (path) =>
    set({
      downloadStatus: 'ready',
      downloadProgress: 100,
      downloadedPath: path,
      error: null,
    }),

  setInstalling: () =>
    set({ downloadStatus: 'installing', error: null }),

  setFailed: (error) =>
    set({ downloadStatus: 'failed', error }),

  reset: () =>
    set({
      downloadStatus: 'idle',
      downloadProgress: 0,
      downloadSpeed: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      downloadedPath: null,
      error: null,
    }),
}))

/**
 * Check if a URL is a Blossom URL (last path segment is a 64-char hex hash).
 */
function extractBlossomHash(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean)
    const last = parts[parts.length - 1] || ''
    return /^[a-f0-9]{64}$/i.test(last) ? last.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Build a list of URLs to try for a given Blossom hash, cycling through
 * all configured Blossom servers (skipping the ones that already failed).
 */
async function buildBlossomFallbackUrls(
  originalUrl: string,
  hash: string,
  skipOrigins: Set<string>,
): Promise<string[]> {
  const { blossomServers } = await import('@/lib/blossom')
  const allServers = blossomServers.getServers()
  const originalOrigin = new URL(originalUrl).origin

  return allServers
    .filter((s) => {
      const norm = s.replace(/\/+$/, '')
      return norm !== originalOrigin && !skipOrigins.has(norm)
    })
    .map((s) => `${s.replace(/\/+$/, '')}/${hash}`)
}

/**
 * Start downloading the update via the Rust backend.
 * For Blossom URLs, automatically fails over to other Blossom servers
 * on hash mismatch or download errors.
 */
export async function startUpdateDownload(url: string, ext: string, hash?: string) {
  const store = useUpdateStore.getState()
  if (store.downloadStatus === 'downloading') return

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const { listen } = await import('@tauri-apps/api/event')

    store.setDownloading(0, 0, 0, 0)

    // Listen for progress events from Rust
    const unlisten = await listen<{
      percent: number
      downloaded: number
      total: number
      speed: number
    }>('den-update-progress', (event) => {
      useUpdateStore.getState().setDownloading(
        event.payload.percent,
        event.payload.speed,
        event.payload.downloaded,
        event.payload.total,
      )
    })

    // Determine filename
    const cleanExt = ext.startsWith('.') ? ext : `.${ext}`
    const filename = `DEN-Chat-Setup${cleanExt}`

    // Determine the hash to verify against:
    // 1. Explicit hash from build event
    // 2. Blossom URL hash (last path segment is SHA-256)
    const blossomHash = extractBlossomHash(url)
    const expectedHash = hash || blossomHash || ''

    // Build the list of URLs to try (original first, then Blossom fallbacks)
    const urlsToTry = [url]
    const failedOrigins = new Set<string>()

    if (blossomHash) {
      const fallbacks = await buildBlossomFallbackUrls(url, blossomHash, failedOrigins)
      urlsToTry.push(...fallbacks)
    }

    let lastError = ''

    for (const tryUrl of urlsToTry) {
      try {
        // Reset progress for each attempt
        useUpdateStore.getState().setDownloading(0, 0, 0, 0)

        const result = await invoke<{ path: string; hash: string; verified: boolean }>(
          'download_update',
          { url: tryUrl, filename, expectedHash: expectedHash || null },
        )

        unlisten()
        useUpdateStore.getState().setReady(result.path)
        return // Success — stop trying
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        lastError = errMsg

        // Track which origin failed so we don't retry it
        try {
          failedOrigins.add(new URL(tryUrl).origin)
        } catch { /* ignore */ }

        // If it's a hash mismatch on a Blossom URL, try the next server
        if (blossomHash && errMsg.includes('Hash mismatch')) {
          console.warn(`Update download hash mismatch from ${tryUrl}, trying next server...`)
          continue
        }

        // For non-hash-mismatch errors on Blossom URLs, also try fallbacks
        if (blossomHash) {
          console.warn(`Update download failed from ${tryUrl}: ${errMsg}, trying next server...`)
          continue
        }

        // Non-Blossom URL failed — no fallback available
        break
      }
    }

    // All attempts failed
    unlisten()
    useUpdateStore.getState().setFailed(lastError || 'Download failed from all sources')
  } catch (err) {
    useUpdateStore
      .getState()
      .setFailed(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Launch the downloaded installer (Windows only).
 * On other platforms, this will fail gracefully.
 */
export async function startUpdateInstall() {
  const store = useUpdateStore.getState()
  if (!store.downloadedPath) return

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    store.setInstalling()
    await invoke('install_update', { path: store.downloadedPath })
    // App will exit — we won't reach here on Windows
  } catch (err) {
    useUpdateStore
      .getState()
      .setFailed(err instanceof Error ? err.message : String(err))
  }
}
