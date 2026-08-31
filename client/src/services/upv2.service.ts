/**
 * NIP-UPV2 Client Service — Password login via relay-mediated challenge-response
 * Ported from Jumble's upv2.service.ts
 *
 * Protocol:
 * 1. Derive login keys from password + identifier using HKDF
 * 2. Send request_challenge (kind 24134) to signer's relay
 * 3. Receive challenge nonce
 * 4. Sign nonce with schnorr and send login event
 * 5. Receive session_created with session ID + expiry
 * 6. Use session to sign events, encrypt/decrypt via signer
 */

import { SimplePool, nip19 } from 'nostr-tools'
import { nip44 } from 'nostr-tools'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { schnorr } from '@noble/curves/secp256k1'
import { dnnService } from '@/lib/dnn/dnnService'
import { getRandomRelays } from '@/lib/nostr/relay-pool'

const UPV2_KIND = 24134

type UPV2Action =
  | 'request_challenge'
  | 'challenge'
  | 'login'
  | 'session_created'
  | 'sign_event'
  | 'signed_event'
  | 'nip04_encrypt'
  | 'nip04_decrypt'
  | 'nip44_encrypt'
  | 'nip44_decrypt'
  // NIP-SKD (§7 methods, used as the UPV2 action). `skd_sign_as_subkey` gets a 'signed_event'
  // response (like sign_event); the others echo their own action name with a { result } body.
  | 'skd_get_subkey_pubkey'
  | 'skd_sign_as_subkey'
  | 'skd_nip44_encrypt_as_subkey'
  | 'skd_nip44_decrypt_as_subkey'
  | 'error'

export interface UPV2Session {
  sessionId: string
  signerPubkey: string
  loginSk: string
  loginPk: string
  relays: string[]
  expiresAt: number
}

interface UPV2LoginResult {
  success: boolean
  error?: string
  session?: UPV2Session
}

class UPV2Service {
  private static instance: UPV2Service
  private pool: SimplePool
  private currentSession: UPV2Session | null = null
  // Whether the connected signer (DENOS) implements NIP-SKD over UPV2 — probed once at login.
  // Gates v2-hub capability so `canUseV2`/the create toggle stay accurate.
  private skdSupported = false

  constructor() {
    this.pool = new SimplePool()
  }

  static getInstance(): UPV2Service {
    if (!UPV2Service.instance) {
      UPV2Service.instance = new UPV2Service()
    }
    return UPV2Service.instance
  }

  private getInstanceId(): string {
    const STORAGE_KEY = 'upv2_instance_id'
    let instanceId = localStorage.getItem(STORAGE_KEY)
    if (!instanceId) {
      instanceId = crypto.randomUUID()
      localStorage.setItem(STORAGE_KEY, instanceId)
    }
    return instanceId
  }

  /**
   * Derive login keys from password and identifier
   */
  private deriveLoginKey(password: string, identifier: string): { sk: string; pk: string } {
    const salt = identifier + 'NIP-UPV2'
    const saltBytes = new TextEncoder().encode(salt)
    const passwordBytes = new TextEncoder().encode(password)

    const derivedKey = hkdf(sha256, passwordBytes, saltBytes, undefined, 32)
    const sk = bytesToHex(derivedKey)
    const pk = bytesToHex(schnorr.getPublicKey(derivedKey))

    return { sk, pk }
  }

  private signChallenge(nonce: string, sk: string): string {
    const messageBytes = new TextEncoder().encode(nonce)
    const messageHash = sha256(messageBytes)
    const signature = schnorr.sign(messageHash, hexToBytes(sk))
    return bytesToHex(signature)
  }

  private generateSessionId(): string {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return bytesToHex(bytes)
  }

