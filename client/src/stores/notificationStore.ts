/**
 * Notification Store — Central state management for all notification domains
 *
 * Manages unread counts, read timestamps, and relay sync for:
 * - Social feed (Jumble-compatible "seen at" watermark)
 * - Hub chat (per-hub, per-channel unread counts)
 * - DMs (NIP-17 and NIP-04 per-conversation)
 * - Public chat (per-topic)
 *
 * Persistence: NIP-78 event is the canonical state; localStorage caches it.
 * Publishing: 15s debounce batches rapid clicks, 60s throttle caps relay writes.
 *             Throttled publishes are automatically rescheduled (never dropped).
 */

import { create } from 'zustand'
import type { ISigner } from '@/stores/userStore'
import { guardedDecrypt, guardedEncrypt } from '@/lib/auth/signerGuard'
import type {
  HubReadState,
  HubMuteSettings,
  DmReadState,
  PcReadState,
  NotifDomain,
} from '@/lib/notifications/readState'
import {
  loadReadState,
  parseSocialSeenAt,
  parseHubReadState,
  parseDmReadState,
  parsePcReadState,
  buildSocialSeenAtEvent,
  buildHubReadStateEvent,
  buildDmReadStateEvent,
  buildPcReadStateEvent,
  signAndPublishReadState,
  getRemainingThrottleTime,
  pruneHubReadState,
  normalizeHubMuteSettings,
  hasAnyMute,
  saveCachedEvent,
  loadCachedEvent,
  setReadStateAccount,
  restoreReadStateAccount,
} from '@/lib/notifications/readState'

// ── Helpers ──

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}

// ── Types ──

export interface ChannelUnread {
  lastRead: number
  count: number
  hasMention: boolean
}

export interface ConversationUnread {
  lastRead: number
  count: number
}

export interface NotificationState {
  /** Whether the initial load from localStorage + relay has completed */
  initialized: boolean

  // ── Social ──
  /** Social feed "seen at" watermark (unix timestamp) */
  socialSeenAt: number
  /** Whether there are new social notifications since socialSeenAt */
  hasSocialNotification: boolean

  // ── Hub Chat ──
  /** Per-hub, per-channel unread state */
  hubUnreads: Record<string, Record<string, ChannelUnread>>
  /** Per-hub granular mute settings */
  hubMuteSettings: Record<string, HubMuteSettings>

  // ── DMs ──
  /** NIP-17 DM per-conversation unread state */
  dm17Unreads: Record<string, ConversationUnread>
  /** NIP-04 DM per-conversation unread state */
  dm04Unreads: Record<string, ConversationUnread>

  // ── Public Chat ──
  /** Per-topic read timestamps */
  pcReadTimes: Record<string, number>

  // ── Computed totals ──
  /** Total unread count across all hub channels (excluding muted hubs) */
  totalHubUnread: number
  /** Total DM unread count (NIP-17 + NIP-04) */
  totalDmUnread: number
  /** Grand total unread count (for tab title / tray badge) */
  totalUnread: number

  // ── Actions ──

  /** Initialize from localStorage + relay. Call once on app startup. */
  init: (pubkey: string, signer: ISigner | null, privateKey: string | null) => Promise<void>

  /** Reset all state (on logout) */
  reset: () => void

  // Social
  updateSocialSeenAt: (signer: ISigner | null, privateKey: string | null) => Promise<void>
  setHasSocialNotification: (has: boolean) => void

  // Hub Chat
  markChannelRead: (hubDTag: string, channelId: string) => void
  /** Advance the read watermark for a channel the user is actively viewing, so
   *  messages seen live aren't re-counted as unread by a later refresh scan. */
  advanceChannelRead: (hubDTag: string, channelId: string, messageTimestamp: number) => void
  markHubRead: (hubDTag: string) => void
  incrementChannelUnread: (hubDTag: string, channelId: string, messageTimestamp: number, mentionType?: 'personal' | 'everyone' | 'here' | 'role') => void
  setHubMuteSettings: (hubDTag: string, settings: HubMuteSettings) => void
  pruneHubs: (activeHubDTags: Set<string>, channelsByHub: Record<string, Set<string>>) => void

