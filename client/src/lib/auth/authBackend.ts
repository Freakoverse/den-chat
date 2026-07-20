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
import { createTaprootTransaction, createSegwitTransaction, type UTXO } from '@/lib/crypto/btc-tx'
import { signEvmTransaction, getEvmSigningKey } from '@/lib/crypto/evm-tx'
import type { EvmChain } from '@/stores/rpcStore'

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
  /** PIN-gated: returns the seed mnemonic / nsec for reveal + backup (desktop). */
  exportSeed(pubkey: string, pin: string): Promise<string>
  exportNsec(pubkey: string, pin: string): Promise<string>
  /** Vault only: reveal the secret + offer a backup download inside the vault overlay (nothing returned to the app). */
  revealSecret?(pubkey: string): Promise<void>
  renameSeed(seedId: string, name: string): Promise<void>
  renameAccount(pubkey: string, name: string): Promise<void>
  changePin(pubkey: string, currentPin: string, newPin: string, newHint?: string): Promise<void>
  /** PIN-gated: unlock the account and describe how to finish login (see applyLogin). */
  loginAccount(pubkey: string, pin: string): Promise<LoginResult>
  /**
   * Build + sign a blockchain transaction. Desktop verifies `pin` and signs locally;
   * the vault ignores `pin` and confirms with its own in-iframe PIN prompt. The app
   * gathers the structured inputs (UTXOs/nonce/gas) and broadcasts the returned hex.
   */
  signTransaction(pubkey: string, chain: string, tx: BtcSignTx | EvmSignTx, pin?: string): Promise<{ signed: string }>
  /** true → the app must collect the PIN and show its own confirm (desktop); false → the vault does. */
  confirmsInApp: boolean
  /**
   * true → secrets + PINs are entered in the vault's own overlay, NOT the app (PWA);
   * the UI must skip its in-app PIN screens and let the backend method drive the vault prompt.
   * false → the app collects PINs in its own UI (desktop OS keyring).
   */
  promptsInVault: boolean
}

export interface BtcSignTx { utxos: UTXO[]; recipientAddress: string; amountSats: string | number; feeRate: number; addressType: 'taproot' | 'segwit' | 'segwit-odd'; /** Address the UTXOs belong to — selects the correct key parity for P2WPKH. */ fromAddress?: string }
export interface EvmSignTx { to: string; value: string | number; data?: Uint8Array; gasLimit: string | number; gasPrice: string | number; nonce: string | number; addressMode?: 'nostr' | 'standard' }

function signTxLocally(privKey: string, chain: string, tx: BtcSignTx | EvmSignTx): { signed: string } {
  if (chain === 'bitcoin') {
    const t = tx as BtcSignTx
    const args = [privKey, t.utxos, t.recipientAddress, BigInt(t.amountSats), Number(t.feeRate)] as const
    // Both P2WPKH variants ('segwit' = 02‖x even-y, 'segwit-odd' = 03‖x odd-y) go to the
    // same signer — it picks the key parity that actually controls `fromAddress`, and
    // throws if neither does. Taproot forces even-y internally and is unaffected.
    const isP2wpkh = t.addressType === 'segwit' || t.addressType === 'segwit-odd'
    return { signed: isP2wpkh ? createSegwitTransaction(...args, t.fromAddress) : createTaprootTransaction(...args) }
  }
  const t = tx as EvmSignTx
  const signingKey = getEvmSigningKey(privKey, t.addressMode === 'standard' ? 'standard' : 'nostr')
  const signed = signEvmTransaction(
    { chain: chain as EvmChain, to: t.to, value: BigInt(t.value), data: t.data, gasLimit: BigInt(t.gasLimit), gasPrice: BigInt(t.gasPrice), nonce: BigInt(t.nonce) },
    signingKey,
  )
  return { signed }
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
  async signTransaction(pubkey, chain, tx, pin) {
    if (!pin) throw new Error('PIN required')
    const privKey = await rsLoginAccount(pubkey, pin) // PIN-gated; releases the key
    return signTxLocally(privKey, chain, tx)
  },
  confirmsInApp: true,
  promptsInVault: false,
}

/* ─── Mobile/PWA: vault ─── */
const npubOf = (pubkey: string) => nip19.npubEncode(pubkey)

// Generate + reveal + PIN entry all happen in the vault overlay; the app gets only the
// new pubkey/seedId — never the mnemonic or PIN.
async function vaultGenerate(): Promise<GenResult> {
  const r = await getVaultClient().generateInteractive()
  return { pubkey: r.pubkey, npub: npubOf(r.pubkey), mnemonic: '', seed_id: r.seedId }
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
  async deriveNextAccount(seedId) {
    const r = await getVaultClient().deriveInteractive(seedId) // PIN entered in the vault overlay
    const acct = (await getVaultClient().status()).accounts.find((a) => a.pubkey === r.pubkey)
    return { pubkey: r.pubkey, npub: npubOf(r.pubkey), account_index: acct?.index ?? 0 }
  },
  // Import (phrase / nsec / backup file) happens entirely in the vault overlay — the
  // secret and PIN never reach the app. Both entry points open the same overlay.
  async importSeed() {
    const r = await getVaultClient().importInteractive()
    return { pubkey: r.pubkey, npub: npubOf(r.pubkey), seed_id: r.seedId }
  },
  async importNsec() {
    const r = await getVaultClient().importInteractive()
    return { pubkey: r.pubkey, npub: npubOf(r.pubkey) }
  },
  async verifyPin(pubkey, pin) {
    // exportBackup is PIN-gated and side-effect-free — succeeds iff the PIN is right.
    try { await getVaultClient().exportBackup(pubkey, pin); return true } catch { return false }
  },
  async deleteAccount(pubkey) {
    await getVaultClient().removeInteractive(pubkey) // PIN confirmed in the vault overlay
  },
  // Reveal happens inside the vault overlay (see revealSecret) — the secret is never
  // returned to the app, so these guard against accidental app-side exposure.
  async exportSeed() { throw new Error('Secrets are revealed inside the vault') },
  async exportNsec() { throw new Error('Secrets are revealed inside the vault') },
  async revealSecret(pubkey) { await getVaultClient().exportRevealInteractive(pubkey) },
  async renameSeed(seedId, name) { await getVaultClient().renameSeed(seedId, name) },
  async renameAccount(pubkey, name) { await getVaultClient().renameAccount(pubkey, name) },
  async changePin(pubkey) { await getVaultClient().changePinInteractive(pubkey) },
  async loginAccount(pubkey) {
    // PIN is entered in the vault's overlay — the app never sees it. Skip the prompt if
    // the vault is already unlocked for this account (e.g. right after generate/import).
    const v = getVaultClient()
    const s = await v.status()
    if (s.unlocked && s.pubkey === pubkey) v.markActive(pubkey)
    else await v.unlockInteractive(pubkey) // throws "Cancelled" if the user dismisses
    return { authMethod: 'vault', privKey: null, signer: vaultSigner() }
  },
  async signTransaction(_pubkey, chain, tx) {
    // The vault confirms + PINs in its own iframe and signs there — the key never leaves.
    return getVaultClient().signTransaction(chain, tx)
  },
  confirmsInApp: false,
  promptsInVault: true,
}
