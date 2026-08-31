/**
 * NIP-CHAT v2 — kick a member (remove from the tree + rotate the hub secret).
 *
 * Self-contained so it can be wired into the existing v1-shaped ban/remove handlers via a
 * clean `if (isV2(hub))` branch without touching the v1 path. It mirrors the v1 paginated
 * remove+rotate (one page + spine + history), but:
 *   - the member is located + removed by their pseudonym `P` (leaf id), not their real key;
 *   - the touched page's group-encrypted roster segment is re-written under the NEW epoch
 *     (forward-secret identity — the kicked member can't read members added later);
 *   - the hub event is re-published as the owner `O` with its content re-encrypted under the
 *     new epoch key (via `republishV2HubRotate`).
 *
 * Only the kicked member's page + the spine + history + index are rewritten — v1-parity cost,
 * even at 10M members. Requires a local key or an SKD signer (owner-side sub-key ops).
 */

import type { HubData } from '@/stores/hubStore'
import type { ISigner } from '@/stores/userStore'

/**
 * Resolve a member's leaf id `P` from their real key `R` by scanning the roster segments —
 * works for **any** signer (uses the hub-secret-derived roster key, never the signer). Used as
 * a fallback when `HubMember.p` isn't cached and the owner uses a remote signer (so the local
 * `deriveMemberPseudonymForOwner` ECDH shortcut isn't available). O(pages) downloads, but a
 * kick is rare and `p` is normally cached, so this seldom runs.
 */
export async function resolveMemberPByRoster(opts: {
  hub: HubData
  memberR: string
  /** Epoch→secretHex history (roster segments are stamped per-epoch). */
  epochSecrets: Record<number, string>
}): Promise<string | null> {
  const { hub, memberR, epochSecrets } = opts
  if (!hub.indexFileHash || hub.blossomServers.length === 0) return null
  const { downloadTextFromBlossom, parseIndexFile } = await import('@/lib/blossom')
  const { deserializeLeafPage, fromHex } = await import('@/lib/crypto/lkh')
  const { decryptRoster } = await import('@/lib/hub/hubContent')
  try {
    const index = parseIndexFile(await downloadTextFromBlossom(hub.indexFileHash, hub.blossomServers))
    for (const pageEntry of index.leafPages) {
      try {
        const page = deserializeLeafPage(await downloadTextFromBlossom(pageEntry.hash, hub.blossomServers))
        if (!page.rosterBlob) continue
        const secretHex = epochSecrets[page.rosterEpoch ?? 0]
        if (!secretHex) continue
        const roster = await decryptRoster(fromHex(secretHex), page.rosterBlob, page.rosterEpoch ?? 0)
        for (const [p, r] of Object.entries(roster)) if (r === memberR) return p
      } catch { /* skip unreadable page */ }
    }
  } catch { /* index unreadable */ }
  return null
}

export interface KickMemberV2Result {
  newIndexHash: string
  newEpoch: number
  newSecretHex: string
  /** Full epoch→secretHex map after the rotation (for `setEpochSecrets`). */
  epochMap: Record<number, string>
  /** v2 group rotation: groupId → new secretHex (for `setGroupSecret`). */
  groupSecrets: Record<string, string>
  /** Updated grouped_roles (bumped epochs for rotated groups), for the store. Undefined = unchanged. */
  groupedRoles?: Array<{ groupId: string; roleIds: string[]; epoch: number }>
  /** Group ids that FAILED to re-key (kicked member retains access) — surface to the owner. */
  groupsNotRotated?: string[]
  eventCreatedAt?: number
  publishedRelays: string[]
  targetedRelays: string[]
}

/** A group tree to (re)build: its id + the qualifying members' {p,r}. */
export interface GroupRebuild {
  groupId: string
  members: Array<{ p: string; r: string }>
}

/**
 * Build fresh v2 (P-keyed) group trees with new secrets. Returns the index refs + the new
 * secrets (groupId → hex). Empty-member groups are skipped.
 */
