import {
  SimplePool,
  type Filter,
  type Event,
} from 'nostr-tools'
import { StorageKey } from '@/lib/constants'

const pool = new SimplePool()

/** Default relays — user can customize these later */
const DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.snort.social',
  'wss://relay.wellorder.net',
  'wss://relay.nostr.info',
]

/** In-memory cache — null means "not loaded yet" */
let activeRelaysCache: string[] | null = null

/**
 * Load enabled relays from localStorage.
 * Falls back to DEFAULT_RELAYS if nothing stored or all disabled.
 */
function loadRelays(): string[] {
  try {
    const stored = localStorage.getItem(StorageKey.CLIENT_RELAYS)
    if (stored) {
      const parsed = JSON.parse(stored) as { url: string; enabled: boolean }[]
      const enabled = parsed.filter((r) => r.enabled).map((r) => r.url)
      if (enabled.length > 0) return enabled
    }
  } catch { /* ignore */ }
  return [...DEFAULT_RELAYS]
}

/**
 * Get the current active relay list.
 * Lazy-loads from localStorage on first call.
 */
export function getRelays(): string[] {
  if (activeRelaysCache === null) {
    activeRelaysCache = loadRelays()
  }
  return [...activeRelaysCache]
}

/**
 * Set the active relay list and persist to localStorage.
 * @param list Full relay list with enabled states to persist
 */
export function setRelays(list: { url: string; enabled: boolean }[]) {
  localStorage.setItem(StorageKey.CLIENT_RELAYS, JSON.stringify(list))
  const enabled = list.filter((r) => r.enabled).map((r) => r.url)
  activeRelaysCache = enabled.length > 0 ? enabled : [...DEFAULT_RELAYS]
}

/**
 * Invalidate the in-memory cache so next getRelays() re-reads localStorage.
 * Useful when localStorage was updated externally (e.g. by the settings page).
 */
export function reloadRelays() {
  activeRelaysCache = loadRelays()
}

/**
 * Get the full relay list with enabled/disabled states (for settings UI).
 * Falls back to defaults if nothing stored.
 */
export function getRelayList(): { url: string; enabled: boolean }[] {
  try {
    const stored = localStorage.getItem(StorageKey.CLIENT_RELAYS)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    }
  } catch { /* ignore */ }
  return DEFAULT_RELAYS.map((url) => ({ url, enabled: true }))
}

/**
 * Get the hardcoded default relay URLs (for UI guards like preventing deletion).
 */
export function getDefaultRelays(): string[] {
  return [...DEFAULT_RELAYS]
}

/**
 * Pick up to `n` random relays from the active pool. Used by lightweight
 * bootstrap flows (auth) that don't need to fan out across the whole pool.
 */
export function getRandomRelays(n: number): string[] {
  const all = getRelays()
  if (all.length <= n) return all
  const shuffled = [...all]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, n)
}

/**
 * Publish an event to all active relays.
 * Each relay has a 15-second timeout — if it doesn't respond, it counts as failed.
 * @returns Array of relay URLs that accepted the event
 */
export async function publishEvent(event: Event): Promise<string[]> {
  const relays = getRelays()
  const promises = pool.publish(relays, event)

  const results = await Promise.allSettled(
    promises.map((p) => Promise.race([
      p,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 15_000)),
    ]))
  )

  const accepted: string[] = []
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      accepted.push(relays[i])
    }
  })

  return accepted
}

/**
 * Publish an event progressively — calls onProgress after each relay confirms/rejects.
 * Each relay has a 15-second timeout.
 * Resolves once ALL relays have responded or timed out.
 * @param relayUrls Optional specific relay list. Defaults to global activeRelays.
 * @returns Array of relay URLs that accepted the event
 */
export function publishEventProgressive(
  event: Event,
  onProgress: (confirmed: number, total: number, acceptedRelays: string[]) => void,
  relayUrls?: string[]
): Promise<string[]> {
  const relays = relayUrls && relayUrls.length > 0 ? [...relayUrls] : getRelays()
  const total = relays.length
  const promises = pool.publish(relays, event)
  let confirmed = 0
  const accepted: string[] = []

  return new Promise((resolve) => {
    let settled = 0
    promises.forEach((p, i) => {
      Promise.race([
        p,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 15_000)),
      ]).then(() => {
        confirmed++
        accepted.push(relays[i])
        onProgress(confirmed, total, [...accepted])
      }).catch(() => {
        // Relay rejected or timed out — don't count as confirmed
      }).finally(() => {
        settled++
        if (settled === total) resolve(accepted)
      })
    })
  })
}

