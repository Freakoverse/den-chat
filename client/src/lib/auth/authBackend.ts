/**
 * AuthBackend — the storage/signing backend the unified login UI (LoginScreen) talks to.
 *
 * One UI, two implementations:
 *   - rustBackend  (desktop):    keys live in the OS keyring via Tauri (delegates to secure-storage).
 *   - vaultBackend (PWA/mobile): keys live in the isolated vault origin (maps vault data into the
 *                                same StoredAccount/StoredSeed shapes the desktop UI already uses).
 *
 * The interface mirrors the secure-storage functions LoginScreen already calls, so the UI barely
 * changes — it just reads `const backend = isTauri() ? rustBackend : vaultBackend`.
 *
 * The one real difference is login completion: the desktop releases the private key
 * (`login(pubkey, method, privKey)`), the vault never does (it signs via `vaultSigner`). So
 * `loginAccount` returns a LoginResult describing how to finish — apply it with `applyLogin`.
 */
import { nip19 } from 'nostr-tools'
import { useUserStore, type AuthMethod, type ISigner } from '@/stores/userStore'
import { encryptBackup, decryptBackup } from '@/lib/auth/backupCrypto'
import { getVaultClient, vaultSigner } from '@/lib/auth/vaultClient'
import {
  listAccounts as rsListAccounts, listSeeds as rsListSeeds, getActiveAccount as rsGetActive,
  generateAccount as rsGenerateAccount, generateNewSeed as rsGenerateNewSeed, deriveNextAccount as rsDerive,
  importSeed as rsImportSeed, importNsec as rsImportNsec, verifyPin as rsVerifyPin,
  loginAccount as rsLoginAccount, deleteAccount as rsDeleteAccount,
  exportSeed as rsExportSeed, exportNsec as rsExportNsec,
  renameSeed as rsRenameSeed, renameAccount as rsRenameAccount, changePin as rsChangePin,
  type StoredAccount, type StoredSeed,
} from '@/lib/auth/secure-storage'

export type { StoredAccount, StoredSeed }

export interface GenResult { pubkey: string; npub: string; mnemonic: string; seed_id: string }
export interface LoginResult { authMethod: AuthMethod; privKey: string | null; signer: ISigner | null }

export interface AuthBackend {
  listAccounts(): Promise<StoredAccount[]>
  listSeeds(): Promise<StoredSeed[]>
  getActiveAccount(): Promise<string | null>
  generateAccount(pin: string, name?: string, pinHint?: string): Promise<GenResult>
  generateNewSeed(pin: string, name?: string, pinHint?: string): Promise<GenResult>
  deriveNextAccount(seedId: string, pin: string, pinHint?: string): Promise<{ pubkey: string; npub: string; account_index: number }>
  importSeed(mnemonic: string, pin: string, name?: string, pinHint?: string): Promise<{ pubkey: string; npub: string; seed_id: string }>
  importNsec(nsecOrHex: string, pin: string, name?: string, pinHint?: string): Promise<{ pubkey: string; npub: string }>
  verifyPin(pubkey: string, pin: string): Promise<boolean>
  deleteAccount(pubkey: string, pin: string): Promise<void>
  /** PIN-gated: returns the seed mnemonic / nsec for reveal + backup. */
  exportSeed(pubkey: string, pin: string): Promise<string>
  exportNsec(pubkey: string, pin: string): Promise<string>
  renameSeed(seedId: string, name: string): Promise<void>
  renameAccount(pubkey: string, name: string): Promise<void>
  changePin(pubkey: string, currentPin: string, newPin: string, newHint?: string): Promise<void>
  /** PIN-gated: unlock the account and describe how to finish login (see applyLogin). */
  loginAccount(pubkey: string, pin: string): Promise<LoginResult>
}

/** Finish login from a LoginResult: set the signer (if any) and authenticate. */
export function applyLogin(pubkey: string, r: LoginResult) {
  if (r.signer) useUserStore.getState().setSigner(r.signer)
  useUserStore.getState().login(pubkey, r.authMethod, r.privKey)
}

