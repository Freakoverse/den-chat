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
import { getTrustedCreator } from '@/lib/hub/hubCreatorGuard'
import { downloadTextFromBlossom, parseIndexFile, decryptHubSecret, decryptGroupSecret, downloadBanList } from '@/lib/blossom'
import { cacheHubBlob, getCachedHubText } from '@/lib/blossom/hubBlobStore'
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
export function parseHubEvent(event: Event, contentOverride?: string): (HubData & { creatorPubkey: string }) | null {
  try {
    const dTag = event.tags.find(t => t[0] === 'd')?.[1]
    if (!dTag) return null

    const name = event.tags.find(t => t[0] === 'n')?.[1] || 'Unnamed Hub'
    // Epoch: prefer an explicit `epoch` tag, else the `m` tag's 3rd field (where hub creation and
    // rotation actually write it: `["m", indexHash, epoch]`), else 1. Without the `m` fallback a
    // rotated hub (epoch > 1) would derive its content key at the wrong epoch and fail to decrypt.
    const epochTag = event.tags.find(t => t[0] === 'epoch')?.[1]
    const mEpoch = event.tags.find(t => t[0] === 'm')?.[2]
    const epoch = epochTag ? parseInt(epochTag, 10) : (mEpoch ? parseInt(mEpoch, 10) : 1)

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

    // Parse join PoW from the W tag. No W tag ⇒ 0 (no join PoW) — the join PoW is an
    // explicit, opt-in setting; it does NOT inherit the message PoW.
    const wjTag = event.tags.find(t => t[0] === 'W')?.[1]

    // Parse disappearing-messages timer (seconds). Absent/0/malformed ⇒ off.
    const meTag = event.tags.find(t => t[0] === 'message_expiration')?.[1]
    const messageExpiration = meTag ? Math.max(0, parseInt(meTag, 10) || 0) : 0

    // Parse hub format version (NIP-CHAT §0). Absent ⇒ v1. This reads the live
    // tag only; the authoritative v2 decision (fail-safe) also weighs the
    // hub-list record and encrypted content — see lib/hub/version.ts.
    const versionTag = event.tags.find(t => t[0] === 'version')?.[1]
    const version = versionTag ? (parseInt(versionTag, 10) || undefined) : undefined
    // NIP-SKD scheme: ['signer_scheme', family, version] ⇒ 'family:version'.
    const ssTag = event.tags.find(t => t[0] === 'signer_scheme')
    const signerScheme = ssTag && ssTag[1] ? `${ssTag[1]}:${ssTag[2] || '1'}` : undefined

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

    // v2 structural content is encrypted; the caller passes the decrypted JSON as
    // `contentOverride` once it holds the hub secret. Without it, a v2 hub's content won't
    // JSON.parse (channels/roles stay empty until the override is supplied).
    const rawContent = contentOverride ?? event.content
    if (rawContent) {
      try {
        const content = JSON.parse(rawContent)

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
        // Content is not valid JSON — a legacy event, or v2 encrypted content without the
        // decrypted override (channels/roles fill in once the caller re-parses with the secret).
      }
    }

    // v2 public face lives in plaintext tags (the structural content is encrypted). Apply them
    // over content.settings so the join/Discover card and header render before the secret.
    const pictureTag = event.tags.find(t => t[0] === 'picture')?.[1]
    const bannerTag = event.tags.find(t => t[0] === 'banner')?.[1]
    const aboutTag = event.tags.find(t => t[0] === 'about')?.[1]
    if (pictureTag) icon = pictureTag
    if (bannerTag) banner = bannerTag
    if (aboutTag) description = aboutTag

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
      joinMinPow: wjTag ? parseInt(wjTag, 10) : 0,
      messageExpiration,
      version,
      signerScheme,
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
/**
 * Download a hub tree blob (index/page/spine/history) resiliently:
 *   1. try the hub's Blossom servers, retaining a local copy on success so THIS device can
 *      heal the hub later if the servers GC the blob;
 *   2. if it's gone from every server, fall back to our local retention store — the source
 *      of truth that keeps a v2 hub (whose blobs live under the throwaway pseudonym O on
 *      GC-happy public servers) loadable. The cooperative mirror (ensureBlossomRedundancy,
 *      run on load) then re-uploads it from local bytes.
 * Throws only when the blob is on no server AND we hold no local copy.
 */
async function loadHubText(hash: string, servers: string[], dTag: string): Promise<string> {
  try {
    const text = await downloadTextFromBlossom(hash, servers)
    cacheHubBlob(hash, new TextEncoder().encode(text), dTag).catch(() => {})
    return text
  } catch (err) {
    const local = await getCachedHubText(hash)
    if (local !== null) {
      console.warn(`[useHubLoader] ${dTag}: blob ${hash} gone from all servers — loaded from local retention (will re-mirror)`)
      return local
    }
    throw err
  }
}

export async function loadHubSecret(
  hubData: HubData & { creatorPubkey: string },
  memberPubkey: string,
  memberPrivateKey: string | null,
  signer: any,
): Promise<{ secretHex: string; members: HubMember[]; bannedPubkeys: string[]; banListUnresolved?: boolean; historyHash: string; pageCount: number; failReason?: 'signer-issue' | 'not-a-member' } | null> {
  if (!hubData.indexFileHash || hubData.blossomServers.length === 0) {
    return null
  }

  try {
    // 1. Download and parse index file (resilient: local-retention fallback if GC'd)
    const indexContent = await loadHubText(hubData.indexFileHash, hubData.blossomServers, hubData.dTag)
    const index = parseIndexFile(indexContent)

    // 2. Download ban pages (non-blocking). v1 ban pages are plaintext; v2 ban pages are
    // encrypted with the hub secret, so they're decrypted later (after the secret is obtained).
    const { isV2: isV2Check } = await import('@/lib/hub/version')
    const v2Hub = isV2Check(hubData)
    let bannedPubkeys: string[] = []
    // "We couldn't load the ban list" vs "there are no bans" — consumers must NOT overwrite the store's
    // ban list with [] when it's unresolved (that un-hides banned users). For v2 the list is loaded only
    // AFTER the secret (below), so EVERY early/failure return before that point is unresolved; for v1 the
    // list is attempted here, so the flag tracks this download's outcome.
    let banListUnresolved = v2Hub && index.banPages.length > 0
    if (!v2Hub && index.banPages.length > 0) {
      try {
        const banEntries = await downloadBanList(index.banPages, hubData.blossomServers)
        bannedPubkeys = banEntries.map(e => e.pubkey)
        console.log(`Hub ${hubData.dTag}: loaded ${bannedPubkeys.length} banned pubkeys from ${index.banPages.length} ban page(s)`)
      } catch (err) {
        console.warn(`Hub ${hubData.dTag}: failed to download ban pages:`, err)
        banListUnresolved = true // v1 download failed → don't let the caller clobber the existing list
      }
    }

    // ── Paginated format ──
    if (index.pageSize > 0 && index.spineHash && index.leafPages.length > 0) {
      const { findPageForPubkey, decryptHubSecretPaginated, decryptHubSecretPaginatedV2, getPageMembersV2 } = await import('@/lib/blossom')
      const { deserializeLeafPage, getPageMembers } = await import('@/lib/crypto/lkh')
      const { isV2 } = await import('@/lib/hub/version')

      const v2 = isV2(hubData)
      const ownerPub = hubData.creatorPubkey // in v2 the hub author is the owner pseudonym O

      // In v2 the leaf is keyed on the member's pseudonym P (NIP-SKD), not their real key.
      let lookupPubkey = memberPubkey // R for v1
      if (v2) {
        const { isSupportedSignerScheme, getSignerScheme } = await import('@/lib/hub/version')
        if (!isSupportedSignerScheme(hubData)) {
          // Hub advertises a signer scheme this client doesn't implement (a future `skd:2`, or a malformed
          // value). Deriving P under the wrong scheme yields a MISMATCHED pseudonym → fail closed (guard,
          // don't derive) rather than silently produce wrong keys / an undecryptable hub.
          console.warn(`Hub ${hubData.dTag}: unsupported signer scheme ${getSignerScheme(hubData)} — refusing to derive`)
          return { secretHex: '', members: [], bannedPubkeys, banListUnresolved, historyHash: index.historyHash, pageCount: index.leafPages.length, failReason: 'signer-issue' as const }
        }
        const { makeSubkeySigner } = await import('@/lib/nostr/v2send')
        const { ChatContext, canUseV2 } = await import('@/lib/crypto/skd')
        if (!canUseV2({ privateKey: memberPrivateKey, signer })) {
          // No local key / NIP-SKD signer → cannot derive P → cannot read this v2 hub.
          return { secretHex: '', members: [], bannedPubkeys, banListUnresolved, historyHash: index.historyHash, pageCount: index.leafPages.length, failReason: 'signer-issue' as const }
        }
        const pSigner = makeSubkeySigner(ChatContext.member(hubData.dTag), { privateKey: memberPrivateKey, signer, peerPub: ownerPub })
        lookupPubkey = await pSigner.getPublicKey()
      }

      // Find which page contains our leaf (P in v2, R in v1)
      const pageEntry = findPageForPubkey(index, lookupPubkey)
      if (!pageEntry) {
        console.warn(`Hub ${hubData.dTag}: pubkey not found in any page (paginated index)`)
        return { secretHex: '', members: [], bannedPubkeys, banListUnresolved, historyHash: index.historyHash, pageCount: index.leafPages.length }
      }

      // Download our page + spine (resilient: local-retention fallback if GC'd from servers)
      const [pageContent, spineContent] = await Promise.all([
        loadHubText(pageEntry.hash, hubData.blossomServers, hubData.dTag),
        loadHubText(index.spineHash, hubData.blossomServers, hubData.dTag),
      ])

      // Decrypt hub secret via page + spine
      let hubSecret: Uint8Array | null = null
      let signerFailed = false
      try {
        hubSecret = v2
          ? await decryptHubSecretPaginatedV2(lookupPubkey, memberPrivateKey, signer, ownerPub, pageContent, spineContent)
          : await decryptHubSecretPaginated(memberPubkey, memberPrivateKey, signer, hubData.creatorPubkey, pageContent, spineContent)
      } catch (err) {
        // Throws on signer errors (declined/circuit open); returns null when not in the tree.
        console.warn(`Hub ${hubData.dTag}: signer error during paginated decrypt:`, err)
        signerFailed = true
      }

      // Extract members: v1 from leaf pubkeys (no secret needed); v2 by decrypting the page's
      // group roster segment → P→R map (requires the hub secret, so this runs after the decrypt).
      let members: HubMember[] = []
      try {
        if (v2) {
          if (hubSecret) {
            // Roster segments are stamped per-epoch; resolve the right secret from history,
            // falling back to the current secret (single-epoch / freshly-touched pages).
            const epochMap = useHubStore.getState().epochSecrets[hubData.dTag] || {}
            const { fromHex } = await import('@/lib/crypto/lkh')
            const resolveEpochSecret = (epoch: number): Uint8Array | undefined =>
              epochMap[epoch] ? fromHex(epochMap[epoch]) : (hubSecret ?? undefined)
            members = (await getPageMembersV2(pageContent, resolveEpochSecret)).map(m => ({ pubkey: m.pubkey, roles: m.roles, flags: m.flags, p: m.p }))
          }
        } else {
          members = getPageMembers(deserializeLeafPage(pageContent))
        }
      } catch (err) {
        console.warn(`Hub ${hubData.dTag}: failed to extract members from page:`, err)
      }

      if (!hubSecret) {
        const failReason = signerFailed ? 'signer-issue' as const : 'not-a-member' as const
        console.warn(`Hub ${hubData.dTag}: could not decrypt hub secret (paginated, ${failReason})`)
        return members.length > 0 || signerFailed
          ? { secretHex: '', members, bannedPubkeys, banListUnresolved, historyHash: index.historyHash, pageCount: index.leafPages.length, failReason }
          : null
      }

      // v2: the ban list is encrypted with the hub secret — decrypt it now (real keys R).
      if (v2 && index.banPages.length > 0) {
        try {
          const { downloadBanListV2 } = await import('@/lib/blossom')
          bannedPubkeys = (await downloadBanListV2(index.banPages, hubSecret, hubData.blossomServers)).map(e => e.pubkey)
          banListUnresolved = false // loaded successfully → safe to write (clears the pre-secret "unresolved")
        } catch (err) {
          // Distinguish "couldn't load the ban list" from "no bans" — the caller must NOT overwrite the
          // store's ban list with [] on a transient failure (that would un-hide banned users).
          console.warn(`Hub ${hubData.dTag}: failed to decrypt v2 ban pages:`, err)
          banListUnresolved = true
        }
      }

      const secretHex = Array.from(hubSecret).map(b => b.toString(16).padStart(2, '0')).join('')
      return { secretHex, members, bannedPubkeys, banListUnresolved, historyHash: index.historyHash, pageCount: index.leafPages.length }
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
        ? { secretHex: '', members, bannedPubkeys, banListUnresolved, historyHash: index.historyHash, pageCount: 0, failReason }
        : null
    }

    const secretHex = Array.from(hubSecret).map(b => b.toString(16).padStart(2, '0')).join('')
    return { secretHex, members, bannedPubkeys, banListUnresolved, historyHash: index.historyHash, pageCount: 0 }
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
/**
 * Parse a facilitator tree's epoch-history blob (byte-identical to the owner/v1 format:
 * `AES(treeSecret, "hub:<epoch>:<hex>\n…")`). Shared by the v1 and v2 load paths. Returns the full
 * epoch→secret map and the facilitator's current epoch (the MAX line). Empty result if no history.
 */
async function parseFacilitatorHistory(
  treeSecret: Uint8Array,
  historyHash: string | undefined,
  hubData: { dTag: string; blossomServers: string[] },
): Promise<{ epoch?: number; epochSecrets?: Record<number, string> }> {
  if (!historyHash) return {}
  try {
    const historyBlob = await downloadTextFromBlossom(historyHash, hubData.blossomServers)
    const plaintext = await aesDecrypt(treeSecret, historyBlob)
    const map: Record<number, string> = {}
    let maxEpoch = 0
    for (const line of plaintext.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('hub:')) continue
      const parts = trimmed.split(':')
      if (parts.length < 3) continue
      const ep = parseInt(parts[1], 10)
      map[ep] = parts.slice(2).join(':')
      if (ep > maxEpoch) maxEpoch = ep
    }
    if (Object.keys(map).length > 0) return { epoch: maxEpoch, epochSecrets: map }
  } catch (err) {
    console.warn(`Hub ${hubData.dTag}: failed to parse facilitator epoch history:`, err)
  }
  return {}
}

/**
 * Extract the owner's real pubkey (R_owner) from decrypted hub content — but ONLY if the owner
 * attestation's signature verifies (R_owner signed the hub coordinate). The attestation is the one
 * artifact binding the pseudonymous hub to a real identity for members; a malicious owner controls the
 * encrypted content and could embed any `rOwnerPub` (e.g. a victim's npub) with a bogus signature, which
 * would otherwise make every client show the hub as created by the victim AND grant that key owner
 * permissions via `isHubOwner`. Fail closed: an absent or invalid attestation yields undefined.
 */
function verifiedOwnerRealPubkey(
  decrypted: unknown,
  creatorPubkey: string,
  dTag: string,
  verify: (coord: string, att: { rOwnerPub: string; createdAt: number; sigOwner: string }) => boolean,
): string | undefined {
  const att = (decrypted as { owner_attestation?: { rOwnerPub?: string; createdAt?: number; sigOwner?: string } })?.owner_attestation
  if (!att?.rOwnerPub || !att.sigOwner || typeof att.createdAt !== 'number') return undefined
  const coord = `${KINDS.HUB_EVENT}:${creatorPubkey}:${dTag}`
  if (verify(coord, att as { rOwnerPub: string; createdAt: number; sigOwner: string })) return att.rOwnerPub
  console.warn(`Hub ${dTag}: owner attestation failed verification — ignoring claimed owner R`)
  return undefined
}

/**
 * v2 hubs encrypt their structural content (channels/roles/categories) with the hub content key.
 * `parseHubEvent` leaves those empty until we hold the secret — so once we do (via the owner tree OR
 * a facilitator), decrypt the content, re-parse, and merge it in. Shared by the member and
 * facilitator load paths (a facilitated user would otherwise see an empty hub with no channels).
 */
export async function decryptAndMergeV2HubContent(
  dTag: string,
  event: Event,
  hubData: HubData & { creatorPubkey: string },
  secretHex: string,
): Promise<boolean> {
  if (hubData.version !== 2) return false
  try {
    const { fromHex } = await import('@/lib/crypto/lkh')
    const { deriveHubContentKey, decryptHubContent, verifyOwnerAttestation } = await import('@/lib/hub/hubContent')
    const key = deriveHubContentKey(fromHex(secretHex), hubData.epoch)
    const decrypted = await decryptHubContent(key, event.content)
    const full = parseHubEvent(event, JSON.stringify(decrypted))
    const ownerRealPubkey = verifiedOwnerRealPubkey(decrypted, hubData.creatorPubkey, dTag, verifyOwnerAttestation)
    if (full) {
      useHubStore.getState().setHubData(dTag, {
        ...hubData,
        channels: full.channels,
        categories: full.categories,
        roles: full.roles,
        groupedRoles: full.groupedRoles,
        description: full.description,
        icon: full.icon,
        banner: full.banner,
        ownerRealPubkey,
      })
      // "authentic" (used ONLY to bind the creator on the facilitator path) requires a VERIFIED owner
      // attestation, NOT just a successful content decrypt. The content key is derived from the hub
      // secret + epoch alone (no author binding) and the ciphertext is public on relays, so an attacker
      // can replay the real owner's content blob inside an event signed by their OWN key — a content
      // decrypt would succeed and (if we trusted it) bind the hub to the attacker, hijacking it for
      // facilitated users. The attestation commits R_owner's signature to THIS event's coordinate
      // (36942:creatorPubkey:dTag), so a forged event (different author → different coord) can't produce
      // a verifying attestation. ownerRealPubkey is defined only when that check passed.
      return ownerRealPubkey !== undefined
    }
  } catch (err) {
    console.warn(`Hub ${dTag}: failed to decrypt v2 hub content:`, err)
  }
  return false
}

export async function loadFacilitatorSecret(
  hubData: HubData & { creatorPubkey: string },
  facilitatorPubkey: string,
  memberPubkey: string,
  memberPrivateKey: string | null,
  signer: any,
): Promise<{ secretHex: string; facilitatorMembers: string[]; epoch?: number; epochSecrets?: Record<number, string> } | null> {
  // v2: `facilitatorPubkey` is the facilitator's member pseudonym `P_fac`. Their list is `P_fac`-
  // authored; each leaf is keyed on a facilitated pseudonym `Pf = ECDH(P_fac, R_f)`. We derive OUR
  // `Pf` (peer = `P_fac`) internally, unwrap our leaf, and recover the secret — no roster needed, so
  // it works even for someone the owner never added to the main tree.
  const { isV2 } = await import('@/lib/hub/version')
  if (isV2(hubData)) {
    try {
      const jrs = await fetchEvents({ kinds: [KINDS.JOIN_REQUEST], authors: [facilitatorPubkey], '#d': [hubData.dTag], limit: 1 })
      if (jrs.length === 0) return null
      const lt = jrs[0].tags.find((t: string[]) => t[0] === 'list')
      if (!lt?.[1]) return null
      let indexContent: string | null = null
      try { indexContent = await downloadTextFromBlossom(lt[1], hubData.blossomServers) } catch { return null }
      if (!indexContent) return null
      const index = parseIndexFile(indexContent)
      if (!index.treeHash) return null
      const treeContent = await downloadTextFromBlossom(index.treeHash, hubData.blossomServers)
      const { decryptSecretFromFacilitatorTreeV2 } = await import('@/lib/blossom/members')
      const { toHex, deserializeTree } = await import('@/lib/crypto/lkh')
      const secret = await decryptSecretFromFacilitatorTreeV2(facilitatorPubkey, hubData.dTag, memberPrivateKey, signer, treeContent)
      if (!secret) return null
      const facilitatorMembers = deserializeTree(treeContent).leaves.map((l: any) => l.pubkey)
      const { epoch, epochSecrets } = await parseFacilitatorHistory(secret, index.historyHash, hubData)
      return { secretHex: toHex(secret), facilitatorMembers, epoch, epochSecrets }
    } catch (e) {
      console.warn(`Hub ${hubData.dTag}: v2 facilitator secret load failed`, e)
      return null
    }
  }
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

    // Epoch history — same single-AES-blob format the owner tree uses; parse so the facilitated
    // user can decrypt every epoch and knows the facilitator's current epoch (the MAX line).
    const { epoch, epochSecrets } = await parseFacilitatorHistory(hubSecret, index.historyHash, hubData)

    return { secretHex, facilitatorMembers, epoch, epochSecrets }
  } catch (err) {
    console.warn(`Hub ${hubData.dTag}: failed to load facilitator secret:`, err)
    return null
  }
}

/**
 * Load ONLY the member list (leaf pubkeys) of a facilitator's tree — no secret decryption. A
 * member already holds the hub secret; to validate + show a facilitated author's messages they only
 * need to know who each facilitator vouched. Called lazily (per facilitator actually referenced by a
 * message, cached), so members don't fetch every facilitation list on load.
 */
export async function loadFacilitatorMemberList(
  hubData: { dTag: string; blossomServers: string[] },
  facilitatorPubkey: string,
): Promise<string[]> {
  try {
    const jrs = await fetchEvents({ kinds: [KINDS.JOIN_REQUEST], authors: [facilitatorPubkey], '#d': [hubData.dTag], limit: 1 })
    if (jrs.length === 0) return []
    const listTag = jrs[0].tags.find((t: string[]) => t[0] === 'list')
    if (!listTag?.[1]) return []
    const indexContent = await downloadTextFromBlossom(listTag[1], hubData.blossomServers)
    const index = parseIndexFile(indexContent)
    if (!index.treeHash) return []
    const treeContent = await downloadTextFromBlossom(index.treeHash, hubData.blossomServers)
    const { deserializeTree } = await import('@/lib/crypto/lkh')
    return deserializeTree(treeContent).leaves.map((l) => l.pubkey)
  } catch (err) {
    console.warn(`Hub ${hubData.dTag}: failed to load facilitator member list for ${facilitatorPubkey.slice(0, 8)}…:`, err)
    return []
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
    const { isV2 } = await import('@/lib/hub/version')
    const v2 = isV2(hubData)
    const modPubkeys: string[] = []
    // Map the key we QUERY by → the mod's real key R we KEY the result by. v2 mods author their
    // ban-list JR under their pseudonym P (m.p), so we must query by P (never R + hub scope — that
    // would leak R to the relay), but store the ban set under R so it agrees with the local writer
    // (UserProfileModal keys the user's own list by R) and the live subscription (also keyed by R).
    const authorToReal = new Map<string, string>()

    for (const member of members) {
      // Skip the creator — they have the main ban list
      if (member.pubkey === hubData.creatorPubkey) continue
      const perms = getPermissionsForUser(hubData, member.pubkey, members)
      if (perms.ban_members) {
        // v2: query by the mod's pseudonym P — never fall back to R (that would leak R + hub scope
        // to the relay AND miss the P-authored ban-list JR). Skip a v2 mod with no resolved P.
        if (v2 && !member.p) continue
        const author = v2 ? member.p! : member.pubkey
        modPubkeys.push(author)
        authorToReal.set(author, member.pubkey)
      }
    }

    if (modPubkeys.length === 0) return result

    // v2 ban pages are AES-encrypted with the hub secret; load it now (skip decrypt if not ready).
    let secretBytes: Uint8Array | undefined
    if (v2) {
      const secretHex = useHubStore.getState().hubSecrets[hubData.dTag]
      if (secretHex) { const { fromHex } = await import('@/lib/crypto/lkh'); secretBytes = fromHex(secretHex) }
    }

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
    for (const [author, jr] of latestByAuthor) {
      const modRealKey = authorToReal.get(author) || author // key by the mod's real key R
      const listTag = jr.tags.find((t: string[]) => t[0] === 'list')
      if (!listTag?.[1]) continue

      try {
        const indexContent = await downloadTextFromBlossom(listTag[1], hubData.blossomServers)
        const index = parseIndexFile(indexContent)

        if (index.banPages.length > 0) {
          let banEntries
          if (v2) {
            if (!secretBytes) continue // hub secret not loaded yet — subscription will pick it up later
            const { downloadBanListV2 } = await import('@/lib/blossom')
            banEntries = await downloadBanListV2(index.banPages, secretBytes, hubData.blossomServers)
          } else {
            banEntries = await downloadBanList(index.banPages, hubData.blossomServers)
          }
          if (banEntries.length > 0) {
            result[modRealKey] = banEntries.map(e => e.pubkey)
            console.log(`Hub ${hubData.dTag}: loaded ${banEntries.length} mod ban(s) from ${modRealKey.slice(0, 8)}...`)
          }
        }
      } catch (err) {
        console.warn(`Hub ${hubData.dTag}: failed to load mod ban list from ${author.slice(0, 8)}...:`, err)
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

    // Cold-start forged-event fallback (v2). Hub-event queries filter by `#d` only, so a relay can serve a
    // forged 36942 for this dTag (attacker key + far-future created_at). On a FIRST-EVER load there's no
    // creator binding yet to reject it (getTrustedCreator undefined), so plain newest-wins would pick the
    // forgery, discard the real owner's (lower created_at) event, and leave the hub unreadable / showing
    // spoofed metadata. Keep the newest event PER AUTHOR so, when a v2 candidate fails to bind (a forgery
    // can't decrypt; the real owner's tree can), we advance to the next author. Bounded by distinct authors.
    const candidatesByDTag = new Map<string, Map<string, Event>>() // dTag → (author → newest event)
    const triedAuthors = new Map<string, Set<string>>()            // dTag → authors whose v2 event didn't bind
    const MAX_CANDIDATE_AUTHORS = 64
    const newestCandidate = (dTag: string, skipTried: boolean): Event | undefined => {
      const byAuthor = candidatesByDTag.get(dTag)
      if (!byAuthor) return undefined
      const tried = triedAuthors.get(dTag)
      let best: Event | undefined
      for (const e of byAuthor.values()) {
        if (skipTried && tried?.has(e.pubkey)) continue
        if (!best || e.created_at > best.created_at) best = e
      }
      return best
    }

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
            const evV2 = event.tags.some(t => t[0] === 'version' && t[1] === '2')
            if (evV2 && !getTrustedCreator(dTag)) {
              // This v2 event didn't bind the creator (a forgery can't decrypt; or we're genuinely not a
              // member). Mark its author tried and advance to the next UNTRIED candidate author, so a forged
              // newest event can't shadow the real owner's on cold start. If every author has been tried
              // (none decrypted), stop — leave the newest for display, no re-enqueue (avoids an oscillation
              // loop for a legitimate non-member).
              const tried = triedAuthors.get(dTag) ?? new Set<string>()
              tried.add(event.pubkey)
              triedAuthors.set(dTag, tried)
              const nextUntried = newestCandidate(dTag, true)
              if (nextUntried) { latestByDTag.set(dTag, nextUntried); enqueue(dTag) }
            } else {
              // A newer version may have arrived while we were processing — redo it.
              const latest = latestByDTag.get(dTag)
              if (latest && latest.created_at !== event.created_at) enqueue(dTag)
            }
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
        // If this hub's real owner is already bound, IGNORE events from any other author at ingest.
        // Otherwise a forged event with a far-future created_at would crowd out the real owner's
        // (deliberately low, original+1) event here — processHub would then reject the forgery but have no
        // fallback, leaving the hub stuck loading. Filtering at ingest keeps the real owner's event.
        const trusted = getTrustedCreator(dTag)
        if (trusted && event.pubkey !== trusted) continue
        // Track the newest event PER AUTHOR, then select the newest whose author hasn't already failed to
        // bind — so the cold-start fallback (in processHub's finally) can reject a forged newest event in
        // favour of the real owner's decryptable one. Cap distinct authors to bound memory under flooding.
        const byAuthor = candidatesByDTag.get(dTag) ?? new Map<string, Event>()
        if (byAuthor.has(event.pubkey) || byAuthor.size < MAX_CANDIDATE_AUTHORS) {
          const prev = byAuthor.get(event.pubkey)
          if (!prev || event.created_at > prev.created_at) byAuthor.set(event.pubkey, event)
          candidatesByDTag.set(dTag, byAuthor)
        }
        const selected = newestCandidate(dTag, true) ?? newestCandidate(dTag, false)
        if (selected) latestByDTag.set(dTag, selected)
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

    /**
     * Apply a facilitator secret result: populate epoch history (so every epoch is decryptable),
     * and set the live hub secret ONLY when the facilitator's epoch matches the hub's current epoch
     * (or when the tree has no history — legacy). If the facilitator is behind a rotation, we keep
     * their history but don't publish a stale secret as current — which would mis-key sends under
     * the newer epoch tag. A later live update re-triggers once the facilitator rebuilds.
     */
    async function applyFacilitatorResult(
      dTag: string,
      hubEpoch: number,
      facilitator: string,
      facResult: { secretHex: string; facilitatorMembers: string[]; epoch?: number; epochSecrets?: Record<number, string> },
      event: Event,
      hubData: HubData & { creatorPubkey: string },
    ) {
      if (facResult.epochSecrets && Object.keys(facResult.epochSecrets).length > 0) {
        setEpochSecrets(dTag, facResult.epochSecrets)
      }
      if (facResult.epoch == null || facResult.epoch === hubEpoch) {
        setHubSecret(dTag, facResult.secretHex)
        setHubPref(dTag, 'facilitatorSecret', facResult.secretHex)
        // Decrypt the v2 structural content now that we hold the secret (else: empty hub, no channels).
        const authentic = await decryptAndMergeV2HubContent(dTag, event, hubData, facResult.secretHex)
        // A SUCCESSFUL content decrypt proves this hub event is the real owner's (its content is encrypted
        // under the hub secret only the real owner could have set) — so facilitated users, who never touch
        // the owner tree, still bind the creator + advance the marks here. Without this they'd get NO
        // forged-event/rollback protection: a relay could serve a forged 36942 with the victim's dTag to
        // overwrite relays/blossom/name or spuriously delete the hub for them.
        if (authentic && hubData.version === 2) {
          const { recordTrustedCreator } = await import('@/lib/hub/hubCreatorGuard')
          const { recordVersionSeen } = await import('@/lib/hub/versionGuard')
          const { recordEpochSeen } = await import('@/lib/hub/epochGuard')
          recordTrustedCreator(dTag, hubData.creatorPubkey)
          recordVersionSeen(dTag, hubData.version)
          recordEpochSeen(dTag, hubData.epoch)
        }
      } else {
        // Facilitator is behind (hasn't rebuilt for the current epoch). Keep the epoch history
        // (old messages readable) but CLEAR any stale current secret so we never read/send at the
        // new epoch with an old key. Invariant: hubSecrets[dTag] is the current secret, or empty.
        setHubSecret(dTag, '')
      }
      if (facResult.facilitatorMembers.length > 0) {
        setHubFacilitatorMembers(dTag, facilitator, facResult.facilitatorMembers)
      }
    }

    /** Process a single hub: parse event, download secret, load bans, etc. */
    async function processHub(dTag: string, event: Event) {
        const hubData = parseHubEvent(event)
        if (!hubData) return

        // Creator binding: hub-event queries filter by `#d` only (no `authors`), so a relay can serve a
        // kind-36942 for this dTag signed by ANY pubkey. Once we've cryptographically confirmed the real
        // owner (its hub secret decrypted — recorded below on success), reject any event from a different
        // author before it can touch the store or the guards. This is what stops a forged event from
        // poisoning the epoch/version marks (a permanent lockout), injecting fake state, or spuriously
        // deleting the hub. Unknown-creator (first ever load) proceeds; the binding is set on decrypt.
        const { isForgedHubEvent, recordTrustedCreator } = await import('@/lib/hub/hubCreatorGuard')
        if (isForgedHubEvent(dTag, event.pubkey)) {
          console.warn(`[HubLoader] Ignoring hub event for ${dTag} from non-owner ${event.pubkey.slice(0, 8)}…`)
          return
        }

        // Version-downgrade + epoch-rollback CHECKS (a hub's version/epoch only ever increase). These only
        // SKIP a stale/downgraded event; they never mutate state, so they're safe to run before the event
        // is proven owner-authored. The corresponding RECORDs, which advance the persisted high-water
        // marks, are deferred to decrypt-success below — a forged event that never decrypts must never
        // advance a mark. A `deleted:true` tombstone omits `version` by design → exempt from the version
        // check (handled by the deleted branch, not the authoring path).
        const { isVersionDowngrade, recordVersionSeen } = await import('@/lib/hub/versionGuard')
        if (!hubData.deleted && isVersionDowngrade(dTag, hubData.version)) {
          console.warn(`[HubLoader] Ignoring version-downgrade hub event for ${dTag}: version ${hubData.version ?? 1} below high-water mark`)
          return
        }
        const { isV2: isV2Loader } = await import('@/lib/hub/version')
        const { isEpochRollback, recordEpochSeen } = await import('@/lib/hub/epochGuard')
        if (isV2Loader(hubData) && isEpochRollback(dTag, hubData.epoch)) {
          console.warn(`[HubLoader] Ignoring rollback hub event for ${dTag}: epoch ${hubData.epoch} below high-water mark`)
          return
        }

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
              // Decryption succeeded — advance the version/epoch high-water marks (a forged event that
              // never decrypts can't poison them). Bind the creator ONLY on v2: a v2 leaf is keyed by the
              // pseudonym P = f(memberPriv, ownerPub), which an attacker can't compute for a forged owner
              // key, so a v2 decrypt-success PROVES the real owner. A v1 leaf is keyed by the member's
              // PUBLIC key R, so an attacker could craft a v1 tree the victim decrypts and bind to the
              // attacker — don't bind (v1 has no R to hide anyway, and this avoids a v1-only lockout).
              if (hubData.version === 2) recordTrustedCreator(dTag, hubData.creatorPubkey)
              recordVersionSeen(dTag, hubData.version)
              recordEpochSeen(dTag, hubData.epoch)
              // Decrypting via the OWNER's tree means we're a real member. If we still carry a
              // facilitator pref (e.g. we were facilitated before being admitted), clear it — else
              // resolveV2PostingSigner could mis-sign our posts as Pf during the roster-load window.
              const facPref = useHubStore.getState().hubPrefs[dTag]
              if (facPref?.facilitator) {
                setHubPref(dTag, 'facilitator', undefined)
                setHubPref(dTag, 'facilitatorSecret', undefined)
              }
              // v2: the structural content (channels/roles/categories) is encrypted with the
              // hub content key. parseHubEvent left it empty; decrypt it now and merge.
              if (hubData.version === 2) {
                try {
                  const { fromHex } = await import('@/lib/crypto/lkh')
                  const { deriveHubContentKey, decryptHubContent, verifyOwnerAttestation } = await import('@/lib/hub/hubContent')
                  const key = deriveHubContentKey(fromHex(result.secretHex), hubData.epoch)
                  const decrypted = await decryptHubContent(key, event.content)
                  const full = parseHubEvent(event, JSON.stringify(decrypted))
                  // The owner attestation reveals the owner's real key R_owner (members-only) — but only
                  // trust it if its signature (by R_owner over the hub coordinate) VERIFIES. Otherwise a
                  // malicious owner could embed a victim's npub as rOwnerPub and every client would show the
                  // hub as created by the victim + grant that key owner permissions (isHubOwner).
                  const ownerRealPubkey = verifiedOwnerRealPubkey(decrypted, hubData.creatorPubkey, dTag, verifyOwnerAttestation)
                  if (full) {
                    setHubData(dTag, {
                      ...hubData,
                      channels: full.channels,
                      categories: full.categories,
                      roles: full.roles,
                      groupedRoles: full.groupedRoles,
                      description: full.description,
                      icon: full.icon,
                      banner: full.banner,
                      ownerRealPubkey,
                    })
                  }
                } catch (err) {
                  console.warn(`Hub ${dTag}: failed to decrypt v2 hub content:`, err)
                }
              }
            }
            if (result.members.length > 0) {
              setHubMembers(dTag, result.members)
            }
            // Write the ban list whenever it RESOLVED (even if genuinely empty, so a full unban clears the
            // display) — but never on a transient ban-page fetch failure (banListUnresolved), which would
            // truncate the store to [] and re-expose banned users.
            if (!result.banListUnresolved) {
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

              // v2: group trees are keyed on the member's pseudonym P and authored by O; the
              // owner is identified by deriving O (not by pubkey === creatorPubkey, which is O).
              let groupLookupKey = pubkey! // v1: R
              let isCreator = pubkey === hubData.creatorPubkey
              if (hubData.version === 2) {
                const { makeSubkeySigner } = await import('@/lib/nostr/v2send')
                const { ChatContext } = await import('@/lib/crypto/skd')
                const oPub = await makeSubkeySigner(ChatContext.owner(hubData.dTag), { privateKey, signer }).getPublicKey()
                isCreator = oPub === hubData.creatorPubkey
                groupLookupKey = await makeSubkeySigner(ChatContext.member(hubData.dTag), { privateKey, signer, peerPub: hubData.creatorPubkey }).getPublicKey()
              }

              for (const group of hubData.groupedRoles) {
                // Hub creator qualifies for ALL groups (including creator-only groups with empty roleIds)
                const qualifies = isCreator || memberQualifiesForGroup(memberRoles, group.roleIds)
                if (qualifies) {
                  try {
                    // Find the group tree hash from the index file
                    const indexContent = await downloadTextFromBlossom(hubData.indexFileHash, hubData.blossomServers)
                    const index = parseIndexFile(indexContent)
                    const groupRef = index.groupTrees.find(gt => gt.groupId === group.groupId)
                    if (groupRef) {
                      const groupTreeContent = await downloadTextFromBlossom(groupRef.hash, hubData.blossomServers)
                      const groupSecret = hubData.version === 2
                        ? await (await import('@/lib/blossom')).decryptGroupSecretV2(groupLookupKey, hubData.dTag, privateKey, signer, hubData.creatorPubkey, groupTreeContent)
                        : await decryptGroupSecret(pubkey!, privateKey, signer, hubData.creatorPubkey, groupTreeContent)
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

            // If no secret from creator's tree (non-member), try the user's saved facilitator.
            if (!result.secretHex) {
              const prefs = hubPrefs[dTag]
              const facilitator = prefs?.facilitator
              if (facilitator) {
                const facResult = await loadFacilitatorSecret(hubData, facilitator, pubkey, privateKey, signer)
                if (facResult) {
                  await applyFacilitatorResult(dTag, hubData.epoch, facilitator, facResult, event, hubData)
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
                await applyFacilitatorResult(dTag, hubData.epoch, facilitator, facResult, event, hubData)
              }
            }
          }
        }

        // Mark blossom secret resolution as complete for this hub
        setHubSecretsResolved(dTag, true)
    }
  }, [hubEntries, hubs, hubSecrets, setHubData, setHubStatus, setHubSecret, setHubMembers, pubkey, privateKey, signer, setEpochSecrets, setGroupEpochSecrets, hubSecretRetryNonce, hubReloadNonce])
}

