import {
  SimplePool,
  type Filter,
  type Event,
} from 'nostr-tools'
import { StorageKey } from '@/lib/constants'

// enableReconnect: when a relay's websocket drops (laptop sleep, network blip, relay restart) nostr-tools
// reconnects with backoff and RE-ISSUES every open subscription (with `since = last seen + 1`). Without it
// the default is `closeAllSubscriptions` — every live sub on that relay died silently and stayed dead
// until the app restarted, which is why DMs/hub messages could stop arriving for days and then all show
// up on the next launch. enablePing detects half-dead connections that never fire onclose.
const pool = new SimplePool({ enableReconnect: true, enablePing: true })

/** Max time a one-shot query waits before returning what responsive relays have.
 *  Prevents a slow/dead relay from stalling the whole fetch. */
const FETCH_MAX_WAIT_MS = 4000

/** Per-relay publish timeout: how long to wait for a relay's OK before treating it as failed. */
const PUBLISH_TIMEOUT_MS = 15_000

/** Default relays — user can customize these later */
const DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://nostr.mom',
  'wss://wheat.happytavern.co',
  'wss://relay.snort.social',
  'wss://nostr.bitcoiner.social',
  'wss://relay.layer.systems',
  'wss://nostr.oxtr.dev',
  'wss://relay.ditto.pub',
  'wss://relay.nostr.net',
  'wss://offchain.pub',
  'wss://nostr-01.yakihonne.com',
  // Curated against a per-relay WRITE test (publish a kind 1) and a write+READ-BACK health test (publish
  // one of the user's own events, then fetch it back from that relay). Kept only relays that accept writes
  // AND serve them back.
  //
  // 2026-10: relay.wellorder.net removed. The health check (and a third-party tool) found it accepts a
  // write but returns nothing on read-back, so events sent there were unreadable. nos.lol and nostr.mom
  // briefly failed the same way and were removed, but recovered (re-tested working) and are back above.
  // Added oxtr.dev, ditto.pub, nostr.net, offchain.pub and nostr-01.yakihonne.com, which passed the
  // write+read-back test. relay.layer.systems is back after its TLS cert was fixed.
  // Earlier removals (dead / write-rejecting / unreachable / read-hanging): relay.nostr.band, nostr.novacisko.cz,
  // relay.cxplay.org, relay.nostr.moe, relay.poster.place, relay.nostr.info, pyramid.fiatjaf.com (WoT
  // write-gated), relay.noswhere.com & search.nos.today (search-only), relay.0xchat.com (connection refused),
  // nostrcheck.me (socket opens but never answers REQ / sends EOSE). All retired below.
  //
  // The dead/broken former-defaults are stripped from existing users' SAVED lists once (RETIRED_DEFAULT_RELAYS
  // / purgeRetiredRelaysOnce; mergeMissingDefaults only ADDS). Critical events publish via publishWithFailover,
  // which also prefers 'working' relays, so a transiently-dead relay can't strand them.
]

/**
 * Former default relays confirmed dead (reject writes / unreachable). Because mergeMissingDefaults only
 * ADDS missing defaults and never removes, a user who was auto-seeded these before they were retired keeps
 * them in localStorage forever — wasting every publish/subscribe attempt on them and skewing the "N/M
 * relays" indicators. purgeRetiredRelaysOnce() strips exactly these URLs from the saved list a single time
 * (guarded by a flag), so a user who deliberately re-adds one later is respected.
 */
const RETIRED_DEFAULT_RELAYS = [
  // (relay.layer.systems was retired here for an expired TLS cert; re-added to DEFAULT_RELAYS 2026-10
  //  after it tested healthy again, so it is intentionally no longer listed as retired.)
  'wss://relay.nostr.band',
  'wss://nostr.novacisko.cz',
  'wss://relay.cxplay.org',
  'wss://relay.nostr.moe',
  'wss://relay.poster.place',
  // 2026-10: dead/unresponsive on READ (see DEFAULT_RELAYS note): nostrcheck.me especially hangs every
  // querySync (connects but never EOSEs), which was breaking DM fetching pool-wide.
  'wss://relay.0xchat.com',
  'wss://nostrcheck.me',
  // 2026-10: accepts writes but serves nothing back on read (confirmed by the health check + a third-party
  // tool), so events sent there were unreadable. (nos.lol and nostr.mom had the same issue but recovered,
  // so they are back in DEFAULT_RELAYS and intentionally not listed here.)
  'wss://relay.wellorder.net',
].map((u) => u.replace(/\/+$/, ''))

