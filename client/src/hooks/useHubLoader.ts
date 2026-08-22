/**
 * useHubLoader — Fetches hub events (kind 36942) from relays and parses them into HubData.
 * Also downloads member files from Blossom and decrypts the hub secret.
 *
 * Called after the user's hub list (kind 16942) is loaded.
 * For each hub entry, fetches the addressable replaceable hub event,
 * parses tags + JSON content per NIP-CHAT spec, populates hubStore,
 * then downloads and decrypts the hub secret from Blossom member files.
 */

import { useEffect, useRef } from 'react'
import { useHubStore, type HubData, type Channel, type Category, type Role } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { fetchEvents, fetchEventsProgressive } from '@/lib/nostr/relay-pool'
import { getAllHubEvents } from '@/lib/cache/hubEventCache'
import { KINDS } from '@/lib/crypto/constants'
import { downloadTextFromBlossom, parseIndexFile, decryptHubSecret, decryptGroupSecret, downloadBanList } from '@/lib/blossom'
import { aesDecrypt } from '@/lib/crypto/aes'
import type { BanEntry } from '@/lib/blossom'
import { deserializeTree, getMembers } from '@/lib/crypto/lkh'
import type { HubMember } from '@/stores/hubStore'
import type { Event } from 'nostr-tools'
import type { GroupedRole } from '@/lib/hub/groupEncryption'
import { memberQualifiesForGroup } from '@/lib/hub/groupEncryption'

/** Longer waits for the critical hub-definition fetch — a hub's event may live
 *  on a single slow relay, and a false 'not-found' hides it from the sidebar. */
const HUB_FETCH_MAX_WAIT_MS = 10000
const HUB_FETCH_RETRY_MAX_WAIT_MS = 15000

/**
 * Parse a hub event (kind 36942) into HubData.
 * Per NIP-CHAT spec §6.1:
 * - Tags: d, n, epoch, r, o, m, w, b
 * - Content: JSON with settings, roles, channels, categories, grouped_roles, plugins
 */
