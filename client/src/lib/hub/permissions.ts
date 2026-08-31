/**
 * Permission Resolution Engine
 *
 * Resolves effective permissions for a user in a hub channel.
 * Per NIP-CHAT §8:
 * - Permissions are client-side rendering decisions
 * - Resolution order: role → category override → channel override
 * - Multiple roles: most permissive wins (any role grants = granted)
 * - Hub creator always has full permissions
 */

import type { HubData, Channel, Category, Role } from '@/stores/hubStore'
import { useHubStore } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'

/**
 * True if `pubkey` owns the hub. In v1 the owner authors as their real key `R` (= creatorPubkey).
 * In v2 the hub is authored by the owner pseudonym `O` (creatorPubkey), and the owner recognizes
 * themselves by their real key `R`, recorded as `ownerRealPubkey`. Every owner check must accept
 * both, or the v2 owner is treated as a stranger in their own hub.
 */
export function isHubOwner(hub: { creatorPubkey: string; ownerRealPubkey?: string }, pubkey: string): boolean {
  return pubkey === hub.creatorPubkey || (!!hub.ownerRealPubkey && pubkey === hub.ownerRealPubkey)
}

/**
 * Whether the given facilitator identity is a hub member who currently holds the `facilitate`
 * permission — the authorization gate for showing a facilitated user's messages and unlocking them.
 *
 * The facilitator identity on a message's `["facilitator", …]` tag is the facilitator's **on-wire**
 * key: the real key `R` in v1, but the member pseudonym `P` in v2. The roster keys members by `R`
 * (`m.pubkey`) and carries `P` in `m.p`, so we resolve by EITHER field, then look permissions up by
 * the member's real key. Without this a v2 facilitator (identified by `P`) is never found in the
 * `R`-keyed roster and every message they vouch is wrongly hidden.
 */
export function isAuthorizedFacilitator(
  hub: HubData,
  facilitatorKey: string,
  members: Array<{ pubkey: string; p?: string; roles?: string }> | undefined,
): boolean {
  const m = members?.find((mm) => mm.pubkey === facilitatorKey || mm.p === facilitatorKey)
  if (!m) return false
  return getPermissionsForUser(hub, m.pubkey, members as Array<{ pubkey: string; roles: string }>).facilitate === true
}

// ─── Types ───

export interface ResolvedPermissions {
  view_channel: boolean
  read_messages: boolean
  send_messages: boolean
  add_reactions: boolean
  create_invite: boolean
  ban_members: boolean
  hide_messages: boolean
  facilitate: boolean
  embed_links: boolean
  attach_files: boolean
  mention_everyone: boolean
  mention_here: boolean
  mention_roles: boolean
  create_polls: boolean
  create_calendar_events: boolean
  connect_voice: boolean
  speak: boolean
  stream_video: boolean
  use_camera: boolean
  use_spatial: boolean
}

/** All permission keys */
export const PERMISSION_KEYS: (keyof ResolvedPermissions)[] = [
  'view_channel',
  'read_messages',
  'send_messages',
  'add_reactions',
  'create_invite',
  'ban_members',
  'hide_messages',
  'facilitate',
  'embed_links',
  'attach_files',
  'mention_everyone',
  'mention_here',
  'mention_roles',
  'create_polls',
  'create_calendar_events',
  'connect_voice',
  'speak',
  'stream_video',
  'use_camera',
  'use_spatial',
]

/** Human-readable labels for each permission */
export const PERMISSION_LABELS: Record<keyof ResolvedPermissions, string> = {
  view_channel: 'View Channel',
  read_messages: 'Read Messages',
  send_messages: 'Send Messages',
  add_reactions: 'Add Reactions',
  create_invite: 'Share Hub',
  ban_members: 'Soft-Ban Members',
  hide_messages: 'Hide Messages',
  facilitate: 'Facilitate Members',
  embed_links: 'Embed & Preview Links',
  attach_files: 'Attach Files',
  mention_everyone: 'Mention @everyone',
  mention_here: 'Mention @here',
  mention_roles: 'Mention @roles',
  create_polls: 'Create Polls',
  create_calendar_events: 'Create Calendar Events',
  connect_voice: 'Connect to Voice',
  speak: 'Speak in Voice',
  stream_video: 'Stream Video',
  use_camera: 'Use Camera',
  use_spatial: 'Spatial Audio',
}

