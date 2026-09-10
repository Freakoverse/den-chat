/**
 * Auto-login ("stay signed in") — remembers the LAST login method + account and resumes it on the
 * next app start. Written on every successful login; cleared on explicit logout (so a logged-out app
 * never auto-resumes). The resume itself lives in LoginScreen's boot effect.
 *
 * SECURITY: this NEVER stores the user's Nostr private key. It stores a public pubkey and the login
 * method; the resumable *connection* secrets (bunker client secret, etc.) live under their own keys and
 * are the same class of secret the bunker flow already persisted. The PIN-protected local methods
 * (vault, desktop keyring) resume only to their PIN prompt — the key stays gated.
 */

import { StorageKey } from '@/lib/constants'

/** The true login method (note: userStore.authMethod collapses bunker/nostrconnect/extension → 'nip46',
 *  so the real sub-method is recorded here instead). */
export type RememberedMethod =
  | 'bunker'        // NIP-46 bunker:// — silent reconnect from the stored bunker url + client secret
  | 'nostrconnect'  // NIP-46 nostrconnect:// — becomes a bunker connection; resumes via the bunker keys
  | 'pc55'          // DENOS "Local" (ws://localhost:7777) — silent if DENOS is running
  | 'nip07'         // browser extension — silent if the extension is present + still authorized
  | 'upv2'          // password login — CANNOT silently resume (needs the password); pre-fills identifier
  | 'vault'         // PWA iframe vault — re-locks on reload; resumes to its PIN overlay
  | 'seed'          // desktop OS-keyring seed account — PIN-gated; resumes to the PIN screen
  | 'nsec'          // desktop OS-keyring nsec account — PIN-gated; resumes to the PIN screen

export interface RememberedLogin {
  method: RememberedMethod
  /** The account's public key (hex). Never a private key. */
  pubkey: string
  /** upv2 only: the DNN ID / npub to pre-fill on resume (NEVER the password). */
  identifier?: string
}

/** Persist the last login so the next startup can resume it. Call after a successful login. */
export function rememberLogin(desc: RememberedLogin): void {
  try {
    localStorage.setItem(StorageKey.LAST_LOGIN, JSON.stringify(desc))
  } catch { /* storage blocked (private window / cleared) — auto-login is best-effort */ }
}

/** Read the remembered login, or null if none / corrupt. */
export function getRememberedLogin(): RememberedLogin | null {
  try {
    const raw = localStorage.getItem(StorageKey.LAST_LOGIN)
    if (!raw) return null
    const d = JSON.parse(raw) as RememberedLogin
    if (d && typeof d.method === 'string' && typeof d.pubkey === 'string') return d
  } catch { /* corrupt/blocked */ }
  return null
}

/** Clear the remembered login AND the resumable connection secrets. Call on explicit logout so a
 *  logged-out app stays on the login screen and can't silently reconnect. */
export function clearRememberedLogin(): void {
  try {
    localStorage.removeItem(StorageKey.LAST_LOGIN)
    localStorage.removeItem(StorageKey.BUNKER_URL)
    localStorage.removeItem(StorageKey.BUNKER_CLIENT_SECRET)
  } catch { /* storage blocked */ }
}
