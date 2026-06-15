/**
 * useStartup — App initialization hook
 *
 * Runs once on mount:
 * 1. Discovers NIP-PC55 local signer (name, accounts)
 * 2. After login: fetches user profile (kind 0) and hub list (kind 16942)
 * 3. After hub list: loads hub events (kind 36942) via useHubLoader
 */

import { useEffect } from 'react'
import { useUserStore } from '@/stores/userStore'
import { useHubStore, type HubEntry, type HubFolder } from '@/stores/hubStore'
import { discover } from '@/lib/auth/pc55'
import { fetchReplaceable, fetchEvents } from '@/lib/nostr/relay-pool'
import { KINDS } from '@/lib/crypto/constants'
import { useHubLoader } from './useHubLoader'
import { useHubSubscriptions } from './useHubSubscriptions'
import { useExceptionSubscriptions } from './useExceptionSubscriptions'
import { useModBanSubscription } from './useModBanSubscription'
import { useHubEventSubscription } from './useHubEventSubscription'
import { useHideMessages } from './useHideMessages'
import { useBlockStore } from '@/stores/blockStore'
import { useFollowStore } from '@/stores/followStore'
import { useUserListsStore } from '@/stores/userListsStore'
import { useEmojiStore } from '@/stores/emojiStore'
import { useStickerStore } from '@/stores/stickerStore'
import { fetchMyEmojiSets, fetchEmojiSubscriptions, fetchEmojiSetByAddress } from '@/lib/nostr/customEmoji'
import { fetchMyStickerSets, fetchStickerSubscriptions, fetchStickerSetByAddress } from '@/lib/nostr/customSticker'
import { fetchMyGifCollections, fetchGifSubscriptions, fetchGifCollectionByAddress, fetchGifFavorites } from '@/lib/nostr/customGif'
import { useGifStore } from '@/stores/gifStore'
import { useDnnStore } from '@/stores/dnnStore'
import { useWotStore } from '@/stores/wotStore'
import { useDMStore } from '@/stores/dmStore'
import { useDM04Store } from '@/stores/dm04Store'
import { useNotificationStore } from '@/stores/notificationStore'
import { STANDARD_KINDS } from '@/lib/crypto/constants'
import { ADMIN_PUBKEY } from '@/lib/constants'

