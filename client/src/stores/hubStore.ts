import { create } from 'zustand'
import type { GroupedRole } from '@/lib/hub/groupEncryption'

export interface HubFolder {
  id: string
  name: string
  color?: string    // hex color for folder accent (e.g. '#7c5cff')
  position: number  // ordering among folders
}

export interface HubEntry {
  dTag: string
  relayHint: string
  position: number
  folderId?: string
  facilitator?: string   // npub of the user's facilitator for this hub
}

export interface HubPrefs {
  showFacilitatedMessages: boolean // default true
  facilitator?: string             // facilitator npub (also stored in HubEntry for persistence)
  facilitatorSecret?: string       // hub secret obtained via facilitator's tree (hex)
}

export interface HubData {
  dTag: string
  creatorPubkey: string
  name: string
  icon?: string
  banner?: string
  tags?: string[]
  description?: string
  epoch: number
  generalRelays: string[]
  filterRelays: string[]
  blossomServers: string[]
  indexFileHash: string
  channels: Channel[]
  categories: Category[]
  roles: Role[]
  minPow: number
  nsfw?: boolean
  discoverable?: boolean
  deleted?: boolean
  /** Grouped role definitions for private channels/categories */
  groupedRoles?: GroupedRole[]
  /** Original publication timestamp (from published_at tag) — stable across updates */
  publishedAt?: number
  /** Actual event created_at — used for +1 replacement on updates */
  eventCreatedAt?: number
}

export interface Channel {
  channelId: string
  name: string
  type: 'chat' | 'announcement' | 'forum' | 'voice'
  categoryId: string | null
  synced: boolean
  encryption: string | null
  position: number
  description?: string
  /** Per-role permission overrides: { [roleId]: { [permKey]: boolean } } */
  permissions?: Record<string, Record<string, boolean>>
}

export interface Category {
  categoryId: string
  name: string
  position: number
  encryption: string | null
  /** Per-role permission overrides: { [roleId]: { [permKey]: boolean } } */
  permissions?: Record<string, Record<string, boolean>>
}

export interface Role {
  roleId: string
  name: string
  color?: string
  position: number
  hoist?: boolean
  permissions: Record<string, boolean>
}

export type HubStatus = 'loaded' | 'not-found' | 'deleted'

/** A single hide-message entry */
export interface HideEntry {
  ref: string         // a-tag value ("36943:pubkey:dTag") or event ID
  hiderPubkey: string // who hid it
  kind: number        // kind of the hidden event
  targetPubkey: string // author of the hidden message
  createdAt: number   // timestamp of the hide event
}

export interface HubMember {
  pubkey: string
  roles: string
  flags?: string
}

export interface HubState {
  /** All hub entries from User Hub List (kind 16942) */
  hubEntries: HubEntry[]
  /** Folder definitions */
  folders: HubFolder[]
  /** Whether the hub list has been fetched from relays */
  hubListLoaded: boolean
  /** Loaded hub data (keyed by d tag) */
  hubs: Record<string, HubData>
  /** Per-hub load status */
  hubStatus: Record<string, HubStatus>
  /** Decrypted hub secrets (keyed by d tag) — Uint8Array stored as hex */
  hubSecrets: Record<string, string>
  /** Currently selected hub d tag */
  activeHubId: string | null
  /** Currently selected channel id */
  activeChannelId: string | null
  /** Whether to hide deleted hubs from the sidebar */
  hideDeletedHubs: boolean
  /** Whether to hide not-found hubs from the sidebar */
  hideNotFoundHubs: boolean
  /** Hub members extracted from LKH tree (keyed by hub d tag) */
  hubMembers: Record<string, HubMember[]>
  /** Hub being previewed (ephemeral, not in hub list event) */
  previewHubId: string | null
  /** Per-hub preferences (facilitator, visibility toggles) */
  hubPrefs: Record<string, HubPrefs>
  /** Per-hub ban lists loaded from Blossom ban pages (keyed by hub d tag) */
  hubBanLists: Record<string, string[]>
  /** Per-hub facilitator member lists: hubDTag -> facilitatorPubkey -> member pubkeys */
  hubFacilitatorMembers: Record<string, Record<string, string[]>>
  /** Per-hub moderator ban lists: hubDTag → modPubkey → banned pubkeys */
  modBanLists: Record<string, Record<string, string[]>>
  /** Hide messages from non-members in hub chat (default: true) */
  hideNonMemberMessages: boolean
  /** Decrypted group secrets: hubDTag → groupId → hex secret */
  groupSecrets: Record<string, Record<string, string>>
  /** Historical epoch secrets: hubDTag → epoch → secretHex (from history file) */
  epochSecrets: Record<string, Record<number, string>>
  /** Hidden messages: hubDTag → ref → HideEntry */
  hiddenMessages: Record<string, Record<string, HideEntry>>
  /** Historical group epoch secrets: hubDTag → groupId → epoch → secretHex */
  groupEpochSecrets: Record<string, Record<string, Record<number, string>>>
  /** Tracks whether blossom secret resolution has completed for each hub.
   *  false/absent = still loading, true = resolved (may or may not have a secret). */
  hubSecretsResolved: Record<string, boolean>
  /** Number of leaf pages in the paginated index (0 or absent = monolithic / unknown) */
  hubPageCounts: Record<string, number>
  /** Lightweight version counter incremented whenever any secret changes.
   *  Allows consumers (e.g. useMessages) to react to secret updates without
   *  subscribing to the full secret objects (which would cause new references). */
  _secretsVersion: number