  // DMs
  markDmRead: (conversationId: string, type: 'nip17' | 'nip04') => void
  incrementDmUnread: (conversationId: string, type: 'nip17' | 'nip04') => void

  // Public Chat
  markTopicRead: (topic: string) => void
  getTopicReadTime: (topic: string) => number

  // Persistence
  publishHubReadState: (signer: ISigner | null, privateKey: string | null) => Promise<boolean>
  publishDmReadState: (signer: ISigner | null, privateKey: string | null) => Promise<boolean>
  publishPcReadState: (signer: ISigner | null, privateKey: string | null) => Promise<boolean>
}

// ── Helpers ──

function computeTotalHubUnread(
  hubUnreads: Record<string, Record<string, ChannelUnread>>,
  hubMuteSettings: Record<string, HubMuteSettings>
): number {
  let total = 0
  for (const [hubDTag, channels] of Object.entries(hubUnreads)) {
    if (hubMuteSettings[hubDTag]?.all) continue
    for (const ch of Object.values(channels)) {
      total += ch.count
    }
  }
  return total
}

function computeTotalDmUnread(
  dm17: Record<string, ConversationUnread>,
  dm04: Record<string, ConversationUnread>
): number {
  let total = 0
  for (const c of Object.values(dm17)) total += c.count
  for (const c of Object.values(dm04)) total += c.count
  return total
}

function recomputeTotals(state: {
  hubUnreads: Record<string, Record<string, ChannelUnread>>
  hubMuteSettings: Record<string, HubMuteSettings>
  dm17Unreads: Record<string, ConversationUnread>
  dm04Unreads: Record<string, ConversationUnread>
}) {
  const totalHubUnread = computeTotalHubUnread(state.hubUnreads, state.hubMuteSettings)
  const totalDmUnread = computeTotalDmUnread(state.dm17Unreads, state.dm04Unreads)
  return {
    totalHubUnread,
    totalDmUnread,
    totalUnread: totalHubUnread + totalDmUnread,
  }
}

/** Build HubReadState from the store's live state for serialization */
function buildHubReadStateFromStore(
  hubUnreads: Record<string, Record<string, ChannelUnread>>,
  hubMuteSettings: Record<string, HubMuteSettings>
): HubReadState {
  const hubs: HubReadState['hubs'] = {}
  for (const [hubDTag, channels] of Object.entries(hubUnreads)) {
    const hubEntry: Record<string, number> & { _muted?: HubMuteSettings | boolean } = {}
    const settings = hubMuteSettings[hubDTag]
    if (settings && hasAnyMute(settings)) hubEntry._muted = settings
    for (const [channelId, ch] of Object.entries(channels)) {
      hubEntry[channelId] = ch.lastRead
    }
    hubs[hubDTag] = hubEntry
  }
  return { hubs }
}

/** Build DmReadState from the store's live state for serialization */
function buildDmReadStateFromStore(
  dm17Unreads: Record<string, ConversationUnread>,
  dm04Unreads: Record<string, ConversationUnread>
): DmReadState {
  const dm17: Record<string, number> = {}
  const dm04: Record<string, number> = {}
  for (const [k, v] of Object.entries(dm17Unreads)) dm17[k] = v.lastRead
  for (const [k, v] of Object.entries(dm04Unreads)) dm04[k] = v.lastRead
  return { dm17, dm04 }
}

// ── Store ──

/**
 * Synchronous pre-load from localStorage.
 * The _save*ToLocalStorage functions store plaintext JSON (not encrypted),
 * so we can parse it instantly at module evaluation time — before any
 * message subscription delivers its first event. This eliminates the
 * "badges flash up then snap down" race condition.
 */