export function useStartup() {
  const setLocalSigner = useUserStore((s) => s.setLocalSigner)
  const isAuthenticated = useUserStore((s) => s.isAuthenticated)
  const pubkey = useUserStore((s) => s.pubkey)
  const activeHubId = useHubStore((s) => s.activeHubId)
  const setProfile = useUserStore((s) => s.setProfile)
  const setHubEntries = useHubStore((s) => s.setHubEntries)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const loadBlockList = useBlockStore((s) => s.loadBlockList)
  const loadFollowList = useFollowStore((s) => s.loadFollowList)

  // Discover local signer on startup
  useEffect(() => {
    discover().then((info) => {
      if (info) {
        setLocalSigner(info.name)
      }
    })
  }, [])

  // After login: fetch profile + hub list
  useEffect(() => {
    if (!isAuthenticated || !pubkey) return

    // Fetch user profile (kind 0)
    fetchReplaceable(pubkey, 0).then((event) => {
      if (event) {
        try {
          const profile = JSON.parse(event.content)
          setProfile({
            displayName: profile.display_name || profile.name,
            avatar: profile.picture,
          })
        } catch { /* ignore parse errors */ }
      }
    })

    // Fetch user hub list (kind 16942)
    fetchReplaceable(pubkey, KINDS.USER_HUB_LIST).then((event) => {
      if (!event) {
        setHubEntries([], []) // marks hubListLoaded = true
        return
      }

      const folders: HubFolder[] = []
      const entries: HubEntry[] = []

      for (const tag of event.tags) {
        if (tag[0] === 'folder' && tag[1] && tag[2]) {
          const color = tag[3] || undefined
          const position = tag[4] ? parseInt(tag[4], 10) : folders.length
          folders.push({ id: tag[1], name: tag[2], color, position })
        }
        if (tag[0] === 'v' && tag[1]) {
          // NIP-CHAT spec: [v, dTag, relayHint, position] or [v, dTag, relayHint, position:folderId]
          const relayHint = tag[2] || ''
          const posField = tag[3] || '0'
          const colonIdx = posField.indexOf(':')
          let position: number
          let folderId: string | undefined

          if (colonIdx !== -1) {
            position = parseInt(posField.substring(0, colonIdx), 10)
            folderId = posField.substring(colonIdx + 1)
          } else {
            position = parseInt(posField, 10)
            folderId = undefined
          }

          entries.push({ dTag: tag[1], relayHint, position, folderId })
        }
      }

      setHubEntries(entries, folders)
    })
    // Load user's encrypted block/mute list (kind 10000)
    loadBlockList(pubkey, signer, privateKey)
    // Load user's follow list (kind 3)
    loadFollowList(pubkey).then(() => {
      // Build WoT graph after follow list is available (background, non-blocking)
      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(() => useWotStore.getState().buildGraph())
      } else {
        setTimeout(() => useWotStore.getState().buildGraph(), 2000)
      }
    })
    // Load user's relay list (NIP-65) and blossom server list — used by posting behaviour
    useUserListsStore.getState().loadUserLists(pubkey)

    // Load custom emoji sets (NIP-30)
    ;(async () => {
      try {
        const [mySets, subAddresses] = await Promise.all([
          fetchMyEmojiSets(pubkey),
          fetchEmojiSubscriptions(pubkey),
        ])
        useEmojiStore.getState().setMyEmojiSets(mySets)
        useEmojiStore.getState().setSubscriptionAddresses(subAddresses)

        const subscribedSets = await Promise.all(
          subAddresses.map((addr) => fetchEmojiSetByAddress(addr))
        )
        useEmojiStore.getState().setSubscribedSets(
          subscribedSets.filter((s): s is NonNullable<typeof s> => s !== null)
        )
        useEmojiStore.getState().setLoaded(true)
      } catch (err) {
        console.error('[Startup] Failed to load custom emojis:', err)
        useEmojiStore.getState().setLoaded(true)
      }
    })()

    // Load custom sticker sets
    ;(async () => {
      try {
        const [mySets, subAddresses] = await Promise.all([
          fetchMyStickerSets(pubkey),
          fetchStickerSubscriptions(pubkey),
        ])
        useStickerStore.getState().setMyStickerSets(mySets)
        useStickerStore.getState().setSubscriptionAddresses(subAddresses)

        const subscribedSets = await Promise.all(
          subAddresses.map((addr) => fetchStickerSetByAddress(addr))
        )
        useStickerStore.getState().setSubscribedSets(
          subscribedSets.filter((s): s is NonNullable<typeof s> => s !== null)
        )
        useStickerStore.getState().setLoaded(true)
      } catch (err) {
        console.error('[Startup] Failed to load custom stickers:', err)
        useStickerStore.getState().setLoaded(true)
      }
    })()

    // Load custom GIF collections + subscriptions + favorites
    ;(async () => {
      try {
        const [myCollections, subAddresses, favorites] = await Promise.all([
          fetchMyGifCollections(pubkey),
          fetchGifSubscriptions(pubkey),
          fetchGifFavorites(pubkey),
        ])
        useGifStore.getState().setMyGifCollections(myCollections)
        useGifStore.getState().setSubscriptionAddresses(subAddresses)
        useGifStore.getState().setFavorites(favorites)

        const subscribedCollections = await Promise.all(
          subAddresses.map((addr) => fetchGifCollectionByAddress(addr))
        )
        useGifStore.getState().setSubscribedCollections(
          subscribedCollections.filter((c): c is NonNullable<typeof c> => c !== null)
        )
        useGifStore.getState().setLoaded(true)
      } catch (err) {
        console.error('[Startup] Failed to load custom GIFs:', err)
        useGifStore.getState().setLoaded(true)
      }
    })()

    // Initialize DNN service (background — non-blocking)
    useDnnStore.getState().initService().catch((err) =>
      console.warn('[Startup] DNN service init failed:', err)
    )

    // Initialize notification read-state from localStorage + relays
    useNotificationStore.getState().init(pubkey, signer, privateKey)
      .then(() => {
        // Background check: are there new social notifications since last seen?
        const { socialSeenAt, setHasSocialNotification } = useNotificationStore.getState()
        if (socialSeenAt > 0) {
          fetchEvents({
            kinds: [1, 7, 6, 9735],
            '#p': [pubkey],
            since: socialSeenAt + 1,
            limit: 1,
          }).then((events) => {
            // Filter out our own events (self-replies, etc.)
            const hasNew = events.some(e => e.pubkey !== pubkey)
            if (hasNew) setHasSocialNotification(true)
          }).catch(() => { /* non-critical */ })
        }
      })
      .catch((err) =>
        console.warn('[Startup] Notification store init failed:', err)
      )

    // ─── Deferred DM subscriptions ───
    // DM decryption is CPU-intensive (NIP-17 = 2× NIP-44 per message, NIP-04 = N decrypts per tag).
    // Starting them immediately competes with hub loading for CPU and relay bandwidth.
    // Strategy: start DMs when the first hub secret is available (hub UI is usable), OR after 5s fallback.
    let dmsStarted = false
    const startDMs = () => {
      if (dmsStarted) return
      dmsStarted = true
      console.log('[Startup] Starting deferred DM subscriptions')
      useDMStore.getState().startSubscription(pubkey, signer, privateKey)
      useDM04Store.getState().startSubscription(pubkey, signer, privateKey)
    }

    // Event-based trigger: watch for first hub secret becoming available
    const unsubHubStore = useHubStore.subscribe((state) => {
      if (Object.keys(state.hubSecrets).length > 0 && !dmsStarted) {
        startDMs()
        unsubHubStore()
        clearTimeout(dmFallbackTimer)
      }
    })

    // Safety fallback: if hub loading fails or takes too long, start DMs anyway
    const dmFallbackTimer = setTimeout(() => {
      if (!dmsStarted) {
        console.log('[Startup] DM fallback timer fired — starting DMs')
        startDMs()
        unsubHubStore()
      }
    }, 5000)

    // Re-subscribe on tab visibility only if subscriptions were lost (e.g. browser killed them)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (!useDMStore.getState().subscription) {
          useDMStore.getState().startSubscription(pubkey, signer, privateKey)
        }
        if (!useDM04Store.getState().subscription) {
          useDM04Store.getState().startSubscription(pubkey, signer, privateKey)
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    // ─── Deferred event redundancy check (personal events) ───
    // 30s after startup, verify that critical user events exist on all user relays.
    // If not, rebroadcast them (no signing needed — events are self-authenticating).
    const redundancyTimer = setTimeout(() => {
      import('@/lib/nostr/eventRedundancy').then(({ ensureAddressableRedundancy }) => {
        // Personal events — authored by the current user
        ensureAddressableRedundancy(STANDARD_KINDS.USER_METADATA, pubkey)           // kind 0 — profile
        ensureAddressableRedundancy(STANDARD_KINDS.CONTACT_LIST, pubkey)            // kind 3 — follow list
        ensureAddressableRedundancy(10000, pubkey)                                  // kind 10000 — mute/block list
        ensureAddressableRedundancy(STANDARD_KINDS.RELAY_LIST, pubkey)              // kind 10002 — relay list
        ensureAddressableRedundancy(STANDARD_KINDS.BLOSSOM_SERVER_LIST, pubkey)     // kind 10063 — blossom servers
        ensureAddressableRedundancy(KINDS.USER_HUB_LIST, pubkey)                   // kind 16942 — hub list

        // Emoji sets (kind 30030) — user's own sets, dynamic d-tags
        for (const set of useEmojiStore.getState().myEmojiSets) {
          ensureAddressableRedundancy(30030, pubkey, set.dTag)
        }
        // Emoji subscriptions (kind 30000, d=emoji-subscriptions)
        if (useEmojiStore.getState().subscriptionAddresses.length > 0) {
          ensureAddressableRedundancy(30000, pubkey, 'emoji-subscriptions')
        }

        // Sticker sets (kind 30030) — user's own sets, dynamic d-tags
        for (const set of useStickerStore.getState().myStickerSets) {
          ensureAddressableRedundancy(30030, pubkey, set.dTag)
        }
        // Sticker subscriptions (kind 30000, d=sticker-subscriptions)
        if (useStickerStore.getState().subscriptionAddresses.length > 0) {
          ensureAddressableRedundancy(30000, pubkey, 'sticker-subscriptions')
        }

        // GIF collections (kind 30030) — user's own collections, dynamic d-tags
        for (const col of useGifStore.getState().myGifCollections) {
          ensureAddressableRedundancy(30030, pubkey, col.dTag)
        }
        // GIF subscriptions (kind 30000, d=gif-subscriptions)
        if (useGifStore.getState().subscriptionAddresses.length > 0) {
          ensureAddressableRedundancy(30000, pubkey, 'gif-subscriptions')
        }
        // GIF favorites (kind 30000, d=gif-favorites)
        if (useGifStore.getState().favorites.length > 0) {
          ensureAddressableRedundancy(30000, pubkey, 'gif-favorites')
        }

        // Admin NIP-78 application data — authored by the admin pubkey
        // Any authenticated user helps keep these alive via cooperative rebroadcasting
        ensureAddressableRedundancy(STANDARD_KINDS.APP_DATA, ADMIN_PUBKEY, 'den-chat-faq')
        ensureAddressableRedundancy(STANDARD_KINDS.APP_DATA, ADMIN_PUBKEY, 'den-chat-background-login')
        ensureAddressableRedundancy(STANDARD_KINDS.APP_DATA, ADMIN_PUBKEY, 'den-chat-ads')
        ensureAddressableRedundancy(STANDARD_KINDS.APP_DATA, ADMIN_PUBKEY, 'den-chat-premium')
        ensureAddressableRedundancy(STANDARD_KINDS.APP_DATA, ADMIN_PUBKEY, 'den-chat-about-other-products')
        ensureAddressableRedundancy(STANDARD_KINDS.APP_DATA, ADMIN_PUBKEY, 'den-chat-guides')
      })
    }, 30_000)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      unsubHubStore()
      clearTimeout(dmFallbackTimer)
      clearTimeout(redundancyTimer)
    }
  }, [isAuthenticated, pubkey])

  // Load hub event data from relays for all hub entries
  useHubLoader()

  // Subscribe to real-time messages for all loaded hubs
  useHubSubscriptions()

  // Tier 2: Exception subscriptions for event kinds without #h tags (zaps, etc.)
  useExceptionSubscriptions()

  // Real-time subscription for moderator ban list changes
  useModBanSubscription()

  // Real-time subscription for hub event updates (creator bans, epoch rotations, etc.)
  useHubEventSubscription()

  // Fetch hide message events for the active hub (initial 30-day window)
  useHideMessages(activeHubId)

  // ─── Hub event redundancy (cooperative rebroadcasting) ───
  // When the user opens a hub, check that its hub event (kind 36942) exists on ≥3
  // hardcoded relays. Any member that opens a hub helps keep it alive.
  // No cleanup on the timeout — rapid hub switching queues all visited hubs for checking.
  useEffect(() => {
    if (!isAuthenticated || !activeHubId) return
    const hubId = activeHubId
    setTimeout(() => {
      const hub = useHubStore.getState().hubs[hubId]
      if (!hub) return
      import('@/lib/nostr/eventRedundancy').then(({ ensureAddressableRedundancy }) => {
        ensureAddressableRedundancy(KINDS.HUB_EVENT, hub.creatorPubkey, hubId)
      })
    }, 5000)
  }, [isAuthenticated, activeHubId])
}

