/**
 * Crypto barrel export — all cryptographic primitives for NIP-CHAT
 */

export { computeSharedSecret } from './ecdh'
export { deriveKey, deriveChannelKey } from './hkdf'
export { aesEncrypt, aesDecrypt } from './aes'
export {
  DOMAIN_SALT,
  KINDS,
  STANDARD_KINDS,
  NOSTR_DERIVATION_BASE,
  AES_IV_LENGTH,
  AES_TAG_LENGTH,
  AES_KEY_LENGTH,
} from './constants'
export {
  buildTree,
  createLeaf,
  addLeaf,
  removeLeaf,
  removeLeaves,
  serializeTree,
  deserializeTree,
  walkTreeToSecret,
  getMembers,
  toHex,
  fromHex,
} from './lkh'
export type {
  LkhLeaf,
  LkhNode,
  LkhRoot,
  LkhTree,
  LkhTreeNode,
} from './lkh'
