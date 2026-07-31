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
/** Max top-up rounds before giving up (each round re-checks coverage). */
const MAX_ROUNDS = 3

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

/** Build a deduplicated relay list from client relays + user NIP-65 relays */
function getAllRelays(): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  const add = (url: string) => {
    const normalized = url.replace(/\/+$/, '')
    if (!seen.has(normalized)) {
      seen.add(normalized)
      result.push(url)
    }
  }

  // Client relays (Settings > Network > Relays, enabled only)
  for (const r of getRelays()) add(r)

  // User NIP-65 relays (kind 10002)
  for (const r of useUserListsStore.getState().userRelays) add(r)

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

/** Random distinct sample of up to `n` items (Fisher-Yates). */
function sample<T>(arr: T[], n: number): T[] {
  if (n <= 0 || arr.length === 0) return []
  const copy = [...arr]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, Math.min(n, copy.length))
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
 * TARGET_COPIES relays. Version-aware throughout.
 *
 * 1. Check coverage across every relay we know (client + NIP-65), recording the
 *    created_at each relay holds.
 * 2. If the client holds a NEWER version than any reachable relay (`knownLatest` >
 *    the newest relay copy), the fresh copy can't be pushed from here — spreading
 *    the stale relay copy would be wrong — so we bail and leave it to a deliberate
 *    rebroadcast (Settings → My Hubs). If found nowhere, nothing to copy.
 * 3. "Covered" = relays holding the LATEST created_at (a stale copy does NOT count).
 * 4. Top up: each round pick `needed` random relays from the client list AND the
 *    user list that DON'T have the latest (stale or absent), push the latest event,
 *    re-check, and fold confirmed ones into coverage. Repeat until the target or we
 *    run out of relays.
 */
async function checkAndRebroadcast(filter: Filter, key: string, knownLatest?: number): Promise<void> {
  const clientRelays = uniqRelays(getRelays())
  const userRelays = uniqRelays(useUserListsStore.getState().userRelays)
  const allRelays = uniqRelays([...clientRelays, ...userRelays])
  if (allRelays.length === 0) return

  const { have, event } = await queryPresence(allRelays, filter)
  if (!event) {
    console.log(`[EventRedundancy] ${key}: not found on any relay — nothing to rebroadcast`)
    return
  }

  const relayLatest = event.created_at
  // The client knows a newer version than any reachable relay has — don't spread
  // the stale relay copy; the current version must be pushed deliberately.
  if (knownLatest !== undefined && knownLatest > relayLatest) {
    console.warn(`[EventRedundancy] ${key}: relays only have ${relayLatest}, client holds ${knownLatest} — relays are stale; skipping auto-rebroadcast (rebroadcast manually to propagate the current version).`)
    return
  }

  // Coverage counts only relays that hold the LATEST version.
  const coverage = new Set([...have.entries()].filter(([, ca]) => ca === relayLatest).map(([r]) => r))
  if (coverage.size >= TARGET_COPIES) {
    console.log(`[EventRedundancy] ${key}: latest version already on ${coverage.size}/${TARGET_COPIES} relays`)
    return
  }

  const tried = new Set<string>()
  for (let round = 0; round < MAX_ROUNDS && coverage.size < TARGET_COPIES; round++) {
    const needed = TARGET_COPIES - coverage.size
    // Candidates = relays without the latest (stale OR absent), not yet tried.
    const pickFrom = (list: string[]) => sample(list.filter((r) => !coverage.has(r) && !tried.has(r)), needed)
    const candidates = uniqRelays([...pickFrom(clientRelays), ...pickFrom(userRelays)])
    if (candidates.length === 0) break // no untried relays left to try

    candidates.forEach((c) => tried.add(c))
    try {
      await publishToSpecificRelays(candidates, event)
    } catch (err) {
      console.warn(`[EventRedundancy] ${key}: publish round ${round + 1} failed:`, err)
    }

    // Confirm which candidates now hold the LATEST version, and fold them in.
    const { have: nowHave } = await queryPresence(candidates, filter)
    for (const [r, ca] of nowHave) if (ca === relayLatest) coverage.add(r)
  }

  if (coverage.size >= TARGET_COPIES) {
    console.log(`[EventRedundancy] ${key}: ensured latest on ${coverage.size}/${TARGET_COPIES} relays`)
  } else {
    console.warn(`[EventRedundancy] ${key}: latest on only ${coverage.size}/${TARGET_COPIES} relays after top-up (ran out of relays)`)
  }
}

export type RelayAvailability = {
  relay: string
  /** present = holds the latest version; outdated = holds an older version; absent = has none. */
  status: 'present' | 'outdated' | 'absent'
  createdAt?: number
}

/**
 * Check which of the user's relays (client + NIP-65) hold the LATEST version of an
 * event matching `filter`. Read-only — does NOT rebroadcast. Version-aware: a relay
 * with an older copy is reported 'outdated', not 'present'. The reference version
 * is the newest across relays, raised to `knownLatest` (the version the client is
 * actually using) so a relay is 'outdated' even when the fresh copy is unreachable.
 * Each relay is queried individually with an 8s timeout.
 */
export async function checkEventAvailability(filter: Filter, knownLatest?: number): Promise<RelayAvailability[]> {
  const relays = getAllRelays()
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
 */
export function ensureAddressableRedundancy(kind: number, pubkey: string, dTag?: string, knownLatest?: number) {
  const key = eventKey(kind, pubkey, dTag)
  if (checkedThisSession.has(key)) return
  checkedThisSession.add(key)

  const filter: Filter = { kinds: [kind], authors: [pubkey], limit: 1 }
  if (dTag !== undefined) {
    filter['#d'] = [dTag]
  }

  enqueue(() => checkAndRebroadcast(filter, key, knownLatest))
}
