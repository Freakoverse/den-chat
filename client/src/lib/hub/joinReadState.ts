/**
 * Hub join-request read-state — the creator's per-hub "seen" watermark, synced across their devices
 * via a NIP-78 (kind 30078) event (d = den-join-read-state), mirroring the hub/dm/pc read-states.
 *
 * WHY NIP-78, not bare localStorage: the watermark IS how a creator dismisses a batch of join
 * requests ("I've seen these / I'll ignore them"). The kind-36944 request events persist on relays
 * after approval, and a creator may deliberately leave some unactioned — so this "already handled up
 * to here" decision must follow the creator to their other devices, which a device-local
 * `den-join-requests-seen:<dTag>` value never did.
 *
 * PRIVACY: content is NIP-44 self-encrypted. It lists the hub d-tags the creator moderates; published
 * in the clear on an `R`-authored event that would link R → a private v2 hub they own. The d-tag is
 * generic, so an observer only learns "R has a den-chat read-state" (true of every user).
 *
 * Canonical state = the NIP-78 event; localStorage caches a plaintext copy for instant/offline reads.
 * Merge is element-wise max per hub (two devices each advancing a different hub never lose either);
 * writes are debounced here and throttled by the shared read-state publisher.
 */
import type { ISigner } from '@/stores/userStore'
import { APP_DATA_DTAGS, STANDARD_KINDS } from '@/lib/crypto/constants'
import {
  loadCachedEvent,
  saveCachedEvent,
  fetchReadStateEvent,
  buildJoinReadStateEvent,
  parseJoinReadState,
  signAndPublishReadState,
  getRemainingThrottleTime,
  setReadStateAccount,
  type JoinReadState,
} from '@/lib/notifications/readState'

/** Legacy device-local watermark key, migrated once into the synced state. */
const LEGACY_PREFIX = 'den-join-requests-seen:'
const PUBLISH_DEBOUNCE_MS = 15_000 // batch rapid mark-seen clicks (mirrors notificationStore)

let _map: Record<string, number> = {} // hub d-tag → last-seen unix ts
let _account = ''
let _publishTimer: ReturnType<typeof setTimeout> | null = null

/** Fold legacy per-hub localStorage watermarks into the map (max). Returns true if anything merged. */
function migrateLegacy(): boolean {
  let changed = false
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(LEGACY_PREFIX)) keys.push(k)
    }
    for (const k of keys) {
      const dTag = k.slice(LEGACY_PREFIX.length)
      const ts = parseInt(localStorage.getItem(k) || '0', 10) || 0
      if (ts > (_map[dTag] ?? 0)) { _map[dTag] = ts; changed = true }
    }
  } catch { /* localStorage unavailable */ }
  return changed
}

/** Persist the merged map to the plaintext localStorage cache (per-account, via the read-state lib). */
function saveCache(): void {
  const cached = loadCachedEvent('join')
  const cacheEvent = {
    ...(cached ?? { id: '', sig: '', pubkey: '', kind: STANDARD_KINDS.APP_DATA, tags: [['d', APP_DATA_DTAGS.JOIN_READ_STATE]] }),
    content: JSON.stringify({ hubs: _map } as JoinReadState),
    created_at: Math.floor(Date.now() / 1000),
  }
  try { saveCachedEvent('join', cacheEvent as never) } catch { /* ignore */ }
}

function schedulePublish(): void {
  if (_publishTimer) clearTimeout(_publishTimer)
  _publishTimer = setTimeout(() => { void publishNow() }, PUBLISH_DEBOUNCE_MS)
}

async function publishNow(): Promise<void> {
  try {
    const { useUserStore } = await import('@/stores/userStore')
    const { signer, privateKey } = useUserStore.getState()
    const pubkey = _account || useUserStore.getState().pubkey || ''
    if (!pubkey || (!signer && !privateKey)) return

    const { guardedEncrypt } = await import('@/lib/auth/signerGuard')
    const content = JSON.stringify({ hubs: _map } as JoinReadState)
    let encrypted: string
    try {
      encrypted = await guardedEncrypt(content, pubkey, signer, privateKey, 'nip44')
    } catch (err) {
      // NEVER publish plaintext — it would leak the moderated hub d-tags (v2 owner ↔ hub link).
      console.warn('[join-read-state] encrypt failed — skipping publish:', err)
      return
    }
    const event = buildJoinReadStateEvent(encrypted)
    const published = await signAndPublishReadState('join', event, signer, privateKey)
    if (!published) {
      // Throttled — reschedule for when the window opens (never silently drop a change).
      const remaining = getRemainingThrottleTime('join')
      if (remaining > 0) _publishTimer = setTimeout(() => { void publishNow() }, remaining * 1000)
    }
  } catch (err) {
    console.warn('[join-read-state] publish failed:', err)
  }
}

/**
 * Load the creator's join-request read-state for `pubkey`: plaintext cache → relay (decrypted) →
 * legacy migration, merged element-wise (max). Call on login / account switch. Safe to call more
 * than once; resets when the active account changes.
 */
export async function hydrateJoinReadState(
  pubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<void> {
  if (!pubkey) return
  if (_account !== pubkey) { _map = {}; _account = pubkey }
  setReadStateAccount(pubkey) // ensure the shared cache is namespaced to this account

  // 1. Plaintext localStorage cache (instant, offline).
  const cached = loadCachedEvent('join')
  if (cached?.content) {
    for (const [dTag, ts] of Object.entries(parseJoinReadState(cached.content).hubs)) {
      if (ts > (_map[dTag] ?? 0)) _map[dTag] = ts
    }
  }

  // 2. Relay (encrypted) — element-wise max so no device's watermark is lost.
  try {
    const relayEv = await fetchReadStateEvent(pubkey, 'join')
    if (relayEv?.content) {
      const { guardedDecrypt } = await import('@/lib/auth/signerGuard')
      const decrypted = await guardedDecrypt(relayEv.content, pubkey, signer, privateKey, 'nip44')
      for (const [dTag, ts] of Object.entries(parseJoinReadState(decrypted).hubs)) {
        if (ts > (_map[dTag] ?? 0)) _map[dTag] = ts
      }
    }
  } catch (err) {
    console.warn('[join-read-state] relay hydrate failed:', err)
  }

  // 3. One-time migration of any device-local legacy watermarks.
  const migrated = migrateLegacy()

  saveCache()
  // If the legacy migration or a newer relay merge changed things, push the reconciled state up.
  if (migrated) schedulePublish()
}

/** The creator's last-seen watermark for a hub's join requests (0 if never seen / not hydrated). */
export function getJoinSeen(dTag: string): number {
  return _map[dTag] ?? 0
}

/**
 * Re-read the plaintext cache into memory (element-wise max). Cheap; used for cross-tab sync — a
 * `storage` event fires in OTHER tabs when this tab writes the cache, but their in-memory map is a
 * separate JS context and would otherwise stay stale.
 */
export function refreshJoinSeenFromCache(): void {
  const cached = loadCachedEvent('join')
  if (!cached?.content) return
  for (const [dTag, ts] of Object.entries(parseJoinReadState(cached.content).hubs)) {
    if (ts > (_map[dTag] ?? 0)) _map[dTag] = ts
  }
}

/** Advance the watermark for a hub to `ts` (no-op if not newer); persists + syncs across devices. */
export function setJoinSeen(dTag: string, ts: number): void {
  if (ts <= (_map[dTag] ?? 0)) return
  _map[dTag] = ts
  saveCache()
  schedulePublish()
}