function preloadFromLocalStorage() {
  // Point the caches at the last-active account so this synchronous preload reads
  // that account's namespace (not a different account's, and not a shared bucket).
  restoreReadStateAccount()

  // Hub read-state
  let hubUnreads: Record<string, Record<string, ChannelUnread>> = {}
  let hubMuteSettings: Record<string, HubMuteSettings> = {}
  try {
    const hubCached = loadCachedEvent('hub')
    if (hubCached?.content) {
      const hubState = parseHubReadState(hubCached.content)
      for (const [hubDTag, hubData] of Object.entries(hubState.hubs)) {
        hubUnreads[hubDTag] = {}
        const muteRaw = hubData._muted
        if (muteRaw) hubMuteSettings[hubDTag] = normalizeHubMuteSettings(muteRaw)
        for (const [key, value] of Object.entries(hubData)) {
          if (key === '_muted') continue
          hubUnreads[hubDTag][key] = { lastRead: value as number, count: 0, hasMention: false }
        }
      }
    }
  } catch { /* ignore — will be overwritten by init() */ }

  // DM read-state
  let dm17Unreads: Record<string, ConversationUnread> = {}
  let dm04Unreads: Record<string, ConversationUnread> = {}
  try {
    const dmCached = loadCachedEvent('dm')
    if (dmCached?.content) {
      const dmState = parseDmReadState(dmCached.content)
      for (const [k, v] of Object.entries(dmState.dm17)) {
        dm17Unreads[k] = { lastRead: v, count: 0 }
      }
      for (const [k, v] of Object.entries(dmState.dm04)) {
        dm04Unreads[k] = { lastRead: v, count: 0 }
      }
    }
  } catch { /* ignore */ }

  // Social seen-at
  let socialSeenAt = 0
  try {
    const socialCached = loadCachedEvent('social')
    if (socialCached) socialSeenAt = parseSocialSeenAt(socialCached)
  } catch { /* ignore */ }

  // Public chat read-state
  let pcReadTimes: Record<string, number> = {}
  try {
    const pcCached = loadCachedEvent('pc')
    if (pcCached) {
      const pcState = parsePcReadState(pcCached)
      pcReadTimes = pcState.topics
    }
  } catch { /* ignore */ }

  return { hubUnreads, hubMuteSettings, dm17Unreads, dm04Unreads, socialSeenAt, pcReadTimes }
}

const _preloaded = preloadFromLocalStorage()

