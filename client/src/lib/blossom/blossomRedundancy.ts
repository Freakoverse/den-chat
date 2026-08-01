/**
 * blossomRedundancy — Cooperative Blossom file mirroring
 *
 * A hub's member list lives as a small tree of content-addressed Blossom files
 * (index → spine/tree, history, ban pages, and each member's own leaf page).
 * If a Blossom server purges a blob, that file can vanish unless someone
 * re-uploads it. This is the Blossom analogue of eventRedundancy: any member
 * who opens a hub checks that each critical file exists on at least
 * TARGET_COPIES servers and — because blobs are content-addressed and BUD-01
 * upload auth is tied to the uploader, not the content owner — re-uploads the
 * bytes (re-downloaded from a server that still has them) to servers missing it.
 *
 * Server fallback (deduped by normalized URL, in priority order):
 *   1. Hub's Blossom servers (from the hub event)
 *   2. Client Blossom list   — Settings > Network (enabled only)
 *   3. User Blossom list     — kind 10063, if available
 * If the hub's servers are dead and we still can't reach TARGET_COPIES, we
 * spill over into the client list, then the user list, then give up — best effort.
 *
 * Files change on member add/remove and epoch rotation (the index hash in the
 * hub event changes). We key dedup on the *current* index hash and always
 * re-parse the live index for child hashes — child hashes are never cached.
 *
 * Tasks are queued and processed sequentially to avoid hammering servers.
 */

import {
  blossomServers,
  downloadFromBlossom,
  downloadTextFromBlossom,
  uploadToBlossomServers,
  parseIndexFile,
  findPageForPubkey,
} from '@/lib/blossom'
import { useUserStore } from '@/stores/userStore'
import { useUserListsStore } from '@/stores/userListsStore'
import { useHubStore, type HubData } from '@/stores/hubStore'

/** Desired number of Blossom servers that should hold each critical file. */
const TARGET_COPIES = 3
const HEAD_TIMEOUT_MS = 5_000

/** "dTag:indexHash" combos already mirrored this session. */
const checkedThisSession = new Set<string>()

// ── Sequential task queue ──
const queue: Array<() => Promise<void>> = []
let processing = false

function enqueue(task: () => Promise<void>) {
  queue.push(task)
  processQueue()
}

async function processQueue() {
  if (processing) return
  processing = true
  while (queue.length > 0) {
    const task = queue.shift()!
    try {
      await task()
    } catch (err) {
      console.warn('[BlossomRedundancy] Task failed:', err)
    }
  }
  processing = false
}

// ── Helpers ──

function normalize(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Ordered, deduped Blossom server candidates:
 * hub servers → client list (enabled) → user list (kind 10063).
 */
function getCandidateServers(hub: HubData): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  const add = (url: string) => {
    const n = normalize(url)
    if (n && !seen.has(n)) {
      seen.add(n)
      result.push(n)
    }
  }
  for (const s of hub.blossomServers) add(s)
  for (const s of blossomServers.getServers()) add(s)
  for (const s of useUserListsStore.getState().userBlossoms) add(s)
  return result
}

