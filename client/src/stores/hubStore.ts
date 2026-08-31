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
  blossomServers: string[]
  indexFileHash: string
  channels: Channel[]
  categories: Category[]
  roles: Role[]
  minPow: number
  joinMinPow: number
  /** Disappearing-messages timer in SECONDS (a duration, not a timestamp).
   *  undefined or 0 = off. When set, durable chat events are stamped with a
   *  NIP-40 expiration of created_at + this value. */
  messageExpiration?: number
  /** Hub format version from the `version` tag (NIP-CHAT §0). undefined/1 = v1
   *  (public); 2 = v2 (member-identity privacy). */
  version?: number
  /** NIP-SKD derivation scheme from the `signer_scheme` tag, as "family:version"
   *  (v2 only). undefined ⇒ default "skd:1". */
  signerScheme?: string
  /** v2 only: the owner's REAL key R_owner (from the decrypted owner attestation). Members-only;
   *  used to authorize the owner's pseudonymous moderation actions (hide/unhide). */
  ownerRealPubkey?: string
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
  /**
   * Channel (`c` tag) the hide was authored in and authorized against. A hide only takes effect when
   * rendered in THIS channel — so a mod authorized to hide only in channel X can't hide a message that
   * actually lives in channel Y by tagging it `c:X` (the Y render won't match). Absent ⇒ legacy hub-wide.
   */
  channelId?: string
}

export interface HubMember {
  pubkey: string
  roles: string
  flags?: string
  /** v2 only: the member's pseudonym `P` (leaf id in the tree; `pubkey` is their real key `R`). */
  p?: string
}

export interface HubState {
  /** All hub entries from User Hub List (kind 16942) */
  hubEntries: HubEntry[]
  /** Folder definitions */
  folders: HubFolder[]
  /** Whether the hub list has been fetched from relays */
  hubListLoaded: boolean
  /** created_at of the hub-list event (kind 16942) the client currently holds — so
   *  the redundancy check can tell "relays are stale" from "relays have the latest". */
  hubListCreatedAt?: number
  /** Raw NIP-44-encrypted content of the hub-list event, kept so the v2 (private) memberships
   *  can be re-decrypted once a remote signer becomes available — the first decrypt at startup
   *  can fail (signer not yet connected / awaiting approval), and we must not permanently drop
   *  the private hubs when it does. */
  hubListPrivateContent?: string
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
  /** Why hub secret decryption failed: 'signer-issue' = signer declined/unavailable,
   *  'not-a-member' = pubkey not found in LKH tree */
  hubSecretFailReason: Record<string, 'signer-issue' | 'not-a-member'>
  /** Lightweight version counter incremented whenever any secret changes.
   *  Allows consumers (e.g. useMessages) to react to secret updates without
   *  subscribing to the full secret objects (which would cause new references). */
  _secretsVersion: number
  /** Bumped to force useHubLoader to re-attempt hubs whose secret failed to
   *  decrypt (e.g. after a remote-signer reconnect on app resume). */
  hubSecretRetryNonce: number
  /** Bumped to force useHubLoader to re-fetch a single hub from scratch — used by
   *  the "Try again" action on a not-found hub. `hubReloadTarget` names the hub. */
  hubReloadNonce: number
  hubReloadTarget: string | null

  /** Actions */
  setHubEntries: (entries: HubEntry[], folders: HubFolder[]) => void
  setHubListCreatedAt: (ts: number) => void
  setHubListPrivateContent: (content: string | undefined) => void
  bumpHubSecretRetry: () => void
  /** Clear a hub's status and force the loader to re-fetch it from scratch. */
  retryHub: (dTag: string) => void
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
  setHubSecretFailReason: (dTag: string, reason: 'signer-issue' | 'not-a-member') => void
  /** Load the account's namespaced hub prefs + facilitator member-lists (call on login/session restore). */
  hydratePersistedForAccount: (account: string) => void
}