// Bumped to v3 so the one-time purge re-runs for users already purged under v1/v2 (to strip the
// newly-retired nos.lol / relay.wellorder.net / nostr.mom from their saved client relay list).
const RETIRED_PURGE_FLAG = 'den-relays-retired-purge-v3'

/** One-time (ever) removal of confirmed-dead former-default relays from the saved client relay list. */
function purgeRetiredRelaysOnce(): void {
  try {
    if (localStorage.getItem(RETIRED_PURGE_FLAG)) return
    const raw = localStorage.getItem(StorageKey.CLIENT_RELAYS)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const retired = new Set(RETIRED_DEFAULT_RELAYS)
        const norm = (u: string) => u.replace(/\/+$/, '')
        const cleaned = parsed.filter((r) => r && typeof r.url === 'string' && !retired.has(norm(r.url)))
        if (cleaned.length !== parsed.length) {
          localStorage.setItem(StorageKey.CLIENT_RELAYS, JSON.stringify(cleaned))
        }
      }
    }
    localStorage.setItem(RETIRED_PURGE_FLAG, '1')
  } catch { /* ignore — best-effort cleanup */ }
}

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
    purgeRetiredRelaysOnce()
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
    purgeRetiredRelaysOnce()
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
  // No relays at all (empty explicit list AND empty client list): nothing will ever settle, so
  // resolve now instead of hanging the caller forever.
  if (total === 0) {
    onProgress(0, 0, [])
    return Promise.resolve([])
  }
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
 * Publish a HUB-CRITICAL event (hub event, join request, facilitator/mod list) with relay FAILOVER —
 * the write-side companion to getPublishRelays. Seeds the relay set the caller already computed (usually
 * `getPublishRelays([...hub.generalRelays])`), then falls over to the hub + client relay pool until enough
 * accept, so a membership/settings/facilitator change can't be stranded on a fixed dead relay set (the bug
 * we fixed for v2 `republishV2*`). Returns the accepted relays ([] if none — callers should throw on that).
 *
 * `poolExtra` is the hub's own relays (the event's natural home); the client relay pool is always appended
 * for reach. For a v2 PSEUDONYM-authored event the client relays are already part of the caller's seed, so
 * this adds no new personal-relay footprint beyond what the seed already targets.
 */
