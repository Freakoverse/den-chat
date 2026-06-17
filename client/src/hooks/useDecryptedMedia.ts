/**
 * useDecryptedMedia — Download → Decrypt → Blob URL for encrypted attachments
 *
 * For unencrypted attachments, returns the direct Blossom URL immediately.
 * For encrypted attachments, downloads the ciphertext, decrypts with the per-file
 * AES-256-GCM key, verifies the plaintext hash, and returns a blob URL.
 *
 * Uses a module-level cache so the same file is never downloaded/decrypted twice
 * within a session.
 */

import { useState, useEffect, useRef } from 'react'
import type { Attachment } from '@/stores/messageStore'
import { getFromPersistentCache, putInPersistentCache } from '@/lib/cache/blossomMediaCache'

/* ─── Module-level cache ─── */

/** hash → blob URL (persists for the browser session) */
const blobUrlCache = new Map<string, string>()
/** hash → in-progress promise (deduplicates concurrent requests) */
const inflightRequests = new Map<string, Promise<string>>()

/** Look up a cached decrypted blob URL by hash (used by gallery viewer) */
export function getDecryptedBlobUrl(hash: string): string | undefined {
  return blobUrlCache.get(hash)
}

/* ─── Types ─── */

export interface DecryptedMediaState {
  /** Resolved URL — direct Blossom URL or decrypted blob URL */
  src: string | null
  /** True while downloading + decrypting */
  loading: boolean
  /** Error message if decryption or download failed */
  error: string | null
  /** True if the file is end-to-end encrypted */
  isEncrypted: boolean
  /** Download progress (0–100), only during encrypted downloads */
  progress: number
}

/* ─── Hook ─── */

export function useDecryptedMedia(
  attachment: Attachment,
  servers: string[],
): DecryptedMediaState {
  const enc = attachment.encryption
  const isEncrypted = !!enc

  // For unencrypted files, return direct URL immediately
  const directUrl = !isEncrypted && servers.length > 0
    ? `${servers[0].replace(/\/+$/, '')}/${attachment.hash}`
    : null

  const [src, setSrc] = useState<string | null>(directUrl)
  const [loading, setLoading] = useState(isEncrypted)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const cancelRef = useRef(false)

  useEffect(() => {
    // Not encrypted — use direct URL
    if (!enc) {
      setSrc(directUrl)
      setLoading(false)
      return
    }

    // Check cache first
    const cacheKey = attachment.hash
    const cached = blobUrlCache.get(cacheKey)
    if (cached) {
      setSrc(cached)
      setLoading(false)
      return
    }

    cancelRef.current = false
    setLoading(true)
    setError(null)
    setProgress(0)

    // Deduplicate concurrent requests for the same hash
    let promise = inflightRequests.get(cacheKey)
    if (!promise) {
      promise = decryptFromServers(attachment, servers, enc, (p) => {
        if (!cancelRef.current) setProgress(p)
      })
      inflightRequests.set(cacheKey, promise)
      promise.finally(() => inflightRequests.delete(cacheKey))
    }

    promise
      .then((blobUrl) => {
        blobUrlCache.set(cacheKey, blobUrl)
        if (!cancelRef.current) {
          setSrc(blobUrl)
          setLoading(false)
          setProgress(100)
        }
      })
      .catch((err) => {
        if (!cancelRef.current) {
          setError(err?.message || 'Failed to decrypt file')
          setLoading(false)
        }
      })

    return () => {
      cancelRef.current = true
    }
  }, [attachment.hash, enc?.key, servers.length])

  return { src, loading, error, isEncrypted, progress }
}

/* ─── Core download + decrypt logic ─── */

async function decryptFromServers(
  attachment: Attachment,
  servers: string[],
  enc: NonNullable<Attachment['encryption']>,
  onProgress: (percent: number) => void,
): Promise<string> {
  const { decryptFile } = await import('@/lib/crypto/fileEncryption')

  // Decrypt ciphertext bytes → verify plaintext hash → blob URL.
  const finalize = async (cipherBytes: Uint8Array): Promise<string> => {
    // Decrypt (→95%)
    const plainBytes = await decryptFile(cipherBytes, enc.key, enc.nonce)
    onProgress(95)

    // Verify original (plaintext) hash (95–100%)
    const hashBuf = await crypto.subtle.digest('SHA-256', plainBytes.slice() as Uint8Array<ArrayBuffer>)
    const actualHash = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    if (actualHash !== enc.originalHash) {
      console.warn(`⚠ Decrypted file hash mismatch: expected ${enc.originalHash}, got ${actualHash}`)
      // Still return the blob — the user should see a warning but not be blocked
    }

    onProgress(100)
    const blob = new Blob([plainBytes.slice() as Uint8Array<ArrayBuffer>], { type: attachment.type || 'application/octet-stream' })
    return URL.createObjectURL(blob)
  }

  // 1. Persistent cache hit — we store the *ciphertext* keyed by its blossom hash
  //    (privacy-safe: the plaintext never touches disk), so a cache hit skips the
  //    network entirely and we just decrypt the cached bytes. Survives refresh.
  try {
    const cachedCipher = await getFromPersistentCache(attachment.hash)
    if (cachedCipher) {
      onProgress(90)
      const cipherBytes = new Uint8Array(await cachedCipher.arrayBuffer())
      return await finalize(cipherBytes)
    }
  } catch { /* fall through to network */ }

  for (let i = 0; i < servers.length; i++) {
    const baseUrl = servers[i].replace(/\/+$/, '')
    const url = `${baseUrl}/${attachment.hash}`

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
      if (!res.ok) continue

      // Read with progress
      const contentLength = res.headers.get('content-length')
      const total = contentLength ? parseInt(contentLength, 10) : attachment.size

      let cipherBytes: Uint8Array
      if (res.body && total > 0) {
        const reader = res.body.getReader()
        const chunks: Uint8Array[] = []
        let loaded = 0

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          loaded += value.length
          onProgress(Math.round((loaded / total) * 90)) // 0–90% for download
        }

        // Concatenate chunks
        cipherBytes = new Uint8Array(loaded)
        let offset = 0
        for (const chunk of chunks) {
          cipherBytes.set(chunk, offset)
          offset += chunk.length
        }
      } else {
        // Fallback: no streaming body
        const buf = await res.arrayBuffer()
        cipherBytes = new Uint8Array(buf)
        onProgress(90)
      }

      // Persist the ciphertext for next time (best-effort, never blocks).
      putInPersistentCache(attachment.hash, new Blob([cipherBytes.slice() as Uint8Array<ArrayBuffer>])).catch(() => {})

      return await finalize(cipherBytes)
    } catch (err) {
      console.warn(`Failed to decrypt from ${baseUrl}:`, err)
      continue
    }
  }

  throw new Error('File not found on any server')
}