/** Short descriptions for permission tooltips */
export const PERMISSION_DESCRIPTIONS: Record<keyof ResolvedPermissions, string> = {
  view_channel: 'Can see this channel in the sidebar',
  read_messages: 'Can decrypt and read messages — denying makes the channel private',
  send_messages: 'Can send messages in hub channels',
  add_reactions: 'Can add reactions to messages in this hub',
  create_invite: 'Can copy and share the hub address with others',
  ban_members: 'Can soft-ban members from the hub',
  hide_messages: 'Can hide specific messages in this hub',
  facilitate: 'Can vouch people into the hub via a facilitation list (grants them access). Their messages appear only while this role keeps this permission.',
  embed_links: 'Links in messages from this role will show preview cards',
  attach_files: 'Can upload and attach files to messages in this hub',
  mention_everyone: '@everyone mentions from this role trigger notifications',
  mention_here: '@here mentions from this role trigger notifications',
  mention_roles: 'Can use @role mentions to notify all members of a role',
  create_polls: 'Can create polls in hub channels',
  create_calendar_events: 'Can create and publish calendar events in this hub',
  connect_voice: 'Can join voice channels in this hub',
  speak: 'Can unmute and transmit audio in voice channels',
  stream_video: 'Can screen share in voice channels',
  use_camera: 'Can enable camera in voice channels',
  use_spatial: 'Can use spatial audio positioning in voice channels',
}

/** Permissions that exist in the schema but are not yet implemented.
 *  The UI should render these as disabled with a "coming soon" indicator. */
export const DISABLED_PERMISSIONS: ReadonlySet<keyof ResolvedPermissions> = new Set([
  // All permissions are now implemented
])

/** Default permissions for the 'everyone' role when creating a new hub */
export const DEFAULT_EVERYONE_PERMISSIONS: ResolvedPermissions = {
  view_channel: true,
  read_messages: true,
  send_messages: true,
  add_reactions: true,
  create_invite: false,
  ban_members: false,
  hide_messages: false,
  facilitate: false,
  embed_links: true,
  attach_files: true,
  mention_everyone: false,
  mention_here: false,
  mention_roles: false,
  create_polls: true,
  create_calendar_events: false,
  connect_voice: true,
  speak: true,
  stream_video: true,
  use_camera: true,
  use_spatial: true,
}

/** Full permissions (used for hub creator override) */
export const FULL_PERMISSIONS: ResolvedPermissions = {
  view_channel: true,
  read_messages: true,
  send_messages: true,
  add_reactions: true,
  create_invite: true,
  ban_members: true,
  hide_messages: true,
  facilitate: true,
  embed_links: true,
  attach_files: true,
  mention_everyone: true,
  mention_here: true,
  mention_roles: true,
  create_polls: true,
  create_calendar_events: true,
  connect_voice: true,
  speak: true,
  stream_video: true,
  use_camera: true,
  use_spatial: true,
}

// ─── Resolution ───

/**
 * Resolve effective permissions for a member in a specific channel.
 *
 * @param hub - The hub data
 * @param memberRoles - Pipe-separated role IDs from the LKH leaf (e.g. "uuid1|uuid2")
 * @param channelId - Optional channel ID for channel/category-level overrides
 * @param isCreator - Whether the user is the hub creator (always gets full perms)
 * @returns Resolved permission set
 */
