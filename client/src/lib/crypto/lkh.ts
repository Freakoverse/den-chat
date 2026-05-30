/**
 * LKH — Logical Key Hierarchy tree engine
 *
 * A balanced binary tree of symmetric keys for efficient hub secret distribution.
 * - Leaf nodes: member pubkeys with NIP-04 encrypted leaf keys
 * - Internal nodes: AES-256-GCM encrypted node keys (left & right child encryptions)
 * - Root node: additionally holds AES-encrypted hub secret
 *
 * All operations are pure functions operating on tree data structures.
 * NIP-04 encrypt/decrypt is handled by callers (blossom/members.ts).
 */

import { aesEncrypt, aesDecrypt } from './aes'

// ─── Types ───

export interface LkhLeaf {
  type: 'leaf'
  nodeId: string
  pubkey: string
  roles: string
  /** NIP-04 encrypted leaf key (set by caller) */
  encryptedLeafKey: string
  /** Raw leaf key — only held in memory during tree building (creator-side) */
  rawKey?: Uint8Array
  /** Optional flags like 'w' for whitelist */
  flags?: string
}

export interface LkhNode {
  type: 'node'
  nodeId: string
  leftChildId: string
  rightChildId: string
  /** This node's key AES-encrypted with left child's key */
  encLeft: string
  /** This node's key AES-encrypted with right child's key */
  encRight: string
  /** Raw node key — only held in memory during tree building (creator-side) */
  rawKey?: Uint8Array
}

export interface LkhRoot {
  type: 'root'
  nodeId: string
  leftChildId: string
  rightChildId: string
  encLeft: string
  encRight: string
  /** Hub secret AES-encrypted with root key */
  encHubSecret: string
  rawKey?: Uint8Array
}

export type LkhTreeNode = LkhLeaf | LkhNode | LkhRoot

export interface LkhTree {
  leaves: LkhLeaf[]
  nodes: LkhNode[]
  root: LkhRoot
}

// ─── Helpers ───

function randomKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

function shortUuid(): string {
  return crypto.randomUUID().split('-')[0]
}

/** Convert Uint8Array to hex string */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Convert hex string to Uint8Array */
export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

// ─── Tree Building ───

/**
 * Build a balanced binary LKH tree from an array of pre-created leaves.
 *
 * Each leaf must already have its `rawKey` set (random 32 bytes).
 * The `encryptedLeafKey` field should be set by the caller after NIP-04 encryption.
 *
 * @param leaves - Array of LkhLeaf with rawKey set
 * @param hubSecret - The hub secret to encrypt at the root
 * @returns Complete LkhTree with all AES encryptions applied
 */
export async function buildTree(leaves: LkhLeaf[], hubSecret: Uint8Array): Promise<LkhTree> {
  if (leaves.length === 0) {
    throw new Error('Cannot build LKH tree with no leaves')
  }

  // Special case: single leaf — create a root directly above it
  if (leaves.length === 1) {
    const leaf = leaves[0]
    const rootKey = randomKey()

    const encLeft = await aesEncrypt(leaf.rawKey!, toHex(rootKey))
    const encHubSecret = await aesEncrypt(rootKey, toHex(hubSecret))

    const root: LkhRoot = {
      type: 'root',
      nodeId: shortUuid(),
      leftChildId: leaf.nodeId,
      rightChildId: leaf.nodeId, // single child — same ref
      encLeft,
      encRight: encLeft, // same encryption since same child
      encHubSecret,
      rawKey: rootKey,
    }

    return { leaves: [leaf], nodes: [], root }
  }

  // Build bottom-up: pair leaves into internal nodes, then pair nodes, etc.
  const allNodes: LkhNode[] = []

  // Current level starts as leaves (we just need nodeId + rawKey)
  type NodeRef = { nodeId: string; rawKey: Uint8Array }
  let currentLevel: NodeRef[] = leaves.map(l => ({ nodeId: l.nodeId, rawKey: l.rawKey! }))

  while (currentLevel.length > 2) {
    const nextLevel: NodeRef[] = []

    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i]

      if (i + 1 >= currentLevel.length) {
        // Odd one out — push up to next level
        nextLevel.push(left)
        continue
      }

      const right = currentLevel[i + 1]
      const nodeKey = randomKey()
      const nodeId = shortUuid()

      const encLeft = await aesEncrypt(left.rawKey, toHex(nodeKey))
      const encRight = await aesEncrypt(right.rawKey, toHex(nodeKey))

      allNodes.push({
        type: 'node',
        nodeId,
        leftChildId: left.nodeId,
        rightChildId: right.nodeId,
        encLeft,
        encRight,
        rawKey: nodeKey,
      })

      nextLevel.push({ nodeId, rawKey: nodeKey })
    }

    currentLevel = nextLevel
  }

  // Final two nodes become children of root
  const left = currentLevel[0]
  const right = currentLevel.length > 1 ? currentLevel[1] : left
  const rootKey = randomKey()

  const encLeft = await aesEncrypt(left.rawKey, toHex(rootKey))
  const encRight = left === right
    ? encLeft
    : await aesEncrypt(right.rawKey, toHex(rootKey))
  const encHubSecret = await aesEncrypt(rootKey, toHex(hubSecret))

  const root: LkhRoot = {
    type: 'root',
    nodeId: shortUuid(),
    leftChildId: left.nodeId,
    rightChildId: right === left ? left.nodeId : right.nodeId,
    encLeft,
    encRight,
    encHubSecret,
    rawKey: rootKey,
  }

  return { leaves: [...leaves], nodes: allNodes, root }
}