  /**
   * Resolve identifier (DNN ID or npub) to pubkey + relays.
   * Uses the full DNN service with node discovery, failover, and health checks.
   */
  private async resolveIdentifier(identifier: string): Promise<{
    pubkey: string
    npub: string
    relays: string[]
  } | null> {
    // Fall back to 3 random relays from the user's active pool (Settings → Network)
    // rather than a separate hardcoded list.
    const DEFAULT_RELAYS = getRandomRelays(3)

    // Handle npub
    if (identifier.startsWith('npub')) {
      const { data } = nip19.decode(identifier)
      return {
        pubkey: data as string,
        npub: identifier,
        relays: DEFAULT_RELAYS,
      }
    }

    // Parse DNN ID — strip name prefix if present (e.g. name.n4.8 → n4.8)
    let dnnIdentifier = identifier

    // Block formats (n4.8 or b922664.8)
    if (/^n\d+\.\d+$/i.test(identifier) || /^b\d+\.\d+$/i.test(identifier)) {
      dnnIdentifier = identifier
    } else {
      // name.n4.8 or name.b922664.8
      const nameWithBlockMatch = identifier.match(/^.+\.(n\d+\.\d+|b\d+\.\d+)$/i)
      if (nameWithBlockMatch) {
        dnnIdentifier = nameWithBlockMatch[1]
      } else {
        // name.encoded format
        const fullDnnMatch = identifier.match(/^(.+)\.([a-z0-9]+)$/i)
        if (fullDnnMatch) {
          dnnIdentifier = fullDnnMatch[2]
        }
      }
    }

    const isDnnFormat = /^[a-zA-Z0-9]+$/.test(dnnIdentifier) || /^n\d+\.\d+$/i.test(dnnIdentifier) || /^b\d+\.\d+$/i.test(dnnIdentifier)

    if (isDnnFormat) {
      const resolution = await dnnService.resolve(dnnIdentifier)
      if (!resolution || !resolution.npub) return null

      // Extract relays from kind:63600 metadata and merge with defaults.
      // The user's signer listens on its registered relays, so include those
      // alongside the standard fallbacks for maximum reachability.
      const metadataRelays = (resolution.metadata?.relays ?? [])
        .filter((r): r is string => typeof r === 'string' && (r.startsWith('wss://') || r.startsWith('ws://')))
      const relays = [...new Set([...metadataRelays, ...DEFAULT_RELAYS])]

      const pubkey = resolution.npub.startsWith('npub')
        ? (nip19.decode(resolution.npub).data as string)
        : resolution.npub

      return { pubkey, npub: resolution.npub, relays }
    }

    return null
  }

