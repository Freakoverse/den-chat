/**
 * vaultClient — talks to the isolated vault origin (denchat.dekev.top) from the app.
 *
 * Embeds the vault as a hidden iframe and proxies key operations over postMessage.
 * The private key lives entirely in the vault origin; the app only ever sends
 * "sign this" / "decrypt this" requests and gets results back — so an XSS in the
 * app can't read the key.
 *
 * The vault is local (no relays/network), in the same page process, so there's no
 * connection to drop — no reconnect logic needed (unlike NIP-46).
 */

import type { ISigner } from '@/stores/userStore'
import type { SkdSigner } from '@/lib/crypto/skd'
import { SUPPORTED_SIGNER_SCHEMES } from '@/lib/crypto/skd'
import type { BackupPayloadV1 } from '@/lib/auth/backupCrypto'

/**
 * The vault's deployed origin. On a SEPARATE registrable domain from the app
 * (dekev.top vs denchat.top) so Site Isolation puts the vault in its own process —
 * closing the Spectre-class same-process gap a subdomain would leave open.
 */
export const VAULT_ORIGIN = 'https://denchat.dekev.top'

/** Plaintext metadata (no secrets). A "seed" holds one PIN; accounts are derived from it. */
export interface VaultSeed { id: string; name: string | null; kind: 'seed' | 'key'; hint: string | null; createdAt: number }
export interface VaultAccount { pubkey: string; npub: string; seedId: string; index: number; name: string | null; createdAt: number }
export interface VaultStatus { seeds: VaultSeed[]; accounts: VaultAccount[]; active: string | null; unlocked: boolean; pubkey: string | null }

const REQUEST_TIMEOUT = 30_000
const HIDDEN_IFRAME_CSS = 'position:fixed;width:0;height:0;border:0;visibility:hidden;background:transparent;'
// Transparent so the vault's confirm card floats over the app (the app stays visible behind the dimmed backdrop).
const OVERLAY_IFRAME_CSS = 'position:fixed;inset:0;width:100%;height:100%;border:0;visibility:visible;z-index:2147483647;background:transparent;'

interface PendingRequest {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class VaultClient {
  private iframe: HTMLIFrameElement | null = null
  private ready: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private pending = new Map<string, PendingRequest>()
  private seq = 0
  /** Last-unlocked account — used to re-unlock after the vault auto-locks on idle. */
  private activePubkey: string | null = null
  /**
   * Capabilities the DEPLOYED vault advertised in its ready handshake (e.g. 'skd:1'). `null` until the
   * handshake lands. This is how the app learns what the LIVE vault backend can actually do — not what the
   * client-side adapter merely knows how to ask for. An old vault build sends no capabilities → this stays
   * an empty list → v2 (NIP-SKD) is gated off, exactly like an extension that doesn't implement it.
   */
  private capabilities: string[] | null = null
  /** App-provided handler that prompts the user for their PIN and unlocks. */
  private unlockHandler: ((pubkey: string) => Promise<void>) | null = null

  /** Register the re-unlock prompt (called by VaultLockGate). */
  setUnlockHandler(fn: ((pubkey: string) => Promise<void>) | null) { this.unlockHandler = fn }
  getActivePubkey() { return this.activePubkey }

  /**
   * Whether the DEPLOYED vault advertised a NIP-SKD scheme this client supports (needed for v2 hubs).
   * Returns false until the ready handshake lands, and for any older vault that doesn't advertise it — so
   * the v2 toggle stays off rather than enabling an operation the live vault would reject mid-flight.
   */
  supportsSkd(): boolean {
    const caps = this.capabilities ?? []
    return caps.some((c) => (SUPPORTED_SIGNER_SCHEMES as readonly string[]).includes(c))
  }

  /** Kick off the iframe handshake early (fire-and-forget) so `capabilities` is populated before it's read. */
  warmUp(): void { void this.ensure() }

  /** Lazily create the iframe + message listener and wait for the vault handshake. */
  private ensure(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve) => { this.readyResolve = resolve })

    window.addEventListener('message', this.onMessage)

    const iframe = document.createElement('iframe')
    iframe.src = VAULT_ORIGIN + '/'
    iframe.setAttribute('aria-hidden', 'true')
    iframe.allow = 'camera' // delegate camera to the vault origin for in-vault QR scanning
    iframe.style.cssText = HIDDEN_IFRAME_CSS
    iframe.title = 'DEN Chat Vault'
    document.body.appendChild(iframe)
    this.iframe = iframe

