/**
 * LKH Member File Manager — Creates and manages Blossom LKH tree files
 *
 * Per NIP-CHAT spec §5.2 (LKH Tree File Format):
 * - Builds balanced binary trees with NIP-04 encrypted leaves
 * - Internal nodes use AES-256-GCM
 * - Root node holds AES-encrypted hub secret
 *
 * Supports all signer types:
 * - Local key (nsec/seed): nostr-tools nip04.encrypt/decrypt
 * - NIP-07 (browser ext): signer.nip04.encrypt/decrypt
 * - NIP-46 (Nostr Connect): signer.nip04.encrypt/decrypt
 * - NIP-PC55 (DENOS): signer.nip04Encrypt/nip04Decrypt
 * - NIP-UPV2: signer.nip04.encrypt/decrypt
 */

import { nip04 } from 'nostr-tools'
import { aesEncrypt } from '@/lib/crypto/aes'
import { encryptNip04, decryptNip04 } from '@/lib/nostr/nip04dm'
import {
  buildTree,
  createLeaf,
  serializeTree,
  deserializeTree,
  walkTreeToSecret,
  toHex,
  fromHex,
  type LkhLeaf,
  type LkhTree,
  // Paginated LKH
  PAGE_SIZE,
  buildLeafPage,
  buildSpine,
  serializeLeafPage,
  deserializeLeafPage,
  serializeSpine,
  walkPageToPageRoot,
  walkSpineToSecret,
  recoverPageRootKeys,
  splitPage,
  type LeafPage,
  type SpineTree,
} from '@/lib/crypto/lkh'
import { computeHash, uploadToBlossomServers } from './client'
import type { ISigner } from '@/stores/userStore'
import { makeSubkeySigner, type SubkeySigner } from '@/lib/nostr/v2send'
import { ChatContext } from '@/lib/crypto/skd'
import { encryptRoster, decryptRoster } from '@/lib/hub/hubContent'

/** Resolves the hub secret for a given epoch (from the owner/member's epoch history). */
export type EpochSecretResolver = (epoch: number) => Uint8Array | undefined
import { guardedDecrypt } from '@/lib/auth/signerGuard'

// ─── Types ───

export interface IndexFile {
  // Monolithic — used by facilitator/mesh list indexes
  treeHash: string

  // Paginated — used by hub creator indexes
  // When pageSize > 0, this is a paginated index; when 0, it's monolithic
  pageSize: number
  spineHash: string
  leafPages: Array<{ pageIndex: number; firstPubkey: string; hash: string }>

  // Common to both formats. Ban pages carry an optional `epoch` stamp (the epoch their secret encrypts
  // them at), serialized as `bans:<i>:<hash>@<epoch>`; legacy pages have no `@epoch` → epoch undefined.
  banPages: Array<{ page: number; hash: string; epoch?: number }>
  groupTrees: Array<{ groupId: string; hash: string }>
  historyHash: string
}

// ─── NIP-04 Helpers ───

/**
 * NIP-04 encrypt: works with any signer type or raw private key.
 * Routes through SignerGuard for backoff/circuit-breaker protection.
 */
export async function nip04Encrypt(
  targetPubkey: string,
  plaintext: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<string> {
  return encryptNip04(plaintext, targetPubkey, signer, privateKey)
}

/**
 * NIP-04 decrypt: works with any signer type or raw private key.
 * Routes through SignerGuard for backoff/circuit-breaker protection.
 */
async function nip04Decrypt(
  senderPubkey: string,
  ciphertext: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<string> {
  return decryptNip04(ciphertext, senderPubkey, signer, privateKey)
}

// ─── Index File ───

/**
 * Create a monolithic index file (for facilitator/mesh list indexes).
 * Uses `tree:<hash>` format for the single LKH tree file.
 */
export function createIndexFile(
  treeHash: string,
  banPageHashes: string[] = [],
  historyHash?: string,
  groupTrees?: Array<{ groupId: string; hash: string }>,
): string {
  const lines: string[] = []

  lines.push(`tree:${treeHash}`)

  for (let i = 0; i < banPageHashes.length; i++) {
    lines.push(`bans:${i}:${banPageHashes[i]}`)
  }

  if (groupTrees) {
    for (const gt of groupTrees) {
      lines.push(`group:${gt.groupId}:${gt.hash}`)
    }
  }

  if (historyHash) {
    lines.push(`history:${historyHash}`)
  }

  return lines.join('\n')
}

/**
 * Create a paginated index file (for hub creator indexes).
 * Uses `meta:page_size=...`, `spine:<hash>`, and `leaf-page:...` format.
 */
export function createPaginatedIndexFile(
  spineHash: string,
  leafPages: Array<{ pageIndex: number; firstPubkey: string; hash: string }>,
  banPageHashes: string[] = [],
  historyHash?: string,
  groupTrees?: Array<{ groupId: string; hash: string }>,
): string {
  const lines: string[] = []

  lines.push(`meta:page_size=10000`)
  lines.push(`spine:${spineHash}`)

  // Leaf pages sorted by pageIndex
  const sorted = [...leafPages].sort((a, b) => a.pageIndex - b.pageIndex)
  for (const lp of sorted) {
    lines.push(`leaf-page:${lp.pageIndex}:${lp.firstPubkey}:${lp.hash}`)
  }

  for (let i = 0; i < banPageHashes.length; i++) {
    lines.push(`bans:${i}:${banPageHashes[i]}`)
  }

  if (groupTrees) {
    for (const gt of groupTrees) {
      lines.push(`group:${gt.groupId}:${gt.hash}`)
    }
  }

  if (historyHash) {
    lines.push(`history:${historyHash}`)
  }

  return lines.join('\n')
}

/**
 * Parse an index file string into structured data.
 * Auto-detects format: presence of `meta:` = paginated, `tree:` = monolithic.
 * Both formats populate the same IndexFile type.
 */
export function parseIndexFile(content: string): IndexFile {
  let treeHash = ''
  let pageSize = 0
  let spineHash = ''
  const leafPages: Array<{ pageIndex: number; firstPubkey: string; hash: string }> = []
  const banPages: Array<{ page: number; hash: string; epoch?: number }> = []
  const groupTrees: Array<{ groupId: string; hash: string }> = []
  let historyHash = ''

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith('meta:')) {
      // Parse meta key=value pairs
      const kv = trimmed.slice(5)
      if (kv.startsWith('page_size=')) {
        pageSize = parseInt(kv.slice(10), 10)
      }
    } else if (trimmed.startsWith('spine:')) {
      spineHash = trimmed.slice(6)
    } else if (trimmed.startsWith('leaf-page:')) {
      const parts = trimmed.slice(10).split(':')
      if (parts.length >= 3) {
        leafPages.push({
          pageIndex: parseInt(parts[0], 10),
          firstPubkey: parts[1],
          hash: parts[2],
        })
      }
    } else if (trimmed.startsWith('tree:')) {
      treeHash = trimmed.slice(5)
    } else if (trimmed.startsWith('bans:')) {
      const parts = trimmed.split(':')
      // parts[2] is `<hash>` or `<hash>@<epoch>` (the epoch stamp lives outside the ciphertext so the
      // reader knows which epoch key to derive before decrypting).
      const [hash, epochStr] = (parts[2] ?? '').split('@')
      banPages.push({ page: parseInt(parts[1], 10), hash, epoch: epochStr != null ? parseInt(epochStr, 10) : undefined })
    } else if (trimmed.startsWith('group:')) {
      const parts = trimmed.split(':')
      groupTrees.push({ groupId: parts[1], hash: parts[2] })
    } else if (trimmed.startsWith('history:')) {
      historyHash = trimmed.slice(8)
    }
  }

  // Sort leafPages by pageIndex for binary search
  leafPages.sort((a, b) => a.pageIndex - b.pageIndex)

  return { treeHash, pageSize, spineHash, leafPages, banPages, groupTrees, historyHash }
}

/**
 * Serialize a parsed ban-page entry back into an index token (`<hash>` or `<hash>@<epoch>`). Use this
 * — NOT bare `bp.hash` — whenever PRESERVING existing ban pages into a rebuilt index, so the epoch stamp
 * survives the round-trip. Dropping the stamp would make an epoch-bound page undecryptable.
 */
export function banPageToken(bp: { hash: string; epoch?: number }): string {
  return bp.epoch != null ? `${bp.hash}@${bp.epoch}` : bp.hash
}

/**
 * Find which leaf page contains a given pubkey using binary search.
 * Leaf pages are sorted by firstPubkey (hex pubkeys sort lexicographically).
 *
 * @param index - Parsed paginated index file
 * @param pubkey - Hex pubkey to find
 * @returns The page entry containing this pubkey, or null if not found
 */
