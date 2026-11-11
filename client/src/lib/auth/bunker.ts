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

/** Per-attempt timeout for a single signer round-trip. Short because a loopback/LRS signer answers in
 *  milliseconds; a request still outstanding after this was almost certainly dropped (and is retried
 *  once). Kept under the SignerGuard's 20s so two attempts still fit inside its window. */
const SIGNER_ATTEMPT_TIMEOUT_MS = 8000

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Signer ${label} timed out after ${ms / 1000}s`)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

export class BunkerSigner {
  signer: NBunkerSigner | null = null
  private clientSecretKey: Uint8Array
  private pubkey: string | null = null
  private bunkerUrl: string | null = null
  // Whether the remote signer implements NIP-SKD (§7) — probed once at login. Gates v2-hub
  // capability so `canUseV2`/the create toggle stay accurate for a signer that predates SKD.
  private skdSupported = false
  /** Serializes ALL signer round-trips to one-in-flight (see {@link call}). */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(clientSecretKey?: string) {
    this.clientSecretKey = clientSecretKey ? hexToBytes(clientSecretKey) : generateSecretKey()
  }

  /**
   * Login with a bunker:// URL.
   * @param bunker - bunker:// URL string
   * @param isInitialConnection - whether to send connect handshake
   * @param metadata - optional app metadata ({name,url,image}) sent with the FIRST connect so the
   *                   signer can label the connection with a real app name instead of a key/origin.
   *                   Used by the LRS (local) path, which has no pasted nostrconnect:// URI to carry
   *                   it; harmless for ordinary bunker:// (a signer keeps its stored name on reconnect).
   * @returns The user's Nostr pubkey
   */
  async login(bunker: string, isInitialConnection = true, metadata?: Record<string, unknown>): Promise<string> {
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
    this.wrapSendRequest() // serialize + timeout + retry every round-trip (see call())

    if (isInitialConnection) {
      await this.signer.connect(metadata)
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
    this.wrapSendRequest()
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
  // Composed verifier ops (NIP-SKD §1.2) — remote owner (ViaSelf) / facilitator (ViaBlinded); pubkey only.
  async skdGetPeerBlindedPubkeyViaSelf(viaContext: string, context: string, peerPub: string): Promise<string> {
    if (!this.signer) throw new Error('Not logged in')
    return this.signer.sendRequest('skd_get_peer_blinded_pubkey_via_self', [viaContext, context, peerPub])
  }
  async skdGetPeerBlindedPubkeyViaBlinded(viaContext: string, viaPeerPub: string, context: string, peerPub: string): Promise<string> {
    if (!this.signer) throw new Error('Not logged in')
    return this.signer.sendRequest('skd_get_peer_blinded_pubkey_via_blinded', [viaContext, viaPeerPub, context, peerPub])
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

  /** One-shot capability probe (§7), capped so a non-SKD bunker doesn't slow login. Probes the
   *  **blinded** op (not self) — NIP-CHAT v2 authors members under the blinded form, so a signer
   *  with only the self/shared surface must be treated as unsupported (v2 gated off). */
  private async probeSkd(): Promise<boolean> {
    try {
      const pub = await Promise.race([
        this.skdGetBlindedPubkey('nip-skd:capability-probe', this.getClientPublicKey()),
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

  /**
   * Route every signer round-trip through here: ONE-IN-FLIGHT serialization + a per-call timeout + a
   * single re-send retry. A local (LRS/DENOS) signer over the loopback silently DROPS requests that
   * arrive concurrently, so serializing means it only ever sees one at a time, which removes the burst
   * that made grouped-hub/DM decrypts hang for 20s and trip the circuit breaker. The timeout also gives
   * sign/SKD ops a bound they otherwise lack (they can hang forever). `connect` is never timed, it may
   * legitimately block on first-time user approval at the signer.
   */
  private call<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => this.attempt(label, fn), () => this.attempt(label, fn))
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }
  private async attempt<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (label === 'connect') return fn() // first-time approval can take as long as the user needs
    let lastErr: unknown
    for (let i = 0; i < 2; i++) {
      try {
        return await withTimeout(fn(), SIGNER_ATTEMPT_TIMEOUT_MS, label)
      } catch (err) {
        lastErr = err
        const msg = err instanceof Error ? err.message.toLowerCase() : ''
        const transient = msg.includes('timeout') || msg.includes('timed out') || msg.includes('connection')
          || msg.includes('not connected') || msg.includes('closed') || msg.includes('closing') || msg.includes('aborted')
        if (i === 0 && transient) continue // re-send once over the same connection
        throw err
      }
    }
    throw lastErr
  }
  /** Wrap the inner nostr-tools signer's single request chokepoint so every op (getPublicKey, sign,
   *  nip04/44, SKD, connect) funnels through {@link call}. Called after (re)creating the signer. */
  private wrapSendRequest(): void {
    const s = this.signer as unknown as { sendRequest: (method: string, params: string[]) => Promise<string> } | null
    if (!s) return
    const orig = s.sendRequest.bind(s)
    s.sendRequest = (method: string, params: string[]) => this.call(method, () => orig(method, params))
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