    return this.ready
  }

  /** Resize the hidden iframe into a full-screen overlay (for the in-vault tx confirm) and back. */
  private setOverlay(show: boolean) {
    if (this.iframe) this.iframe.style.cssText = show ? OVERLAY_IFRAME_CSS : HIDDEN_IFRAME_CSS
  }

  private onMessage = (e: MessageEvent) => {
    if (e.origin !== VAULT_ORIGIN) return // only trust the vault origin
    const msg = e.data
    if (msg?.type === 'vault-ready') {
      // Record what the live vault says it supports. Missing/!array ⇒ an old build ⇒ no extra capabilities.
      this.capabilities = Array.isArray(msg.capabilities) ? msg.capabilities.filter((c: unknown): c is string => typeof c === 'string') : []
      this.readyResolve?.()
      return
    }
    if (msg?.type === 'vault-overlay') { this.setOverlay(!!msg.show); return }
    if (typeof msg?.id !== 'string') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error || 'Vault error'))
  }

  /** Send an op to the vault and await its result. */
  async call<T = unknown>(type: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT): Promise<T> {
    await this.ensure()
    const id = `r${++this.seq}`
    const win = this.iframe?.contentWindow
    if (!win) throw new Error('Vault not available')
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Vault request timed out'))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      win.postMessage({ id, type, params }, VAULT_ORIGIN)
    })
  }

  /**
   * Like call(), but if the vault has auto-locked on idle, prompt the user to
   * re-enter their PIN (via the registered handler) and retry once. Used for the
   * signer ops so a lock mid-session is transparent rather than a hard failure.
   */
  private async callWithRelock<T>(type: string, params?: unknown): Promise<T> {
    try {
      return await this.call<T>(type, params)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/lock/i.test(msg) && this.unlockHandler && this.activePubkey) {
        await this.unlockHandler(this.activePubkey)  // resolves once the user unlocks
        return await this.call<T>(type, params)      // retry once
      }
      throw e
    }
  }

  // ── Lifecycle / identity management ──
  status() { return this.call<VaultStatus>('status') }
  listAccounts() { return this.call<VaultAccount[]>('listAccounts') }
  generate() { return this.call<{ mnemonic: string; pubkey: string }>('generate') }
  /** Generate + reveal a new seed in the vault overlay (PIN set there); returns only the pubkey. */
  generateInteractive() { return this.call<{ pubkey: string; seedId: string }>('generateInteractive', undefined, 10 * 60_000) }
  saveNew(mnemonic: string, pin: string, name?: string, hint?: string) { return this.call<{ pubkey: string; seedId: string }>('saveNew', { mnemonic, pin, name, hint }) }
  importBackup(payload: BackupPayloadV1, password: string, name?: string, hint?: string) { return this.call<{ pubkey: string; seedId: string }>('importBackup', { payload, password, name, hint }) }
  /** Import a phrase / nsec / backup file in the vault overlay (secret + PIN entered there); returns only the pubkey. */
  importInteractive() { return this.call<{ pubkey: string; seedId: string }>('importInteractive', undefined, 10 * 60_000) }
  deriveAccount(seedId: string, pin: string, name?: string) { return this.call<{ pubkey: string }>('deriveAccount', { seedId, pin, name }) }
  async unlock(pubkey: string, pin: string) {
    const r = await this.call<{ pubkey: string }>('unlock', { pubkey, pin })
    this.activePubkey = pubkey
    return r
  }
  /** Unlock with the PIN collected in the vault's own overlay (the app never sees it). */
  async unlockInteractive(pubkey: string) {
    const r = await this.call<{ pubkey: string }>('unlockInteractive', { pubkey }, 5 * 60_000)
    this.activePubkey = pubkey
    return r
  }
  /** Mark an already-unlocked account active (e.g. right after generate/import) for relock tracking. */
  markActive(pubkey: string) { this.activePubkey = pubkey }
  lock() { return this.call('lock') }
  removeAccount(pubkey: string, pin: string) { return this.call<{ ok: boolean }>('removeAccount', { pubkey, pin }) }
  renameSeed(seedId: string, name: string) { return this.call<{ ok: boolean }>('renameSeed', { seedId, name }) }
  renameAccount(pubkey: string, name: string) { return this.call<{ ok: boolean }>('renameAccount', { pubkey, name }) }
  changePin(pubkey: string, currentPin: string, newPin: string, newHint?: string) { return this.call<{ ok: boolean }>('changePin', { pubkey, currentPin, newPin, newHint }) }
  // ── Interactive (PIN/secret entered in the vault overlay) ──
  deriveInteractive(seedId: string) { return this.call<{ pubkey: string }>('deriveInteractive', { seedId }, 5 * 60_000) }
  removeInteractive(pubkey: string) { return this.call<{ ok: boolean }>('removeInteractive', { pubkey }, 5 * 60_000) }
  verifyPinInteractive(pubkey: string) { return this.call<{ ok: boolean }>('verifyPinInteractive', { pubkey }, 5 * 60_000) }
  exportRevealInteractive(pubkey: string) { return this.call<{ ok: boolean }>('exportRevealInteractive', { pubkey }, 10 * 60_000) }
  changePinInteractive(pubkey: string) { return this.call<{ ok: boolean }>('changePinInteractive', { pubkey }, 5 * 60_000) }
  /** Build + sign a blockchain transaction from structured params (the vault derives the sighash + confirms with PIN). */
  signTransaction(chain: string, tx: unknown) { return this.call<{ signed: string }>('signTransaction', { chain, tx }, 5 * 60_000) }

  // ── ISigner-shaped operations (transparent re-unlock on idle-lock) ──
  getPublicKey() { return this.callWithRelock<string>('getPublicKey') }
  signEvent(event: Record<string, unknown>) { return this.callWithRelock<Record<string, unknown>>('signEvent', { event }) }
  nip04Encrypt(pubkey: string, plaintext: string) { return this.callWithRelock<string>('nip04Encrypt', { pubkey, plaintext }) }
  nip04Decrypt(pubkey: string, ciphertext: string) { return this.callWithRelock<string>('nip04Decrypt', { pubkey, ciphertext }) }
  nip44Encrypt(pubkey: string, plaintext: string) { return this.callWithRelock<string>('nip44Encrypt', { pubkey, plaintext }) }
  nip44Decrypt(pubkey: string, ciphertext: string) { return this.callWithRelock<string>('nip44Decrypt', { pubkey, ciphertext }) }

  // ── NIP-SKD sub-key operations (v2 hubs) — the private material stays in the vault ──
  skdGetSubkeyPubkey(context: string, peerPub?: string) { return this.callWithRelock<string>('skdGetSubkeyPubkey', { context, peerPub }) }
  skdSignAsSubkey(context: string, event: unknown, peerPub?: string) { return this.callWithRelock<Record<string, unknown>>('skdSignAsSubkey', { context, event, peerPub }) }
  skdNip44EncryptAsSubkey(context: string, recipientPub: string, plaintext: string, peerPub?: string) { return this.callWithRelock<string>('skdNip44EncryptAsSubkey', { context, recipientPub, plaintext, peerPub }) }
  skdNip44DecryptAsSubkey(context: string, senderPub: string, ciphertext: string, peerPub?: string) { return this.callWithRelock<string>('skdNip44DecryptAsSubkey', { context, senderPub, ciphertext, peerPub }) }
}

