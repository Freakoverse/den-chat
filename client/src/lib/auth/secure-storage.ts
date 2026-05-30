/**
 * Secure Storage — OS-level secure storage abstraction
 *
 * Desktop (Tauri): All secrets stored in OS keyring via Rust backend.
 *   - Windows → DPAPI (Windows Credential Manager)
 *   - macOS   → Keychain
 *   - Linux   → Secret Service (GNOME Keyring / KDE Wallet)
 *
 * Web/PWA: No secrets stored — auth via external signers only.
 *   All functions are no-ops on web.
 */

import { isTauri } from '@/lib/utils'

// ─── Types ──────────────────────────────────────────────────────────────

export interface StoredAccount {
  pubkey: string
  npub: string
  name: string | null
  auth_method: 'seed' | 'nsec'
  seed_id: string | null
  account_index: number | null
  created_at: number
  has_pin: boolean
  pin_hint: string | null
}

export interface StoredSeed {
  id: string
  name: string
  account_pubkeys: string[]
}

// ─── Tauri invoke helper ────────────────────────────────────────────────

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error('Secure storage is only available in the desktop app.')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

// ─── Account Operations (desktop only) ──────────────────────────────────

/**
 * List all stored accounts (no secrets).
 */
export async function listAccounts(): Promise<StoredAccount[]> {
  if (!isTauri()) return []
  try {
    return await tauriInvoke<StoredAccount[]>('list_accounts')
  } catch (err) {
    console.error('listAccounts failed:', err)
    return []
  }
}

/**
 * List all stored seeds (no secrets — just metadata).
 */
export async function listSeeds(): Promise<StoredSeed[]> {
  if (!isTauri()) return []
  try {
    return await tauriInvoke<StoredSeed[]>('list_seeds')
  } catch (err) {
    console.error('listSeeds failed:', err)
    return []
  }
}

/**
 * Generate a new seed phrase + first keypair.
 * Returns the mnemonic (only shown once for backup).
 */
export async function generateAccount(
  pin: string,
  name?: string,
  pinHint?: string,
): Promise<{ pubkey: string; npub: string; mnemonic: string; seed_id: string }> {
  return tauriInvoke('generate_account', {
    pin,
    name: name ?? null,
    pinHint: pinHint ?? null,
  })
}

/**
 * Generate a completely new seed (when user already has seeds but wants another).
 */
export async function generateNewSeed(
  pin: string,
  name?: string,
  pinHint?: string,
): Promise<{ pubkey: string; npub: string; mnemonic: string; seed_id: string }> {
  return tauriInvoke('generate_new_seed', {
    pin,
    name: name ?? null,
    pinHint: pinHint ?? null,
  })
}

/**
 * Derive the next sibling account from an existing seed.
 */
export async function deriveNextAccount(
  seedId: string,
  pin: string,
  pinHint?: string,
): Promise<{ pubkey: string; npub: string; account_index: number }> {
  return tauriInvoke('derive_next_account', {
    seedId,
    pin,
    pinHint: pinHint ?? null,
  })
}

/**
 * Import an existing seed phrase.
 */
export async function importSeed(
  mnemonic: string,
  pin: string,
  name?: string,
  pinHint?: string,
): Promise<{ pubkey: string; npub: string; seed_id: string }> {
  return tauriInvoke('import_seed', {
    mnemonic,
    pin,
    name: name ?? null,
    pinHint: pinHint ?? null,
  })
}

/**
 * Import an nsec or raw hex private key.
 */
export async function importNsec(
  nsecOrHex: string,
  pin: string,
  name?: string,
  pinHint?: string,
): Promise<{ pubkey: string; npub: string }> {
  return tauriInvoke('import_nsec', {
    nsecOrHex,
    pin,
    name: name ?? null,
    pinHint: pinHint ?? null,
  })
}

/**
 * Verify a PIN against a stored account.
 */
export async function verifyPin(pubkey: string, pin: string): Promise<boolean> {
  return tauriInvoke('verify_pin', { pubkey, pin })
}

/**
 * Login — returns the private key hex after PIN verification.
 * This is the ONLY path that releases the private key to JS.
 */
export async function loginAccount(
  pubkey: string,
  pin: string,
): Promise<string> {
  const result = await tauriInvoke<{ private_key_hex: string }>('login_account', { pubkey, pin })
  return result.private_key_hex
}

/**
 * Delete an account (PIN-gated).
 */
export async function deleteAccount(pubkey: string, pin: string): Promise<void> {
  return tauriInvoke('delete_account', { pubkey, pin })
}

/**
 * Export seed phrase (PIN-gated). Returns the mnemonic.
 */
export async function exportSeed(pubkey: string, pin: string): Promise<string> {
  return tauriInvoke('export_seed', { pubkey, pin })
}

/**
 * Export private key as nsec (PIN-gated).
 */
export async function exportNsec(pubkey: string, pin: string): Promise<string> {
  return tauriInvoke('export_nsec', { pubkey, pin })
}

/**
 * Rename an account.
 */
export async function renameAccount(pubkey: string, name: string): Promise<void> {
  return tauriInvoke('rename_account', { pubkey, name })
}

/**
 * Rename a seed's label.
 */
export async function renameSeed(seedId: string, name: string): Promise<void> {
  return tauriInvoke('rename_seed', { seedId, name })
}

/**
 * Change PIN for an account.
 */
export async function changePin(
  pubkey: string,
  currentPin: string,
  newPin: string,
  newHint?: string,
): Promise<void> {
  return tauriInvoke('change_pin', {
    pubkey,
    currentPin,
    newPin,
    newHint: newHint ?? null,
  })
}

/**
 * Get the last-active account pubkey.
 */
export async function getActiveAccount(): Promise<string | null> {
  if (!isTauri()) return null
  try {
    return await tauriInvoke<string | null>('get_active_account')
  } catch {
    return null
  }
}

// ─── Legacy functions (no-ops, kept for backward compat) ────────────────

/**
 * @deprecated Use the new account management functions instead.
 */
export async function secureStore(_key: string, _value: string): Promise<void> {
  // No-op — legacy plugin-store removed
}

/**
 * @deprecated Use the new account management functions instead.
 */
export async function secureRetrieve(_key: string): Promise<string | null> {
  return null
}

/**
 * @deprecated Use the new account management functions instead.
 */
export async function secureDelete(_key: string): Promise<void> {
  // No-op — legacy plugin-store removed
}
