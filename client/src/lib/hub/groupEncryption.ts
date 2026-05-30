/**
 * Group Encryption — Utilities for grouped role encryption
 *
 * Per NIP-CHAT §15: channels/categories can be encrypted for specific role sets.
 * Each unique set of roles gets its own LKH tree and secret.
 *
 * The group ID is a deterministic SHA-256 hash of the sorted role IDs,
 * so the same set of roles always maps to the same group regardless of order.
 */

// ─── Types ───

export interface GroupedRole {
  /** Deterministic hash of sorted role IDs */
  groupId: string
  /** Role IDs that define this group */
  roleIds: string[]
  /** Current group secret epoch (independent of hub epoch) */
  epoch: number
}

// ─── Group ID Computation ───

/**
 * Compute a deterministic group ID from a set of role IDs.
 * The result is the same regardless of input order.
 *
 * @param roleIds - Array of role UUIDs
 * @returns SHA-256 hex hash of sorted, comma-joined role IDs
 */
export async function computeGroupId(roleIds: string[]): Promise<string> {
  const sorted = [...roleIds].sort()
  const joined = sorted.join(',')
  const encoded = new TextEncoder().encode(joined)
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Check if a member's roles intersect with a group's role set.
 * A member qualifies for a group if they have at least one of the group's roles.
 *
 * @param memberRoles - Pipe-separated role IDs (e.g. "uuid1|uuid2")
 * @param groupRoleIds - The group's role IDs
 * @returns true if the member has at least one matching role
 */
export function memberQualifiesForGroup(memberRoles: string, groupRoleIds: string[]): boolean {
  const memberRoleSet = new Set(memberRoles.split('|').map(s => s.trim()).filter(Boolean))
  return groupRoleIds.some(rid => memberRoleSet.has(rid))
}

/**
 * Get all members who qualify for a group based on their roles.
 *
 * @param members - Array of {pubkey, roles} from the hub member list
 * @param groupRoleIds - The group's role IDs
 * @returns Filtered array of qualifying members
 */
export function getGroupMembers(
  members: Array<{ pubkey: string; roles: string }>,
  groupRoleIds: string[],
): Array<{ pubkey: string; roles: string }> {
  return members.filter(m => memberQualifiesForGroup(m.roles, groupRoleIds))
}
