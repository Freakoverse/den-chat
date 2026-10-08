/**
 * buildHubEvent — Shared utility to construct a hub event (kind 36942) from HubData.
 * Used by both CreateHubDialog and HubSettingsModal to avoid duplication.
 */

import type { HubData, Channel, Category, Role } from '@/stores/hubStore'
import { joinNoteTag, type JoinNotePolicy } from '@/lib/hub/joinNote'
import type { GroupedRole } from '@/lib/hub/groupEncryption'
import { createUnsignedEvent } from '@/lib/nostr'
import { KINDS } from '@/lib/crypto/constants'
import { coordinateShortTag } from '@/lib/nostr/nipShort'
import { encryptHubContent, deriveHubContentKey, buildOwnerAttestation, type OwnerAttestation } from './hubContent'
import { nowSeconds } from '@/lib/time/clockOffset'
import type { UnsignedEvent, Event } from 'nostr-tools'
import type { ISigner } from '@/stores/userStore'
import {
  HUB_NAME_MAX, HUB_DESCRIPTION_MAX, CHANNEL_NAME_MAX, CHANNEL_DESCRIPTION_MAX,
  CATEGORY_NAME_MAX, ROLE_NAME_MAX, TOPIC_TAG_MAX, MEDIA_URL_MAX,
  MAX_CHANNELS, MAX_CATEGORIES, MAX_ROLES, MAX_TOPIC_TAGS, MAX_GENERAL_RELAYS, MAX_BLOSSOM_SERVERS,
} from '@/lib/hub/hubLimits'

interface BuildHubEventOptions {
  dTag: string
  name: string
  description?: string
  epoch: number
  icon?: string
  banner?: string
  tags?: string[]
  relays: string[]
  blossomServers: string[]
  indexFileHash: string
  /** Struct-blob hash (new format). When set, the structural arrays move OUT of the event content into
   *  the Blossom blob and the event carries a `["struct", hash, epoch]` tag, so the event stays O(1). The
   *  caller uploads the blob first (see lib/hub/hubStructBlob) and passes the verified hash here. */
  structFileHash?: string
  channels: Channel[]
  categories: Category[]
  roles: Role[]
  minPow?: number
  joinMinPow?: number
  /** Join-note prompt/requirement (§6.3.1) → plaintext `join_note` tag. */
  joinNote?: JoinNotePolicy
  /** Disappearing-messages timer in SECONDS (duration). Omitted/0 = off. */
  messageExpiration?: number
  nsfw?: boolean
  discoverable?: boolean
  groupedRoles?: GroupedRole[]
  /** Original publication timestamp — preserved across updates for ordering */
  publishedAt?: number
  /** Previous event's created_at — used for +1 replacement so edits don't
   *  bump the hub to the top of discover feeds (same pattern as message edits) */
  eventCreatedAt?: number
  /** The hub event's author pubkey (v1: creator R, v2: owner pseudonym O — i.e. hub.creatorPubkey).
   *  When set, the event gets a NIP-SHORT `["s", code]` tag (coordinate-derived, stable across edits). */
  authorPubkey?: string
}

