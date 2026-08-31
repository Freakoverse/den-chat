/**
 * useModBanSubscription — Real-time subscription for moderator ban list changes
 *
 * Subscribes to JOIN_REQUEST events (kind 36944) from all moderators of the
 * active hub. When a new/updated join request arrives, re-downloads the
 * moderator's ban list from Blossom and updates the store.
 *
 * This ensures that mod-ban/unban effects propagate to all connected clients
 * without requiring a page refresh.
 */

import { useEffect, useRef } from 'react'
import { useHubStore } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { subscribeToRelays } from '@/lib/nostr/relay-pool'
import { KINDS } from '@/lib/crypto/constants'
import { getPermissionsForUser, isHubOwner } from '@/lib/hub/permissions'
import { isV2 } from '@/lib/hub/version'
import { hubMemberIdentity } from '@/lib/hub/hubMemberSign'
import type { Event } from 'nostr-tools'

export function useModBanSubscription() {
  const activeHubId = useHubStore((s) => s.activeHubId)
  const hub = useHubStore((s) => activeHubId ? s.hubs[activeHubId] : null)
  const hubMembers = useHubStore((s) => activeHubId ? s.hubMembers[activeHubId] : undefined)
  const pubkey = useUserStore((s) => s.pubkey)
  const privateKey = useUserStore((s) => s.privateKey)
  const signer = useUserStore((s) => s.signer)
  const subRef = useRef<{ close: () => void } | null>(null)
  // Track the latest event timestamp per mod to avoid re-processing old events
  const latestTsRef = useRef<Record<string, number>>({})
  // Debounce processing to avoid hammering Blossom on rapid updates
  const pendingRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  useEffect(() => {
    // Clean up previous subscription
    if (subRef.current) {
      subRef.current.close()
      subRef.current = null
    }
    latestTsRef.current = {}
    for (const t of Object.values(pendingRef.current)) clearTimeout(t)
    pendingRef.current = {}

    if (!activeHubId || !hub || !hubMembers || hubMembers.length === 0) return

    const v2 = isV2(hub)
    // Find all moderators (members with ban_members permission, excluding creator). Subscribe by the
    // key they AUTHOR their ban-list JR under: pseudonym `P` (m.p) on v2, real key `R` (m.pubkey) on
    // v1. Perms are always looked up by the real key (roster keys members by R).
    const modPubkeys: string[] = []
    for (const member of hubMembers) {
      if (isHubOwner(hub, member.pubkey)) continue // owner authors bans as O — skip their member entry (v2: keyed by R_owner ≠ O)
      const perms = getPermissionsForUser(hub, member.pubkey, hubMembers)
      if (perms.ban_members) {
        // v2: subscribe by the mod's pseudonym P — never fall back to R (leaks R + hub scope).
        if (v2 && !member.p) continue
        modPubkeys.push(v2 ? member.p! : member.pubkey)
      }
    }

    // Also subscribe for our OWN join request updates (in case another client/session bans)
    // and for moderators banning us (so the banned user sees it in real-time)
    // We subscribe to ALL join requests for this hub from mods + all members (since any mod
    // could ban us). But to keep it lightweight, just subscribe to mod pubkeys.
    // If we want the banned user to see the ban immediately, we need to include
    // join requests from ALL members with ban_members. Let's keep it to mods.
    if (modPubkeys.length === 0 && (!pubkey || pubkey === hub.creatorPubkey)) return

    const relays = [...new Set(hub.generalRelays)].filter(Boolean)
    if (relays.length === 0) return

    const now = Math.floor(Date.now() / 1000)
    let cancelled = false

    const processJoinRequest = async (event: Event) => {
      // Key the store by the mod's REAL key R (event author is P on v2): the loader and the local
      // writer (UserProfileModal) both key by R, so resolve P→R via the roster to keep them in sync.
      const modPubkey = v2 ? (hubMembers.find((m) => m.p === event.pubkey)?.pubkey ?? event.pubkey) : event.pubkey
      const dTag = event.tags.find((t: string[]) => t[0] === 'd')?.[1]
      if (dTag !== activeHubId) return

      // Skip if we've already processed a newer event from this mod
      const prevTs = latestTsRef.current[modPubkey] || 0
      if (event.created_at <= prevTs) return
      latestTsRef.current[modPubkey] = event.created_at

      // Debounce: if multiple events arrive quickly, only process the latest
      if (pendingRef.current[modPubkey]) {
        clearTimeout(pendingRef.current[modPubkey])
      }

      pendingRef.current[modPubkey] = setTimeout(async () => {
        delete pendingRef.current[modPubkey]

        const listTag = event.tags.find((t: string[]) => t[0] === 'list')
        if (!listTag?.[1]) {
          // No list tag — moderator cleared their ban list
          useHubStore.getState().setModBanList(activeHubId!, modPubkey, [])
          return
        }

        try {
          const { downloadTextFromBlossom, parseIndexFile, downloadBanList, downloadBanListV2 } = await import('@/lib/blossom')
          const currentHub = useHubStore.getState().hubs[activeHubId!]
          if (!currentHub) return

          // Re-validate authorization ON RECEIPT — don't trust the relay's `authors` filter. The resolved
          // author (R) must actually hold ban_members (or be the owner); otherwise a permissive/hostile
          // relay could serve a non-mod's JOIN_REQUEST and have their ban list applied locally (subtractive
          // censorship — useMessages merges every modBanList to hide messages). Mirrors processHideEvent.
          const { getPermissionsForUser, isHubOwner } = await import('@/lib/hub/permissions')
          const roster = useHubStore.getState().hubMembers[activeHubId!] || []
          if (!isHubOwner(currentHub, modPubkey) && !getPermissionsForUser(currentHub, modPubkey, roster).ban_members) {
            console.warn(`[ModBanSub] Ignoring ban list from ${modPubkey.slice(0, 8)}… — author lacks ban_members`)
            return
          }

          const indexContent = await downloadTextFromBlossom(listTag[1], currentHub.blossomServers)
          const index = parseIndexFile(indexContent)

          if (index.banPages.length > 0) {
            // v2 ban pages are AES-encrypted with the hub secret; v1 are plaintext.
            let banEntries
            if (v2) {
              const secretHex = useHubStore.getState().hubSecrets[activeHubId!]
              if (!secretHex) { console.warn('[ModBanSub] no hub secret yet for v2 ban list'); return }
              const { fromHex } = await import('@/lib/crypto/lkh')
              banEntries = await downloadBanListV2(index.banPages, fromHex(secretHex), currentHub.blossomServers)
            } else {
              banEntries = await downloadBanList(index.banPages, currentHub.blossomServers)
            }
            const bannedPks = banEntries.map(e => e.pubkey)
            useHubStore.getState().setModBanList(activeHubId!, modPubkey, bannedPks)
            console.log(`[ModBanSub] Updated ban list from ${modPubkey.slice(0, 8)}...: ${bannedPks.length} banned`)
          } else {
            useHubStore.getState().setModBanList(activeHubId!, modPubkey, [])
            console.log(`[ModBanSub] Cleared ban list from ${modPubkey.slice(0, 8)}...`)
          }
        } catch (err) {
          console.warn(`[ModBanSub] Failed to update ban list from ${modPubkey.slice(0, 8)}...:`, err)
        }
      }, 500) // 500ms debounce
    }

    // Include our own authoring key (to sync a ban we make from another session): pseudonym `P` on
    // v2 (derived), real key `R` on v1. Deriving `P` is async, so set the subscription up in an IIFE.
    ;(async () => {
      let ownKey = pubkey || undefined
      if (v2) {
        // NEVER put our real key R in a hub-scoped subscription filter on v2. Use our derived P; if
        // it can't be derived, omit our own key entirely (lose cross-session self-sync, not privacy).
        ownKey = undefined
        if (pubkey && pubkey !== hub.creatorPubkey) {
          try {
            const id = await hubMemberIdentity(hub, { privateKey, signer })
            if (id) ownKey = id.authKey
          } catch { /* omit — no R on the wire */ }
        }
      }
      if (cancelled) return
      const subscribePubkeys = [...new Set([...modPubkeys, ...(ownKey ? [ownKey] : [])])]

      const sub = subscribeToRelays(
        relays,
        {
          kinds: [KINDS.JOIN_REQUEST],
          authors: subscribePubkeys,
          '#d': [activeHubId],
          since: now,
        },
        (event: Event) => { processJoinRequest(event) },
      )
      if (cancelled) { sub.close(); return }
      subRef.current = sub
    })()

    return () => {
      cancelled = true
      if (subRef.current) { subRef.current.close(); subRef.current = null }
      for (const t of Object.values(pendingRef.current)) clearTimeout(t)
      pendingRef.current = {}
    }
  }, [activeHubId, hub, hubMembers, pubkey, privateKey, signer])
}
