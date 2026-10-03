/**
 * relayHealthProbe: a universal, cached "does this relay actually work for me" check.
 *
 * The reachability dot (SettingsPage RelayHealthDot) only proves a WebSocket connects. That's not the
 * failure that breaks hubs/DMs: a relay can connect fine yet reject writes or refuse to serve events
 * back (degmods was exactly this). This store does the REAL test, everywhere, as a labeled badge beside
 * the dot: publish one of the USER'S OWN already-signed events to a single relay, then fetch it straight
 * back from that same relay by id. Accepted + served back => working; otherwise => broken.
 *
 * Probe payload (what the user "published related to hubs"): their own most recent hub message if we hold
 * one locally (v1 messages are authored by their real key, so identifiable), else their own relay list
 * (kind 10002) or profile (kind 0). Any of these is the user's own event and belongs on a relay, so
 * re-publishing it to test is harmless (and doubles as redundancy).
 *
 * Results are cached per relay URL with a TTL and shared across the whole UI, so the labels are auto-
 * filled on open and shown instantly next time. In-flight probes are deduped per URL.
 */

import { create } from 'zustand'
import type { Event } from 'nostr-tools'
import { publishToSpecificRelays, fetchEventsFromRelays, fetchReplaceable } from './relay-pool'
import { useUserStore } from '@/stores/userStore'
import { useMessageStore } from '@/stores/messageStore'
import { STANDARD_KINDS } from '@/lib/crypto/constants'

export type RelayHealth = 'checking' | 'working' | 'broken'

/** How long a cached result stays fresh before an auto-probe re-checks it (in the background, keeping the
 *  last label visible). Reopening a relay list within this window is pure cache: no probe, no 'checking'. */
const TTL_MS = 24 * 60 * 60_000

/** Persisted results older than this are dropped on load and re-checked fresh. Longer than TTL_MS so a
 *  merely-stale result is still shown instantly (and re-checked in the background), not dropped. */
const PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60_000
const LS_KEY = 'den_relay_health'

const norm = (u: string) => u.replace(/\/+$/, '')

/** Load cached results from a previous session so labels show instantly after a restart (no 'checking'). */
function loadPersisted(): { status: Record<string, RelayHealth>; checkedAt: Record<string, number> } {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return { status: {}, checkedAt: {} }
    const parsed = JSON.parse(raw) as Record<string, { status?: string; checkedAt?: number }>
    const status: Record<string, RelayHealth> = {}
    const checkedAt: Record<string, number> = {}
    const now = Date.now()
    for (const [url, e] of Object.entries(parsed)) {
      if (e && (e.status === 'working' || e.status === 'broken') && typeof e.checkedAt === 'number' && now - e.checkedAt < PERSIST_MAX_AGE_MS) {
        status[url] = e.status
        checkedAt[url] = e.checkedAt
      }
    }
    return { status, checkedAt }
  } catch {
    return { status: {}, checkedAt: {} }
  }
}

function persistState(status: Record<string, RelayHealth>, checkedAt: Record<string, number>): void {
  try {
    const out: Record<string, { status: RelayHealth; checkedAt: number }> = {}
    for (const [url, st] of Object.entries(status)) {
      if (st === 'working' || st === 'broken') out[url] = { status: st, checkedAt: checkedAt[url] ?? Date.now() }
    }
    localStorage.setItem(LS_KEY, JSON.stringify(out))
  } catch { /* storage unavailable: non-fatal */ }
}

interface RelayHealthState {
  status: Record<string, RelayHealth>
  checkedAt: Record<string, number>
  /** While a relay is 'checking', its probe-attempt progress {done, total} (for a live "(n/n)" label). */
  progress: Record<string, { done: number; total: number }>
  /** Auto-probe a relay (no-op if fresh or already in flight). Updates `status` when it resolves. */
  probe: (url: string) => void
  /** Force a re-probe of one relay regardless of the TTL (shows 'checking (n/n)'), used by an explicit re-test. */
  refresh: (url: string) => void
  /** Force a re-probe of many relays (one shared fresh probe event), used by the "Test again" button. */
  refreshAll: (urls: string[]) => void
  /** Record a known result directly (e.g. the hub-event probe in the relay fix modal). */
  setStatus: (url: string, health: 'working' | 'broken') => void
}

// The probe event is the same for every relay in a session, so fetch/find it once and reuse.
let probeEventPromise: Promise<Event | null> | null = null
function resetProbeEvent() { probeEventPromise = null }

async function resolveProbeEvent(): Promise<Event | null> {
  const me = useUserStore.getState().pubkey
  if (!me) return null

  // 1. One of the user's OWN hub messages we already hold (v1: authored by their real key).
  const byHub = useMessageStore.getState().messages
  for (const byChannel of Object.values(byHub)) {
    for (const list of Object.values(byChannel)) {
      for (const m of list) {
        if (m.pubkey === me && m.rawEvent) {
          try { return JSON.parse(m.rawEvent) as Event } catch { /* keep looking */ }
        }
      }
    }
  }

  // 2. Fall back to the user's own relay list (10002), then profile (0): always theirs, always
  //    belongs on relays, and works for v2-only users whose hub messages are pseudonym-authored.
  return (await fetchReplaceable(me, STANDARD_KINDS.RELAY_LIST).catch(() => null))
    ?? (await fetchReplaceable(me, STANDARD_KINDS.USER_METADATA).catch(() => null))
}