export function parseHubEvent(event: Event): (HubData & { creatorPubkey: string }) | null {
  try {
    const dTag = event.tags.find(t => t[0] === 'd')?.[1]
    if (!dTag) return null

    const name = event.tags.find(t => t[0] === 'n')?.[1] || 'Unnamed Hub'
    const epochTag = event.tags.find(t => t[0] === 'epoch')?.[1]
    const epoch = epochTag ? parseInt(epochTag, 10) : 1

    // Parse relay tags — every relay tag is a hub (general) relay
    const generalRelays: string[] = []
    for (const tag of event.tags) {
      if (tag[0] === 'r' && tag[1]) {
        generalRelays.push(tag[1])
      }
    }

    // Parse blossom servers
    const blossomServers = event.tags
      .filter(t => t[0] === 'o' && t[1])
      .map(t => t[1])

    // Parse index file hash
    const mTag = event.tags.find(t => t[0] === 'm')
    const indexFileHash = mTag?.[1] || ''

    // Parse topic tags
    const tags = event.tags
      .filter(t => t[0] === 't' && t[1])
      .map(t => t[1])

    // Parse PoW from w tag (source of truth), fallback to legacy JSON
    const wTag = event.tags.find(t => t[0] === 'w')?.[1]
    let minPow = wTag ? parseInt(wTag, 10) : 0

    // Parse join PoW from wj tag; fall back to message PoW when absent so
    // existing hubs keep their current join behavior.
    const wjTag = event.tags.find(t => t[0] === 'wj')?.[1]

    // Parse NSFW from content-warning tag (source of truth)
    const nsfw = event.tags.some(t => t[0] === 'content-warning')

    // Parse JSON content
    let channels: Channel[] = []
    let categories: Category[] = []
    let roles: Role[] = []
    let groupedRoles: GroupedRole[] = []
    let description = ''
    let icon: string | undefined
    let banner: string | undefined

    if (event.content) {
      try {
        const content = JSON.parse(event.content)

        // Settings
        if (content.settings?.description) {
          description = content.settings.description
        }
        if (content.settings?.icon) {
          icon = content.settings.icon
        }
        if (content.settings?.banner) {
          banner = content.settings.banner
        }
        // Legacy fallback: read min_pow from JSON if w tag absent
        if (minPow === 0 && typeof content.settings?.min_pow === 'number') {
          minPow = content.settings.min_pow
        }

        // Channels
        if (Array.isArray(content.channels)) {
          channels = content.channels.map((ch: any) => ({
            channelId: ch.channel_id,
            name: ch.name,
            type: ch.type || 'chat',
            categoryId: ch.category_id || null,
            synced: ch.synced ?? false,
            encryption: ch.encryption || null,
            position: ch.position ?? 0,
            description: ch.description || undefined,
            permissions: ch.permissions && typeof ch.permissions === 'object' && Object.keys(ch.permissions).length > 0 ? ch.permissions : undefined,
          }))
        }

        // Categories
        if (Array.isArray(content.categories)) {
          categories = content.categories.map((cat: any) => ({
            categoryId: cat.category_id,
            name: cat.name,
            position: cat.position ?? 0,
            encryption: cat.encryption || null,
            permissions: cat.permissions && typeof cat.permissions === 'object' && Object.keys(cat.permissions).length > 0 ? cat.permissions : undefined,
          }))
        }

        // Roles
        if (Array.isArray(content.roles)) {
          const parsed = content.roles.map((r: any) => ({
            roleId: r.role_id,
            name: r.name,
            color: r.color || undefined,
            position: typeof r.position === 'number' ? r.position : 0,
            hoist: r.hoist || false,
            permissions: {
              ...r.permissions,
              // Backward compatibility: new permissions default to true when absent
              create_polls: r.permissions?.create_polls ?? true,
              use_camera: r.permissions?.use_camera ?? true,
              use_spatial: r.permissions?.use_spatial ?? true,
            },
          }))
          // Merge duplicate 'everyone' roles: combine permissions (most permissive wins)
          const everyoneRoles = parsed.filter((r: any) => r.name === 'everyone')
          const otherRoles = parsed.filter((r: any) => r.name !== 'everyone')
          if (everyoneRoles.length > 1) {
            const merged = { ...everyoneRoles[0] }
            const mergedPerms = { ...merged.permissions }
            for (let i = 1; i < everyoneRoles.length; i++) {
              for (const [key, val] of Object.entries(everyoneRoles[i].permissions)) {
                if (val === true) mergedPerms[key] = true
              }
            }
            merged.permissions = mergedPerms
            merged.position = 0
            roles = [merged, ...otherRoles]
          } else {
            roles = parsed
          }
        }

        // Grouped roles
        if (Array.isArray(content.grouped_roles)) {
          groupedRoles = content.grouped_roles.map((g: any) => ({
            groupId: g.group_id,
            roleIds: Array.isArray(g.role_ids) ? g.role_ids : [],
            epoch: g.epoch ?? 1,
          }))
        }
      } catch {
        // Content is not valid JSON — could be a legacy event
        console.warn(`Hub ${dTag}: failed to parse content JSON`)
      }
    }

    // Fallback: try legacy tag-based format for backwards compat
    if (channels.length === 0) {
      const channelTagData = event.tags.filter(t => t[0] === 'channel')
      if (channelTagData.length > 0) {
        channels = channelTagData.map(t => ({
          channelId: t[1],
          name: t[2] || 'unnamed',
          type: (t[4] || 'chat') as 'chat' | 'announcement',
          categoryId: null,
          synced: false,
          encryption: null,
          position: parseInt(t[3] || '0', 10),
        }))
      }
    }

    // Fallback: legacy name tag
    const legacyName = event.tags.find(t => t[0] === 'name')?.[1]

    // Check for deleted flag
    const isDeleted = event.tags.some(t => t[0] === 'deleted' && t[1] === 'true')

    // Parse discoverable flag (f tag — default: on when absent)
    const fTag = event.tags.find(t => t[0] === 'f')
    const discoverable = fTag ? fTag[1] !== 'off' : true

    // Parse published_at tag (original publication time, preserved across updates)
    const publishedAtTag = event.tags.find(t => t[0] === 'published_at')?.[1]
    const publishedAt = publishedAtTag ? parseInt(publishedAtTag, 10) : undefined

    return {
      dTag,
      name: name !== 'Unnamed Hub' ? name : (legacyName || name),
      icon,
      banner,
      tags: tags.length > 0 ? tags : undefined,
      description,
      epoch,
      generalRelays,
      blossomServers,
      indexFileHash,
      channels,
      categories,
      roles,
      minPow,
      joinMinPow: wjTag ? parseInt(wjTag, 10) : minPow,
      nsfw,
      creatorPubkey: event.pubkey,
      deleted: isDeleted || undefined,
      discoverable,
      groupedRoles: groupedRoles.length > 0 ? groupedRoles : undefined,
      publishedAt,
      eventCreatedAt: event.created_at,
    }
  } catch (err) {
    console.error('Failed to parse hub event:', err)
    return null
  }
}

/**
 * Download and decrypt the hub secret from Blossom LKH tree file.
 * Auto-detects monolithic vs paginated index format.
 * Also downloads ban pages from the index file.
 */
