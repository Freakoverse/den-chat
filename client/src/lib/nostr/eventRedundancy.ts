/**
 * eventRedundancy — Cooperative event rebroadcasting
 *
 * Ensures critical Nostr events (profiles, relay lists, hub lists, hub events)
 * exist on at least TARGET_COPIES (3) of the user's relays — NOT all of them. If
 * coverage is below the target, it tops up by rebroadcasting the already-signed
 * event (no signing needed) to randomly chosen relays drawn from both the client
 * list and the user (NIP-65) list, then re-checks and retries until it reaches the
 * target or runs out of relays. This is the relay analogue of blossomRedundancy,
 * which mirrors files to 3 servers.
 *
 * Relay sources (deduplicated):
 *   1. Client relays — from Settings > Network > Relays (enabled only)
 *   2. User relays  — NIP-65 relay list (kind 10002), if available
 *
 * Two categories:
 *   Personal events: checked once on startup (30s delay)
 *   Shared hub events: checked when a user opens a hub (any member helps)
 *
 * Tasks are queued and processed sequentially to avoid relay flooding.
 */

import { fetchEventsFromRelays, publishToSpecificRelays, getRelays } from './relay-pool'
import { useUserListsStore } from '@/stores/userListsStore'
import type { Event, Filter } from 'nostr-tools'

const RELAY_TIMEOUT_MS = 8_000

/** Desired number of relays that should hold each critical event. */
const TARGET_COPIES = 3

/** Events already checked this session — keyed by "kind:pubkey:dTag" */
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
      console.warn('[EventRedundancy] Task failed:', err)
    }
  }
  processing = false
}

// ── Helpers ──

function eventKey(kind: number, pubkey: string, dTag?: string): string {
  return dTag ? `${kind}:${pubkey}:${dTag}` : `${kind}:${pubkey}`
}

/**
 * Deduplicated relay list, in priority order: any `extra` relays (e.g. a hub's
 * own declared relays) first, then client relays (Settings > Network > Relays,
 * enabled only), then the user's NIP-65 relays (kind 10002). The extra relays go
 * first because they're the event's natural home and most likely to accept it.
 */
function getAllRelays(extra: string[] = []): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  const add = (url: string) => {
    const normalized = url.replace(/\/+$/, '')
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized)
      result.push(url)
    }
  }

  for (const r of extra) add(r)                                    // hub-declared relays first
  for (const r of getRelays()) add(r)                             // client relays
  for (const r of useUserListsStore.getState().userRelays) add(r) // user NIP-65 relays

  return result
}

/** Strip trailing slashes so the same relay from two lists dedups correctly. */
function normalizeRelay(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Deduplicated, normalized, non-empty relay list (order preserved). */
function uniqRelays(urls: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const u of urls) {
    const n = normalizeRelay(u)
    if (n && !seen.has(n)) { seen.add(n); out.push(n) }
  }
  return out
}


/**
 * Which of `relays` hold an event matching `filter`, with the created_at of the
 * version each holds (its newest), plus the newest event overall — the signed
 * event we'd rebroadcast. Version-aware: a relay with a STALE copy is recorded
 * with its OLDER created_at, so callers can tell "has the latest" apart from "has
 * an old copy". Each relay is queried individually with an 8s timeout.
 */
async function queryPresence(relays: string[], filter: Filter): Promise<{ have: Map<string, number>; event: Event | null }> {
  const have = new Map<string, number>()
  let best: Event | null = null
  const results = await Promise.allSettled(
    relays.map(async (relay) => {
      const events = await Promise.race([
        fetchEventsFromRelays([relay], filter),
        new Promise<Event[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), RELAY_TIMEOUT_MS)),
      ])
      return { relay, events }
    }),
  )
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.events.length > 0) {
      const ev = r.value.events.reduce((a, b) => (b.created_at > a.created_at ? b : a))
      have.set(normalizeRelay(r.value.relay), ev.created_at)
      if (!best || ev.created_at > best.created_at) best = ev
    }
  }
  return { have, event: best }
}

/**
 * Core: ensure the LATEST version of a replaceable event is held by at least
 * TARGET_COPIES relays. Version-aware throughout — but RELAY-SOURCED ONLY.
 *
 * It never pushes a copy the client only holds locally. Two reasons: (1) the local
 * hub cache is manual-rebroadcast-only by design, and (2) a member who was offline
 * during a hub deletion holds the pre-deletion LIVE copy (not the tombstone), so
 * auto-pushing it could resurrect a deleted hub. Propagating a version that's newer
 * locally than on any relay is therefore deferred to a deliberate action
 * (Settings → My Hubs).
 *
 * 1. Check coverage across every relay we know (hub-declared + client + NIP-65),
 *    recording the created_at each relay holds. If found nowhere, done.
 * 2. If `knownLatest` (the version the client is actually using) is newer than any
 *    relay copy, bail — don't spread the stale relay copy; defer to a manual rebroadcast.
 * 3. "Covered" = relays holding the LATEST created_at (a stale copy does NOT count).
 * 4. Fail over across ALL relays that don't hold the latest (hub relays first, then
 *    client, then user), a small batch at a time, pushing the newest relay copy and
 *    folding confirmed/ACKed relays into coverage — until the target is reached or we
 *    run out of relays. (No fixed round cap and no random 3-pick: every relay gets a
 *    chance, so a few write-rejecting relays can't strand it below the target.)
 */
