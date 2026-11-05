/**
 * NIP-LRS — Local Relay Signer (replaces the old NIP-PC55 custom protocol)
 *
 * A desktop signer (e.g. DENOS) exposes its NIP-46 interface over a minimal NIP-01 relay bound to
 * localhost. This is **vanilla NIP-46 over a loopback relay**: after discovery we hand a
 * `bunker://<transport_pubkey>?relay=ws://127.0.0.1:<port>` URL to the existing BunkerSigner, so all
 * signing / NIP-04 / NIP-44 / NIP-SKD paths are unchanged (see bunker.ts). This module only adds the
 * two things "run a relay on localhost" does not settle on its own:
 *
 *  1. Discovery — scan a small port range for a signer, told apart from an ordinary relay by the
 *     `local_relay_signer` marker in its NIP-11 info document (§5).
 *  2. Identity — pin the signer's random `transport_pubkey` (TOFU) and persist ONE client key per
 *     transport key, so re-logins reuse the same signer-side connection + policy (no duplicates, no
 *     re-approval) and we never reconnect to a different signer that grabbed the old port (§7).
 *
 * Field-tested gotchas baked in here:
 *  - A signer can RST ~40% of browser connections to its HTTP endpoint, so each probe is retried and
 *    the whole range is re-scanned a few times before concluding "no signer".
 *  - A browser `fetch` can't distinguish "port closed" from "connection reset" (both throw
 *    `TypeError`); only our own `AbortError` (timeout) is distinguishable. So: short per-probe timeout,
 *    treat a fast failure as "retry", a timeout as "give up on this port for now".
 *  - The name is self-declared and WILL collide; identity is the pinned transport key. UIs must show a
 *    key fingerprint, never the name alone.
 */

import { BunkerSigner } from './bunker'

/** Default port and the ten-port failover range clients scan (§4). */
const LRS_PORT_START = 7777
const LRS_PORT_END = 7786
/** Short per-probe timeout — dead loopback ports may hang until this on some stacks (§9 notes). */
const PROBE_TIMEOUT_MS = 1200
/** Fast-failure retries within a single port probe (the ~40% RST issue). */
const PROBE_ATTEMPTS = 3
/** How many times to re-scan the whole range before concluding "no signer". */
const SCAN_ROUNDS = 3

const CLIENT_SECRET_PREFIX = 'lrs_client_secret:' // + transportPubkey (hex) — one client key per signer
const LRS_STATE_KEY = 'lrs_last' // { transportPubkey, accountPubkey, lastPort } for reconnection (§7)

/** A discovered local signer. `transportPubkey` is the identity (pinned); `port` is only a cache. */
export interface LrsSignerInfo {
  /** Self-declared, UNTRUSTED display label (§5.1). Never identity. */
  name: string
  /** The signer's random transport key — the NIP-46 remote-signer pubkey we connect to and pin. */
  transportPubkey: string
  port: number
  /** `ws://127.0.0.1:<port>` */
  relayUrl: string
}

/** Persisted reconnection state for the last LRS login. */
export interface LrsState {
  transportPubkey: string
  accountPubkey: string
  lastPort: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A short, human-comparable fingerprint of a transport key, for disambiguating signers in the UI. */
export function fingerprint(transportPubkey: string): string {
  const k = transportPubkey.toLowerCase()
  return `${k.slice(0, 8)}…${k.slice(-4)}`
}

function buildBunkerUrl(transportPubkey: string, port: number): string {
  return `bunker://${transportPubkey}?relay=${encodeURIComponent(`ws://127.0.0.1:${port}`)}`
}

/** App metadata sent on the first connect so the signer labels us by name, not origin/key (§6.1). */
function buildMetadata(): Record<string, unknown> {
  let url = ''
  try { url = typeof location !== 'undefined' ? location.origin : '' } catch { /* no window */ }
  return { name: 'DEN Chat', ...(url ? { url } : {}) }
}

/* ─── Discovery ─── */

/**
 * Probe one port once. Returns the signer info, or `null` if the port is reachable but is not an LRS
 * signer (no marker). THROWS on a network failure so the caller can tell a timeout (AbortError →
 * give up) from a fast failure (possible RST → retry).
 */
async function probeOnce(port: number): Promise<LrsSignerInfo | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'GET',
      headers: { Accept: 'application/nostr+json' },
      signal: controller.signal,
      cache: 'no-store',
      // Default CORS mode: the signer answers the PNA/CORS preflight (§3); we need to read the body.
    })
    if (!res.ok) return null
    let doc: unknown
    try { doc = await res.json() } catch { return null }
    const d = doc as { name?: unknown; local_relay_signer?: { transport_pubkey?: unknown } } | null
    const tpk = d?.local_relay_signer?.transport_pubkey
    // The presence of the marker with a valid x-only pubkey IS the capability test (§5.1).
    if (typeof tpk !== 'string' || !/^[0-9a-f]{64}$/i.test(tpk)) return null
    const name = typeof d?.name === 'string' && d.name.trim() ? d.name.trim() : 'Local signer'
    return { name, transportPubkey: tpk.toLowerCase(), port, relayUrl: `ws://127.0.0.1:${port}` }
  } finally {
    clearTimeout(timer)
  }
}

/** Probe a port with retry: a fast failure is retried (possible RST), a timeout gives up for now. */
async function probePort(port: number): Promise<LrsSignerInfo | null> {
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
    try {
      return await probeOnce(port) // reachable: signer info, or null (not a signer) — don't retry
    } catch (err) {
      // AbortError = our timeout → the port is slow/hanging; stop retrying it this round.
      if ((err as { name?: string })?.name === 'AbortError') return null
      // Otherwise a fast failure: could be a genuine RST on a live signer → retry with a short backoff.
      if (attempt < PROBE_ATTEMPTS - 1) await sleep(120)
    }
  }
  return null
}

