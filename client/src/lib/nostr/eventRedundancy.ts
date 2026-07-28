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
 * Which of `relays` currently hold an event matching `filter` (normalized set),
 * plus the newest such event found — the signed event we rebroadcast. Each relay
 * is queried individually with an 8s timeout.
 */
async function queryPresence(relays: string[], filter: Filter): Promise<{ present: Set<string>; event: Event | null }> {
  const present = new Set<string>()
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
      present.add(normalizeRelay(r.value.relay))
      const ev = r.value.events[0]
      if (!best || ev.created_at > best.created_at) best = ev
    }
  }
  return { present, event: best }
}

/**
 * Core: ensure a single event is held by at least TARGET_COPIES relays.
 *
 * 1. Check current coverage across every relay we know (client + NIP-65).
 * 2. If already on ≥ TARGET_COPIES, done. If found nowhere, nothing to copy — done.
 * 3. Otherwise top up: each round pick `needed` random relays from the client list
 *    AND `needed` from the user list (deduped, excluding relays that already have it
 *    or were tried), rebroadcast the signed event to them, then re-check just those
 *    candidates and fold the confirmed ones into coverage. Repeat with fresh random
 *    picks until coverage hits the target or we run out of untried relays.
 */
async function checkAndRebroadcast(filter: Filter, key: string): Promise<void> {
  const clientRelays = uniqRelays(getRelays())
  const userRelays = uniqRelays(useUserListsStore.getState().userRelays)
  const allRelays = uniqRelays([...clientRelays, ...userRelays])
  if (allRelays.length === 0) return

  const { present, event } = await queryPresence(allRelays, filter)
  if (!event) {
    console.log(`[EventRedundancy] ${key}: not found on any relay — nothing to rebroadcast`)
    return
  }

  const coverage = new Set(present)
  if (coverage.size >= TARGET_COPIES) {
    console.log(`[EventRedundancy] ${key}: already on ${coverage.size}/${TARGET_COPIES} relays`)
    return
  }

  const tried = new Set<string>()
  for (let round = 0; round < MAX_ROUNDS && coverage.size < TARGET_COPIES; round++) {
    const needed = TARGET_COPIES - coverage.size
    const pickFrom = (list: string[]) => sample(list.filter((r) => !coverage.has(r) && !tried.has(r)), needed)
    const candidates = uniqRelays([...pickFrom(clientRelays), ...pickFrom(userRelays)])
    if (candidates.length === 0) break // no untried relays left to try

    candidates.forEach((c) => tried.add(c))
    try {
      await publishToSpecificRelays(candidates, event)
    } catch (err) {
      console.warn(`[EventRedundancy] ${key}: publish round ${round + 1} failed:`, err)
    }

    // Confirm which candidates actually hold it now, and fold them into coverage.
    const { present: nowPresent } = await queryPresence(candidates, filter)
    nowPresent.forEach((r) => coverage.add(r))
  }

  if (coverage.size >= TARGET_COPIES) {
    console.log(`[EventRedundancy] ${key}: ensured on ${coverage.size}/${TARGET_COPIES} relays`)
  } else {
    console.warn(`[EventRedundancy] ${key}: only ${coverage.size}/${TARGET_COPIES} relays after top-up (ran out of relays)`)
  }
}

/**
 * Check which of the user's relays (client + NIP-65) currently hold an event
 * matching `filter`. Read-only — does NOT rebroadcast. Used by the hub
 * availability UI. Each relay is queried individually with an 8s timeout.
 */
export async function checkEventAvailability(filter: Filter): Promise<{ relay: string; present: boolean }[]> {
  const relays = getAllRelays()
  const results = await Promise.allSettled(
    relays.map(async (relay) => {
      const events = await Promise.race([
        fetchEventsFromRelays([relay], filter),
        new Promise<Event[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), RELAY_TIMEOUT_MS)),
      ])
      return { relay, present: events.length > 0 }
    }),
  )
  return results.map((r, i) => (r.status === 'fulfilled' ? r.value : { relay: relays[i], present: false }))
}

// ── Public API ──

/**
 * Ensure an addressable/replaceable event exists on all user relays
 * (client relays + NIP-65 relays). Enqueued for sequential processing.
 * Skips if already checked this session.
 *
 * @param kind   Event kind
 * @param pubkey Event author pubkey
 * @param dTag   Optional d-tag for addressable events
 */
export function ensureAddressableRedundancy(kind: number, pubkey: string, dTag?: string) {
  const key = eventKey(kind, pubkey, dTag)
  if (checkedThisSession.has(key)) return
  checkedThisSession.add(key)

  const filter: Filter = { kinds: [kind], authors: [pubkey], limit: 1 }
  if (dTag !== undefined) {
    filter['#d'] = [dTag]
  }

  enqueue(() => checkAndRebroadcast(filter, key))
}