async function checkAndRebroadcast(filter: Filter, key: string, knownLatest?: number, extraRelays: string[] = []): Promise<void> {
  const allRelays = uniqRelays(getAllRelays(extraRelays))
  if (allRelays.length === 0) return

  const { have, event } = await queryPresence(allRelays, filter)
  if (!event) {
    console.log(`[EventRedundancy] ${key}: not found on any relay — nothing to rebroadcast`)
    return
  }

  const relayLatest = event.created_at
  // The client holds a NEWER version than any relay has. Do NOT auto-rebroadcast:
  // spreading the stale relay copy is wrong, and pushing our own local copy is a
  // deliberate action (avoids resurrecting a deleted hub from a pre-deletion copy).
  if (knownLatest !== undefined && knownLatest > relayLatest) {
    console.warn(`[EventRedundancy] ${key}: relays only have ${relayLatest}, client holds ${knownLatest} — deferring to a manual rebroadcast (Settings → My Hubs) to propagate the current version.`)
    return
  }

  // Coverage counts only relays that hold the LATEST version.
  const coverage = new Set([...have.entries()].filter(([, ca]) => ca === relayLatest).map(([r]) => r))
  if (coverage.size >= TARGET_COPIES) {
    console.log(`[EventRedundancy] ${key}: latest version already on ${coverage.size}/${TARGET_COPIES} relays`)
    return
  }

  // Fail over across every non-holder relay, a batch at a time, until we reach the
  // target or exhaust the list. A relay that ACKs the publish counts as covered even
  // if the immediate re-query hasn't caught up (avoids the read-after-write race).
  const tried = new Set<string>()
  while (coverage.size < TARGET_COPIES) {
    const pool = allRelays.filter((r) => !coverage.has(normalizeRelay(r)) && !tried.has(normalizeRelay(r)))
    if (pool.length === 0) break
    const needed = TARGET_COPIES - coverage.size
    const batch = pool.slice(0, Math.min(pool.length, needed + 2)) // small over-provision
    batch.forEach((c) => tried.add(normalizeRelay(c)))

    let accepted: string[] = []
    try {
      accepted = await publishToSpecificRelays(batch, event)
    } catch (err) {
      console.warn(`[EventRedundancy] ${key}: publish batch failed:`, err)
    }

    // Fold in relays confirmed to hold the latest, plus any that ACKed the publish.
    const { have: nowHave } = await queryPresence(batch, filter)
    for (const [r, ca] of nowHave) if (ca === relayLatest) coverage.add(normalizeRelay(r))
    for (const url of accepted) coverage.add(normalizeRelay(url))
  }

  if (coverage.size >= TARGET_COPIES) {
    console.log(`[EventRedundancy] ${key}: ensured latest on ${coverage.size}/${TARGET_COPIES} relays`)
  } else {
    console.warn(`[EventRedundancy] ${key}: latest on only ${coverage.size}/${TARGET_COPIES} relays after failover (ran out of relays)`)
  }
}

export type RelayAvailability = {
  relay: string
  /** present = holds the latest version; outdated = holds an older version; absent = has none. */
  status: 'present' | 'outdated' | 'absent'
  createdAt?: number
}

/**
 * Check which relays (hub-declared `extraRelays` + client + NIP-65) hold the LATEST
 * version of an event matching `filter`. Read-only — does NOT rebroadcast. Version-
 * aware: a relay with an older copy is reported 'outdated', not 'present'. The
 * reference version is the newest across relays, raised to `knownLatest` (the version
 * the client is actually using) so a relay is 'outdated' even when the fresh copy is
 * unreachable. Each relay is queried individually with an 8s timeout.
 */
export async function checkEventAvailability(filter: Filter, knownLatest?: number, extraRelays: string[] = []): Promise<RelayAvailability[]> {
  const relays = getAllRelays(extraRelays)
  const { have } = await queryPresence(relays, filter)
  const relayMax = have.size > 0 ? Math.max(...have.values()) : 0
  const reference = Math.max(relayMax, knownLatest ?? 0)
  return relays.map((relay) => {
    const ca = have.get(normalizeRelay(relay))
    if (ca === undefined) return { relay, status: 'absent' as const }
    if (reference > 0 && ca < reference) return { relay, status: 'outdated' as const, createdAt: ca }
    return { relay, status: 'present' as const, createdAt: ca }
  })
}

// ── Public API ──

/**
 * Ensure an addressable/replaceable event exists on all user relays
 * (client relays + NIP-65 relays). Enqueued for sequential processing.
 * Skips if already checked this session.
 *
 * @param kind        Event kind
 * @param pubkey      Event author pubkey
 * @param dTag        Optional d-tag for addressable events
 * @param knownLatest created_at of the version the client currently holds, if newer
 *                    than what relays return (so we never spread a stale copy over it)
 * @param extraRelays hub-declared relays to include first (for hub-scoped events)
 */
export function ensureAddressableRedundancy(kind: number, pubkey: string, dTag?: string, knownLatest?: number, extraRelays?: string[]) {
  const key = eventKey(kind, pubkey, dTag)
  if (checkedThisSession.has(key)) return
  checkedThisSession.add(key)

  const filter: Filter = { kinds: [kind], authors: [pubkey], limit: 1 }
  if (dTag !== undefined) {
    filter['#d'] = [dTag]
  }

  enqueue(() => checkAndRebroadcast(filter, key, knownLatest, extraRelays))
}
