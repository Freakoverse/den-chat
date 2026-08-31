/**
 * buildHubEvent — Shared utility to construct a hub event (kind 36942) from HubData.
 * Used by both CreateHubDialog and HubSettingsModal to avoid duplication.
 */

import type { HubData, Channel, Category, Role } from '@/stores/hubStore'
import type { GroupedRole } from '@/lib/hub/groupEncryption'
import { createUnsignedEvent } from '@/lib/nostr'
import { KINDS } from '@/lib/crypto/constants'
import { encryptHubContent, deriveHubContentKey, buildOwnerAttestation, type OwnerAttestation } from './hubContent'
import type { UnsignedEvent, Event } from 'nostr-tools'
import type { ISigner } from '@/stores/userStore'
import {
  HUB_NAME_MAX, HUB_DESCRIPTION_MAX, CHANNEL_NAME_MAX, CHANNEL_DESCRIPTION_MAX,
  CATEGORY_NAME_MAX, ROLE_NAME_MAX, TOPIC_TAG_MAX,
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
  channels: Channel[]
  categories: Category[]
  roles: Role[]
  minPow?: number
  joinMinPow?: number
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
}

/** Validate hub event data against relay size limits. Throws on violation. */
function validateHubLimits(opts: BuildHubEventOptions) {
  const errors: string[] = []

  // String limits
  if (opts.name.length > HUB_NAME_MAX) errors.push(`Hub name exceeds ${HUB_NAME_MAX} characters`)
  if (opts.description && opts.description.length > HUB_DESCRIPTION_MAX) errors.push(`Hub description exceeds ${HUB_DESCRIPTION_MAX} characters`)

  // Array limits
  if (opts.channels.length > MAX_CHANNELS) errors.push(`Too many channels (max ${MAX_CHANNELS})`)
  if (opts.categories.length > MAX_CATEGORIES) errors.push(`Too many categories (max ${MAX_CATEGORIES})`)
  if (opts.roles.length > MAX_ROLES) errors.push(`Too many roles (max ${MAX_ROLES})`)
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
    relays, blossomServers, indexFileHash, channels, categories, roles, minPow, joinMinPow, messageExpiration, nsfw, discoverable, groupedRoles,
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

  // Build JSON content per NIP-CHAT spec §6.1
  const contentObj = {
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
    minPow, joinMinPow, messageExpiration, nsfw, discoverable, groupedRoles,
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
  if (tags) for (const t of tags) eventTags.push(['t', t])
  if (nsfw) { eventTags.push(['content-warning', '']); eventTags.push(['L', 'content-warning']) }
  if (minPow && minPow > 0) eventTags.push(['w', minPow.toString()])
  if (joinMinPow && joinMinPow > 0) eventTags.push(['W', joinMinPow.toString()])
  if (messageExpiration && messageExpiration > 0) eventTags.push(['message_expiration', Math.floor(messageExpiration).toString()])
  eventTags.push(['f', discoverable === false ? 'off' : 'on'])

  // v2 public face — plaintext so non-members can preview the join/Discover card.
  if (icon) eventTags.push(['picture', icon])
  if (banner) eventTags.push(['banner', banner])
  if (description) eventTags.push(['about', description])

  // Format version + NIP-SKD derivation scheme.
  eventTags.push(['version', '2'])
  const [fam, ver] = (signerScheme || 'skd:1').split(':')
  eventTags.push(['signer_scheme', fam || 'skd', ver || '1'])

  // Structural content (member-only) + the encrypted owner attestation, encrypted whole.
  const contentObj = {
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
  const unsigned = await buildHubEventV2({ ...opts, contentKey, ownerAttestation, signerScheme: opts.signerScheme })
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
  hub: { dTag: string; creatorPubkey: string; version?: number; signerScheme?: string },
  params: BuildHubEventOptions,
  opts: { pubkey: string; privateKey: string | null; signer: ISigner | null; minPow?: number },
): Promise<Event> {
  const { isV2 } = await import('@/lib/hub/version')
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
  return mineAndSign(buildHubEvent(params), opts.minPow ?? params.minPow ?? 0, opts.pubkey, opts.signer, opts.privateKey)
}
