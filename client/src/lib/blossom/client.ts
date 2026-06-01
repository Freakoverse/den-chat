import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import type { ISigner } from '@/stores/userStore'
import { signWithSigner, createUnsignedEvent } from '@/lib/nostr'
import { StorageKey } from '@/lib/constants'

const DEFAULT_SERVERS = [
  'https://blossom.primal.net',
  'https://blossom.band',
  'https://blossom.nostr.hu',
  'https://cdn.sovbit.host',
  'https://blossom.data.haus',
]

function normalize(url: string): string {
  return url.replace(/\/+$/, '')
}

// ─── Migration from old keys ───

function migrateOldBlossomKeys(): void {
  // Only migrate once — if new key already exists, skip
  if (localStorage.getItem(StorageKey.CLIENT_BLOSSOMS)) return

  // Try old toggle state first (has url + enabled info)
  const oldToggle = localStorage.getItem('denchat_blossom_toggle_state')
  if (oldToggle) {
    try {
      const parsed = JSON.parse(oldToggle)
      if (Array.isArray(parsed) && parsed.length > 0) {
        localStorage.setItem(StorageKey.CLIENT_BLOSSOMS, JSON.stringify(parsed))
      }
    } catch { /* ignore */ }
  } else {
    // Try old flat server list
    const oldServers = localStorage.getItem('denchat_blossom_servers')
    if (oldServers) {
      try {
        const parsed = JSON.parse(oldServers)
        if (Array.isArray(parsed) && parsed.length > 0) {
          const migrated = parsed.map((url: string) => ({ url, enabled: true }))
          localStorage.setItem(StorageKey.CLIENT_BLOSSOMS, JSON.stringify(migrated))
        }
      } catch { /* ignore */ }
    }
  }

  // Clean up old keys
  localStorage.removeItem('denchat_blossom_toggle_state')
  localStorage.removeItem('denchat_blossom_servers')
  localStorage.removeItem('denchat_blossom_fallback')
}

// Run migration on module load
migrateOldBlossomKeys()

// ─── Server Management ───

export const blossomServers = {
  /** Get the full list with enabled states */
  getList(): { url: string; enabled: boolean }[] {
    try {
      const stored = localStorage.getItem(StorageKey.CLIENT_BLOSSOMS)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed) && parsed.length > 0) return parsed
      }
    } catch { /* ignore */ }
    return DEFAULT_SERVERS.map((url) => ({ url, enabled: true }))
  },

  /** Get only the enabled server URLs (for runtime use) */
  getServers(): string[] {
    const list = this.getList()
    const enabled = list.filter((s) => s.enabled).map((s) => s.url)
    return enabled.length > 0 ? enabled : [...DEFAULT_SERVERS]
  },

  /** Save the full list (with toggle states) */
  saveList(list: { url: string; enabled: boolean }[]): void {
    localStorage.setItem(StorageKey.CLIENT_BLOSSOMS, JSON.stringify(list))
  },

  addServer(url: string): void {
    const list = this.getList()
    const normalized = normalize(url)
    if (!list.some((s) => s.url === normalized)) {
      list.push({ url: normalized, enabled: true })
      this.saveList(list)
    }
  },

  removeServer(url: string): void {
    const list = this.getList().filter(s => s.url !== url)
    this.saveList(list)
  },

  getDefaults(): string[] {
    return [...DEFAULT_SERVERS]
  },

  resetToDefaults(): void {
    localStorage.removeItem(StorageKey.CLIENT_BLOSSOMS)
  },
}

// ─── Auth Header (BUD-01) ───

/**
 * Create a Nostr kind 24242 auth event for Blossom requests.
 * Per BUD-01: the event authorizes a specific action on a specific file.
 */