const initialState = {
  initialized: false,
  socialSeenAt: _preloaded.socialSeenAt,
  hasSocialNotification: false,
  hubUnreads: _preloaded.hubUnreads,
  hubMuteSettings: _preloaded.hubMuteSettings,
  dm17Unreads: _preloaded.dm17Unreads,
  dm04Unreads: _preloaded.dm04Unreads,
  pcReadTimes: _preloaded.pcReadTimes,
  ...recomputeTotals({
    hubUnreads: _preloaded.hubUnreads,
    hubMuteSettings: _preloaded.hubMuteSettings,
    dm17Unreads: _preloaded.dm17Unreads,
    dm04Unreads: _preloaded.dm04Unreads,
  }),
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  ...initialState,

  // ── Init ──

  init: async (pubkey, signer, privateKey) => {
    // Scope all read-state caches to this account before any load/save, so an
    // account switch never reads or overwrites another account's cache.
    setReadStateAccount(pubkey)

    // Load all four domains in parallel
    const [socialEvent, hubEvent, dmEvent, pcEvent] = await Promise.all([
      loadReadState(pubkey, 'social'),
      loadReadState(pubkey, 'hub'),
      loadReadState(pubkey, 'dm'),
      loadReadState(pubkey, 'pc'),
    ])

    // Parse social
    const socialSeenAt = parseSocialSeenAt(socialEvent)

    // Parse hub — content is encrypted (NIP-44 self-encryption, NIP-04 legacy fallback)
    let hubState: HubReadState = { hubs: {} }
    if (hubEvent?.content) {
      let hubDecrypted = false
      // Try NIP-44 decryption first (modern standard)
      if (!hubDecrypted && signer) {
        try {
          const decrypted = await guardedDecrypt(hubEvent.content, pubkey, signer, null, 'nip44')
          hubState = parseHubReadState(decrypted)
          hubDecrypted = true
        } catch { /* not NIP-44 encrypted or decrypt failed */ }
      }
      if (!hubDecrypted && privateKey) {
        try {
          const { nip44 } = await import('nostr-tools')
          const convKey = nip44.v2.utils.getConversationKey(hexToBytes(privateKey), pubkey)
          const decrypted = nip44.v2.decrypt(hubEvent.content, convKey)
          hubState = parseHubReadState(decrypted)
          hubDecrypted = true
        } catch { /* not NIP-44 encrypted or decrypt failed */ }
      }
      // Fallback: try NIP-04 decryption (backward compat with existing events)
      if (!hubDecrypted && signer) {
        try {
          const decrypted = await guardedDecrypt(hubEvent.content, pubkey, signer, null, 'nip04')
          hubState = parseHubReadState(decrypted)
          hubDecrypted = true
        } catch { /* not NIP-04 encrypted */ }
      }
      if (!hubDecrypted && privateKey) {
        try {
          const { nip04 } = await import('nostr-tools')
          const decrypted = await nip04.decrypt(privateKey, pubkey, hubEvent.content)
          hubState = parseHubReadState(decrypted)
          hubDecrypted = true
        } catch { /* not NIP-04 encrypted */ }
      }
      // Fallback: try plaintext parse (legacy / development)
      if (!hubDecrypted) {
        hubState = parseHubReadState(hubEvent.content)
      }
    }

    // Parse DM — content is encrypted (NIP-44 self-encryption, NIP-04 legacy fallback)
    let dmState: DmReadState = { dm17: {}, dm04: {} }
    if (dmEvent?.content) {
      let dmDecrypted = false
      // Try NIP-44 decryption first (modern standard)
      if (!dmDecrypted && signer) {
        try {
          const decrypted = await guardedDecrypt(dmEvent.content, pubkey, signer, null, 'nip44')
          dmState = parseDmReadState(decrypted)
          dmDecrypted = true
        } catch { /* not NIP-44 encrypted or decrypt failed */ }
      }
      if (!dmDecrypted && privateKey) {
        try {
          const { nip44 } = await import('nostr-tools')
          const convKey = nip44.v2.utils.getConversationKey(hexToBytes(privateKey), pubkey)
          const decrypted = nip44.v2.decrypt(dmEvent.content, convKey)
          dmState = parseDmReadState(decrypted)
          dmDecrypted = true
        } catch { /* not NIP-44 encrypted or decrypt failed */ }
      }
      // Fallback: try NIP-04 decryption (backward compat with existing events)
      if (!dmDecrypted && signer) {
        try {
          const decrypted = await guardedDecrypt(dmEvent.content, pubkey, signer, null, 'nip04')
          dmState = parseDmReadState(decrypted)
          dmDecrypted = true
        } catch { /* not NIP-04 encrypted */ }
      }
      if (!dmDecrypted && privateKey) {
        try {
          const { nip04 } = await import('nostr-tools')
          const decrypted = await nip04.decrypt(privateKey, pubkey, dmEvent.content)
          dmState = parseDmReadState(decrypted)
          dmDecrypted = true
        } catch { /* not NIP-04 encrypted */ }
      }
      // Fallback: try plaintext parse (legacy / development)
      if (!dmDecrypted) {
        dmState = parseDmReadState(dmEvent.content)
      }
    }

    // Parse public chat (plaintext)
    const pcState = parsePcReadState(pcEvent)

    // Hydrate hub unreads from read-state timestamps,
    // merging with any live counts accumulated from the preloaded state
    const liveState = get()
    const hubUnreads: Record<string, Record<string, ChannelUnread>> = {}
    const hubMuteSettings: Record<string, HubMuteSettings> = {}
    for (const [hubDTag, hubData] of Object.entries(hubState.hubs)) {
      hubUnreads[hubDTag] = {}
      const muteRaw = hubData._muted
      if (muteRaw) hubMuteSettings[hubDTag] = normalizeHubMuteSettings(muteRaw)
      for (const [key, value] of Object.entries(hubData)) {
        if (key === '_muted') continue
        const relayLastRead = value as number
        const live = liveState.hubUnreads[hubDTag]?.[key]
        if (live && live.lastRead >= relayLastRead) {
          // Preloaded lastRead is same or newer — keep live counts
          hubUnreads[hubDTag][key] = live
        } else {
          // Relay has a newer lastRead — reset counts (read elsewhere)
          hubUnreads[hubDTag][key] = { lastRead: relayLastRead, count: 0, hasMention: false }
        }
      }
    }
    // Also include any hub/channel entries from live state not in the relay event
    // (e.g. new channels discovered by subscription before init completes)
    for (const [hubDTag, channels] of Object.entries(liveState.hubUnreads)) {
      if (!hubUnreads[hubDTag]) hubUnreads[hubDTag] = {}
      for (const [chId, chData] of Object.entries(channels)) {
        if (!hubUnreads[hubDTag][chId]) {
          hubUnreads[hubDTag][chId] = chData
        }
      }
    }

    // Hydrate DM unreads, merging with live counts
    const dm17Unreads: Record<string, ConversationUnread> = {}
    const dm04Unreads: Record<string, ConversationUnread> = {}
    for (const [k, v] of Object.entries(dmState.dm17)) {
      const live = liveState.dm17Unreads[k]
      dm17Unreads[k] = (live && live.lastRead >= v) ? live : { lastRead: v, count: 0 }
    }
    for (const [k, v] of Object.entries(dmState.dm04)) {
      const live = liveState.dm04Unreads[k]
      dm04Unreads[k] = (live && live.lastRead >= v) ? live : { lastRead: v, count: 0 }
    }
    // Include any conversations from live state not in relay event
    for (const [k, v] of Object.entries(liveState.dm17Unreads)) {
      if (!dm17Unreads[k]) dm17Unreads[k] = v
    }
    for (const [k, v] of Object.entries(liveState.dm04Unreads)) {
      if (!dm04Unreads[k]) dm04Unreads[k] = v
    }

    set({
      initialized: true,
      socialSeenAt,
      hubUnreads,
      hubMuteSettings,
      dm17Unreads,
      dm04Unreads,
      pcReadTimes: pcState.topics,
      ...recomputeTotals({ hubUnreads, hubMuteSettings, dm17Unreads, dm04Unreads }),
    })

    // Flush decrypted plaintext to localStorage so the next app launch
    // preloads correctly (relay events may have overwritten cache with encrypted content)
    _saveHubToLocalStorage(get)
    _saveDmToLocalStorage(get)
    _savePcToLocalStorage(get)
  },

  reset: () => set({
    initialized: false,
    socialSeenAt: 0,
    hasSocialNotification: false,
    hubUnreads: {},
    hubMuteSettings: {},
    dm17Unreads: {},
    dm04Unreads: {},
    pcReadTimes: {},
    totalHubUnread: 0,
    totalDmUnread: 0,
    totalUnread: 0,
  }),

  // ── Social ──

  updateSocialSeenAt: async (signer, privateKey) => {
    const event = buildSocialSeenAtEvent()
    set({ socialSeenAt: event.created_at, hasSocialNotification: false })
    await signAndPublishReadState('social', event, signer, privateKey)
  },

  setHasSocialNotification: (has) => set({ hasSocialNotification: has }),

  // ── Hub Chat ──

  markChannelRead: (hubDTag, channelId) => {
    const now = Math.floor(Date.now() / 1000)
    set((state) => {
      const hubChannels = { ...(state.hubUnreads[hubDTag] || {}) }
      hubChannels[channelId] = {
        lastRead: now,
        count: 0,
        hasMention: false,
      }
      const hubUnreads = { ...state.hubUnreads, [hubDTag]: hubChannels }
      return { hubUnreads, ...recomputeTotals({ ...state, hubUnreads }) }
    })
    // Save to localStorage immediately
    _saveHubToLocalStorage(get)
  },

  advanceChannelRead: (hubDTag, channelId, messageTimestamp) => {
    set((state) => {
      const hubChannels = { ...(state.hubUnreads[hubDTag] || {}) }
      const existing = hubChannels[channelId] || { lastRead: 0, count: 0, hasMention: false }
      // Advance to the newest of: current watermark, this message's time, or now
      // (max() keeps it clock-skew-safe against future-dated events).
      const ts = Math.max(existing.lastRead, messageTimestamp, Math.floor(Date.now() / 1000))
      if (ts === existing.lastRead && existing.count === 0 && !existing.hasMention) return {}
      hubChannels[channelId] = { lastRead: ts, count: 0, hasMention: false }
      const hubUnreads = { ...state.hubUnreads, [hubDTag]: hubChannels }
      return { hubUnreads, ...recomputeTotals({ ...state, hubUnreads }) }
    })
    _saveHubToLocalStorage(get)
  },

  markHubRead: (hubDTag) => {
    const now = Math.floor(Date.now() / 1000)
    set((state) => {
      const hubChannels = { ...(state.hubUnreads[hubDTag] || {}) }
      for (const channelId of Object.keys(hubChannels)) {
        hubChannels[channelId] = { ...hubChannels[channelId], lastRead: now, count: 0, hasMention: false }
      }
      const hubUnreads = { ...state.hubUnreads, [hubDTag]: hubChannels }
      return { hubUnreads, ...recomputeTotals({ ...state, hubUnreads }) }
    })
    _saveHubToLocalStorage(get)
  },

  incrementChannelUnread: (hubDTag, channelId, messageTimestamp, mentionType) => {
    set((state) => {
      // Check granular mute settings — skip increment if muted for this type
      const muteSettings = state.hubMuteSettings[hubDTag]
      if (muteSettings) {
        if (muteSettings.all) return {}
        if (!mentionType && muteSettings.normal) return {}
        if (mentionType === 'personal' && muteSettings.mentions) return {}
        if (mentionType === 'everyone' && muteSettings.everyone) return {}
        if (mentionType === 'here' && muteSettings.here) return {}
        if (mentionType === 'role' && muteSettings.roles) return {}
      }
      const hubChannels = { ...(state.hubUnreads[hubDTag] || {}) }
      const existing = hubChannels[channelId] || { lastRead: 0, count: 0, hasMention: false }
      // Only count messages newer than the last read timestamp
      if (existing.lastRead > 0 && messageTimestamp <= existing.lastRead) return {}
      hubChannels[channelId] = {
        ...existing,
        count: existing.count + 1,
        hasMention: existing.hasMention || !!mentionType,
      }
      const hubUnreads = { ...state.hubUnreads, [hubDTag]: hubChannels }
      return { hubUnreads, ...recomputeTotals({ ...state, hubUnreads }) }
    })
  },

  setHubMuteSettings: (hubDTag, settings) => {
    set((state) => {
      const hubMuteSettings = { ...state.hubMuteSettings, [hubDTag]: settings }
      return { hubMuteSettings, ...recomputeTotals({ ...state, hubMuteSettings }) }
    })
    // Save to localStorage immediately (for local persistence), but do NOT
    // auto-publish to relay — the user must explicitly click "Save" in the UI.
    _saveHubToLocalStorage(get, true)
  },

  pruneHubs: (activeHubDTags, channelsByHub) => {
    set((state) => {
      const currentState = buildHubReadStateFromStore(state.hubUnreads, state.hubMuteSettings)
      const pruned = pruneHubReadState(currentState, activeHubDTags, channelsByHub)

      if (pruned === currentState) return {} // nothing changed

      // Rebuild hubUnreads from pruned state
      const hubUnreads: Record<string, Record<string, ChannelUnread>> = {}
      const hubMuteSettings: Record<string, HubMuteSettings> = {}
      for (const [hubDTag, hubData] of Object.entries(pruned.hubs)) {
        hubUnreads[hubDTag] = {}
        const muteRaw = hubData._muted
        if (muteRaw) hubMuteSettings[hubDTag] = normalizeHubMuteSettings(muteRaw)
        for (const [key, value] of Object.entries(hubData)) {
          if (key === '_muted') continue
          const existing = state.hubUnreads[hubDTag]?.[key]
          hubUnreads[hubDTag][key] = existing ?? {
            lastRead: value as number,
            count: 0,
            hasMention: false,
          }
        }
      }

      return { hubUnreads, hubMuteSettings, ...recomputeTotals({ hubUnreads, hubMuteSettings, dm17Unreads: state.dm17Unreads, dm04Unreads: state.dm04Unreads }) }
    })
    _saveHubToLocalStorage(get)
  },

  // ── DMs ──

  markDmRead: (conversationId, type) => {
    const now = Math.floor(Date.now() / 1000)
    console.log('[notif] markDmRead called:', { conversationId: conversationId.slice(0, 12) + '...', type, now })
    const key = type === 'nip17' ? 'dm17Unreads' : 'dm04Unreads'
    set((state) => {
      const unreads = { ...state[key] }
      unreads[conversationId] = { lastRead: now, count: 0 }
      const newState = { ...state, [key]: unreads }
      return { [key]: unreads, ...recomputeTotals(newState) }
    })
    _saveDmToLocalStorage(get)
  },

  incrementDmUnread: (conversationId, type) => {
    const key = type === 'nip17' ? 'dm17Unreads' : 'dm04Unreads'
    set((state) => {
      const unreads = { ...state[key] }
      const existing = unreads[conversationId] || { lastRead: 0, count: 0 }
      unreads[conversationId] = { ...existing, count: existing.count + 1 }
      const newState = { ...state, [key]: unreads }
      return { [key]: unreads, ...recomputeTotals(newState) }
    })
  },

  // ── Public Chat ──

  markTopicRead: (topic) => {
    const now = Math.floor(Date.now() / 1000)
    set((state) => ({
      pcReadTimes: { ...state.pcReadTimes, [topic]: now },
    }))
    _savePcToLocalStorage(get)
  },

  getTopicReadTime: (topic) => {
    return get().pcReadTimes[topic] ?? 0
  },

  // ── Publishing ──

  publishHubReadState: async (signer, privateKey) => {
    const state = get()
    const hubState = buildHubReadStateFromStore(state.hubUnreads, state.hubMuteSettings)
    const content = JSON.stringify(hubState)

    let encryptedContent = content
    if (signer) {
      try {
        const pubkey = await signer.getPublicKey()
        encryptedContent = await guardedEncrypt(content, pubkey, signer, null, 'nip44')
      } catch (err) {
        console.warn('[notif] Failed to NIP-44 encrypt hub read-state (signer), using plaintext:', err)
      }
    } else if (privateKey) {
      try {
        const { nip44, getPublicKey } = await import('nostr-tools')
        const privKeyBytes = hexToBytes(privateKey)
        const pubkey = getPublicKey(privKeyBytes)
        const convKey = nip44.v2.utils.getConversationKey(privKeyBytes, pubkey)
        encryptedContent = nip44.v2.encrypt(content, convKey)
      } catch (err) {
        console.warn('[notif] Failed to NIP-44 encrypt hub read-state (privateKey), using plaintext:', err)
      }
    }

    const event = buildHubReadStateEvent(hubState, encryptedContent)
    return signAndPublishReadState('hub', event, signer, privateKey)
  },

  publishDmReadState: async (signer, privateKey) => {
    const state = get()
    const dmState = buildDmReadStateFromStore(state.dm17Unreads, state.dm04Unreads)
    const content = JSON.stringify(dmState)

    let encryptedContent = content
    if (signer) {
      try {
        const pubkey = await signer.getPublicKey()
        encryptedContent = await guardedEncrypt(content, pubkey, signer, null, 'nip44')
      } catch (err) {
        console.warn('[notif] Failed to NIP-44 encrypt DM read-state (signer), using plaintext:', err)
      }
    } else if (privateKey) {
      try {
        const { nip44, getPublicKey } = await import('nostr-tools')
        const privKeyBytes = hexToBytes(privateKey)
        const pubkey = getPublicKey(privKeyBytes)
        const convKey = nip44.v2.utils.getConversationKey(privKeyBytes, pubkey)
        encryptedContent = nip44.v2.encrypt(content, convKey)
      } catch (err) {
        console.warn('[notif] Failed to NIP-44 encrypt DM read-state (privateKey), using plaintext:', err)
      }
    }

    const event = buildDmReadStateEvent(dmState, encryptedContent)
    return signAndPublishReadState('dm', event, signer, privateKey)
  },

  publishPcReadState: async (signer, privateKey) => {
    const state = get()
    const pcState: PcReadState = { topics: state.pcReadTimes }
    const event = buildPcReadStateEvent(pcState)
    return signAndPublishReadState('pc', event, signer, privateKey)
  },
}))