export function findPageForPubkey(
  index: IndexFile,
  pubkey: string,
): { pageIndex: number; firstPubkey: string; hash: string } | null {
  const pages = index.leafPages
  if (pages.length === 0) return null

  // Binary search: find the last page whose firstPubkey <= pubkey
  let lo = 0
  let hi = pages.length - 1
  let result = 0

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (pages[mid].firstPubkey <= pubkey) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  return pages[result]
}

// ─── Creator-side: Build LKH tree for a new hub ───

/**
 * Create and upload the initial paginated LKH tree for a new hub (creator as sole member).
 *
 * Produces: 1 leaf page + 1 spine + 1 history + 1 index = 4 files uploaded.
 *
 * @param creatorPubkey - Creator's hex public key
 * @param hubDTag - Hub's d tag (UUID)
 * @param hubSecret - 32-byte hub secret as Uint8Array
 * @param privateKey - Creator's private key hex (null if using signer)
 * @param signer - ISigner with NIP-04 support (null if using private key)
 * @param blossomServerUrls - Blossom servers to upload to
 * @returns Index file hash and blossom servers
 */
export async function createAndUploadMemberFiles(
  creatorPubkey: string,
  hubDTag: string,
  hubSecret: Uint8Array,
  privateKey: string | null,
  signer: ISigner | null,
  blossomServerUrls: string[],
  onFileProgress?: (info: { fileIndex: number; totalFiles: number; label: string }) => void,
): Promise<{ indexHash: string; blossomServers: string[] }> {
  const totalFiles = 4

  // 1. Create a single leaf for the creator
  const creatorLeaf = createLeaf(creatorPubkey, 'everyone')

  // 2. NIP-04 encrypt the leaf key for the creator
  const leafKeyHex = toHex(creatorLeaf.rawKey!)
  creatorLeaf.encryptedLeafKey = await nip04Encrypt(
    creatorPubkey,
    leafKeyHex,
    signer,
    privateKey,
  )

  // 3. Build a single leaf page (1 leaf → page-root above it)
  const page = await buildLeafPage([creatorLeaf], 0)

  // 4. Serialize and upload leaf page
  onFileProgress?.({ fileIndex: 0, totalFiles, label: 'Leaf page' })
  const pageContent = serializeLeafPage(page)
  const pageBytes = new TextEncoder().encode(pageContent)
  const { hash: pageHash } = await uploadToBlossomServers(
    pageBytes, signer, privateKey, blossomServerUrls, 'text/plain',
  )

  // 5. Build spine (1 page root → spine root with encHubSecret)
  const spine = await buildSpine(
    [{ nodeId: page.pageRoot.nodeId, rawKey: page.pageRoot.rawKey! }],
    hubSecret,
  )

  // 6. Serialize and upload spine
  onFileProgress?.({ fileIndex: 1, totalFiles, label: 'Spine tree' })
  const spineContent = serializeSpine(spine)
  const spineBytes = new TextEncoder().encode(spineContent)
  const { hash: spineHash } = await uploadToBlossomServers(
    spineBytes, signer, privateKey, blossomServerUrls, 'text/plain',
  )

  // 7. Create epoch history file
  onFileProgress?.({ fileIndex: 2, totalFiles, label: 'Epoch history' })
  const hubSecretHex = toHex(hubSecret)
  const historyPlaintext = `hub:1:${hubSecretHex}`
  const historyBlob = await aesEncrypt(hubSecret, historyPlaintext)
  const historyBytes = new TextEncoder().encode(historyBlob)
  const { hash: historyHash } = await uploadToBlossomServers(
    historyBytes, signer, privateKey, blossomServerUrls, 'text/plain',
  )

  // 8. Create and upload paginated index file
  onFileProgress?.({ fileIndex: 3, totalFiles, label: 'Index file' })
  const indexContent = createPaginatedIndexFile(
    spineHash,
    [{ pageIndex: 0, firstPubkey: creatorPubkey, hash: pageHash }],
    [],
    historyHash,
  )
  const indexBytes = new TextEncoder().encode(indexContent)
  const { hash: indexHash } = await uploadToBlossomServers(
    indexBytes, signer, privateKey, blossomServerUrls, 'text/plain',
  )

  console.log(`Paginated LKH tree built with 1 leaf. Page: ${pageHash}, Spine: ${spineHash}, Index: ${indexHash}`)

  return { indexHash, blossomServers: blossomServerUrls }
}

/**
 * v2 variant — create the initial paginated LKH tree for a new **v2** hub.
 *
 * The creator's leaf is keyed on their **pseudonym `P`** (not `R`); the leaf key is
 * wrapped by the **owner pseudonym `O`** to the creator's real key `R` (member unwraps with
 * their root key + `O` as counterparty); and the page carries a group-encrypted, epoch-stamped
 * **roster segment** (`{ P: R }` under `HKDF(hubSecret, "roster")`) for the roster. The page
 * stays plaintext (bootstrap unchanged, NIP-CHAT §0.2/§5.2.1). Requires a **local key or an SKD
 * signer with sub-key nip44** (owner-side
 * leaf-key wrapping) — see NIP-CHAT §0.5.
 *
 * @param creatorRPub - the creator's real public key `R`
 * @returns index hash + the derived `ownerPub` (`O`) and `memberP` (`P`) for the hub event/coordinate
 */
export async function createAndUploadMemberFilesV2(
  creatorRPub: string,
  hubDTag: string,
  hubSecret: Uint8Array,
  privateKey: string | null,
  signer: ISigner | null,
  blossomServerUrls: string[],
  onFileProgress?: (info: { fileIndex: number; totalFiles: number; label: string }) => void,
): Promise<{ indexHash: string; blossomServers: string[]; ownerPub: string; memberP: string }> {
  const totalFiles = 4

  // Derive the owner pseudonym O (self) and the creator's member pseudonym P (ECDH with O).
  const ownerSigner = makeSubkeySigner(ChatContext.owner(hubDTag), { privateKey, signer })
  const ownerPub = await ownerSigner.getPublicKey()
  // Sign the Blossom upload auth as the owner pseudonym O — so the storage server never sees
  // the owner's real key R_owner (which would deanonymize the hub operator).
  const ownerAuth = (e: import('nostr-tools').UnsignedEvent) => ownerSigner.signEvent(e)
  const pSigner = makeSubkeySigner(ChatContext.member(hubDTag), { privateKey, signer, peerPub: ownerPub })
  const memberP = await pSigner.getPublicKey()

  // 1. Leaf keyed on P
  const leaf = createLeaf(memberP, 'everyone')

  // 2. Wrap the leaf key as O → the creator's real key R (member unwraps with root R + O)
  const leafKeyHex = toHex(leaf.rawKey!)
  leaf.encryptedLeafKey = await ownerSigner.nip44Encrypt(creatorRPub, leafKeyHex)

  // 3. Build the (plaintext) leaf page + its group-encrypted roster segment (P→R,
  //    stamped at epoch 1 to match the initial history line below).
  const page = await buildLeafPage([leaf], 0)
  page.rosterEpoch = 1
  page.rosterBlob = await encryptRoster(hubSecret, { [memberP]: creatorRPub }, 1)
  onFileProgress?.({ fileIndex: 0, totalFiles, label: 'Leaf page' })
  const pageBytes = new TextEncoder().encode(serializeLeafPage(page))
  const { hash: pageHash } = await uploadToBlossomServers(pageBytes, signer, privateKey, blossomServerUrls, 'text/plain', undefined, undefined, ownerAuth)

  // 5-6. Spine (encrypts the hub secret at the root) + upload
  const spine = await buildSpine([{ nodeId: page.pageRoot.nodeId, rawKey: page.pageRoot.rawKey! }], hubSecret)
  onFileProgress?.({ fileIndex: 1, totalFiles, label: 'Spine tree' })
  const spineBytes = new TextEncoder().encode(serializeSpine(spine))
  const { hash: spineHash } = await uploadToBlossomServers(spineBytes, signer, privateKey, blossomServerUrls, 'text/plain', undefined, undefined, ownerAuth)

  // 7. Epoch history (unchanged — encrypted with the hub secret)
  onFileProgress?.({ fileIndex: 2, totalFiles, label: 'Epoch history' })
  const historyBlob = await aesEncrypt(hubSecret, `hub:1:${toHex(hubSecret)}`)
  const historyBytes = new TextEncoder().encode(historyBlob)
  const { hash: historyHash } = await uploadToBlossomServers(historyBytes, signer, privateKey, blossomServerUrls, 'text/plain', undefined, undefined, ownerAuth)

  // 8. Paginated index — first_pubkey is P
  onFileProgress?.({ fileIndex: 3, totalFiles, label: 'Index file' })
  const indexContent = createPaginatedIndexFile(
    spineHash,
    [{ pageIndex: 0, firstPubkey: memberP, hash: pageHash }],
    [],
    historyHash,
  )
  const indexBytes = new TextEncoder().encode(indexContent)
  const { hash: indexHash } = await uploadToBlossomServers(indexBytes, signer, privateKey, blossomServerUrls, 'text/plain', undefined, undefined, ownerAuth)

  return { indexHash, blossomServers: blossomServerUrls, ownerPub, memberP }
}

