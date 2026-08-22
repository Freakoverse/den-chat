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
import { getPermissionsForUser } from '@/lib/hub/permissions'
import type { Event } from 'nostr-tools'

export function useModBanSubscription() {
  const activeHubId = useHubStore((s) => s.activeHubId)
  const hub = useHubStore((s) => activeHubId ? s.hubs[activeHubId] : null)
  const hubMembers = useHubStore((s) => activeHubId ? s.hubMembers[activeHubId] : undefined)
  const pubkey = useUserStore((s) => s.pubkey)
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

    // Find all moderators (members with ban_members permission, excluding creator)
    const modPubkeys: string[] = []
    for (const member of hubMembers) {
      if (member.pubkey === hub.creatorPubkey) continue
      const perms = getPermissionsForUser(hub, member.pubkey, hubMembers)
      if (perms.ban_members) {
        modPubkeys.push(member.pubkey)
      }
    }

    // Also subscribe for our OWN join request updates (in case another client/session bans)
    // and for moderators banning us (so the banned user sees it in real-time)
    // We subscribe to ALL join requests for this hub from mods + all members (since any mod
    // could ban us). But to keep it lightweight, just subscribe to mod pubkeys.
    // If we want the banned user to see the ban immediately, we need to include
    // join requests from ALL members with ban_members. Let's keep it to mods.
    if (modPubkeys.length === 0 && (!pubkey || pubkey === hub.creatorPubkey)) return

    // Include own pubkey if we're a moderator (to sync across sessions)
    const subscribePubkeys = [...new Set([...modPubkeys, ...(pubkey ? [pubkey] : [])])]

    const relays = [...new Set(hub.generalRelays)].filter(Boolean)
    if (relays.length === 0) return

    const now = Math.floor(Date.now() / 1000)

    const processJoinRequest = async (event: Event) => {
      const modPubkey = event.pubkey
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
          const { downloadTextFromBlossom, parseIndexFile, downloadBanList } = await import('@/lib/blossom')
          const currentHub = useHubStore.getState().hubs[activeHubId!]
          if (!currentHub) return

          const indexContent = await downloadTextFromBlossom(listTag[1], currentHub.blossomServers)
          const index = parseIndexFile(indexContent)

          if (index.banPages.length > 0) {
            const banEntries = await downloadBanList(index.banPages, currentHub.blossomServers)
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

    // Subscribe to real-time join request updates from mods
    const sub = subscribeToRelays(
      relays,
      {
        kinds: [KINDS.JOIN_REQUEST],
        authors: subscribePubkeys,
        '#d': [activeHubId],
        since: now,
      },
      (event: Event) => {
        processJoinRequest(event)
      },
    )

    subRef.current = sub

    return () => {
      sub.close()
      subRef.current = null
      for (const t of Object.values(pendingRef.current)) clearTimeout(t)
      pendingRef.current = {}
    }
  }, [activeHubId, hub, hubMembers, pubkey])
}
