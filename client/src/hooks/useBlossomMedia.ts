/**
 * useBlossomMedia — Optimistic blossom rendering + background SHA-256 verification
 *
 * Instead of download-then-verify-then-render, this hook:
 * 1. Immediately returns a direct server URL for the browser to render natively
 * 2. Verifies the file hash in the background
 * 3. Fails over to other servers if hash mismatches or network errors occur
 *
 * Usage:
 *   const media = useBlossomMedia(originalUrl)
 *   <img src={media.src} />
 *   <VerificationBadge verified={media.verified} ... />
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { blossomServers } from '@/lib/blossom'
import { setCachedSize, hasSizeOverride, checkImageSize as headCheckSize } from '@/lib/imageSizeGuard'

// ── Blossom URL detection ──

/** Known blossom server hostnames (without protocol) */
const KNOWN_BLOSSOM_HOSTS = [
  'blossom.primal.net', 'blossom.band', 'blossom.nostr.hu',
  'cdn.sovbit.host', 'blossom.data.haus',
  'video.nostr.build', 'image.nostr.build',
]

/** SHA-256 hash pattern: 64 hex characters */
const SHA256_RE = /^[a-f0-9]{64}$/i

interface BlossomParsed {
  hash: string
  ext: string         // e.g. ".jpg" or "" (bare hash)
  originServer: string // e.g. "https://blossom.primal.net"
}

/**
 * Parse a URL to see if it's a blossom hash URL.
 * Supports:
 *   https://blossom.primal.net/<sha256>
 *   https://blossom.primal.net/<sha256>.jpg
 *   https://any-configured-server/<sha256>
 */
function parseBlossomUrl(url: string): BlossomParsed | null {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.replace('www.', '')

    // Check if it's a known blossom host OR a user-configured server
    const configuredServers = blossomServers.getServers()
    const isBlossomHost = KNOWN_BLOSSOM_HOSTS.includes(hostname) ||
      configuredServers.some(s => {
        try { return new URL(s).hostname.replace('www.', '') === hostname } catch { return false }
      })

    if (!isBlossomHost) return null

    // Extract path — should be /<hash> or /<hash>.ext
    const pathParts = parsed.pathname.replace(/^\//, '').split('.')
    const hash = pathParts[0]
    const ext = pathParts.length > 1 ? `.${pathParts.slice(1).join('.')}` : ''

    if (!SHA256_RE.test(hash)) return null

    return {
      hash,
      ext,
      originServer: `${parsed.protocol}//${parsed.host}`,
    }
  } catch {
    return null
  }
}

// ── SHA-256 verification ──

async function hashBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── Types ──

export type VerificationStatus = 'pending' | 'verified' | 'tampered'

export type BlossomMediaState = {
  /** Direct URL for immediate rendering (updated on failover) */
  src: string
  /** Whether we're still finding a responsive server */
  loading: boolean
  /** Hash verification status */
  verified: VerificationStatus
  /** Error — only set when NO server responded at all */
  error: false | 'not-found'
  /** Current server attempt index (0-based) */
  serverIndex: number
  /** Total servers being tried */
  totalServers: number
  /** The expected SHA-256 hash (for recovery modal) */
  expectedHash: string
  /** All servers available (for recovery modal) */
  servers: string[]
  /** File extension (for recovery modal) */
  ext: string
  /** Manually trigger re-verification from a specific server index */
  retryVerification: (fromServerIndex?: number) => void
  /** Accept an externally verified blob URL (from recovery modal) */
  acceptVerifiedUrl: (blobUrl: string) => void
  /** True if the image exceeds the configured render size limit */
  sizeExceeded: boolean
  /** Detected file size in bytes (from HEAD Content-Length), or undefined */
  detectedSize: number | undefined
}

// ── Global cache for verified hashes (avoid re-verifying the same file) ──
const verifiedCache = new Map<string, { serverUrl: string }>()

/**
 * Hook that provides optimistic blossom media rendering with background hash verification.
 * Returns a direct URL immediately so the browser can render/stream natively.
 */