// ── Internal localStorage Helpers ──
// These save the current state to localStorage without going through the full
// sign+publish flow. The NIP-78 event in localStorage is a "draft" that gets
// published to relay on the next throttle window.

/** Debounce timers for relay publishing (per domain) */
const _publishTimers: Record<string, ReturnType<typeof setTimeout>> = {}
const PUBLISH_DEBOUNCE_MS = 15_000 // 15 seconds — batches rapid mark-read clicks

/** Schedule a debounced relay publish for a domain.
 *  If the publish is throttled, automatically reschedules for when the
 *  throttle window opens so changes are never silently dropped. */
function _schedulePublish(domain: 'hub' | 'dm' | 'pc') {
  if (_publishTimers[domain]) clearTimeout(_publishTimers[domain])
  _publishTimers[domain] = setTimeout(async () => {
    try {
      // Lazy import to avoid circular dependency
      const { useUserStore } = await import('@/stores/userStore')
      const { signer, privateKey } = useUserStore.getState()
      const store = useNotificationStore.getState()
      let published = false
      if (domain === 'hub') published = await store.publishHubReadState(signer, privateKey)
      else if (domain === 'dm') published = await store.publishDmReadState(signer, privateKey)
      else if (domain === 'pc') published = await store.publishPcReadState(signer, privateKey)

      // If throttled, reschedule for when the throttle window opens
      if (!published) {
        const remaining = getRemainingThrottleTime(domain)
        if (remaining > 0) {
          _publishTimers[domain] = setTimeout(() => _schedulePublish(domain), remaining * 1000)
        }
      }
    } catch (err) {
      console.warn(`[notif] Debounced publish for ${domain} failed:`, err)
    }
  }, PUBLISH_DEBOUNCE_MS)
}

