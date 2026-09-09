/**
 * NIP-46 Nostr Connect Signer — Login via nostrconnect:// URI
 * Ported from Jumble's nostrConnection.signer.ts
 *
 * Flow:
 * 1. Client generates clientSecretKey and builds nostrconnect:// URI
 * 2. URI is displayed (QR code / copy) for user to paste in signer app
 * 3. Call login() — it blocks until the remote signer connects via relay
 * 4. Once connected, getPublicKey/signEvent/etc work normally
 */

import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { BunkerSigner as NBunkerSigner, createNostrConnectURI, toBunkerURL, parseBunkerInput } from 'nostr-tools/nip46'
import { bytesToHex } from '@noble/hashes/utils'
import { getRandomRelays } from '@/lib/nostr/relay-pool'

export interface NostrConnectLoginDetails {
  privKey: Uint8Array
  connectionString: string
}

/**
 * Generate login details (keys + connection URI) upfront.
 * This should be called once when the UI mounts.
 */
export function generateNostrConnectDetails(relays: string[] = getRandomRelays(3)): NostrConnectLoginDetails {
  const privKey = generateSecretKey()
  const connectionString = createNostrConnectURI({
    clientPubkey: getPublicKey(privKey),
    relays,
    secret: Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''),
    name: 'DEN Chat',
    url: window.location.origin,
  })
  return { privKey, connectionString }
}

export class NostrConnectSigner {
  signer: NBunkerSigner | null = null
  private clientSecretKey: Uint8Array
  private pubkey: string | null = null
  private bunkerString: string | null = null
  // Whether the remote signer implements NIP-SKD (§7) — probed once at login. Gates v2-hub
  // capability so `canUseV2`/the create toggle stay accurate for a signer that predates SKD.
  private skdSupported = false

  constructor(clientSecretKey: Uint8Array) {
    this.clientSecretKey = clientSecretKey
  }

  /**
   * Login using a nostrconnect:// connection string.
   * This call BLOCKS until the remote signer connects via the relay.
   * No manual "I've connected" button needed.
   *
   * @param abortSignal Optional AbortSignal to cancel the connection attempt
   */
  async login(connectionString: string, abortSignal?: AbortSignal): Promise<{ bunkerString: string | null; pubkey: string }> {
    this.signer = await NBunkerSigner.fromURI(this.clientSecretKey, connectionString, {
      onauth: (url) => {
        window.open(url, '_blank')
      },
    }, abortSignal || 60_000)

    this.bunkerString = toBunkerURL(this.signer.bp)
    this.pubkey = await this.signer.getPublicKey()
    this.skdSupported = await this.probeSkd()

    return { bunkerString: this.bunkerString, pubkey: this.pubkey }
  }

  async getPublicKey(): Promise<string> {
    if (!this.signer) throw new Error('Not logged in')
    if (!this.pubkey) {
      this.pubkey = await this.signer.getPublicKey()
    }
    return this.pubkey
  }