async function createAuthHeader(
  action: 'upload' | 'get' | 'delete',
  fileHash: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<string> {
  const expiration = Math.floor(Date.now() / 1000) + 600 // 10 min

  const tags: [string, ...string[]][] = [
    ['t', action],
    ['x', fileHash],
    ['expiration', expiration.toString()],
  ]

  const unsigned = createUnsignedEvent(24242, `Authorize ${action}`, tags)
  const signed = await signWithSigner(unsigned, signer, privateKey)
  const encoded = btoa(JSON.stringify(signed))
  return `Nostr ${encoded}`
}

// ─── Upload ───

/**
 * Compute SHA-256 hash of data.
 */
export function computeHash(data: Uint8Array): string {
  return bytesToHex(sha256(data))
}

/**
 * Upload progress callback
 */
export interface UploadProgress {
  /** Current server URL being uploaded to */
  serverUrl: string
  /** Server index in the sequence (0-based) */
  serverIndex: number
  /** Total number of servers to try */
  totalServers: number
  /** Upload percentage for current server (0-100) */
  percent: number
  /** Upload speed in bytes/sec */
  speed: number
  /** Bytes uploaded so far for current server */
  loaded: number
  /** Total bytes to upload */
  total: number
}

/**
 * Upload a file to a single Blossom server using XHR for progress tracking.
 * Returns true on success, false on failure.
 * Supports abort via AbortController signal.
 */
function uploadToServerWithProgress(
  serverUrl: string,
  data: Uint8Array,
  authHeader: string,
  contentType: string,
  onProgress: (progress: UploadProgress, partialInfo: { serverIndex: number; totalServers: number }) => void,
  serverIndex: number,
  totalServers: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const xhr = new XMLHttpRequest()
    const url = `${normalize(serverUrl)}/upload`
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', contentType)
    xhr.setRequestHeader('Authorization', authHeader)

    let startTime = Date.now()
    let lastLoaded = 0
    let responseTimeout: ReturnType<typeof setTimeout> | null = null

    const clearResponseTimeout = () => {
      if (responseTimeout) { clearTimeout(responseTimeout); responseTimeout = null }
    }

    // Handle abort signal
    const handleAbort = () => {
      clearResponseTimeout()
      try { xhr.abort() } catch { /* ignore */ }
      resolve(false)
    }
    if (signal) {
      if (signal.aborted) { resolve(false); return }
      signal.addEventListener('abort', handleAbort, { once: true })
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const now = Date.now()
        const elapsed = (now - startTime) / 1000 // seconds
        const speed = elapsed > 0 ? event.loaded / elapsed : 0

        onProgress({
          serverUrl,
          serverIndex,
          totalServers,
          percent: Math.round((event.loaded / event.total) * 100),
          speed,
          loaded: event.loaded,
          total: event.total,
        }, { serverIndex, totalServers })

        lastLoaded = event.loaded

        // Start 15s response timeout once all bytes are uploaded
        if (event.loaded >= event.total && !responseTimeout) {
          responseTimeout = setTimeout(() => {
            console.warn(`Blossom: server ${serverUrl} did not respond within 15s after upload completed`)
            signal?.removeEventListener('abort', handleAbort)
            try { xhr.abort() } catch { /* ignore */ }
            resolve(false)
          }, 15_000)
        }
      }
    }

    xhr.onerror = () => {
      clearResponseTimeout()
      signal?.removeEventListener('abort', handleAbort)
      resolve(false)
    }

    xhr.onload = () => {
      clearResponseTimeout()
      signal?.removeEventListener('abort', handleAbort)
      resolve(xhr.status >= 200 && xhr.status < 300)
    }

    xhr.onabort = () => {
      clearResponseTimeout()
      signal?.removeEventListener('abort', handleAbort)
      resolve(false)
    }

    const blob = new Blob([data.buffer as ArrayBuffer], { type: contentType })
    xhr.send(blob)
  })
}

/**
 * Pick N random servers from the list.
 */
function pickRandomServers(servers: string[], count: number): string[] {
  const shuffled = [...servers].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, count)
}

/**
 * Upload a file sequentially to Blossom servers with progress.
 * Picks 3 random servers and uploads to each one at a time.
 * User can cancel the current server upload (moves to next).
 *
 * @param data - Raw file bytes
 * @param signer - ISigner for auth (or null)
 * @param privateKey - Raw private key hex (or null)
 * @param servers - Optional list of servers (defaults to configured servers)
 * @param contentType - MIME type
 * @param onProgress - Progress callback
 * @param getAbortSignal - Called before each server upload, returns AbortSignal for that server
 * @returns SHA-256 hash of the file and success count
 */
