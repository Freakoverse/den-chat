/**
 * Auth barrel export
 */

export { generateSeedPhrase, isValidMnemonic, deriveNostrKeypair, pubkeyFromPrivkey } from './keygen'
export {
  // New secure account management
  listAccounts, listSeeds,
  generateAccount, generateNewSeed, deriveNextAccount,
  importSeed, importNsec,
  verifyPin, loginAccount,
  deleteAccount, exportSeed, exportNsec,
  renameAccount, changePin, getActiveAccount,
  // Legacy no-ops (backward compat)
  secureStore, secureRetrieve, secureDelete,
  // Types
  type StoredAccount, type StoredSeed,
} from './secure-storage'
export { discover, PC55Signer, type DiscoverResult } from './pc55'
export { BunkerSigner } from './bunker'
export { NostrConnectSigner, generateNostrConnectDetails } from './nostr-connect'
export { Nip07Signer, hasNip07Extension } from './nip07'
export {
  guardedDecrypt, guardedEncrypt,
  resetSignerGuard, isSignerCircuitOpen,
  SignerCircuitOpenError, SignerCachedFailureError,
} from './signerGuard'