export function getEffectivePermissions(
  hub: HubData,
  memberRoles: string,
  channelId?: string,
  isCreator?: boolean,
): ResolvedPermissions {
  // Hub creator always has full permissions
  if (isCreator) return { ...FULL_PERMISSIONS }

  // Parse role IDs from pipe-separated string
  const roleIds = memberRoles ? memberRoles.split('|').map(s => s.trim()).filter(Boolean) : []

  // Find matching Role objects
  const matchedRoles: Role[] = []
  for (const role of hub.roles) {
    // Match by role ID or by name 'everyone' (everyone applies to ALL members)
    if (role.name === 'everyone' || roleIds.includes(role.roleId)) {
      matchedRoles.push(role)
    }
  }

  // If no roles matched at all, fall back to 'everyone' defaults
  if (matchedRoles.length === 0) {
    return { ...DEFAULT_EVERYONE_PERMISSIONS }
  }

  // Merge permissions: most permissive wins across all roles
  const merged: ResolvedPermissions = { ...DEFAULT_EVERYONE_PERMISSIONS }
  for (const key of PERMISSION_KEYS) {
    // If ANY matched role grants this permission, it's granted
    merged[key] = matchedRoles.some(r => r.permissions[key] === true)
  }

  // Apply category and channel overrides if channelId is provided
  if (channelId) {
    const channel = hub.channels.find(ch => ch.channelId === channelId)
    if (channel) {
      const category = channel.categoryId
        ? hub.categories.find(cat => cat.categoryId === channel.categoryId)
        : null

      // Apply category-level overrides
      if (category?.permissions) {
        applyOverrides(merged, category.permissions, matchedRoles)
      }

      // Apply channel-level overrides (only if synced == false)
      if (!channel.synced && channel.permissions) {
        applyOverrides(merged, channel.permissions, matchedRoles)
      }
    }
  }

  return merged
}

/**
 * Apply permission overrides from category or channel level.
 * Override format: { [roleId]: { [permKey]: boolean } }
 * Most permissive wins across all the user's roles.
 */
function applyOverrides(
  target: ResolvedPermissions,
  overrides: Record<string, Record<string, boolean>>,
  matchedRoles: Role[],
) {
  if (!overrides || typeof overrides !== 'object') return

  // Track which keys were explicitly overridden
  const overriddenKeys = new Set<string>()

  for (const key of PERMISSION_KEYS) {
    // Check if any matched role has an override for this permission
    let hasOverride = false
    let anyGrants = false

    for (const role of matchedRoles) {
      const roleOverride = overrides[role.roleId]
      if (roleOverride && key in roleOverride) {
        hasOverride = true
        if (roleOverride[key]) anyGrants = true
      }
    }

    // Also check the 'everyone' role by name match
    for (const [overrideRoleId, perms] of Object.entries(overrides)) {
      const isEveryoneOverride = matchedRoles.some(r => r.roleId === overrideRoleId && r.name === 'everyone')
      if (isEveryoneOverride && key in perms) {
        hasOverride = true
        if (perms[key]) anyGrants = true
      }
    }

    if (hasOverride) {
      target[key] = anyGrants
      overriddenKeys.add(key)
    }
  }

  // Sync connect_voice from read_messages if only one was explicitly overridden
  // This handles backward compatibility with channels set up before the read↔connect lock
  if (overriddenKeys.has('read_messages') && !overriddenKeys.has('connect_voice')) {
    target.connect_voice = target.read_messages
  } else if (overriddenKeys.has('connect_voice') && !overriddenKeys.has('read_messages')) {
    target.read_messages = target.connect_voice
  }
}

// ─── Hooks ───

/**
 * React hook: resolve permissions for the current user in the active hub/channel.
 * Returns full permissions for creators, resolved permissions for members,
 * and restrictive defaults for non-members.
 */
export function usePermissions(hubDTag?: string, channelId?: string): ResolvedPermissions {
  const pubkey = useUserStore((s) => s.pubkey)
  const hub = useHubStore((s) => hubDTag ? s.hubs[hubDTag] : null)
  const hubMembers = useHubStore((s) => hubDTag ? s.hubMembers[hubDTag] : undefined)

  if (!hub || !pubkey) {
    // No hub or not logged in — deny everything
    return {
      view_channel: false,
      read_messages: false,
      send_messages: false,
      add_reactions: false,
      create_invite: false,
      ban_members: false,
      hide_messages: false,
      facilitate: false,
      embed_links: false,
      attach_files: false,
      mention_everyone: false,
      mention_here: false,
      mention_roles: false,
      create_polls: false,
      create_calendar_events: false,
      connect_voice: false,
      speak: false,
      stream_video: false,
      use_camera: false,
      use_spatial: false,
    }
  }

  const isCreator = isHubOwner(hub, pubkey)

  // Find the member's roles from the LKH tree
  const member = hubMembers?.find(m => m.pubkey === pubkey)
  const memberRoles = member?.roles || 'everyone'

  return getEffectivePermissions(hub, memberRoles, channelId, isCreator)
}