// ─── Member-side: Decrypt hub secret from LKH tree ───

/**
 * Decrypt the hub secret from a downloaded LKH tree file.
 *
 * 1. Parse the tree
 * 2. Find our leaf by pubkey
 * 3. NIP-04 decrypt our leaf key
 * 4. Walk up the tree (AES-decrypt at each level)
 * 5. AES-decrypt the hub secret from root
 *
 * @param memberPubkey - Our hex pubkey
 * @param memberPrivateKey - Our private key hex (null if using signer)
 * @param signer - ISigner with NIP-04 support (null if using private key)
 * @param creatorPubkey - Hub creator's pubkey (needed for NIP-04 decrypt)
 * @param treeContent - Raw tree file content (downloaded from Blossom)
 * @returns Hub secret as Uint8Array, or null if not a member
 */
export async function decryptHubSecret(
  memberPubkey: string,
  memberPrivateKey: string | null,
  signer: ISigner | null,
  creatorPubkey: string,
  treeContent: string,
): Promise<Uint8Array | null> {
  try {
    const tree = deserializeTree(treeContent)

    // Find our leaf
    const ourLeaf = tree.leaves.find(l => l.pubkey === memberPubkey)
    if (!ourLeaf) return null // not a member

    // NIP-04 decrypt our leaf key
    const leafKeyHex = await nip04Decrypt(
      creatorPubkey,
      ourLeaf.encryptedLeafKey,
      signer,
      memberPrivateKey,
    )
    const leafKey = fromHex(leafKeyHex)

    // Walk up the tree to get the hub secret
    const hubSecret = await walkTreeToSecret(tree, memberPubkey, leafKey)
    return hubSecret
  } catch (err) {
    console.error('Failed to decrypt hub secret from LKH tree:', err)
    throw err // Re-throw so caller can distinguish signer errors from not-a-member
  }
}

// ─── Creator-side: Re-hydrate rawKeys after deserialization ───

/**
 * After downloading and deserializing a tree from Blossom, rawKeys are lost
 * (they're stripped during serialization). The creator can recover them by
 * NIP-04 decrypting each leaf's encryptedLeafKey (creator encrypted them).
 *
 * This MUST be called before addLeaf/removeLeaf/buildTree on downloaded trees.
 * NOTE: This is for MONOLITHIC trees (group trees, facilitator mesh lists).
 * For paginated hub trees, use rehydratePageKeys instead.
 */
