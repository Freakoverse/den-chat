/**
 * Key Generation — BIP-39 mnemonic + BIP-32 Nostr key derivation
 *
 * Generates 24-word BIP-39 mnemonics and derives Nostr keypairs at
 * multiple indices from the same seed: m/44'/1237'/<index>'/0/0
 */

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { HDKey } from '@scure/bip32'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { getPublicKey } from 'nostr-tools'

/**
 * Generate a new 24-word BIP-39 mnemonic.
 * @returns 24 space-separated words
 */
export function generateSeedPhrase(): string {
  return generateMnemonic(wordlist, 256) // 256 bits = 24 words
}

/**
 * Validate a BIP-39 mnemonic.
 */
export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, wordlist)
}

/**
 * Derive a Nostr keypair from a BIP-39 mnemonic at a given account index.
 *
 * Path: m/44'/1237'/<index>'/0/0
 * - 44' = BIP-44 purpose
 * - 1237' = Nostr coin type
 * - <index>' = account index (0 = primary, 1 = second, etc.)
 *
 * @param mnemonic - 24-word BIP-39 mnemonic
 * @param index - Account index (default 0)
 * @returns { privateKey, publicKey } as hex strings
 */
export function deriveNostrKeypair(
  mnemonic: string,
  index: number = 0
): { privateKey: string; publicKey: string } {
  const seed = mnemonicToSeedSync(mnemonic)
  const root = HDKey.fromMasterSeed(seed)
  const child = root.derive(`m/44'/1237'/${index}'/0/0`)

  if (!child.privateKey) {
    throw new Error('Failed to derive private key')
  }

  const privateKeyHex = bytesToHex(child.privateKey)
  const publicKeyHex = getPublicKey(hexToBytes(privateKeyHex))

  return { privateKey: privateKeyHex, publicKey: publicKeyHex }
}

/**
 * Derive the public key from a raw nsec/private key hex.
 */
export function pubkeyFromPrivkey(privateKeyHex: string): string {
  return getPublicKey(hexToBytes(privateKeyHex))
}