function _saveHubToLocalStorage(get: () => NotificationState, skipPublish = false) {
  const state = get()
  const hubState = buildHubReadStateFromStore(state.hubUnreads, state.hubMuteSettings)
  const cached = loadCachedEvent('hub')
  const now = Math.floor(Date.now() / 1000)

  // Build a pseudo-event for localStorage (not signed — just for caching)
  const cacheEvent = {
    ...(cached ?? { id: '', sig: '', pubkey: '', kind: 30078, tags: [['d', 'den-hub-read-state']] }),
    content: JSON.stringify(hubState),
    created_at: now,
  }
  saveCachedEvent('hub', cacheEvent as any)
  if (!skipPublish) _schedulePublish('hub')
}

function _saveDmToLocalStorage(get: () => NotificationState) {
  const state = get()
  const dmState = buildDmReadStateFromStore(state.dm17Unreads, state.dm04Unreads)
  const cached = loadCachedEvent('dm')
  const now = Math.floor(Date.now() / 1000)

  const cacheEvent = {
    ...(cached ?? { id: '', sig: '', pubkey: '', kind: 30078, tags: [['d', 'den-dm-read-state']] }),
    content: JSON.stringify(dmState),
    created_at: now,
  }
  saveCachedEvent('dm', cacheEvent as any)
  _schedulePublish('dm')
}