/** Validate hub event data against relay size limits. Throws on violation. */
function validateHubLimits(opts: BuildHubEventOptions) {
  const errors: string[] = []

  // String limits
  if (opts.name.length > HUB_NAME_MAX) errors.push(`Hub name exceeds ${HUB_NAME_MAX} characters`)
  if (opts.description && opts.description.length > HUB_DESCRIPTION_MAX) errors.push(`Hub description exceeds ${HUB_DESCRIPTION_MAX} characters`)
  if (opts.icon && opts.icon.length > MEDIA_URL_MAX) errors.push(`Hub icon URL exceeds ${MEDIA_URL_MAX} characters`)
  if (opts.banner && opts.banner.length > MEDIA_URL_MAX) errors.push(`Hub banner URL exceeds ${MEDIA_URL_MAX} characters`)

  // Array (count) limits: these keep the INLINE event under relay size limits, so they only apply to
  // the legacy inline format. Struct-blob hubs move the arrays to a Blossom blob (the event is O(1)),
  // so the channel/category/role COUNT caps are lifted; per-item string limits below still apply.
  if (!opts.structFileHash) {
    if (opts.channels.length > MAX_CHANNELS) errors.push(`Too many channels (max ${MAX_CHANNELS})`)
    if (opts.categories.length > MAX_CATEGORIES) errors.push(`Too many categories (max ${MAX_CATEGORIES})`)
    if (opts.roles.length > MAX_ROLES) errors.push(`Too many roles (max ${MAX_ROLES})`)
  }
  if (opts.tags && opts.tags.length > MAX_TOPIC_TAGS) errors.push(`Too many topic tags (max ${MAX_TOPIC_TAGS})`)
  if (opts.relays.length > MAX_GENERAL_RELAYS) errors.push(`Too many relays (max ${MAX_GENERAL_RELAYS})`)
  if (opts.blossomServers.length > MAX_BLOSSOM_SERVERS) errors.push(`Too many blossom servers (max ${MAX_BLOSSOM_SERVERS})`)

  // Per-item string limits
  for (const ch of opts.channels) {
    if (ch.name.length > CHANNEL_NAME_MAX) errors.push(`Channel "${ch.name.slice(0, 20)}…" name exceeds ${CHANNEL_NAME_MAX} characters`)
    if (ch.description && ch.description.length > CHANNEL_DESCRIPTION_MAX) errors.push(`Channel "${ch.name.slice(0, 20)}…" description exceeds ${CHANNEL_DESCRIPTION_MAX} characters`)
  }
  for (const cat of opts.categories) {
    if (cat.name.length > CATEGORY_NAME_MAX) errors.push(`Category "${cat.name.slice(0, 20)}…" name exceeds ${CATEGORY_NAME_MAX} characters`)
  }
  for (const role of opts.roles) {
    if (role.name.length > ROLE_NAME_MAX) errors.push(`Role "${role.name.slice(0, 20)}…" name exceeds ${ROLE_NAME_MAX} characters`)
  }
  if (opts.tags) {
    for (const tag of opts.tags) {
      if (tag.length > TOPIC_TAG_MAX) errors.push(`Topic tag "${tag.slice(0, 20)}…" exceeds ${TOPIC_TAG_MAX} characters`)
    }
  }

  if (errors.length > 0) {
    throw new Error(`Hub event validation failed:\n${errors.join('\n')}`)
  }
}

