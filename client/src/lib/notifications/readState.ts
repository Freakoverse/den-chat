/**
 * Read-State Event Utilities — NIP-78 based notification persistence
 *
 * Each notification domain (social, hub, DM, public chat) stores its read-state
 * as a Kind 30078 (NIP-78) Application Data event. The event's content carries
 * the read timestamps; localStorage caches a copy for offline/fast access.
 *
 * Social uses Jumble's d-tag ("notifications_seen_at") for cross-client sync.
 * Hub and DM content is encrypted (reveals membership); public chat is plaintext.
 */

import { type Event, type UnsignedEvent } from 'nostr-tools'
import { STANDARD_KINDS, APP_DATA_DTAGS } from '@/lib/crypto/constants'
import { StorageKey } from '@/lib/constants'
import { createUnsignedEvent, signWithSigner } from '@/lib/nostr/events'
import { fetchReplaceable, publishEvent } from '@/lib/nostr/relay-pool'
import type { ISigner } from '@/stores/userStore'

// ── Types ──

/** Per-hub granular mute settings */
export interface HubMuteSettings {
  all?: boolean       // Master toggle — mute everything
  normal?: boolean    // Mute regular messages (non-mention)
  mentions?: boolean  // Mute @npub / nostr:npub / @dnn personal mentions
  everyone?: boolean  // Mute @everyone mentions
  here?: boolean      // Mute @here mentions
  roles?: boolean     // Mute @role mentions
}

/** Hub chat read-state: per-hub, per-channel timestamps + optional mute settings */
export interface HubReadState {
  hubs: Record<string, Record<string, number> & { _muted?: HubMuteSettings | boolean }>
}

/**
 * Normalize a legacy boolean _muted value to HubMuteSettings.
 * - undefined/false → {} (no muting)
 * - true → all flags on (legacy "fully muted" behavior)
 * - object → pass through
 */
export function normalizeHubMuteSettings(
  raw: boolean | HubMuteSettings | undefined
): HubMuteSettings {
  if (!raw) return {}
  if (raw === true) return { all: true, normal: true, mentions: true, everyone: true, here: true, roles: true }
  return raw
}

/** Check if any mute flag is set (i.e. settings object is non-empty with at least one true) */
export function hasAnyMute(settings: HubMuteSettings): boolean {
  return !!(settings.all || settings.normal || settings.mentions || settings.everyone || settings.here || settings.roles)
}

/** DM read-state: per-conversation timestamps for both protocols */
export interface DmReadState {
  dm17: Record<string, number>  // NIP-17 conversations (counterparty pubkey → timestamp)
  dm04: Record<string, number>  // NIP-04 conversations (counterparty pubkey → timestamp)
}

/** Public chat read-state: per-topic timestamps */
export interface PcReadState {
  topics: Record<string, number>
}

/** Map of domain → localStorage key */
const STORAGE_KEYS: Record<string, string> = {
  social: StorageKey.NOTIF_SOCIAL_SEEN_AT,
  hub:    StorageKey.NOTIF_HUB_READ_STATE,
  dm:     StorageKey.NOTIF_DM_READ_STATE,
  pc:     StorageKey.NOTIF_PC_READ_STATE,
}

/** Map of domain → NIP-78 d-tag */
const DTAGS: Record<string, string> = {
  social: APP_DATA_DTAGS.SOCIAL_SEEN_AT,
  hub:    APP_DATA_DTAGS.HUB_READ_STATE,
  dm:     APP_DATA_DTAGS.DM_READ_STATE,
  pc:     APP_DATA_DTAGS.PC_READ_STATE,
}

export type NotifDomain = 'social' | 'hub' | 'dm' | 'pc'

// ── localStorage Cache ──

/**
 * Load a cached NIP-78 event from localStorage.
 * Returns null if nothing stored or parse fails.
 */
export function loadCachedEvent(domain: NotifDomain): Event | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS[domain])
    if (!raw) return null
    return JSON.parse(raw) as Event
  } catch {
    return null
  }
}

/**
 * Save a NIP-78 event to localStorage cache.
 */
