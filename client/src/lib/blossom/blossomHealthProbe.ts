/**
 * blossomHealthProbe: a universal, cached "does this Blossom server actually work for me" check.
 *
 * The reachability dot (SettingsPage BlossomHealthDot) only proves a HEAD request returns. That's not the
 * failure that breaks hubs/media: a Blossom server can respond to HEAD yet reject uploads (415/401/CORS)
 * or refuse to serve a blob back. This store does the REAL test, everywhere, as a labeled badge beside the
 * dot: upload a tiny fixed probe blob to one server, then fetch it straight back by hash and verify the
 * bytes. Accepted + served back + hash matches => working; otherwise => broken. This is the Blossom
 * analogue of relayHealthProbe (publish + read-back for relays).
 *
 * The probe blob is a fixed ~24-byte payload, so it is content-addressed to the SAME hash every time:
 * re-probing never creates new data (an idempotent re-PUT), and the one kind-24242 upload auth is per-hash
 * (valid for every server), so a whole sweep signs ONCE. Results are cached per server URL with a TTL and
 * persisted, so labels auto-fill on open and show instantly next session. In-flight probes are deduped.
 */

import { create } from 'zustand'
import { computeHash, createAuthHeader } from './client'
import { useUserStore } from '@/stores/userStore'

export type BlossomHealth = 'checking' | 'working' | 'broken'

/** How long a cached result stays fresh before an auto-probe re-checks it (background, keeping the label). */
const TTL_MS = 24 * 60 * 60_000
/** Persisted results older than this are dropped on load and re-checked fresh (longer than TTL_MS). */
const PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60_000
const LS_KEY = 'den_blossom_health'

/** Dedicated timeout per probe PUT and per read-back GET. Short on purpose: a server that hangs on write
 *  or read should be flagged quickly, not drag the whole sweep. */
const HEALTH_PROBE_TIMEOUT_MS = 5000

const norm = (u: string) => u.replace(/\/+$/, '')

/** The fixed probe payload + its (lazily computed) content hash. Same bytes forever ⇒ same hash forever. */
const PROBE_BYTES = new TextEncoder().encode('den-blossom-health-probe')
let _probeHash = ''
function probeHash(): string {
  if (!_probeHash) _probeHash = computeHash(PROBE_BYTES)
  return _probeHash
}

// ── One shared upload auth per sweep (per-hash ⇒ valid for every server). Re-signed when near expiry. ──
const AUTH_TTL_MS = 8 * 60_000 // re-sign before the 10-min 24242 expiration
let authCache: { header: string; signedAt: number } | null = null
let authPromise: Promise<string | null> | null = null

function resetProbeAuth() { authCache = null; authPromise = null }

async function signProbeAuth(): Promise<string | null> {
  const { signer, privateKey } = useUserStore.getState()
  if (!signer && !privateKey) return null // logged out / no key: can't sign an upload auth
  try {
    const header = await createAuthHeader('upload', probeHash(), signer, privateKey)
    authCache = { header, signedAt: Date.now() }
    return header
  } catch {
    return null
  }
}

function getProbeAuth(): Promise<string | null> {
  if (authCache && Date.now() - authCache.signedAt < AUTH_TTL_MS) return Promise.resolve(authCache.header)
  if (!authPromise) authPromise = signProbeAuth().finally(() => { authPromise = null })
  return authPromise
}

/**
 * One probe pass: PUT the probe blob (tests WRITE, always uploaded, never skipped on HEAD, since write
 * rejection is the failure we care about), then GET it back by hash and verify the bytes. 'broken' when the
 * upload is refused, the read-back fails, or the bytes don't match.
 */