/** Scan the whole range once, in parallel. Returns signers deduped by transport key (lowest port). */
async function scanOnce(): Promise<LrsSignerInfo[]> {
  const ports: number[] = []
  for (let p = LRS_PORT_START; p <= LRS_PORT_END; p++) ports.push(p)
  const results = await Promise.all(ports.map((p) => probePort(p)))
  const byKey = new Map<string, LrsSignerInfo>()
  for (const r of results) {
    if (!r) continue
    const existing = byKey.get(r.transportPubkey)
    if (!existing || r.port < existing.port) byKey.set(r.transportPubkey, r)
  }
  return [...byKey.values()].sort((a, b) => a.port - b.port)
}

/**
 * Discover local signers with zero configuration (§5.2).
 *
 * Fast path: if `remembered` is given, try its last-known port first and return immediately when the
 * marker there still matches the remembered transport key.
 *
 * Otherwise scan the range a few times (resilience against the RST flakiness) and return every signer
 * found. Callers pick: one → use it; many → show a chooser (name + fingerprint); none → "no signer".
 */
export async function discoverLocalSigners(remembered?: LrsState | null): Promise<LrsSignerInfo[]> {
  if (remembered) {
    const hit = await probePort(remembered.lastPort)
    if (hit && hit.transportPubkey === remembered.transportPubkey) return [hit]
  }
  for (let round = 0; round < SCAN_ROUNDS; round++) {
    const found = await scanOnce()
    if (found.length > 0) return found
    if (round < SCAN_ROUNDS - 1) await sleep(200)
  }
  return []
}

/** Find the specific remembered signer (for silent resume): fast-path its port, else re-scan, and
 *  return it ONLY if a listening port presents the PINNED transport key — never a stranger (§7.3). */
export async function findRememberedSigner(state: LrsState): Promise<LrsSignerInfo | null> {
  const signers = await discoverLocalSigners(state)
  return signers.find((s) => s.transportPubkey === state.transportPubkey) ?? null
}

/* ─── Reconnection state ─── */

export function loadLrsState(): LrsState | null {
  try {
    const raw = localStorage.getItem(LRS_STATE_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as LrsState
    if (s && /^[0-9a-f]{64}$/i.test(s.transportPubkey) && typeof s.lastPort === 'number') return s
  } catch { /* storage blocked / corrupt */ }
  return null
}

function saveLrsState(state: LrsState): void {
  try { localStorage.setItem(LRS_STATE_KEY, JSON.stringify(state)) } catch { /* storage blocked */ }
}

export function clearLrsState(): void {
  try { localStorage.removeItem(LRS_STATE_KEY) } catch { /* storage blocked */ }
}

/** One persisted client key per signer, keyed by its transport key. Returns the hex secret and
 *  whether it was freshly generated (→ this is a first connect, so send app metadata). */
function loadOrCreateClientSecret(transportPubkey: string): { secret: string; isNew: boolean } {
  const key = CLIENT_SECRET_PREFIX + transportPubkey.toLowerCase()
  try {
    const stored = localStorage.getItem(key)
    if (stored && /^[0-9a-f]{64}$/i.test(stored)) return { secret: stored, isNew: false }
  } catch { /* storage blocked */ }
  // Let BunkerSigner mint one, then persist it so future logins reuse the same client identity.
  const fresh = new BunkerSigner().getClientSecretKey()
  try { localStorage.setItem(key, fresh) } catch { /* storage blocked */ }
  return { secret: fresh, isNew: true }
}

/* ─── Signer ─── */

/**
 * LrsSigner — a local (loopback) NIP-46 signer. Thin wrapper over BunkerSigner that owns the
 * LRS-specific concerns: building the loopback bunker URL, persisting a per-signer client key, sending
 * app metadata on first connect, pinning the transport key, and remembering reconnection state. Every
 * ISigner + NIP-SKD method delegates to the inner BunkerSigner unchanged.
 */
export class LrsSigner {
  readonly name: string
  readonly transportPubkey: string
  readonly port: number
  private bunker: BunkerSigner
  private isFirstConnect: boolean

  constructor(info: LrsSignerInfo) {
    this.name = info.name
    this.transportPubkey = info.transportPubkey
    this.port = info.port
    const { secret, isNew } = loadOrCreateClientSecret(info.transportPubkey)
    this.isFirstConnect = isNew
    this.bunker = new BunkerSigner(secret)
  }

  /** Connect over the loopback relay. On first contact the signer blocks on in-app approval (no auth
   *  URL, no client-side timeout — see bunker.ts / nostr-tools). Returns the account pubkey. */
  async connect(): Promise<string> {
    const url = buildBunkerUrl(this.transportPubkey, this.port)
    // Metadata only on first connect; a known client key resumes silently with its stored name (§6.1).
    const pubkey = await this.bunker.login(url, true, this.isFirstConnect ? buildMetadata() : undefined)
    saveLrsState({ transportPubkey: this.transportPubkey, accountPubkey: pubkey, lastPort: this.port })
    return pubkey
  }

  getPublicKey(): Promise<string> { return this.bunker.getPublicKey() }
  signEvent(draftEvent: Record<string, unknown>): Promise<Record<string, unknown>> { return this.bunker.signEvent(draftEvent) }
  get nip04() { return this.bunker.nip04 }
  get nip44() { return this.bunker.nip44 }
  /** NIP-SKD surface — present only when the signer advertised support (probed by BunkerSigner). */
  get skd() { return this.bunker.skd }
  reconnect(): Promise<void> { return this.bunker.reconnect() }
  close(): void { this.bunker.close() }
}
