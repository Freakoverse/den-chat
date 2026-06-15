/**
 * eventRedundancy — Cooperative event rebroadcasting
 *
 * Ensures critical Nostr events (profiles, relay lists, hub lists, hub events)
 * exist on all of the user's configured relays. If an event is missing from some
 * relays (e.g. due to DB purges), it rebroadcasts the already-signed event —
 * no signing needed.
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

/**
 * Core: check a single event's presence across all user relays and rebroadcast if needed.
 */
async function checkAndRebroadcast(filter: Filter, key: string): Promise<void> {
  const relays = getAllRelays()
  if (relays.length === 0) return

  // Query each relay individually (in parallel, each with 8s timeout)
  const results = await Promise.allSettled(
    relays.map(async (relay) => {
      const events = await Promise.race([
        fetchEventsFromRelays([relay], filter),
        new Promise<Event[]>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), RELAY_TIMEOUT_MS)
        ),
      ])
      return { relay, events }
    })
  )

  // Classify relays: which have the event, which don't
  const presentOn: string[] = []
  const missingFrom: string[] = []
  let bestEvent: Event | null = null

  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const relay = relays[i]

    if (result.status === 'fulfilled' && result.value.events.length > 0) {
      presentOn.push(relay)
      // Keep the latest event for rebroadcasting
      const event = result.value.events[0]
      if (!bestEvent || event.created_at > bestEvent.created_at) {
        bestEvent = event
      }
    } else {
      missingFrom.push(relay)
    }
  }

  console.log(
    `[EventRedundancy] ${key}: found on ${presentOn.length}/${relays.length} relays` +
    (missingFrom.length > 0 ? ` (missing: ${missingFrom.join(', ')})` : '')
  )

  if (missingFrom.length === 0 || !bestEvent) {
    return // Present on all relays, or event not found anywhere
  }

  // Rebroadcast to all relays that are missing the event
  try {
    const accepted = await publishToSpecificRelays(missingFrom, bestEvent)
    if (accepted.length > 0) {
      console.log(`[EventRedundancy] ${key}: rebroadcasted to ${accepted.length} relay(s):`, accepted)
    }
    const finalCoverage = presentOn.length + accepted.length
    if (finalCoverage < relays.length) {
      console.warn(`[EventRedundancy] ${key}: only on ${finalCoverage}/${relays.length} relays after rebroadcast`)
    }
  } catch (err) {
    console.warn(`[EventRedundancy] Failed to rebroadcast ${key}:`, err)
  }
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