  /** Actions */
  setHubEntries: (entries: HubEntry[], folders: HubFolder[]) => void
  setHubListLoaded: (loaded: boolean) => void
  setHubData: (dTag: string, data: HubData) => void
  setHubStatus: (dTag: string, status: HubStatus) => void
  setHubSecret: (dTag: string, secretHex: string) => void
  setActiveHub: (dTag: string | null) => void
  setActiveChannel: (channelId: string | null) => void
  removeHubEntry: (dTag: string) => void
  setHideDeletedHubs: (hide: boolean) => void
  setHideNotFoundHubs: (hide: boolean) => void
  setHubMembers: (dTag: string, members: HubMember[]) => void
  setPreviewHub: (dTag: string | null) => void
  setHubPref: <K extends keyof HubPrefs>(dTag: string, key: K, value: HubPrefs[K]) => void
  setHubBanList: (dTag: string, pubkeys: string[]) => void
  setHubFacilitatorMembers: (dTag: string, facilitatorPubkey: string, members: string[]) => void
  setModBanList: (dTag: string, modPubkey: string, bannedPubkeys: string[]) => void
  setHideNonMemberMessages: (hide: boolean) => void
  setGroupSecret: (dTag: string, groupId: string, secretHex: string) => void
  setEpochSecrets: (dTag: string, secrets: Record<number, string>) => void
  setGroupEpochSecrets: (dTag: string, groupId: string, secrets: Record<number, string>) => void
  setHubSecretsResolved: (dTag: string, resolved: boolean) => void
  setHubPageCount: (dTag: string, pageCount: number) => void
  setHiddenMessages: (dTag: string, entries: Record<string, HideEntry>) => void
  addHiddenMessage: (dTag: string, entry: HideEntry) => void
  removeHiddenMessage: (dTag: string, ref: string) => void
  clearHiddenMessages: (dTag: string) => void
}