// ─── Leaf Creation ───

/**
 * Create a new leaf node for a member.
 * The caller is responsible for NIP-04 encrypting the rawKey and setting encryptedLeafKey.
 */
export function createLeaf(pubkey: string, roles: string, flags?: string): LkhLeaf {
  return {
    type: 'leaf',
    nodeId: shortUuid(),
    pubkey,
    roles,
    encryptedLeafKey: '', // set by caller after NIP-04 encryption
    rawKey: randomKey(),
    flags,
  }
}

// ─── Add Member ───

/**
 * Add a member to an existing tree.
 *
 * Strategy: deserialize, add leaf, rebuild entire tree bottom-up.
 * This is simpler and ensures balance. For hubs with many members,
 * a more targeted insert could be used, but rebuild is O(N) AES which
 * is fast (~ms for thousands of members).
 *
 * @param tree - Current tree (must have rawKeys on all nodes — creator-side only)
 * @param newLeaf - New leaf node with rawKey set, encryptedLeafKey set
 * @param hubSecret - Current hub secret (unchanged — adding doesn't rotate)
 * @returns New tree with the added member
 */
export async function addLeaf(tree: LkhTree, newLeaf: LkhLeaf, hubSecret: Uint8Array): Promise<LkhTree> {
  const allLeaves = [...tree.leaves, newLeaf]
  return buildTree(allLeaves, hubSecret)
}

// ─── Remove Member ───

/**
 * Remove a member from the tree and generate a new hub secret.
 *
 * Strategy: remove leaf, rebuild tree with new hub secret.
 *
 * @param tree - Current tree (must have rawKeys — creator-side only)
 * @param pubkey - Pubkey of the member to remove
 * @returns New tree and new hub secret, or null if pubkey not found
 */
export async function removeLeaf(
  tree: LkhTree,
  pubkey: string,
): Promise<{ tree: LkhTree; newHubSecret: Uint8Array } | null> {
  const remaining = tree.leaves.filter(l => l.pubkey !== pubkey)
  if (remaining.length === tree.leaves.length) return null // not found

  if (remaining.length === 0) {
    throw new Error('Cannot remove the last member from the tree')
  }

  const newHubSecret = randomKey()
  const newTree = await buildTree(remaining, newHubSecret)
  return { tree: newTree, newHubSecret }
}

/**
 * Batch remove multiple members and generate a new hub secret.
 */
export async function removeLeaves(
  tree: LkhTree,
  pubkeys: string[],
): Promise<{ tree: LkhTree; newHubSecret: Uint8Array } | null> {
  const removeSet = new Set(pubkeys)
  const remaining = tree.leaves.filter(l => !removeSet.has(l.pubkey))
  if (remaining.length === tree.leaves.length) return null // none found

  if (remaining.length === 0) {
    throw new Error('Cannot remove all members from the tree')
  }

  const newHubSecret = randomKey()
  const newTree = await buildTree(remaining, newHubSecret)
  return { tree: newTree, newHubSecret }
}

