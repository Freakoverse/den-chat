/**
 * eventRedundancy — Cooperative event rebroadcasting
 *
 * Ensures critical Nostr events (profiles, relay lists, hub lists, hub events)
 * exist on at least 3 hardcoded relays. If an event is missing from some relays
 * (e.g. due to DB purges), it rebroadcasts the already-signed event — no signing needed.
 *
 * Two categories:
 *   Personal events: checked once on startup (30s delay)
 *   Shared hub events: checked when a user opens a hub (any member helps)
 *
 * Tasks are queued and processed sequentially to avoid relay flooding.
 */

import { fetchEventsFromRelays, publishToSpecificRelays, getDefaultRelays } from './relay-pool'
import { useUserListsStore } from '@/stores/userListsStore'
import type { Event, Filter } from 'nostr-tools'

const REDUNDANCY_TARGET = 3
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

/**
 * Core: check a single event's presence across hardcoded relays and rebroadcast if needed.
 */
async function checkAndRebroadcast(filter: Filter, key: string): Promise<void> {
  const hardcodedRelays = getDefaultRelays()

  // Query each hardcoded relay individually (in parallel, each with 8s timeout)
  const results = await Promise.allSettled(
    hardcodedRelays.map(async (relay) => {
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
    const relay = hardcodedRelays[i]

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
    `[EventRedundancy] ${key}: found on ${presentOn.length}/${hardcodedRelays.length} hardcoded relays` +
    (missingFrom.length > 0 ? ` (missing: ${missingFrom.join(', ')})` : '')
  )

  if (presentOn.length >= REDUNDANCY_TARGET || !bestEvent) {
    return // Sufficient redundancy, or event not found anywhere
  }

  // Rebroadcast to missing hardcoded relays
  const rebroadcastedTo: string[] = []
  if (missingFrom.length > 0) {
    try {
      const accepted = await publishToSpecificRelays(missingFrom, bestEvent)
      rebroadcastedTo.push(...accepted)
    } catch (err) {
      console.warn(`[EventRedundancy] Failed to rebroadcast to hardcoded relays:`, err)
    }
  }

  // If still under target, try user's NIP-65 relay list as overflow
  const totalCoverage = presentOn.length + rebroadcastedTo.length
  if (totalCoverage < REDUNDANCY_TARGET) {
    const userRelays = useUserListsStore.getState().userRelays
    const alreadyTried = new Set([...presentOn, ...rebroadcastedTo, ...missingFrom])
    const untried = userRelays.filter(r => !alreadyTried.has(r))

    if (untried.length > 0) {
      const needed = REDUNDANCY_TARGET - totalCoverage
      const targets = untried.slice(0, needed)
      try {
        const accepted = await publishToSpecificRelays(targets, bestEvent)
        rebroadcastedTo.push(...accepted)
      } catch (err) {
        console.warn(`[EventRedundancy] Failed to rebroadcast to user relays:`, err)
      }
    }
  }

  if (rebroadcastedTo.length > 0) {
    console.log(`[EventRedundancy] ${key}: rebroadcasted to ${rebroadcastedTo.length} relay(s):`, rebroadcastedTo)
  } else if (presentOn.length < REDUNDANCY_TARGET) {
    console.warn(`[EventRedundancy] ${key}: could not achieve ${REDUNDANCY_TARGET}-relay redundancy (only on ${presentOn.length})`)
  }
}

// ── Public API ──

/**
 * Ensure an addressable/replaceable event exists on at least 3 hardcoded relays.
 * Enqueued for sequential processing. Skips if already checked this session.
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