async function buildV2GroupTrees(
  groupRebuilds: GroupRebuild[],
  hubDTag: string,
  privateKey: string | null,
  signer: ISigner | null,
  blossomServers: string[],
): Promise<{ refs: Array<{ groupId: string; hash: string }>; secrets: Record<string, string> }> {
  const { createAndUploadGroupTreeV2 } = await import('@/lib/blossom')
  const { toHex } = await import('@/lib/crypto/lkh')
  const refs: Array<{ groupId: string; hash: string }> = []
  const secrets: Record<string, string> = {}
  for (const g of groupRebuilds) {
    if (g.members.length === 0) continue
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const hash = await createAndUploadGroupTreeV2(g.members, secret, hubDTag, privateKey, signer, blossomServers)
    refs.push({ groupId: g.groupId, hash })
    secrets[g.groupId] = toHex(secret)
  }
  return { refs, secrets }
}

/**
 * Remove one member (by pseudonym `P`) from the given groups INCREMENTALLY: download each group's
 * existing tree, drop the `P` leaf, rotate the secret, re-upload. Preserves every OTHER leaf —
 * including members on roster pages the owner's client never loaded — because it edits the tree
 * itself rather than rebuilding from the (possibly partial) in-memory roster.
 */
async function removeMemberFromGroupsV2(
  memberP: string,
  groups: Array<{ groupId: string; currentSecretHex: string }>,
  oldGroupTrees: Array<{ groupId: string; hash: string }>,
  hubDTag: string,
  privateKey: string | null,
  signer: ISigner | null,
  blossomServers: string[],
): Promise<{ refs: Array<{ groupId: string; hash: string }>; secrets: Record<string, string>; failed: string[] }> {
  const { removeMemberFromGroupTreeV2, downloadTextFromBlossom } = await import('@/lib/blossom')
  const { toHex, fromHex } = await import('@/lib/crypto/lkh')
  const { uploadToBlossomServers } = await import('@/lib/blossom/client')
  const { makeSubkeySigner } = await import('@/lib/nostr/v2send')
  const { ChatContext } = await import('@/lib/crypto/skd')
  const ownerSigner = makeSubkeySigner(ChatContext.owner(hubDTag), { privateKey, signer })
  const ownerAuth = (e: import('nostr-tools').UnsignedEvent) => ownerSigner.signEvent(e)
  const refs: Array<{ groupId: string; hash: string }> = []
  const secrets: Record<string, string> = {}
  const failed: string[] = []
  for (const g of groups) {
    // Isolate each group: a failure (e.g. removeLeaf throwing on a last-member tree) must not abort
    // the whole kick — the page/spine/ban already uploaded and the hub event still needs publishing.
    // BUT a skipped group is NOT revoked: the kicked member keeps that group's secret + read access, so
    // we RECORD the failure and surface it to the owner (below) instead of only console.warn-ing.
    try {
      const oldHash = oldGroupTrees.find(gt => gt.groupId === g.groupId)?.hash
      if (!oldHash) continue
      const treeContent = await downloadTextFromBlossom(oldHash, blossomServers)
      const r = await removeMemberFromGroupTreeV2(treeContent, memberP, fromHex(g.currentSecretHex), hubDTag, privateKey, signer)
      if (!r) continue // member wasn't a leaf — nothing to remove
      const { hash } = await uploadToBlossomServers(
        new TextEncoder().encode(r.newTreeContent), signer, privateKey, blossomServers, 'text/plain', undefined, undefined, ownerAuth,
      )
      refs.push({ groupId: g.groupId, hash })
      secrets[g.groupId] = toHex(r.newGroupSecret)
    } catch (err) {
      console.warn(`[v2kick] group ${g.groupId.slice(0, 8)} removal failed, skipping:`, err)
      failed.push(g.groupId)
    }
  }
  return { refs, secrets, failed }
}