export function buildHubEvent(opts: BuildHubEventOptions) {
  // Defense-in-depth: validate limits before building the event
  validateHubLimits(opts)

  const {
    dTag, name, description, epoch, icon, banner, tags,
    relays, blossomServers, indexFileHash, channels, categories, roles, minPow, joinMinPow, joinNote, messageExpiration, nsfw, discoverable, groupedRoles,
    publishedAt, eventCreatedAt
  } = opts

  // Build event tags
  const eventTags: [string, ...string[]][] = [
    ['d', dTag],
    ['n', name],
    ['epoch', epoch.toString()],
  ]

  for (const relay of relays) {
    eventTags.push(['r', relay, 'general'])
  }
  for (const server of blossomServers) {
    eventTags.push(['o', server])
  }
  if (indexFileHash) {
    eventTags.push(['m', indexFileHash, epoch.toString()])
  }
  // Real wall-clock time of THIS edit (corrected clock). created_at is a logical counter (prev+1),
  // so it isn't the actual edit time; updated_at is, for display and for tie resolution (§6.1).
  eventTags.push(['updated_at', nowSeconds().toString()])
  // Topic tags for discoverability
  if (tags && tags.length > 0) {
    for (const t of tags) {
      eventTags.push(['t', t])
    }
  }
  // NSFW / content-warning tags (NIP-36 + NIP-32)
  if (nsfw) {
    eventTags.push(['content-warning', ''])
    eventTags.push(['L', 'content-warning'])
  }
  // PoW difficulty tag (message PoW)
  if (minPow && minPow > 0) {
    eventTags.push(['w', minPow.toString()])
  }
  // Join PoW difficulty tag (separate from message PoW)
  if (joinMinPow && joinMinPow > 0) {
    eventTags.push(['W', joinMinPow.toString()])
  }
  // Join-note prompt / requirement (plaintext — prospective members hold no secret yet)
  { const jn = joinNoteTag(joinNote); if (jn) eventTags.push(jn) }
  // Disappearing-messages timer (seconds). Distinct name from NIP-40's
  // "expiration" ON PURPOSE — an "expiration" tag here would make relays delete
  // the hub event itself. This is only the hub-wide policy; per-message NIP-40
  // "expiration" tags are stamped at send time (see stampHubExpiration).
  if (messageExpiration && messageExpiration > 0) {
    eventTags.push(['message_expiration', Math.floor(messageExpiration).toString()])
  }
  // Discoverable flag — only emit when 'off' (default is discoverable)
  if (discoverable === false) {
    eventTags.push(['f', 'off'])
  } else {
    eventTags.push(['f', 'on'])
  }
  // NIP-SHORT short address (coordinate-derived, so stable across edits).
  if (opts.authorPubkey) eventTags.push(coordinateShortTag(KINDS.HUB_EVENT, opts.authorPubkey, dTag))

  // Struct-blob format (v1): the structural arrays live in a PLAINTEXT Blossom blob, so the public face
  // moves to plaintext tags (picture/banner/about), which parseHubEvent reads the same way it does for
  // v2, and the event content becomes empty. Keeps the event O(1) regardless of channel/role counts.
  if (opts.structFileHash) {
    if (icon) eventTags.push(['picture', icon])
    if (banner) eventTags.push(['banner', banner])
    if (description) eventTags.push(['about', description])
    eventTags.push(['struct', opts.structFileHash, epoch.toString()])
  }

  // Build JSON content per NIP-CHAT spec §6.1. Struct-blob hubs carry no structure in content (it is in
  // the Blossom blob; the public face is in tags above), so the content is empty.
  const contentObj = opts.structFileHash ? {} : {
    settings: {
      description: description || undefined,
      icon: icon || undefined,
      banner: banner || undefined,
    },
    roles: roles.map(r => ({
      role_id: r.roleId,
      name: r.name,
      ...(r.color ? { color: r.color } : {}),
      position: r.position,
      ...(r.hoist ? { hoist: true } : {}),
      permissions: r.permissions,
    })),
    grouped_roles: (groupedRoles || []).map(g => ({
      group_id: g.groupId,
      role_ids: g.roleIds,
      epoch: g.epoch,
    })),
    categories: categories.map(c => ({
      category_id: c.categoryId,
      name: c.name,
      position: c.position,
      encryption: c.encryption,
      permissions: c.permissions || {},
    })),
    channels: channels.map(ch => ({
      channel_id: ch.channelId,
      name: ch.name,
      type: ch.type,
      category_id: ch.categoryId,
      synced: ch.synced,
      encryption: ch.encryption,
      position: ch.position,
      description: ch.description || undefined,
      permissions: ch.permissions || {},
    })),
    plugins: {},
  }

  // Use previous created_at + 1 on updates so the hub doesn't jump to the
  // top of discover feeds. First publish (no eventCreatedAt) uses wall-clock.
  const createdAt = eventCreatedAt != null ? eventCreatedAt + 1 : undefined
  const unsigned = createUnsignedEvent(KINDS.HUB_EVENT, JSON.stringify(contentObj), eventTags, createdAt)

  // Add published_at tag — preserves original creation time across updates
  if (publishedAt) {
    unsigned.tags = [...unsigned.tags, ['published_at', publishedAt.toString()]]
  } else {
    // First publish — set published_at to match created_at
    unsigned.tags = [...unsigned.tags, ['published_at', unsigned.created_at.toString()]]
  }

  return unsigned
}