export function useBlossomMedia(originalUrl: string | undefined, maxSizeMB?: number): BlossomMediaState {
  const parsed = useMemo(() => originalUrl ? parseBlossomUrl(originalUrl) : null, [originalUrl])

  // Build server list: origin first, then all configured servers (deduplicated)
  const servers = useMemo(() => {
    if (!parsed) return []
    const all = blossomServers.getServers()
    const ordered = [parsed.originServer]
    for (const s of all) {
      const norm = s.replace(/\/+$/, '')
      if (!ordered.includes(norm)) ordered.push(norm)
    }
    return ordered
  }, [parsed])

  const [currentSrc, setCurrentSrc] = useState('')
  const [verified, setVerified] = useState<VerificationStatus>('pending')
  const [error, setError] = useState<false | 'not-found'>(false)
  const [serverIdx, setServerIdx] = useState(0)
  const [loading, setLoading] = useState(false)
  const [sizeExceeded, setSizeExceeded] = useState(false)
  const [detectedSize, setDetectedSize] = useState<number | undefined>(undefined)
  const cancelRef = useRef(false)
  const verifyingRef = useRef(false)

  // Compute the limit in bytes (undefined = no limit)
  const limitBytes = maxSizeMB != null && maxSizeMB > 0 ? maxSizeMB * 1024 * 1024 : undefined

  // Build a URL from server index
  const buildUrl = useCallback((idx: number) => {
    if (!parsed || idx >= servers.length) return ''
    return `${servers[idx].replace(/\/+$/, '')}/${parsed.hash}${parsed.ext}`
  }, [parsed, servers])

  // ── Phase 1: Find a responsive server (HEAD) and set src immediately ──
  useEffect(() => {
    if (!parsed || servers.length === 0) return
    cancelRef.current = false
    verifyingRef.current = false

    // Check if already verified in cache
    const cached = verifiedCache.get(parsed.hash)
    if (cached) {
      const cachedUrl = `${cached.serverUrl.replace(/\/+$/, '')}/${parsed.hash}${parsed.ext}`
      setCurrentSrc(cachedUrl)
      setVerified('verified')
      setLoading(false)
      setError(false)
      return
    }

    setLoading(true)
    setError(false)
    setVerified('pending')
    setServerIdx(0)
    setSizeExceeded(false)
    setDetectedSize(undefined)

    const findServer = async () => {
      for (let i = 0; i < servers.length; i++) {
        if (cancelRef.current) return
        const url = buildUrl(i)
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 5000)
          const res = await fetch(url, { method: 'HEAD', signal: controller.signal })
          clearTimeout(timer)
          if (res.ok) {
            if (cancelRef.current) return

            // ── Size limit check (Tier 1: HEAD Content-Length) ──
            const cl = res.headers.get('content-length')
            if (cl) {
              const sizeBytes = Number(cl)
              if (!isNaN(sizeBytes) && sizeBytes > 0) {
                setCachedSize(url, sizeBytes)
                setDetectedSize(sizeBytes)
                if (limitBytes && !hasSizeOverride(originalUrl || '') && sizeBytes > limitBytes) {
                  setSizeExceeded(true)
                  setLoading(false)
                  return
                }
              }
            } else {
              setCachedSize(url, 'unknown')
            }

            setCurrentSrc(url)
            setServerIdx(i)
            setLoading(false)
            // Start background verification
            verifyInBackground(i)
            return
          }
        } catch {
          // Server didn't respond, try next
        }
      }
      // No server responded at all
      if (!cancelRef.current) {
        setError('not-found')
        setLoading(false)
      }
    }

    // Background hash verification
    const verifyInBackground = async (fromIdx: number) => {
      if (verifyingRef.current) return
      verifyingRef.current = true
      let hadTampered = false

      for (let i = fromIdx; i < servers.length; i++) {
        if (cancelRef.current) { verifyingRef.current = false; return }
        const baseUrl = servers[i].replace(/\/+$/, '')
        const srcUrl = `${baseUrl}/${parsed.hash}${parsed.ext}`

        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 30000)
          const res = await fetch(srcUrl, { signal: controller.signal })
          clearTimeout(timer)
          if (!res.ok) continue

          const blob = await res.blob()
          if (cancelRef.current) { verifyingRef.current = false; return }

          const actualHash = await hashBlob(blob)
          if (actualHash === parsed.hash) {
            // Verified! Cache it
            verifiedCache.set(parsed.hash, { serverUrl: baseUrl })
            if (!cancelRef.current) {
              // If verified from a different server, update src to the verified one
              if (i !== fromIdx) {
                setCurrentSrc(srcUrl)
                setServerIdx(i)
              }
              setVerified('verified')
            }
            verifyingRef.current = false
            return
          } else {
            console.warn(`⚠ Blossom hash mismatch from ${baseUrl}: expected ${parsed.hash}, got ${actualHash}`)
            hadTampered = true
            // Do NOT swap currentSrc here — keep showing the image from Phase 1.
            // The verification continues trying other servers in the background.
          }
        } catch {
          // Network error — try next server silently.
          // Do NOT swap currentSrc — keep the working Phase 1 image displayed.
        }
      }

      // All servers exhausted — keep showing the image (Phase 1 confirmed it exists)
      // Only set tampered if we actually detected hash mismatches; otherwise stay pending
      if (!cancelRef.current) {
        setVerified(hadTampered ? 'tampered' : 'pending')
      }
      verifyingRef.current = false
    }

    findServer()
    return () => { cancelRef.current = true }
  }, [parsed, servers, buildUrl, limitBytes, originalUrl])

  // ── Manual retry (for recovery modal) ──
  const retryVerification = useCallback((fromServerIndex?: number) => {
    if (!parsed || servers.length === 0) return
    cancelRef.current = false
    verifyingRef.current = false
    setVerified('pending')
    setError(false)

    const startIdx = fromServerIndex ?? 0

    const doRetry = async () => {
      verifyingRef.current = true
      let hadTampered = false

      for (let i = startIdx; i < servers.length; i++) {
        if (cancelRef.current) { verifyingRef.current = false; return }
        const baseUrl = servers[i].replace(/\/+$/, '')
        const srcUrl = `${baseUrl}/${parsed.hash}${parsed.ext}`

        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 30000)
          const res = await fetch(srcUrl, { signal: controller.signal })
          clearTimeout(timer)
          if (!res.ok) continue

          const blob = await res.blob()
          if (cancelRef.current) { verifyingRef.current = false; return }

          const actualHash = await hashBlob(blob)
          if (actualHash === parsed.hash) {
            verifiedCache.set(parsed.hash, { serverUrl: baseUrl })
            if (!cancelRef.current) {
              setCurrentSrc(srcUrl)
              setServerIdx(i)
              setVerified('verified')
            }
            verifyingRef.current = false
            return
          } else {
            hadTampered = true
          }
        } catch { /* try next */ }
      }

      if (!cancelRef.current) {
        setVerified(hadTampered ? 'tampered' : 'pending')
        if (!hadTampered) setError('not-found')
      }
      verifyingRef.current = false
    }

    doRetry()
  }, [parsed, servers])

  // ── Accept externally verified blob URL ──
  const acceptVerifiedUrl = useCallback((blobUrl: string) => {
    setCurrentSrc(blobUrl)
    setVerified('verified')
    if (parsed) {
      verifiedCache.set(parsed.hash, { serverUrl: 'blob' })
    }
  }, [parsed])

  // ── Non-blossom URL: standalone size check ──
  const [nonBlossomSizeExceeded, setNonBlossomSizeExceeded] = useState(false)
  const [nonBlossomSize, setNonBlossomSize] = useState<number | undefined>(undefined)

  useEffect(() => {
    if (parsed || !originalUrl || !limitBytes || hasSizeOverride(originalUrl)) return
    let cancelled = false

    headCheckSize(originalUrl).then((result) => {
      if (cancelled) return
      if (typeof result === 'number') {
        setNonBlossomSize(result)
        if (result > limitBytes) setNonBlossomSizeExceeded(true)
      }
      // If 'unknown', we allow it through (can't determine size from HEAD)
    })

    return () => { cancelled = true }
  }, [parsed, originalUrl, limitBytes])

  // Not a blossom URL — return original unchanged
  if (!parsed) {
    return {
      src: nonBlossomSizeExceeded ? '' : (originalUrl || ''),
      loading: false,
      verified: 'verified',
      error: false,
      serverIndex: 0,
      totalServers: 0,
      expectedHash: '',
      servers: [],
      ext: '',
      retryVerification: () => {},
      acceptVerifiedUrl: () => {},
      sizeExceeded: nonBlossomSizeExceeded,
      detectedSize: nonBlossomSize,
    }
  }

  return {
    src: sizeExceeded ? '' : currentSrc,
    loading,
    verified,
    error,
    serverIndex: serverIdx,
    totalServers: servers.length,
    expectedHash: parsed.hash,
    servers,
    ext: parsed.ext,
    retryVerification,
    acceptVerifiedUrl,
    sizeExceeded,
    detectedSize,
  }
}

// ── Standalone hash verification (for BlobImage/BlobMedia/BlobFile that don't use the hook) ──

export { parseBlossomUrl, hashBlob, verifiedCache, KNOWN_BLOSSOM_HOSTS, SHA256_RE }
export type { BlossomParsed }