export async function publishCriticalWithFailover(
  event: Event,
  seedRelays: string[],
  poolExtra: string[] = [],
): Promise<string[]> {
  return publishWithFailover(event, seedRelays, { pool: [...poolExtra, ...getRelays()] })
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
 * Each relay has a `timeoutMs` timeout (default PUBLISH_TIMEOUT_MS = 15s; the relay-health probe passes a
 * shorter one so a hanging relay doesn't drag the check out).
 */
export async function publishToSpecificRelays(relays: string[], event: Event, timeoutMs: number = PUBLISH_TIMEOUT_MS): Promise<string[]> {
  if (relays.length === 0) return publishEvent(event) // fallback to default

  const promises = pool.publish(relays, event)

  const results = await Promise.allSettled(
    promises.map((p) => Promise.race([
      p,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
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
 * Publish a critical event with FAILOVER. Tries `seedRelays` first; if fewer than `target` relays
 * accept, keeps trying more relays from `opts.pool` (a batch at a time, with a small over-provision)
 * until `target` accept or the candidate list is exhausted. Returns every relay that accepted.
 *
 * Unlike publishToSpecificRelays (fire-once to a fixed set), a dead / write-rejecting relay in the
 * seed set can no longer strand a publish — it routes around to healthy relays, so as long as ANY
 * reachable relay in the candidate list accepts writes, the event lands.
 *
 * PRIVACY: `opts.pool` is supplied EXPLICITLY by the caller and is NOT defaulted to the user's
 * personal relays. This is deliberate — a privacy-scoped event (a v2 hub event/message authored by a
 * pseudonym) must fail over ONLY within the hub's own relays; expanding it onto the user's personal
 * (R-advertised) relays would link the pseudonym to R. Callers pass the pool that matches the event's
 * privacy boundary: client+NIP-65 relays for the user's own events, hub relays only for hub events.
 */
/**
 * Globally-registered relay ranker (lower = tried first), set by the relay-health layer so publishWithFailover
 * can prefer 'working' relays without relay-pool importing the health store (which would be a cycle).
 */
let publishRanker: ((url: string) => number) | null = null
export function setPublishRanker(fn: ((url: string) => number) | null): void { publishRanker = fn }

export async function publishWithFailover(
  event: Event,
  seedRelays: string[],
  opts: {
    pool?: string[]
    target?: number
    /** Called after each failover batch (and once at the start) so a send UI can show live progress. */
    onProgress?: (confirmed: number, total: number, acceptedRelays: string[]) => void
    /** Try relays with a lower rank first (e.g. map 'working' relays to 0 and 'broken' to 2 so the
     *  target is reached on healthy relays before a known-broken one is even attempted). Stable, so the
     *  caller's deterministic order is preserved within each rank tier. */
    rank?: (url: string) => number
  } = {},
): Promise<string[]> {
  const target = opts.target ?? 3
  const norm = (u: string) => u.replace(/\/+$/, '')
  // Ordered, deduped candidate list: seed relays first (the event's natural home), then the pool.
  const candidates: string[] = []
  const seen = new Set<string>()
  for (const u of [...seedRelays, ...(opts.pool ?? [])]) {
    const n = norm(u)
    if (n && !seen.has(n)) { seen.add(n); candidates.push(u) }
  }
  // Prefer healthier relays first (stable sort keeps the deterministic within-tier order). Uses the
  // explicit rank if given, else the globally-registered health ranker (see setPublishRanker), so every
  // failover publish routes around known-broken relays without each caller wiring it up.
  const rank = opts.rank ?? publishRanker
  if (rank) candidates.sort((a, b) => rank(a) - rank(b))
  const accepted = new Set<string>()
  opts.onProgress?.(0, target, [])
  let i = 0
  while (accepted.size < target && i < candidates.length) {
    const need = target - accepted.size
    const batch = candidates.slice(i, i + need + 2) // small over-provision so one round usually suffices
    i += batch.length
    // Resolve this batch as soon as `need` relays ACK, without waiting out a slow/hanging relay in the batch
    // (its publish keeps running in the background). Only advance to the next batch if the batch settles
    // without reaching the target. This is what stops one unresponsive relay adding ~15s to every publish.
    await publishBatchAccepting(batch, event, need, (url) => {
      accepted.add(url)
      opts.onProgress?.(accepted.size, target, Array.from(accepted))
    })
  }
  return Array.from(accepted)
}

/**
 * Publish `event` to `relays` in parallel and resolve as soon as `need` of them ACK (calling `onAccept`
 * per relay as it does), instead of waiting for every relay to settle. Also resolves when all relays have
 * settled (fewer than `need` accepted) or a hard cap elapses, so a relay that connects but never ACKs
 * can't block it. Relays still publishing when it resolves keep going in the background. Resolves void;
 * the caller tracks the accepted set via `onAccept`.
 */
function publishBatchAccepting(
  relays: string[],
  event: Event,
  need: number,
  onAccept: (url: string) => void,
): Promise<void> {
  const norm = (u: string) => u.replace(/\/+$/, '')
  if (relays.length === 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let acceptCount = 0
    let settledCount = 0
    let done = false
    const finish = () => { if (done) return; done = true; clearTimeout(hard); resolve() }
    const promises = pool.publish(relays, event)
    promises.forEach((p, idx) => {
      Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('publish timeout')), PUBLISH_TIMEOUT_MS))])
        .then(() => { acceptCount++; onAccept(norm(relays[idx])); if (acceptCount >= need) finish() })
        .catch(() => { /* relay rejected / timed out */ })
        .finally(() => { settledCount++; if (settledCount >= promises.length) finish() })
    })
    const hard = setTimeout(finish, PUBLISH_TIMEOUT_MS + 1000)
  })
}

/**
 * After the first event arrives, if the still-open relays stay silent this long, resolve with what we
 * have instead of blocking for the full maxWait. This is the fix for a relay that connects but never
 * sends EOSE (e.g. nostrcheck.me): querySync's EOSE fires only on ALL-relay EOSE, so one such relay
 * used to stall EVERY fetch for the whole timeout and thrash the pool (it was silently breaking DM
 * fetching pool-wide). See collectEvents.
 */
const FETCH_IDLE_MS = 2000

/**
 * One-shot fetch that does NOT wait on a hung relay. Collects events (deduped by id) from `relays` and
 * resolves on the first of: all-relay EOSE (healthy fast path), an idle window after the last event, or
 * the hard `maxWait` cap.
 *
 * The idle window engages ONLY after the first event, so a query whose only answer lives on a slow relay
 * still waits the full maxWait (the window never starts). We only cut off a relay that goes silent AFTER
 * other relays have already delivered, which is exactly the all-EOSE stall we are fixing, not a slow
 * relay holding the sole copy. Callers that must wait for a slow relay pass idleMs = maxWait (done
 * automatically for the long-maxWait critical callers in fetchEvents).
 */
function collectEvents(relays: string[], filter: Filter, maxWait: number, idleMs: number): Promise<Event[]> {
  return new Promise((resolve) => {
    const byId = new Map<string, Event>()
    let settled = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const finish = () => {
      if (settled) return
      settled = true
      if (idleTimer) clearTimeout(idleTimer)
      clearTimeout(hard)
      try { sub.close() } catch { /* ignore */ }
      resolve([...byId.values()])
    }
    const resetIdle = () => {
      if (idleMs >= maxWait) return // idle disabled: the hard cap is the only early exit
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(finish, idleMs)
    }
    const sub = pool.subscribeMany(relays, filter, {
      maxWait,
      onevent(ev) { if (!byId.has(ev.id)) byId.set(ev.id, ev); resetIdle() },
      oneose() { finish() }, // all relays EOSE'd (healthy fast path)
    })
    const hard = setTimeout(finish, maxWait)
  })
}

/**
 * Fetch events matching a filter from active relays. Returns whatever the responsive relays gave us:
 * a single dead/hung relay cannot stall the whole query (see collectEvents / FETCH_IDLE_MS). Callers
 * that must not miss an event living only on a slow relay pass a longer maxWait; doing so also disables
 * the idle short-circuit (idleMs = maxWait), so those fetches wait in full as before.
 */
export async function fetchEvents(
  filter: Filter | Filter[],
  maxWait: number = FETCH_MAX_WAIT_MS,
): Promise<Event[]> {
  // subscribeMany takes a single Filter; merge if an array was provided (same as the old querySync path)
  const merged = Array.isArray(filter)
    ? filter.reduce<Filter>((acc, f) => ({ ...acc, ...f }), {})
    : filter
  // A longer-than-default maxWait signals "I need completeness, wait for slow relays" → no idle cutoff.
  const idleMs = maxWait > FETCH_MAX_WAIT_MS ? maxWait : Math.min(maxWait, FETCH_IDLE_MS)
  return collectEvents(getRelays(), merged, maxWait, idleMs)
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
  onEose?: () => void,
  opts?: {
    /**
     * NIP-42: called when a relay demands authentication (AUTH challenge / CLOSED auth-required).
     * nostr-tools builds the kind-22242 template (relay + challenge tags); we sign it. The pool sends
     * the AUTH and re-issues the subscription on its own. Omit for subscriptions that must never
     * reveal the user's real key to the relay (see lib/nostr/relayAuth.ts for the guarded signer).
     */
    onauth?: NonNullable<Parameters<typeof pool.subscribeMany>[2]['onauth']>
  },
): { close: () => void } {
  const sub = pool.subscribeMany(
    relays,
    filter,
    {
      onevent: onEvent,
      oneose: onEose,
      onauth: opts?.onauth,
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
export async function fetchEventsFromRelays(relays: string[], filter: Filter | Filter[], maxWait: number = FETCH_MAX_WAIT_MS): Promise<Event[]> {
  if (relays.length === 0) return fetchEvents(filter)
  const merged = Array.isArray(filter)
    ? filter.reduce<Filter>((acc, f) => ({ ...acc, ...f }), {})
    : filter
  // Same hung-relay protection as fetchEvents: a dead relay in this set can't stall the whole query.
  return collectEvents(relays, merged, maxWait, Math.min(maxWait, FETCH_IDLE_MS))
}

/**
 * Close all relay connections.
 */
export function closeAllConnections() {
  pool.close(getRelays())
}
