/**
 * hubBlossomHealth — creator-side repair for a hub whose ADVERTISED Blossom servers have rotted.
 *
 * A hub's `blossomServers` list is frozen at creation (the first 3 client defaults at the time) and
 * the public servers underneath it change policy or die — the pre-2026-08 default {primal, band,
 * nostr.hu} is now 415 / 401 / CORS-blocked across the board. Members then try dead servers first on
 * every load, and writes only still work because of the client-server upload fallback. This module
 * lets the creator FIX the advertised list, deliberately:
 *
 *   probeServers        — test candidates with the hub's REAL index + spine, uploaded exactly as
 *                         production does (text/plain, the hub's auth signer O/P, NO client fallback)
 *                         and read back hash-verified from that server only. A synthetic test blob
 *                         would false-pass a server that rejects text/plain (band's exact failure).
 *                         There is no cleanup: a passing probe leaves the real blobs on the server,
 *                         which is precisely the state we want it in.
 *   mirrorTreeToServers — put EVERY tree blob on the chosen servers (BUD-04 mirror first, byte-upload
 *                         fallback — see mirrorHash) and verify each server serves each blob. Only
 *                         fully-verified servers should be published: a list we haven't proven
 *                         end-to-end would just move the problem to new servers.
 *   republishHubWithBlossomServers — the same hub-event republish Hub Settings uses, with only the
 *                         blossom list changed. An explicit owner action; nothing here publishes on
 *                         its own.
 */

import type { HubData } from '@/stores/hubStore'
import type { ISigner } from '@/stores/userStore'
import { blossomServers, downloadTextFromBlossom, parseIndexFile, computeHash } from '@/lib/blossom'
import { downloadFromBlossomDetailed, uploadToBlossomServersOnce, type BlossomAuthSigner } from '@/lib/blossom/client'
import { mirrorHash, headExists } from '@/lib/blossom/blossomRedundancy'
import { cacheHubBlob, getCachedHubBlob } from '@/lib/blossom/hubBlobStore'

/** What the member-tree files are uploaded as in production (treeUpdater) — the probe must match it. */
const TREE_CONTENT_TYPE = 'text/plain'

const normalize = (u: string) => u.replace(/\/+$/, '')

export interface ServerCheck {
  server: string
  ok: boolean
  reason?: string
}

/** Curated client defaults the hub doesn't already advertise — the replacement candidates. */
export function replacementCandidates(hub: HubData): string[] {
  const advertised = new Set(hub.blossomServers.map(normalize))
  return blossomServers.getServers().map(normalize).filter((s) => !advertised.has(s))
}

/** Every content-addressed blob the hub's member tree references, index first. */
export async function listHubTreeHashes(hub: HubData): Promise<Array<{ hash: string; label: string }>> {
  const out: Array<{ hash: string; label: string }> = [{ hash: hub.indexFileHash, label: 'index' }]
  const index = parseIndexFile(await downloadTextFromBlossom(hub.indexFileHash, hub.blossomServers))
  if (index.spineHash) out.push({ hash: index.spineHash, label: 'spine' })
  if (index.historyHash) out.push({ hash: index.historyHash, label: 'history' })
  for (const p of index.leafPages) out.push({ hash: p.hash, label: `page ${p.pageIndex}` })
  for (const b of index.banPages) out.push({ hash: b.hash, label: `ban page ${b.page}` })
  for (const g of index.groupTrees) out.push({ hash: g.hash, label: `group ${g.groupId.slice(0, 8)}` })
  return out.filter((e) => !!e.hash)
}

/**
 * A tree blob's bytes plus a URL some server currently serves it from (a BUD-04 source). Tries the
 * hub's servers then the client defaults; else our local retention (no source URL in that case).
 */