/**
 * Build a **v2** hub event (NIP-CHAT §0.3, §6.1): the structural content
 * (roles, categories, channel names, permissions, plugins) is encrypted with
 * `hub_content_key`, the public face (`n`, `picture`, `banner`, `about`, `t`)
 * stays in plaintext tags, and the encrypted owner attestation is embedded in
 * the content. The returned event is UNSIGNED with `pubkey` unset — the caller
 * signs it as the owner pseudonym `O` (see `lib/nostr/v2send`).
 */
export async function buildHubEventV2(
  opts: BuildHubEventOptions & {
    /** hub_content_key = deriveHubContentKey(hubSecret, epoch). */
    contentKey: Uint8Array
    /** R_owner ↔ coordinate attestation (built by the caller via buildOwnerAttestation). */
    ownerAttestation: OwnerAttestation
    /** NIP-SKD scheme "family:version" (default "skd:1"). */
    signerScheme?: string
  },
): Promise<UnsignedEvent> {
  validateHubLimits(opts)

  const {
    dTag, name, description, epoch, icon, banner, tags,
    relays, blossomServers, indexFileHash, channels, categories, roles,
    minPow, joinMinPow, joinNote, messageExpiration, nsfw, discoverable, groupedRoles,
    publishedAt, eventCreatedAt, contentKey, ownerAttestation, signerScheme,
  } = opts

  const eventTags: [string, ...string[]][] = [
    ['d', dTag],
    ['n', name],
    ['epoch', epoch.toString()],
  ]
  for (const relay of relays) eventTags.push(['r', relay, 'general'])
  for (const server of blossomServers) eventTags.push(['o', server])
  if (indexFileHash) eventTags.push(['m', indexFileHash, epoch.toString()])
  eventTags.push(['updated_at', nowSeconds().toString()]) // real edit time (see v1 path / §6.1)
  if (tags) for (const t of tags) eventTags.push(['t', t])
  if (nsfw) { eventTags.push(['content-warning', '']); eventTags.push(['L', 'content-warning']) }
  if (minPow && minPow > 0) eventTags.push(['w', minPow.toString()])
  if (joinMinPow && joinMinPow > 0) eventTags.push(['W', joinMinPow.toString()])
  { const jn = joinNoteTag(joinNote); if (jn) eventTags.push(jn) }
  if (messageExpiration && messageExpiration > 0) eventTags.push(['message_expiration', Math.floor(messageExpiration).toString()])
  eventTags.push(['f', discoverable === false ? 'off' : 'on'])
  // NIP-SHORT short address — plaintext tag (relay-indexed), coordinate-derived over the O pseudonym.
  if (opts.authorPubkey) eventTags.push(coordinateShortTag(KINDS.HUB_EVENT, opts.authorPubkey, dTag))

  // v2 public face — plaintext so non-members can preview the join/Discover card.
  if (icon) eventTags.push(['picture', icon])
  if (banner) eventTags.push(['banner', banner])
  if (description) eventTags.push(['about', description])

  // Format version + NIP-SKD derivation scheme.
  eventTags.push(['version', '2'])
  const [fam, ver] = (signerScheme || 'skd:1').split(':')
  eventTags.push(['signer_scheme', fam || 'skd', ver || '1'])

  // Struct-blob format (v2): the structural arrays move into the encrypted Blossom blob, so the event
  // content carries ONLY the owner attestation (needed for verification) and stays O(1). The blob is
  // encrypted with the same hub_content_key, so it stays members-only.
  if (opts.structFileHash) eventTags.push(['struct', opts.structFileHash, epoch.toString()])

  // Structural content (member-only) + the encrypted owner attestation, encrypted whole. In struct-blob
  // format the structure is in the blob, so only the attestation remains inline.
  const contentObj = opts.structFileHash ? { owner_attestation: ownerAttestation } : {
    roles: roles.map(r => ({
      role_id: r.roleId, name: r.name, ...(r.color ? { color: r.color } : {}),
      position: r.position, ...(r.hoist ? { hoist: true } : {}), permissions: r.permissions,
    })),
    grouped_roles: (groupedRoles || []).map(g => ({ group_id: g.groupId, role_ids: g.roleIds, epoch: g.epoch })),
    categories: categories.map(c => ({
      category_id: c.categoryId, name: c.name, position: c.position, encryption: c.encryption, permissions: c.permissions || {},
    })),
    channels: channels.map(ch => ({
      channel_id: ch.channelId, name: ch.name, type: ch.type, category_id: ch.categoryId,
      synced: ch.synced, encryption: ch.encryption, position: ch.position,
      description: ch.description || undefined, permissions: ch.permissions || {},
    })),
    plugins: {},
    owner_attestation: ownerAttestation,
  }
  const encContent = await encryptHubContent(contentKey, contentObj)

  const createdAt = eventCreatedAt != null ? eventCreatedAt + 1 : undefined
  const unsigned = createUnsignedEvent(KINDS.HUB_EVENT, encContent, eventTags, createdAt)
  unsigned.tags = [...unsigned.tags, ['published_at', (publishedAt ?? unsigned.created_at).toString()]]
  return unsigned
}