// ─── Serialization ───

/**
 * Serialize an LKH tree to the line-based format specified in NIP-CHAT §5.2.
 */
export function serializeTree(tree: LkhTree): string {
  const lines: string[] = []

  // Leaves
  for (const leaf of tree.leaves) {
    const parts = ['leaf', leaf.nodeId, leaf.pubkey, leaf.roles, leaf.encryptedLeafKey]
    if (leaf.flags) parts.push(leaf.flags)
    lines.push(parts.join(':'))
  }

  // Internal nodes
  for (const node of tree.nodes) {
    lines.push(['node', node.nodeId, node.leftChildId, node.rightChildId, node.encLeft, node.encRight].join(':'))
  }

  // Root
  const r = tree.root
  lines.push(['root', r.nodeId, r.leftChildId, r.rightChildId, r.encLeft, r.encRight, r.encHubSecret].join(':'))

  return lines.join('\n')
}

/**
 * Deserialize a tree from the line-based format.
 * Note: rawKeys are NOT preserved in serialization — this is for member-side parsing.
 */
export function deserializeTree(text: string): LkhTree {
  const leaves: LkhLeaf[] = []
  const nodes: LkhNode[] = []
  let root: LkhRoot | null = null

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith('leaf:')) {
      const parts = trimmed.slice(5).split(':')
      if (parts.length < 4) throw new Error(`Invalid leaf line: ${trimmed}`)
      leaves.push({
        type: 'leaf',
        nodeId: parts[0],
        pubkey: parts[1],
        roles: parts[2],
        encryptedLeafKey: parts[3],
        flags: parts[4] || undefined,
      })
    } else if (trimmed.startsWith('node:')) {
      const parts = trimmed.slice(5).split(':')
      if (parts.length < 5) throw new Error(`Invalid node line: ${trimmed}`)
      nodes.push({
        type: 'node',
        nodeId: parts[0],
        leftChildId: parts[1],
        rightChildId: parts[2],
        encLeft: parts[3],
        encRight: parts[4],
      })
    } else if (trimmed.startsWith('root:')) {
      const parts = trimmed.slice(5).split(':')
      if (parts.length < 6) throw new Error(`Invalid root line: ${trimmed}`)
      root = {
        type: 'root',
        nodeId: parts[0],
        leftChildId: parts[1],
        rightChildId: parts[2],
        encLeft: parts[3],
        encRight: parts[4],
        encHubSecret: parts[5],
      }
    }
  }

  if (!root) throw new Error('No root node found in tree')

  return { leaves, nodes, root }
}

// ─── Member Decryption Path ───

/**
 * Decrypt the hub secret from an LKH tree given a member's decrypted leaf key.
 *
 * This walks from the leaf up to the root, AES-decrypting each parent's key.
 *
 * @param tree - Deserialized tree (from Blossom download)
 * @param leafPubkey - Member's pubkey (to find their leaf)
 * @param decryptedLeafKey - The leaf's raw key (after NIP-04 decryption by caller)
 * @returns The hub secret as Uint8Array
 */
export async function walkTreeToSecret(
  tree: LkhTree,
  leafPubkey: string,
  decryptedLeafKey: Uint8Array,
): Promise<Uint8Array> {
  // Find our leaf
  const leaf = tree.leaves.find(l => l.pubkey === leafPubkey)
  if (!leaf) throw new Error(`Leaf not found for pubkey: ${leafPubkey}`)

  // Build a lookup: childId → parent (node or root)
  const parentMap = new Map<string, LkhNode | LkhRoot>()
  for (const node of tree.nodes) {
    parentMap.set(node.leftChildId, node)
    parentMap.set(node.rightChildId, node)
  }
  parentMap.set(tree.root.leftChildId, tree.root)
  if (tree.root.rightChildId !== tree.root.leftChildId) {
    parentMap.set(tree.root.rightChildId, tree.root)
  }

  // Walk up from leaf to root
  let currentId = leaf.nodeId
  let currentKey = decryptedLeafKey

  while (true) {
    const parent = parentMap.get(currentId)
    if (!parent) throw new Error(`No parent found for node: ${currentId}`)

    // Decrypt parent's key using our current key
    const encBlob = currentId === parent.leftChildId ? parent.encLeft : parent.encRight
    const parentKeyHex = await aesDecrypt(currentKey, encBlob)
    const parentKey = fromHex(parentKeyHex)

    if (parent.type === 'root') {
      // Decrypt hub secret from root
      const hubSecretHex = await aesDecrypt(parentKey, parent.encHubSecret)
      return fromHex(hubSecretHex)
    }

    // Move up
    currentId = parent.nodeId
    currentKey = parentKey
  }
}

