/**
 * useHubEventSubscription — Real-time subscription for hub event updates
 *
 * Subscribes to hub events (kind 36942) for all joined hubs. When the creator
 * re-publishes a hub event (e.g. after banning a user, changing settings, adding
 * channels), this hook detects the update and:
 *   1. Re-parses the hub data and updates the store
 *   2. Re-downloads the ban list from Blossom index file
 *
 * This ensures that creator bans, epoch rotations, and structural changes
 * propagate to all connected clients without requiring a page refresh.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useHubStore } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { subscribeToRelays } from '@/lib/nostr/relay-pool'
import { KINDS } from '@/lib/crypto/constants'
import { putHubEvent } from '@/lib/cache/hubEventCache'
import { parseHubEvent } from './useHubLoader'
import { buildRelayIndex } from '@/lib/nostr/buildRelayIndex'
import type { Event } from 'nostr-tools'

export function useHubEventSubscription() {
  const hubs = useHubStore((s) => s.hubs)
  const hubListLoaded = useHubStore((s) => s.hubListLoaded)
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const subsRef = useRef<{ close: () => void }[]>([])
  // Track the latest event timestamp per hub to avoid re-processing stale events
  const latestTsRef = useRef<Record<string, number>>({})
  // Debounce processing to avoid hammering Blossom
  const pendingRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  // Compute fingerprint outside the effect so only relay config changes re-subscribe
  const hubFingerprint = useMemo(() => {
    const hubKeys = Object.keys(hubs)
    if (hubKeys.length === 0) return ''
    return hubKeys
      .sort()
      .map((k) => {
        const h = hubs[k]
        return `${k}:${h.generalRelays.join(',')}`
      })
      .join('|')
  }, [hubs])

  // Force a full re-subscribe on resume. Browsers drop WebSockets when a tab is
  // backgrounded, and on Tauri the window is always "visible" so visibilitychange
  // never fires — hence the periodic keepalive too. Without this the hub-event sub
  // silently dies and epoch rotations (new hub secret) are missed until a manual
  // refresh, even though the message sub (useHubSubscriptions) keeps flowing. A
  // fresh REQ returns the latest hub event per coordinate, which then flows through
  // the re-download → re-derive → re-decrypt pipeline below.
  const [reconnectNonce, setReconnectNonce] = useState(0)
  useEffect(() => {
    const RECONNECT_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
    const forceReconnect = () => setReconnectNonce((n) => n + 1)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') forceReconnect()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    const intervalId = setInterval(forceReconnect, RECONNECT_INTERVAL_MS)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    if (!hubListLoaded || !pubkey || !hubFingerprint) return

    // Tear down old subscriptions
    for (const sub of subsRef.current) sub.close()
    subsRef.current = []
    latestTsRef.current = {}
    for (const t of Object.values(pendingRef.current)) clearTimeout(t)
    pendingRef.current = {}

    // Build relay batches (same as useHubSubscriptions)
    const batches = buildRelayIndex(hubs)
    if (batches.length === 0) return

    // Seed each hub's last-seen timestamp to the version we already hold, NOT wall-clock.
    // Re-published hub events use created_at = original + 1 (kept low so edits don't bump
    // discover feeds), so a ban/settings update is only "newer" relative to our current
    // copy — seeding to `now` would make every such update look stale and get ignored
    // until the user refreshes (which is the exact bug this fixes).
    for (const dTag of Object.keys(hubs)) {
      latestTsRef.current[dTag] = hubs[dTag]?.eventCreatedAt || 0
    }

    const processHubEvent = async (event: Event) => {
      const hubData = parseHubEvent(event)
      if (!hubData) return

      // Keep a local (IndexedDB) copy of the hub definition — newest-wins, tombstones
      // included — so it can still be exported if it's later wiped from all relays.
      putHubEvent(event).catch(() => {})

      const dTag = hubData.dTag

      // Skip if we've already processed a newer event for this hub
      const prevTs = latestTsRef.current[dTag] || 0
      if (event.created_at <= prevTs) return
      latestTsRef.current[dTag] = event.created_at

      // Debounce to avoid hammering Blossom on rapid updates
      if (pendingRef.current[dTag]) {
        clearTimeout(pendingRef.current[dTag])
      }

      pendingRef.current[dTag] = setTimeout(async () => {
        delete pendingRef.current[dTag]

        const store = useHubStore.getState()
        const currentHub = store.hubs[dTag]
        if (!currentHub) return

        // Check if this is actually newer (different index hash, hub epoch, group epochs, or channel/role structure)
        const groupEpochsChanged = (() => {
          const oldGroups = currentHub.groupedRoles || []
          const newGroups = hubData.groupedRoles || []
          if (oldGroups.length !== newGroups.length) return true
          return newGroups.some((ng) => {
            const og = oldGroups.find((g) => g.groupId === ng.groupId)
            return !og || og.epoch !== ng.epoch
          })
        })()

        // Lightweight structural fingerprint for channels/categories/roles
        const channelFP = (h: typeof hubData) =>
          h.channels.map(c => `${c.channelId}:${c.encryption}:${JSON.stringify(c.permissions || {})}`).join('|')
        const categoryFP = (h: typeof hubData) =>
          h.categories.map(c => `${c.categoryId}:${c.encryption}:${JSON.stringify(c.permissions || {})}`).join('|')
        const roleFP = (h: typeof hubData) =>
          h.roles.map(r => `${r.roleId}:${JSON.stringify(r.permissions)}`).join('|')

        const structureChanged =
          channelFP(hubData) !== channelFP(currentHub) ||
          categoryFP(hubData) !== categoryFP(currentHub) ||
          roleFP(hubData) !== roleFP(currentHub)

        // Disappearing-messages timer is metadata (no index/epoch/structure change),
        // but member SEND behaviour depends on it, so a timer-only edit must still
        // propagate — otherwise members keep sending under the old policy.
        const expirationChanged =
          (hubData.messageExpiration || 0) !== (currentHub.messageExpiration || 0)

        if (
          hubData.indexFileHash === currentHub.indexFileHash &&
          hubData.epoch === currentHub.epoch &&
          !groupEpochsChanged &&
          !structureChanged &&
          !expirationChanged
        ) {
          return // No meaningful change
        }

        console.log(`[HubEventSub] Hub ${dTag} updated: epoch ${currentHub.epoch} → ${hubData.epoch}, indexHash changed: ${hubData.indexFileHash !== currentHub.indexFileHash}, groupEpochs changed: ${groupEpochsChanged}, structure changed: ${structureChanged}`)

        // Update hub data in store
        store.setHubData(dTag, hubData)

        // If the hub is deleted, mark it
        if (hubData.deleted) {
          store.setHubStatus(dTag, 'deleted')
          return
        }

        // Re-download ban list from new index file
        if (hubData.indexFileHash && hubData.blossomServers.length > 0) {
          try {
            const { downloadTextFromBlossom, parseIndexFile, downloadBanList } = await import('@/lib/blossom')
            const indexContent = await downloadTextFromBlossom(hubData.indexFileHash, hubData.blossomServers)
            const index = parseIndexFile(indexContent)

            // Update ban list
            if (index.banPages.length > 0) {
              const banEntries = await downloadBanList(index.banPages, hubData.blossomServers)
              const bannedPks = banEntries.map(e => e.pubkey)
              store.setHubBanList(dTag, bannedPks)
              console.log(`[HubEventSub] Updated ban list for ${dTag}: ${bannedPks.length} banned`)
            } else {
              store.setHubBanList(dTag, [])
            }

            // If index changed (ban/unban/role change), re-download tree and try to decrypt secret
            if (hubData.indexFileHash !== currentHub.indexFileHash && pubkey) {
              try {
                const { decryptHubSecret, decryptHubSecretPaginated, findPageForPubkey } = await import('@/lib/blossom')
                const { deserializeTree, getMembers, deserializeLeafPage, getPageMembers } = await import('@/lib/crypto/lkh')
                const { aesDecrypt } = await import('@/lib/crypto/aes')

                let hubSecret: Uint8Array | null = null
                let members: { pubkey: string; roles: string; flags?: string }[] = []

                // ── Paginated format ──
                if (index.pageSize > 0 && index.spineHash && index.leafPages.length > 0) {
                  const pageEntry = findPageForPubkey(index, pubkey)
                  if (pageEntry) {
                    const [pageContent, spineContent] = await Promise.all([
                      downloadTextFromBlossom(pageEntry.hash, hubData.blossomServers),
                      downloadTextFromBlossom(index.spineHash, hubData.blossomServers),
                    ])

                    // Extract members from our page
                    try {
                      const page = deserializeLeafPage(pageContent)
                      members = getPageMembers(page)
                    } catch { /* ignore */ }

                    hubSecret = await decryptHubSecretPaginated(
                      pubkey, privateKey, signer,
                      hubData.creatorPubkey, pageContent, spineContent,
                    )
                  }
                }
                // ── Monolithic format ──
                else if (index.treeHash) {
                  const treeContent = await downloadTextFromBlossom(index.treeHash, hubData.blossomServers)
                  const tree = deserializeTree(treeContent)
                  members = getMembers(tree)

                  hubSecret = await decryptHubSecret(
                    pubkey, privateKey, signer,
                    hubData.creatorPubkey, treeContent,
                  )
                }

                if (members.length > 0) {
                  store.setHubMembers(dTag, members)
                }
                if (hubSecret) {
                  const secretHex = Array.from(hubSecret).map(b => b.toString(16).padStart(2, '0')).join('')
                  store.setHubSecret(dTag, secretHex)
                  console.log(`[HubEventSub] Re-decrypted hub secret for ${dTag} (epoch ${hubData.epoch})`)

                  // Re-download epoch history so old messages remain decryptable
                  if (index.historyHash) {
                    try {
                      const historyBlob = await downloadTextFromBlossom(index.historyHash, hubData.blossomServers)
                      const epochMap: Record<number, string> = {}

                      let plaintext = ''
                      try {
                        plaintext = await aesDecrypt(hubSecret, historyBlob)
                      } catch {
                        // Fallback: legacy per-row format
                        for (const line of historyBlob.split('\n')) {
                          const trimmed = line.trim()
                          if (!trimmed || !trimmed.startsWith('hub:')) continue
                          const parts = trimmed.split(':')
                          if (parts.length < 3) continue
                          const ep = parseInt(parts[1], 10)
                          const ciphertext = parts.slice(2).join(':')
                          try {
                            const decryptedHex = await aesDecrypt(hubSecret, ciphertext)
                            epochMap[ep] = decryptedHex
                          } catch { /* skip */ }
                        }
                      }

                      const groupEpochMaps: Record<string, Record<number, string>> = {}
                      if (plaintext) {
                        for (const line of plaintext.split('\n')) {
                          const trimmed = line.trim()
                          if (!trimmed) continue
                          if (trimmed.startsWith('hub:')) {
                            const parts = trimmed.split(':')
                            if (parts.length < 3) continue
                            epochMap[parseInt(parts[1], 10)] = parts.slice(2).join(':')
                          } else if (trimmed.startsWith('group:')) {
                            const parts = trimmed.split(':')
                            if (parts.length < 4) continue
                            const gid = parts[1]
                            const gep = parseInt(parts[2], 10)
                            if (!groupEpochMaps[gid]) groupEpochMaps[gid] = {}
                            groupEpochMaps[gid][gep] = parts.slice(3).join(':')
                          }
                        }
                      }

                      if (Object.keys(epochMap).length > 0) {
                        store.setEpochSecrets(dTag, epochMap)
                        console.log(`[HubEventSub] Loaded ${Object.keys(epochMap).length} epoch secrets for ${dTag}`)
                      }
                      for (const [gid, gmap] of Object.entries(groupEpochMaps)) {
                        store.setGroupEpochSecrets(dTag, gid, gmap)
                      }
                    } catch (err) {
                      console.warn(`[HubEventSub] Failed to load epoch history for ${dTag}:`, err)
                    }
                  }

                  // Re-decrypt group secrets for groups the user qualifies for
                  if (hubData.groupedRoles && hubData.groupedRoles.length > 0 && index.groupTrees.length > 0) {
                    try {
                      const { decryptGroupSecret } = await import('@/lib/blossom')
                      const { memberQualifiesForGroup } = await import('@/lib/hub/groupEncryption')
                      const member = members.find((m) => m.pubkey === pubkey)
                      const memberRoles = member?.roles || 'everyone'
                      const isCreator = pubkey === hubData.creatorPubkey

                      for (const group of hubData.groupedRoles) {
                        const qualifies = isCreator || memberQualifiesForGroup(memberRoles, group.roleIds)
                        if (!qualifies) continue

                        const groupRef = index.groupTrees.find((gt) => gt.groupId === group.groupId)
                        if (!groupRef) continue

                        try {
                          const groupTreeContent = await downloadTextFromBlossom(groupRef.hash, hubData.blossomServers)
                          const groupSecret = await decryptGroupSecret(pubkey, privateKey, signer, hubData.creatorPubkey, groupTreeContent)
                          if (groupSecret) {
                            const groupSecretHex = Array.from(groupSecret).map((b) => b.toString(16).padStart(2, '0')).join('')
                            store.setGroupSecret(dTag, group.groupId, groupSecretHex)
                            console.log(`[HubEventSub] Re-decrypted group secret for ${group.groupId.slice(0, 8)}... (epoch ${group.epoch})`)
                          }
                        } catch (err) {
                          console.warn(`[HubEventSub] Failed to decrypt group secret for ${group.groupId.slice(0, 8)}...:`, err)
                        }
                      }
                    } catch (err) {
                      console.warn(`[HubEventSub] Failed to process group secrets:`, err)
                    }
                  }
                } else {
                  console.log(`[HubEventSub] Cannot decrypt hub secret for ${dTag} — may have been removed`)
                }
              } catch (err) {
                console.warn(`[HubEventSub] Failed to re-decrypt hub secret for ${dTag}:`, err)
              }
            }
          } catch (err) {
            console.warn(`[HubEventSub] Failed to update ban list for ${dTag}:`, err)
          }
        }
      }, 500) // 500ms debounce
    }

    // Subscribe to hub events for all hubs per relay batch
    for (const batch of batches) {
      const sub = subscribeToRelays(
        [batch.relay],
        {
          // No `since`: re-published hub events carry a low created_at (original + 1),
          // so a `since: now` lower bound would filter them out. Hub events are
          // addressable, so relays return only the latest version per coordinate —
          // no history flood from omitting `since`.
          kinds: [KINDS.HUB_EVENT],
          '#d': batch.hubDTags,
        },
        (event: Event) => {
          processHubEvent(event)
        },
      )
      subsRef.current.push(sub)
    }

    return () => {
      for (const sub of subsRef.current) sub.close()
      subsRef.current = []
      for (const t of Object.values(pendingRef.current)) clearTimeout(t)
      pendingRef.current = {}
    }
  }, [hubListLoaded, hubFingerprint, pubkey, signer, privateKey, reconnectNonce])
}