  /**
   * Login with DNN ID/npub and password
   */
  async login(identifier: string, password: string, relays?: string[]): Promise<UPV2LoginResult> {
    console.log('[UPV2] Starting login for:', identifier)

    const resolved = await this.resolveIdentifier(identifier)
    if (!resolved) {
      return { success: false, error: 'Could not resolve identifier' }
    }

    const targetRelays = relays || resolved.relays
    const sessionId = this.generateSessionId()
    const { sk: loginSk, pk: loginPk } = this.deriveLoginKey(password, resolved.npub)

    try {
      // Step 1: Request challenge
      const challenge = await this.requestChallenge(targetRelays, loginPk, loginSk, resolved.pubkey, sessionId)
      if (!challenge) {
        return { success: false, error: 'Failed to get challenge from signer' }
      }

      // Step 2: Sign challenge and login
      const signature = this.signChallenge(challenge.nonce, loginSk)
      const session = await this.performLogin(targetRelays, loginPk, loginSk, resolved.pubkey, sessionId, challenge.nonce, signature)

      if (!session) {
        return { success: false, error: 'Login failed — invalid credentials' }
      }

      this.currentSession = {
        sessionId: session.sessionId,
        signerPubkey: resolved.pubkey,
        loginSk,
        loginPk,
        relays: targetRelays,
        expiresAt: session.expiresAt,
      }

      this.skdSupported = await this.probeSkd()
      return { success: true, session: this.currentSession }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  private async requestChallenge(
    relays: string[], loginPk: string, loginSk: string, signerPubkey: string, sessionId: string,
  ): Promise<{ nonce: string; expiresAt: number } | null> {
    await Promise.all(relays.map((url) => this.pool.ensureRelay(url).catch(() => null)))
    await new Promise((r) => setTimeout(r, 500))

    const requestTime = Math.floor(Date.now() / 1000)

    await this.sendUPV2Event(relays, loginPk, loginSk, signerPubkey, 'request_challenge', sessionId, {
      client: 'den-chat',
      instance_id: this.getInstanceId(),
    })

    const response = await this.pollForResponse(relays, loginPk, loginSk, 'challenge', 15000, sessionId, requestTime)
    if (response) {
      return { nonce: response.challenge, expiresAt: response.expires_at }
    }
    return null
  }

  private async performLogin(
    relays: string[], loginPk: string, loginSk: string, signerPubkey: string,
    sessionId: string, nonce: string, signature: string,
  ): Promise<{ sessionId: string; expiresAt: number } | null> {
    const requestTime = Math.floor(Date.now() / 1000)

    await this.sendUPV2Event(relays, loginPk, loginSk, signerPubkey, 'login', sessionId, {
      challenge_signature: signature,
      nonce,
      client: 'den-chat',
      instance_id: this.getInstanceId(),
    })

    const response = await this.pollForResponse(relays, loginPk, loginSk, 'session_created', 15000, sessionId, requestTime)
    if (response) {
      return { sessionId: response.session_id, expiresAt: response.expires_at }
    }
    return null
  }

  /**
   * Wait for a signer response using relay subscriptions (push-based).
   *
   * Uses pool.subscribeMany for near-instant event delivery instead of polling.
   * Also performs an initial querySync to catch events that arrived before
   * the subscription was established (race condition prevention).
   * A 2-second safety-net re-query handles unreliable relays that drop subscriptions.
   */
  /* eslint-disable @typescript-eslint/no-explicit-any */
  private async pollForResponse(
    relays: string[], loginPk: string, loginSk: string,
    expectedAction: UPV2Action, timeoutMs: number,
    sessionId?: string, requestTime?: number, nonce?: string,
  ): Promise<any> {
    const minTime = (requestTime || Math.floor(Date.now() / 1000)) - 15
    const startTime = Math.floor(Date.now() / 1000) - 30
    const processedIds = new Set<string>()

    const filter: any = {
      kinds: [UPV2_KIND, 24133],
      '#p': [loginPk],
      since: startTime,
    }

    return new Promise<any>((resolve) => {
      let settled = false
      let sub: { close: () => void } | null = null
      let safetyInterval: ReturnType<typeof setInterval> | null = null

      const cleanup = () => {
        if (settled) return
        settled = true
        sub?.close()
        if (safetyInterval) clearInterval(safetyInterval)
      }

      const finish = (result: any) => {
        if (settled) return
        cleanup()
        resolve(result)
      }

      // Timeout — resolve null if no response in time
      setTimeout(() => finish(null), timeoutMs)

      /**
       * Try to match a single event against expected action/session/nonce.
       * Returns the parsed payload if matched, undefined if not.
       */
      const tryMatchEvent = (event: any): any => {
        if (processedIds.has(event.id)) return undefined
        processedIds.add(event.id)

        try {
          if ((event.created_at || 0) < minTime) return undefined

          const conversationKey = nip44.v2.utils.getConversationKey(
            hexToBytes(loginSk),
            event.pubkey,
          )
          const decrypted = nip44.v2.decrypt(event.content, conversationKey)
          const payload = JSON.parse(decrypted)

          if (event.kind === UPV2_KIND) {
            const actionTag = event.tags.find((t: string[]) => t[0] === 'a')
            const eventSessionTag = event.tags.find((t: string[]) => t[0] === 's')
            const eventNonceTag = event.tags.find((t: string[]) => t[0] === 'n')

            if (sessionId && (!eventSessionTag?.[1] || eventSessionTag[1] !== sessionId)) return undefined
            if (nonce && (!eventNonceTag?.[1] || eventNonceTag[1] !== nonce)) return undefined

            if (actionTag?.[1] === expectedAction) return payload
            if (actionTag?.[1] === 'error') return null // explicit null = error
          } else if (event.kind === 24133) {
            if (expectedAction === 'signed_event' && payload.result) {
              const signedEvent = typeof payload.result === 'string' ? JSON.parse(payload.result) : payload.result
              return { event: signedEvent }
            } else if (payload.error) {
              return null
            }
          }
        } catch { /* skip malformed */ }
        return undefined
      }

      // 1. Set up push-based subscription for real-time events
      try {
        sub = this.pool.subscribeMany(relays, filter, {
          onevent: (event: any) => {
            if (settled) return
            const result = tryMatchEvent(event)
            if (result !== undefined) finish(result)
          },
        })
      } catch {
        // Subscription setup failed — fall through to safety-net polling
      }

      // 2. Initial querySync to catch events that arrived before subscription
      this.pool.querySync(relays, filter).then((events) => {
        if (settled) return
        for (const event of events) {
          const result = tryMatchEvent(event)
          if (result !== undefined) { finish(result); return }
        }
      }).catch(() => { /* ignore query errors */ })

      // 3. Safety-net re-query every 2s for relays that don't push reliably
      safetyInterval = setInterval(async () => {
        if (settled) return
        try {
          const events = await this.pool.querySync(relays, filter)
          for (const event of events) {
            const result = tryMatchEvent(event)
            if (result !== undefined) { finish(result); return }
          }
        } catch { /* ignore */ }
      }, 2000)
    })
  }

  private async sendUPV2Event(
    relays: string[], loginPk: string, loginSk: string,
    signerPubkey: string, action: UPV2Action, sessionId: string, payload: any,
  ): Promise<void> {
    const payloadJson = JSON.stringify(payload)
    const conversationKey = nip44.v2.utils.getConversationKey(
      hexToBytes(loginSk),
      signerPubkey,
    )
    const encryptedContent = nip44.v2.encrypt(payloadJson, conversationKey)

    const eventTemplate = {
      pubkey: loginPk,
      created_at: Math.floor(Date.now() / 1000),
      kind: UPV2_KIND,
      tags: [
        ['a', action],
        ['s', sessionId],
        ['p', signerPubkey],
      ],
      content: encryptedContent,
    }

    const id = this.getEventId(eventTemplate)
    const sig = bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(loginSk)))

    const signedEvent = { ...eventTemplate, id, sig }

    await Promise.all(
      relays.map(async (url) => {
        try {
          const relay = await this.pool.ensureRelay(url)
          await relay.publish(signedEvent as any)
        } catch { /* skip failed relay */ }
      }),
    )
  }