async function loadHubSecret(
  hubData: HubData & { creatorPubkey: string },
  memberPubkey: string,
  memberPrivateKey: string | null,
  signer: any,
): Promise<{ secretHex: string; members: HubMember[]; bannedPubkeys: string[]; historyHash: string; pageCount: number; failReason?: 'signer-issue' | 'not-a-member' } | null> {
  if (!hubData.indexFileHash || hubData.blossomServers.length === 0) {
    return null
  }

  try {
    // 1. Download and parse index file
    const indexContent = await downloadTextFromBlossom(hubData.indexFileHash, hubData.blossomServers)
    const index = parseIndexFile(indexContent)

    // 2. Download ban pages (non-blocking — don't fail if bans can't be fetched)
    let bannedPubkeys: string[] = []
    if (index.banPages.length > 0) {
      try {
        const banEntries = await downloadBanList(index.banPages, hubData.blossomServers)
        bannedPubkeys = banEntries.map(e => e.pubkey)
        console.log(`Hub ${hubData.dTag}: loaded ${bannedPubkeys.length} banned pubkeys from ${index.banPages.length} ban page(s)`)
      } catch (err) {
        console.warn(`Hub ${hubData.dTag}: failed to download ban pages:`, err)
      }
    }

    // ── Paginated format ──
    if (index.pageSize > 0 && index.spineHash && index.leafPages.length > 0) {
      const { findPageForPubkey, decryptHubSecretPaginated } = await import('@/lib/blossom')
      const { deserializeLeafPage, getPageMembers } = await import('@/lib/crypto/lkh')

      // Find which page contains our pubkey
      const pageEntry = findPageForPubkey(index, memberPubkey)
      if (!pageEntry) {
        console.warn(`Hub ${hubData.dTag}: pubkey not found in any page (paginated index)`)
        // Return approximate member count from page count
        return { secretHex: '', members: [], bannedPubkeys, historyHash: index.historyHash, pageCount: index.leafPages.length }
      }

      // Download our page + spine
      const [pageContent, spineContent] = await Promise.all([
        downloadTextFromBlossom(pageEntry.hash, hubData.blossomServers),
        downloadTextFromBlossom(index.spineHash, hubData.blossomServers),
      ])

      // Extract members from our page (lazy — we only see our page's members)
      let members: HubMember[] = []
      try {
        const page = deserializeLeafPage(pageContent)
        members = getPageMembers(page)
      } catch (err) {
        console.warn(`Hub ${hubData.dTag}: failed to extract members from page:`, err)
      }

      // Decrypt hub secret via page + spine
      let hubSecret: Uint8Array | null = null
      let signerFailed = false
      try {
        hubSecret = await decryptHubSecretPaginated(
          memberPubkey,
          memberPrivateKey,
          signer,
          hubData.creatorPubkey,
          pageContent,
          spineContent,
        )
      } catch (err) {
        // decryptHubSecretPaginated throws on signer errors (declined/circuit open)
        // but returns null when pubkey not found in tree
        console.warn(`Hub ${hubData.dTag}: signer error during paginated decrypt:`, err)
        signerFailed = true
      }

      if (!hubSecret) {
        const failReason = signerFailed ? 'signer-issue' as const : 'not-a-member' as const
        console.warn(`Hub ${hubData.dTag}: could not decrypt hub secret (paginated, ${failReason})`)
        return members.length > 0 || signerFailed
          ? { secretHex: '', members, bannedPubkeys, historyHash: index.historyHash, pageCount: index.leafPages.length, failReason }
          : null
      }

      const secretHex = Array.from(hubSecret).map(b => b.toString(16).padStart(2, '0')).join('')
      return { secretHex, members, bannedPubkeys, historyHash: index.historyHash, pageCount: index.leafPages.length }
    }

    // ── Monolithic format (legacy / facilitator) ──
    if (!index.treeHash) {
      console.warn(`Hub ${hubData.dTag}: no tree hash in index file`)
      return null
    }

    // Download LKH tree file
    const treeContent = await downloadTextFromBlossom(index.treeHash, hubData.blossomServers)

    // Extract member list from tree (before decryption — available to all)
    let members: HubMember[] = []
    try {
      const tree = deserializeTree(treeContent)
      members = getMembers(tree)
    } catch (err) {
      console.warn(`Hub ${hubData.dTag}: failed to extract members from tree:`, err)
    }

    // Decrypt hub secret from LKH tree
    let hubSecret: Uint8Array | null = null
    let signerFailed = false
    try {
      hubSecret = await decryptHubSecret(
        memberPubkey,
        memberPrivateKey,
        signer,
        hubData.creatorPubkey,
        treeContent,
      )
    } catch (err) {
      console.warn(`Hub ${hubData.dTag}: signer error during monolithic decrypt:`, err)
      signerFailed = true
    }

    if (!hubSecret) {
      const failReason = signerFailed ? 'signer-issue' as const : 'not-a-member' as const
      console.warn(`Hub ${hubData.dTag}: could not decrypt hub secret (${failReason})`)
      return members.length > 0 || signerFailed
        ? { secretHex: '', members, bannedPubkeys, historyHash: index.historyHash, pageCount: 0, failReason }
        : null
    }

    const secretHex = Array.from(hubSecret).map(b => b.toString(16).padStart(2, '0')).join('')
    return { secretHex, members, bannedPubkeys, historyHash: index.historyHash, pageCount: 0 }
  } catch (err) {
    console.warn(`Hub ${hubData.dTag}: failed to load hub secret from Blossom:`, err)
    return null
  }
}