/**
 * Throw a user-facing error if no relay accepted the event. Pass the `accepted`
 * array returned by publishEvent / publishToSpecificRelays / publishEventProgressive.
 * Used by user-facing writes so a dead-relay publish fails loudly instead of
 * silently looking published. (Background/best-effort publishes don't use this.)
 */
export function assertPublished(accepted: string[] | undefined): void {
  if (!accepted || accepted.length === 0) {
    throw new Error("Couldn't reach any relay — your message wasn't published. Check your connection or relay settings and try again.")
  }
}

/**
 * Publish an event to a SPECIFIC set of relays (not the global activeRelays).
 * Each relay has a 15-second timeout.
 */
export async function publishToSpecificRelays(relays: string[], event: Event): Promise<string[]> {
  if (relays.length === 0) return publishEvent(event) // fallback to default

  const promises = pool.publish(relays, event)

  const results = await Promise.allSettled(
    promises.map((p) => Promise.race([
      p,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 15_000)),
    ]))
  )

  const accepted: string[] = []
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      accepted.push(relays[i])
    }
  })

  return accepted
}

/**
 * Fetch events matching a filter from active relays.
 * Waits for all relays to respond (or timeout).
 */
export async function fetchEvents(filter: Filter | Filter[]): Promise<Event[]> {
  // nostr-tools querySync takes a single Filter; merge if array provided
  const merged = Array.isArray(filter)
    ? filter.reduce<Filter>((acc, f) => ({ ...acc, ...f }), {})
    : filter
  return pool.querySync(getRelays(), merged)
}

/**
 * Subscribe to real-time events matching a filter.
 * Returns an object with an unsubscribe function.
 */
export function subscribeEvents(
  filter: Filter,
  onEvent: (event: Event) => void,
  onEose?: () => void
): { close: () => void } {
  const sub = pool.subscribeMany(
    getRelays(),
    filter,
    {
      onevent: onEvent,
      oneose: onEose,
    }
  )

  return { close: () => sub.close() }
}

/**
 * Subscribe to events on SPECIFIC relays (not the global activeRelays).
 * Used for hub-specific relay subscriptions where each hub defines its own relay set.
 */
export function subscribeToRelays(
  relays: string[],
  filter: Filter,
  onEvent: (event: Event) => void,
  onEose?: () => void
): { close: () => void } {
  const sub = pool.subscribeMany(
    relays,
    filter,
    {
      onevent: onEvent,
      oneose: onEose,
    }
  )

  return { close: () => sub.close() }
}

/**
 * Fetch a single event by ID.
 */
export async function fetchEventById(id: string): Promise<Event | null> {
  const events = await fetchEvents({ ids: [id] })
  return events[0] ?? null
}

/**
 * Fetch the latest replaceable event for a pubkey and kind.
 */
export async function fetchReplaceable(
  pubkey: string,
  kind: number,
  dTag?: string
): Promise<Event | null> {
  const filter: Filter = { authors: [pubkey], kinds: [kind], limit: 1 }
  if (dTag !== undefined) {
    filter['#d'] = [dTag]
  }

  const events = await fetchEvents(filter)
  return events[0] ?? null
}

/**
 * Fetch events matching a filter from SPECIFIC relays (not the global activeRelays).
 * Used for DNN relay discovery — querying a user's published relay list.
 */
export async function fetchEventsFromRelays(relays: string[], filter: Filter | Filter[]): Promise<Event[]> {
  if (relays.length === 0) return fetchEvents(filter)
  const merged = Array.isArray(filter)
    ? filter.reduce<Filter>((acc, f) => ({ ...acc, ...f }), {})
    : filter
  return pool.querySync(relays, merged)
}

/**
 * Close all relay connections.
 */
export function closeAllConnections() {
  pool.close(getRelays())
}