export function saveCachedEvent(domain: NotifDomain, event: Event): void {
  localStorage.setItem(STORAGE_KEYS[domain], JSON.stringify(event))
}

/**
 * Clear a cached event from localStorage.
 */
export function clearCachedEvent(domain: NotifDomain): void {
  localStorage.removeItem(STORAGE_KEYS[domain])
}

// ── Relay Fetch ──

/**
 * Fetch the latest NIP-78 read-state event from relays for a given domain.
 */
export async function fetchReadStateEvent(
  pubkey: string,
  domain: NotifDomain
): Promise<Event | null> {
  return fetchReplaceable(pubkey, STANDARD_KINDS.APP_DATA, DTAGS[domain])
}

/**
 * Load read-state from both localStorage and relay, keeping the newer one.
 * Updates localStorage cache if the relay version is newer.
 * Returns the winning event (or null if neither source has one).
 */
export async function loadReadState(
  pubkey: string,
  domain: NotifDomain
): Promise<Event | null> {
  const cached = loadCachedEvent(domain)
  let relayEvent: Event | null = null

  try {
    relayEvent = await fetchReadStateEvent(pubkey, domain)
  } catch (err) {
    console.warn(`[notif] Failed to fetch ${domain} read-state from relay:`, err)
  }

  // Pick whichever is newer
  // NOTE: We do NOT cache the relay event to localStorage here.
  // For encrypted domains (hub, dm), the relay event content is encrypted
  // and can't be parsed by preloadFromLocalStorage(). The init() function
  // decrypts the content and then re-saves plaintext via _save*ToLocalStorage.
  if (!cached && !relayEvent) return null
  if (!cached) return relayEvent
  if (!relayEvent) return cached

  return relayEvent.created_at > cached.created_at ? relayEvent : cached
}

// ── Event Builders ──

/**
 * Build a Social "seen at" event — Jumble-compatible.
 * The created_at IS the "last seen" timestamp. Content is informational only.
 */
export function buildSocialSeenAtEvent(): UnsignedEvent {
  return createUnsignedEvent(
    STANDARD_KINDS.APP_DATA,
    'Records read time to sync notification status across devices.',
    [['d', DTAGS.social]]
  )
}

/**
 * Build a Hub Chat read-state event with encrypted content.
 */
export function buildHubReadStateEvent(state: HubReadState, encryptedContent: string): UnsignedEvent {
  return createUnsignedEvent(
    STANDARD_KINDS.APP_DATA,
    encryptedContent,
    [['d', DTAGS.hub]]
  )
}

/**
 * Build a DM read-state event with encrypted content.
 */
export function buildDmReadStateEvent(state: DmReadState, encryptedContent: string): UnsignedEvent {
  return createUnsignedEvent(
    STANDARD_KINDS.APP_DATA,
    encryptedContent,
    [['d', DTAGS.dm]]
  )
}

/**
 * Build a Public Chat read-state event with plaintext content.
 */
export function buildPcReadStateEvent(state: PcReadState): UnsignedEvent {
  return createUnsignedEvent(
    STANDARD_KINDS.APP_DATA,
    JSON.stringify(state),
    [['d', DTAGS.pc]]
  )
}

// ── Content Parsing ──

/**
 * Parse the social "seen at" timestamp from a NIP-78 event.
 * For social, the created_at IS the timestamp (Jumble-compatible).
 */
export function parseSocialSeenAt(event: Event | null): number {
  return event?.created_at ?? 0
}

/**
 * Parse hub read-state from a NIP-78 event's decrypted content.
 */
export function parseHubReadState(decryptedContent: string): HubReadState {
  try {
    const parsed = JSON.parse(decryptedContent)
    return { hubs: parsed.hubs ?? {} }
  } catch {
    return { hubs: {} }
  }
}

/**
 * Parse DM read-state from a NIP-78 event's decrypted content.
 */
