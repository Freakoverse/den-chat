/**
 * useGroupLoader — loads every group in the user's list (kind 16943) and keeps it live.
 *
 * Per entry: fetch the kind-36950 event by coordinate (hinted relay + client relays), derive the
 * group secret from the INLINE tree (my own leaf), decrypt the epoch history + settings, resolve
 * members (v2: P→R through the roster), then register the group in the HUB store as a single-channel
 * hub flagged `isGroup` — which is what lets the whole message pipeline (subscriptions, cache, send,
 * replies, reactions, pins, typing) work for it unchanged. A live subscription on the coordinate
 * re-applies newer events (member added/removed → new tree / rotated secret).
 */
import { useEffect, useRef } from 'react'
import type { Event } from 'nostr-tools'
import { useGroupStore } from '@/stores/groupStore'
import { useHubStore } from '@/stores/hubStore'
import { useUserStore, type ISigner } from '@/stores/userStore'
import { KINDS } from '@/lib/crypto/constants'
import { getRelays, fetchEventsFromRelays, subscribeToRelays } from '@/lib/nostr/relay-pool'
import { toHex } from '@/lib/crypto/lkh'
import { canUseV2 } from '@/lib/crypto/skd'
import {
  parseGroupEvent, deriveGroupSecret, decryptHistory, listGroupMembers, readGroupSettings,
  resolveOwnerRealPubkey, toHubData, isGroupV2, type GroupData,
} from '@/lib/group/groupEvent'
import type { GroupEntry } from '@/lib/group/groupList'

const dedupRelays = (urls: string[]) => {
  const seen = new Set<string>()
  return urls.filter((u) => { const n = u.replace(/\/+$/, ''); if (!n || seen.has(n)) return false; seen.add(n); return true })
}

/** newest created_at applied per group, so a late-arriving older version never regresses the tree */
const latestApplied: Record<string, number> = {}

/**
 * Apply a group event: derive the secret, resolve members, register in the hub store.
 * Exported so accepting an invite (which already has the event in hand) uses the identical path.
 */
export async function applyGroupEvent(
  event: Event,
  me: string,
  keys: { privateKey: string | null; signer: ISigner | null },
): Promise<GroupData | null> {
  const g = parseGroupEvent(event)
  if (!g) return null
  if ((latestApplied[g.dTag] ?? 0) > event.created_at) return null
  latestApplied[g.dTag] = event.created_at

  const gs = useGroupStore.getState()
  const hs = useHubStore.getState()
  gs.setGroup(g.dTag, g)

  if (g.deleted) {
    gs.setStatus(g.dTag, 'deleted')
    const existing = hs.hubs[g.dTag]
    if (existing) hs.setHubData(g.dTag, { ...existing, deleted: true, eventCreatedAt: g.eventCreatedAt })
    hs.setHubStatus(g.dTag, 'deleted')
    return g
  }

  if (isGroupV2(g) && !canUseV2(keys)) {
    gs.setStatus(g.dTag, 'unsupported')
    hs.setHubData(g.dTag, toHubData(g, {}))
    hs.setHubSecretsResolved(g.dTag, true)
    hs.setHubStatus(g.dTag, 'loaded')
    return g
  }

  let derived: { secret: Uint8Array; memberP?: string } | null = null
  try {
    derived = await deriveGroupSecret(g, me, keys)
  } catch (err) {
    console.warn(`[Groups] secret derivation failed for ${g.dTag.slice(0, 8)}…`, err)
  }
  if (!derived) {
    // Not in the tree (removed, or never accepted properly). Keep the face for the list; no chat access.
    gs.setStatus(g.dTag, 'removed')
    hs.setHubData(g.dTag, toHubData(g, {}))
    hs.setHubSecret(g.dTag, '')
    hs.setHubSecretsResolved(g.dTag, true)
    hs.setHubStatus(g.dTag, 'loaded')
    return g
  }

  const { secret } = derived
  const secretHex = toHex(secret)
  let epochSecrets: Record<number, string> = {}
  try { epochSecrets = await decryptHistory(secret, g.history) } catch { /* unreadable history → current epoch only */ }
  epochSecrets[g.epoch] = secretHex

  const [members, settings, ownerReal] = await Promise.all([
    listGroupMembers(g, epochSecrets),
    readGroupSettings(g, secret),
    resolveOwnerRealPubkey(g, secret),
  ])

  hs.setHubData(g.dTag, toHubData(g, settings, ownerReal))
  hs.setHubSecret(g.dTag, secretHex)
  hs.setEpochSecrets(g.dTag, epochSecrets)
  hs.setHubMembers(g.dTag, members)
  hs.setHubSecretsResolved(g.dTag, true)
  hs.setHubStatus(g.dTag, 'loaded')
  gs.setStatus(g.dTag, 'loaded')
  return g
}

/** Fetch the newest group event for a coordinate from the hinted relay + client relays. */
export async function fetchGroupEvent(pubkey: string, dTag: string, relayHint?: string): Promise<Event | null> {
  const relays = dedupRelays([...(relayHint ? [relayHint] : []), ...getRelays()])
  const events = await fetchEventsFromRelays(relays, { kinds: [KINDS.GROUP_EVENT], authors: [pubkey], '#d': [dTag], limit: 5 })
  return [...events].sort((a, b) => b.created_at - a.created_at)[0] ?? null
}

async function loadEntry(entry: GroupEntry, me: string, keys: { privateKey: string | null; signer: ISigner | null }) {
  const gs = useGroupStore.getState()
  gs.setStatus(entry.dTag, 'loading')
  try {
    const ev = await fetchGroupEvent(entry.pubkey, entry.dTag, entry.relay)
    if (!ev) { gs.setStatus(entry.dTag, 'not-found'); return }
    await applyGroupEvent(ev, me, keys)
  } catch (err) {
    console.error(`[Groups] failed to load ${entry.dTag.slice(0, 8)}…`, err)
    gs.setStatus(entry.dTag, 'error')
  }
}

export function useGroupLoader() {
  const entries = useGroupStore((s) => s.entries)
  const listLoaded = useGroupStore((s) => s.listLoaded)
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const subsRef = useRef<Map<string, { close: () => void }>>(new Map())

  useEffect(() => {
    if (!listLoaded || !pubkey) return
    const keys = { privateKey, signer }
    const wanted = new Set(entries.map((e) => e.dTag))

    for (const entry of entries) {
      const status = useGroupStore.getState().status[entry.dTag]
      if (!status || status === 'error' || status === 'not-found') void loadEntry(entry, pubkey, keys)

      if (!subsRef.current.has(entry.dTag)) {
        const relays = dedupRelays([...(entry.relay ? [entry.relay] : []), ...getRelays()])
        const sub = subscribeToRelays(
          relays,
          { kinds: [KINDS.GROUP_EVENT], authors: [entry.pubkey], '#d': [entry.dTag] },
          (ev) => { void applyGroupEvent(ev, pubkey, { privateKey: useUserStore.getState().privateKey, signer: useUserStore.getState().signer }) },
        )
        subsRef.current.set(entry.dTag, sub)
      }
    }
    // Drop subscriptions for groups no longer in the list
    for (const [dTag, sub] of subsRef.current) {
      if (!wanted.has(dTag)) { sub.close(); subsRef.current.delete(dTag) }
    }
  }, [entries, listLoaded, pubkey, signer, privateKey])

  useEffect(() => () => {
    for (const sub of subsRef.current.values()) sub.close()
    subsRef.current.clear()
  }, [])
}
