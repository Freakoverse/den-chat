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
export function nowSeconds(): number {
  const c = Math.floor(nowMs() / 1000)
  let v = c
  if (c < lastIssued && (lastIssued - c) * 1000 < HOLD_BACK_MAX_MS) v = lastIssued
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
    if (rtt > MAX_RTT_MS) return null
    const ts = Number(body.match(/^ts=([0-9.]+)/m)?.[1])
    if (!ts || Number.isNaN(ts)) return null
    return { host: 'cloudflare-trace', offsetMs: ts * 1000 - (t0 + rtt / 2), rtt }
  } catch {
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
    if (rtt > MAX_RTT_MS) return null
    const date = res.headers.get('date')
    if (!date) return null
    const server = Date.parse(date)
    if (Number.isNaN(server)) return null
    // A cached reply is useless: some CDNs keep the original Date (stale), others regenerate it
    // (fresh) and report Age either way, so Age can't be used to correct it. Only a miss counts.
    if ((Number(res.headers.get('age')) || 0) > 0) return null
    // Date is truncated to the second: +500ms centres the error.
    const serverMs = server + 500
    return { host: new URL(url).host, offsetMs: serverMs - (t0 + rtt / 2), rtt }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

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
    const extra: Promise<Sample | null>[] = CLOUDFLARE_TRACE.map(probeTrace)
    if (typeof location !== 'undefined' && /^https?:/.test(location.origin)) {
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
  // Two agreeing hosts, or one host that agreed with itself twice (the origin fallback).
  if (!(hosts.size >= 2 || kept.length >= 2)) return null
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
        console.log(`[Clock] ${reason}: not enough agreeing sources (${samples.length} samples), leaving the clock as is`)
        return
      }
      const next = Math.abs(agg.offsetMs) >= APPLY_MIN_MS ? Math.round(agg.offsetMs) : 0
      stored = { offsetMs: next, measuredAt: Date.now(), samples: agg.kept.length, hosts: [...new Set(agg.kept.map((s) => s.host))] }
      save()
      sessionRef = { wall: Date.now(), mono: performance.now() }
      const changed = next !== offsetMs
      offsetMs = next
      applied = next !== 0
      console.log(`[Clock] ${reason}: device clock is ${describeOffset(agg.offsetMs)} (${agg.kept.length} sources: ${stored.hosts.join(', ')})${applied ? ', correcting outgoing timestamps' : ''}`)
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
  // Give startup its bandwidth first; the stored offset (if any) already applies.
  setTimeout(() => { if (navigator.onLine) void measureClockOffset(stale ? 'initial measurement' : 'weekly refresh check') }, stale ? 8_000 : 60_000)
  const check = () => {
    if (!navigator.onLine) return
    if (clockJumped()) { sessionRef = { wall: Date.now(), mono: performance.now() }; void measureClockOffset('clock jump detected') }
    else if (stored && Date.now() - stored.measuredAt > MAX_AGE_MS) void measureClockOffset('measurement expired')
  }
  setInterval(check, CHECK_EVERY_MS)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check() })
}
