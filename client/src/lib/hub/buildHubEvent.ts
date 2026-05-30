/**
 * buildHubEvent — Shared utility to construct a hub event (kind 36942) from HubData.
 * Used by both CreateHubDialog and HubSettingsModal to avoid duplication.
 */

import type { HubData, Channel, Category, Role } from '@/stores/hubStore'
import type { GroupedRole } from '@/lib/hub/groupEncryption'
import { createUnsignedEvent } from '@/lib/nostr'
import { KINDS } from '@/lib/crypto/constants'

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
  nsfw?: boolean
  discoverable?: boolean
  groupedRoles?: GroupedRole[]
  /** Original publication timestamp — preserved across updates for ordering */
  publishedAt?: number

}

export function buildHubEvent(opts: BuildHubEventOptions) {
  const {
    dTag, name, description, epoch, icon, banner, tags,
    relays, blossomServers, indexFileHash, channels, categories, roles, minPow, nsfw, discoverable, groupedRoles,
    publishedAt
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
  // PoW difficulty tag
  if (minPow && minPow > 0) {
    eventTags.push(['w', minPow.toString()])
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

  const unsigned = createUnsignedEvent(KINDS.HUB_EVENT, JSON.stringify(contentObj), eventTags)

  // Add published_at tag — preserves original creation time across updates
  if (publishedAt) {
    unsigned.tags = [...unsigned.tags, ['published_at', publishedAt.toString()]]
  } else {
    // First publish — set published_at to match created_at
    unsigned.tags = [...unsigned.tags, ['published_at', unsigned.created_at.toString()]]
  }

  return unsigned
}