export function parseDmReadState(decryptedContent: string): DmReadState {
  try {
    const parsed = JSON.parse(decryptedContent)
    return {
      dm17: parsed.dm17 ?? {},
      dm04: parsed.dm04 ?? {},
    }
  } catch {
    return { dm17: {}, dm04: {} }
  }
}

/**
 * Parse public chat read-state from a NIP-78 event's plaintext content.
 */
export function parsePcReadState(event: Event | null): PcReadState {
  if (!event?.content) return { topics: {} }
  try {
    const parsed = JSON.parse(event.content)
    return { topics: parsed.topics ?? {} }
  } catch {
    return { topics: {} }
  }
}

// ── Signing & Publishing ──

/** Track last publish timestamps per domain to enforce throttle */
const _lastPublished: Record<string, number> = {}
const PUBLISH_THROTTLE_S = 60 // 60 seconds

/**
 * Get the remaining seconds until the throttle window opens for a domain.
 * Returns 0 if the domain is not throttled (ready to publish).
 */
export function getRemainingThrottleTime(domain: NotifDomain): number {
  const now = Math.floor(Date.now() / 1000)
  const lastTime = _lastPublished[domain] ?? 0
  const elapsed = now - lastTime
  return elapsed >= PUBLISH_THROTTLE_S ? 0 : PUBLISH_THROTTLE_S - elapsed
}

/**
 * Sign and publish a read-state event if the 60-second throttle window allows.
 * Always updates localStorage immediately regardless of throttle.
 *
 * @returns true if the event was published to relay, false if throttled
 */
export async function signAndPublishReadState(
  domain: NotifDomain,
  unsignedEvent: UnsignedEvent,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<boolean> {
  // Sign the event
  const signedEvent = await signWithSigner(unsignedEvent, signer, privateKey)

  // NOTE: We intentionally do NOT call saveCachedEvent() here.
  // For encrypted domains (hub, dm), the _save*ToLocalStorage helpers
  // already maintain a plaintext cache. Overwriting it with the signed
  // event (which has encrypted content) would corrupt preloadFromLocalStorage
  // on next app launch — the encrypted content can't be JSON-parsed
  // synchronously, causing all read timestamps to be lost.

  // Throttle relay publishing: max once per 60 seconds per domain
  const now = Math.floor(Date.now() / 1000)
  const lastTime = _lastPublished[domain] ?? 0
  if (now - lastTime < PUBLISH_THROTTLE_S) {
    return false // throttled — localStorage plaintext cache is already current
  }

  try {
    await publishEvent(signedEvent)
    _lastPublished[domain] = now
    return true
  } catch (err) {
    console.warn(`[notif] Failed to publish ${domain} read-state:`, err)
    return false
  }
}

// ── Pruning ──

/**
 * Prune stale entries from hub read-state.
 * Removes hubs no longer in the user's hub list and channels no longer visible.
 *
 * @param state - Current hub read-state
 * @param activeHubDTags - Set of hub d-tags from the user's hub list (Kind 16942)
 * @param channelsByHub - Map of hubDTag → Set of visible channel IDs
 * @returns Pruned state (may be same object if nothing changed)
 */
export function pruneHubReadState(
  state: HubReadState,
  activeHubDTags: Set<string>,
  channelsByHub: Record<string, Set<string>>
): HubReadState {
  let changed = false
  const pruned: HubReadState = { hubs: { ...state.hubs } }

  for (const hubDTag of Object.keys(pruned.hubs)) {
    // Hub no longer in user's hub list → remove entirely
    if (!activeHubDTags.has(hubDTag)) {
      delete pruned.hubs[hubDTag]
      changed = true
      continue
    }

    // Channel no longer visible → remove that channel entry
    const visibleChannels = channelsByHub[hubDTag]
    if (!visibleChannels) continue

    const hubChannels = { ...pruned.hubs[hubDTag] }
    for (const key of Object.keys(hubChannels)) {
      if (key === '_muted') continue // preserve meta keys
      if (!visibleChannels.has(key)) {
        delete hubChannels[key]
        changed = true
      }
    }
    pruned.hubs[hubDTag] = hubChannels
  }

  return changed ? pruned : state
}
