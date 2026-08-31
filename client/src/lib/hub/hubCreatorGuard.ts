/**
 * Hub creator binding (anti-poisoning / anti-injection).
 *
 * Hub events (kind 36942) are addressable/replaceable, keyed by (kind, pubkey, dTag). The client's
 * hub-event queries filter by `#d` only — never `authors` — because on a cold start it does not yet know
 * which pubkey authored a given hub. That means a relay can hand back a kind-36942 with a victim's dTag
 * signed by ANY pubkey, and it coexists with the real owner's event. Without an owner binding, such a
 * forged event could: advance the persisted epoch/version high-water marks (a permanent, cross-session
 * lockout — every later legit event then looks like a rollback/downgrade), inject fake channels/bans, or
 * spuriously mark the hub deleted.
 *
 * Binding: once a hub's secret has SUCCESSFULLY decrypted with a given creator pubkey as `O` (proof that
 * pubkey is the real owner — nobody else's key decrypts the hub secret), we persist dTag→creator. From
 * then on, every hub event whose author differs from the recorded creator is rejected before it can touch
 * the store or the guards. The record is only ever written from a decrypt-verified event, so a forged
 * event can never establish or change the binding. (For v1 hubs — plaintext, no R to hide — the binding is
 * still recorded on first load and prevents cross-owner dTag confusion; there's no secret so we record on
 * first accepted load.)
 */

import { useUserStore } from '@/stores/userStore'

const KEY = 'den_hub_creator'

// Account-scope the key so this device's private-hub dTag→owner map can't bleed across accounts / leak a
// foreign account's memberships at rest. Persists per-account across restarts (the binding must survive);
// legacy global key dropped on first access.
// null when no account is logged in — load()/save() then no-op rather than touching the bare legacy KEY
// (which would fail open for an in-flight event during logout/switch and could wipe an account's binding).
function nsKey(): string | null {
  let pk: string | null | undefined
  try { pk = useUserStore.getState().pubkey } catch { /* ignore */ }
  return pk ? `${KEY}:${pk}` : null
}
function load(): Record<string, string> {
  const k = nsKey()
  if (!k) return {} // no account → don't read or delete anything
  try {
    try { localStorage.removeItem(KEY) } catch { /* ignore */ } // drop legacy global key (only with an account)
    const raw = localStorage.getItem(k)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function save(m: Record<string, string>): void {
  const k = nsKey()
  if (!k) return // no account → don't write (never fall back to the bare key)
  try { localStorage.setItem(k, JSON.stringify(m)) } catch { /* storage unavailable — non-fatal */ }
}

/** The verified owner pubkey for this hub, or undefined if we've never confirmed one. */
export function getTrustedCreator(dTag: string): string | undefined {
  return load()[dTag]
}

/**
 * Record the verified owner. Call ONLY after proof the pubkey is the real owner (its hub secret decrypted).
 * First write wins and is sticky; a differing pubkey is IGNORED (a hub's owner never changes, and honoring a
 * change would let a forged event steal the binding).
 */
export function recordTrustedCreator(dTag: string, creatorPubkey: string): void {
  if (!creatorPubkey) return
  const m = load()
  if (!m[dTag]) { m[dTag] = creatorPubkey; save(m) }
}

/**
 * True if this event must be REJECTED because we have a verified owner for the hub and this event is from a
 * different author (a forged/impostor hub event). Unknown-creator (never verified) returns false — the first
 * legit load establishes the binding via recordTrustedCreator on decrypt success.
 */
export function isForgedHubEvent(dTag: string, eventPubkey: string): boolean {
  const trusted = getTrustedCreator(dTag)
  return !!trusted && trusted !== eventPubkey
}