/**
 * Build **and sign** a v2 hub event for re-publishing after an edit (rename, channel/role
 * change, delete, etc.). Derives the content key from the hub secret, rebuilds the owner
 * attestation, encrypts the (edited) structural content, and signs as the owner pseudonym `O`.
 *
 * Use this wherever v1 code does `mineAndSign(buildHubEvent(...))` — that path signs with the
 * root key and emits plaintext, which corrupts a v2 hub.
 */
export async function buildAndSignV2HubEvent(
  opts: BuildHubEventOptions & {
    /** The hub's current secret (bytes). */
    hubSecret: Uint8Array
    /** The real owner key `R_owner` (for the attestation). */
    ownerRealPub: string
    /** The owner pseudonym `O` — the hub event author (== hub.creatorPubkey). */
    ownerPub: string
    /** Message-PoW difficulty (mined before signing). */
    minPow?: number
    privateKey: string | null
    signer: ISigner | null
    signerScheme?: string
  },
): Promise<Event> {
  const { makeSubkeySigner, mineAndSignAsSubkey } = await import('@/lib/nostr/v2send')
  const { ChatContext } = await import('@/lib/crypto/skd')

  const contentKey = deriveHubContentKey(opts.hubSecret, opts.epoch)
  const coord = `${KINDS.HUB_EVENT}:${opts.ownerPub}:${opts.dTag}`
  const ownerAttestation = await buildOwnerAttestation(coord, opts.ownerRealPub, opts.signer, opts.privateKey)
  // The v2 hub event is authored by O (ownerPub); its short code derives from that coordinate.
  const unsigned = await buildHubEventV2({ ...opts, authorPubkey: opts.ownerPub, contentKey, ownerAttestation, signerScheme: opts.signerScheme })
  const ownerSigner = makeSubkeySigner(ChatContext.owner(opts.dTag), { privateKey: opts.privateKey, signer: opts.signer })
  return mineAndSignAsSubkey(unsigned, opts.minPow && opts.minPow > 0 ? opts.minPow : 0, ownerSigner)
}

/**
 * One-liner for UI re-publish sites: build + sign a hub event the right way for the hub's
 * format. v1 → `mineAndSign(buildHubEvent(...))` (root key, plaintext); v2 →
 * `buildAndSignV2HubEvent` (owner `O`, encrypted content, reading the hub secret from the
 * store). Replaces the inline `mineAndSign(buildHubEvent(...))` pattern everywhere.
 */
