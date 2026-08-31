/**
 * Version-downgrade guard (v2 hubs).
 *
 * A hub's format version only ever INCREASES (v1 → v2; higher later). The `version` tag lives on the
 * owner-signed hub event and is otherwise the SOLE selector between the v2 (pseudonymous) and v1
 * (plaintext real-key R) code paths — `isV2(hub)` reduces to `hub.version === 2`. A pure MITM relay can't
 * forge the tag (it would break the owner's signature), but a malicious or coerced owner (or a compromised
 * owner key) could publish a validly-signed hub event with `version` dropped to 1 and a higher created_at.
 * Every member's client would then silently take the v1 path and begin authoring hub events under their
 * REAL key R — deanonymizing the entire membership to third-party relays, the exact property v2 exists to
 * protect. `version.ts` designed a `VersionSignals` fail-safe for this but nothing ever supplied the
 * signals, so it was inert.
 *
 * Defence (mirrors epochGuard): persist the highest version ever accepted per hub and REFUSE to apply any
 * hub event whose version is strictly lower. The mark is only advanced from events we actually accept
 * (owner-signed, decryptable at that version), so a legit current event always passes; a downgrade is
 * skipped, keeping the last good v2 state. Version is public metadata, so a single global map is fine.
 */

import { useUserStore } from '@/stores/userStore'

const KEY = 'den_hub_version_seen'

// Account-scope the storage key so this device's private-hub dTag set doesn't bleed across accounts (or
// leak a foreign account's memberships at rest). Persists per-account across restarts (NOT cleared on
// logout) so the anti-downgrade high-water mark survives — its whole purpose. The legacy un-namespaced key
// is deleted on first access (it was a global membership-at-rest leak).
// The account-scoped key, or null when there's no logged-in account. When null we must NOT touch the bare
// legacy `KEY` at all — deleting/reading/writing it (a) fails open for an in-flight event during a
// logout/switch and (b) would wipe an account's real mark. So load()/save() no-op without an account.
function nsKey(): string | null {
  let pk: string | null | undefined
  try { pk = useUserStore.getState().pubkey } catch { /* ignore */ }
  return pk ? `${KEY}:${pk}` : null
}
function load(): Record<string, number> {
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

function save(m: Record<string, number>): void {
  const k = nsKey()
  if (!k) return // no account → don't write (never fall back to the bare key)
  try { localStorage.setItem(k, JSON.stringify(m)) } catch { /* storage unavailable — non-fatal */ }
}

/** Highest version previously accepted for this hub (0 if never seen). */
export function getMaxVersionSeen(dTag: string): number {
  return load()[dTag] || 0
}

/** Highest hub format version this client understands. */
const MAX_SUPPORTED_VERSION = 2

/**
 * Record an accepted version as the new monotonic high-water mark. Clamped to the max SUPPORTED version so
 * an event carrying an absurd `version` (e.g. 99 — a bug, or a malicious owner-signed event) can't raise
 * the mark above what any legit event will ever carry, which would permanently reject every real v2 event
 * as a "downgrade." An unsupported-but-higher version is handled by isSupportedVersion ("update client"),
 * not by this mark.
 */
export function recordVersionSeen(dTag: string, version: number | undefined): void {
  let v = version && version >= 1 ? version : 1
  if (v > MAX_SUPPORTED_VERSION) v = MAX_SUPPORTED_VERSION
  const m = load()
  if (v > (m[dTag] || 0)) { m[dTag] = v; save(m) }
}

/**
 * True if applying a hub event at `version` would be a DOWNGRADE below the recorded high-water mark —
 * e.g. a tampered/malicious event stripping the v2 `version` tag to force the plaintext-R v1 path.
 * Callers must SKIP such events (do not apply their fields or re-key/re-author under them).
 */
export function isVersionDowngrade(dTag: string, version: number | undefined): boolean {
  const v = version && version >= 1 ? version : 1
  return v < getMaxVersionSeen(dTag)
}