export async function uploadToBlossomServers(
  data: Uint8Array,
  signer: ISigner | null,
  privateKey: string | null,
  servers?: string[],
  contentType: string = 'application/octet-stream',
  onProgress?: (progress: UploadProgress) => void,
  getAbortSignal?: () => AbortSignal | undefined,
): Promise<{ hash: string; successCount: number; serverUrls: string[] }> {
  const allServers = servers || blossomServers.getServers()
  // Shuffle all servers and try them until we get 3 successes or exhaust all
  const shuffled = [...allServers].sort(() => Math.random() - 0.5)
  const targetCount = 3
  const hash = computeHash(data)
  const authHeader = await createAuthHeader('upload', hash, signer, privateKey)

  let successCount = 0
  const serverUrls: string[] = []

  // Sequential upload — try all servers, stop once we reach targetCount successes
  for (let i = 0; i < shuffled.length; i++) {
    if (successCount >= targetCount) break
    const server = shuffled[i]
    const signal = getAbortSignal?.()

    // Check if the file already exists on this server (HEAD request)
    try {
      const headCtrl = new AbortController()
      const headTimer = setTimeout(() => headCtrl.abort(), 5000) // 5s timeout for HEAD
      const headUrl = `${server}/` + hash
      const headRes = await fetch(headUrl, { method: 'HEAD', signal: headCtrl.signal }).catch(() => null)
      clearTimeout(headTimer)
      if (headRes && headRes.ok) {
        // File already exists on this server — skip upload
        successCount++
        serverUrls.push(normalize(server))
        onProgress?.({
          serverUrl: server,
          serverIndex: i,
          totalServers: shuffled.length,
          percent: 100,
          speed: 0,
          loaded: data.length,
          total: data.length,
        })
        console.log(`Blossom: file ${hash} already exists on ${server}, skipping upload`)
        continue
      }
    } catch { /* HEAD check failed — proceed with upload */ }

    // Report starting this server
    onProgress?.({
      serverUrl: server,
      serverIndex: i,
      totalServers: shuffled.length,
      percent: 0,
      speed: 0,
      loaded: 0,
      total: data.length,
    })

    const ok = await uploadToServerWithProgress(
      server,
      data,
      authHeader,
      contentType,
      (progress) => onProgress?.(progress),
      i,
      shuffled.length,
      signal,
    )

    if (ok) {
      successCount++
      serverUrls.push(normalize(server))
      onProgress?.({
        serverUrl: server,
        serverIndex: i,
        totalServers: shuffled.length,
        percent: 100,
        speed: 0,
        loaded: data.length,
        total: data.length,
      })
    }
  }

  if (successCount === 0) {
    throw new Error('Upload failed: no Blossom servers accepted the file')
  }

  return { hash, successCount, serverUrls }
}

// ─── Download ───

/**
 * Download progress callback
 */
export interface DownloadProgress {
  serverUrl: string
  percent: number
  speed: number
  loaded: number
  total: number
}

/**
 * Download a file by SHA-256 hash from Blossom servers.
 * Tries each server in order until one succeeds.
 * Verifies the hash of downloaded content.
 *
 * @param hash - SHA-256 hash of the file
 * @param servers - Optional list of servers to try
 * @returns File contents as Uint8Array
 */
export async function downloadFromBlossom(
  hash: string,
  servers?: string[],
): Promise<Uint8Array> {
  const targetServers = servers || blossomServers.getServers()

  // Build a deduped server list: provided servers first, then client defaults as fallback
  const triedSet = new Set(targetServers.map(normalize))
  const fallbackServers = servers
    ? blossomServers.getServers().filter(s => !triedSet.has(normalize(s)))
    : []
  const allServers = [...targetServers, ...fallbackServers]

  for (const server of allServers) {
    try {
      const url = `${normalize(server)}/${hash}`
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) continue

      const data = new Uint8Array(await res.arrayBuffer())

      // Verify hash
      const actualHash = computeHash(data)
      if (actualHash !== hash) {
        console.warn(`Hash mismatch from ${server}: expected ${hash}, got ${actualHash}`)
        continue
      }

      return data
    } catch (err) {
      console.warn(`Blossom download failed for ${server}:`, err)
      continue
    }
  }

  throw new Error(`Failed to download file ${hash} from any Blossom server`)
}

/**
 * Download a file from a URL with XHR progress tracking.
 * If the URL looks like a blossom URL (hash as last path segment), verifies SHA-256.
 * Supports trying alternative blossom servers on failure or hash mismatch.
 *
 * @returns { data, verified, hash, serverUrl }
 */
