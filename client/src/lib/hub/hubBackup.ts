/**
 * hubBackup — export/restore a hub's full definition + Blossom member data.
 *
 * A backup is a single gzipped JSON bundle held on the USER'S disk. It never goes
 * to Blossom as a bundle — Blossom is one-blob-per-SHA256 with no archives. On
 * restore we unpack and upload each blob individually, byte-identical, so every
 * hash matches what the index references and the hub resolves again.
 *
 *   { v: 1, exportedAt, event: <signed 36942>, blobs: { "<sha256>": "<base64>" } }
 *
 * Scale: this is deliberately for small/normal hubs. It collects everything in
 * memory, so it's capped (see MAX_BACKUP_RAW_BYTES). Normal hub use is paginated
 * (a client only fetches its own leaf page); a backup is inherently O(all members),
 * which is why it can't scale to mega-hubs. The cap fails fast + loud instead.
 */

import { downloadFromBlossom, parseIndexFile, computeHash } from '@/lib/blossom'
import { KINDS } from '@/lib/crypto/constants'
import type { HubData } from '@/stores/hubStore'
import { verifyEvent, type Event } from 'nostr-tools'

/** Hard ceiling on raw (decompressed) blob bytes — export refuses to create, restore refuses to accept.
 *  Sized so peak memory stays ~150-200MB (base64 + JSON string), which is safe on mobile too. */
export const MAX_BACKUP_RAW_BYTES = 50 * 1024 * 1024
/** Above this we warn the user it'll be a big file, but still allow it. */
export const WARN_BACKUP_RAW_BYTES = 10 * 1024 * 1024
/** Reject an absurd .gz before we even decompress it (cheap first line of defence). */
export const MAX_BACKUP_COMPRESSED_BYTES = 100 * 1024 * 1024
/** Rough per-member cost used only for the pre-flight estimate. */
const BYTES_PER_MEMBER_EST = 350

export interface HubBackupBundle {
  v: 1
  exportedAt: number
  event: Event
  blobs: Record<string, string>
}

export const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

// ── base64 (chunked so we don't blow the arg limit on big blobs) ──

function toB64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ── gzip via native streams (no dependency) ──

async function gzip(bytes: Uint8Array): Promise<Blob> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
  return await new Response(stream).blob()
}

/**
 * Decompress INCREMENTALLY, aborting past `maxBytes`. This is the gzip-bomb guard:
 * a ~1MB .gz can expand to 1GB, so we must never buffer the whole stream blindly.
 */