/**
 * Get all member pubkeys from a tree (for member list display).
 */
export function getMembers(tree: LkhTree): Array<{ pubkey: string; roles: string; flags?: string }> {
  return tree.leaves.map(l => ({
    pubkey: l.pubkey,
    roles: l.roles,
    flags: l.flags,
  }))
}

// ═══════════════════════════════════════════════════════════════════════
// PAGINATED LKH — Spine-and-Page Architecture
//
// For hubs with many members, the monolithic tree is split into:
//   - Leaf Pages: self-contained subtrees of up to PAGE_SIZE leaves each
//   - Spine: a tree connecting page roots to a single root with encHubSecret
//
// Member decryption: walk leaf page → page-root key → walk spine → hub secret
// Creator operations: modify 1 page + rebuild spine = 3 file uploads
//
// Group trees and facilitator mesh lists remain monolithic (use buildTree above).
// ═══════════════════════════════════════════════════════════════════════

/** Maximum leaves per page. Triggers a split when exceeded. */
export const PAGE_SIZE = 10_000

// ─── Paginated Types ───

export interface LeafPage {
  leaves: LkhLeaf[]
  nodes: LkhNode[]
  /** The top node of this page's subtree — its rawKey bridges to the spine */
  pageRoot: {
    type: 'page-root'
    nodeId: string
    leftChildId: string
    rightChildId: string
    encLeft: string
    encRight: string
    rawKey?: Uint8Array
  }
}

export interface SpineTree {
  nodes: LkhNode[]
  root: LkhRoot
  /**
   * Page-root keys encrypted with the hub secret.
   * Stored as `pr-key:<nodeId>:<aes_encrypted_rawKey>` lines in the spine file.
   * This allows the creator to recover all page-root rawKeys from the spine alone
   * (without downloading all pages), enabling O(1) spine rebuilds.
   * Only the creator needs these — regular members walk bottom-up and never use them.
   */
  encryptedPageRootKeys: Array<{ nodeId: string; encKey: string }>
}

// ─── Page Building ───

/**
 * Build a self-contained leaf-page subtree from a sorted subset of leaves.
 *
 * The subtree has its own internal nodes and a page-root at the top.
 * The page-root's rawKey is passed up to the spine for connection.
 * Unlike buildTree, the page-root does NOT hold encHubSecret — that's the spine's job.
 *
 * @param leaves - Sorted array of LkhLeaf with rawKey set (up to PAGE_SIZE)
 * @param _pageIndex - Page index (for future use / logging)
 * @returns LeafPage with serializable content and page-root rawKey
 */
