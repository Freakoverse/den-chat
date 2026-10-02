/**
 * hubRelayHealth — creator-side health check for a hub's ADVERTISED relays.
 *
 * A hub's `generalRelays` list is where every member reads and writes the hub. If one of those relays
 * dies or stops accepting writes, the hub degrades silently: messages land on fewer relays, some members
 * stop seeing content, and (worst case) the hub event itself rots off the network. This module lets the
 * creator PROVE which advertised relays still work and fix the list, deliberately. It is the relay twin
 * of hubRelayHealth's sibling, lib/hub/hubBlossomHealth (which does the same for Blossom servers).
 *
 *   probeRelays                 — for each relay: rebroadcast the hub's OWN event (kind 36942 / group
 *                                 36950) to that relay alone (no failover), then fetch it straight back
 *                                 from that same relay by id. A relay that rejects the write or won't
 *                                 serve it back is marked broken. This is a real write+read round-trip,
 *                                 not a reachability ping, so it catches write-gated / read-gated /
 *                                 no-retention relays that a socket check would false-pass. Retries once
 *                                 so a single network blip doesn't mark a relay broken.
 *   replacementRelayCandidates  — relays the hub doesn't already advertise (client + the user's NIP-65),
 *                                 so the creator can swap a broken relay for one proven to work.
 *   republishHubWithRelays      — the same hub-event republish Hub Settings uses, with only the relay
 *                                 list changed. An explicit owner action; nothing here publishes on its own.
 *
 * Results feed hubStore.relayHealth (persisted per-account) via setRelayHealth, surfaced to the creator
 * by HubRelayHealthBanner and the per-relay badges in Hub Settings.
 */

import type { Event, Filter } from 'nostr-tools'
import type { HubData } from '@/stores/hubStore'
import type { ISigner } from '@/stores/userStore'
import { KINDS } from '@/lib/crypto/constants'
import {
  getRelays,
  publishToSpecificRelays,
  fetchEventsFromRelays,
} from '@/lib/nostr/relay-pool'
import { useUserListsStore } from '@/stores/userListsStore'

const normalize = (u: string) => u.replace(/\/+$/, '')

export interface RelayCheck {
  relay: string
  ok: boolean
  reason?: string
}

/** The container-event kind that identifies this hub/group on relays. */
function hubEventKind(hub: HubData): number {
  return hub.isGroup ? KINDS.GROUP_EVENT : KINDS.HUB_EVENT
}

/**
 * Relays the hub doesn't already advertise, as replacement candidates: the user's client relays plus
 * their NIP-65 relays, deduped and minus what's already on the hub. Order: client first, then NIP-65.
 */
export function replacementRelayCandidates(hub: HubData): string[] {
  const advertised = new Set(hub.generalRelays.map(normalize))
  const seen = new Set<string>()
  const out: string[] = []
  const add = (url: string) => {
    const n = normalize(url)
    if (!n || advertised.has(n) || seen.has(n)) return
    seen.add(n)
    out.push(n)
  }
  for (const r of getRelays()) add(r)
  for (const r of useUserListsStore.getState().userRelays) add(r)
  return out
}

/**
 * Fetch the hub's own newest container event (kind 36942 / group 36950) to use as the probe payload.
 * It's always the thing that must live on a hub relay, so rebroadcasting it previews the real publish.
 * Queried across the hub's relays + the client relays so we can still find it when some relays are dead.
 */
export async function fetchHubProbeEvent(hub: HubData): Promise<Event | null> {
  const filter: Filter = {
    kinds: [hubEventKind(hub)],
    authors: [hub.creatorPubkey],
    '#d': [hub.dTag],
    limit: 1,
  }
  const relays = Array.from(new Set([...hub.generalRelays, ...getRelays()].map(normalize)))
  const events = await fetchEventsFromRelays(relays, filter)
  if (events.length === 0) return null
  // Newest wins (NIP-01 replaceable: newer created_at, then lowest id on a tie).
  return events.reduce((best, e) =>
    (e.created_at > best.created_at || (e.created_at === best.created_at && e.id < best.id)) ? e : best)
}

/** Write `event` to one relay (no failover) then fetch it straight back from that relay by id. */
async function probeOneRelayOnce(relay: string, event: Event): Promise<RelayCheck> {
  const accepted = await publishToSpecificRelays([relay], event)
  if (accepted.length === 0) return { relay: normalize(relay), ok: false, reason: 'write rejected' }
  const back = await fetchEventsFromRelays([relay], { ids: [event.id] })
  if (back.some((e) => e.id === event.id)) return { relay: normalize(relay), ok: true }
  return { relay: normalize(relay), ok: false, reason: 'not served back' }
}

