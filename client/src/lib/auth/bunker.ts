/**
 * NIP-46 Bunker Signer — Login via bunker:// URL
 * Ported from Jumble's bunker.signer.ts
 *
 * Uses nostr-tools BunkerSigner to connect to a remote signer
 * via a bunker:// URL (e.g., from nsecBunker).
 */

import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { BunkerSigner as NBunkerSigner, parseBunkerInput } from 'nostr-tools/nip46'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

export class BunkerSigner {
  signer: NBunkerSigner | null = null
  private clientSecretKey: Uint8Array
  private pubkey: string | null = null
  private bunkerUrl: string | null = null
  // Whether the remote signer implements NIP-SKD (§7) — probed once at login. Gates v2-hub
  // capability so `canUseV2`/the create toggle stay accurate for a signer that predates SKD.
  private skdSupported = false

  constructor(clientSecretKey?: string) {
    this.clientSecretKey = clientSecretKey ? hexToBytes(clientSecretKey) : generateSecretKey()
  }

  /**
   * Login with a bunker:// URL.
   * @param bunker - bunker:// URL string
   * @param isInitialConnection - whether to send connect handshake
   * @returns The user's Nostr pubkey
   */
  async login(bunker: string, isInitialConnection = true): Promise<string> {
    const bunkerPointer = await parseBunkerInput(bunker)
    if (!bunkerPointer) {
      throw new Error('Invalid bunker URL')
    }
    // A bunker URL must carry at least one relay (bunker://<pubkey>?relay=wss://…);
    // without it connect() has nowhere to reach the signer and fails instantly.
    if (!bunkerPointer.relays || bunkerPointer.relays.length === 0) {
      throw new Error('This bunker URL has no relay. It must include ?relay=wss://… so the app can reach your signer.')
    }
    this.bunkerUrl = bunker

    this.signer = NBunkerSigner.fromBunker(this.clientSecretKey, bunkerPointer, {
      onauth: (url) => {
        window.open(url, '_blank')
      },
    })

    if (isInitialConnection) {
      await this.signer.connect()
    }

    this.pubkey = await this.signer.getPublicKey()
    this.skdSupported = await this.probeSkd()
    return this.pubkey
  }

  /**
   * Re-establish the relay subscription from the stored bunker URL without a
   * full reload (the previous WebSocket may have been suspended in the
   * background). Re-creates the underlying signer with a fresh subscription and
   * warms it; subsequent calls go through the new connection.
   */
  async reconnect(): Promise<void> {
    if (!this.bunkerUrl) return
    const bunkerPointer = await parseBunkerInput(this.bunkerUrl)
    if (!bunkerPointer) return
    this.signer = NBunkerSigner.fromBunker(this.clientSecretKey, bunkerPointer, {
      onauth: (url) => { window.open(url, '_blank') },
    })
    // Warm the connection in the background; don't block recovery on it.
    this.signer.getPublicKey().catch(() => {})
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
   * NIP-04 encrypt/decrypt object for ISigner interface.
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
   * NIP-44 encrypt/decrypt object — for NIP-17 DM support
   */
  get nip44() {
    return {
      encrypt: (pubkey: string, plaintext: string) => this.nip44Encrypt(pubkey, plaintext),
      decrypt: (pubkey: string, ciphertext: string) => this.nip44Decrypt(pubkey, ciphertext),
    }
  }

  // ── NIP-SKD (§7): derive + act as v2-hub pseudonyms via the remote signer ──
  // Forwards the §7 request methods over NIP-46. `peer` is the TRAILING positional param and is
  // OMITTED for self derivations. The sub-key never leaves the signer.

  async skdGetSubkeyPubkey(context: string, peerPub?: string): Promise<string> {
    if (!this.signer) throw new Error('Not logged in')
    return this.signer.sendRequest('skd_get_subkey_pubkey', peerPub ? [context, peerPub] : [context])
  }
  async skdSignAsSubkey(context: string, event: unknown, peerPub?: string): Promise<Record<string, unknown>> {
    if (!this.signer) throw new Error('Not logged in')
    const eventJson = JSON.stringify(event)
    const resultJson = await this.signer.sendRequest('skd_sign_as_subkey', peerPub ? [context, eventJson, peerPub] : [context, eventJson])
    return JSON.parse(resultJson)
  }
  async skdNip44EncryptAsSubkey(context: string, recipientPub: string, plaintext: string, peerPub?: string): Promise<string> {
    if (!this.signer) throw new Error('Not logged in')
    return this.signer.sendRequest('skd_nip44_encrypt_as_subkey', peerPub ? [context, recipientPub, plaintext, peerPub] : [context, recipientPub, plaintext])
  }
  async skdNip44DecryptAsSubkey(context: string, senderPub: string, ciphertext: string, peerPub?: string): Promise<string> {
    if (!this.signer) throw new Error('Not logged in')
    return this.signer.sendRequest('skd_nip44_decrypt_as_subkey', peerPub ? [context, senderPub, ciphertext, peerPub] : [context, senderPub, ciphertext])
  }

  /** One-shot capability probe (§7), capped so a non-SKD bunker doesn't slow login. */
  private async probeSkd(): Promise<boolean> {
    try {
      const pub = await Promise.race([
        this.skdGetSubkeyPubkey('nip-skd:capability-probe'),
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
      getSubkeyPubkey: (context: string, peerPub?: string) => this.skdGetSubkeyPubkey(context, peerPub),
      signAsSubkey: (context: string, event: unknown, peerPub?: string) => this.skdSignAsSubkey(context, event, peerPub),
      nip44EncryptAsSubkey: (context: string, recipientPub: string, plaintext: string, peerPub?: string) => this.skdNip44EncryptAsSubkey(context, recipientPub, plaintext, peerPub),
      nip44DecryptAsSubkey: (context: string, senderPub: string, ciphertext: string, peerPub?: string) => this.skdNip44DecryptAsSubkey(context, senderPub, ciphertext, peerPub),
    }
  }

  getClientSecretKey(): string {
    return bytesToHex(this.clientSecretKey)
  }

  getClientPublicKey(): string {
    return getPublicKey(this.clientSecretKey)
  }

  close(): void {
    this.signer = null
    this.pubkey = null
  }
}