export async function buildLeafPage(leaves: LkhLeaf[], _pageIndex: number): Promise<LeafPage> {
  if (leaves.length === 0) {
    throw new Error('Cannot build leaf page with no leaves')
  }

  // Special case: single leaf — page-root directly above it
  if (leaves.length === 1) {
    const leaf = leaves[0]
    const prKey = randomKey()
    const prId = shortUuid()

    const encLeft = await aesEncrypt(leaf.rawKey!, toHex(prKey))

    return {
      leaves: [leaf],
      nodes: [],
      pageRoot: {
        type: 'page-root',
        nodeId: prId,
        leftChildId: leaf.nodeId,
        rightChildId: leaf.nodeId,
        encLeft,
        encRight: encLeft,
        rawKey: prKey,
      },
    }
  }

  // Build bottom-up: pair leaves into internal nodes, then pair nodes
  const allNodes: LkhNode[] = []

  type NodeRef = { nodeId: string; rawKey: Uint8Array }
  let currentLevel: NodeRef[] = leaves.map(l => ({ nodeId: l.nodeId, rawKey: l.rawKey! }))

  while (currentLevel.length > 2) {
    const nextLevel: NodeRef[] = []

    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i]

      if (i + 1 >= currentLevel.length) {
        nextLevel.push(left)
        continue
      }

      const right = currentLevel[i + 1]
      const nodeKey = randomKey()
      const nodeId = shortUuid()

      const encLeft = await aesEncrypt(left.rawKey, toHex(nodeKey))
      const encRight = await aesEncrypt(right.rawKey, toHex(nodeKey))

      allNodes.push({
        type: 'node',
        nodeId,
        leftChildId: left.nodeId,
        rightChildId: right.nodeId,
        encLeft,
        encRight,
        rawKey: nodeKey,
      })

      nextLevel.push({ nodeId, rawKey: nodeKey })
    }

    currentLevel = nextLevel
  }

  // Final two nodes become children of page-root
  const left = currentLevel[0]
  const right = currentLevel.length > 1 ? currentLevel[1] : left
  const prKey = randomKey()
  const prId = shortUuid()

  const encLeft = await aesEncrypt(left.rawKey, toHex(prKey))
  const encRight = left === right
    ? encLeft
    : await aesEncrypt(right.rawKey, toHex(prKey))

  return {
    leaves: [...leaves],
    nodes: allNodes,
    pageRoot: {
      type: 'page-root',
      nodeId: prId,
      leftChildId: left.nodeId,
      rightChildId: right === left ? left.nodeId : right.nodeId,
      encLeft,
      encRight,
      rawKey: prKey,
    },
  }
}

// ─── Spine Building ───

/**
 * Build a spine tree connecting page roots to a single root with encHubSecret.
 *
 * Each page root becomes a "leaf" of the spine. The spine's internal nodes use
 * AES to chain page-root keys up to the spine root, which encrypts the hub secret.
 *
 * @param pageRoots - Array of { nodeId, rawKey } from each page's pageRoot
 * @param hubSecret - The hub secret to encrypt at the spine root
 * @returns SpineTree with serializable content
 */
export async function buildSpine(
  pageRoots: Array<{ nodeId: string; rawKey: Uint8Array }>,
  hubSecret: Uint8Array,
): Promise<SpineTree> {
  if (pageRoots.length === 0) {
    throw new Error('Cannot build spine with no page roots')
  }

  // Encrypt each page-root key with the hub secret for creator-side recovery.
  // This lets the creator download ONLY the spine to recover all page-root rawKeys,
  // avoiding the need to download + rehydrate every page for a spine rebuild.
  const encryptedPageRootKeys: Array<{ nodeId: string; encKey: string }> = []
  for (const pr of pageRoots) {
    const encKey = await aesEncrypt(hubSecret, toHex(pr.rawKey))
    encryptedPageRootKeys.push({ nodeId: pr.nodeId, encKey })
  }

  // Single page — spine root directly above the page root
  if (pageRoots.length === 1) {
    const pr = pageRoots[0]
    const rootKey = randomKey()

    const encLeft = await aesEncrypt(pr.rawKey, toHex(rootKey))
    const encHubSecret = await aesEncrypt(rootKey, toHex(hubSecret))

    const root: LkhRoot = {
      type: 'root',
      nodeId: shortUuid(),
      leftChildId: pr.nodeId,
      rightChildId: pr.nodeId,
      encLeft,
      encRight: encLeft,
      encHubSecret,
      rawKey: rootKey,
    }

    return { nodes: [], root, encryptedPageRootKeys }
  }

  // Build bottom-up from page roots
  const allNodes: LkhNode[] = []

  type NodeRef = { nodeId: string; rawKey: Uint8Array }
  let currentLevel: NodeRef[] = pageRoots.map(pr => ({ nodeId: pr.nodeId, rawKey: pr.rawKey }))

  while (currentLevel.length > 2) {
    const nextLevel: NodeRef[] = []

    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i]

      if (i + 1 >= currentLevel.length) {
        nextLevel.push(left)
        continue
      }

      const right = currentLevel[i + 1]
      const nodeKey = randomKey()
      const nodeId = shortUuid()

      const encLeft = await aesEncrypt(left.rawKey, toHex(nodeKey))
      const encRight = await aesEncrypt(right.rawKey, toHex(nodeKey))

      allNodes.push({
        type: 'node',
        nodeId,
        leftChildId: left.nodeId,
        rightChildId: right.nodeId,
        encLeft,
        encRight,
        rawKey: nodeKey,
      })

      nextLevel.push({ nodeId, rawKey: nodeKey })
    }

    currentLevel = nextLevel
  }

  // Final two become children of spine root
  const left = currentLevel[0]
  const right = currentLevel.length > 1 ? currentLevel[1] : left
  const rootKey = randomKey()

  const encLeft = await aesEncrypt(left.rawKey, toHex(rootKey))
  const encRight = left === right
    ? encLeft
    : await aesEncrypt(right.rawKey, toHex(rootKey))
  const encHubSecret = await aesEncrypt(rootKey, toHex(hubSecret))

  const root: LkhRoot = {
    type: 'root',
    nodeId: shortUuid(),
    leftChildId: left.nodeId,
    rightChildId: right === left ? left.nodeId : right.nodeId,
    encLeft,
    encRight,
    encHubSecret,
    rawKey: rootKey,
  }

  return { nodes: allNodes, root, encryptedPageRootKeys }
}