/**
 * Get effective permissions for a specific user (not the current user).
 * Used for rendering decisions about other users' content (e.g. embed_links, send_messages filtering).
 */
export function getPermissionsForUser(
  hub: HubData,
  userPubkey: string,
  hubMembers: Array<{ pubkey: string; roles: string; p?: string }> | undefined,
  channelId?: string,
): ResolvedPermissions {
  // Match by real key `R` (m.pubkey) OR pseudonym `P` (m.p): callers pass the ON-WIRE author key,
  // which on a v2 hub is the member's pseudonym `P`, not `R`. Matching only `m.pubkey` would miss
  // every v2 member, collapse them to the `everyone` role, and (e.g.) hide calendar events / polls
  // from roles that grant the permission. Mirrors isAuthorizedFacilitator's dual match.
  const member = hubMembers?.find(m => m.pubkey === userPubkey || m.p === userPubkey)
  // Recognize the OWNER by their resolved real key too. On v2 the owner authors content under their
  // member pseudonym `P_owner` (≠ `O` = creatorPubkey, ≠ `R_owner`), so `isHubOwner(hub, userPubkey)`
  // with the on-wire `P_owner` is false, and the owner's own roster entry carries the `everyone` role —
  // which would (e.g.) hide the OWNER's own calendar events on their OWN hub. `member.pubkey` is the
  // real key `R`, so `isHubOwner(hub, member.pubkey)` restores full creator permissions for owner content.
  const isCreator = isHubOwner(hub, userPubkey) || (!!member && isHubOwner(hub, member.pubkey))
  const memberRoles = member?.roles || 'everyone'
  return getEffectivePermissions(hub, memberRoles, channelId, isCreator)
}

// ─── Channel Access (visibility) ───

/**
 * Resolve a channel's effective group-encryption id: its own, or (for a synced
 * channel) its category's. Returns null for channels that use the hub-wide secret.
 */
export function getChannelGroupId(hub: HubData, channelId: string): string | null {
  const ch = hub.channels.find(c => c.channelId === channelId)
  if (!ch) return null
  if (ch.encryption) return ch.encryption
  if (ch.synced && ch.categoryId) {
    const cat = hub.categories.find(c => c.categoryId === ch.categoryId)
    if (cat?.encryption) return cat.encryption
  }
  return null
}

/**
 * Can the given user SEE/open a channel? Mirrors the sidebar's visibility rule:
 * the view_channel permission AND possession of any required group secret. The hub
 * creator always has access. Reads live store state (hub, members, group secrets).
 */
export function canAccessChannel(hubDTag: string, channelId: string, userPubkey: string): boolean {
  const state = useHubStore.getState()
  const hub = state.hubs[hubDTag]
  if (!hub) return false
  if (isHubOwner(hub, userPubkey)) return true

  const hubMembers = state.hubMembers[hubDTag]
  const perms = getPermissionsForUser(hub, userPubkey, hubMembers, channelId)
  if (!perms.view_channel) return false

  const groupId = getChannelGroupId(hub, channelId)
  if (groupId) {
    const groupSecrets = state.groupSecrets[hubDTag]
    if (!(groupSecrets && groupSecrets[groupId])) return false
  }
  return true
}

/**
 * Should the user receive unread badges / notification sounds for a channel?
 * Requires hub membership on top of channel visibility. Membership is proven by
 * possession of the hub secret — a pending join request can't decrypt the LKH
 * tree, so it never holds the secret. This suppresses notifications for hubs the
 * user hasn't joined and for channels they can't access.
 */
export function canReceiveChannelNotification(hubDTag: string, channelId: string, userPubkey: string): boolean {
  const state = useHubStore.getState()
  const hub = state.hubs[hubDTag]
  if (!hub) return false
  if (isHubOwner(hub, userPubkey)) return true
  // Membership proof — only synced members hold the hub secret.
  if (!state.hubSecrets[hubDTag]) return false
  return canAccessChannel(hubDTag, channelId, userPubkey)
}