let singleton: VaultClient | null = null
export function getVaultClient(): VaultClient {
  if (!singleton) singleton = new VaultClient()
  return singleton
}

/** Adapter so the rest of the app can use the vault as a standard ISigner.
 *  The NIP-SKD surface (`.skd`, used for v2 hubs and feature-detected by canUseV2) is exposed ONLY when the
 *  DEPLOYED vault advertised SKD support in its ready handshake — an old vault build that can't actually do
 *  the skd* ops presents no `.skd`, so the v2 toggle stays off instead of failing mid-creation. Modelled as
 *  a getter so it reflects the live capability even if the signer object was built before the handshake. */
export function vaultSigner(): ISigner & SkdSigner {
  const v = getVaultClient()
  v.warmUp() // start the handshake now so `.skd` resolves correctly by the time the v2 toggle renders
  return {
    getPublicKey: () => v.getPublicKey(),
    signEvent: (draft) => v.signEvent(draft),
    nip04: {
      encrypt: (pubkey, plaintext) => v.nip04Encrypt(pubkey, plaintext),
      decrypt: (pubkey, ciphertext) => v.nip04Decrypt(pubkey, ciphertext),
    },
    nip44: {
      encrypt: (pubkey, plaintext) => v.nip44Encrypt(pubkey, plaintext),
      decrypt: (pubkey, ciphertext) => v.nip44Decrypt(pubkey, ciphertext),
    },
    // NIP-SKD: derive + act as v2 hub pseudonyms (O/P/Pf + join addr) without the sub-key ever leaving the
    // vault. Present only when the live vault supports it (see above) — otherwise `undefined`, so
    // signerSupportsSkd() is false and v2 is gated off, exactly as for an extension without skd.
    get skd(): SkdSigner['skd'] {
      if (!v.supportsSkd()) return undefined
      return {
        getSubkeyPubkey: (context, peerPub) => v.skdGetSubkeyPubkey(context, peerPub),
        signAsSubkey: (context, event, peerPub) => v.skdSignAsSubkey(context, event, peerPub),
        nip44EncryptAsSubkey: (context, recipientPub, plaintext, peerPub) => v.skdNip44EncryptAsSubkey(context, recipientPub, plaintext, peerPub),
        nip44DecryptAsSubkey: (context, senderPub, ciphertext, peerPub) => v.skdNip44DecryptAsSubkey(context, senderPub, ciphertext, peerPub),
      }
    },
  }
}