/**
 * Auto-fetch hub secret via the user's saved facilitator.
 * Called when the user is NOT in the creator's member tree but has a facilitator set.
 *
 * 1. Fetch the facilitator's join request (kind 36944) to find their `list` tag
 * 2. Download the facilitator's index → tree from blossom
 * 3. Decrypt the hub secret from the facilitator's tree (leaf NIP-04 uses facilitator's pubkey)
 */
async function loadFacilitatorSecret(
  hubData: HubData & { creatorPubkey: string },
  facilitatorPubkey: string,
  memberPubkey: string,
  memberPrivateKey: string | null,
  signer: any,
): Promise<{ secretHex: string; facilitatorMembers: string[] } | null> {
  try {
    // 1. Fetch the facilitator's join request to get the `list` tag
    const joinRequests = await fetchEvents({
      kinds: [KINDS.JOIN_REQUEST],
      authors: [facilitatorPubkey],
      '#d': [hubData.dTag],
      limit: 1,
    })

    if (joinRequests.length === 0) {
      console.warn(`Hub ${hubData.dTag}: facilitator has no join request`)
      return null
    }

    const joinReq = joinRequests[0]
    const listTag = joinReq.tags.find((t: string[]) => t[0] === 'list')
    if (!listTag || !listTag[1]) {
      console.warn(`Hub ${hubData.dTag}: facilitator's join request has no list tag`)
      return null
    }

    const indexHash = listTag[1]

    // 2. Try downloading from hub's blossom servers first, then facilitator's
    // Hub's servers are the natural first-look location
    let indexContent: string | null = null
    try {
      indexContent = await downloadTextFromBlossom(indexHash, hubData.blossomServers)
    } catch {
      console.warn(`Hub ${hubData.dTag}: facilitator index not on hub blossom servers, trying other sources`)
    }

    if (!indexContent) {
      // Could try facilitator's blossom servers here (from their blossom server list event)
      // For now, fall back to hub servers only
      return null
    }

    const index = parseIndexFile(indexContent)
    if (!index.treeHash) {
      console.warn(`Hub ${hubData.dTag}: no tree hash in facilitator's index file`)
      return null
    }

    // 3. Download the facilitator's LKH tree
    const treeContent = await downloadTextFromBlossom(index.treeHash, hubData.blossomServers)

    // 4. Decrypt hub secret from facilitator's tree
    //    The facilitator encrypted leaves with THEIR keypair, so creatorPubkey = facilitatorPubkey
    const hubSecret = await decryptHubSecret(
      memberPubkey,
      memberPrivateKey,
      signer,
      facilitatorPubkey,   // NIP-04 counterparty is the facilitator (they encrypted the leaf keys)
      treeContent,
    )

    if (!hubSecret) {
      console.warn(`Hub ${hubData.dTag}: could not decrypt hub secret from facilitator's tree`)
      return null
    }

    const secretHex = Array.from(hubSecret).map(b => b.toString(16).padStart(2, '0')).join('')
    console.log(`Hub ${hubData.dTag}: successfully decrypted hub secret via facilitator`)

    // Extract facilitator's member list from their tree
    let facilitatorMembers: string[] = []
    try {
      const facTree = deserializeTree(treeContent)
      facilitatorMembers = getMembers(facTree).map(m => m.pubkey)
    } catch (err) {
      console.warn(`Hub ${hubData.dTag}: failed to extract facilitator member list:`, err)
    }

    return { secretHex, facilitatorMembers }
  } catch (err) {
    console.warn(`Hub ${hubData.dTag}: failed to load facilitator secret:`, err)
    return null
  }
}

/**
 * Load ban lists from members who have the `ban_members` permission.
 * For each such member, fetch their join request → list tag → index → ban pages.
 * Stores results keyed by moderator pubkey.
 */