export async function rehydrateTreeKeys(
  tree: LkhTree,
  hubSecret: Uint8Array,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<LkhTree> {
  // 1. Recover every leaf rawKey by NIP-04 decrypting encryptedLeafKey
  for (const leaf of tree.leaves) {
    const leafKeyHex = await nip04Decrypt(
      leaf.pubkey,
      leaf.encryptedLeafKey,
      signer,
      privateKey,
    )
    leaf.rawKey = fromHex(leafKeyHex)
  }

  // 2. Rebuild the full tree to regenerate all internal node rawKeys
  //    (we can't recover node rawKeys from serialization — only leaf keys are NIP-04)
  const rebuilt = await buildTree(tree.leaves, hubSecret)
  return rebuilt
}

// ─── Paginated: Member-side decryption ───

/**
 * Decrypt the hub secret using the paginated two-step flow:
 *   1. Walk leaf page → page-root key
 *   2. Walk spine → hub secret
 *
 * @param memberPubkey - Our hex pubkey
 * @param memberPrivateKey - Our private key hex (null if using signer)
 * @param signer - ISigner with NIP-04 support (null if using private key)
 * @param creatorPubkey - Hub creator's pubkey (needed for NIP-04 decrypt)
 * @param pageContent - Raw leaf page file content (downloaded from Blossom)
 * @param spineContent - Raw spine file content (downloaded from Blossom)
 * @returns Hub secret as Uint8Array, or null if not a member
 */
export async function decryptHubSecretPaginated(
  memberPubkey: string,
  memberPrivateKey: string | null,
  signer: ISigner | null,
  creatorPubkey: string,
  pageContent: string,
  spineContent: string,
): Promise<Uint8Array | null> {
  try {
    const page = deserializeLeafPage(pageContent)
    const { deserializeSpine: parseSpine } = await import('@/lib/crypto/lkh')
    const spine = parseSpine(spineContent)

    // Find our leaf
    const ourLeaf = page.leaves.find(l => l.pubkey === memberPubkey)
    if (!ourLeaf) return null // not on this page

    // NIP-04 decrypt our leaf key
    const leafKeyHex = await nip04Decrypt(
      creatorPubkey,
      ourLeaf.encryptedLeafKey,
      signer,
      memberPrivateKey,
    )
    const leafKey = fromHex(leafKeyHex)

    // Step 1: Walk page → page-root key
    const { pageRootKey, pageRootId } = await walkPageToPageRoot(page, memberPubkey, leafKey)

    // Step 2: Walk spine → hub secret
    const hubSecret = await walkSpineToSecret(spine, pageRootId, pageRootKey)
    return hubSecret
  } catch (err) {
    console.error('Failed to decrypt hub secret (paginated):', err)
    throw err // Re-throw so caller can distinguish signer errors from not-a-member
  }
}

/**
 * v2 variant — bootstrap the hub secret from a **v2** paginated tree.
 *
 * The leaf is found by the member's **pseudonym `P`**, and the leaf key is unwrapped with the
 * member's **root key + the owner pseudonym `O`** as the nip44 counterparty (mirroring how
 * the owner wrapped it). The page is plaintext, so the walk to the hub secret is otherwise
 * identical to v1.
 *
 * @param memberP - the member's pseudonym `P` (their leaf identifier)
 * @param memberRPrivateKey - the member's real private key hex (null if using a signer)
 * @param ownerPub - the hub's owner pseudonym `O` (from the coordinate `kind:O:d_tag`)
 */
export async function decryptHubSecretPaginatedV2(
  memberP: string,
  memberRPrivateKey: string | null,
  signer: ISigner | null,
  ownerPub: string,
  pageContent: string,
  spineContent: string,
): Promise<Uint8Array | null> {
  try {
    const page = deserializeLeafPage(pageContent)
    const { deserializeSpine: parseSpine } = await import('@/lib/crypto/lkh')
    const spine = parseSpine(spineContent)

    const ourLeaf = page.leaves.find(l => l.pubkey === memberP)
    if (!ourLeaf) return null // not on this page

    // Unwrap the leaf key: nip44 with our ROOT key, O as the counterparty.
    const leafKeyHex = await guardedDecrypt(ourLeaf.encryptedLeafKey, ownerPub, signer, memberRPrivateKey, 'nip44')
    const leafKey = fromHex(leafKeyHex)

    const { pageRootKey, pageRootId } = await walkPageToPageRoot(page, memberP, leafKey)
    const hubSecret = await walkSpineToSecret(spine, pageRootId, pageRootKey)
    return hubSecret
  } catch (err) {
    console.error('Failed to decrypt hub secret (v2 paginated):', err)
    throw err
  }
}

/**
 * v2 roster — decrypt the page's group-encrypted roster segment (one op) to map each
 * leaf's pseudonym `P` to its real key `R`. Returns members keyed on **`R`** (so
 * membership/ban filtering, which keys on the real key, works), with the pseudonym `p`
 * carried alongside. `resolveEpochSecret` supplies the hub secret for the segment's stamped
 * epoch (from history). Returns `[]` if the segment can't be read.
 */
export async function getPageMembersV2(
  pageContent: string,
  resolveEpochSecret: EpochSecretResolver,
): Promise<Array<{ pubkey: string; roles: string; flags?: string; p: string }>> {
  const page = deserializeLeafPage(pageContent)
  if (!page.rosterBlob) return []
  const secret = resolveEpochSecret(page.rosterEpoch ?? 0)
  if (!secret) return []
  let roster: Record<string, string>
  try {
    roster = await decryptRoster(secret, page.rosterBlob, page.rosterEpoch ?? 0)
  } catch {
    return []
  }
  const out: Array<{ pubkey: string; roles: string; flags?: string; p: string }> = []
  for (const leaf of page.leaves) {
    const rPub = roster[leaf.pubkey]
    if (!rPub) continue // no roster entry for this P
    out.push({ pubkey: rPub, roles: leaf.roles, flags: leaf.flags, p: leaf.pubkey })
  }
  return out
}

// ─── Paginated: Creator-side page rehydration ───

/**
 * Rehydrate a single leaf page's rawKeys for the creator.
 * NIP-04 decrypts each leaf's encryptedLeafKey, then rebuilds the page
 * subtree to recover all internal node keys + page-root key.
 *
 * @param pageContent - Raw leaf page content (from Blossom download)
 * @param signer - ISigner for NIP-04 decryption
 * @param privateKey - Private key for NIP-04 decryption
 * @returns Rehydrated page with rawKeys on all leaves + page-root
 */
export async function rehydratePageKeys(
  pageContent: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<LeafPage> {
  const page = deserializeLeafPage(pageContent)

  // NIP-04 decrypt each leaf's key
  for (const leaf of page.leaves) {
    const leafKeyHex = await nip04Decrypt(
      leaf.pubkey,
      leaf.encryptedLeafKey,
      signer,
      privateKey,
    )
    leaf.rawKey = fromHex(leafKeyHex)
  }

  // Rebuild page subtree to recover internal node keys + page-root key
  // Use the existing leaf order (already sorted)
  const rebuilt = await buildLeafPage(page.leaves, 0)
  return rebuilt
}

// ─── Paginated: Creator-side add/remove members ───

/**
 * Add a new member to a single leaf page.
 * If the page exceeds PAGE_SIZE after insertion, splits into two pages.
 *
 * @param pageContent - Raw leaf page content (must be rehydrated first or pass rehydrated page)
 * @param rehydratedPage - Pre-rehydrated page (if available, avoids re-rehydrating)
 * @param memberPubkey - Pubkey of the new member
 * @param roles - Role string (e.g. "everyone")
 * @param signer - ISigner for NIP-04 encryption
 * @param privateKey - Private key for NIP-04 encryption
 * @param flags - Optional flags (e.g. "w" for whitelist)
 * @returns Updated page(s) and whether a split occurred
 */
export async function addMemberToPage(
  rehydratedPage: LeafPage,
  memberPubkey: string,
  roles: string,
  signer: ISigner | null,
  privateKey: string | null,
  flags?: string,
): Promise<{ pages: LeafPage[]; split: boolean }> {
  // Guard: skip if member already exists in the page
  if (rehydratedPage.leaves.some(l => l.pubkey === memberPubkey)) {
    console.warn(`[addMemberToPage] Member ${memberPubkey.slice(0, 8)}… already in page, skipping`)
    return { pages: [rehydratedPage], split: false }
  }

  // Create and NIP-04 encrypt the new leaf
  const newLeaf = createLeaf(memberPubkey, roles, flags)
  const leafKeyHex = toHex(newLeaf.rawKey!)
  newLeaf.encryptedLeafKey = await nip04Encrypt(memberPubkey, leafKeyHex, signer, privateKey)

  // Insert sorted by pubkey
  const allLeaves = [...rehydratedPage.leaves, newLeaf]
  allLeaves.sort((a, b) => a.pubkey.localeCompare(b.pubkey))

  // Check if split is needed
  if (allLeaves.length > PAGE_SIZE) {
    const [firstHalf, secondHalf] = splitPage(allLeaves)
    const page1 = await buildLeafPage(firstHalf, 0)
    const page2 = await buildLeafPage(secondHalf, 0)
    return { pages: [page1, page2], split: true }
  }

  // Rebuild single page with new leaf
  const updated = await buildLeafPage(allLeaves, 0)
  return { pages: [updated], split: false }
}

/**
 * v2 rehydration (owner-side) — recover every leaf's raw key so the page subtree can be
 * rebuilt. Decrypt the page's roster segment once (with the secret for its stamped epoch)
 * to get the `P→R` map, then for each leaf unwrap the leaf key via the owner `O` (`nip44`
 * with the member's `R` as counterparty). Carries the decrypted roster forward for the
 * caller to mutate (add/remove).
 */
export async function rehydratePageKeysV2(
  pageContent: string,
  ownerSigner: SubkeySigner,
  resolveEpochSecret: EpochSecretResolver,
): Promise<LeafPage> {
  const page = deserializeLeafPage(pageContent)
  if (!page.rosterBlob) throw new Error('rehydratePageKeysV2: page has no roster segment (not a v2 page)')
  const secret = resolveEpochSecret(page.rosterEpoch ?? 0)
  if (!secret) throw new Error(`rehydratePageKeysV2: no secret for roster epoch ${page.rosterEpoch}`)
  const roster = await decryptRoster(secret, page.rosterBlob, page.rosterEpoch ?? 0)

  for (const leaf of page.leaves) {
    const rPub = roster[leaf.pubkey]
    if (!rPub) throw new Error(`rehydratePageKeysV2: no roster entry for leaf ${leaf.pubkey.slice(0, 8)}…`)
    const leafKeyHex = await ownerSigner.nip44Decrypt(rPub, leaf.encryptedLeafKey)
    leaf.rawKey = fromHex(leafKeyHex)
  }
  const rebuilt = await buildLeafPage(page.leaves, 0)
  rebuilt.roster = roster
  rebuilt.rosterEpoch = page.rosterEpoch
  rebuilt.rosterBlob = page.rosterBlob
  return rebuilt
}

/**
 * v2 add (owner-side) — insert a new member into a rehydrated page. The leaf is keyed on the
 * member's pseudonym `P`; the leaf key is wrapped by the owner `O` to the member's real key
 * `R` (member unwraps with their root key + `O`). The `P→R` roster segment is re-encrypted
 * under the **current** epoch secret and re-stamped. Adding does NOT rotate the hub secret.
 */
export async function addMemberToPageV2(
  rehydratedPage: LeafPage,
  memberP: string,
  memberR: string,
  roles: string,
  currentSecret: Uint8Array,
  currentEpoch: number,
  ownerSigner: SubkeySigner,
  flags?: string,
): Promise<{ pages: LeafPage[]; split: boolean }> {
  if (rehydratedPage.leaves.some(l => l.pubkey === memberP)) {
    console.warn(`[addMemberToPageV2] Member ${memberP.slice(0, 8)}… already in page, skipping`)
    return { pages: [rehydratedPage], split: false }
  }

  const newLeaf = createLeaf(memberP, roles, flags)
  const leafKeyHex = toHex(newLeaf.rawKey!)
  newLeaf.encryptedLeafKey = await ownerSigner.nip44Encrypt(memberR, leafKeyHex)

  // Full P→R map = carried roster + the new member; each result page gets its own slice.
  const fullRoster: Record<string, string> = { ...(rehydratedPage.roster ?? {}), [memberP]: memberR }

  const allLeaves = [...rehydratedPage.leaves, newLeaf]
  allLeaves.sort((a, b) => a.pubkey.localeCompare(b.pubkey))

  const stampRoster = async (page: LeafPage): Promise<LeafPage> => {
    const slice: Record<string, string> = {}
    for (const l of page.leaves) if (fullRoster[l.pubkey]) slice[l.pubkey] = fullRoster[l.pubkey]
    page.roster = slice
    page.rosterEpoch = currentEpoch
    page.rosterBlob = await encryptRoster(currentSecret, slice, currentEpoch)
    return page
  }

  if (allLeaves.length > PAGE_SIZE) {
    const [firstHalf, secondHalf] = splitPage(allLeaves)
    const page1 = await stampRoster(await buildLeafPage(firstHalf, 0))
    const page2 = await stampRoster(await buildLeafPage(secondHalf, 0))
    return { pages: [page1, page2], split: true }
  }
  const updated = await stampRoster(await buildLeafPage(allLeaves, 0))
  return { pages: [updated], split: false }
}

/**
 * Remove a member from a single leaf page.
 * Does NOT generate a new hub secret — that's the caller's responsibility
 * (done at the spine level via buildSpine with a new secret).
 *
 * @param rehydratedPage - Pre-rehydrated page
 * @param memberPubkey - Pubkey of the member to remove
 * @returns Updated page, or null if member not found on this page
 */
export async function removeMemberFromPage(
  rehydratedPage: LeafPage,
  memberPubkey: string,
): Promise<LeafPage | null> {
  const remaining = rehydratedPage.leaves.filter(l => l.pubkey !== memberPubkey)
  if (remaining.length === rehydratedPage.leaves.length) return null // not found

  if (remaining.length === 0) {
    throw new Error('Cannot remove the last member from a page')
  }

  return buildLeafPage(remaining, 0)
}

/**
 * v2 remove (owner-side) — drop a member (by pseudonym `P`) from a rehydrated page and
 * re-encrypt the page's roster segment under the **new** epoch secret (a kick rotates the
 * secret). Surviving leaves keep their wrapped keys; only the page subtree + roster segment
 * are rebuilt. Returns null if the member is not on this page.
 */
export async function removeMemberFromPageV2(
  rehydratedPage: LeafPage,
  memberP: string,
  newSecret: Uint8Array,
  newEpoch: number,
): Promise<LeafPage | null> {
  const remaining = rehydratedPage.leaves.filter(l => l.pubkey !== memberP)
  if (remaining.length === rehydratedPage.leaves.length) return null // not found
  if (remaining.length === 0) throw new Error('Cannot remove the last member from a page')

  const page = await buildLeafPage(remaining, 0)
  // Rebuild the roster segment without the removed member, stamped at the new epoch.
  const slice: Record<string, string> = {}
  const src = rehydratedPage.roster ?? {}
  for (const l of remaining) if (src[l.pubkey]) slice[l.pubkey] = src[l.pubkey]
  page.roster = slice
  page.rosterEpoch = newEpoch
  page.rosterBlob = await encryptRoster(newSecret, slice, newEpoch)
  return page
}

/**
 * Update a member's roles in a leaf page WITHOUT changing any keys.
 * The page must be rehydrated (rawKeys present).
 *
 * @param rehydratedPage - Pre-rehydrated page
 * @param memberPubkey - Pubkey of the member to update
 * @param newRoles - New pipe-separated role IDs
 * @returns Updated page, or null if member not found
 */
export async function updateMemberRolesInPage(
  rehydratedPage: LeafPage,
  memberPubkey: string,
  newRoles: string,
): Promise<LeafPage | null> {
  const leaf = rehydratedPage.leaves.find(l => l.pubkey === memberPubkey)
  if (!leaf) return null

  leaf.roles = newRoles
  // Rebuild page to get new page-root (structure doesn't change, but keys re-derive)
  return buildLeafPage(rehydratedPage.leaves, 0)
}

// ─── Monolithic: Creator-side add/remove (kept for group trees) ───

/**
 * Add a new member to an existing monolithic LKH tree.
 * NOTE: For paginated hub trees, use addMemberToPage instead.
 *
 * @returns New serialized tree content
 */
export async function addMemberToTree(
  currentTree: LkhTree,
  memberPubkey: string,
  roles: string,
  hubSecret: Uint8Array,
  signer: ISigner | null,
  privateKey: string | null,
  flags?: string,
): Promise<string> {
  // Guard: skip if member already exists in the tree
  if (currentTree.leaves.some(l => l.pubkey === memberPubkey)) {
    console.warn(`[addMemberToTree] Member ${memberPubkey.slice(0, 8)}… already in tree, skipping`)
    return serializeTree(currentTree)
  }

  const newLeaf = createLeaf(memberPubkey, roles, flags)

  // NIP-04 encrypt the leaf key for the new member (1 signer call)
  const leafKeyHex = toHex(newLeaf.rawKey!)
  newLeaf.encryptedLeafKey = await nip04Encrypt(
    memberPubkey,
    leafKeyHex,
    signer,
    privateKey,
  )

  // Rebuild tree with new leaf (maintains balance)
  const { addLeaf: addLeafFn } = await import('@/lib/crypto/lkh')
  const newTree = await addLeafFn(currentTree, newLeaf, hubSecret)

  return serializeTree(newTree)
}

/**
 * Remove a member from the monolithic tree and generate a new hub secret.
 * NOTE: For paginated hub trees, use removeMemberFromPage instead.
 *
 * @returns New tree content and new hub secret, or null
 */
export async function removeMemberFromTree(
  currentTree: LkhTree,
  memberPubkey: string,
): Promise<{ newTreeContent: string; newHubSecret: Uint8Array } | null> {
  const { removeLeaf: removeLeafFn } = await import('@/lib/crypto/lkh')
  const result = await removeLeafFn(currentTree, memberPubkey)
  if (!result) return null

  return {
    newTreeContent: serializeTree(result.tree),
    newHubSecret: result.newHubSecret,
  }
}

/**
 * Update a member's roles in the monolithic tree WITHOUT changing any keys.
 * NOTE: For paginated hub trees, use updateMemberRolesInPage instead.
 */
export function updateMemberRoles(
  currentTree: LkhTree,
  memberPubkey: string,
  newRoles: string,
): string | null {
  const leaf = currentTree.leaves.find(l => l.pubkey === memberPubkey)
  if (!leaf) return null

  leaf.roles = newRoles
  return serializeTree(currentTree)
}

// ─── Ban Page Helpers ───

export interface BanEntry {
  pubkey: string
  reason: string
}

/**
 * Create a ban page file content from entries.
 * Format per NIP-CHAT §5.3: `<pubkey>,<reason>` per line.
 */
export function createBanPage(entries: BanEntry[]): string {
  return entries.map(e => `${e.pubkey},${e.reason || ''}`).join('\n')
}

/**
 * Parse a ban page file into entries.
 */
export function parseBanPage(content: string): BanEntry[] {
  const entries: BanEntry[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const commaIdx = trimmed.indexOf(',')
    if (commaIdx < 0) {
      entries.push({ pubkey: trimmed, reason: '' })
    } else {
      entries.push({
        pubkey: trimmed.slice(0, commaIdx),
        reason: trimmed.slice(commaIdx + 1),
      })
    }
  }
  return entries
}

/**
 * Upload ban pages to Blossom and return their hashes.
 * Currently puts all entries into a single page.
 */
export async function uploadBanPages(
  entries: BanEntry[],
  signer: ISigner | null,
  privateKey: string | null,
  blossomServerUrls: string[],
): Promise<string[]> {
  if (entries.length === 0) return []

  const content = createBanPage(entries)
  const bytes = new TextEncoder().encode(content)
  const { hash } = await uploadToBlossomServers(
    bytes, signer, privateKey, blossomServerUrls, 'text/plain',
  )
  return [hash]
}

/**
 * v2 — upload a single **encrypted** ban page (stores real keys `R`), keyed on the hub
 * secret. Returns the hash(es) for the index. Empty entries → no page.
 */
export async function uploadBanPagesV2(
  entries: BanEntry[],
  hubSecret: Uint8Array,
  epoch: number,
  signer: ISigner | null,
  privateKey: string | null,
  blossomServerUrls: string[],
  authSigner?: (e: import('nostr-tools').UnsignedEvent) => Promise<import('nostr-tools').Event>,
): Promise<string[]> {
  if (entries.length === 0) return []
  const { encryptBanList } = await import('@/lib/hub/hubContent')
  const content = await encryptBanList(hubSecret, createBanPage(entries), epoch)
  const { hash } = await uploadToBlossomServers(
    new TextEncoder().encode(content), signer, privateKey, blossomServerUrls, 'text/plain', undefined, undefined, authSigner,
  )
  // Stamp the epoch onto the returned index token so the reader keys off it (see banPageToken).
  return [`${hash}@${epoch}`]
}

/**
 * v2 — download + decrypt the encrypted ban pages into `BanEntry[]` (real keys `R`).
 * Requires the hub secret. Best-effort: undecryptable pages are skipped.
 */
export async function downloadBanListV2(
  banPages: Array<{ hash: string; epoch?: number }>,
  hubSecret: Uint8Array,
  blossomServers: string[],
): Promise<BanEntry[]> {
  const { downloadTextFromBlossom } = await import('./client')
  const { decryptBanList } = await import('@/lib/hub/hubContent')
  const all: BanEntry[] = []
  for (const bp of banPages) {
    // FAIL CLOSED: any page that can't be downloaded/decrypted THROWS (was: caught → partial result).
    // A partial ban list is dangerous — the caller would treat the missing page's members as "not
    // banned" and could re-approve / re-vouch them. Callers must distinguish "no bans" (empty pages)
    // from "couldn't load the ban list" (this throw) and fail closed on the latter.
    const enc = await downloadTextFromBlossom(bp.hash, blossomServers)
    // Key off the page's stamped epoch (undefined → legacy fallback inside decryptBanList).
    all.push(...parseBanPage(await decryptBanList(hubSecret, enc, bp.epoch)))
  }
  return all
}

/**
 * Download all ban pages from Blossom and return a flat array of banned pubkeys.
 */
export async function downloadBanList(
  banPages: Array<{ page: number; hash: string }>,
  blossomServers: string[],
): Promise<BanEntry[]> {
  const { downloadTextFromBlossom } = await import('./client')
  const allEntries: BanEntry[] = []

  for (const bp of banPages) {
    try {
      const content = await downloadTextFromBlossom(bp.hash, blossomServers)
      const entries = parseBanPage(content)
      allEntries.push(...entries)
    } catch (err) {
      console.warn(`Failed to download ban page ${bp.page} (${bp.hash}):`, err)
    }
  }

  return allEntries
}

// ─── Group Tree Operations ───
// Group trees use the same LKH format as the hub tree, but the root's
// encHubSecret field holds the group secret instead of the hub secret.

/**
 * Create and upload a new group LKH tree for a set of members.
 *
 * @param memberPubkeys - Pubkeys of members who belong to this group
 * @param groupSecret - 32-byte group secret as Uint8Array
 * @param signer - ISigner with NIP-04 support
 * @param privateKey - Creator's private key hex
 * @param blossomServerUrls - Blossom servers to upload to
 * @returns Hash of the uploaded group tree file
 */
export async function createAndUploadGroupTree(
  memberPubkeys: string[],
  groupSecret: Uint8Array,
  signer: ISigner | null,
  privateKey: string | null,
  blossomServerUrls: string[],
): Promise<string> {
  if (memberPubkeys.length === 0) {
    throw new Error('Cannot create group tree with no members')
  }

  // Create leaves for all group members
  const leaves: LkhLeaf[] = []
  for (const pubkey of memberPubkeys) {
    const leaf = createLeaf(pubkey, 'group')
    const leafKeyHex = toHex(leaf.rawKey!)
    leaf.encryptedLeafKey = await nip04Encrypt(pubkey, leafKeyHex, signer, privateKey)
    leaves.push(leaf)
  }

  // Build tree with group secret at root
  const tree = await buildTree(leaves, groupSecret)

  // Serialize and upload
  const treeContent = serializeTree(tree)
  const treeBytes = new TextEncoder().encode(treeContent)
  const { hash } = await uploadToBlossomServers(
    treeBytes, signer, privateKey, blossomServerUrls, 'text/plain',
  )

  console.log(`Group tree built with ${memberPubkeys.length} leaves, uploaded: ${hash}`)
  return hash
}

/**
 * v1 facilitator mesh tree — a MONOLITHIC member tree (leaves keyed on real keys `R`, wrapped via
 * NIP-04) that distributes the hub secret, plus a monolithic index (`tree:<hash>`). This matches the
 * format the facilitator consume paths expect (`index.treeHash` in `handleAddToMesh` /
 * `handleSetFacilitator` / `loadFacilitatorSecret`). The owner's main member tree is paginated for
 * scale, but a facilitator's list is small, so it stays monolithic — and `createAndUploadMemberFiles`
 * (paginated) must NOT be used here, or the index has no `tree:` hash and "add" fails with "No tree hash".
 */
export async function createAndUploadFacilitatorTreeV1(
  memberPubkeys: string[],
  hubSecret: Uint8Array,
  signer: ISigner | null,
  privateKey: string | null,
  blossomServerUrls: string[],
  epoch: number,
  epochSecrets: Record<number, string>,
): Promise<{ indexHash: string; treeHash: string }> {
  if (memberPubkeys.length === 0) throw new Error('Cannot create facilitator tree with no members')
  const leaves: LkhLeaf[] = []
  for (const pubkey of memberPubkeys) {
    const leaf = createLeaf(pubkey, 'everyone')
    leaf.encryptedLeafKey = await nip04Encrypt(pubkey, toHex(leaf.rawKey!), signer, privateKey)
    leaves.push(leaf)
  }
  const tree = await buildTree(leaves, hubSecret)
  const enc = new TextEncoder()
  const { hash: treeHash } = await uploadToBlossomServers(enc.encode(serializeTree(tree)), signer, privateKey, blossomServerUrls, 'text/plain')

  // Epoch history — byte-identical to the owner tree's format: a single AES blob
  // (encrypted with the CURRENT hub secret) of `hub:<epoch>:<secretHex>` lines. The
  // current epoch's line MUST be present, else a facilitated user can't tell which
  // secret is current after a rotation. The distributed tree secret stays the current one.
  const merged: Record<number, string> = { ...epochSecrets, [epoch]: toHex(hubSecret) }
  const historyLines = Object.keys(merged)
    .map((e) => parseInt(e, 10))
    .sort((a, b) => a - b)
    .map((ep) => `hub:${ep}:${merged[ep]}`)
  const historyBlob = await aesEncrypt(hubSecret, historyLines.join('\n'))
  const { hash: historyHash } = await uploadToBlossomServers(enc.encode(historyBlob), signer, privateKey, blossomServerUrls, 'text/plain')

  const { hash: indexHash } = await uploadToBlossomServers(enc.encode(createIndexFile(treeHash, [], historyHash)), signer, privateKey, blossomServerUrls, 'text/plain')
  return { indexHash, treeHash }
}

/**
 * v1 — rebuild a facilitator's mesh tree after an epoch rotation. Extracts the vouched member
 * pubkeys from the facilitator's existing tree and re-creates the tree + epoch history + index
 * under the NEW hub secret (so vouched members receive the new epoch's secret), reusing
 * `createAndUploadFacilitatorTreeV1`. Returns the new index/tree hashes; the caller republishes
 * the `list` join request with the new index hash. v1 only.
 */
export async function rebuildFacilitatorTreeV1(
  oldTreeContent: string,
  newHubSecret: Uint8Array,
  epoch: number,
  epochSecrets: Record<number, string>,
  signer: ISigner | null,
  privateKey: string | null,
  blossomServerUrls: string[],
): Promise<{ indexHash: string; treeHash: string; memberPubkeys: string[] }> {
  const memberPubkeys = deserializeTree(oldTreeContent).leaves.map((l) => l.pubkey)
  const { indexHash, treeHash } = await createAndUploadFacilitatorTreeV1(
    memberPubkeys, newHubSecret, signer, privateKey, blossomServerUrls, epoch, epochSecrets,
  )
  return { indexHash, treeHash, memberPubkeys }
}

/**
 * Add a member to an existing group tree.
 * The tree must be rehydrated (rawKeys present) before calling this.
 *
 * @returns New serialized tree content
 */
export async function addMemberToGroupTree(
  currentTree: LkhTree,
  memberPubkey: string,
  groupSecret: Uint8Array,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<string> {
  // Guard: skip if member already exists in the group tree
  if (currentTree.leaves.some(l => l.pubkey === memberPubkey)) {
    console.warn(`[addMemberToGroupTree] Member ${memberPubkey.slice(0, 8)}… already in group tree, skipping`)
    return serializeTree(currentTree)
  }

  const newLeaf = createLeaf(memberPubkey, 'group')
  const leafKeyHex = toHex(newLeaf.rawKey!)
  newLeaf.encryptedLeafKey = await nip04Encrypt(memberPubkey, leafKeyHex, signer, privateKey)

  const { addLeaf: addLeafFn } = await import('@/lib/crypto/lkh')
  const newTree = await addLeafFn(currentTree, newLeaf, groupSecret)
  return serializeTree(newTree)
}

/**
 * Remove a member from a group tree and generate a new group secret.
 * Returns null if member not found.
 *
 * @returns New tree content and new group secret, or null
 */
export async function removeMemberFromGroupTree(
  currentTree: LkhTree,
  memberPubkey: string,
): Promise<{ newTreeContent: string; newGroupSecret: Uint8Array } | null> {
  const { removeLeaf: removeLeafFn } = await import('@/lib/crypto/lkh')
  const result = await removeLeafFn(currentTree, memberPubkey)
  if (!result) return null

  return {
    newTreeContent: serializeTree(result.tree),
    newGroupSecret: result.newHubSecret, // removeLeaf returns newHubSecret — same field, different semantic
  }
}

/**
 * Decrypt the group secret from a downloaded group LKH tree file.
 * Same algorithm as decryptHubSecret — the tree format is identical.
 *
 * @returns Group secret as Uint8Array, or null if not a member of this group
 */
export async function decryptGroupSecret(
  memberPubkey: string,
  memberPrivateKey: string | null,
  signer: ISigner | null,
  creatorPubkey: string,
  treeContent: string,
): Promise<Uint8Array | null> {
  // Reuse the hub secret decryption — same LKH format
  return decryptHubSecret(memberPubkey, memberPrivateKey, signer, creatorPubkey, treeContent)
}

/**
 * v2 — create + upload a group LKH tree keyed on member pseudonyms `P`, with each leaf key wrapped
 * **`O ↔ P`** (owner `O` to the member's *pseudonym* `P` = `leaf.pubkey`). Wrapping to `P` (not the
 * real key `R`) lets the owner later **rehydrate the tree from the tree alone** — decrypting each
 * leaf against its own `P` — with no roster lookup, which is what enables incremental add/remove and
 * fixes the multi-page "rebuild drops off-page members" bug. Members unwrap with their own `P`-signer
 * (peer = `O`). `members` is `{p, r}` for call-site compatibility, but only `p` is used now.
 */
export async function createAndUploadGroupTreeV2(
  members: Array<{ p: string; r: string }>,
  groupSecret: Uint8Array,
  hubDTag: string,
  privateKey: string | null,
  signer: ISigner | null,
  blossomServerUrls: string[],
): Promise<string> {
  if (members.length === 0) throw new Error('Cannot create group tree with no members')
  const ownerSigner = makeSubkeySigner(ChatContext.owner(hubDTag), { privateKey, signer })
  const ownerAuth = (e: import('nostr-tools').UnsignedEvent) => ownerSigner.signEvent(e)

  const leaves: LkhLeaf[] = []
  for (const m of members) {
    const leaf = createLeaf(m.p, 'group')
    leaf.encryptedLeafKey = await ownerSigner.nip44Encrypt(m.p, toHex(leaf.rawKey!)) // O ↔ P (leaf pubkey)
    leaves.push(leaf)
  }
  const tree = await buildTree(leaves, groupSecret)
  return uploadGroupTreeV2(serializeTree(tree), privateKey, signer, blossomServerUrls, ownerAuth)
}

/** Upload a serialized group tree with owner Blossom auth; returns its hash. */
async function uploadGroupTreeV2(
  serialized: string,
  privateKey: string | null,
  signer: ISigner | null,
  blossomServerUrls: string[],
  ownerAuth: (e: import('nostr-tools').UnsignedEvent) => Promise<import('nostr-tools').Event>,
): Promise<string> {
  const { hash } = await uploadToBlossomServers(
    new TextEncoder().encode(serialized), signer, privateKey, blossomServerUrls, 'text/plain', undefined, undefined, ownerAuth,
  )
  return hash
}

/**
 * v2 — decrypt a group secret from an `O ↔ P`-wrapped group tree. The member finds their leaf by
 * `P`, unwraps the leaf key with their `P`-signer (peer = owner `O`), and walks to the group secret.
 * Returns null if the member isn't in the group.
 */
export async function decryptGroupSecretV2(
  memberP: string,
  hubDTag: string,
  memberRPrivateKey: string | null,
  signer: ISigner | null,
  ownerPub: string,
  treeContent: string,
): Promise<Uint8Array | null> {
  try {
    const tree = deserializeTree(treeContent)
    const ourLeaf = tree.leaves.find(l => l.pubkey === memberP)
    if (!ourLeaf) return null
    const pSigner = makeSubkeySigner(ChatContext.member(hubDTag), { privateKey: memberRPrivateKey, signer, peerPub: ownerPub })
    const leafKeyHex = await pSigner.nip44Decrypt(ownerPub, ourLeaf.encryptedLeafKey) // P ↔ O
    return await walkTreeToSecret(tree, memberP, fromHex(leafKeyHex))
  } catch (err) {
    console.error('Failed to decrypt group secret (v2):', err)
    throw err
  }
}

/**
 * v2 — the OWNER rehydrates a group tree (recovers every node's raw key) using ONLY the tree: each
 * leaf key is unwrapped `O ↔ P` against `leaf.pubkey` (= `P`), so no roster / `P→R` lookup is needed.
 * Rebuilds the internal nodes under `groupSecret`. Required before incremental add/remove.
 */
export async function rehydrateGroupTreeV2(
  treeContent: string,
  groupSecret: Uint8Array,
  hubDTag: string,
  privateKey: string | null,
  signer: ISigner | null,
): Promise<LkhTree> {
  const tree = deserializeTree(treeContent)
  const ownerSigner = makeSubkeySigner(ChatContext.owner(hubDTag), { privateKey, signer })
  for (const leaf of tree.leaves) {
    leaf.rawKey = fromHex(await ownerSigner.nip44Decrypt(leaf.pubkey, leaf.encryptedLeafKey))
  }
  return buildTree(tree.leaves, groupSecret)
}

/**
 * v2 — add one member (by pseudonym `P`) to a group tree WITHOUT rebuilding from the roster. Reads
 * the whole existing membership from the tree (so off-page members are preserved), adds the `P`-keyed
 * leaf wrapped `O ↔ P`, and re-keys the path under the SAME group secret (an addition doesn't need a
 * rotation). Idempotent. Returns the new serialized tree.
 */
export async function addMemberToGroupTreeV2(
  treeContent: string,
  memberP: string,
  groupSecret: Uint8Array,
  hubDTag: string,
  privateKey: string | null,
  signer: ISigner | null,
): Promise<string> {
  const rehydrated = await rehydrateGroupTreeV2(treeContent, groupSecret, hubDTag, privateKey, signer)
  if (rehydrated.leaves.some(l => l.pubkey === memberP)) return serializeTree(rehydrated)
  const ownerSigner = makeSubkeySigner(ChatContext.owner(hubDTag), { privateKey, signer })
  const newLeaf = createLeaf(memberP, 'group')
  newLeaf.encryptedLeafKey = await ownerSigner.nip44Encrypt(memberP, toHex(newLeaf.rawKey!))
  const { addLeaf } = await import('@/lib/crypto/lkh')
  return serializeTree(await addLeaf(rehydrated, newLeaf, groupSecret))
}

/**
 * v2 — remove one member (by pseudonym `P`) from a group tree and ROTATE the group secret (forward
 * secrecy). Reads the whole membership from the tree (off-page members preserved), removes the
 * `P`-keyed leaf, and re-keys the path with a fresh secret. Returns null if `P` isn't in the tree.
 */
export async function removeMemberFromGroupTreeV2(
  treeContent: string,
  memberP: string,
  groupSecret: Uint8Array,
  hubDTag: string,
  privateKey: string | null,
  signer: ISigner | null,
): Promise<{ newTreeContent: string; newGroupSecret: Uint8Array } | null> {
  const rehydrated = await rehydrateGroupTreeV2(treeContent, groupSecret, hubDTag, privateKey, signer)
  const { removeLeaf } = await import('@/lib/crypto/lkh')
  const result = await removeLeaf(rehydrated, memberP)
  if (!result) return null
  return { newTreeContent: serializeTree(result.tree), newGroupSecret: result.newHubSecret }
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 facilitator (mesh) trees
//
// A facilitator is a member — NOT the owner — who vouches for others by handing them the hub
// secret through their own small LKH tree (an alternative to the owner's main tree). In v1 that
// tree is keyed on, and wrapped to, real keys `R`. In v2 that would deanonymize everyone in it,
// and a facilitator can't derive other members' `P` anyway (that needs `O_priv` or each member's
// `R_priv`). The fix: key leaves on each vouched member's pseudonym `P` and wrap each leaf key
// **`P`→`P`** — the facilitator's own member pseudonym `P` (peer = owner `O`, so it matches the
// `P` they post under) to the member's `P`. No real key ever enters a facilitator tree, and the
// facilitator needs only each member's public `P`, which the member supplies. There is no roster
// and no `O`: the member unwraps with their own `P`-signer against the facilitator's public `P`
// (read off the list join request, which the facilitator authors under that same `P`).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the epoch-history blob for a v2 facilitator tree — byte-identical to the owner/v1 format
 * (`AES(currentSecret, "hub:<epoch>:<hex>\n…")`, lines sorted ascending, current epoch forced in),
 * so a vouched user can decrypt every past epoch. See {@link createAndUploadFacilitatorTreeV1}.
 */
async function buildFacilitatorHistoryBlobV2(
  hubSecret: Uint8Array, epoch: number, epochSecrets: Record<number, string>,
): Promise<string> {
  const merged: Record<number, string> = { ...epochSecrets, [epoch]: toHex(hubSecret) }
  const lines = Object.keys(merged).map(Number).sort((a, b) => a - b).map((ep) => `hub:${ep}:${merged[ep]}`)
  return aesEncrypt(hubSecret, lines.join('\n'))
}

/**
 * v2 — create + upload a facilitator mesh tree. The facilitator adds people **by their real key
 * `R_f` (npub)** — the tree keys each leaf on the *facilitated pseudonym* `Pf = ECDH(P_fac, R_f)`
 * (see {@link deriveFacilitatedPseudonymForFacilitator}), so `R_f` never enters the tree. Each leaf
 * key is wrapped `P_fac ↔ Pf` (to the leaf pubkey, so the facilitator can later rehydrate it for a
 * rebuild without needing `R_f`). The kind-24242 Blossom auth is signed as the facilitator's `P_fac`.
 * Index carries the epoch-history blob so vouched users decrypt across rotations.
 *
 * Requires the facilitator's **local** `privateKey` — `Pf` is a sub-sub-key a remote signer can't
 * derive (see {@link deriveFacilitatedPseudonymForFacilitator}).
 *
 * @param memberRs vouched users' real keys `R_f`
 * @returns { indexHash, treeHash } — put `indexHash` in the `list` tag of the list join request.
 */
export async function createAndUploadFacilitatorTreeV2(
  memberRs: string[],
  hubSecret: Uint8Array,
  hubDTag: string,
  ownerPub: string,
  epoch: number,
  epochSecrets: Record<number, string>,
  privateKey: string | null,
  signer: ISigner | null,
  blossomServerUrls: string[],
): Promise<{ indexHash: string; treeHash: string }> {
  if (!privateKey) throw new Error('Facilitating a v2 hub requires a local key')
  if (memberRs.length === 0) throw new Error('Cannot create facilitator tree with no members')
  const { deriveFacilitatedPseudonymForFacilitator } = await import('@/lib/crypto/skd')
  const facSigner = makeSubkeySigner(ChatContext.member(hubDTag), { privateKey, signer, peerPub: ownerPub })
  const facAuth = (e: import('nostr-tools').UnsignedEvent) => facSigner.signEvent(e)

  const leaves: LkhLeaf[] = []
  for (const rf of memberRs) {
    const pf = deriveFacilitatedPseudonymForFacilitator(privateKey, ownerPub, hubDTag, rf)
    const leaf = createLeaf(pf, 'member')
    leaf.encryptedLeafKey = await facSigner.nip44Encrypt(pf, toHex(leaf.rawKey!))
    leaves.push(leaf)
  }
  const tree = await buildTree(leaves, hubSecret)
  const enc = new TextEncoder()
  const { hash: treeHash } = await uploadToBlossomServers(
    enc.encode(serializeTree(tree)), signer, privateKey, blossomServerUrls, 'text/plain', undefined, undefined, facAuth,
  )
  const historyBlob = await buildFacilitatorHistoryBlobV2(hubSecret, epoch, epochSecrets)
  const { hash: historyHash } = await uploadToBlossomServers(
    enc.encode(historyBlob), signer, privateKey, blossomServerUrls, 'text/plain', undefined, undefined, facAuth,
  )
  const { hash: indexHash } = await uploadToBlossomServers(
    enc.encode(createIndexFile(treeHash, [], historyHash)), signer, privateKey, blossomServerUrls, 'text/plain', undefined, undefined, facAuth,
  )
  return { indexHash, treeHash }
}

/**
 * v2 — add one vouched user (by their real key `R_f`) to an existing facilitator tree. Derives their
 * `Pf`, rehydrates existing leaf keys (`P_fac ↔ Pf` unwrap by leaf pubkey), adds the new leaf, and
 * re-derives the path under `hubSecret`. Idempotent if `R_f`'s `Pf` is already present.
 */
export async function addMemberToFacilitatorTreeV2(
  treeContent: string,
  newMemberR: string,
  hubSecret: Uint8Array,
  hubDTag: string,
  ownerPub: string,
  privateKey: string | null,
  signer: ISigner | null,
): Promise<string> {
  if (!privateKey) throw new Error('Facilitating a v2 hub requires a local key')
  const { deriveFacilitatedPseudonymForFacilitator } = await import('@/lib/crypto/skd')
  const pf = deriveFacilitatedPseudonymForFacilitator(privateKey, ownerPub, hubDTag, newMemberR)
  const tree = deserializeTree(treeContent)
  if (tree.leaves.some(l => l.pubkey === pf)) return serializeTree(tree)
  const facSigner = makeSubkeySigner(ChatContext.member(hubDTag), { privateKey, signer, peerPub: ownerPub })
  // Rehydrate raw leaf keys so addLeaf can recompute the path.
  for (const leaf of tree.leaves) {
    leaf.rawKey = fromHex(await facSigner.nip44Decrypt(leaf.pubkey, leaf.encryptedLeafKey))
  }
  const newLeaf = createLeaf(pf, 'member')
  newLeaf.encryptedLeafKey = await facSigner.nip44Encrypt(pf, toHex(newLeaf.rawKey!))
  const { addLeaf } = await import('@/lib/crypto/lkh')
  const newTree = await addLeaf(tree, newLeaf, hubSecret)
  return serializeTree(newTree)
}

/**
 * v2 — rebuild a facilitator tree under a NEW hub secret + refreshed epoch history, keeping the same
 * vouched set. Leaf pubkeys (`Pf`) and their wraps (`P_fac ↔ Pf`, secret-independent) are preserved;
 * only the tree path + root secret change. Used by the manual "Update list to current epoch" flow.
 */
export async function rebuildFacilitatorTreeV2(
  oldTreeContent: string,
  newHubSecret: Uint8Array,
  hubDTag: string,
  ownerPub: string,
  epoch: number,
  epochSecrets: Record<number, string>,
  privateKey: string | null,
  signer: ISigner | null,
  blossomServerUrls: string[],
  /**
   * `Pf` leaves to DROP from the rebuilt tree — the caller passes the pseudonyms of vouched members who
   * are now banned from the hub. Without this, a refresh re-keys a kicked+banned member's leaf under the
   * new secret and rewrites the full epoch-history blob, handing them back read access (ban evasion).
   */
  excludePfs?: Set<string>,
): Promise<{ indexHash: string; treeHash: string }> {
  if (!privateKey) throw new Error('Facilitating a v2 hub requires a local key')
  const facSigner = makeSubkeySigner(ChatContext.member(hubDTag), { privateKey, signer, peerPub: ownerPub })
  const facAuth = (e: import('nostr-tools').UnsignedEvent) => facSigner.signEvent(e)
  const oldTree = deserializeTree(oldTreeContent)

  const leaves: LkhLeaf[] = []
  for (const l of oldTree.leaves) {
    if (excludePfs?.has(l.pubkey)) continue // banned vouched member — do NOT re-key them into the new epoch
    const rawKeyHex = await facSigner.nip44Decrypt(l.pubkey, l.encryptedLeafKey) // wrap is to leaf pubkey Pf
    const leaf = createLeaf(l.pubkey, 'member')
    leaf.rawKey = fromHex(rawKeyHex)
    leaf.encryptedLeafKey = l.encryptedLeafKey // wrap doesn't depend on the hub secret — reuse verbatim
    leaves.push(leaf)
  }
  if (leaves.length === 0) throw new Error('No vouched members remain after removing banned users — remove the facilitation list instead.')
  const tree = await buildTree(leaves, newHubSecret)
  const enc = new TextEncoder()
  const { hash: treeHash } = await uploadToBlossomServers(
    enc.encode(serializeTree(tree)), signer, privateKey, blossomServerUrls, 'text/plain', undefined, undefined, facAuth,
  )
  const historyBlob = await buildFacilitatorHistoryBlobV2(newHubSecret, epoch, epochSecrets)
  const { hash: historyHash } = await uploadToBlossomServers(
    enc.encode(historyBlob), signer, privateKey, blossomServerUrls, 'text/plain', undefined, undefined, facAuth,
  )
  const { hash: indexHash } = await uploadToBlossomServers(
    enc.encode(createIndexFile(treeHash, [], historyHash)), signer, privateKey, blossomServerUrls, 'text/plain', undefined, undefined, facAuth,
  )
  return { indexHash, treeHash }
}

/**
 * v2 — a vouched user recovers the hub secret from a facilitator's mesh tree: derive their own `Pf`
 * (peer = the facilitator's `P_fac`, read off the list-JR author), find the `Pf`-keyed leaf, unwrap
 * the leaf key `Pf ↔ P_fac`, and walk to the secret. Works on any signer (the facilitated side is a
 * normal sub-key of the user's own root). Returns null if not vouched by this list.
 */
export async function decryptSecretFromFacilitatorTreeV2(
  facilitatorP: string,
  hubDTag: string,
  memberPrivateKey: string | null,
  signer: ISigner | null,
  treeContent: string,
): Promise<Uint8Array | null> {
  const pfSigner = makeSubkeySigner(ChatContext.facilitated(hubDTag), { privateKey: memberPrivateKey, signer, peerPub: facilitatorP })
  const pf = await pfSigner.getPublicKey()
  const tree = deserializeTree(treeContent)
  const ourLeaf = tree.leaves.find(l => l.pubkey === pf)
  if (!ourLeaf) return null
  const leafKeyHex = await pfSigner.nip44Decrypt(facilitatorP, ourLeaf.encryptedLeafKey)
  return await walkTreeToSecret(tree, pf, fromHex(leafKeyHex))
}