  private getEventId(event: any): string {
    const serialized = JSON.stringify([
      0, event.pubkey, event.created_at, event.kind, event.tags, event.content,
    ])
    const hash = sha256(new TextEncoder().encode(serialized))
    return bytesToHex(hash)
  }

  // ─── ISigner-like methods ───

  async getPublicKey(): Promise<string> {
    if (!this.currentSession) throw new Error('Not logged in via UPV2')
    return this.currentSession.signerPubkey
  }

  async signEvent(draftEvent: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.currentSession) throw new Error('Not logged in via UPV2')

    const nonceBytes = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
    const signature = this.signChallenge(nonceBytes, this.currentSession.loginSk)
    const requestTime = Math.floor(Date.now() / 1000)

    await this.sendUPV2Event(
      this.currentSession.relays, this.currentSession.loginPk, this.currentSession.loginSk,
      this.currentSession.signerPubkey, 'sign_event', this.currentSession.sessionId,
      { challenge_signature: signature, nonce: nonceBytes, event: draftEvent },
    )

    const response = await this.pollForResponse(
      this.currentSession.relays, this.currentSession.loginPk, this.currentSession.loginSk,
      'signed_event', 30000, this.currentSession.sessionId, requestTime, nonceBytes,
    )

    if (response?.event) return response.event
    throw new Error('Failed to get signed event from signer')
  }

  async nip04Encrypt(pubkey: string, plainText: string): Promise<string> {
    return this.requestEncryptDecrypt('nip04_encrypt', pubkey, plainText)
  }

  async nip04Decrypt(pubkey: string, cipherText: string): Promise<string> {
    return this.requestEncryptDecrypt('nip04_decrypt', pubkey, cipherText)
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
    return this.requestEncryptDecrypt('nip44_encrypt', pubkey, plainText)
  }

  async nip44Decrypt(pubkey: string, cipherText: string): Promise<string> {
    return this.requestEncryptDecrypt('nip44_decrypt', pubkey, cipherText)
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

  // ── NIP-SKD (§7 methods over UPV2) — derive + act as v2-hub pseudonyms via DENOS ──
  // UPV2 is bespoke, so (unlike NIP-46/PC55's positional array) the params are a JSON OBJECT:
  // { context, peerPub?, nonce, + event | (recipientPub, plaintext) | (senderPub, ciphertext) }.
  // Matches DENOS's handle_skd (upv2.rs): session-authenticated (no challenge_signature), the
  // sign op replies with a 'signed_event' { event } and the rest echo their own action + { result }.

  async skdGetSubkeyPubkey(context: string, peerPub?: string): Promise<string> {
    const s = this.currentSession
    if (!s) throw new Error('Not logged in via UPV2')
    const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
    const requestTime = Math.floor(Date.now() / 1000)
    await this.sendUPV2Event(s.relays, s.loginPk, s.loginSk, s.signerPubkey, 'skd_get_subkey_pubkey', s.sessionId,
      { context, ...(peerPub ? { peerPub } : {}), nonce })
    const response = await this.pollForResponse(s.relays, s.loginPk, s.loginSk, 'skd_get_subkey_pubkey', 30000, s.sessionId, requestTime, nonce)
    if (response?.result) return response.result as string
    throw new Error('skd_get_subkey_pubkey failed: no result from signer')
  }
  async skdSignAsSubkey(context: string, event: unknown, peerPub?: string): Promise<Record<string, unknown>> {
    const s = this.currentSession
    if (!s) throw new Error('Not logged in via UPV2')
    const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
    const requestTime = Math.floor(Date.now() / 1000)
    await this.sendUPV2Event(s.relays, s.loginPk, s.loginSk, s.signerPubkey, 'skd_sign_as_subkey', s.sessionId,
      { context, ...(peerPub ? { peerPub } : {}), nonce, event })
    const response = await this.pollForResponse(s.relays, s.loginPk, s.loginSk, 'signed_event', 30000, s.sessionId, requestTime, nonce)
    if (response?.event) return response.event as Record<string, unknown>
    throw new Error('skd_sign_as_subkey failed: no signed event from signer')
  }
  async skdNip44EncryptAsSubkey(context: string, recipientPub: string, plaintext: string, peerPub?: string): Promise<string> {
    const s = this.currentSession
    if (!s) throw new Error('Not logged in via UPV2')
    const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
    const requestTime = Math.floor(Date.now() / 1000)
    await this.sendUPV2Event(s.relays, s.loginPk, s.loginSk, s.signerPubkey, 'skd_nip44_encrypt_as_subkey', s.sessionId,
      { context, ...(peerPub ? { peerPub } : {}), nonce, recipientPub, plaintext })
    const response = await this.pollForResponse(s.relays, s.loginPk, s.loginSk, 'skd_nip44_encrypt_as_subkey', 30000, s.sessionId, requestTime, nonce)
    if (response?.result) return response.result as string
    throw new Error('skd_nip44_encrypt_as_subkey failed: no result from signer')
  }
  async skdNip44DecryptAsSubkey(context: string, senderPub: string, ciphertext: string, peerPub?: string): Promise<string> {
    const s = this.currentSession
    if (!s) throw new Error('Not logged in via UPV2')
    const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
    const requestTime = Math.floor(Date.now() / 1000)
    await this.sendUPV2Event(s.relays, s.loginPk, s.loginSk, s.signerPubkey, 'skd_nip44_decrypt_as_subkey', s.sessionId,
      { context, ...(peerPub ? { peerPub } : {}), nonce, senderPub, ciphertext })
    const response = await this.pollForResponse(s.relays, s.loginPk, s.loginSk, 'skd_nip44_decrypt_as_subkey', 30000, s.sessionId, requestTime, nonce)
    if (response?.result) return response.result as string
    throw new Error('skd_nip44_decrypt_as_subkey failed: no result from signer')
  }

  /** One-shot capability probe (§7), capped so a non-SKD signer doesn't slow login. */
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

  private async requestEncryptDecrypt(
    action: 'nip04_encrypt' | 'nip04_decrypt' | 'nip44_encrypt' | 'nip44_decrypt',
    pubkey: string, content: string,
  ): Promise<string> {
    const session = this.currentSession!
    const nonceVal = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
    const isEncrypt = action.endsWith('_encrypt')
    const contentKey = isEncrypt ? 'plaintext' : 'ciphertext'
    const requestTime = Math.floor(Date.now() / 1000)

    await this.sendUPV2Event(
      session.relays, session.loginPk, session.loginSk,
      session.signerPubkey, action, session.sessionId,
      { pubkey, [contentKey]: content, nonce: nonceVal },
    )

    const response = await this.pollForResponse(
      session.relays, session.loginPk, session.loginSk,
      action, 30000, session.sessionId, requestTime, nonceVal,
    )

    if (response?.result) return response.result
    throw new Error(`${action} failed: no result from signer`)
  }

  isLoggedIn(): boolean {
    return this.currentSession !== null && this.currentSession.expiresAt > Date.now()
  }

  getSession(): UPV2Session | null {
    return this.currentSession
  }

  logout(): void {
    this.currentSession = null
  }
}

const upv2Service = UPV2Service.getInstance()
export default upv2Service
export { UPV2Service }
