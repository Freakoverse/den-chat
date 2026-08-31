/**
 * Epoch-rollback guard (v2 hubs).
 *
 * A private hub's epoch only ever INCREASES — every rotation (kick/ban/fix-encryption) bumps it. A
 * malicious or eclipsing relay could still serve an OLD but validly-signed hub event (lower epoch).
 * On LIVE updates this is already out-ranked by `created_at` ordering (an old event has a lower
 * created_at), but at INITIAL LOAD there is no newer event to compare against, so a full eclipse could
 * downgrade the client to a rotated-out secret — and it would then encrypt new messages under a key a
 * just-kicked member still holds.
 *
 * Defence: persist the highest epoch ever seen per hub (across sessions) and REFUSE to apply any hub
 * event whose epoch is strictly lower. The high-water mark is only ever advanced from events we actually
 * accept (which decrypted with the current secret, i.e. authored by the real owner `O`), so a forged
 * high epoch would require the owner's key. Epoch is public metadata, so a single global map is fine.
 */

import { useUserStore } from '@/stores/userStore'

const KEY = 'den_hub_max_epoch'

// Account-scope the key so this device's private-hub dTag set can't bleed across accounts / leak a foreign
// account's memberships at rest. Persists per-account across restarts (the anti-rollback mark must survive);
// legacy global key dropped on first access.
// null when no account is logged in — load()/save() then no-op rather than touching the bare legacy KEY
// (which would fail open for an in-flight event during logout/switch and could wipe an account's mark).
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

/** Highest epoch previously accepted for this hub (0 if never seen). */
export function getMaxEpochSeen(dTag: string): number {
  return load()[dTag] || 0
}

/** Record an accepted epoch as the new monotonic high-water mark. */
export function recordEpochSeen(dTag: string, epoch: number): void {
  if (!Number.isFinite(epoch) || epoch <= 0) return
  const m = load()
  if (epoch > (m[dTag] || 0)) { m[dTag] = epoch; save(m) }
}

/**
 * True if applying a hub event at `epoch` would be a ROLLBACK below the recorded high-water mark —
 * i.e. an attacker serving a stale event. Callers should skip such events (do NOT bootstrap their
 * secret/content). Equal-or-higher epochs are fine.
 */
export function isEpochRollback(dTag: string, epoch: number): boolean {
  return epoch < getMaxEpochSeen(dTag)
}