  async signEvent(draftEvent: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.signer) throw new Error('Not logged in')
    return this.signer.signEvent(draftEvent as any) as any
  }

  async nip04Encrypt(pubkey: string, plainText: string): Promise<string> {
    if (!this.signer) throw new Error('Not logged in')
    return this.signer.nip04Encrypt(pubkey, plainText)
  }

  async nip04Decrypt(pubkey: string, cipherText: string): Promise<string> {
    if (!this.signer) throw new Error('Not logged in')
    return this.signer.nip04Decrypt(pubkey, cipherText)
  }

  /**
   * NIP-04 encrypt/decrypt object — for NIP-04 (kind 4) DM support.
   * The presence of this getter is how the app detects NIP-04 capability.
   */
  get nip04() {
    return {
      encrypt: (pubkey: string, plaintext: string) => this.nip04Encrypt(pubkey, plaintext),
      decrypt: (pubkey: string, ciphertext: string) => this.nip04Decrypt(pubkey, ciphertext),
    }
  }

  async nip44Encrypt(pubkey: string, plainText: string): Promise<string> {
    if (!this.signer) throw new Error('Not logged in')
    return this.signer.nip44Encrypt(pubkey, plainText)
  }

  async nip44Decrypt(pubkey: string, cipherText: string): Promise<string> {
    if (!this.signer) throw new Error('Not logged in')
    return this.signer.nip44Decrypt(pubkey, cipherText)
  }

  /**
   * NIP-44 encrypt/decrypt object — exposes signer's nip44 capabilities
   */
  get nip44() {
    return {
      encrypt: (pubkey: string, plaintext: string) => this.nip44Encrypt(pubkey, plaintext),
      decrypt: (pubkey: string, ciphertext: string) => this.nip44Decrypt(pubkey, ciphertext),
    }
  }

  // ── NIP-SKD (§7): derive + act as v2-hub pseudonyms via the remote signer ──
  // Each of the three forms (self/shared/blinded) has its OWN method names; `peer` is a fixed
  // trailing positional param of the shared/blinded methods and is ABSENT from self (§7), so the
  // form is never inferred from argument presence. The sub-key never leaves the signer.

  // self form (no peer)
  async skdGetSelfSubkeyPubkey(context: string): Promise<string> {
    if (!this.signer) throw new Error('Not logged in')
    return this.signer.sendRequest('skd_get_self_subkey_pubkey', [context])
  }
  async skdSignAsSelfSubkey(context: string, event: unknown): Promise<Record<string, unknown>> {
    if (!this.signer) throw new Error('Not logged in')
    const resultJson = await this.signer.sendRequest('skd_sign_as_self_subkey', [context, JSON.stringify(event)])
    return JSON.parse(resultJson)
  }
  async skdNip44EncryptAsSelfSubkey(context: string, recipientPub: string, plaintext: string): Promise<string> {
    if (!this.signer) throw new Error('Not logged in')
    return this.signer.sendRequest('skd_nip44_encrypt_as_self_subkey', [context, recipientPub, plaintext])
  }
  async skdNip44DecryptAsSelfSubkey(context: string, senderPub: string, ciphertext: string): Promise<string> {
    if (!this.signer) throw new Error('Not logged in')
    return this.signer.sendRequest('skd_nip44_decrypt_as_self_subkey', [context, senderPub, ciphertext])
  }
  // shared form (peer required)
  async skdGetSharedSubkeyPubkey(context: string, peerPub: string): Promise<string> {
    if (!this.signer) throw new Error('Not logged in')
    return this.signer.sendRequest('skd_get_shared_subkey_pubkey', [context, peerPub])
  }
  async skdSignAsSharedSubkey(context: string, event: unknown, peerPub: string): Promise<Record<string, unknown>> {
    if (!this.signer) throw new Error('Not logged in')
    const resultJson = await this.signer.sendRequest('skd_sign_as_shared_subkey', [context, JSON.stringify(event), peerPub])
    return JSON.parse(resultJson)
  }
  async skdNip44EncryptAsSharedSubkey(context: string, recipientPub: string, plaintext: string, peerPub: string): Promise<string> {
    if (!this.signer) throw new Error('Not logged in')
    return this.signer.sendRequest('skd_nip44_encrypt_as_shared_subkey', [context, recipientPub, plaintext, peerPub])
  }
  async skdNip44DecryptAsSharedSubkey(context: string, senderPub: string, ciphertext: string, peerPub: string): Promise<string> {
    if (!this.signer) throw new Error('Not logged in')
    return this.signer.sendRequest('skd_nip44_decrypt_as_shared_subkey', [context, senderPub, ciphertext, peerPub])
  }
  // blinded form (peer required on every method; the blinded private scalar never leaves the signer)
  async skdGetBlindedPubkey(context: string, peerPub: string): Promise<string> {
    if (!this.signer) throw new Error('Not logged in')
    return this.signer.sendRequest('skd_get_blinded_pubkey', [context, peerPub])
  }
  async skdGetPeerBlindedPubkey(context: string, peerPub: string): Promise<string> {
    if (!this.signer) throw new Error('Not logged in')
    return this.signer.sendRequest('skd_get_peer_blinded_pubkey', [context, peerPub])
  }
  async skdSignAsBlinded(context: string, event: unknown, peerPub: string): Promise<Record<string, unknown>> {
    if (!this.signer) throw new Error('Not logged in')
    const resultJson = await this.signer.sendRequest('skd_sign_as_blinded', [context, JSON.stringify(event), peerPub])
    return JSON.parse(resultJson)
  }
  async skdNip44EncryptAsBlinded(context: string, recipientPub: string, plaintext: string, peerPub: string): Promise<string> {
    if (!this.signer) throw new Error('Not logged in')
    return this.signer.sendRequest('skd_nip44_encrypt_as_blinded', [context, recipientPub, plaintext, peerPub])
  }
  async skdNip44DecryptAsBlinded(context: string, senderPub: string, ciphertext: string, peerPub: string): Promise<string> {
    if (!this.signer) throw new Error('Not logged in')
    return this.signer.sendRequest('skd_nip44_decrypt_as_blinded', [context, senderPub, ciphertext, peerPub])
  }

  /** One-shot capability probe (§7), capped so a non-SKD signer doesn't slow login. Probes the
   *  **blinded** op (not self) — NIP-CHAT v2 authors members under the blinded form, so a signer
   *  with only the self/shared surface must be treated as unsupported (v2 gated off). */
  private async probeSkd(): Promise<boolean> {
    try {
      const pub = await Promise.race([
        this.skdGetBlindedPubkey('nip-skd:capability-probe', getPublicKey(this.clientSecretKey)),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 8000)),
      ])
      return /^[0-9a-f]{64}$/i.test(pub)
    } catch {
      return false
    }
  }

  /** NIP-SKD surface — present only when the signer advertised support (probed at login). */
  get skd() {
    if (!this.skdSupported) return undefined
    return {
      getSelfSubkeyPubkey: (context: string) => this.skdGetSelfSubkeyPubkey(context),
      signAsSelfSubkey: (context: string, event: unknown) => this.skdSignAsSelfSubkey(context, event),
      nip44EncryptAsSelfSubkey: (context: string, recipientPub: string, plaintext: string) => this.skdNip44EncryptAsSelfSubkey(context, recipientPub, plaintext),
      nip44DecryptAsSelfSubkey: (context: string, senderPub: string, ciphertext: string) => this.skdNip44DecryptAsSelfSubkey(context, senderPub, ciphertext),
      getSharedSubkeyPubkey: (context: string, peerPub: string) => this.skdGetSharedSubkeyPubkey(context, peerPub),
      signAsSharedSubkey: (context: string, event: unknown, peerPub: string) => this.skdSignAsSharedSubkey(context, event, peerPub),
      nip44EncryptAsSharedSubkey: (context: string, recipientPub: string, plaintext: string, peerPub: string) => this.skdNip44EncryptAsSharedSubkey(context, recipientPub, plaintext, peerPub),
      nip44DecryptAsSharedSubkey: (context: string, senderPub: string, ciphertext: string, peerPub: string) => this.skdNip44DecryptAsSharedSubkey(context, senderPub, ciphertext, peerPub),
      getBlindedPubkey: (context: string, peerPub: string) => this.skdGetBlindedPubkey(context, peerPub),
      getPeerBlindedPubkey: (context: string, peerPub: string) => this.skdGetPeerBlindedPubkey(context, peerPub),
      signAsBlinded: (context: string, event: unknown, peerPub: string) => this.skdSignAsBlinded(context, event, peerPub),
      nip44EncryptAsBlinded: (context: string, recipientPub: string, plaintext: string, peerPub: string) => this.skdNip44EncryptAsBlinded(context, recipientPub, plaintext, peerPub),
      nip44DecryptAsBlinded: (context: string, senderPub: string, ciphertext: string, peerPub: string) => this.skdNip44DecryptAsBlinded(context, senderPub, ciphertext, peerPub),
    }
  }

  getClientSecretKey(): string {
    return bytesToHex(this.clientSecretKey)
  }

  getBunkerString(): string | null {
    return this.bunkerString
  }

  /**
   * Re-establish the relay subscription in place using the bunker string
   * captured at login (no new nostrconnect:// handshake needed — the signer
   * already approved us). Fixes the case where the PWA was backgrounded and the
   * relay WebSocket got suspended.
   */
  async reconnect(): Promise<void> {
    if (!this.bunkerString) return
    const bunkerPointer = await parseBunkerInput(this.bunkerString)
    if (!bunkerPointer) return
    this.signer = NBunkerSigner.fromBunker(this.clientSecretKey, bunkerPointer, {
      onauth: (url) => { window.open(url, '_blank') },
    })
    // Warm the connection in the background; don't block recovery on it.
    this.signer.getPublicKey().catch(() => {})
  }

  close(): void {
    this.signer = null
    this.pubkey = null
    this.bunkerString = null
  }
}
