/**
 * Safe Tree Updater — Centralized helper for all LKH tree mutations
 *
 * Handles the full flow: upload → verify → publish → cleanup
 * Safety guarantee: old files are ONLY deleted after ALL verifications pass.
 *
 * Used by: JoinRequestsModal (add), UserProfileModal (ban/remove),
 *          HubSettingsModal Members page (role updates)
 */

import type { HubData } from '@/stores/hubStore'
import type { ISigner } from '@/stores/userStore'
import type { BanEntry } from './members'

// ─── Types ───

export interface SafeTreeUpdateParams {
  /** Hub data (provides dTag, servers, epoch, channels, etc.) */
  hub: HubData
  /** Signer for auth + NIP-04 */
  signer: ISigner | null
  /** Private key hex */
  privateKey: string | null
  /** New serialized tree content (already modified) */
  newTreeContent: string
  /** New epoch number (only bumped on member removal — defaults to hub.epoch) */
  newEpoch?: number
  /** New hub secret bytes (only set on member removal) */
  newHubSecret?: Uint8Array
  /** Old hub secret bytes (needed for history re-encryption on epoch bump) */
  oldHubSecret?: Uint8Array
  /** Updated ban entries (replaces existing ban pages) */
  banEntries?: BanEntry[]
  /** Whether to preserve existing group tree refs in the index */
  preserveGroupTrees?: boolean
  /** Skip publishing the hub event (caller will publish its own with updated data) */
  skipPublish?: boolean
}

export interface SafeTreeUpdateResult {
  /** New index file hash (to store in hub event m tag) */
  newIndexHash: string
  /** Epoch used (may have been bumped) */
  newEpoch: number
  /** Hashes that were cleaned up (best-effort deleted) */
  cleanedUpHashes: string[]
}

// ─── Main ───

/**
 * Safely update the LKH tree on Blossom and re-publish the hub event.
 *
 * Flow:
 * 1. Upload new tree file
 * 2. Verify new tree is downloadable (HEAD check)
 * 3. Upload new history file (if epoch bumped)
 * 4. Upload ban pages (if provided)
 * 5. Upload new index file
 * 6. Verify new index is downloadable and contains correct tree hash
 * 7. Re-publish hub event with new index hash
 * 8. Cleanup: DELETE old tree, index, history hashes (best-effort)
 *
 * If ANY step 1–7 fails, we abort and throw — old files stay intact.
 */