// ── hubPrefs persistence ──
// We persist ONLY the public bits across reloads: the chosen `facilitator` (npub) and the
// `showFacilitatedMessages` toggle. The `facilitatorSecret` is deliberately NOT persisted — it's a
// hub secret and gets re-derived from the facilitator's tree on load. Persisting `facilitator` is
// what lets a facilitated user avoid re-entering the npub every session (the loader auto-fetches).
// SECURITY: hub prefs (facilitator npub per hub) + facilitator member-lists (Pf pseudonyms) are
// namespaced by the logged-in account — `den_hub_prefs:<account>` — so one account's hub relationships
// don't bleed to another account on the same device, and a hard-reset on switch doesn't restore the
// first account's data. `_currentAccount` is set by `hydratePersistedForAccount` (called on login);
// until then nothing is persisted (no un-namespaced global write). The legacy un-namespaced keys are
// deleted on hydrate (one-time; a facilitated user re-enters their facilitator handle, and the Pf
// member-lists are a background-revalidated cache, so the loss is minor and self-healing).
const HUB_PREFS_LEGACY_KEY = 'den_hub_prefs'
const FAC_MEMBERS_LEGACY_KEY = 'den_hub_fac_members'
let _currentAccount: string | null = null
function hubPrefsKey(account: string): string { return `den_hub_prefs:${account}` }
function facMembersKey(account: string): string { return `den_hub_fac_members:${account}` }

function loadPersistedHubPrefs(account: string | null): Record<string, HubPrefs> {
  if (!account) return {}
  try {
    const raw = localStorage.getItem(hubPrefsKey(account))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, Partial<HubPrefs>>
    const out: Record<string, HubPrefs> = {}
    for (const [dTag, p] of Object.entries(parsed)) {
      out[dTag] = {
        showFacilitatedMessages: p.showFacilitatedMessages ?? true,
        ...(p.facilitator ? { facilitator: p.facilitator } : {}),
      }
    }
    return out
  } catch {
    return {}
  }
}

function persistHubPrefs(prefs: Record<string, HubPrefs>): void {
  if (!_currentAccount) return
  try {
    const slim: Record<string, { showFacilitatedMessages: boolean; facilitator?: string }> = {}
    for (const [dTag, p] of Object.entries(prefs)) {
      // Skip default-only entries to keep storage tidy; drop the secret.
      if (p.showFacilitatedMessages === false || p.facilitator) {
        slim[dTag] = {
          showFacilitatedMessages: p.showFacilitatedMessages,
          ...(p.facilitator ? { facilitator: p.facilitator } : {}),
        }
      }
    }
    localStorage.setItem(hubPrefsKey(_currentAccount), JSON.stringify(slim))
  } catch { /* storage unavailable — non-fatal */ }
}

