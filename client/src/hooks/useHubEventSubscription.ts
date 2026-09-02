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
import { subscribeToRelays, getRelays } from '@/lib/nostr/relay-pool'
import { KINDS } from '@/lib/crypto/constants'
import { putHubEvent } from '@/lib/cache/hubEventCache'
import { isV2 } from '@/lib/hub/version'
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

    // Build relay batches. Include the CLIENT relays for every hub (not just each hub's own
    // generalRelays): membership-change hub events publish with failover to a broad pool
    // (hub relays → client relays), so when a hub's relays are down the new event lands on client
    // relays. Watching only generalRelays would miss it live — an accepted member would keep seeing
    // the awaiting-approval guard until a manual refresh. Mirrors the join-request badge fix.
    const batches = buildRelayIndex(hubs, getRelays())
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

      // Reject a forged (non-owner) hub event BEFORE advancing the newest-seen timestamp — otherwise a
      // forged event with a far-future created_at would poison latestTsRef and cause the real owner's
      // (lower created_at) event to be dropped. The binding is set once the real owner is confirmed
      // (decrypt success, below); unknown-creator proceeds.
      const { isForgedHubEvent } = await import('@/lib/hub/hubCreatorGuard')
      if (isForgedHubEvent(dTag, event.pubkey)) {
        console.warn(`[HubEventSub] Ignoring hub event for ${dTag} from non-owner ${event.pubkey.slice(0, 8)}…`)
        return
      }

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

        // Creator binding was already enforced above (before the timestamp guard); recordTrustedCreator is
        // used at decrypt-success below to establish/confirm the binding.
        const { recordTrustedCreator } = await import('@/lib/hub/hubCreatorGuard')

        // Version-downgrade CHECK: a hub's version only ever increases; refuse a below-mark event (a
        // tampered event dropping the v2 `version` tag to force the plaintext-R v1 path). This only SKIPS,
        // never mutates — safe before owner-proof. The RECORD is deferred to decrypt-success below so a
        // forged event can't advance the mark. A `deleted:true` tombstone omits `version` by design →
        // exempt (handled by the deleted branch, not the authoring path).
        const { isVersionDowngrade } = await import('@/lib/hub/versionGuard')
        if (!hubData.deleted && isVersionDowngrade(dTag, hubData.version)) {
          console.warn(`[HubEventSub] Ignoring version-downgrade hub event for ${dTag}: version ${hubData.version ?? 1} below high-water mark`)
          return
        }

        // v2: content is encrypted and the tree is P-keyed. Handle the whole update via the
        // shared loader path — never the v1 re-download below (which would wipe the encrypted
        // channels/roles and mis-key the tree by the real key R).
        if (isV2(hubData)) {
          // Epoch-rollback CHECK (record deferred to decrypt-success, same rationale as the version check).
          const { isEpochRollback } = await import('@/lib/hub/epochGuard')
          if (isEpochRollback(dTag, hubData.epoch)) {
            console.warn(`[HubEventSub] Ignoring rollback hub event for ${dTag}: epoch ${hubData.epoch} below high-water mark`)
            return
          }

          const indexChanged = hubData.indexFileHash !== currentHub.indexFileHash
          let secretHex = store.hubSecrets[dTag]
          let memberSecretRefreshed = false

          // On an index change (kick/edit/rotation), re-bootstrap via loadHubSecret (handles v2:
          // P derivation, roster members, encrypted bans).
          if (indexChanged && pubkey) {
            try {
              const { loadHubSecret } = await import('./useHubLoader')
              const res = await loadHubSecret(hubData, pubkey, privateKey, signer)
              if (res) {
                if (res.secretHex) {
                  store.setHubSecret(dTag, res.secretHex); secretHex = res.secretHex; memberSecretRefreshed = true
                  // Decrypt succeeded → advance the high-water marks now (a forged event that never
                  // decrypts can't poison them). Bind the creator ONLY on v2 — a v2 decrypt proves the real
                  // owner (P is unforgeable for a wrong ownerPub), whereas a v1 leaf keyed on the public R
                  // could be crafted by an attacker to bind to the wrong key.
                  const { recordVersionSeen } = await import('@/lib/hub/versionGuard')
                  const { recordEpochSeen } = await import('@/lib/hub/epochGuard')
                  if (hubData.version === 2) recordTrustedCreator(dTag, hubData.creatorPubkey)
                  recordVersionSeen(dTag, hubData.version)
                  recordEpochSeen(dTag, hubData.epoch)
                }
                if (res.members.length > 0) store.setHubMembers(dTag, res.members)
                // Write the ban list only when it RESOLVED. loadHubSecret sets banListUnresolved on a transient
                // ban-page fetch failure; overwriting with the [] it returns there would TRUNCATE the store's
                // ban list and re-expose banned users. A genuinely-empty (resolved) list still writes, so a
                // full unban propagates. Matches the initial-load consumer (useHubLoader).
                if (!res.banListUnresolved) store.setHubBanList(dTag, res.bannedPubkeys)
                if (res.pageCount > 0) store.setHubPageCount(dTag, res.pageCount)
                if (res.secretHex && res.historyHash) {
                  try {
                    const { downloadTextFromBlossom } = await import('@/lib/blossom')
                    const { aesDecrypt } = await import('@/lib/crypto/aes')
                    const { fromHex } = await import('@/lib/crypto/lkh')
                    const blob = await downloadTextFromBlossom(res.historyHash, hubData.blossomServers)
                    const plaintext = await aesDecrypt(fromHex(res.secretHex), blob)
                    const epochMap: Record<number, string> = {}
                    for (const line of plaintext.split('\n')) {
                      const t = line.trim(); if (!t.startsWith('hub:')) continue
                      const p = t.split(':'); if (p.length >= 3) epochMap[parseInt(p[1], 10)] = p.slice(2).join(':')
                    }
                    if (Object.keys(epochMap).length > 0) store.setEpochSecrets(dTag, epochMap)
                  } catch { /* history best-effort */ }
                }
              }
            } catch (err) {
              console.warn(`[HubEventSub] v2 re-bootstrap failed for ${dTag}:`, err)
            }
          }

          // Facilitated (non-member) users have no leaf in the owner's tree, so loadHubSecret above
          // couldn't refresh their secret — leaving the STALE pre-rotation one in place while the
          // metadata branch below bumps the epoch. That mis-keys sends (old secret under the new epoch
          // tag → undecryptable for everyone). On a rotation, clear it and re-fetch the facilitator's
          // rebuilt tree (loadFacilitatorSecret's v2 path derives our Pf against P_fac). Mirrors v1's
          // Part 4, but must live HERE — the v2 branch returns before that tail is reached.
          if (indexChanged && pubkey && !memberSecretRefreshed && hubData.epoch > currentHub.epoch) {
            const facilitator = store.hubPrefs[dTag]?.facilitator
            if (facilitator) {
              store.setHubSecret(dTag, ''); secretHex = '' // invalidate the stale secret NOW (falsy → skips content-decrypt below)
              try {
                const { loadFacilitatorSecret } = await import('./useHubLoader')
                const facResult = await loadFacilitatorSecret(hubData, facilitator, pubkey, privateKey, signer)
                if (facResult) {
                  if (facResult.epochSecrets && Object.keys(facResult.epochSecrets).length > 0) store.setEpochSecrets(dTag, facResult.epochSecrets)
                  if (facResult.epoch == null || facResult.epoch === hubData.epoch) {
                    // Facilitator is current — safe to use their distributed secret.
                    store.setHubSecret(dTag, facResult.secretHex); store.setHubPref(dTag, 'facilitatorSecret', facResult.secretHex); secretHex = facResult.secretHex
                  } // else facilitator is behind → leave cleared (can read old epochs via history, can't send at the new one)
                  if (facResult.facilitatorMembers.length > 0) store.setHubFacilitatorMembers(dTag, facilitator, facResult.facilitatorMembers)
                }
              } catch (err) { console.warn(`[HubEventSub] v2 facilitated re-fetch failed for ${dTag}:`, err) }
            } else if (secretHex) {
              // KICK/BAN: the secret rotated, we did NOT re-derive a member secret (a still-member would
              // have, above), and we have no facilitator to fall back on → we've been removed. Fail closed:
              // drop the stale pre-rotation secret + our own membership entry so the not-a-member guard
              // reappears, instead of leaving us with lingering access to the hub. Re-attempt once via the
              // retry nonce so a merely-transient load failure (rare, given local blob retention) self-heals
              // — if we're genuinely still a member the loader re-derives and the guard clears again.
              console.log(`[HubEventSub] ${dTag}: rotation without a refreshed member secret and no facilitator — treating as removed, clearing access`)
              store.setHubSecret(dTag, ''); secretHex = ''
              store.setHubMembers(dTag, (store.hubMembers[dTag] || []).filter((m) => m.pubkey !== pubkey))
              store.bumpHubSecretRetry?.()
            }
          }

          // v2: refresh the encrypted ban list from the (new) index whenever we hold the secret. A regular
          // member gets this via loadHubSecret above, but a FACILITATED user's loadHubSecret returns
          // not-a-member (no leaf in the owner tree) — they re-derive the secret via their facilitator, whose
          // mesh still lists them, so without this they never learn they were banned and the HardBan gate
          // (isHardBanned = my key ∈ hubBanList) never triggers in-session. Load it here so a banned
          // facilitated user is gated live, and other members hide them.
          if (secretHex && indexChanged) {
            try {
              const { fromHex } = await import('@/lib/crypto/lkh')
              const { downloadTextFromBlossom, parseIndexFile, downloadBanListV2 } = await import('@/lib/blossom')
              const idx = parseIndexFile(await downloadTextFromBlossom(hubData.indexFileHash, hubData.blossomServers))
              if (idx.banPages.length > 0) {
                const bans = await downloadBanListV2(idx.banPages, fromHex(secretHex), hubData.blossomServers)
                store.setHubBanList(dTag, bans.map((e) => e.pubkey))
              } else {
                store.setHubBanList(dTag, [])
              }
            } catch (err) { console.warn(`[HubEventSub] v2 ban-list refresh failed for ${dTag}:`, err) }
          }

          // Decrypt structural content with the (current or newly-bootstrapped) secret.
          let full: (typeof hubData) | null = null
          let ownerRealPubkey: string | undefined
          if (secretHex) {
            try {
              const { fromHex } = await import('@/lib/crypto/lkh')
              const { deriveHubContentKey, decryptHubContent, verifyOwnerAttestation } = await import('@/lib/hub/hubContent')
              const key = deriveHubContentKey(fromHex(secretHex), hubData.epoch)
              const decrypted = await decryptHubContent(key, event.content)
              full = parseHubEvent(event, JSON.stringify(decrypted))
              // Re-extract + verify the owner's real key R from the attestation on EVERY update — parseHubEvent
              // doesn't (it can't verify), and the store's merge only preserves a PRIOR ownerRealPubkey. Without
              // this, a member whose initial load raced/missed the extraction never learns the owner's R, so the
              // member list shows the owner twice (faceless O with the crown + their real identity from the roster).
              const { verifiedOwnerRealPubkey } = await import('./useHubLoader')
              ownerRealPubkey = verifiedOwnerRealPubkey(decrypted, hubData.creatorPubkey, dTag, verifyOwnerAttestation)
            } catch { /* couldn't decrypt — preserve existing structure below */ }
          }

          // If we HELD a secret but it can't decrypt THIS event's content while the epoch has MOVED, it's
          // stale — we couldn't follow the rotation (kicked, or facilitator behind), so we no longer have
          // access. Clear it so the no-access guard shows IN-SESSION, not only after a reload. (The
          // facilitated/kick branch above tries to do this, but only when its epoch condition holds; a race
          // that already advanced currentHub.epoch, or a facilitated re-fetch that left a stale secret, can
          // slip past it — this is the fail-closed backstop.) Gated on an ACTUAL epoch change so a transient
          // or corrupt-content blip on the SAME epoch never nukes a still-valid secret; a genuinely-still
          // member re-derived their secret above (full is set) and never reaches here.
          if (secretHex && !full && hubData.epoch !== currentHub.epoch) {
            console.log(`[HubEventSub] ${dTag}: held secret can't decrypt epoch ${hubData.epoch} content (was ${currentHub.epoch}) — stale, clearing so the no-access guard shows`)
            store.setHubSecret(dTag, '')
            secretHex = ''
            store.bumpHubSecretRetry?.() // if we're genuinely still a member (transient miss), the loader re-derives and the guard clears
          }

          if (full) {
            // Never WIPE a previously-verified ownerRealPubkey: if this update's attestation didn't
            // re-verify (undefined — e.g. an event whose content was rebuilt without the attestation, or a
            // transient hiccup), keep the value we already trust. Otherwise a single such update would drop
            // the owner's real key and the member list would show the owner twice again (faceless O + R).
            store.setHubData(dTag, { ...full, ownerRealPubkey: ownerRealPubkey ?? currentHub.ownerRealPubkey })
          } else if (indexChanged || hubData.epoch !== currentHub.epoch || (hubData.messageExpiration || 0) !== (currentHub.messageExpiration || 0) || hubData.deleted) {
            // Couldn't decrypt content (e.g. we were kicked) — update metadata only, keep channels.
            store.setHubData(dTag, {
              ...currentHub,
              indexFileHash: hubData.indexFileHash,
              epoch: hubData.epoch,
              messageExpiration: hubData.messageExpiration,
              deleted: hubData.deleted,
              eventCreatedAt: hubData.eventCreatedAt,
            })
          }
          // v2: re-decrypt group secrets when groups exist (rotation bumps their epoch/tree).
          if (full && secretHex && full.groupedRoles && full.groupedRoles.length > 0 && pubkey) {
            try {
              const { makeSubkeySigner } = await import('@/lib/nostr/v2send')
              const { ChatContext } = await import('@/lib/crypto/skd')
              const { memberQualifiesForGroup } = await import('@/lib/hub/groupEncryption')
              const { downloadTextFromBlossom, parseIndexFile, decryptGroupSecretV2 } = await import('@/lib/blossom')
              const oPub = await makeSubkeySigner(ChatContext.owner(dTag), { privateKey, signer }).getPublicKey()
              const isOwner = oPub === full.creatorPubkey
              const groupP = await makeSubkeySigner(ChatContext.member(dTag), { privateKey, signer, peerPub: full.creatorPubkey }).getPublicKey()
              const myRoles = store.hubMembers[dTag]?.find(m => m.pubkey === pubkey)?.roles || 'everyone'
              const index = parseIndexFile(await downloadTextFromBlossom(full.indexFileHash, full.blossomServers))
              for (const group of full.groupedRoles) {
                if (!(isOwner || memberQualifiesForGroup(myRoles, group.roleIds))) continue
                const ref = index.groupTrees.find(gt => gt.groupId === group.groupId)
                if (!ref) continue
                const gs = await decryptGroupSecretV2(groupP, full.dTag, privateKey, signer, full.creatorPubkey, await downloadTextFromBlossom(ref.hash, full.blossomServers))
                if (!gs) continue
                const hex = Array.from(gs).map(b => b.toString(16).padStart(2, '0')).join('')
                const prev = useHubStore.getState().groupSecrets?.[dTag]?.[group.groupId]
                const gmap: Record<number, string> = { ...(useHubStore.getState().groupEpochSecrets?.[dTag]?.[group.groupId] || {}) }
                if (prev && prev !== hex) gmap[Math.max(1, group.epoch - 1)] = prev
                gmap[group.epoch] = hex
                store.setGroupEpochSecrets(dTag, group.groupId, gmap)
                store.setGroupSecret(dTag, group.groupId, hex)
              }
            } catch (err) { console.warn(`[HubEventSub] v2 group re-decrypt failed for ${dTag}:`, err) }
          }
          if (hubData.deleted) store.setHubStatus(dTag, 'deleted')
          return
        }

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

                  // Facilitators rebuild their list to the new epoch MANUALLY, via the
                  // "Update list to current epoch" button in User Settings → My Facilitation List.
                  // (An automatic rebuild here only worked when the facilitator's client happened to
                  // be online at the exact moment the rotation arrived — unreliable — so it was removed
                  // in favor of the explicit button.)
                } else {
                  console.log(`[HubEventSub] Cannot decrypt hub secret for ${dTag} — may have been removed`)

                  // Part 4 — facilitated user auto-re-fetch on rotation. This tail is the v1 path only
                  // (the isV2 branch above returns early — the v2 equivalent lives there); we couldn't
                  // decrypt via the owner's tree (not a direct member) but have a saved facilitator.
                  // On a rotation, re-run the facilitator load; if they haven't rebuilt yet, the guard
                  // below keeps the epoch history but clears the stale current secret.
                  const facilitator = useHubStore.getState().hubPrefs[dTag]?.facilitator
                  if (facilitator && hubData.epoch > currentHub.epoch) {
                    try {
                      {
                        // Invalidate the stale secret IMMEDIATELY, before the async re-fetch below.
                        // The rotation just made our current secret old; without this synchronous
                        // clear there's a window where a facilitated user could SEND at the new epoch
                        // with the old key (nobody with the real new secret could then decrypt it).
                        store.setHubSecret(dTag, '')
                        const { loadFacilitatorSecret } = await import('./useHubLoader')
                        const facResult = await loadFacilitatorSecret(hubData, facilitator, pubkey, privateKey, signer)
                        if (facResult) {
                          if (facResult.epochSecrets && Object.keys(facResult.epochSecrets).length > 0) {
                            store.setEpochSecrets(dTag, facResult.epochSecrets)
                          }
                          if (facResult.epoch != null && facResult.epoch < hubData.epoch) {
                            // Facilitator is behind — they haven't rebuilt for this rotation yet. Clear
                            // the now-stale current secret so getChannelKey returns null for the new
                            // epoch: no decrypt of new-epoch messages, and (crucially) no SEND under the
                            // new epoch tag with an old secret. Epoch history stays (old msgs readable).
                            store.setHubSecret(dTag, '')
                          } else {
                            // Facilitator is current (or legacy no-history): their distributed secret is
                            // the current epoch's — safe to use as the live hub secret.
                            store.setHubSecret(dTag, facResult.secretHex)
                            store.setHubPref(dTag, 'facilitatorSecret', facResult.secretHex)
                          }
                          if (facResult.facilitatorMembers.length > 0) {
                            store.setHubFacilitatorMembers(dTag, facilitator, facResult.facilitatorMembers)
                          }
                          console.log(`[HubEventSub] Re-fetched facilitator secret for ${dTag} (facilitator epoch ${facResult.epoch ?? 'legacy'}, hub epoch ${hubData.epoch})`)
                        }
                      }
                    } catch (err) {
                      console.warn(`[HubEventSub] Facilitated re-fetch failed for ${dTag}:`, err)
                    }
                  }
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