/**
 * Probe each relay in `relays` with the hub's own event: rebroadcast it to that relay alone, then fetch
 * it back from that same relay. Retries once before marking a relay broken (a single blip shouldn't
 * condemn a relay). Runs the relays in parallel (each is independent); `onResult` fires per relay so a UI
 * can fill badges in as they resolve. Pass `probeEvent` to reuse one already fetched (the picker probes
 * current + candidate relays with the same event); otherwise it's fetched here.
 */
export async function probeRelays(
  hub: HubData,
  relays: string[],
  onResult?: (r: RelayCheck) => void,
  probeEvent?: Event | null,
): Promise<RelayCheck[]> {
  const targets = Array.from(new Set(relays.map(normalize))).filter(Boolean)
  if (targets.length === 0) return []

  const event = probeEvent ?? await fetchHubProbeEvent(hub)
  if (!event) throw new Error('Could not obtain the hub event to test relays with.')

  return Promise.all(targets.map(async (relay) => {
    let result: RelayCheck = { relay, ok: false, reason: 'unreachable' }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await probeOneRelayOnce(relay, event)
      } catch (e) {
        result = { relay, ok: false, reason: (e instanceof Error ? e.message : String(e)) || 'error' }
      }
      if (result.ok) break
    }
    onResult?.(result)
    return result
  }))
}

/**
 * Republish the hub event with ONLY its relay list changed — the identical path Hub Settings takes when
 * the owner edits relays there (v2: encrypted content, signed as O; v1: mined + signed as the creator),
 * published with relay failover, then mirrored into the local store. Clears the hub's relay-health marks
 * on success. Mirrors republishHubWithBlossomServers.
 */
export async function republishHubWithRelays(
  hub: HubData,
  newRelays: string[],
  opts: { pubkey: string; signer: ISigner | null; privateKey: string | null },
): Promise<void> {
  const { pubkey, signer, privateKey } = opts
  const { buildHubEvent, buildAndSignV2HubEvent } = await import('@/lib/hub/buildHubEvent')
  const { mineAndSign } = await import('@/lib/nostr')
  const { publishCriticalWithFailover } = await import('@/lib/nostr/relay-pool')
  const { getPublishRelays } = await import('@/stores/postingBehaviourStore')
  const { isV2 } = await import('@/lib/hub/version')
  const { useHubStore } = await import('@/stores/hubStore')

  const relays = Array.from(new Set(newRelays.map(normalize))).filter(Boolean)

  const params = {
    dTag: hub.dTag,
    name: hub.name,
    description: hub.description || undefined,
    epoch: hub.epoch,
    icon: hub.icon || undefined,
    banner: hub.banner || undefined,
    tags: hub.tags && hub.tags.length > 0 ? hub.tags : undefined,
    relays,
    blossomServers: hub.blossomServers,
    indexFileHash: hub.indexFileHash,
    channels: hub.channels,
    categories: hub.categories,
    roles: hub.roles,
    minPow: hub.minPow > 0 ? hub.minPow : undefined,
    joinMinPow: hub.joinMinPow > 0 ? hub.joinMinPow : undefined,
    joinNote: hub.joinNote,
    messageExpiration: hub.messageExpiration && hub.messageExpiration > 0 ? hub.messageExpiration : undefined,
    nsfw: hub.nsfw || undefined,
    discoverable: hub.discoverable !== false,
    groupedRoles: hub.groupedRoles && hub.groupedRoles.length > 0 ? hub.groupedRoles : undefined,
    publishedAt: hub.publishedAt,
    eventCreatedAt: hub.eventCreatedAt,
  }

  let signed
  if (isV2(hub)) {
    const secretHex = useHubStore.getState().hubSecrets[hub.dTag]
    if (!secretHex) throw new Error('Hub secret not available')
    const { fromHex } = await import('@/lib/crypto/lkh')
    signed = await buildAndSignV2HubEvent({
      ...params,
      hubSecret: fromHex(secretHex),
      ownerRealPub: pubkey,
      ownerPub: hub.creatorPubkey,
      minPow: hub.minPow,
      privateKey,
      signer,
    })
  } else {
    signed = await mineAndSign(buildHubEvent(params), hub.minPow, pubkey, signer, privateKey)
  }

  // Seed the publish with the NEW relay list (plus failover) so the update lands on the relays we're
  // keeping, not the old broken ones. Zero relays accepted => fail loudly rather than split-brain the hub.
  const accepted = await publishCriticalWithFailover(signed, getPublishRelays([...relays], { hubOnly: isV2(hub) }), [...relays])
  if (accepted.length === 0) throw new Error('The hub update was not accepted by any relay. Please try again.')

  useHubStore.getState().setHubData(hub.dTag, { ...hub, generalRelays: relays, eventCreatedAt: signed.created_at })
  useHubStore.getState().clearRelayHealth(hub.dTag)
}
