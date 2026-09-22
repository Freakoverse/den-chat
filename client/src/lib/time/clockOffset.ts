/**
 * clockOffset: how far this device's clock is from the servers it talks to, and a corrected clock
 * for stamping outgoing events.
 *
 * Nostr timestamps are the sender's clock. A device that runs minutes fast puts its messages "in
 * the future" for everyone else. We measure the offset from `Date` headers of servers the user
 * already uses (relays via NIP-11, Blossom servers), NTP-style (server time against the midpoint of
 * the request), take the median, and only apply it when the sources agree. No third-party time
 * service for the installed client, where the native HTTP plugin sees every header and relays plus
 * Blossom servers are enough. On the web those servers hide `Date` behind CORS, so the pool is the
 * app's own origin (never hardcoded) plus Cloudflare's trace endpoint, whose body carries a
 * millisecond timestamp and is readable cross-origin. Two independent clocks for browser users.
 *
 * Load: one short probe set at launch when there is no usable measurement, then only when the
 * device clock visibly jumps (wall clock vs the monotonic clock) or the measurement is a week old.
 * The result is stored per device so restarts start corrected.
 */
import { isTauri } from '@/lib/utils'

const STORAGE_KEY = 'den-chat-clock-offset'
const LAST_ISSUED_KEY = 'den-chat-clock-last-issued'
/** Offsets below this are within measurement noise (1s Date headers + half a round trip). */
const APPLY_MIN_MS = 3_000
/** Samples farther than this from the median are outliers (a server with a wrong clock). */
const AGREE_MS = 2_000
/** Wall clock vs monotonic clock disagreement that means "the user changed the clock". */
const JUMP_MS = 5_000
const MAX_AGE_MS = 7 * 24 * 3600_000
const CHECK_EVERY_MS = 30 * 60_000
const PROBE_TIMEOUT_MS = 5_000
const MAX_RTT_MS = 4_000
/** Never stamp an event earlier than the last one this device stamped, within this window. */
const HOLD_BACK_MAX_MS = 10 * 60_000

interface Stored {
  offsetMs: number
  measuredAt: number   // wall ms
  samples: number
  hosts: string[]
}
interface Sample { host: string; offsetMs: number; rtt: number }

let offsetMs = 0
let applied = false
let stored: Stored | null = null
let sessionRef: { wall: number; mono: number } | null = null
let lastIssued = 0
let measuring: Promise<void> | null = null
let inited = false
const listeners = new Set<() => void>()

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) stored = JSON.parse(raw) as Stored
    lastIssued = Number(localStorage.getItem(LAST_ISSUED_KEY)) || 0
  } catch { stored = null }
  if (stored && Date.now() - stored.measuredAt < MAX_AGE_MS) {
    offsetMs = stored.offsetMs
    applied = Math.abs(offsetMs) >= APPLY_MIN_MS
  }
}
function save() {
  try { if (stored) localStorage.setItem(STORAGE_KEY, JSON.stringify(stored)) } catch { /* ignore */ }
}
function notify() { for (const l of listeners) l() }

/** The corrected clock in ms. */
export function nowMs(): number { return Date.now() + offsetMs }

/**
 * The corrected clock in seconds, for `created_at` and `published_at`. Never runs backwards on this
 * device within a 10 minute window, so the first events after a correction can't sort behind the
 * ones stamped by the old (wrong) clock.
 */
let lastStampLog = 0
export function nowSeconds(): number {
  const raw = Math.floor(Date.now() / 1000)
  const c = Math.floor(nowMs() / 1000)
  let v = c
  if (c < lastIssued && (lastIssued - c) * 1000 < HOLD_BACK_MAX_MS) v = lastIssued
  if (v !== raw && Date.now() - lastStampLog > 5_000) {
    lastStampLog = Date.now()
    console.log(`[Clock] stamping created_at ${v} (device would say ${raw}; ${v === c ? `offset ${Math.round(offsetMs / 1000)}s` : `held at last issued ${lastIssued} so the clock never runs backwards`})`)
  }
  if (v > lastIssued) {
    lastIssued = v
    try { localStorage.setItem(LAST_ISSUED_KEY, String(v)) } catch { /* ignore */ }
  }
  return v
}

