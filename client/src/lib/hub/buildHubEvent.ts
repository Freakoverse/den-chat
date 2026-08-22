/**
 * buildHubEvent — Shared utility to construct a hub event (kind 36942) from HubData.
 * Used by both CreateHubDialog and HubSettingsModal to avoid duplication.
 */

import type { HubData, Channel, Category, Role } from '@/stores/hubStore'
import type { GroupedRole } from '@/lib/hub/groupEncryption'
import { createUnsignedEvent } from '@/lib/nostr'
import { KINDS } from '@/lib/crypto/constants'
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
    relays, blossomServers, indexFileHash, channels, categories, roles, minPow, joinMinPow, nsfw, discoverable, groupedRoles,
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
    eventTags.push(['wj', joinMinPow.toString()])
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
