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

// ─── Types ───

export interface IndexFile {
  // Monolithic — used by facilitator/mesh list indexes
  treeHash: string

  // Paginated — used by hub creator indexes
  // When pageSize > 0, this is a paginated index; when 0, it's monolithic
  pageSize: number
  spineHash: string
  leafPages: Array<{ pageIndex: number; firstPubkey: string; hash: string }>

  // Common to both formats
  banPages: Array<{ page: number; hash: string }>
  groupTrees: Array<{ groupId: string; hash: string }>
  historyHash: string
}

// ─── NIP-04 Helpers ───

/**
 * NIP-04 encrypt: works with any signer type or raw private key.
 * The leaf key (as hex) is encrypted for the target pubkey.
 */
export async function nip04Encrypt(
  targetPubkey: string,
  plaintext: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<string> {
  // Try signer first (remote signers, browser extensions)
  if (signer?.nip04?.encrypt) {
    return signer.nip04.encrypt(targetPubkey, plaintext)
  }
  if (signer?.nip04Encrypt) {
    return signer.nip04Encrypt(targetPubkey, plaintext)
  }
  // Fall back to local key with nostr-tools
  if (privateKey) {
    return nip04.encrypt(privateKey, targetPubkey, plaintext)
  }
  throw new Error('No signer or private key available for NIP-04 encryption')
}

/**
 * NIP-04 decrypt: works with any signer type or raw private key.
 */
async function nip04Decrypt(
  senderPubkey: string,
  ciphertext: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<string> {
  if (signer?.nip04?.decrypt) {
    return signer.nip04.decrypt(senderPubkey, ciphertext)
  }
  if (signer?.nip04Decrypt) {
    return signer.nip04Decrypt(senderPubkey, ciphertext)
  }
  if (privateKey) {
    return nip04.decrypt(privateKey, senderPubkey, ciphertext)
  }
  throw new Error('No signer or private key available for NIP-04 decryption')
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
  const banPages: Array<{ page: number; hash: string }> = []
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
      banPages.push({ page: parseInt(parts[1], 10), hash: parts[2] })
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
): Promise<{ indexHash: string; blossomServers: string[] }> {
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
  const spineContent = serializeSpine(spine)
  const spineBytes = new TextEncoder().encode(spineContent)
  const { hash: spineHash } = await uploadToBlossomServers(
    spineBytes, signer, privateKey, blossomServerUrls, 'text/plain',
  )

  // 7. Create epoch history file
  const hubSecretHex = toHex(hubSecret)
  const historyPlaintext = `hub:1:${hubSecretHex}`
  const historyBlob = await aesEncrypt(hubSecret, historyPlaintext)
  const historyBytes = new TextEncoder().encode(historyBlob)
  const { hash: historyHash } = await uploadToBlossomServers(
    historyBytes, signer, privateKey, blossomServerUrls, 'text/plain',
  )

  // 8. Create and upload paginated index file
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
    return null
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
    return null
  }
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