export async function safeTreeUpdate(params: SafeTreeUpdateParams): Promise<SafeTreeUpdateResult> {
  const {
    hub,
    signer,
    privateKey,
    newTreeContent,
    newEpoch: epochOverride,
    newHubSecret,
    oldHubSecret,
    banEntries,
    preserveGroupTrees = true,
    skipPublish = false,
  } = params

  const epoch = epochOverride ?? hub.epoch

  // Dynamic imports to keep bundle size manageable
  const { uploadToBlossomServers, downloadTextFromBlossom, deleteFromBlossom } = await import('./client')
  const { parseIndexFile, createIndexFile, uploadBanPages } = await import('./members')
  const { buildHubEvent } = await import('@/lib/hub/buildHubEvent')
  const { signWithSigner } = await import('@/lib/nostr/events')
  const { publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
  const { getPublishRelays } = await import('@/stores/postingBehaviourStore')

  // ── Collect old hashes for cleanup ──
  const oldHashes: string[] = []
  const oldIndexHash = hub.indexFileHash
  let oldTreeHash = ''
  let oldHistoryHash = ''
  let existingGroupTrees: Array<{ groupId: string; hash: string }> = []

  if (oldIndexHash && hub.blossomServers.length > 0) {
    try {
      const oldIndexContent = await downloadTextFromBlossom(oldIndexHash, hub.blossomServers)
      const oldIndex = parseIndexFile(oldIndexContent)
      oldTreeHash = oldIndex.treeHash
      oldHistoryHash = oldIndex.historyHash
      existingGroupTrees = oldIndex.groupTrees
    } catch {
      console.warn('safeTreeUpdate: could not download old index for cleanup tracking')
    }
  }

  // ── Step 1: Upload new tree ──
  const treeBytes = new TextEncoder().encode(newTreeContent)
  const { hash: newTreeHash } = await uploadToBlossomServers(
    treeBytes, signer, privateKey, hub.blossomServers, 'text/plain',
  )

  // ── Step 2: Verify new tree is downloadable ──
  await verifyFileExists(newTreeHash, hub.blossomServers)

  // ── Step 3: Upload new history (if epoch bumped — single-blob format) ──
  let newHistoryHash = oldHistoryHash
  if (newHubSecret && oldHubSecret && epoch !== hub.epoch) {
    const { aesEncrypt, aesDecrypt } = await import('@/lib/crypto/aes')
    const { toHex } = await import('@/lib/crypto/lkh')

    // Decrypt existing history blob
    let historyPlaintext = ''
    if (oldHistoryHash) {
      try {
        const historyBlob = await downloadTextFromBlossom(oldHistoryHash, hub.blossomServers)
        historyPlaintext = await aesDecrypt(oldHubSecret, historyBlob)
      } catch { /* start fresh */ }
    }

    // Build updated plaintext lines
    const lines = historyPlaintext ? historyPlaintext.split('\n').filter(l => l.trim()) : []
    const oldSecretHex = toHex(oldHubSecret)
    const newSecretHex = toHex(newHubSecret)
    // Add old epoch secret if not already present
    if (!lines.some(l => l.startsWith(`hub:${hub.epoch}:`))) {
      lines.push(`hub:${hub.epoch}:${oldSecretHex}`)
    }
    // Add/replace new epoch
    const newIdx = lines.findIndex(l => l.startsWith(`hub:${epoch}:`))
    if (newIdx >= 0) lines[newIdx] = `hub:${epoch}:${newSecretHex}`
    else lines.push(`hub:${epoch}:${newSecretHex}`)

    // Re-encrypt as single blob with new secret
    const updatedBlob = await aesEncrypt(newHubSecret, lines.join('\n'))
    const historyBytes = new TextEncoder().encode(updatedBlob)
    const { hash: hHash } = await uploadToBlossomServers(
      historyBytes, signer, privateKey, hub.blossomServers, 'text/plain',
    )
    newHistoryHash = hHash
  }

  // ── Step 4: Upload ban pages (if provided) ──
  let banPageHashes: string[] = []
  if (banEntries && banEntries.length > 0) {
    banPageHashes = await uploadBanPages(banEntries, signer, privateKey, hub.blossomServers)
  }

  // ── Step 5: Upload new index ──
  const groupTrees = preserveGroupTrees ? existingGroupTrees : undefined
  const newIndexContent = createIndexFile(
    newTreeHash,
    banPageHashes,
    newHistoryHash || undefined,
    groupTrees && groupTrees.length > 0 ? groupTrees : undefined,
  )
  const indexBytes = new TextEncoder().encode(newIndexContent)
  const { hash: newIndexHash } = await uploadToBlossomServers(
    indexBytes, signer, privateKey, hub.blossomServers, 'text/plain',
  )

  // ── Step 6: Verify new index is correct ──
  const verifyIndexContent = await downloadTextFromBlossom(newIndexHash, hub.blossomServers)
  const verifyIndex = parseIndexFile(verifyIndexContent)
  if (verifyIndex.treeHash !== newTreeHash) {
    throw new Error(
      `safeTreeUpdate: index verification failed — expected tree ${newTreeHash}, got ${verifyIndex.treeHash}`
    )
  }

  // ── Step 7: Re-publish hub event ──
  // When skipPublish is true, the caller will publish its own hub event
  // with updated data (e.g., bumped groupedRoles epochs after group rotation).
  if (!skipPublish) {
    const unsignedEvent = buildHubEvent({
      dTag: hub.dTag,
      name: hub.name,
      description: hub.description || undefined,
      epoch,
      icon: hub.icon,
      banner: hub.banner,
      tags: hub.tags,
      relays: [...hub.generalRelays, ...hub.filterRelays],
      blossomServers: hub.blossomServers,
      indexFileHash: newIndexHash,
      channels: hub.channels,
      categories: hub.categories,
      roles: hub.roles,
      minPow: hub.minPow > 0 ? hub.minPow : undefined,
      nsfw: hub.nsfw || undefined,
      discoverable: hub.discoverable,
      groupedRoles: hub.groupedRoles,
      publishedAt: hub.publishedAt,

    })
    const signedEvent = await signWithSigner(unsignedEvent, signer, privateKey)
    await publishToSpecificRelays(
      getPublishRelays([...hub.generalRelays, ...hub.filterRelays]),
      signedEvent,
    )
  }

  // ── Step 8: Cleanup old files (best-effort) ──
  // ONLY runs after all verifications passed
  const cleanedUpHashes: string[] = []

  if (oldTreeHash && oldTreeHash !== newTreeHash) {
    oldHashes.push(oldTreeHash)
  }
  if (oldIndexHash && oldIndexHash !== newIndexHash) {
    oldHashes.push(oldIndexHash)
  }
  if (oldHistoryHash && newHubSecret && oldHistoryHash !== newHistoryHash) {
    oldHashes.push(oldHistoryHash)
  }
  // Remove updated pages that are no longer referenced
  for (const hash of oldHashes) {
    try {
      await deleteFromBlossom(hash, signer, privateKey, hub.blossomServers)
      cleanedUpHashes.push(hash)
    } catch {
      // Never throw on cleanup failure
      console.warn(`safeTreeUpdate: cleanup of ${hash} failed (non-fatal)`)
    }
  }

  console.log(`safeTreeUpdate: success. New index: ${newIndexHash}, cleaned up ${cleanedUpHashes.length} old files`)

  return { newIndexHash, newEpoch: epoch, cleanedUpHashes }
}

// ═══════════════════════════════════════════════════════════════════════
// Paginated Safe Tree Update
// ═══════════════════════════════════════════════════════════════════════

export interface SafePaginatedTreeUpdateParams {
  hub: HubData
  signer: ISigner | null
  privateKey: string | null

  /** Updated pages (page content has already been rebuilt) */
  updatedPages: Array<{
    pageIndex: number
    content: string        // serialized page content
    firstPubkey: string    // first pubkey in this page (for index)
  }>

  /** New pages created by a split */
  newPages?: Array<{
    content: string
    firstPubkey: string
  }>

  /** Page indices to remove (after merge — rare) */
  removedPageIndices?: number[]

  /** Spine is ALWAYS rebuilt (since page roots changed) */
  newSpineContent: string

  /** Epoch / secret rotation (same as monolithic) */
  newEpoch?: number
  newHubSecret?: Uint8Array
  oldHubSecret?: Uint8Array

  /** Ban entries (replaces existing ban pages) */
  banEntries?: BanEntry[]

  /** Whether to preserve existing group tree refs in the index */
  preserveGroupTrees?: boolean

  /** Skip publishing the hub event (caller will publish) */
  skipPublish?: boolean

  /** Pre-fetched old index data — avoids redundant download if caller already has it */
  existingIndexData?: {
    spineHash: string
    historyHash: string
    groupTrees: Array<{ groupId: string; hash: string }>
    leafPages: Array<{ pageIndex: number; firstPubkey: string; hash: string }>
  }

  /** Progress callback — called at each major step for UI feedback */
  onStep?: (step: string) => void
}

/**
 * Safely update the paginated LKH tree on Blossom.
 *
 * Flow:
 * 1. Download old index → collect old hashes for cleanup
 * 2. Upload each updated page → verify each exists (HEAD check)
 * 3. Upload new pages from splits → verify
 * 4. Upload spine → verify
 * 5. Upload history (if epoch bumped)
 * 6. Upload ban pages (if provided)
 * 7. Build new index with updated page list + spine hash
 * 8. Upload index → verify (download + parse + check spine hash)
 * 9. Publish hub event (unless skipPublish)
 * 10. Cleanup: delete old page/spine/index hashes (best-effort)
 */
export async function safePaginatedTreeUpdate(params: SafePaginatedTreeUpdateParams): Promise<SafeTreeUpdateResult> {
  const {
    hub, signer, privateKey,
    updatedPages, newPages = [], removedPageIndices = [],
    newSpineContent,
    newEpoch: epochOverride,
    newHubSecret, oldHubSecret,
    banEntries,
    preserveGroupTrees = true,
    skipPublish = false,
    existingIndexData,
    onStep,
  } = params

  const epoch = epochOverride ?? hub.epoch

  const { uploadToBlossomServers, downloadTextFromBlossom, deleteFromBlossom } = await import('./client')
  const { parseIndexFile, createPaginatedIndexFile, uploadBanPages } = await import('./members')
  const { buildHubEvent } = await import('@/lib/hub/buildHubEvent')
  const { signWithSigner } = await import('@/lib/nostr/events')
  const { publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
  const { getPublishRelays } = await import('@/stores/postingBehaviourStore')

  // ── Collect old hashes for cleanup ──
  const oldHashes: string[] = []
  const oldIndexHash = hub.indexFileHash
  let oldSpineHash = ''
  let oldHistoryHash = ''
  let existingGroupTrees: Array<{ groupId: string; hash: string }> = []
  let existingLeafPages: Array<{ pageIndex: number; firstPubkey: string; hash: string }> = []

  if (existingIndexData) {
    // Use pre-fetched data — avoids redundant network download
    oldSpineHash = existingIndexData.spineHash
    oldHistoryHash = existingIndexData.historyHash
    existingGroupTrees = existingIndexData.groupTrees
    existingLeafPages = existingIndexData.leafPages
  } else if (oldIndexHash && hub.blossomServers.length > 0) {
    try {
      const oldIndexContent = await downloadTextFromBlossom(oldIndexHash, hub.blossomServers)
      const oldIndex = parseIndexFile(oldIndexContent)
      oldSpineHash = oldIndex.spineHash
      oldHistoryHash = oldIndex.historyHash
      existingGroupTrees = oldIndex.groupTrees
      existingLeafPages = oldIndex.leafPages
    } catch {
      console.warn('safePaginatedTreeUpdate: could not download old index for cleanup tracking')
    }
  }

  // ── Step 1-3: Upload all pages + spine in parallel ──
  onStep?.('Uploading leaf pages & spine')
  const updatedPageHashes = new Map<number, { firstPubkey: string; hash: string }>()
  const nextPageIndex = existingLeafPages.length > 0
    ? Math.max(...existingLeafPages.map(p => p.pageIndex)) + 1
    : updatedPages.length
  const newPageEntries: Array<{ pageIndex: number; firstPubkey: string; hash: string }> = []

  // Build all upload tasks (pages + new pages + spine)
  const uploadTasks: Promise<void>[] = []
  let newSpineHash = ''

  // Updated pages
  for (const page of updatedPages) {
    uploadTasks.push((async () => {
      const pageBytes = new TextEncoder().encode(page.content)
      const { hash } = await uploadToBlossomServers(
        pageBytes, signer, privateKey, hub.blossomServers, 'text/plain',
      )
      await verifyFileExists(hash, hub.blossomServers)
      updatedPageHashes.set(page.pageIndex, { firstPubkey: page.firstPubkey, hash })
    })())
  }

  // New pages from splits
  for (let i = 0; i < newPages.length; i++) {
    const idx = i
    uploadTasks.push((async () => {
      const pageBytes = new TextEncoder().encode(newPages[idx].content)
      const { hash } = await uploadToBlossomServers(
        pageBytes, signer, privateKey, hub.blossomServers, 'text/plain',
      )
      await verifyFileExists(hash, hub.blossomServers)
      newPageEntries.push({
        pageIndex: nextPageIndex + idx,
        firstPubkey: newPages[idx].firstPubkey,
        hash,
      })
    })())
  }

  // Spine (parallel with pages — independent file)
  uploadTasks.push((async () => {
    const spineBytes = new TextEncoder().encode(newSpineContent)
    const { hash } = await uploadToBlossomServers(
      spineBytes, signer, privateKey, hub.blossomServers, 'text/plain',
    )
    await verifyFileExists(hash, hub.blossomServers)
    newSpineHash = hash
  })())

  // Wait for ALL page + spine uploads to complete
  await Promise.all(uploadTasks)

  // ── Step 5: Upload history (if epoch bumped) ──
  if (newHubSecret && oldHubSecret && epoch !== hub.epoch) onStep?.('Uploading epoch history')
  let newHistoryHash = oldHistoryHash
  if (newHubSecret && oldHubSecret && epoch !== hub.epoch) {
    const { aesEncrypt, aesDecrypt } = await import('@/lib/crypto/aes')
    const { toHex } = await import('@/lib/crypto/lkh')

    let historyPlaintext = ''
    if (oldHistoryHash) {
      try {
        const historyBlob = await downloadTextFromBlossom(oldHistoryHash, hub.blossomServers)
        historyPlaintext = await aesDecrypt(oldHubSecret, historyBlob)
      } catch { /* start fresh */ }
    }

    const lines = historyPlaintext ? historyPlaintext.split('\n').filter(l => l.trim()) : []
    const oldSecretHex = toHex(oldHubSecret)
    const newSecretHex = toHex(newHubSecret)
    if (!lines.some(l => l.startsWith(`hub:${hub.epoch}:`))) {
      lines.push(`hub:${hub.epoch}:${oldSecretHex}`)
    }
    const newIdx = lines.findIndex(l => l.startsWith(`hub:${epoch}:`))
    if (newIdx >= 0) lines[newIdx] = `hub:${epoch}:${newSecretHex}`
    else lines.push(`hub:${epoch}:${newSecretHex}`)

    const updatedBlob = await aesEncrypt(newHubSecret, lines.join('\n'))
    const historyBytes = new TextEncoder().encode(updatedBlob)
    const { hash: hHash } = await uploadToBlossomServers(
      historyBytes, signer, privateKey, hub.blossomServers, 'text/plain',
    )
    newHistoryHash = hHash
  }

  // ── Step 6: Upload ban pages ──
  let banPageHashes: string[] = []
  if (banEntries && banEntries.length > 0) {
    banPageHashes = await uploadBanPages(banEntries, signer, privateKey, hub.blossomServers)
  }

  // ── Step 7: Build new index ──
  onStep?.('Building & uploading index')
  // Start with existing pages, apply updates and additions
  const removedSet = new Set(removedPageIndices)
  const finalPages = existingLeafPages
    .filter(p => !removedSet.has(p.pageIndex))
    .map(p => {
      const updated = updatedPageHashes.get(p.pageIndex)
      return updated ? { pageIndex: p.pageIndex, firstPubkey: updated.firstPubkey, hash: updated.hash } : p
    })
    .concat(newPageEntries)

  const groupTrees = preserveGroupTrees ? existingGroupTrees : undefined
  const newIndexContent = createPaginatedIndexFile(
    newSpineHash,
    finalPages,
    banPageHashes,
    newHistoryHash || undefined,
    groupTrees && groupTrees.length > 0 ? groupTrees : undefined,
  )
  const indexBytes = new TextEncoder().encode(newIndexContent)
  const { hash: newIndexHash } = await uploadToBlossomServers(
    indexBytes, signer, privateKey, hub.blossomServers, 'text/plain',
  )

  // ── Step 8: Verify index ──
  onStep?.('Verifying uploads')
  const verifyIndexContent = await downloadTextFromBlossom(newIndexHash, hub.blossomServers)
  const verifyIndex = parseIndexFile(verifyIndexContent)
  if (verifyIndex.spineHash !== newSpineHash) {
    throw new Error(
      `safePaginatedTreeUpdate: index verification failed — expected spine ${newSpineHash}, got ${verifyIndex.spineHash}`
    )
  }

  // ── Step 9: Re-publish hub event ──
  if (!skipPublish) {
    onStep?.('Signing hub event')
    const unsignedEvent = buildHubEvent({
      dTag: hub.dTag,
      name: hub.name,
      description: hub.description || undefined,
      epoch,
      icon: hub.icon,
      banner: hub.banner,
      tags: hub.tags,
      relays: [...hub.generalRelays, ...hub.filterRelays],
      blossomServers: hub.blossomServers,
      indexFileHash: newIndexHash,
      channels: hub.channels,
      categories: hub.categories,
      roles: hub.roles,
      minPow: hub.minPow > 0 ? hub.minPow : undefined,
      nsfw: hub.nsfw || undefined,
      discoverable: hub.discoverable,
      groupedRoles: hub.groupedRoles,
      publishedAt: hub.publishedAt,

    })
    const signedEvent = await signWithSigner(unsignedEvent, signer, privateKey)
    onStep?.('Publishing to relays')
    await publishToSpecificRelays(
      getPublishRelays([...hub.generalRelays, ...hub.filterRelays]),
      signedEvent,
    )
  }

  // ── Step 10: Cleanup old files ──
  onStep?.('Cleaning up old files')
  const cleanedUpHashes: string[] = []

  // Old spine
  if (oldSpineHash && oldSpineHash !== newSpineHash) {
    oldHashes.push(oldSpineHash)
  }
  // Old index
  if (oldIndexHash && oldIndexHash !== newIndexHash) {
    oldHashes.push(oldIndexHash)
  }
  // Old history
  if (oldHistoryHash && newHubSecret && oldHistoryHash !== newHistoryHash) {
    oldHashes.push(oldHistoryHash)
  }
  // Old page hashes that were replaced
  for (const [pageIdx, newEntry] of updatedPageHashes) {
    const oldPage = existingLeafPages.find(p => p.pageIndex === pageIdx)
    if (oldPage && oldPage.hash !== newEntry.hash) {
      oldHashes.push(oldPage.hash)
    }
  }

  // Fire all cleanup deletes in parallel (best-effort, non-blocking)
  const cleanupResults = await Promise.allSettled(
    oldHashes.map(hash =>
      deleteFromBlossom(hash, signer, privateKey, hub.blossomServers)
        .then(() => hash)
    )
  )
  for (const r of cleanupResults) {
    if (r.status === 'fulfilled') cleanedUpHashes.push(r.value)
  }

  console.log(`safePaginatedTreeUpdate: success. New index: ${newIndexHash}, cleaned up ${cleanedUpHashes.length} old files`)

  return { newIndexHash, newEpoch: epoch, cleanedUpHashes }
}

// ─── Helpers ───

/**
 * Verify a file exists on at least one Blossom server via HEAD request.
 * Throws if file cannot be found on any server.
 */
async function verifyFileExists(hash: string, servers: string[]): Promise<void> {
  // Fire all HEAD requests simultaneously — resolve on first success
  try {
    await Promise.any(
      servers.map(async (server) => {
        const url = `${server.replace(/\/+$/, '')}/${hash}`
        const res = await fetch(url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) throw new Error(`${res.status}`)
      })
    )
  } catch {
    throw new Error(`safeTreeUpdate: verification failed — file ${hash} not found on any Blossom server`)
  }
}