// ─── Page Serialization ───

/**
 * Serialize a leaf page to the line-based format.
 *
 * Format:
 *   leaf:<nodeId>:<pubkey>:<roles>:<encryptedLeafKey>[:<flags>]
 *   node:<nodeId>:<leftChildId>:<rightChildId>:<encLeft>:<encRight>
 *   page-root:<nodeId>:<leftChildId>:<rightChildId>:<encLeft>:<encRight>
 */
export function serializeLeafPage(page: LeafPage): string {
  const lines: string[] = []

  for (const leaf of page.leaves) {
    const parts = ['leaf', leaf.nodeId, leaf.pubkey, leaf.roles, leaf.encryptedLeafKey]
    if (leaf.flags) parts.push(leaf.flags)
    lines.push(parts.join(':'))
  }

  for (const node of page.nodes) {
    lines.push(['node', node.nodeId, node.leftChildId, node.rightChildId, node.encLeft, node.encRight].join(':'))
  }

  const pr = page.pageRoot
  lines.push(['page-root', pr.nodeId, pr.leftChildId, pr.rightChildId, pr.encLeft, pr.encRight].join(':'))

  return lines.join('\n')
}

/**
 * Deserialize a leaf page from the line-based format.
 * rawKeys are NOT preserved — this is for member-side parsing.
 */
export function deserializeLeafPage(text: string): LeafPage {
  const leaves: LkhLeaf[] = []
  const nodes: LkhNode[] = []
  let pageRoot: LeafPage['pageRoot'] | null = null

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith('leaf:')) {
      const parts = trimmed.slice(5).split(':')
      if (parts.length < 4) throw new Error(`Invalid leaf line: ${trimmed}`)
      leaves.push({
        type: 'leaf',
        nodeId: parts[0],
        pubkey: parts[1],
        roles: parts[2],
        encryptedLeafKey: parts[3],
        flags: parts[4] || undefined,
      })
    } else if (trimmed.startsWith('page-root:')) {
      const parts = trimmed.slice(10).split(':')
      if (parts.length < 5) throw new Error(`Invalid page-root line: ${trimmed}`)
      pageRoot = {
        type: 'page-root',
        nodeId: parts[0],
        leftChildId: parts[1],
        rightChildId: parts[2],
        encLeft: parts[3],
        encRight: parts[4],
      }
    } else if (trimmed.startsWith('node:')) {
      const parts = trimmed.slice(5).split(':')
      if (parts.length < 5) throw new Error(`Invalid node line: ${trimmed}`)
      nodes.push({
        type: 'node',
        nodeId: parts[0],
        leftChildId: parts[1],
        rightChildId: parts[2],
        encLeft: parts[3],
        encRight: parts[4],
      })
    }
  }

  if (!pageRoot) throw new Error('No page-root found in leaf page')

  return { leaves, nodes, pageRoot }
}

// ─── Spine Serialization ───