async function probeOnce(url: string, authHeader: string): Promise<{ health: 'working' | 'broken'; range: boolean }> {
  const hash = probeHash()
  try {
    const putRes = await fetch(`${norm(url)}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'Authorization': authHeader },
      body: new Blob([PROBE_BYTES.buffer as ArrayBuffer]),
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    }).catch(() => null)
    if (!putRes?.ok) return { health: 'broken', range: false }

    const getRes = await fetch(`${norm(url)}/${hash}`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    }).catch(() => null)
    if (!getRes?.ok) return { health: 'broken', range: false }
    const back = new Uint8Array(await getRes.arrayBuffer())
    if (computeHash(back) !== hash) return { health: 'broken', range: false }

    // Partial-fetch capability: request a sub-range and verify the returned bytes EXACTLY match the known
    // probe content. Requires BOTH a 206 and correct bytes: a 200 (range ignored, full body served) or any
    // mismatch ⇒ false. Runs in the browser, so it also reflects CORS: this is range fetching as the client
    // would really use it (pull only a member's path out of a large roster blob instead of the whole file).
    let range = false
    try {
      const a = 5, b = 15 // a sub-range well inside the 24-byte probe blob
      const rr = await fetch(`${norm(url)}/${hash}`, {
        headers: { Range: `bytes=${a}-${b}` },
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      }).catch(() => null)
      if (rr && rr.status === 206) {
        const part = new Uint8Array(await rr.arrayBuffer())
        const want = PROBE_BYTES.slice(a, b + 1)
        range = part.length === want.length && part.every((v, i) => v === want[i])
      }
    } catch { /* range stays false */ }

    return { health: 'working', range }
  } catch {
    return { health: 'broken', range: false }
  }
}

function loadPersisted(): { status: Record<string, BlossomHealth>; checkedAt: Record<string, number>; range: Record<string, boolean> } {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return { status: {}, checkedAt: {}, range: {} }
    const parsed = JSON.parse(raw) as Record<string, { status?: string; checkedAt?: number; range?: boolean }>
    const status: Record<string, BlossomHealth> = {}
    const checkedAt: Record<string, number> = {}
    const range: Record<string, boolean> = {}
    const now = Date.now()
    for (const [url, e] of Object.entries(parsed)) {
      if (e && (e.status === 'working' || e.status === 'broken') && typeof e.checkedAt === 'number' && now - e.checkedAt < PERSIST_MAX_AGE_MS) {
        status[url] = e.status
        checkedAt[url] = e.checkedAt
        if (typeof e.range === 'boolean') range[url] = e.range
      }
    }
    return { status, checkedAt, range }
  } catch {
    return { status: {}, checkedAt: {}, range: {} }
  }
}

function persistState(status: Record<string, BlossomHealth>, checkedAt: Record<string, number>, range: Record<string, boolean>): void {
  try {
    const out: Record<string, { status: BlossomHealth; checkedAt: number; range?: boolean }> = {}
    for (const [url, st] of Object.entries(status)) {
      if (st === 'working' || st === 'broken') out[url] = { status: st, checkedAt: checkedAt[url] ?? Date.now(), ...(range[url] !== undefined ? { range: range[url] } : {}) }
    }
    localStorage.setItem(LS_KEY, JSON.stringify(out))
  } catch { /* storage unavailable: non-fatal */ }
}

interface BlossomHealthState {
  status: Record<string, BlossomHealth>
  checkedAt: Record<string, number>
  /** Per working server: does it serve HTTP byte-range requests correctly (verified 206 + exact bytes)? */
  range: Record<string, boolean>
  /** While 'checking', the probe-pass progress {done, total} for a live "(n/n)" label. */
  progress: Record<string, { done: number; total: number }>
  /** Auto-probe a server (no-op if fresh or already in flight). */
  probe: (url: string) => void
  /** Force a re-probe of one server regardless of TTL (shows 'checking (n/n)'). */
  refresh: (url: string) => void
  /** Re-check ONE server now, preserving its checkedAt so the automatic 24h schedule is unchanged. */
  recheck: (url: string) => void
  /** Force a re-probe of many servers (one shared fresh auth), for a "Test again" button. */
  refreshAll: (urls: string[]) => void
  /** Record a known result directly (e.g. the hub Blossom-fix probe). */
  setStatus: (url: string, health: 'working' | 'broken') => void
}

const inFlight = new Set<string>()
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export const useBlossomHealthStore = create<BlossomHealthState>((set, get) => {
  const persist = () => { const s = get(); persistState(s.status, s.checkedAt, s.range) }
  const run = (url: string, force = false, keepTimestamp = false) => {
    const n = norm(url)
    if (!n || inFlight.has(n)) return
    inFlight.add(n)
    const prev = get().status[n]
    const prevCheckedAt = get().checkedAt[n]
    // Never flip to broken on a single pass: a WORKING server needs 2 extra confirming passes (3 total)
    // before it's marked broken; any other case needs 1 extra (2 total). Mirrors the relay probe.
    const needed = prev === 'working' ? 3 : 2
    const setProg = (pass: number) => set((s) => ({ progress: { ...s.progress, [n]: { done: pass, total: needed } } }))
    set((s) => ({ status: { ...s.status, [n]: force ? 'checking' : (s.status[n] ?? 'checking') }, progress: { ...s.progress, [n]: { done: 1, total: needed } } }))
    ;(async () => {
      let result: BlossomHealth | null = 'broken'
      let rangeCap = false
      try {
        const auth = await getProbeAuth()
        if (!auth) {
          result = null // no auth (logged out / no key): show no label, keep the reachability dot
        } else {
          let r = await probeOnce(url, auth) // pass 1
          for (let pass = 2; pass <= needed && r.health === 'broken'; pass++) {
            setProg(pass)
            await delay(1200) // a confirming pass that comes back working keeps it working
            r = await probeOnce(url, auth)
          }
          result = r.health
          rangeCap = r.range
        }
      } catch {
        result = 'broken'
      }
      inFlight.delete(n)
      set((s) => {
        const status = { ...s.status }
        const checkedAt = { ...s.checkedAt }
        const range = { ...s.range }
        const progress = { ...s.progress }
        delete progress[n]
        if (result === null) { delete status[n]; delete checkedAt[n]; delete range[n] }
        else {
          status[n] = result
          checkedAt[n] = keepTimestamp && prevCheckedAt ? prevCheckedAt : Date.now()
          if (result === 'working') range[n] = rangeCap
          else delete range[n]
        }
        return { status, checkedAt, range, progress }
      })
      persist()
    })()
  }

  const initial = loadPersisted()
  return {
    status: initial.status,
    checkedAt: initial.checkedAt,
    range: initial.range,
    progress: {},
    probe: (url) => {
      const n = norm(url)
      const st = get()
      const cached = st.status[n]
      if (cached && cached !== 'checking' && Date.now() - (st.checkedAt[n] ?? 0) < TTL_MS) return
      run(url)
    },
    refresh: (url) => { resetProbeAuth(); run(url, true) },
    recheck: (url) => { run(url, true, true) },
    refreshAll: (urls) => {
      resetProbeAuth()
      void getProbeAuth() // kick off a single shared re-sign so every server tests with the same auth
      for (const u of urls) run(u, true)
    },
    setStatus: (url, health) => {
      const n = norm(url)
      if (!n) return
      set((s) => {
        const range = { ...s.range }
        delete range[n] // a directly-set result carries no range-capability info; a probe will fill it in
        return { status: { ...s.status, [n]: health }, checkedAt: { ...s.checkedAt, [n]: Date.now() }, range }
      })
      persist()
    },
  }
})

/** Convenience: the current health of a server (for non-component callers). */
export function blossomHealthOf(url: string): BlossomHealth | undefined {
  return useBlossomHealthStore.getState().status[norm(url)]
}

/**
 * Stable-sort Blossom URLs so the ones the health check found 'working' come first, then untested, then
 * 'broken'. Stable, so the caller's base order is preserved within each tier. Falls back to the base order
 * when nothing's been probed yet. The Blossom analogue of orderByHealth for relays.
 */
export function orderByBlossomHealth(urls: string[]): string[] {
  const rank = (u: string) => {
    const h = blossomHealthOf(u)
    return h === 'working' ? 0 : h === 'broken' ? 2 : 1
  }
  return [...urls].sort((a, b) => rank(a) - rank(b))
}