async function fetchBlob(hub: HubData, hash: string): Promise<{ bytes: Uint8Array; sourceUrl?: string } | null> {
  try {
    const { data, servedBy } = await downloadFromBlossomDetailed(hash, hub.blossomServers)
    return { bytes: data, sourceUrl: `${servedBy}/${hash}` }
  } catch { /* fall through to local retention */ }
  const local = await getCachedHubBlob(hash)
  return local ? { bytes: local } : null
}

/** Read a blob back from ONE server — no fallback — and verify its sha256. */
async function readBackVerified(server: string, hash: string): Promise<void> {
  const res = await fetch(`${normalize(server)}/${hash}`, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`read-back ${res.status}`)
  const data = new Uint8Array(await res.arrayBuffer())
  if (computeHash(data) !== hash) throw new Error('read-back hash mismatch')
}

/**
 * Probe `servers` with the hub's real index + spine: production content-type, production auth signer,
 * no-fallback upload, then a hash-verified read-back from that server alone. `onResult` fires per
 * server so a UI can fill in as it goes.
 */
export async function probeServers(
  hub: HubData,
  servers: string[],
  opts: { signer: ISigner | null; privateKey: string | null; authSigner?: BlossomAuthSigner },
  onResult?: (r: ServerCheck) => void,
): Promise<ServerCheck[]> {
  // Real index + spine — small, always present, same type/auth as every production tree upload.
  const probes = (await listHubTreeHashes(hub)).filter((e) => e.label === 'index' || e.label === 'spine')
  const blobs: Array<{ hash: string; bytes: Uint8Array }> = []
  for (const p of probes) {
    const got = await fetchBlob(hub, p.hash)
    if (got) blobs.push({ hash: p.hash, bytes: got.bytes })
  }
  if (blobs.length === 0) throw new Error('Could not obtain the hub index/spine to test with.')

  const results: ServerCheck[] = []
  for (const server of servers) {
    let ok = true
    let reason: string | undefined
    for (const { hash, bytes } of blobs) {
      try {
        // No-fallback upload: a rejection must surface as THIS server's failure, not get rescued.
        await uploadToBlossomServersOnce(bytes, opts.signer, opts.privateKey, [server], TREE_CONTENT_TYPE, undefined, undefined, opts.authSigner)
        await readBackVerified(server, hash)
      } catch (e) {
        ok = false
        reason = (e instanceof Error ? e.message : String(e))
          .replace(/^Upload failed: no Blossom servers accepted the file\s*/, '')
          .replace(/^\(|\)$/g, '')
          .trim() || 'rejected'
        break
      }
    }
    const r: ServerCheck = { server: normalize(server), ok, reason }
    results.push(r)
    onResult?.(r)
  }
  return results
}

/**
 * Mirror the FULL tree to `servers` (BUD-04 first, byte upload fallback — see mirrorHash) and verify
 * every blob is served by every server. Returns the servers that fully verified; the rest are reported
 * with the blob that failed. Only the verified servers should be published.
 */
