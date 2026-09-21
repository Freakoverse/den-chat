/**
 * groupStore — the user's groups (NIP-CHAT §21): the kind-16943 list entries and per-group load
 * status. The loaded group's chat state (secret, members, epoch secrets, the single-channel HubData)
 * lives in the HUB store under the group's d-tag (flagged `isGroup`), so the message pipeline reuses
 * unchanged. This store only knows which groups exist for this user and how their load went.
 */
import { create } from 'zustand'
import type { GroupEntry } from '@/lib/group/groupList'
import type { GroupData } from '@/lib/group/groupEvent'

export type GroupStatus =
  | 'loading'
  | 'loaded'
  | 'not-found'   // no event on the hinted + client relays
  | 'removed'     // event found, but my leaf is gone (creator removed me)
  | 'deleted'     // tombstone
  | 'unsupported' // v2 group and this signer can't do NIP-SKD
  | 'error'

interface GroupState {
  entries: GroupEntry[]
  listLoaded: boolean
  listCreatedAt: number | null
  status: Record<string, GroupStatus>
  /** The parsed group event per d-tag (creator ops need the raw tree/history/settings). */
  groups: Record<string, GroupData>
  /** Group open in the DM page's Groups tab. */
  activeGroupId: string | null
  /** Which DM page section is showing ('dms' | 'groups'). Lives here (not in DMPage state) because the
   *  page is mounted separately for the desktop and mobile layouts and remounts on a breakpoint change. */
  dmSection: 'dms' | 'groups'
  setDmSection: (s: 'dms' | 'groups') => void
  /** Pending invites the user is looking at (naddr coords), not yet accepted. */
  pendingInvites: string[]
  /** Bumped by requestOpenGroup so the DM page switches to the Groups section even if the id is unchanged. */
  openNonce: number

  setEntries: (entries: GroupEntry[], createdAt?: number | null) => void
  /** Open a group in the DM page (from a shared card etc.): sets it active + bumps openNonce. */
  requestOpenGroup: (dTag: string) => void
  addEntry: (entry: GroupEntry) => void
  removeEntry: (dTag: string) => void
  setStatus: (dTag: string, status: GroupStatus) => void
  setGroup: (dTag: string, group: GroupData, raw?: import('nostr-tools').Event) => void
  /** The latest raw kind-36950 event per group (for "View raw event"). */
  rawEvents: Record<string, import('nostr-tools').Event>
  removeGroup: (dTag: string) => void
  setActiveGroup: (dTag: string | null) => void
  addPendingInvite: (a: string) => void
  removePendingInvite: (a: string) => void
  reset: () => void
}

export const useGroupStore = create<GroupState>((set) => ({
  entries: [],
  listLoaded: false,
  listCreatedAt: null,
  status: {},
  groups: {},
  activeGroupId: null,
  dmSection: 'dms',
  setDmSection: (dmSection) => set({ dmSection }),
  pendingInvites: [],
  openNonce: 0,

  requestOpenGroup: (dTag) => set((s) => ({ activeGroupId: dTag, openNonce: s.openNonce + 1 })),
  setEntries: (entries, createdAt = null) => set({ entries: [...entries].sort((a, b) => a.position - b.position), listLoaded: true, listCreatedAt: createdAt }),
  addEntry: (entry) => set((s) => (s.entries.some((e) => e.dTag === entry.dTag) ? {} : { entries: [...s.entries, entry] })),
  removeEntry: (dTag) => set((s) => ({ entries: s.entries.filter((e) => e.dTag !== dTag) })),
  setStatus: (dTag, status) => set((s) => ({ status: { ...s.status, [dTag]: status } })),
  rawEvents: {},
  setGroup: (dTag, group, raw) => set((s) => ({ groups: { ...s.groups, [dTag]: group }, ...(raw ? { rawEvents: { ...s.rawEvents, [dTag]: raw } } : {}) })),
  removeGroup: (dTag) => set((s) => {
    const { [dTag]: _g, ...groups } = s.groups
    const { [dTag]: _st, ...status } = s.status
    return { groups, status, activeGroupId: s.activeGroupId === dTag ? null : s.activeGroupId }
  }),
  setActiveGroup: (dTag) => set({ activeGroupId: dTag }),
  addPendingInvite: (a) => set((s) => (s.pendingInvites.includes(a) ? {} : { pendingInvites: [...s.pendingInvites, a] })),
  removePendingInvite: (a) => set((s) => ({ pendingInvites: s.pendingInvites.filter((x) => x !== a) })),
  reset: () => set({ entries: [], listLoaded: false, listCreatedAt: null, status: {}, groups: {}, activeGroupId: null, pendingInvites: [] }),
}))