/**
 * Serialize a spine tree to the line-based format.
 * Same as serializeTree but uses SpineTree (no leaves, has root with encHubSecret).
 */
export function serializeSpine(spine: SpineTree): string {
  const lines: string[] = []

  // Encrypted page-root keys (creator-side recovery)
  for (const prk of spine.encryptedPageRootKeys) {
    lines.push(`pr-key:${prk.nodeId}:${prk.encKey}`)
  }

  for (const node of spine.nodes) {
    lines.push(['node', node.nodeId, node.leftChildId, node.rightChildId, node.encLeft, node.encRight].join(':'))
  }

  const r = spine.root
  lines.push(['root', r.nodeId, r.leftChildId, r.rightChildId, r.encLeft, r.encRight, r.encHubSecret].join(':'))

  return lines.join('\n')
}

/**
 * Deserialize a spine tree from the line-based format.
 */
export function deserializeSpine(text: string): SpineTree {
  const nodes: LkhNode[] = []
  const encryptedPageRootKeys: Array<{ nodeId: string; encKey: string }> = []
  let root: LkhRoot | null = null

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith('pr-key:')) {
      const parts = trimmed.slice(7).split(':')
      if (parts.length < 2) throw new Error(`Invalid pr-key line: ${trimmed}`)
      encryptedPageRootKeys.push({ nodeId: parts[0], encKey: parts.slice(1).join(':') })
    } else if (trimmed.startsWith('node:')) {
      const parts = trimmed.slice(5).split(':')
      if (parts.length < 5) throw new Error(`Invalid node line: ${trimmed}`)
      nodes.push({
        type: 'node',
        nodeId: parts[0],
        leftChildId: parts[1],
        rightChildId: parts[2],
        encLeft: parts[3],
        encRight: parts[4],
      })
    } else if (trimmed.startsWith('root:')) {
      const parts = trimmed.slice(5).split(':')
      if (parts.length < 6) throw new Error(`Invalid root line: ${trimmed}`)
      root = {
        type: 'root',
        nodeId: parts[0],
        leftChildId: parts[1],
        rightChildId: parts[2],
        encLeft: parts[3],
        encRight: parts[4],
        encHubSecret: parts[5],
      }
    }
  }

  if (!root) throw new Error('No root node found in spine')

  return { nodes, root, encryptedPageRootKeys }
}

// ─── Paginated Member Decryption ───

/**
 * Walk from a member's leaf up to the page-root, returning the page-root key.
 * This is the first step of paginated decryption.
 *
 * @param page - Deserialized leaf page
 * @param leafPubkey - Member's pubkey
 * @param decryptedLeafKey - The leaf's raw key (after NIP-04 decryption)
 * @returns Page-root key and nodeId (feed into walkSpineToSecret)
 */
export async function walkPageToPageRoot(
  page: LeafPage,
  leafPubkey: string,
  decryptedLeafKey: Uint8Array,
): Promise<{ pageRootKey: Uint8Array; pageRootId: string }> {
  const leaf = page.leaves.find(l => l.pubkey === leafPubkey)
  if (!leaf) throw new Error(`Leaf not found in page for pubkey: ${leafPubkey}`)

  // Build parent lookup: childId → parent (node or page-root)
  const parentMap = new Map<string, LkhNode | LeafPage['pageRoot']>()
  for (const node of page.nodes) {
    parentMap.set(node.leftChildId, node)
    parentMap.set(node.rightChildId, node)
  }
  parentMap.set(page.pageRoot.leftChildId, page.pageRoot)
  if (page.pageRoot.rightChildId !== page.pageRoot.leftChildId) {
    parentMap.set(page.pageRoot.rightChildId, page.pageRoot)
  }

  // Walk up from leaf to page-root
  let currentId = leaf.nodeId
  let currentKey = decryptedLeafKey

  while (true) {
    const parent = parentMap.get(currentId)
    if (!parent) throw new Error(`No parent found for node: ${currentId}`)

    const encBlob = currentId === parent.leftChildId ? parent.encLeft : parent.encRight
    const parentKeyHex = await aesDecrypt(currentKey, encBlob)
    const parentKey = fromHex(parentKeyHex)

    if (parent.type === 'page-root') {
      return { pageRootKey: parentKey, pageRootId: parent.nodeId }
    }

    currentId = parent.nodeId
    currentKey = parentKey
  }
}