export async function downloadFromBlossomWithProgress(
  url: string,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
  skipServers?: string[],
): Promise<{ data: Uint8Array; verified: boolean; hash: string | null; serverUrl: string }> {
  // Extract hash from blossom-style URL (last path segment = 64-char hex)
  const pathParts = new URL(url).pathname.split('/').filter(Boolean)
  const lastSegment = pathParts[pathParts.length - 1] || ''
  const isBlossom = /^[a-f0-9]{64}$/i.test(lastSegment)
  const expectedHash = isBlossom ? lastSegment.toLowerCase() : null

  // If we should try alternative servers (after a failure), build server list
  const serversToTry: string[] = [url]
  if (isBlossom && expectedHash) {
    const allServers = blossomServers.getServers()
    const urlOrigin = new URL(url).origin
    const skipSet = new Set([...(skipServers || []), urlOrigin])
    for (const s of allServers) {
      const norm = normalize(s)
      if (!skipSet.has(norm)) {
        serversToTry.push(`${norm}/${expectedHash}`)
      }
    }
  }

  for (const tryUrl of serversToTry) {
    try {
      const result = await _downloadWithXHR(tryUrl, onProgress, signal)
      if (!result) continue

      // Verify hash if this is a blossom URL
      if (expectedHash) {
        const actualHash = computeHash(result.data)
        return {
          data: result.data,
          verified: actualHash === expectedHash,
          hash: actualHash,
          serverUrl: tryUrl,
        }
      }

      return { data: result.data, verified: true, hash: null, serverUrl: tryUrl }
    } catch {
      continue
    }
  }

  throw new Error('Download failed from all sources')
}

/** Internal: XHR download with progress */
function _downloadWithXHR(
  url: string,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<{ data: Uint8Array } | null> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', url)
    xhr.responseType = 'arraybuffer'

    let startTime = Date.now()

    const handleAbort = () => {
      try { xhr.abort() } catch { /* ignore */ }
      resolve(null)
    }
    if (signal) {
      if (signal.aborted) { resolve(null); return }
      signal.addEventListener('abort', handleAbort, { once: true })
    }

    xhr.onprogress = (event) => {
      if (event.lengthComputable) {
        const elapsed = (Date.now() - startTime) / 1000
        const speed = elapsed > 0 ? event.loaded / elapsed : 0
        onProgress?.({
          serverUrl: url,
          percent: Math.round((event.loaded / event.total) * 100),
          speed,
          loaded: event.loaded,
          total: event.total,
        })
      }
    }

    xhr.onload = () => {
      signal?.removeEventListener('abort', handleAbort)
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
        resolve({ data: new Uint8Array(xhr.response as ArrayBuffer) })
      } else {
        resolve(null)
      }
    }

    xhr.onerror = () => { signal?.removeEventListener('abort', handleAbort); resolve(null) }
    xhr.onabort = () => { signal?.removeEventListener('abort', handleAbort); resolve(null) }

    xhr.send()
  })
}

/**
 * Download and parse a text file from Blossom.
 */
export async function downloadTextFromBlossom(
  hash: string,
  servers?: string[],
): Promise<string> {
  const data = await downloadFromBlossom(hash, servers)
  return new TextDecoder().decode(data)
}

// ─── Delete ───

/**
 * Request deletion of a file by SHA-256 hash from Blossom servers.
 * Per BUD-02: sends DELETE /<hash> with kind 24242 auth header (t=delete).
 *
 * This is fire-and-forget per server — failures are logged but never thrown.
 * Servers may reject the request if the file wasn't uploaded by this user.
 *
 * SAFETY: Only call this AFTER verifying the replacement file is uploaded
 * and downloadable. Never delete a hash that is still referenced by a
 * live index or hub event.
 *
 * @param hash - SHA-256 hash of the file to delete
 * @param signer - ISigner for auth
 * @param privateKey - Raw private key hex
 * @param servers - Blossom servers to send delete requests to
 * @returns Count of successful and failed deletions
 */
export async function deleteFromBlossom(
  hash: string,
  signer: ISigner | null,
  privateKey: string | null,
  servers?: string[],
): Promise<{ deleted: number; failed: number }> {
  const targetServers = servers || blossomServers.getServers()
  const authHeader = await createAuthHeader('delete', hash, signer, privateKey)

  let deleted = 0
  let failed = 0

  for (const server of targetServers) {
    try {
      const url = `${normalize(server)}/${hash}`
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: authHeader },
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok || res.status === 404) {
        // 404 is fine — file already gone
        deleted++
      } else {
        failed++
        console.warn(`Blossom DELETE ${hash} from ${server}: ${res.status}`)
      }
    } catch (err) {
      failed++
      console.warn(`Blossom DELETE ${hash} from ${server} failed:`, err)
    }
  }

  if (deleted > 0) {
    console.log(`Blossom: deleted ${hash} from ${deleted}/${targetServers.length} servers`)
  }

  return { deleted, failed }
}