export const useHubStore = create<HubState>((set) => ({
  hubEntries: [],
  folders: [],
  hubListLoaded: false,
  hubs: {},
  hubStatus: {},
  hubSecrets: {},
  activeHubId: null,
  activeChannelId: null,
  hideDeletedHubs: localStorage.getItem('den_hide_deleted_hubs') !== 'false',
  hideNotFoundHubs: localStorage.getItem('den_hide_notfound_hubs') !== 'false',
  hubMembers: {},
  previewHubId: null,
  hubPrefs: {},
  hubBanLists: {},
  hubFacilitatorMembers: {},
  modBanLists: {},
  hideNonMemberMessages: localStorage.getItem('den_hide_nonmember_msgs') !== 'false',
  groupSecrets: {},
  epochSecrets: {},
  groupEpochSecrets: {},
  hiddenMessages: {},
  hubSecretsResolved: {},
  hubPageCounts: {},
  _secretsVersion: 0,

  setHubEntries: (entries, folders) => set({ hubEntries: entries, folders, hubListLoaded: true }),
  setHubListLoaded: (loaded) => set({ hubListLoaded: loaded }),

  setHubData: (dTag, data) =>
    set((state) => ({ hubs: { ...state.hubs, [dTag]: data } })),

  setHubStatus: (dTag, status) =>
    set((state) => ({ hubStatus: { ...state.hubStatus, [dTag]: status } })),

  setHubSecret: (dTag, secretHex) =>
    set((state) => ({ hubSecrets: { ...state.hubSecrets, [dTag]: secretHex }, _secretsVersion: state._secretsVersion + 1 })),

  setActiveHub: (dTag) => set((state) => {
    // Persist last-active hub for startup prioritization (Phase 5)
    if (dTag) {
      localStorage.setItem('den_last_active_hub', dTag)
    }
    // If navigating away from a preview hub, clear it
    const clearPreview = state.previewHubId && dTag !== state.previewHubId
      ? { previewHubId: null }
      : {}
    return { activeHubId: dTag, activeChannelId: null, ...clearPreview }
  }),

  setActiveChannel: (channelId) => set({ activeChannelId: channelId }),

  removeHubEntry: (dTag) =>
    set((state) => ({
      hubEntries: state.hubEntries.filter((e) => e.dTag !== dTag),
      activeHubId: state.activeHubId === dTag ? null : state.activeHubId,
      activeChannelId: state.activeHubId === dTag ? null : state.activeChannelId,
    })),

  setHideDeletedHubs: (hide) => {
    localStorage.setItem('den_hide_deleted_hubs', String(hide))
    set({ hideDeletedHubs: hide })
  },

  setHideNotFoundHubs: (hide) => {
    localStorage.setItem('den_hide_notfound_hubs', String(hide))
    set({ hideNotFoundHubs: hide })
  },

  setHubMembers: (dTag, members) =>
    set((state) => ({ hubMembers: { ...state.hubMembers, [dTag]: members } })),

  setPreviewHub: (dTag) => set({ previewHubId: dTag }),

  setHubPref: (dTag, key, value) =>
    set((state) => {
      const existing = state.hubPrefs[dTag] || { showFacilitatedMessages: true }
      return { hubPrefs: { ...state.hubPrefs, [dTag]: { ...existing, [key]: value } } }
    }),

  setHubBanList: (dTag, pubkeys) =>
    set((state) => ({ hubBanLists: { ...state.hubBanLists, [dTag]: pubkeys } })),

  setHubFacilitatorMembers: (dTag, facilitatorPubkey, members) =>
    set((state) => ({
      hubFacilitatorMembers: {
        ...state.hubFacilitatorMembers,
        [dTag]: { ...(state.hubFacilitatorMembers[dTag] || {}), [facilitatorPubkey]: members },
      },
    })),

  setModBanList: (dTag, modPubkey, bannedPubkeys) =>
    set((state) => ({
      modBanLists: {
        ...state.modBanLists,
        [dTag]: { ...(state.modBanLists[dTag] || {}), [modPubkey]: bannedPubkeys },
      },
    })),

  setHideNonMemberMessages: (hide) => {
    localStorage.setItem('den_hide_nonmember_msgs', String(hide))
    set({ hideNonMemberMessages: hide })
  },

  setGroupSecret: (dTag, groupId, secretHex) =>
    set((state) => ({
      groupSecrets: {
        ...state.groupSecrets,
        [dTag]: { ...(state.groupSecrets[dTag] || {}), [groupId]: secretHex },
      },
      _secretsVersion: state._secretsVersion + 1,
    })),

  setEpochSecrets: (dTag, secrets) =>
    set((state) => ({ epochSecrets: { ...state.epochSecrets, [dTag]: secrets }, _secretsVersion: state._secretsVersion + 1 })),

  setGroupEpochSecrets: (dTag, groupId, secrets) =>
    set((state) => ({
      groupEpochSecrets: {
        ...state.groupEpochSecrets,
        [dTag]: {
          ...(state.groupEpochSecrets[dTag] || {}),
          [groupId]: secrets,
        },
      },
      _secretsVersion: state._secretsVersion + 1,
    })),

  setHubSecretsResolved: (dTag, resolved) =>
    set((state) => ({ hubSecretsResolved: { ...state.hubSecretsResolved, [dTag]: resolved } })),

  setHubPageCount: (dTag, pageCount) =>
    set((state) => ({ hubPageCounts: { ...state.hubPageCounts, [dTag]: pageCount } })),

  setHiddenMessages: (dTag, entries) =>
    set((state) => ({ hiddenMessages: { ...state.hiddenMessages, [dTag]: entries } })),

  addHiddenMessage: (dTag, entry) =>
    set((state) => ({
      hiddenMessages: {
        ...state.hiddenMessages,
        [dTag]: { ...(state.hiddenMessages[dTag] || {}), [entry.ref]: entry },
      },
    })),

  removeHiddenMessage: (dTag, ref) =>
    set((state) => {
      const existing = { ...(state.hiddenMessages[dTag] || {}) }
      delete existing[ref]
      return { hiddenMessages: { ...state.hiddenMessages, [dTag]: existing } }
    }),

  clearHiddenMessages: (dTag) =>
    set((state) => {
      const next = { ...state.hiddenMessages }
      delete next[dTag]
      return { hiddenMessages: next }
    }),
}))

/** Standalone helper to read hub prefs without re-render subscription */
export function getHubPrefs(dTag: string): HubPrefs {
  return useHubStore.getState().hubPrefs[dTag] || { showFacilitatedMessages: true }
}
