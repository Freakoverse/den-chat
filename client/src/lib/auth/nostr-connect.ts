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

const DEFAULT_RELAYS = ['wss://relay.primal.net', 'wss://relay.damus.io', 'wss://nos.lol']

export interface NostrConnectLoginDetails {
  privKey: Uint8Array
  connectionString: string
}

/**
 * Generate login details (keys + connection URI) upfront.
 * This should be called once when the UI mounts.
 */
export function generateNostrConnectDetails(relays: string[] = DEFAULT_RELAYS): NostrConnectLoginDetails {
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