/** HEAD a hash on a server — true if the server holds the blob. */
async function headExists(server: string, hash: string): Promise<boolean> {
  try {
    const res = await fetch(`${normalize(server)}/${hash}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Ensure a single content-addressed file exists on >= TARGET_COPIES servers.
 * HEAD-first, so the common (well-replicated) case costs no downloads.
 */
async function mirrorHash(hash: string, candidates: string[], label: string): Promise<void> {
  if (!hash) return

  // 1. Census via HEAD (parallel). Preserve priority order for non-holders.
  const present = await Promise.all(candidates.map((s) => headExists(s, hash)))
  const holders = candidates.filter((_, i) => present[i])
  const nonHolders = candidates.filter((_, i) => !present[i])

  if (holders.length >= TARGET_COPIES) {
    return // already well-replicated — no download needed
  }

  // 2. We need more copies — fetch the bytes once. downloadFromBlossom verifies
  //    the sha256 and falls back across servers (known holders first).
  let bytes: Uint8Array
  try {
    bytes = await downloadFromBlossom(hash, holders.length > 0 ? holders : candidates)
  } catch {
    // Gone from every known server, and we don't hold it — unrecoverable here.
    // (Only the creator/facilitator could rebuild it from local state.)
    console.warn(`[BlossomRedundancy] ${label} ${hash}: missing from all servers, cannot mirror`)
    return
  }

  // 3. Upload to non-holders in priority order until we reach TARGET_COPIES.
  //    uploadToBlossomServers re-HEADs and skips servers that already have it,
  //    which also covers HEAD-census false negatives.
  const { signer, privateKey } = useUserStore.getState()
  let copies = holders.length
  const filled: string[] = []
  for (const server of nonHolders) {
    if (copies >= TARGET_COPIES) break
    try {
      const { successCount } = await uploadToBlossomServers(bytes, signer, privateKey, [server])
      if (successCount > 0) {
        copies++
        filled.push(server)
      }
    } catch {
      // dead/refusing server — move on to the next candidate
    }
  }

  if (filled.length > 0) {
    console.log(
      `[BlossomRedundancy] ${label} ${hash}: mirrored to ${filled.length} server(s), now ${copies}/${TARGET_COPIES}`
    )
  }
  if (copies < TARGET_COPIES) {
    console.warn(`[BlossomRedundancy] ${label} ${hash}: only ${copies}/${TARGET_COPIES} copies after mirroring`)
  }
}

/**
 * Mirror the hub's critical member-list files: index, spine/tree, history,
 * ban pages, and the member's own leaf page.
 */
async function mirrorHubFiles(hub: HubData, memberPubkey: string): Promise<void> {
  const candidates = getCandidateServers(hub)
  if (candidates.length === 0 || !hub.indexFileHash) return

  // The index file itself — everything else is referenced from it.
  await mirrorHash(hub.indexFileHash, candidates, `${hub.dTag} index`)

  // Parse the *current* index to discover child hashes (never cached).
  let index
  try {
    const content = await downloadTextFromBlossom(hub.indexFileHash, hub.blossomServers)
    index = parseIndexFile(content)
  } catch {
    console.warn(`[BlossomRedundancy] ${hub.dTag}: could not load index ${hub.indexFileHash}`)
    return
  }

  const targets: Array<{ hash: string; label: string }> = []

  if (index.pageSize > 0) {
    // Paginated (hub creator tree)
    if (index.spineHash) targets.push({ hash: index.spineHash, label: `${hub.dTag} spine` })
    // The member's own leaf page (the only page they fetch on load)
    const page = findPageForPubkey(index, memberPubkey)
    if (page) targets.push({ hash: page.hash, label: `${hub.dTag} page` })
  } else if (index.treeHash) {
    // Monolithic (facilitator / group)
    targets.push({ hash: index.treeHash, label: `${hub.dTag} tree` })
  }

  if (index.historyHash) targets.push({ hash: index.historyHash, label: `${hub.dTag} history` })
  for (const b of index.banPages) targets.push({ hash: b.hash, label: `${hub.dTag} bans` })

  for (const t of targets) {
    await mirrorHash(t.hash, candidates, t.label)
  }
}

// ── Public API ──

/**
 * Ensure the hub's member-list Blossom files exist on >= TARGET_COPIES servers.
 * Cooperative: any member who opens a hub helps keep its files alive.
 * Deduped on the current index hash, so it re-runs after epoch/member changes.
 *
 * @param dTag         Hub d-tag
 * @param memberPubkey The viewer's pubkey (used to locate their leaf page)
 */
export function ensureBlossomRedundancy(dTag: string, memberPubkey: string) {
  const hub = useHubStore.getState().hubs[dTag]
  if (!hub || !hub.indexFileHash || hub.blossomServers.length === 0) return

  const key = `${dTag}:${hub.indexFileHash}`
  if (checkedThisSession.has(key)) return
  checkedThisSession.add(key)

  enqueue(() => mirrorHubFiles(hub, memberPubkey))
}

export interface DirectUploadResult { label: string; hash: string; okServers: number; error?: string }

/**
 * DIRECT upload of a hub's member-list files toward TARGET_COPIES (for the manual
 * "Re-upload" button). Plain BUD-02 uploads only — no server-side mirror endpoint,
 * since not every server supports it. For each file: census who already holds it,
 * fetch the bytes once, then upload in PARALLEL BATCHES sized to the shortfall —
 * short by N ⇒ push to N non-holders at once, recount, and retry the remaining
 * shortfall against the next untried servers — until it reaches TARGET_COPIES or
 * runs out of servers. Returns a per-file result so the UI can explain what happened.
 */
export async function directUploadHubFiles(dTag: string, memberPubkey: string): Promise<DirectUploadResult[]> {
  const hub = useHubStore.getState().hubs[dTag]
  if (!hub || !hub.indexFileHash) return []
  const candidates = getCandidateServers(hub)
  if (candidates.length === 0) return []
  const { signer, privateKey } = useUserStore.getState()

  const targets: Array<{ hash: string; label: string }> = [{ hash: hub.indexFileHash, label: 'Index' }]
  try {
    const content = await downloadTextFromBlossom(hub.indexFileHash, hub.blossomServers)
    const index = parseIndexFile(content)
    if (index.pageSize > 0) {
      if (index.spineHash) targets.push({ hash: index.spineHash, label: 'Member tree (spine)' })
      const page = findPageForPubkey(index, memberPubkey)
      if (page) targets.push({ hash: page.hash, label: 'Your member page' })
    } else if (index.treeHash) {
      targets.push({ hash: index.treeHash, label: 'Member tree' })
    }
    if (index.historyHash) targets.push({ hash: index.historyHash, label: 'Epoch history' })
    index.banPages.forEach((b, i) =>
      targets.push({ hash: b.hash, label: index.banPages.length > 1 ? `Ban page ${i + 1}` : 'Ban list' }),
    )
  } catch { /* index unreadable — still push the index file itself */ }

  const results: DirectUploadResult[] = []
  for (const t of targets) {
    // Census who already holds it.
    const present = await Promise.all(candidates.map((s) => headExists(s, t.hash)))
    const holders = candidates.filter((_, i) => present[i])
    const nonHolders = candidates.filter((_, i) => !present[i])
    let copies = holders.length
    if (copies >= TARGET_COPIES) {
      results.push({ label: t.label, hash: t.hash, okServers: copies })
      continue
    }

    // Fetch the bytes once (from a holder if possible, else any candidate).
    let bytes: Uint8Array
    try {
      bytes = await downloadFromBlossom(t.hash, holders.length > 0 ? holders : candidates)
    } catch {
      results.push({ label: t.label, hash: t.hash, okServers: copies, error: 'could not fetch the file from any server' })
      continue
    }

    // Upload in parallel batches sized to the remaining shortfall: short by N ⇒ try
    // N non-holders at once, recount, then retry the new shortfall with the next N.
    let anyAccepted = false
    const untried = [...nonHolders]
    while (copies < TARGET_COPIES && untried.length > 0) {
      const need = TARGET_COPIES - copies
      const batch = untried.splice(0, need)
      const outcomes = await Promise.all(
        batch.map(async (server) => {
          try {
            const { successCount } = await uploadToBlossomServers(bytes, signer, privateKey, [server])
            return successCount > 0
          } catch {
            return false
          }
        }),
      )
      const gained = outcomes.filter(Boolean).length
      copies += gained
      if (gained > 0) anyAccepted = true
    }

    results.push({
      label: t.label,
      hash: t.hash,
      okServers: copies,
      error: copies >= TARGET_COPIES
        ? undefined
        : anyAccepted
          ? `only reached ${copies}/${TARGET_COPIES} — remaining servers refused`
          : 'every server refused the upload',
    })
  }
  return results
}

/**
 * TEMPORARY test helper: push every hub file to EVERY candidate server (no target
 * cap), then report which servers ended up holding the index — i.e. which servers
 * accept uploads from this user. For diagnosing read-only / allowlist servers.
 */
export async function testUploadToAllServers(
  dTag: string,
  memberPubkey: string,
): Promise<{ accepting: string[]; refusing: string[] }> {
  const hub = useHubStore.getState().hubs[dTag]
  if (!hub || !hub.indexFileHash) return { accepting: [], refusing: [] }
  const candidates = getCandidateServers(hub)
  if (candidates.length === 0) return { accepting: [], refusing: [] }
  const { signer, privateKey } = useUserStore.getState()

  const hashes: string[] = [hub.indexFileHash]
  try {
    const content = await downloadTextFromBlossom(hub.indexFileHash, hub.blossomServers)
    const index = parseIndexFile(content)
    if (index.spineHash) hashes.push(index.spineHash)
    if (index.treeHash) hashes.push(index.treeHash)
    const page = findPageForPubkey(index, memberPubkey)
    if (page) hashes.push(page.hash)
    if (index.historyHash) hashes.push(index.historyHash)
    for (const b of index.banPages) hashes.push(b.hash)
  } catch { /* still test the index file */ }

  for (const hash of hashes) {
    let bytes: Uint8Array
    try { bytes = await downloadFromBlossom(hash, candidates) } catch { continue }
    // no onProgress → uploads to every candidate in parallel (skips holders), no cap
    await uploadToBlossomServers(bytes, signer, privateKey, candidates).catch(() => {})
  }

  const present = await Promise.all(candidates.map((s) => headExists(s, hub.indexFileHash)))
  return {
    accepting: candidates.filter((_, i) => present[i]),
    refusing: candidates.filter((_, i) => !present[i]),
  }
}

export interface BlossomFileAvailability {
  label: string
  hash: string
  servers: { server: string; present: boolean }[]
  presentCount: number
}

/**
 * Read-only availability census of a hub's critical member-list Blossom files
 * (index, spine/tree, epoch history, ban pages, the viewer's own leaf page) across
 * the candidate servers. HEAD-only — does NOT mirror. The Blossom analogue of the
 * hub-event availability check. Skips per-member leaf pages other than the viewer's
 * (there can be many); TARGET_COPIES is the "well-replicated" bar.
 */
export async function checkBlossomFileAvailability(
  dTag: string,
  memberPubkey: string,
): Promise<{ servers: string[]; files: BlossomFileAvailability[]; target: number }> {
  const hub = useHubStore.getState().hubs[dTag]
  if (!hub || !hub.indexFileHash) return { servers: [], files: [], target: TARGET_COPIES }

  const candidates = getCandidateServers(hub)
  if (candidates.length === 0) return { servers: [], files: [], target: TARGET_COPIES }

  const targets: Array<{ hash: string; label: string }> = [
    { hash: hub.indexFileHash, label: 'Index' },
  ]
  try {
    const content = await downloadTextFromBlossom(hub.indexFileHash, hub.blossomServers)
    const index = parseIndexFile(content)
    if (index.pageSize > 0) {
      if (index.spineHash) targets.push({ hash: index.spineHash, label: 'Member tree (spine)' })
      const page = findPageForPubkey(index, memberPubkey)
      if (page) targets.push({ hash: page.hash, label: 'Your member page' })
    } else if (index.treeHash) {
      targets.push({ hash: index.treeHash, label: 'Member tree' })
    }
    if (index.historyHash) targets.push({ hash: index.historyHash, label: 'Epoch history' })
    index.banPages.forEach((b, i) =>
      targets.push({ hash: b.hash, label: index.banPages.length > 1 ? `Ban page ${i + 1}` : 'Ban list' }),
    )
  } catch {
    // Index unreadable from Blossom — still report the index file's own availability.
  }

  const files = await Promise.all(
    targets.map(async (t) => {
      const present = await Promise.all(candidates.map((s) => headExists(s, t.hash)))
      return {
        label: t.label,
        hash: t.hash,
        servers: candidates.map((s, i) => ({ server: s, present: present[i] })),
        presentCount: present.filter(Boolean).length,
      }
    }),
  )

  return { servers: candidates, files, target: TARGET_COPIES }
}