export async function loadModBanLists(
  hubData: HubData & { creatorPubkey: string },
  members: HubMember[],
): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {}

  try {
    // Find all members with ban_members permission
    const { getPermissionsForUser } = await import('@/lib/hub/permissions')
    const modPubkeys: string[] = []

    for (const member of members) {
      // Skip the creator — they have the main ban list
      if (member.pubkey === hubData.creatorPubkey) continue
      const perms = getPermissionsForUser(hubData, member.pubkey, members)
      if (perms.ban_members) {
        modPubkeys.push(member.pubkey)
      }
    }

    if (modPubkeys.length === 0) return result

    // Fetch all join requests for these moderators in one query
    const joinRequests = await fetchEvents({
      kinds: [KINDS.JOIN_REQUEST],
      authors: modPubkeys,
      '#d': [hubData.dTag],
    })

    // Group by author (latest per author)
    const latestByAuthor = new Map<string, any>()
    for (const jr of joinRequests) {
      const existing = latestByAuthor.get(jr.pubkey)
      if (!existing || jr.created_at > existing.created_at) {
        latestByAuthor.set(jr.pubkey, jr)
      }
    }

    // For each mod with a list tag, download their ban pages
    for (const [modPubkey, jr] of latestByAuthor) {
      const listTag = jr.tags.find((t: string[]) => t[0] === 'list')
      if (!listTag?.[1]) continue

      try {
        const indexContent = await downloadTextFromBlossom(listTag[1], hubData.blossomServers)
        const index = parseIndexFile(indexContent)

        if (index.banPages.length > 0) {
          const banEntries = await downloadBanList(index.banPages, hubData.blossomServers)
          if (banEntries.length > 0) {
            result[modPubkey] = banEntries.map(e => e.pubkey)
            console.log(`Hub ${hubData.dTag}: loaded ${banEntries.length} mod ban(s) from ${modPubkey.slice(0, 8)}...`)
          }
        }
      } catch (err) {
        console.warn(`Hub ${hubData.dTag}: failed to load mod ban list from ${modPubkey.slice(0, 8)}...:`, err)
      }
    }
  } catch (err) {
    console.warn(`Hub ${hubData.dTag}: failed to load mod ban lists:`, err)
  }

  return result
}

/**
 * Hook: load hub data from relays for all hub entries,
 * then download + decrypt hub secrets from Blossom.
 */
