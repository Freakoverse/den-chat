/**
 * NIP-PC55 — Local desktop signer (ported from Jumble's PC55Signer)
 *
 * Communicates with a signer application (e.g., DENOS) running on
 * ws://localhost:7777 using the NIP-46 protocol over a local WebSocket.
 *
 * Protocol flow:
 * 1. discover() — probe for signer info (name, version, accounts)
 * 2. init() — connect WebSocket + send 'connect' handshake
 * 3. getPublicKey() / signEvent() — actual signing requests
 */

import { generateSecretKey, getPublicKey } from 'nostr-tools'

const PC55_URL = 'ws://localhost:7777'
const REQUEST_TIMEOUT = 60_000 // 60s — user may need to approve in signer UI

interface PC55Response {
  id?: string
  result?: string
  error?: string
}

export interface DiscoverResult {
  name: string
  version: string
  accounts: { npub: string; display_name: string }[]
}

/**
 * Probe for a local signer. Returns discovery info or null if none found.
 * This is called on app startup to detect if DENOS or another signer is running.
 */
export function discover(): Promise<DiscoverResult | null> {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(PC55_URL)
      const timeout = setTimeout(() => {
        ws.close()
        resolve(null)
      }, 2000)

      ws.onopen = () => {
        const msg = JSON.stringify({ method: 'discover', params: [] })
        ws.send(msg)
      }

      ws.onmessage = (event) => {
        clearTimeout(timeout)
        try {
          const data = JSON.parse(event.data)
          // The discover response has result wrapped in the PC55 response format
          const result = typeof data.result === 'string' ? JSON.parse(data.result) : data.result
          ws.close()
          resolve(result as DiscoverResult)
        } catch {
          ws.close()
          resolve(null)
        }
      }

      ws.onerror = () => {
        clearTimeout(timeout)
        resolve(null)
      }
    } catch {
      resolve(null)
    }
  })
}

/**
 * PC55Signer — manages the WebSocket connection to the local signer.
 */
export class PC55Signer {
  private ws: WebSocket | null = null
  private pendingRequests = new Map<string, {
    resolve: (value: string) => void
    reject: (reason: Error) => void
  }>()
  private connected = false
  private clientSecretKey: Uint8Array
  private clientPublicKey: string

  constructor() {
    this.clientSecretKey = generateSecretKey()
    this.clientPublicKey = getPublicKey(this.clientSecretKey)
  }

  /**
   * Connect to the signer WebSocket and send a 'connect' handshake.
   * Must be called before any other method.
   */
  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(PC55_URL)

        const timeout = setTimeout(() => {
          this.ws?.close()
          reject(new Error('Connection to local signer timed out'))
        }, 5000)

        this.ws.onopen = async () => {
          clearTimeout(timeout)
          this.connected = true

          // Set up message handler
          this.ws!.onmessage = (event) => this.handleMessage(event.data)
          this.ws!.onclose = () => { this.connected = false }
          this.ws!.onerror = () => { this.connected = false }

          // Send connect handshake with client name + client pubkey
          try {
            await this.sendRequest('connect', ['DEN Chat', this.clientPublicKey])
            resolve()
          } catch (err) {
            reject(err)
          }
        }

        this.ws.onerror = () => {
          clearTimeout(timeout)
          reject(new Error('Could not connect to local signer at ' + PC55_URL))
        }
      } catch (err) {
        reject(err)
      }
    })
  }

  /**
   * Get the signer's public key (the user's Nostr pubkey).
   */
  async getPublicKey(): Promise<string> {
    return this.sendRequest('get_public_key', [])
  }

  /**
   * Sign a Nostr event via the local signer.
   * Returns the signed event JSON as a string.
   */
  async signEvent(draftEvent: Record<string, unknown>): Promise<Record<string, unknown>> {
    const eventJson = JSON.stringify(draftEvent)
    const resultJson = await this.sendRequest('sign_event', [eventJson])
    return JSON.parse(resultJson)
  }

  /**
   * NIP-04 encrypt via the signer.
   */
  async nip04Encrypt(pubkey: string, plainText: string): Promise<string> {
    return this.sendRequest('nip04_encrypt', [pubkey, plainText])
  }

  /**
   * NIP-04 decrypt via the signer.
   */
  async nip04Decrypt(pubkey: string, cipherText: string): Promise<string> {
    return this.sendRequest('nip04_decrypt', [pubkey, cipherText])
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

  /**
   * NIP-44 encrypt via the signer.
   */
  async nip44Encrypt(pubkey: string, plainText: string): Promise<string> {
    return this.sendRequest('nip44_encrypt', [pubkey, plainText])
  }

  /**
   * NIP-44 decrypt via the signer.
   */
  async nip44Decrypt(pubkey: string, cipherText: string): Promise<string> {
    return this.sendRequest('nip44_decrypt', [pubkey, cipherText])
  }

  /**
   * NIP-44 encrypt/decrypt object for ISigner interface.
   */
  get nip44() {
    return {
      encrypt: (pubkey: string, plaintext: string) => this.nip44Encrypt(pubkey, plaintext),
      decrypt: (pubkey: string, ciphertext: string) => this.nip44Decrypt(pubkey, ciphertext),
    }
  }

  /**
   * Close the WebSocket connection.
   */
  close(): void {
    this.ws?.close()
    this.ws = null
    this.connected = false
  }

  // --- Internal ---

  private sendRequest(method: string, params: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) {
        reject(new Error('Not connected to local signer'))
        return
      }

      const id = crypto.randomUUID()
      const msg = JSON.stringify({ id, method, params })

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request ${method} timed out`))
      }, REQUEST_TIMEOUT)

      this.pendingRequests.set(id, {
        resolve: (value: string) => {
          clearTimeout(timeout)
          resolve(value)
        },
        reject: (reason: Error) => {
          clearTimeout(timeout)
          reject(reason)
        }
      })

      this.ws.send(msg)
    })
  }

  private handleMessage(data: string): void {
    try {
      const response: PC55Response = JSON.parse(data)
      if (!response.id) return

      const pending = this.pendingRequests.get(response.id)
      if (!pending) return
      this.pendingRequests.delete(response.id)

      if (response.error) {
        pending.reject(new Error(response.error))
      } else if (response.result !== undefined) {
        pending.resolve(response.result)
      } else {
        pending.reject(new Error('Empty response from signer'))
      }
    } catch {
      // Ignore malformed messages
    }
  }
}