export async function signHubEventForPublish(
  hub: { dTag: string; creatorPubkey: string; version?: number; signerScheme?: string; structFileHash?: string; blossomServers?: string[] },
  params: BuildHubEventOptions,
  opts: {
    pubkey: string; privateKey: string | null; signer: ISigner | null; minPow?: number
    /** Fired right before a struct blob is (re)uploaded, for callers with a progress UI. Not fired when
     *  the structure is unchanged (no upload) or the hub is legacy (no struct tag). */
    onStructUpload?: () => void
  },
): Promise<Event> {
  const { isV2 } = await import('@/lib/hub/version')

  // Struct-blob hubs: a re-publish carries the *current* structure in `params`. Re-upload the blob ONLY
  // when that structure actually differs from what the store already holds, then swap in the new hash; the
  // event drops the structure (struct tag only), staying O(1). When it is unchanged (a membership/role op
  // that doesn't touch structure, minting the short address, etc.) carry the existing hash forward with no
  // upload. This relies on every caller updating the store AFTER this returns, so the store still holds the
  // pre-edit structure here. Legacy hubs (no struct tag) keep the inline format. Non-structural v2 pointer
  // republishes go through republishV2* (which clone tags and preserve the struct tag), not this path.
  if (hub.structFileHash) {
    const { buildStructObject, resolveStructUploadContext, publishStructBlob } = await import('./hubStructBlob')
    const { useHubStore } = await import('@/stores/hubStore')
    const curHub = useHubStore.getState().hubs[params.dTag]
    const nextStruct = JSON.stringify(buildStructObject({ channels: params.channels, categories: params.categories, roles: params.roles, groupedRoles: params.groupedRoles }))
    const curStruct = curHub
      ? JSON.stringify(buildStructObject({ channels: curHub.channels, categories: curHub.categories, roles: curHub.roles, groupedRoles: curHub.groupedRoles }))
      : null
    if (curStruct !== null && curStruct === nextStruct) {
      // Structure unchanged: reuse the existing blob + hash, no upload.
      params = { ...params, structFileHash: hub.structFileHash }
    } else {
      opts.onStructUpload?.()
      const { contentKey, authSigner } = await resolveStructUploadContext(hub, params.epoch, opts)
      const structFileHash = await publishStructBlob({
        input: { channels: params.channels, categories: params.categories, roles: params.roles, groupedRoles: params.groupedRoles },
        contentKey,
        servers: params.blossomServers?.length ? params.blossomServers : (hub.blossomServers || []),
        dTag: params.dTag,
        signer: opts.signer,
        privateKey: opts.privateKey,
        authSigner,
      })
      params = { ...params, structFileHash }
      // Persist the new struct hash to the store immediately (the blob is already uploaded + verified). This
      // keeps a later NON-structural republish (member-tree/health, which read hub.structFileHash to carry it
      // forward) from reverting the event's struct pointer to the pre-edit blob within the same session. On
      // reload the loader re-derives it from the event tag anyway, so this only bridges the in-session window.
      try {
        const cur = useHubStore.getState().hubs[params.dTag]
        if (cur && cur.structFileHash !== structFileHash) useHubStore.getState().setHubData(params.dTag, { ...cur, structFileHash })
      } catch { /* store sync is best-effort */ }
    }
  }

  if (isV2(hub)) {
    const { useHubStore } = await import('@/stores/hubStore')
    const secretHex = useHubStore.getState().hubSecrets[hub.dTag]
    if (!secretHex) throw new Error('Hub secret not available for v2 re-publish')
    const { fromHex } = await import('@/lib/crypto/lkh')
    return buildAndSignV2HubEvent({
      ...params,
      hubSecret: fromHex(secretHex),
      ownerRealPub: opts.pubkey,
      ownerPub: hub.creatorPubkey,
      minPow: opts.minPow ?? params.minPow,
      privateKey: opts.privateKey,
      signer: opts.signer,
    })
  }
  const { mineAndSign } = await import('@/lib/nostr/events')
  // v1 author is the creator's real key (== hub.creatorPubkey) — give it the NIP-SHORT tag.
  return mineAndSign(buildHubEvent({ ...params, authorPubkey: hub.creatorPubkey }), opts.minPow ?? params.minPow ?? 0, opts.pubkey, opts.signer, opts.privateKey)
}