export function useHubLoader() {
  const hubEntries = useHubStore((s) => s.hubEntries)
  const hubs = useHubStore((s) => s.hubs)
  const hubSecrets = useHubStore((s) => s.hubSecrets)
  const hubPrefs = useHubStore((s) => s.hubPrefs)
  const setHubData = useHubStore((s) => s.setHubData)
  const setHubStatus = useHubStore((s) => s.setHubStatus)
  const setHubSecret = useHubStore((s) => s.setHubSecret)
  const setHubMembers = useHubStore((s) => s.setHubMembers)
  const setHubBanList = useHubStore((s) => s.setHubBanList)
  const setHubFacilitatorMembers = useHubStore((s) => s.setHubFacilitatorMembers)
  const setModBanList = useHubStore((s) => s.setModBanList)
  const setHubPref = useHubStore((s) => s.setHubPref)
  const setGroupSecret = useHubStore((s) => s.setGroupSecret)
  const setEpochSecrets = useHubStore((s) => s.setEpochSecrets)
  const setGroupEpochSecrets = useHubStore((s) => s.setGroupEpochSecrets)
  const setHubSecretsResolved = useHubStore((s) => s.setHubSecretsResolved)
  const setHubPageCount = useHubStore((s) => s.setHubPageCount)
  const setHubSecretFailReason = useHubStore((s) => s.setHubSecretFailReason)
  const pubkey = useUserStore((s) => s.pubkey)
  const privateKey = useUserStore((s) => s.privateKey)
  const signer = useUserStore((s) => s.signer)
  const hubSecretRetryNonce = useHubStore((s) => s.hubSecretRetryNonce)
  const hubReloadNonce = useHubStore((s) => s.hubReloadNonce)
  const loadedRef = useRef<Set<string>>(new Set())
  // Close fn for the most recent progressive hub-event stream, so it can be torn
  // down on unmount (each stream also self-closes on EOSE / maxWait).
  const hubStreamRef = useRef<(() => void) | null>(null)
  useEffect(() => () => { hubStreamRef.current?.() }, [])

  // Manual per-hub retry (the "Try again" button on a not-found hub): forget the
  // "already attempted" mark for the targeted hub so the main effect re-fetches it
  // from scratch. retryHub() also cleared its status, so it shows as pending again.
  useEffect(() => {
    if (hubReloadNonce === 0) return
    const target = useHubStore.getState().hubReloadTarget
    if (target) loadedRef.current.delete(target)
  }, [hubReloadNonce])

  // Retry trigger: when the secret-retry nonce bumps (e.g. remote signer
  // reconnected on app resume), forget the "loaded" mark for hubs whose secret
  // never decrypted (transient signer/connection failures only) so the main
  // effect re-attempts them. Hubs with a secret, or permanently un-decryptable
  // ones (not a member), are left alone.
  useEffect(() => {
    if (hubSecretRetryNonce === 0) return
    const st = useHubStore.getState()
    for (const entry of st.hubEntries) {
      if (!st.hubSecrets[entry.dTag] && st.hubSecretFailReason[entry.dTag] !== 'not-a-member') {
        loadedRef.current.delete(entry.dTag)
      }
    }
  }, [hubSecretRetryNonce])

  // Clear loadedRef when auth identity changes so secrets can be re-fetched.
  // This handles the case where the signer (browser extension) connects late —
  // hubs that failed to decrypt secrets will be re-processed on the next effect run.
  const prevAuthRef = useRef<string>('')
  useEffect(() => {
    const authKey = `${pubkey || ''}:${privateKey ? 'pk' : ''}:${signer ? 'signer' : ''}`
    if (prevAuthRef.current && prevAuthRef.current !== authKey) {
      // Auth changed — clear loaded set so hubs can be re-processed
      loadedRef.current.clear()
      // Also clear hubSecretsResolved for hubs that still don't have secrets
      const state = useHubStore.getState()
      for (const dTag of Object.keys(state.hubSecretsResolved)) {
        if (!state.hubSecrets[dTag]) {
          state.setHubSecretsResolved(dTag, false)
        }
      }
    }
    prevAuthRef.current = authKey
  }, [pubkey, privateKey, signer])

  useEffect(() => {
    if (hubEntries.length === 0) return

    // Find entries not yet loaded (or loaded with stub data from discover join)
    const toLoad = hubEntries.filter(
      (e) => (!hubs[e.dTag] || !hubs[e.dTag].indexFileHash) && !loadedRef.current.has(e.dTag)
    )

    if (toLoad.length === 0) return

    // ── Phase 5: Prioritize hub processing order ──
    // 1. Last-active hub loads first (the hub the user was viewing)
    // 2. Remaining hubs sorted by sidebar position (hubEntries order),
    //    so hubs visible at the top of the sidebar load before offscreen ones.
    const lastActiveHub = localStorage.getItem('den_last_active_hub')
    const positionMap = new Map<string, number>()
    for (let i = 0; i < hubEntries.length; i++) {
      positionMap.set(hubEntries[i].dTag, hubEntries[i].position ?? i)
    }
    toLoad.sort((a, b) => {
      // Active hub always first
      if (a.dTag === lastActiveHub) return -1
      if (b.dTag === lastActiveHub) return 1
      // Then by sidebar position (lower position = higher in sidebar = loads first)
      const posA = positionMap.get(a.dTag) ?? Infinity
      const posB = positionMap.get(b.dTag) ?? Infinity
      return posA - posB
    })

    // Mark as loading to prevent duplicate fetches
    for (const entry of toLoad) {
      loadedRef.current.add(entry.dTag)
    }

    const dTags = toLoad.map(e => e.dTag)

    const requested = new Set(dTags)
    // Newest HUB_EVENT seen per d tag; the created_at we've FULLY processed per d
    // tag; and the set currently being processed. Because events stream in, an
    // older version can arrive before a newer one — we must never run two
    // processHub() for the same hub at once (they'd race on setHubData/secret and
    // an older one finishing last would clobber the newer), and we must always
    // process the newest known version.
    const latestByDTag = new Map<string, Event>()
    const doneAt = new Map<string, number>()   // created_at last fully processed
    const inFlight = new Set<string>()          // d tags currently processing
    const queued = new Set<string>()            // d tags waiting in workQueue

    // ── Concurrency-limited, per-hub-serialized processing (streamed) ──
    // Each hub involves several I/O-bound Blossom fetches + crypto, so cap parallelism.
    const HUB_CONCURRENCY = 10
    let running = 0
    const workQueue: string[] = []
    const enqueue = (dTag: string) => {
      if (queued.has(dTag)) return
      queued.add(dTag)
      workQueue.push(dTag)
    }
    const pump = () => {
      while (running < HUB_CONCURRENCY && workQueue.length > 0) {
        const dTag = workQueue.shift()!
        queued.delete(dTag)
        if (inFlight.has(dTag)) continue
        const event = latestByDTag.get(dTag) // always process the CURRENT newest
        if (!event || doneAt.get(dTag) === event.created_at) continue
        inFlight.add(dTag)
        running++
        processHub(dTag, event)
          .catch((err) => console.error(`Hub ${dTag}: processing failed:`, err))
          .finally(() => {
            running--
            inFlight.delete(dTag)
            doneAt.set(dTag, event.created_at)
            // A newer version may have arrived while we were processing — redo it.
            const latest = latestByDTag.get(dTag)
            if (latest && latest.created_at !== event.created_at) enqueue(dTag)
            pump()
          })
      }
    }

    // Fold newly-arrived events into latestByDTag and enqueue any hub whose newest
    // event we haven't processed yet — so hubs render as their events stream in from
    // the fastest relay, instead of only after the whole query completes.
    const ingest = (events: Event[]) => {
      for (const event of events) {
        const dTag = event.tags.find(t => t[0] === 'd')?.[1]
        if (!dTag || !requested.has(dTag)) continue
        const existing = latestByDTag.get(dTag)
        if (!existing || event.created_at > existing.created_at) latestByDTag.set(dTag, event)
      }
      for (const [dTag, event] of latestByDTag) {
        if (inFlight.has(dTag)) continue                 // re-checked when it finishes
        if (doneAt.get(dTag) === event.created_at) continue // newest already processed
        enqueue(dTag)
      }
      pump()
    }

    // Stream hub events progressively (paint the fastest relay's hubs immediately),
    // still waiting up to HUB_FETCH_MAX_WAIT_MS for stragglers. Anything no relay
    // answered gets one more attempt at a longer wait before we mark it not-found —
    // a hub wrongly hidden from the sidebar is far worse than a couple extra seconds.
    const stream = fetchEventsProgressive(
      { kinds: [KINDS.HUB_EVENT], '#d': dTags },
      ingest,
      { maxWait: HUB_FETCH_MAX_WAIT_MS },
    )
    hubStreamRef.current = stream.close

    // Seed from the local durable cache (IndexedDB) in parallel. A hub event is a
    // replaceable event, so a relay can serve a STALE version while the newest one
    // lives on a single (possibly slow/unreachable) relay. We cached every hub
    // version we've ever seen, newest-wins, so feeding those in — merged by the
    // same newest-wins logic — recovers the freshest version even when relays only
    // hand back an old copy. A genuinely newer relay version still overrides it.
    getAllHubEvents()
      .then((cached) => {
        const relevant = cached.filter((e) => {
          const d = e.tags.find((t) => t[0] === 'd')?.[1]
          return d !== undefined && requested.has(d)
        })
        if (relevant.length > 0) ingest(relevant)
      })
      .catch(() => {})

    stream.done.then(async () => {
      const missing = dTags.filter((d) => !latestByDTag.has(d))
      if (missing.length > 0) {
        const retry = await fetchEvents(
          { kinds: [KINDS.HUB_EVENT], '#d': missing },
          HUB_FETCH_RETRY_MAX_WAIT_MS,
        ).catch(() => [] as Event[])
        ingest(retry)
      }
      // Mark not-found for anything still missing after the retry.
      for (const requestedDTag of dTags) {
        if (!latestByDTag.has(requestedDTag)) {
          setHubStatus(requestedDTag, 'not-found')
        }
      }
    }).catch((err) => {
      console.error('Failed to load hub events:', err)
      // Allow a later retry by forgetting the "attempted" mark.
      for (const entry of toLoad) {
        loadedRef.current.delete(entry.dTag)
      }
    })

    /** Process a single hub: parse event, download secret, load bans, etc. */
    async function processHub(dTag: string, event: Event) {
        const hubData = parseHubEvent(event)
        if (!hubData) return

        setHubData(dTag, hubData)

        // Set hub status based on deleted flag
        if (hubData.deleted) {
          setHubStatus(dTag, 'deleted')
        } else {
          setHubStatus(dTag, 'loaded')
        }

        // Download and decrypt hub secret from Blossom (if not already loaded and not deleted)
        if (!hubData.deleted && !hubSecrets[dTag] && pubkey) {
          const result = await loadHubSecret(hubData, pubkey, privateKey, signer)
          if (result) {
            // Store failure reason if hub secret couldn't be obtained
            if (result.failReason) {
              setHubSecretFailReason(dTag, result.failReason)
            }
            if (result.secretHex) {
              setHubSecret(dTag, result.secretHex)
            }
            if (result.members.length > 0) {
              setHubMembers(dTag, result.members)
            }
            if (result.bannedPubkeys.length > 0) {
              setHubBanList(dTag, result.bannedPubkeys)
            }
            if (result.pageCount > 0) {
              setHubPageCount(dTag, result.pageCount)
            }

            // Load epoch secret history (for decrypting messages from previous epochs)
            // Format: single AES blob containing plaintext lines like "hub:1:secrethex"
            if (result.secretHex && result.historyHash) {
              try {
                const historyBlob = await downloadTextFromBlossom(result.historyHash, hubData.blossomServers)
                const epochMap: Record<number, string> = {}
                const secretBytes = new Uint8Array(result.secretHex.length / 2)
                for (let i = 0; i < result.secretHex.length; i += 2) {
                  secretBytes[i / 2] = parseInt(result.secretHex.substring(i, i + 2), 16)
                }

                // Try single-blob format first
                let plaintext = ''
                try {
                  plaintext = await aesDecrypt(secretBytes, historyBlob)
                } catch {
                  // Fallback: legacy per-row format (each row individually encrypted)
                  for (const line of historyBlob.split('\n')) {
                    const trimmed = line.trim()
                    if (!trimmed || !trimmed.startsWith('hub:')) continue
                    const parts = trimmed.split(':')
                    if (parts.length < 3) continue
                    const ep = parseInt(parts[1], 10)
                    const ciphertext = parts.slice(2).join(':')
                    try {
                      const decryptedHex = await aesDecrypt(secretBytes, ciphertext)
                      epochMap[ep] = decryptedHex
                    } catch { /* skip */ }
                  }
                }

                // Parse plaintext lines (from single-blob) — hub and group secrets
                const groupEpochMaps: Record<string, Record<number, string>> = {}
                if (plaintext) {
                  for (const line of plaintext.split('\n')) {
                    const trimmed = line.trim()
                    if (!trimmed) continue
                    if (trimmed.startsWith('hub:')) {
                      const parts = trimmed.split(':')
                      if (parts.length < 3) continue
                      epochMap[parseInt(parts[1], 10)] = parts.slice(2).join(':')
                    } else if (trimmed.startsWith('group:')) {
                      // group:<groupId>:<epoch>:<secretHex>
                      const parts = trimmed.split(':')
                      if (parts.length < 4) continue
                      const gid = parts[1]
                      const gep = parseInt(parts[2], 10)
                      if (!groupEpochMaps[gid]) groupEpochMaps[gid] = {}
                      groupEpochMaps[gid][gep] = parts.slice(3).join(':')
                    }
                  }
                }

                if (Object.keys(epochMap).length > 0) {
                  setEpochSecrets(dTag, epochMap)
                  console.log(`Hub ${dTag}: loaded ${Object.keys(epochMap).length} epoch secrets from history`)
                }
                for (const [gid, gmap] of Object.entries(groupEpochMaps)) {
                  setGroupEpochSecrets(dTag, gid, gmap)
                  console.log(`Hub ${dTag}: loaded ${Object.keys(gmap).length} group epoch secrets for ${gid}`)
                }
              } catch (err) {
                console.warn(`Hub ${dTag}: failed to load epoch history file:`, err)
              }
            }

            // Load moderator ban lists (from members with ban_members permission)
            if (result.members.length > 0) {
              const modBans = await loadModBanLists(hubData, result.members)
              for (const [modPubkey, bannedPks] of Object.entries(modBans)) {
                setModBanList(dTag, modPubkey, bannedPks)
              }
            }

            // Load group secrets for groups the current user qualifies for
            if (result.secretHex && hubData.groupedRoles && hubData.groupedRoles.length > 0) {
              const member = result.members.find(m => m.pubkey === pubkey)
              const memberRoles = member?.roles || 'everyone'

              for (const group of hubData.groupedRoles) {
                // Hub creator qualifies for ALL groups (including creator-only groups with empty roleIds)
                const isCreator = pubkey === hubData.creatorPubkey
                const qualifies = isCreator || memberQualifiesForGroup(memberRoles, group.roleIds)
                if (qualifies) {
                  try {
                    // Find the group tree hash from the index file
                    const indexContent = await downloadTextFromBlossom(hubData.indexFileHash, hubData.blossomServers)
                    const index = parseIndexFile(indexContent)
                    const groupRef = index.groupTrees.find(gt => gt.groupId === group.groupId)
                    if (groupRef) {
                      const groupTreeContent = await downloadTextFromBlossom(groupRef.hash, hubData.blossomServers)
                      const groupSecret = await decryptGroupSecret(pubkey!, privateKey, signer, hubData.creatorPubkey, groupTreeContent)
                      if (groupSecret) {
                        const groupSecretHex = Array.from(groupSecret).map(b => b.toString(16).padStart(2, '0')).join('')
                        setGroupSecret(dTag, group.groupId, groupSecretHex)
                        console.log(`Hub ${dTag}: decrypted group secret for group ${group.groupId.slice(0, 8)}...`)
                      }
                    }
                  } catch (err) {
                    console.warn(`Hub ${dTag}: failed to load group secret for ${group.groupId.slice(0, 8)}...:`, err)
                  }
                }
              }
            }

            // If no secret from creator's tree (non-member), try facilitator fallback
            if (!result.secretHex) {
              const prefs = hubPrefs[dTag]
              const facilitator = prefs?.facilitator
              if (facilitator) {
                const facResult = await loadFacilitatorSecret(hubData, facilitator, pubkey, privateKey, signer)
                if (facResult) {
                  setHubSecret(dTag, facResult.secretHex)
                  setHubPref(dTag, 'facilitatorSecret', facResult.secretHex)
                  if (facResult.facilitatorMembers.length > 0) {
                    setHubFacilitatorMembers(dTag, facilitator, facResult.facilitatorMembers)
                  }
                }
              }
            }
          } else {
            // loadHubSecret returned null (no index file or no blossom servers)
            // Still try facilitator if saved
            const prefs = hubPrefs[dTag]
            const facilitator = prefs?.facilitator
            if (facilitator) {
              const facResult = await loadFacilitatorSecret(hubData, facilitator, pubkey, privateKey, signer)
              if (facResult) {
                setHubSecret(dTag, facResult.secretHex)
                setHubPref(dTag, 'facilitatorSecret', facResult.secretHex)
                if (facResult.facilitatorMembers.length > 0) {
                  setHubFacilitatorMembers(dTag, facilitator, facResult.facilitatorMembers)
                }
              }
            }
          }
        }

        // Mark blossom secret resolution as complete for this hub
        setHubSecretsResolved(dTag, true)
    }
  }, [hubEntries, hubs, hubSecrets, setHubData, setHubStatus, setHubSecret, setHubMembers, pubkey, privateKey, signer, setEpochSecrets, setGroupEpochSecrets, hubSecretRetryNonce, hubReloadNonce])
}