export function getClockState(): { offsetMs: number; applied: boolean; measuredAt: number | null; samples: number; hosts: string[] } {
  return { offsetMs, applied, measuredAt: stored?.measuredAt ?? null, samples: stored?.samples ?? 0, hosts: stored?.hosts ?? [] }
}
export function subscribeClock(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn) } }

// ── Probing ──

type FetchLike = (url: string, init: RequestInit) => Promise<Response>
async function nativeFetch(): Promise<FetchLike | null> {
  if (!isTauri()) return null
  try {
    const mod = await import('@tauri-apps/plugin-http')
    return mod.fetch as unknown as FetchLike
  } catch { return null }
}

/**
 * Web-only: Cloudflare's diagnostic endpoint allows any origin and its body has `ts=<epoch.ms>`.
 * Better than a 1s Date header. Both hosts are one company, so they count as one host for agreement.
 */
const CLOUDFLARE_TRACE = ['https://www.cloudflare.com/cdn-cgi/trace', 'https://1.1.1.1/cdn-cgi/trace']
async function probeTrace(url: string): Promise<Sample | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    const t0 = Date.now()
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal })
    const body = await res.text()
    const t1 = Date.now()
    const rtt = t1 - t0
    const host = hostOf(url)
    if (rtt > MAX_RTT_MS) { console.log(`[Clock]   ${host} (trace): rejected, round trip ${rtt}ms too slow`); return null }
    const ts = Number(body.match(/^ts=([0-9.]+)/m)?.[1])
    if (!ts || Number.isNaN(ts)) { console.log(`[Clock]   ${host} (trace): rejected, no ts field (status ${res.status})`); return null }
    const offset = ts * 1000 - (t0 + rtt / 2)
    console.log(`[Clock]   ${host} (trace): ts ${ts} | rtt ${rtt}ms | offset ${Math.round(offset)}ms`)
    return { host: 'cloudflare-trace', offsetMs: offset, rtt }
  } catch (err) {
    console.log(`[Clock]   ${hostOf(url)} (trace): failed (${err instanceof Error ? err.name : 'error'})`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function probe(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Sample | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    const t0 = Date.now()
    const res = await fetchImpl(url, { ...init, cache: 'no-store', signal: ctrl.signal })
    const t1 = Date.now()
    const rtt = t1 - t0
    const host = new URL(url).host
    if (rtt > MAX_RTT_MS) { console.log(`[Clock]   ${host}: rejected, round trip ${rtt}ms too slow`); return null }
    const date = res.headers.get('date')
    if (!date) { console.log(`[Clock]   ${host}: rejected, no Date header visible (status ${res.status})`); return null }
    const server = Date.parse(date)
    if (Number.isNaN(server)) { console.log(`[Clock]   ${host}: rejected, unparseable Date "${date}"`); return null }
    // A cached reply is useless: some CDNs keep the original Date (stale), others regenerate it
    // (fresh) and report Age either way, so Age can't be used to correct it. Only a miss counts.
    const age = Number(res.headers.get('age')) || 0
    if (age > 0) { console.log(`[Clock]   ${host}: rejected, served from cache (Age ${age}s)`); return null }
    // Date is truncated to the second: +500ms centres the error.
    const serverMs = server + 500
    const offset = serverMs - (t0 + rtt / 2)
    console.log(`[Clock]   ${host}: server ${date} | status ${res.status} | rtt ${rtt}ms | offset ${Math.round(offset)}ms`)
    return { host, offsetMs: offset, rtt }
  } catch (err) {
    console.log(`[Clock]   ${hostOf(url)}: failed (${err instanceof Error ? err.name : 'error'})`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

function hostOf(url: string): string { try { return new URL(url).host } catch { return url } }

function relayHttpUrl(ws: string): string | null {
  try {
    const u = new URL(ws)
    u.protocol = u.protocol === 'ws:' ? 'http:' : 'https:'
    return u.toString()
  } catch { return null }
}

async function collectSamples(): Promise<Sample[]> {
  const [{ getRelays }, { blossomServers }] = await Promise.all([import('@/lib/nostr/relay-pool'), import('@/lib/blossom')])
  const native = await nativeFetch()
  const fetchImpl: FetchLike = native ?? ((u, i) => fetch(u, i))
  console.log(`[Clock] probing via ${native ? 'Tauri native HTTP (all headers visible)' : 'browser fetch (cross-origin headers hidden unless exposed)'}; device time ${new Date().toISOString()}`)

  const jobs: Promise<Sample | null>[] = []
  for (const r of getRelays().slice(0, 6)) {
    const http = relayHttpUrl(r)
    if (http) jobs.push(probe(fetchImpl, http, { method: 'GET', headers: { Accept: 'application/nostr+json' } }))
  }
  for (const b of blossomServers.getServers().slice(0, 4)) {
    jobs.push(probe(fetchImpl, b.replace(/\/+$/, '') + '/', { method: 'GET' }))
  }
  const results = (await Promise.all(jobs)).filter((s): s is Sample => !!s)

  // Web fallback: relays and Blossom servers that don't expose `Date` across origins give nothing
  // (in practice none of the defaults do). The app's own origin (never hardcoded; a fork's host
  // works the same) is same-origin, so its headers are always readable. A unique path that doesn't
  // exist is a guaranteed cache miss on any CDN (a 404 still carries a fresh Date), where a query
  // string on a real file was served from cache by GitHub Pages. Probe twice so a single-source
  // result still has to be stable.
  if (!native && results.length < 3) {
    console.log(`[Clock] only ${results.length} usable sample(s) from relays/Blossom; adding the web pool (Cloudflare trace + own origin ${typeof location !== 'undefined' ? location.origin : 'n/a'})`)
    const extra: Promise<Sample | null>[] = CLOUDFLARE_TRACE.map(probeTrace)
    const localOrigin = typeof location !== 'undefined' && /^(localhost|127\.|0\.0\.0\.0|\[::1\]|.*\.local$)/.test(location.hostname)
    if (localOrigin) console.log(`[Clock] own origin ${location.origin} is this machine (dev server); skipping it, it would only echo the device clock`)
    if (typeof location !== 'undefined' && /^https?:/.test(location.origin) && !localOrigin) {
      for (let i = 0; i < 2; i++) {
        extra.push(probe(fetchImpl, `${location.origin}/clock-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, { method: 'GET' }))
      }
    }
    for (const s of await Promise.all(extra)) if (s) results.push(s)
  }
  return results
}

function aggregate(samples: Sample[]): { offsetMs: number; kept: Sample[] } | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a.offsetMs - b.offsetMs)
  const median = sorted[Math.floor(sorted.length / 2)].offsetMs
  const kept = sorted.filter((s) => Math.abs(s.offsetMs - median) <= AGREE_MS)
  const hosts = new Set(kept.map((s) => s.host))
  const allHosts = new Set(samples.map((s) => s.host))
  // Two agreeing hosts when more than one host answered (two hosts that disagree is "unsure", not a
  // coin toss on the median); a single host that agreed with itself twice only when it was the only
  // host that answered at all (the origin-only web case).
  if (allHosts.size >= 2 ? hosts.size < 2 : kept.length < 2) return null
  const m = kept[Math.floor(kept.length / 2)].offsetMs
  return { offsetMs: m, kept }
}

/** Measure now (deduplicated). Resolves when the offset has been updated or the attempt gave up. */
export function measureClockOffset(reason: string): Promise<void> {
  if (measuring) return measuring
  measuring = (async () => {
    try {
      const samples = await collectSamples()
      const agg = aggregate(samples)
      if (!agg) {
        console.log(`[Clock] ${reason}: not enough agreeing sources (${samples.length} sample(s): ${samples.map((x) => `${x.host} ${Math.round(x.offsetMs)}ms`).join(', ') || 'none'}), leaving the clock as is`)
        return
      }
      const dropped = samples.filter((x) => !agg.kept.includes(x))
      console.log(`[Clock] ${reason}: median ${Math.round(agg.offsetMs)}ms from ${agg.kept.length} agreeing sample(s)${dropped.length ? `; dropped ${dropped.map((x) => `${x.host} (${Math.round(x.offsetMs)}ms)`).join(', ')}` : ''}`)
      const next = Math.abs(agg.offsetMs) >= APPLY_MIN_MS ? Math.round(agg.offsetMs) : 0
      stored = { offsetMs: next, measuredAt: Date.now(), samples: agg.kept.length, hosts: [...new Set(agg.kept.map((s) => s.host))] }
      save()
      sessionRef = { wall: Date.now(), mono: performance.now() }
      const changed = next !== offsetMs
      offsetMs = next
      applied = next !== 0
      console.log(`[Clock] ${reason}: device clock is ${describeOffset(agg.offsetMs)} (${agg.kept.length} sources: ${stored.hosts.join(', ')})${applied ? `, correcting outgoing timestamps by ${next > 0 ? '+' : ''}${Math.round(next / 1000)}s` : ', no correction applied (under 3s)'}`)
      console.log(`[Clock] now: device ${new Date().toISOString()} | corrected ${new Date(nowMs()).toISOString()} | next created_at would be ${Math.floor(nowMs() / 1000)}`)
      if (changed) notify()
    } finally {
      measuring = null
    }
  })()
  return measuring
}

export function describeOffset(ms: number): string {
  const abs = Math.abs(ms)
  const dir = ms > 0 ? 'slow' : 'fast' // positive offset = server ahead of us = we are slow
  if (abs < 1000) return 'accurate'
  if (abs < 90_000) return `about ${Math.round(abs / 1000)}s ${dir}`
  if (abs < 90 * 60_000) return `about ${Math.round(abs / 60_000)} min ${dir}`
  return `about ${(abs / 3600_000).toFixed(1)} h ${dir}`
}

/** Has the wall clock moved differently from the monotonic clock since the last measurement? */
function clockJumped(): boolean {
  if (!sessionRef) return false
  const wallDelta = Date.now() - sessionRef.wall
  const monoDelta = performance.now() - sessionRef.mono
  return Math.abs(wallDelta - monoDelta) > JUMP_MS
}

/** Start the clock sync: load the stored offset, probe when needed, watch for clock jumps. Idempotent. */
export function initClockSync(): void {
  if (inited || typeof window === 'undefined') return
  inited = true
  load()
  sessionRef = { wall: Date.now(), mono: performance.now() }
  const stale = !stored || Date.now() - stored.measuredAt > MAX_AGE_MS
  console.log(`[Clock] init: ${stored ? `stored offset ${stored.offsetMs}ms measured ${new Date(stored.measuredAt).toISOString()} from ${stored.hosts.join(', ')}${stale ? ' (stale)' : ''}` : 'no stored measurement'}; applied=${applied}; lastIssued=${lastIssued || 'none'}`)
  // Debug handle in the console: denClock.state(), denClock.measure(), denClock.now()
  ;(window as unknown as { denClock?: unknown }).denClock = {
    state: getClockState,
    measure: () => measureClockOffset('manual'),
    now: () => ({ device: new Date().toISOString(), corrected: new Date(nowMs()).toISOString(), createdAt: Math.floor(nowMs() / 1000) }),
  }
  // Give startup its bandwidth first; the stored offset (if any) already applies. Confirm it soon
  // regardless: a clock changed while the app was closed can't be seen by the jump tripwire (the
  // monotonic clock restarts with the process), and the probes go to servers we connect to anyway.
  setTimeout(() => { if (navigator.onLine) void measureClockOffset(stale ? 'initial measurement' : 'launch confirmation') }, 8_000)
  const check = () => {
    if (!navigator.onLine) return
    if (clockJumped()) { sessionRef = { wall: Date.now(), mono: performance.now() }; void measureClockOffset('clock jump detected') }
    else if (stored && Date.now() - stored.measuredAt > MAX_AGE_MS) void measureClockOffset('measurement expired')
  }
  setInterval(check, CHECK_EVERY_MS)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check() })
}