async function gunzipCapped(file: File, maxBytes: number): Promise<Uint8Array> {
  const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error(`This file expands past the ${fmtBytes(maxBytes)} limit — refusing to load it (possible decompression bomb or a hub too large for this tool).`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
}

// ── Export ──

/** Enumerate every Blossom blob the hub depends on, from its index file. */
export async function collectHubBlobHashes(hub: HubData): Promise<{ hashes: string[]; estimatedMembers: number }> {
  if (!hub.indexFileHash) throw new Error('This hub has no member index file to back up.')

  const indexBytes = await downloadFromBlossom(hub.indexFileHash, hub.blossomServers)
  const index = parseIndexFile(new TextDecoder().decode(indexBytes))

  const hashes: string[] = [hub.indexFileHash]
  let estimatedMembers = 0

  if (index.pageSize > 0) {
    // Paginated tree: spine + EVERY leaf page (a backup needs them all, unlike normal use).
    if (index.spineHash) hashes.push(index.spineHash)
    for (const p of index.leafPages) hashes.push(p.hash)
    estimatedMembers = index.leafPages.length * index.pageSize
  } else if (index.treeHash) {
    hashes.push(index.treeHash) // monolithic
  }
  if (index.historyHash) hashes.push(index.historyHash)
  for (const b of index.banPages) hashes.push(b.hash)
  for (const gt of index.groupTrees) hashes.push(gt.hash)

  return { hashes: [...new Set(hashes.filter(Boolean))], estimatedMembers }
}

/**
 * Build a gzipped backup bundle. Guards twice:
 *  1. pre-flight estimate from the index's page count (fails before any heavy download)
 *  2. a running byte counter during the fetch (authoritative — doesn't trust the estimate)
 */
export async function buildHubBackup(
  hub: HubData,
  event: Event,
  onProgress?: (done: number, total: number, bytes: number) => void,
): Promise<Blob> {
  const { hashes, estimatedMembers } = await collectHubBlobHashes(hub)

  const estBytes = estimatedMembers * BYTES_PER_MEMBER_EST
  if (estBytes > MAX_BACKUP_RAW_BYTES) {
    throw new Error(
      `This hub is too large to back up here (~${estimatedMembers.toLocaleString()} members, ≈${fmtBytes(estBytes)}). ` +
      `The limit is ${fmtBytes(MAX_BACKUP_RAW_BYTES)}.`,
    )
  }

  const blobs: Record<string, string> = {}
  let total = 0
  for (let i = 0; i < hashes.length; i++) {
    const bytes = await downloadFromBlossom(hashes[i], hub.blossomServers)
    total += bytes.length
    if (total > MAX_BACKUP_RAW_BYTES) {
      throw new Error(`This hub's data passed the ${fmtBytes(MAX_BACKUP_RAW_BYTES)} limit while downloading — export aborted.`)
    }
    blobs[hashes[i]] = toB64(bytes)
    onProgress?.(i + 1, hashes.length, total)
  }

  const bundle: HubBackupBundle = { v: 1, exportedAt: Math.floor(Date.now() / 1000), event, blobs }
  return gzip(new TextEncoder().encode(JSON.stringify(bundle)))
}

// ── Restore ──

/**
 * Parse + validate an untrusted backup file. Guards: compressed-size sanity,
 * bomb-safe capped decompression, structure, event kind + signature, and a
 * per-blob SHA-256 check (so we never upload junk that could never resolve).
 */
export async function parseHubBackup(file: File): Promise<{ event: Event; blobs: Map<string, Uint8Array>; exportedAt: number }> {
  if (file.size > MAX_BACKUP_COMPRESSED_BYTES) {
    throw new Error(`That file is ${fmtBytes(file.size)} — too large to be a valid hub backup.`)
  }

  const raw = await gunzipCapped(file, MAX_BACKUP_RAW_BYTES)

  let bundle: HubBackupBundle
  try {
    bundle = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    throw new Error('Could not read that file — it is not a valid hub backup.')
  }

  if (bundle?.v !== 1 || !bundle.event || !bundle.blobs || typeof bundle.blobs !== 'object') {
    throw new Error('That file is not a DEN hub backup bundle.')
  }
  if (bundle.event.kind !== KINDS.HUB_EVENT) {
    throw new Error('That backup does not contain a hub event (kind 36942).')
  }
  if (!verifyEvent(bundle.event)) {
    throw new Error('The hub event signature is invalid — refusing to restore a tampered backup.')
  }

  const blobs = new Map<string, Uint8Array>()
  for (const [hash, b64] of Object.entries(bundle.blobs)) {
    let bytes: Uint8Array
    try {
      bytes = fromB64(b64)
    } catch {
      throw new Error(`Corrupt backup — a blob could not be decoded (${hash.slice(0, 12)}…).`)
    }
    // Content addressing: if the bytes don't hash to the declared key, the blob would
    // land under a different hash on upload and never resolve from the index.
    if (computeHash(bytes) !== hash.toLowerCase()) {
      throw new Error(`Corrupt backup — a blob does not match its hash (${hash.slice(0, 12)}…).`)
    }
    blobs.set(hash.toLowerCase(), bytes)
  }

  return { event: bundle.event, blobs, exportedAt: bundle.exportedAt }
}