function getProbeEvent(): Promise<Event | null> {
  if (!probeEventPromise) probeEventPromise = resolveProbeEvent()
  return probeEventPromise
}

const inFlight = new Set<string>()
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** How many read-back attempts within ONE probe pass before it concludes broken (tolerates indexing lag). */
const READBACK_ATTEMPTS = 3

/**
 * One probe pass: publish `ev` once, then read it back with a few increasingly patient attempts. Relays
 * routinely EOSE a query BEFORE a just-published event is indexed, so a single immediate read-back gave
 * flaky false-broken results. 'broken' only when the write was refused outright or every read-back failed.
 */
async function probeOnce(url: string, ev: Event, onAttempt?: () => void): Promise<'working' | 'broken'> {
  let accepted = false
  for (let attempt = 0; attempt < READBACK_ATTEMPTS; attempt++) {
    onAttempt?.() // one step of progress per loop iteration
    if (!accepted) {
      const got = await publishToSpecificRelays([url], ev).catch(() => [] as string[])
      accepted = got.length > 0
      if (!accepted) { await delay(500); continue } // write refused: retry the write
    }
    await delay(500 + attempt * 700) // give the relay time to index before reading back
    const back = await fetchEventsFromRelays([url], { ids: [ev.id] }).catch(() => [])
    if (back.some((e) => e.id === ev.id)) return 'working'
  }
  return 'broken'
}

export const useRelayHealthStore = create<RelayHealthState>((set, get) => {
  const persist = () => { const s = get(); persistState(s.status, s.checkedAt) }
  const run = (url: string, force = false) => {
    const n = norm(url)
    if (!n || inFlight.has(n)) return
    inFlight.add(n)
    const prev = get().status[n]
    // Never flip to broken on a single pass: a WORKING relay needs 2 extra confirming passes (3 total)
    // before it's marked broken; any other case needs 1 extra (2 total). Progress counts one step per
    // read-back loop iteration across all the passes we might run.
    const needed = prev === 'working' ? 3 : 2
    const total = needed * READBACK_ATTEMPTS
    let done = 0
    const bump = () => { done++; set((s) => ({ progress: { ...s.progress, [n]: { done, total } } })) }
    // Background re-checks keep any prior result visible (only show 'checking' on the first probe ever),
    // so they don't flash the label. An explicit re-test (force) shows 'checking (n/n)' so the user sees it run.
    set((s) => ({ status: { ...s.status, [n]: force ? 'checking' : (s.status[n] ?? 'checking') }, progress: { ...s.progress, [n]: { done: 0, total } } }))
    ;(async () => {
      let result: RelayHealth | null = 'broken'
      try {
        const ev = await getProbeEvent()
        if (!ev) {
          result = null // no probe event available (e.g. logged-out) => show no label, keep the dot
        } else {
          let r = await probeOnce(url, ev, bump)
          for (let brokenRuns = 1; brokenRuns < needed && r === 'broken'; brokenRuns++) {
            await delay(1500) // a confirming pass that comes back working keeps it working
            r = await probeOnce(url, ev, bump)
          }
          result = r
        }
      } catch {
        result = 'broken'
      }
      inFlight.delete(n)
      set((s) => {
        const status = { ...s.status }
        const checkedAt = { ...s.checkedAt }
        const progress = { ...s.progress }
        delete progress[n]
        if (result === null) { delete status[n]; delete checkedAt[n] }
        else { status[n] = result; checkedAt[n] = Date.now() }
        return { status, checkedAt, progress }
      })
      persist()
    })()
  }

  const initial = loadPersisted()
  return {
    status: initial.status,
    checkedAt: initial.checkedAt,
    progress: {},
    probe: (url) => {
      const n = norm(url)
      const st = get()
      const cached = st.status[n]
      if (cached && cached !== 'checking' && Date.now() - (st.checkedAt[n] ?? 0) < TTL_MS) return
      run(url)
    },
    refresh: (url) => { resetProbeEvent(); run(url, true) },
    refreshAll: (urls) => {
      resetProbeEvent()
      void getProbeEvent() // kick off a single shared re-fetch so every relay tests with the same event
      for (const u of urls) run(u, true)
    },
    setStatus: (url, health) => {
      const n = norm(url)
      if (!n) return
      set((s) => ({ status: { ...s.status, [n]: health }, checkedAt: { ...s.checkedAt, [n]: Date.now() } }))
      persist()
    },
  }
})

/** Convenience: the current health of a relay (for non-component callers, e.g. the hub banner). */
export function relayHealthOf(url: string): RelayHealth | undefined {
  return useRelayHealthStore.getState().status[norm(url)]
}