function _savePcToLocalStorage(get: () => NotificationState) {
  const state = get()
  const pcState: PcReadState = { topics: state.pcReadTimes }
  const cached = loadCachedEvent('pc')
  const now = Math.floor(Date.now() / 1000)

  const cacheEvent = {
    ...(cached ?? { id: '', sig: '', pubkey: '', kind: 30078, tags: [['d', 'den-pc-read-state']] }),
    content: JSON.stringify(pcState),
    created_at: now,
  }
  saveCachedEvent('pc', cacheEvent as any)
  _schedulePublish('pc')
}

// ── Selectors ──

/** Get unread count for a specific channel */
export function getChannelUnread(hubDTag: string, channelId: string): ChannelUnread {
  const state = useNotificationStore.getState()
  return state.hubUnreads[hubDTag]?.[channelId] ?? { lastRead: 0, count: 0, hasMention: false }
}

/** Get total unread count for a hub (excluding muted) */
export function getHubTotalUnread(hubDTag: string): number {
  const state = useNotificationStore.getState()
  if (state.hubMuteSettings[hubDTag]?.all) return 0
  const channels = state.hubUnreads[hubDTag]
  if (!channels) return 0
  return Object.values(channels).reduce((sum, ch) => sum + ch.count, 0)
}

/** Check if any channel in a hub has a mention */
export function getHubHasMention(hubDTag: string): boolean {
  const state = useNotificationStore.getState()
  if (state.hubMuteSettings[hubDTag]?.all) return false
  const channels = state.hubUnreads[hubDTag]
  if (!channels) return false
  return Object.values(channels).some((ch) => ch.hasMention)
}