// ── Facilitator member-list cache persistence ──
// Persist the vouched-member lists (public Pf pseudonyms only — no secrets, no real keys R) so that on
// a fresh app start a member can immediately validate a facilitated author's messages instead of
// re-fetching each facilitator's tree and waiting. Revalidated in the background on hub open.
function loadPersistedFacilitatorMembers(account: string | null): Record<string, Record<string, string[]>> {
  if (!account) return {}
  try {
    const raw = localStorage.getItem(facMembersKey(account))
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function persistFacilitatorMembers(map: Record<string, Record<string, string[]>>): void {
  if (!_currentAccount) return
  try {
    localStorage.setItem(facMembersKey(_currentAccount), JSON.stringify(map))
  } catch { /* storage unavailable / quota — non-fatal */ }
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
  // Default to SHOWING not-found hubs: they render as a clickable "broken" icon
  // with a retry action, so hiding them by default would bury that affordance.
  // Only hide when the user has explicitly opted in.
  hideNotFoundHubs: localStorage.getItem('den_hide_notfound_hubs') === 'true',
  hubMembers: {},
  previewHubId: null,
  // Start empty — hydrated per-account by hydratePersistedForAccount() on login (persistence is
  // namespaced by account, and there is no account at module-eval time).
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
  hubSecretFailReason: {},
  _secretsVersion: 0,
  hubSecretRetryNonce: 0,
  hubReloadNonce: 0,
  hubReloadTarget: null,
  bumpHubSecretRetry: () => set((state) => ({ hubSecretRetryNonce: state.hubSecretRetryNonce + 1 })),
  retryHub: (dTag) => set((state) => {
    // Clear the terminal status so the sidebar shows the pending/loading state
    // again, and point the loader at this hub via the reload nonce.
    const hubStatus = { ...state.hubStatus }
    delete hubStatus[dTag]
    return { hubStatus, hubReloadTarget: dTag, hubReloadNonce: state.hubReloadNonce + 1 }
  }),

  setHubEntries: (entries, folders) => set({ hubEntries: entries, folders, hubListLoaded: true }),
  setHubListLoaded: (loaded) => set({ hubListLoaded: loaded }),
  setHubListCreatedAt: (ts) => set({ hubListCreatedAt: ts }),
  setHubListPrivateContent: (content) => set({ hubListPrivateContent: content }),

  setHubData: (dTag, data) =>
    set((state) => {
      const prev = state.hubs[dTag]
      // v2: `ownerRealPubkey` is decoded from the encrypted owner attestation (async, only after the
      // hub secret loads). A re-parse of a republished/live-updated event (via `parseHubEvent`) has
      // no way to include it, so it arrives undefined. Carry the known value forward — it's stable
      // per hub and only ever set on load — so `isCreator` doesn't briefly flicker to false (which
      // made the owner UI disappear for a second or two after every hub update).
      const merged = (prev?.ownerRealPubkey && !data.ownerRealPubkey)
        ? { ...data, ownerRealPubkey: prev.ownerRealPubkey }
        : data
      return { hubs: { ...state.hubs, [dTag]: merged } }
    }),

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

  hydratePersistedForAccount: (account) => {
    _currentAccount = account
    // One-time deletion of the legacy un-namespaced keys (they bled across accounts). No migration:
    // assigning the shared blob to whichever account hydrates first would itself be a cross-account bleed.
    try { localStorage.removeItem(HUB_PREFS_LEGACY_KEY); localStorage.removeItem(FAC_MEMBERS_LEGACY_KEY) } catch { /* non-fatal */ }
    set({
      hubPrefs: loadPersistedHubPrefs(account),
      hubFacilitatorMembers: loadPersistedFacilitatorMembers(account),
    })
  },

  setHubPref: (dTag, key, value) =>
    set((state) => {
      const existing = state.hubPrefs[dTag] || { showFacilitatedMessages: true }
      const hubPrefs = { ...state.hubPrefs, [dTag]: { ...existing, [key]: value } }
      persistHubPrefs(hubPrefs)
      return { hubPrefs }
    }),

  setHubBanList: (dTag, pubkeys) =>
    set((state) => ({ hubBanLists: { ...state.hubBanLists, [dTag]: pubkeys } })),

  setHubFacilitatorMembers: (dTag, facilitatorPubkey, members) =>
    set((state) => {
      const hubFacilitatorMembers = {
        ...state.hubFacilitatorMembers,
        [dTag]: { ...(state.hubFacilitatorMembers[dTag] || {}), [facilitatorPubkey]: members },
      }
      persistFacilitatorMembers(hubFacilitatorMembers)
      return { hubFacilitatorMembers }
    }),

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

  setHubSecretFailReason: (dTag, reason) =>
    set((state) => ({ hubSecretFailReason: { ...state.hubSecretFailReason, [dTag]: reason } })),
}))

/** Standalone helper to read hub prefs without re-render subscription */
export function getHubPrefs(dTag: string): HubPrefs {
  return useHubStore.getState().hubPrefs[dTag] || { showFacilitatedMessages: true }
}