export async function kickMemberV2(opts: {
  hub: HubData
  /** The kicked member's real key `R` (for history/ban bookkeeping by the caller). */
  memberR: string
  /** The kicked member's pseudonym `P` — the leaf id to remove. */
  memberP: string
  /** Current hub secret (bytes). */
  oldSecret: Uint8Array
  /** Epoch→secretHex history (for rehydrating old-epoch roster segments). */
  epochSecrets: Record<number, string>
  /** Full updated ban set (real keys `R`, incl. the kicked member) → encrypted ban page under the new secret. Omit to preserve existing ban pages. */
  banEntries?: Array<{ pubkey: string; reason: string }>
  /**
   * Groups the kicked member was in → remove them INCREMENTALLY (patch the existing tree so
   * off-page members are preserved) and rotate that group's secret. Each entry is the group id +
   * its CURRENT secret (hex), which the owner holds. The old tree hash is looked up from the index.
   */
  kickFromGroups?: Array<{ groupId: string; currentSecretHex: string }>
  privateKey: string | null
  signer: ISigner | null
  onStep?: (step: string) => void
}): Promise<KickMemberV2Result> {
  const { hub, memberP, oldSecret, epochSecrets, privateKey, signer, onStep } = opts

  const { downloadTextFromBlossom, uploadToBlossomServers, parseIndexFile, findPageForPubkey, createPaginatedIndexFile, uploadBanPagesV2, banPageToken } =
    await import('@/lib/blossom')
  const { rehydratePageKeysV2, removeMemberFromPageV2 } = await import('@/lib/blossom/members')
  const {
    fromHex, toHex, deserializeSpine, recoverPageRootKeys, buildSpine,
    serializeLeafPage, serializeSpine,
  } = await import('@/lib/crypto/lkh')
  const { aesEncrypt, aesDecrypt } = await import('@/lib/crypto/aes')
  const { makeSubkeySigner } = await import('@/lib/nostr/v2send')
  const { ChatContext } = await import('@/lib/crypto/skd')
  const { republishV2HubRotate } = await import('@/lib/hub/republishV2')

  if (!hub.indexFileHash || hub.blossomServers.length === 0) {
    throw new Error('kickMemberV2: hub has no index / blossom servers')
  }

  const ownerSigner = makeSubkeySigner(ChatContext.owner(hub.dTag), { privateKey, signer })
  // Sign Blossom upload auth as the owner pseudonym O (never R_owner → no leak to the server).
  const ownerAuth = (e: import('nostr-tools').UnsignedEvent) => ownerSigner.signEvent(e)
  const resolveEpochSecret = (epoch: number): Uint8Array | undefined =>
    epochSecrets[epoch] ? fromHex(epochSecrets[epoch]) : (epoch === hub.epoch ? oldSecret : undefined)

  // 1. Download index + locate the kicked member's page by P.
  onStep?.('Downloading index & tree')
  const indexContent = await downloadTextFromBlossom(hub.indexFileHash, hub.blossomServers)
  const index = parseIndexFile(indexContent)
  if (!index.spineHash || index.leafPages.length === 0) throw new Error('kickMemberV2: hub is not paginated')

  const pageEntry = findPageForPubkey(index, memberP)
  if (!pageEntry) throw new Error('kickMemberV2: member not found in any page')

  const [pageContent, spineContent] = await Promise.all([
    downloadTextFromBlossom(pageEntry.hash, hub.blossomServers),
    downloadTextFromBlossom(index.spineHash, hub.blossomServers),
  ])
  const spine = deserializeSpine(spineContent)

  // 2. Rehydrate the page (v2), remove the leaf, rotate the secret + re-stamp the roster.
  onStep?.('Removing member & rotating secret')
  const newEpoch = hub.epoch + 1
  const newSecret = crypto.getRandomValues(new Uint8Array(32))
  const newSecretHex = toHex(newSecret)

  const rehydrated = await rehydratePageKeysV2(pageContent, ownerSigner, resolveEpochSecret)
  const updatedPage = await removeMemberFromPageV2(rehydrated, memberP, newSecret, newEpoch)
  if (!updatedPage) throw new Error('kickMemberV2: member not on the resolved page')

  // 3. Rebuild the spine under the new secret (replace the modified page's root).
  const pageRootKeys = await recoverPageRootKeys(spine, oldSecret)
  const updatedPageRoots = pageRootKeys.map((prk, i) =>
    index.leafPages[i]?.pageIndex === pageEntry.pageIndex
      ? { nodeId: updatedPage.pageRoot.nodeId, rawKey: updatedPage.pageRoot.rawKey! }
      : prk,
  )
  const newSpine = await buildSpine(updatedPageRoots, newSecret)

  // 4. Upload the updated page + new spine.
  onStep?.('Uploading page & spine')
  const { hash: newPageHash } = await uploadToBlossomServers(
    new TextEncoder().encode(serializeLeafPage(updatedPage)), signer, privateKey, hub.blossomServers, 'text/plain', undefined, undefined, ownerAuth,
  )
  const { hash: newSpineHash } = await uploadToBlossomServers(
    new TextEncoder().encode(serializeSpine(newSpine)), signer, privateKey, hub.blossomServers, 'text/plain', undefined, undefined, ownerAuth,
  )

  // 5. Update the epoch-history blob (append old epoch, re-encrypt under the new secret).
  const lines: string[] = []
  if (index.historyHash) {
    try {
      const historyBlob = await downloadTextFromBlossom(index.historyHash, hub.blossomServers)
      const plaintext = await aesDecrypt(oldSecret, historyBlob)
      lines.push(...plaintext.split('\n').filter(l => l.trim()))
    } catch { /* start fresh */ }
  }
  const oldSecretHex = toHex(oldSecret)
  if (!lines.some(l => l.startsWith(`hub:${hub.epoch}:`))) lines.push(`hub:${hub.epoch}:${oldSecretHex}`)
  lines.push(`hub:${newEpoch}:${newSecretHex}`)
  const { hash: newHistoryHash } = await uploadToBlossomServers(
    new TextEncoder().encode(await aesEncrypt(newSecret, lines.join('\n'))), signer, privateKey, hub.blossomServers, 'text/plain', undefined, undefined, ownerAuth,
  )

  // 6. Rebuild the index (swap the one page hash; preserve ban pages + group trees).
  onStep?.('Building index')
  const finalPages = index.leafPages.map(p =>
    p.pageIndex === pageEntry.pageIndex ? { pageIndex: p.pageIndex, firstPubkey: updatedPage.leaves[0].pubkey, hash: newPageHash } : p,
  )
  // Ban list: re-encrypt the full updated set under the NEW secret (real keys R). If no set is
  // supplied, preserve the existing ban pages.
  const banPageHashes = opts.banEntries && opts.banEntries.length > 0
    ? await uploadBanPagesV2(opts.banEntries, newSecret, newEpoch, signer, privateKey, hub.blossomServers, ownerAuth)
    : index.banPages.map(banPageToken) // preserve: keep the epoch stamp

  // Remove the kicked member from any group they were in — INCREMENTALLY (patch the existing tree,
  // preserving members on other roster pages) and rotate that group's secret.
  const groupBuilt = opts.kickFromGroups && opts.kickFromGroups.length > 0
    ? await removeMemberFromGroupsV2(opts.memberP, opts.kickFromGroups, index.groupTrees, hub.dTag, privateKey, signer, hub.blossomServers)
    : { refs: [], secrets: {} as Record<string, string>, failed: [] as string[] }
  const rotatedIds = new Set(groupBuilt.refs.map(r => r.groupId))
  const finalGroupTrees = [...index.groupTrees.filter(gt => !rotatedIds.has(gt.groupId)), ...groupBuilt.refs]
  // Bump the epoch of each rotated group so new messages use the new group secret.
  const bumpedGroupedRoles = rotatedIds.size > 0 && hub.groupedRoles
    ? hub.groupedRoles.map(g => rotatedIds.has(g.groupId) ? { ...g, epoch: g.epoch + 1 } : g)
    : undefined

  const newIndexContent = createPaginatedIndexFile(
    newSpineHash,
    finalPages,
    banPageHashes,
    newHistoryHash,
    finalGroupTrees.length > 0 ? finalGroupTrees : undefined,
  )
  const { hash: newIndexHash } = await uploadToBlossomServers(
    new TextEncoder().encode(newIndexContent), signer, privateKey, hub.blossomServers, 'text/plain', undefined, undefined, ownerAuth,
  )

  // HEAD-verify the new spine + index are actually retrievable before advertising epoch N+1 in the hub
  // event — else a member reading the new event can't fetch the tree that yields the new secret, a
  // transient mis-key window. (safePaginatedTreeUpdate does the same before its publish.)
  const { verifyFileExists } = await import('@/lib/blossom/treeUpdater')
  await verifyFileExists(newSpineHash, hub.blossomServers)
  await verifyFileExists(newIndexHash, hub.blossomServers)

  // 7. Re-publish the hub event as O with content re-encrypted under the new epoch key.
  onStep?.('Publishing hub event')
  const pub = await republishV2HubRotate({
    hub, ownerPub: hub.creatorPubkey, newIndexHash, newEpoch,
    oldHubSecret: oldSecret, newHubSecret: newSecret, groupedRolesOverride: bumpedGroupedRoles, privateKey, signer,
  })

  const epochMap: Record<number, string> = {}
  for (const l of lines) {
    if (!l.startsWith('hub:')) continue
    const parts = l.split(':')
    if (parts.length >= 3) epochMap[parseInt(parts[1], 10)] = parts.slice(2).join(':')
  }

  return {
    newIndexHash,
    newEpoch,
    newSecretHex,
    epochMap,
    groupSecrets: groupBuilt.secrets,
    groupedRoles: bumpedGroupedRoles,
    /** Group ids that FAILED to rotate — the kicked member still has access to these; surface to the owner. */
    groupsNotRotated: groupBuilt.failed,
    eventCreatedAt: pub.eventCreatedAt,
    publishedRelays: pub.publishedRelays,
    targetedRelays: pub.targetedRelays,
  }
}

