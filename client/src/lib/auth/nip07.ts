/**
 * NIP-07 Signer — Browser extension signer (nos2x, Alby, etc.)
 * Ported from Jumble's nip-07.signer.ts
 *
 * Delegates signing to the browser extension via window.nostr.
 * Only available in browser environments (not Tauri desktop).
 */

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>
      signEvent(event: Record<string, unknown>): Promise<Record<string, unknown>>
      nip04?: {
        encrypt(pubkey: string, plainText: string): Promise<string>
        decrypt(pubkey: string, cipherText: string): Promise<string>
      }
      nip44?: {
        encrypt(pubkey: string, plainText: string): Promise<string>
        decrypt(pubkey: string, cipherText: string): Promise<string>
      }
    }
  }
}

export class Nip07Signer {
  private signer: Window['nostr'] | undefined
  private pubkey: string | null = null

  /**
   * Poll for window.nostr up to 5 seconds (50 x 100ms).
   * Extensions inject the API asynchronously after page load.
   */
  async init(): Promise<void> {
    const checkInterval = 100
    const maxAttempts = 50

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (window.nostr) {
        this.signer = window.nostr
        return
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    throw new Error(
      'No Nostr signer extension found. Install one like Alby, nos2x, or nostr-keyx.'
    )
  }

  async getPublicKey(): Promise<string> {
    if (!this.signer) throw new Error('Call init() first')
    if (!this.pubkey) {
      this.pubkey = await this.signer.getPublicKey()
    }
    return this.pubkey
  }

  async signEvent(draftEvent: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.signer) throw new Error('Call init() first')
    return this.signer.signEvent(draftEvent)
  }

  async nip04Encrypt(pubkey: string, plainText: string): Promise<string> {
    if (!this.signer) throw new Error('Call init() first')
    // Read from window.nostr at call time — some extensions inject nip04 lazily
    const nostr = window.nostr
    const nip04 = nostr?.nip04 || (this.signer as any).nip04
    if (!nip04?.encrypt) {
      throw new Error('Your extension does not support NIP-04 encryption')
    }
    return nip04.encrypt(pubkey, plainText)
  }

  async nip04Decrypt(pubkey: string, cipherText: string): Promise<string> {
    if (!this.signer) throw new Error('Call init() first')
    const nostr = window.nostr
    const nip04 = nostr?.nip04 || (this.signer as any).nip04
    if (!nip04?.decrypt) {
      throw new Error('Your extension does not support NIP-04 decryption')
    }
    return nip04.decrypt(pubkey, cipherText)
  }

  /**
   * NIP-04 encrypt/decrypt object — exposes signer's nip04 capabilities
   * for use by the Blossom member file encryption system.
   * Always return wrapper if nip04 is available on either this.signer or window.nostr.
   */
  get nip04() {
    const hasNip04 = this.signer?.nip04 || window.nostr?.nip04
    if (!hasNip04) return undefined
    return {
      encrypt: (pubkey: string, plaintext: string) => this.nip04Encrypt(pubkey, plaintext),
      decrypt: (pubkey: string, ciphertext: string) => this.nip04Decrypt(pubkey, ciphertext),
    }
  }

  async nip44Encrypt(pubkey: string, plainText: string): Promise<string> {
    if (!this.signer) throw new Error('Call init() first')
    // Read from window.nostr at call time — some extensions inject nip44 lazily
    // after page load, so this.signer (captured during init) may not have it yet
    const nostr = window.nostr
    const nip44 = nostr?.nip44 || (this.signer as any).nip44
    if (!nip44?.encrypt) {
      throw new Error('Your extension does not support NIP-44 encryption')
    }
    return nip44.encrypt(pubkey, plainText)
  }

  async nip44Decrypt(pubkey: string, cipherText: string): Promise<string> {
    if (!this.signer) throw new Error('Call init() first')
    const nostr = window.nostr
    const nip44 = nostr?.nip44 || (this.signer as any).nip44
    if (!nip44?.decrypt) {
      throw new Error('Your extension does not support NIP-44 decryption')
    }
    return nip44.decrypt(pubkey, cipherText)
  }

  /**
   * NIP-44 encrypt/decrypt object — always return wrapper so DM capability
   * check passes. If the extension truly doesn't support NIP-44, the individual
   * encrypt/decrypt methods will throw a descriptive error at call time.
   * Some NIP-46 remote signers inject via window.nostr but don't expose
   * a synchronous nip44 property — they handle NIP-44 through the relay protocol.
   */
  get nip44() {
    return {
      encrypt: (pubkey: string, plaintext: string) => this.nip44Encrypt(pubkey, plaintext),
      decrypt: (pubkey: string, ciphertext: string) => this.nip44Decrypt(pubkey, ciphertext),
    }
  }

  close(): void {
    this.signer = undefined
    this.pubkey = null
  }
}

/**
 * Quick check if a NIP-07 extension is available (non-blocking).
 */
export function hasNip07Extension(): boolean {
  return !!window.nostr
}