/* ─── Desktop: OS keyring via Tauri ─── */
export const rustBackend: AuthBackend = {
  listAccounts: rsListAccounts,
  listSeeds: rsListSeeds,
  getActiveAccount: rsGetActive,
  generateAccount: rsGenerateAccount,
  generateNewSeed: rsGenerateNewSeed,
  deriveNextAccount: rsDerive,
  importSeed: rsImportSeed,
  importNsec: rsImportNsec,
  verifyPin: rsVerifyPin,
  deleteAccount: rsDeleteAccount,
  exportSeed: rsExportSeed,
  exportNsec: rsExportNsec,
  renameSeed: rsRenameSeed,
  renameAccount: rsRenameAccount,
  changePin: rsChangePin,
  async loginAccount(pubkey, pin) {
    const privKey = await rsLoginAccount(pubkey, pin)
    const acct = (await rsListAccounts()).find((a) => a.pubkey === pubkey)
    return { authMethod: acct?.auth_method ?? 'seed', privKey, signer: null }
  },
}

/* ─── Mobile/PWA: vault ─── */
const npubOf = (pubkey: string) => nip19.npubEncode(pubkey)

async function vaultGenerate(pin: string, name?: string, pinHint?: string): Promise<GenResult> {
  const g = await getVaultClient().generate()
  const r = await getVaultClient().saveNew(g.mnemonic, pin, name, pinHint)
  return { pubkey: r.pubkey, npub: npubOf(r.pubkey), mnemonic: g.mnemonic, seed_id: r.seedId }
}

export const vaultBackend: AuthBackend = {
  async listAccounts() {
    const s = await getVaultClient().status()
    const seedById = new Map(s.seeds.map((sd) => [sd.id, sd]))
    return s.accounts.map((a): StoredAccount => {
      const seed = seedById.get(a.seedId)
      const isKey = seed?.kind === 'key'
      return {
        pubkey: a.pubkey,
        npub: a.npub,
        name: a.name,
        auth_method: isKey ? 'nsec' : 'seed',
        seed_id: isKey ? null : a.seedId,
        account_index: isKey ? null : a.index,
        created_at: a.createdAt,
        has_pin: true,
        pin_hint: seed?.hint ?? null,
      }
    })
  },
  async listSeeds() {
    const s = await getVaultClient().status()
    return s.seeds.filter((sd) => sd.kind === 'seed').map((sd): StoredSeed => ({
      id: sd.id,
      name: sd.name || '',
      account_pubkeys: s.accounts.filter((a) => a.seedId === sd.id).map((a) => a.pubkey),
    }))
  },
  async getActiveAccount() {
    return (await getVaultClient().status()).active
  },
  generateAccount: vaultGenerate,
  generateNewSeed: vaultGenerate,
  async deriveNextAccount(seedId, pin) {
    const r = await getVaultClient().deriveAccount(seedId, pin)
    const acct = (await getVaultClient().status()).accounts.find((a) => a.pubkey === r.pubkey)
    return { pubkey: r.pubkey, npub: npubOf(r.pubkey), account_index: acct?.index ?? 0 }
  },
  async importSeed(mnemonic, pin, name, pinHint) {
    const r = await getVaultClient().saveNew(mnemonic, pin, name, pinHint)
    return { pubkey: r.pubkey, npub: npubOf(r.pubkey), seed_id: r.seedId }
  },
  async importNsec(nsecOrHex, pin, name, pinHint) {
    // The vault imports an encrypted backup; encrypt the key with its PIN first.
    const payload = await encryptBackup(nsecOrHex.trim(), pin)
    const r = await getVaultClient().importBackup(payload, pin, name, pinHint)
    return { pubkey: r.pubkey, npub: npubOf(r.pubkey) }
  },
  async verifyPin(pubkey, pin) {
    // exportBackup is PIN-gated and side-effect-free — succeeds iff the PIN is right.
    try { await getVaultClient().exportBackup(pubkey, pin); return true } catch { return false }
  },
  async deleteAccount(pubkey, pin) {
    await getVaultClient().removeAccount(pubkey, pin)
  },
  async exportSeed(pubkey, pin) {
    const { payload } = await getVaultClient().exportBackup(pubkey, pin) // PIN-gated
    return decryptBackup(payload, pin) // the stored secret (mnemonic)
  },
  async exportNsec(pubkey, pin) {
    const { payload } = await getVaultClient().exportBackup(pubkey, pin)
    return decryptBackup(payload, pin) // the stored secret (nsec)
  },
  async renameSeed(seedId, name) { await getVaultClient().renameSeed(seedId, name) },
  async renameAccount(pubkey, name) { await getVaultClient().renameAccount(pubkey, name) },
  async changePin(pubkey, currentPin, newPin, newHint) { await getVaultClient().changePin(pubkey, currentPin, newPin, newHint) },
  async loginAccount(pubkey, pin) {
    await getVaultClient().unlock(pubkey, pin) // PIN-gated; throws on wrong PIN
    return { authMethod: 'vault', privKey: null, signer: vaultSigner() }
  },
}