/**
 * NIP-CHAT v2 — "Fix hub encryption": fully re-derive the tree with a fresh secret, keeping
 * the same members. Unlike a kick (one page), this rebuilds every page — fix-encryption is a
 * rare repair, and v1 does a full rebuild too. Leaves are keyed on each member's pseudonym
 * `P`, leaf keys are re-wrapped `O→R`, each page gets a fresh roster segment stamped at the
 * new epoch, and the hub event is re-published as `O` with content re-encrypted.
 */
export async function rebuildTreeV2(opts: {
  hub: HubData
  /** Full member set (including the owner): pseudonym `p`, real key `r`, role string. */
  members: Array<{ p: string; r: string; roles: string }>
  oldSecret: Uint8Array
  /** Full ban set (real keys `R`) → re-encrypted under the NEW secret. Omit to preserve existing pages (only correct if empty). */
  banEntries?: Array<{ pubkey: string; reason: string }>
  /** All groups → rebuild each (P-keyed) with a fresh secret. Omit to preserve existing group trees. */
  groupRebuilds?: GroupRebuild[]
  privateKey: string | null
  signer: ISigner | null
  onStep?: (step: string) => void
}): Promise<KickMemberV2Result> {
  const { hub, members, oldSecret, privateKey, signer, onStep } = opts

  const { downloadTextFromBlossom, uploadToBlossomServers, parseIndexFile, createPaginatedIndexFile, uploadBanPagesV2, banPageToken } =
    await import('@/lib/blossom')
  const {
    toHex, createLeaf, buildLeafPage, buildSpine, serializeLeafPage, serializeSpine, PAGE_SIZE,
  } = await import('@/lib/crypto/lkh')
  const { aesEncrypt, aesDecrypt } = await import('@/lib/crypto/aes')
  const { encryptRoster } = await import('@/lib/hub/hubContent')
  const { makeSubkeySigner } = await import('@/lib/nostr/v2send')
  const { ChatContext } = await import('@/lib/crypto/skd')
  const { republishV2HubRotate } = await import('@/lib/hub/republishV2')

  if (hub.blossomServers.length === 0) throw new Error('rebuildTreeV2: no blossom servers')

  const ownerSigner = makeSubkeySigner(ChatContext.owner(hub.dTag), { privateKey, signer })
  // Sign Blossom upload auth as the owner pseudonym O (never R_owner → no leak to the server).
  const ownerAuth = (e: import('nostr-tools').UnsignedEvent) => ownerSigner.signEvent(e)
  const newEpoch = hub.epoch + 1
  const newSecret = crypto.getRandomValues(new Uint8Array(32))
  const newSecretHex = toHex(newSecret)

  // 1. Read the old index (preserve ban pages + group trees; get history hash).
  onStep?.('Downloading current tree')
  let oldHistoryHash = ''
  let oldBanPageHashes: string[] = []
  let oldGroupTrees: Array<{ groupId: string; hash: string }> = []
  if (hub.indexFileHash) {
    try {
      const index = parseIndexFile(await downloadTextFromBlossom(hub.indexFileHash, hub.blossomServers))
      oldHistoryHash = index.historyHash
      oldBanPageHashes = index.banPages.map(banPageToken) // preserve: keep the epoch stamp
      oldGroupTrees = [...index.groupTrees]
    } catch { /* rebuild from scratch */ }
  }

  // 2. Build fresh leaves (keyed on P, wrapped O→R), sorted by P for deterministic pages.
  onStep?.('Rebuilding member tree')
  const sorted = [...members].sort((a, b) => a.p.localeCompare(b.p))
  const leaves = []
  for (const m of sorted) {
    const leaf = createLeaf(m.p, m.roles || 'everyone')
    leaf.encryptedLeafKey = await ownerSigner.nip44Encrypt(m.r, toHex(leaf.rawKey!))
    leaves.push(leaf)
  }

  // 3. Split into pages; each gets a fresh roster segment at the new epoch.
  const pageRefs: Array<{ pageIndex: number; firstPubkey: string; hash: string }> = []
  const pageRoots: Array<{ nodeId: string; rawKey: Uint8Array }> = []
  const rByP = new Map(sorted.map(m => [m.p, m.r]))
  for (let i = 0, pi = 0; i < leaves.length; i += PAGE_SIZE, pi++) {
    const chunk = leaves.slice(i, i + PAGE_SIZE)
    const page = await buildLeafPage(chunk, pi)
    const roster: Record<string, string> = {}
    for (const l of chunk) { const r = rByP.get(l.pubkey); if (r) roster[l.pubkey] = r }
    page.roster = roster
    page.rosterEpoch = newEpoch
    page.rosterBlob = await encryptRoster(newSecret, roster, newEpoch)
    const { hash } = await uploadToBlossomServers(
      new TextEncoder().encode(serializeLeafPage(page)), signer, privateKey, hub.blossomServers, 'text/plain', undefined, undefined, ownerAuth,
    )
    pageRefs.push({ pageIndex: pi, firstPubkey: chunk[0].pubkey, hash })
    pageRoots.push({ nodeId: page.pageRoot.nodeId, rawKey: page.pageRoot.rawKey! })
  }

  // 4. Spine under the new secret.
  const { hash: newSpineHash } = await uploadToBlossomServers(
    new TextEncoder().encode(serializeSpine(await buildSpine(pageRoots, newSecret))),
    signer, privateKey, hub.blossomServers, 'text/plain', undefined, undefined, ownerAuth,
  )

  // 5. History (append old epoch, re-encrypt under the new secret).
  const lines: string[] = []
  if (oldHistoryHash) {
    try {
      lines.push(...(await aesDecrypt(oldSecret, await downloadTextFromBlossom(oldHistoryHash, hub.blossomServers)))
        .split('\n').filter(l => l.trim()))
    } catch { /* start fresh */ }
  }
  const oldSecretHex = toHex(oldSecret)
  if (!lines.some(l => l.startsWith(`hub:${hub.epoch}:`))) lines.push(`hub:${hub.epoch}:${oldSecretHex}`)
  lines.push(`hub:${newEpoch}:${newSecretHex}`)
  const { hash: newHistoryHash } = await uploadToBlossomServers(
    new TextEncoder().encode(await aesEncrypt(newSecret, lines.join('\n'))), signer, privateKey, hub.blossomServers, 'text/plain', undefined, undefined, ownerAuth,
  )

  // 6. Index — re-encrypt the ban list under the new secret (so it stays readable after the
  //    rotation); rebuild group trees under fresh secrets (else preserve).
  const banPageHashes = opts.banEntries && opts.banEntries.length > 0
    ? await uploadBanPagesV2(opts.banEntries, newSecret, newEpoch, signer, privateKey, hub.blossomServers, ownerAuth)
    : oldBanPageHashes
  const groupBuilt = opts.groupRebuilds && opts.groupRebuilds.length > 0
    ? await buildV2GroupTrees(opts.groupRebuilds, hub.dTag, privateKey, signer, hub.blossomServers)
    : { refs: [], secrets: {} as Record<string, string> }
  const rotatedIds = new Set((opts.groupRebuilds || []).map(g => g.groupId))
  const finalGroupTrees = [...oldGroupTrees.filter(gt => !rotatedIds.has(gt.groupId)), ...groupBuilt.refs]
  const bumpedGroupedRoles = rotatedIds.size > 0 && hub.groupedRoles
    ? hub.groupedRoles.map(g => rotatedIds.has(g.groupId) ? { ...g, epoch: g.epoch + 1 } : g)
    : undefined
  const newIndexContent = createPaginatedIndexFile(
    newSpineHash, pageRefs, banPageHashes, newHistoryHash,
    finalGroupTrees.length > 0 ? finalGroupTrees : undefined,
  )
  const { hash: newIndexHash } = await uploadToBlossomServers(
    new TextEncoder().encode(newIndexContent), signer, privateKey, hub.blossomServers, 'text/plain', undefined, undefined, ownerAuth,
  )

  // HEAD-verify the new spine + index are retrievable before advertising the new epoch (see kickMemberV2).
  const { verifyFileExists } = await import('@/lib/blossom/treeUpdater')
  await verifyFileExists(newSpineHash, hub.blossomServers)
  await verifyFileExists(newIndexHash, hub.blossomServers)

  // 7. Re-publish as O with content re-encrypted under the new epoch key.
  onStep?.('Publishing hub event')
  const pub = await republishV2HubRotate({
    hub, ownerPub: hub.creatorPubkey, newIndexHash, newEpoch,
    oldHubSecret: oldSecret, newHubSecret: newSecret, groupedRolesOverride: bumpedGroupedRoles, privateKey, signer,
  })

  const epochMap: Record<number, string> = {}
  for (const l of lines) {
    if (!l.startsWith('hub:')) continue
    const parts = l.split(':')
    if (parts.length >= 3) epochMap[parseInt(parts[1], 10)] = parts.slice(2).join(':')
  }

  return {
    newIndexHash, newEpoch, newSecretHex, epochMap, groupSecrets: groupBuilt.secrets, groupedRoles: bumpedGroupedRoles,
    eventCreatedAt: pub.eventCreatedAt, publishedRelays: pub.publishedRelays, targetedRelays: pub.targetedRelays,
  }
}