export async function mirrorTreeToServers(
  hub: HubData,
  servers: string[],
  opts: { authSigner?: BlossomAuthSigner },
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<{ verified: string[]; failed: Array<{ server: string; reason: string }> }> {
  const blobs = await listHubTreeHashes(hub)
  const targets = servers.map(normalize)
  const failedBy = new Map<string, string>()
  let done = 0
  for (const b of blobs) {
    onProgress?.(done, blobs.length, b.label)
    // Seed local retention + learn a BUD-04 source, so mirrorHash always has bytes even when no target
    // holds the blob yet (its own local fallback only covers blobs THIS device has loaded before).
    const got = await fetchBlob(hub, b.hash)
    if (!got) {
      for (const s of targets) if (!failedBy.has(s)) failedBy.set(s, `${b.label} is unavailable everywhere`)
      done++
      continue
    }
    await cacheHubBlob(b.hash, got.bytes)
    await mirrorHash(b.hash, targets, b.label, targets.length, opts.authSigner, TREE_CONTENT_TYPE, got.sourceUrl)
    // Verify: every target must actually serve it (HEAD; the bytes were hash-verified on the way in).
    await Promise.all(targets.map(async (s) => {
      if (failedBy.has(s)) return
      if (!(await headExists(s, b.hash))) failedBy.set(s, `missing ${b.label} after mirror`)
    }))
    done++
  }
  onProgress?.(blobs.length, blobs.length, 'done')
  return {
    verified: targets.filter((s) => !failedBy.has(s)),
    failed: [...failedBy].map(([server, reason]) => ({ server, reason })),
  }
}

/**
 * Republish the hub event with ONLY its Blossom server list changed — the identical path Hub Settings
 * takes when the owner edits servers there (v2: encrypted content, signed as O; v1: mined + signed as
 * the creator), published with relay failover, then mirrored into the local store.
 */
export async function republishHubWithBlossomServers(
  hub: HubData,
  newServers: string[],
  opts: { pubkey: string; signer: ISigner | null; privateKey: string | null },
): Promise<void> {
  const { pubkey, signer, privateKey } = opts
  const { buildHubEvent, buildAndSignV2HubEvent } = await import('@/lib/hub/buildHubEvent')
  const { mineAndSign } = await import('@/lib/nostr')
  const { publishCriticalWithFailover } = await import('@/lib/nostr/relay-pool')
  const { getPublishRelays } = await import('@/stores/postingBehaviourStore')
  const { isV2 } = await import('@/lib/hub/version')
  const { useHubStore } = await import('@/stores/hubStore')

  const params = {
    dTag: hub.dTag,
    name: hub.name,
    description: hub.description || undefined,
    epoch: hub.epoch,
    icon: hub.icon || undefined,
    banner: hub.banner || undefined,
    tags: hub.tags && hub.tags.length > 0 ? hub.tags : undefined,
    relays: hub.generalRelays,
    blossomServers: newServers,
    indexFileHash: hub.indexFileHash,
    channels: hub.channels,
    categories: hub.categories,
    roles: hub.roles,
    minPow: hub.minPow > 0 ? hub.minPow : undefined,
    joinMinPow: hub.joinMinPow > 0 ? hub.joinMinPow : undefined,
        joinNote: hub.joinNote,
    messageExpiration: hub.messageExpiration && hub.messageExpiration > 0 ? hub.messageExpiration : undefined,
    nsfw: hub.nsfw || undefined,
    discoverable: hub.discoverable !== false,
    groupedRoles: hub.groupedRoles && hub.groupedRoles.length > 0 ? hub.groupedRoles : undefined,
    publishedAt: hub.publishedAt,
    eventCreatedAt: hub.eventCreatedAt,
  }

  let signed
  if (isV2(hub)) {
    const secretHex = useHubStore.getState().hubSecrets[hub.dTag]
    if (!secretHex) throw new Error('Hub secret not available')
    const { fromHex } = await import('@/lib/crypto/lkh')
    signed = await buildAndSignV2HubEvent({
      ...params,
      hubSecret: fromHex(secretHex),
      ownerRealPub: pubkey,
      ownerPub: hub.creatorPubkey,
      minPow: hub.minPow,
      privateKey,
      signer,
    })
  } else {
    signed = await mineAndSign(buildHubEvent(params), hub.minPow, pubkey, signer, privateKey)
  }

  // Zero relays accepted → fail loudly rather than advance local state and split-brain the hub.
  const accepted = await publishCriticalWithFailover(signed, getPublishRelays([...hub.generalRelays], { hubOnly: isV2(hub) }), [...hub.generalRelays])
  if (accepted.length === 0) throw new Error('The hub update was not accepted by any relay — please try again.')

  useHubStore.getState().setHubData(hub.dTag, { ...hub, blossomServers: newServers, eventCreatedAt: signed.created_at })
  useHubStore.getState().clearBlossomHealth(hub.dTag)
}
