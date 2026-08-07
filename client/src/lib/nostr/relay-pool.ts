import {
  SimplePool,
  type Filter,
  type Event,
} from 'nostr-tools'
import { StorageKey } from '@/lib/constants'

const pool = new SimplePool()

/** Max time a one-shot query waits before returning what responsive relays have.
 *  Prevents a slow/dead relay from stalling the whole fetch. */
const FETCH_MAX_WAIT_MS = 4000

/** Default relays — user can customize these later */
const DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.snort.social',
  'wss://relay.wellorder.net',
  'wss://relay.nostr.info',
  'wss://nostr.mom',
  'wss://nostr.novacisko.cz',
  'wss://nostrcheck.me',
  'wss://pyramid.fiatjaf.com',
  'wss://relay.cxplay.org',
  'wss://relay.layer.systems',
  'wss://relay.nostr.moe',
  'wss://relay.poster.place',
  'wss://wheat.happytavern.co',
  'wss://relay.noswhere.com',
  'wss://search.nos.today',
]

/** In-memory cache — null means "not loaded yet" */
let activeRelaysCache: string[] | null = null

/**
 * Merge any default relays missing from a stored list, appended as enabled.
 * This lets existing installs automatically pick up newly-added defaults
 * (defaults are non-deletable anyway), while preserving stored order and each
 * relay's enabled/disabled state. Non-destructive — callers decide whether to persist.
 */
function mergeMissingDefaults(
  list: { url: string; enabled: boolean }[],
): { url: string; enabled: boolean }[] {
  const norm = (u: string) => u.replace(/\/+$/, '')
  const have = new Set(list.map((r) => norm(r.url)))
  const additions = DEFAULT_RELAYS
    .filter((url) => !have.has(norm(url)))
    .map((url) => ({ url, enabled: true }))
  return additions.length > 0 ? [...list, ...additions] : list
}

/**
 * Load enabled relays from localStorage.
 * Falls back to DEFAULT_RELAYS if nothing stored or all disabled.
 */
function loadRelays(): string[] {
  try {
    const stored = localStorage.getItem(StorageKey.CLIENT_RELAYS)
    if (stored) {
      const parsed = JSON.parse(stored) as { url: string; enabled: boolean }[]
      const merged = mergeMissingDefaults(parsed)
      const enabled = merged.filter((r) => r.enabled).map((r) => r.url)
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
      if (Array.isArray(parsed) && parsed.length > 0) return mergeMissingDefaults(parsed)
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
export async function fetchEvents(
  filter: Filter | Filter[],
  maxWait: number = FETCH_MAX_WAIT_MS,
): Promise<Event[]> {
  // nostr-tools querySync takes a single Filter; merge if array provided
  const merged = Array.isArray(filter)
    ? filter.reduce<Filter>((acc, f) => ({ ...acc, ...f }), {})
    : filter
  // Cap the wait so a single slow/dead relay can't stall the whole query — we
  // return everything the responsive relays gave us instead of hanging for the slowest.
  // Callers that must not miss an event living only on a slow relay (e.g. hub
  // loading) can pass a longer maxWait.
  return pool.querySync(getRelays(), merged, { maxWait })
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
 * Progressive one-shot fetch: streams events via subscribeMany and calls `onEvents`
 * with the accumulated, deduplicated, newest-first list as results arrive — so the UI
 * can paint the first events immediately (from the fastest relay) instead of blocking
 * on the whole batch. Closes on EOSE-from-all or `maxWait`, whichever comes first.
 *
 * Returns `{ close, done }`. `done` resolves with the final list; call `close()` to
 * abort early (e.g. on unmount / refetch) — that also resolves `done` with what we have.
 */
export function fetchEventsProgressive(
  filter: Filter,
  onEvents: (events: Event[]) => void,
  opts?: { maxWait?: number; relays?: string[] },
): { close: () => void; done: Promise<Event[]> } {
  const relays = opts?.relays ?? getRelays()
  const maxWait = opts?.maxWait ?? FETCH_MAX_WAIT_MS
  const byId = new Map<string, Event>()
  let closed = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let deadline: ReturnType<typeof setTimeout> | null = null

  const snapshot = () => [...byId.values()].sort((a, b) => b.created_at - a.created_at)
  const flush = () => { flushTimer = null; if (!closed) onEvents(snapshot()) }
  const scheduleFlush = () => { if (flushTimer == null) flushTimer = setTimeout(flush, 120) }

  let resolveDone!: (e: Event[]) => void
  const done = new Promise<Event[]>((r) => { resolveDone = r })

  const teardown = (emitFinal: boolean) => {
    if (closed) return
    closed = true
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    if (deadline) { clearTimeout(deadline); deadline = null }
    sub.close()
    if (emitFinal) onEvents(snapshot())
    resolveDone(snapshot())
  }

  const sub = pool.subscribeMany(relays, filter, {
    // Pass maxWait as the per-relay EOSE timeout too. Without it, subscribeMany
    // uses nostr-tools' short default (~4.4s), so oneose (fires on all-EOSE) can
    // trigger before a SLOW relay responds — and teardown would drop events that
    // only that relay has (e.g. the newest version of a replaceable event). The
    // deadline below is a hard cap on top of that.
    maxWait,
    onevent(ev) { if (!byId.has(ev.id)) { byId.set(ev.id, ev); scheduleFlush() } },
    oneose() { teardown(true) },
  })
  deadline = setTimeout(() => teardown(true), maxWait)

  return { close: () => teardown(false), done }
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
  dTag?: string,
  maxWait?: number,
): Promise<Event | null> {
  const filter: Filter = { authors: [pubkey], kinds: [kind], limit: 1 }
  if (dTag !== undefined) {
    filter['#d'] = [dTag]
  }

  // Callers fetching a critical replaceable (e.g. the hub list) can pass a longer
  // maxWait so a relay holding the newest version isn't cut off at the 4s default —
  // otherwise we'd pick "newest of what came back fast", i.e. a stale copy.
  const events = await fetchEvents(filter, maxWait)
  // Replaceable events: different relays may return different versions — pick the
  // newest by created_at rather than whichever relay answered first.
  if (events.length === 0) return null
  return events.reduce((newest, e) => (e.created_at > newest.created_at ? e : newest))
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
  return pool.querySync(relays, merged, { maxWait: FETCH_MAX_WAIT_MS })
}

/**
 * Close all relay connections.
 */
export function closeAllConnections() {
  pool.close(getRelays())
}