/**
 * Walk from a page-root up through the spine to decrypt the hub secret.
 * This is the second step of paginated decryption.
 *
 * @param spine - Deserialized spine tree
 * @param pageRootId - The page-root nodeId (from walkPageToPageRoot)
 * @param pageRootKey - The decrypted page-root key
 * @returns The hub secret as Uint8Array
 */
export async function walkSpineToSecret(
  spine: SpineTree,
  pageRootId: string,
  pageRootKey: Uint8Array,
): Promise<Uint8Array> {
  // Build parent lookup: childId → parent (node or root)
  const parentMap = new Map<string, LkhNode | LkhRoot>()
  for (const node of spine.nodes) {
    parentMap.set(node.leftChildId, node)
    parentMap.set(node.rightChildId, node)
  }
  parentMap.set(spine.root.leftChildId, spine.root)
  if (spine.root.rightChildId !== spine.root.leftChildId) {
    parentMap.set(spine.root.rightChildId, spine.root)
  }

  let currentId = pageRootId
  let currentKey = pageRootKey

  while (true) {
    const parent = parentMap.get(currentId)
    if (!parent) throw new Error(`No parent found for node in spine: ${currentId}`)

    const encBlob = currentId === parent.leftChildId ? parent.encLeft : parent.encRight
    const parentKeyHex = await aesDecrypt(currentKey, encBlob)
    const parentKey = fromHex(parentKeyHex)

    if (parent.type === 'root') {
      const hubSecretHex = await aesDecrypt(parentKey, parent.encHubSecret)
      return fromHex(hubSecretHex)
    }

    currentId = parent.nodeId
    currentKey = parentKey
  }
}

// ─── Creator-Side: Page Root Key Recovery ───

/**
 * Recover all page-root rawKeys from the spine using the hub secret.
 *
 * The spine stores each page-root key encrypted with the hub secret (pr-key lines).
 * The creator uses this to recover all page-root rawKeys without downloading
 * any leaf pages — enabling O(1) downloads for add/remove member operations.
 *
 * Flow for modifying a member:
 *   1. Download spine + the affected page (2 downloads)
 *   2. recoverPageRootKeys(spine, hubSecret) → all page-root rawKeys
 *   3. Modify the affected page → get its new page-root rawKey
 *   4. Replace the changed entry in the recovered keys array
 *   5. buildSpine(updatedPageRoots, hubSecret) → new spine
 *   6. Upload: changed page + new spine + new index (3 uploads)
 *
 * @param spine - Deserialized spine tree (must have encryptedPageRootKeys)
 * @param hubSecret - The current hub secret
 * @returns Array of { nodeId, rawKey } for each page root
 */
export async function recoverPageRootKeys(
  spine: SpineTree,
  hubSecret: Uint8Array,
): Promise<Array<{ nodeId: string; rawKey: Uint8Array }>> {
  const result: Array<{ nodeId: string; rawKey: Uint8Array }> = []

  for (const prk of spine.encryptedPageRootKeys) {
    const rawKeyHex = await aesDecrypt(hubSecret, prk.encKey)
    result.push({ nodeId: prk.nodeId, rawKey: fromHex(rawKeyHex) })
  }

  return result
}

// ─── Page Splitting ───

/**
 * Split a sorted array of leaves at the midpoint into two halves.
 * Each half will become a separate leaf page.
 *
 * @param leaves - Sorted array of leaves (by pubkey)
 * @returns Two arrays of leaves [firstHalf, secondHalf]
 */
export function splitPage(leaves: LkhLeaf[]): [LkhLeaf[], LkhLeaf[]] {
  const mid = Math.ceil(leaves.length / 2)
  return [leaves.slice(0, mid), leaves.slice(mid)]
}

/**
 * Get all member pubkeys from a leaf page (for member list display).
 */
export function getPageMembers(page: LeafPage): Array<{ pubkey: string; roles: string; flags?: string }> {
  return page.leaves.map(l => ({
    pubkey: l.pubkey,
    roles: l.roles,
    flags: l.flags,
  }))
}
