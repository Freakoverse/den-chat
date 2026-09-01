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
  /** v2: signs Blossom upload/delete auth as the owner pseudonym O (avoids leaking R_owner). */
  authSigner?: (e: import('nostr-tools').UnsignedEvent) => Promise<import('nostr-tools').Event>
}

export interface SafeTreeUpdateResult {
  /** New index file hash (to store in hub event m tag) */
  newIndexHash: string
  /** Epoch used (may have been bumped) */
  newEpoch: number
  /** Hashes that were cleaned up (best-effort deleted) */
  cleanedUpHashes: string[]
  /**
   * Old blob hashes NOT yet deleted because `skipPublish` was set — the caller publishes the new hub
   * event itself, so it must delete these only AFTER that publish succeeds (deleting them here would strip
   * blobs the still-live hub event references → brick on the caller's publish failure).
   */
  deferredCleanupHashes?: string[]
  /** The created_at of the signed event (for +1 pattern on future updates) */
  eventCreatedAt?: number
  /** Blossom servers that accepted the new index file (subset of targetedServers). */
  uploadedServers?: string[]
  /** Blossom servers the upload targeted. */
  targetedServers?: string[]
  /** Relays that accepted the published hub event (subset of targetedRelays). */
  publishedRelays?: string[]
  /** Relays the hub event was published to. */
  targetedRelays?: string[]
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
    authSigner,
  } = params

  const epoch = epochOverride ?? hub.epoch

  // Dynamic imports to keep bundle size manageable
  const { uploadToBlossomServers, downloadTextFromBlossom, deleteFromBlossom } = await import('./client')
  const { parseIndexFile, createIndexFile, uploadBanPages } = await import('./members')
  const { buildHubEvent } = await import('@/lib/hub/buildHubEvent')
  const { mineAndSign } = await import('@/lib/nostr/events')
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
    treeBytes, signer, privateKey, hub.blossomServers, 'text/plain', undefined, undefined, authSigner,
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
      historyBytes, signer, privateKey, hub.blossomServers, 'text/plain', undefined, undefined, authSigner,
    )
    newHistoryHash = hHash
  }

  // ── Step 4: Upload ban pages (if provided) ──
  let banPageHashes: string[] = []
  if (banEntries && banEntries.length > 0) {
    // v1 ban pages store real keys R in PLAINTEXT. No current v2 path passes banEntries here (v2 bans
    // go through v2kick / uploadBanPagesV2). Fail loudly rather than silently leak if that changes:
    // an authSigner being present means we're in a v2 context.
    if (authSigner) {
      throw new Error('treeUpdater: v2 ban pages must use uploadBanPagesV2 (encrypted) — not the v1 plaintext path')
    }
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
    indexBytes, signer, privateKey, hub.blossomServers, 'text/plain', undefined, undefined, authSigner,
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
  let publishedCreatedAt: number | undefined
  if (!skipPublish) {
    // Fail-closed: this path signs under the ROOT key R with PLAINTEXT content (the v1 shape). A v2 hub
    // MUST republish as O with encrypted content (republishV2*), so v2 callers pass skipPublish. Guard
    // against a future v2 caller forgetting it — that would leak R_owner AND destroy content encryption.
    const { isV2 } = await import('@/lib/hub/version')
    if (isV2(hub)) throw new Error('safeTreeUpdate: refusing to publish a v2 hub event under the root key — pass skipPublish and republish as O')
    const unsignedEvent = buildHubEvent({
      dTag: hub.dTag,
      name: hub.name,
      description: hub.description || undefined,
      epoch,
      icon: hub.icon,
      banner: hub.banner,
      tags: hub.tags,
      relays: [...hub.generalRelays],
      blossomServers: hub.blossomServers,
      indexFileHash: newIndexHash,
      channels: hub.channels,
      categories: hub.categories,
      roles: hub.roles,
      minPow: hub.minPow > 0 ? hub.minPow : undefined,
      joinMinPow: hub.joinMinPow > 0 ? hub.joinMinPow : undefined,
      messageExpiration: hub.messageExpiration || undefined, // preserve the disappearing-messages timer
      nsfw: hub.nsfw || undefined,
      discoverable: hub.discoverable,
      groupedRoles: hub.groupedRoles,
      publishedAt: hub.publishedAt,
      eventCreatedAt: hub.eventCreatedAt,
    })
    const signedEvent = await mineAndSign(unsignedEvent, hub.minPow, hub.creatorPubkey, signer, privateKey)
    publishedCreatedAt = signedEvent.created_at
    // CAS (version-agnostic lost-update guard): abort if another writer moved the hub's index pointer
    // since this op read `hub.indexFileHash`. Fail-closed (throws on a real move OR if the current state
    // can't be confirmed) — see casCheckIndex.
    const { casCheckIndex } = await import('@/lib/hub/hubMutationGuard')
    await casCheckIndex(hub.dTag, hub.creatorPubkey, hub.indexFileHash)
    const pub = await publishToSpecificRelays(
      getPublishRelays([...hub.generalRelays]),
      signedEvent,
    )
    // Zero relays accepted → don't delete the old blobs the still-live event points at (see paginated path).
    if (pub.length === 0) throw new Error('safeTreeUpdate: hub event not accepted by any relay')
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
  // When skipPublish, the caller publishes afterward — defer deletion so we never strip blobs the still-live
  // hub event references (brick-on-publish-failure). See safePaginatedTreeUpdate for the full rationale.
  if (skipPublish) {
    return { newIndexHash, newEpoch: epoch, cleanedUpHashes, deferredCleanupHashes: oldHashes, eventCreatedAt: publishedCreatedAt }
  }

  // Remove updated pages that are no longer referenced
  for (const hash of oldHashes) {
    try {
      await deleteFromBlossom(hash, signer, privateKey, hub.blossomServers, authSigner)
      cleanedUpHashes.push(hash)
    } catch {
      // Never throw on cleanup failure
      console.warn(`safeTreeUpdate: cleanup of ${hash} failed (non-fatal)`)
    }
  }

  console.log(`safeTreeUpdate: success. New index: ${newIndexHash}, cleaned up ${cleanedUpHashes.length} old files`)

  return { newIndexHash, newEpoch: epoch, cleanedUpHashes, eventCreatedAt: publishedCreatedAt }
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
  /** v2: signs Blossom upload/delete auth as the owner pseudonym O (avoids leaking R_owner). */
  authSigner?: (e: import('nostr-tools').UnsignedEvent) => Promise<import('nostr-tools').Event>

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
    authSigner,
    existingIndexData,
    onStep,
  } = params

  const epoch = epochOverride ?? hub.epoch

  const { uploadToBlossomServers, downloadTextFromBlossom, deleteFromBlossom } = await import('./client')
  const { parseIndexFile, createPaginatedIndexFile, uploadBanPages } = await import('./members')
  const { buildHubEvent } = await import('@/lib/hub/buildHubEvent')
  const { mineAndSign } = await import('@/lib/nostr/events')
  const { publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
  const { getPublishRelays } = await import('@/stores/postingBehaviourStore')
  const { cacheHubBlob } = await import('./hubBlobStore')
  const { isV2 } = await import('@/lib/hub/version')
  // v2 tree blobs are uploaded under the throwaway owner pseudonym O (authSigner present),
  // which has no standing on public Blossom servers, so they get GC'd. We therefore RETAIN
  // every blob locally (a source of truth to re-upload from) and NEVER delete the prior
  // tree — keeping old pages/spine/index around is cheap redundancy and the only thing that
  // stops an accept from bricking the hub when the new blobs are dropped before they
  // replicate. See hubBlobStore / blossomRedundancy.
  const v2Hub = isV2(hub)

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
        pageBytes, signer, privateKey, hub.blossomServers, 'text/plain', undefined, undefined, authSigner,
      )
      await cacheHubBlob(hash, pageBytes, hub.dTag) // local source of truth (see top of fn)
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
        pageBytes, signer, privateKey, hub.blossomServers, 'text/plain', undefined, undefined, authSigner,
      )
      await cacheHubBlob(hash, pageBytes, hub.dTag)
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
      spineBytes, signer, privateKey, hub.blossomServers, 'text/plain', undefined, undefined, authSigner,
    )
    await cacheHubBlob(hash, spineBytes, hub.dTag)
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
      historyBytes, signer, privateKey, hub.blossomServers, 'text/plain', undefined, undefined, authSigner,
    )
    await cacheHubBlob(hHash, historyBytes, hub.dTag)
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
  const { hash: newIndexHash, serverUrls: indexServerUrls } = await uploadToBlossomServers(
    indexBytes, signer, privateKey, hub.blossomServers, 'text/plain', undefined, undefined, authSigner,
  )
  await cacheHubBlob(newIndexHash, indexBytes, hub.dTag)

  // ── Step 8: Verify index ──
  onStep?.('Verifying uploads')
  const verifyIndexContent = await downloadTextFromBlossom(newIndexHash, hub.blossomServers)
  const verifyIndex = parseIndexFile(verifyIndexContent)
  if (verifyIndex.spineHash !== newSpineHash) {
    throw new Error(
      `safePaginatedTreeUpdate: index verification failed — expected spine ${newSpineHash}, got ${verifyIndex.spineHash}`
    )
  }
  // Durability push (best-effort, background): fan the new index+spine+pages out toward a
  // safe copy-count across ALL candidate servers (hub → client → user lists), re-uploading
  // from the local retention store if a server already dropped one. Signed as O for v2 so
  // it stays pseudonymous. Not awaited — the local copies above already guarantee the tree
  // can be healed on next load; this just front-runs that healing.
  try {
    const durabilityTargets = [
      { hash: newIndexHash, label: `${hub.dTag} index` },
      { hash: newSpineHash, label: `${hub.dTag} spine` },
      ...Array.from(updatedPageHashes.values()).map(e => ({ hash: e.hash, label: `${hub.dTag} page` })),
      ...newPageEntries.map(e => ({ hash: e.hash, label: `${hub.dTag} page` })),
    ]
    void import('./blossomRedundancy').then(({ ensureHubBlobsDurable }) =>
      ensureHubBlobsDurable(hub, durabilityTargets, { authSigner }),
    ).catch(() => {})
  } catch { /* durability is best-effort */ }

  // ── Step 9: Re-publish hub event ──
  let publishedCreatedAt: number | undefined
  let targetedRelays: string[] = []
  let publishedRelays: string[] = []
  if (!skipPublish) {
    // Fail-closed (see safeTreeUpdate): v2 must republish as O with encrypted content, never here under R.
    if (v2Hub) throw new Error('safePaginatedTreeUpdate: refusing to publish a v2 hub event under the root key — pass skipPublish and republish as O')
    onStep?.('Signing hub event')
    const unsignedEvent = buildHubEvent({
      dTag: hub.dTag,
      name: hub.name,
      description: hub.description || undefined,
      epoch,
      icon: hub.icon,
      banner: hub.banner,
      tags: hub.tags,
      relays: [...hub.generalRelays],
      blossomServers: hub.blossomServers,
      indexFileHash: newIndexHash,
      channels: hub.channels,
      categories: hub.categories,
      roles: hub.roles,
      minPow: hub.minPow > 0 ? hub.minPow : undefined,
      joinMinPow: hub.joinMinPow > 0 ? hub.joinMinPow : undefined,
      messageExpiration: hub.messageExpiration || undefined, // preserve the disappearing-messages timer
      nsfw: hub.nsfw || undefined,
      discoverable: hub.discoverable,
      groupedRoles: hub.groupedRoles,
      publishedAt: hub.publishedAt,
      eventCreatedAt: hub.eventCreatedAt,
    })
    const signedEvent = await mineAndSign(unsignedEvent, hub.minPow, hub.creatorPubkey, signer, privateKey)
    publishedCreatedAt = signedEvent.created_at
    onStep?.('Publishing to relays')
    // CAS (version-agnostic): abort if another writer moved the index pointer since this op started
    // (fail-closed — throws on move OR if the current state can't be confirmed).
    const { casCheckIndex } = await import('@/lib/hub/hubMutationGuard')
    await casCheckIndex(hub.dTag, hub.creatorPubkey, hub.indexFileHash)
    targetedRelays = getPublishRelays([...hub.generalRelays])
    publishedRelays = await publishToSpecificRelays(targetedRelays, signedEvent)
    // publishToSpecificRelays returns [] (not a throw) when every relay rejected. If the new hub event
    // landed nowhere, the cleanup below would delete the OLD index/spine/pages the still-live event points
    // at → brick. Fail loudly instead so cleanup is skipped and the caller doesn't advance local state.
    if (publishedRelays.length === 0) throw new Error('safePaginatedTreeUpdate: hub event not accepted by any relay')
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

  // When skipPublish, the CALLER publishes the new hub event AFTER we return. Deleting the old blobs now
  // would remove them while the LIVE hub event still points at the old index → any reader loading during
  // the caller's publish window (or if that publish fails) can't fetch the tree. Defer: hand the hashes
  // back for the caller to delete only after its own publish succeeds.
  //
  // For v2, go further and DON'T delete the prior tree at all (return no deferred hashes): those blobs are
  // stored under the throwaway owner pseudonym O on public servers that GC them, and the new blobs can be
  // dropped before they replicate. Keeping the old pages/spine/index is cheap redundancy and, together with
  // local retention, is what stops a membership change from bricking the hub. Public servers GC the orphans
  // on their own; we just stop racing them.
  if (skipPublish) {
    return {
      newIndexHash,
      newEpoch: epoch,
      cleanedUpHashes,
      deferredCleanupHashes: v2Hub ? [] : oldHashes,
      eventCreatedAt: publishedCreatedAt,
      uploadedServers: indexServerUrls,
      targetedServers: hub.blossomServers,
      publishedRelays,
      targetedRelays,
    }
  }

  // Fire all cleanup deletes in parallel (best-effort, non-blocking)
  const cleanupResults = await Promise.allSettled(
    oldHashes.map(hash =>
      deleteFromBlossom(hash, signer, privateKey, hub.blossomServers, authSigner)
        .then(() => hash)
    )
  )
  for (const r of cleanupResults) {
    if (r.status === 'fulfilled') cleanedUpHashes.push(r.value)
  }

  console.log(`safePaginatedTreeUpdate: success. New index: ${newIndexHash}, cleaned up ${cleanedUpHashes.length} old files`)

  return {
    newIndexHash,
    newEpoch: epoch,
    cleanedUpHashes,
    eventCreatedAt: publishedCreatedAt,
    uploadedServers: indexServerUrls,
    targetedServers: hub.blossomServers,
    publishedRelays,
    targetedRelays,
  }
}

// ─── Helpers ───

/**
 * Verify a file exists on at least one Blossom server via HEAD request.
 * Throws if file cannot be found on any server.
 */
export async function verifyFileExists(hash: string, servers: string[]): Promise<void> {
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
