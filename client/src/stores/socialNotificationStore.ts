/**
 * socialNotificationStore — warm cache for the short-form (kind-1) notifications page.
 *
 * The Notifications view used to hold its list in local component state and re-fetch 4 relay queries
 * (mentions/reactions/reposts/zaps) from scratch on every mount, showing a spinner each time. This
 * store lifts that fetch out so the result survives navigation: the page renders the last result
 * instantly and refreshes in the background, and the social feed can WARM the cache on open so the
 * Notifications tab is ready before the user clicks it.
 *
 * Not a live subscription — it's a cached fetch with a short refresh throttle. `loading` is only true
 * on the first load (nothing cached yet); a background refresh over existing data keeps the old list on
 * screen. Cleared on account switch via resetSession.
 */

import { create } from 'zustand'
import type { Event } from 'nostr-tools'
import { fetchEventsWide } from '@/lib/nostr/readRelays'
import { parseZapReceipt } from '@/lib/nostr/zap'
import { useUserStore } from '@/stores/userStore'

export type NotifType = 'mention' | 'reply' | 'reaction' | 'repost' | 'zap'

export interface SocialNotification {
  id: string
  type: NotifType
  event: Event        // the notification event itself
  sourceEvent?: Event // the referenced post (resolved)
  createdAt: number
  // Zap-specific — parsed from the kind 9735 receipt (the receipt's own pubkey
  // is the wallet/LNURL service, NOT the zapper, so we resolve the real sender).
  zapSenderPubkey?: string
  zapAmount?: number
  zapMessage?: string
}

interface SocialNotifState {
  notifications: SocialNotification[]
  /** True only while a load runs with nothing cached to show (first load) — never over stale data. */
  loading: boolean
  /** ms epoch of the last successful fetch — powers the refresh throttle. */
  lastFetchedAt: number
  /**
   * Fetch + fold notifications into the store. Renders nothing new until it completes, but keeps any
   * existing list visible in the meantime. A background refresh within REFRESH_THROTTLE_MS is skipped
   * unless `force`. Concurrent calls share one in-flight fetch.
   */
  load: (myPubkey: string | null, opts?: { force?: boolean }) => Promise<void>
  reset: () => void
}

/** Skip a background refresh if we fetched this recently (opening feed then Notifications ⇒ one fetch). */
const REFRESH_THROTTLE_MS = 10_000

/** Shared in-flight fetch so a warm-start and the page's own mount-load don't double-query. */
let inFlight: Promise<void> | null = null

export const useSocialNotificationStore = create<SocialNotifState>((set, get) => ({
  notifications: [],
  loading: false,
  lastFetchedAt: 0,

  load: async (myPubkey, opts) => {
    if (!myPubkey) { set({ loading: false }); return }
    if (inFlight) return inFlight
    // Throttle background refreshes; the very first load (lastFetchedAt 0) always runs.
    if (!opts?.force && get().lastFetchedAt && Date.now() - get().lastFetchedAt < REFRESH_THROTTLE_MS) return
    // Spinner only when there's nothing to show — a refresh keeps the current list up.
    if (get().notifications.length === 0) set({ loading: true })

    inFlight = (async () => {
      try {
        // Fetch all event types that tag us.
        const [mentions, reactions, reposts, zaps] = await Promise.all([
          fetchEventsWide({ kinds: [1], '#p': [myPubkey], limit: 50 }),
          fetchEventsWide({ kinds: [7], '#p': [myPubkey], limit: 50 }),
          fetchEventsWide({ kinds: [6], '#p': [myPubkey], limit: 30 }),
          fetchEventsWide({ kinds: [9735], '#p': [myPubkey], limit: 30 }),
        ])

        const notifs: SocialNotification[] = []

        // Mentions — kind 1 events that tag us but aren't our own.
        for (const event of mentions) {
          if (event.pubkey === myPubkey) continue
          const hasReplyTag = event.tags.some((t) => t[0] === 'e')
          notifs.push({ id: event.id, type: hasReplyTag ? 'reply' : 'mention', event, createdAt: event.created_at })
        }

        // Reactions — pre-filter by k tag when available (NIP-25).
        for (const event of reactions) {
          if (event.pubkey === myPubkey) continue
          const kTag = event.tags.find((t) => t[0] === 'k')
          if (kTag && kTag[1] !== '1') continue // fast-path: skip non-kind-1 reactions
          notifs.push({ id: event.id, type: 'reaction', event, createdAt: event.created_at })
        }

        // Reposts — kind 6 is specifically for kind 1, but filter just in case.
        for (const event of reposts) {
          if (event.pubkey === myPubkey) continue
          const kTag = event.tags.find((t) => t[0] === 'k')
          if (kTag && kTag[1] !== '1') continue
          notifs.push({ id: event.id, type: 'repost', event, createdAt: event.created_at })
        }

        // Zaps — parse the receipt to get the REAL zapper (the receipt's own pubkey is the wallet
        // service), the amount, and the comment.
        for (const event of zaps) {
          const kTag = event.tags.find((t) => t[0] === 'k')
          if (kTag && kTag[1] !== '1') continue
          const zapInfo = parseZapReceipt(event)
          if (!zapInfo) continue // unparseable receipt — skip
          if (zapInfo.senderPubkey === myPubkey) continue // ignore self-zaps
          notifs.push({
            id: event.id, type: 'zap', event, createdAt: event.created_at,
            zapSenderPubkey: zapInfo.senderPubkey, zapAmount: zapInfo.amount, zapMessage: zapInfo.message,
          })
        }

        // Sort newest first.
        notifs.sort((a, b) => b.createdAt - a.createdAt)

        // Resolve referenced posts for reactions/reposts/zaps to confirm kind 1.
        const refIds = new Set<string>()
        for (const n of notifs) {
          if (n.type === 'reaction' || n.type === 'repost' || n.type === 'zap') {
            const eTag = n.event.tags.find((t) => t[0] === 'e')
            if (eTag?.[1]) refIds.add(eTag[1])
          }
        }
        if (refIds.size > 0) {
          const resolved = await fetchEventsWide({ ids: [...refIds].slice(0, 80), limit: 80 })
          const resolvedMap = new Map(resolved.map((e) => [e.id, e]))
          for (const n of notifs) {
            if (n.type === 'reaction' || n.type === 'repost' || n.type === 'zap') {
              const eTag = n.event.tags.find((t) => t[0] === 'e')
              if (eTag?.[1]) n.sourceEvent = resolvedMap.get(eTag[1])
            }
          }
        }

        // Keep only notifications that target kind-1 posts. Mentions/replies are inherently kind 1;
        // for reactions/reposts/zaps, drop any whose resolved source event isn't kind 1.
        const kind1Only = notifs.filter((n) => {
          if (n.type === 'mention' || n.type === 'reply') return true
          if (n.sourceEvent) return n.sourceEvent.kind === 1
          const kTag = n.event.tags.find((t) => t[0] === 'k')
          if (kTag?.[1] === '1') return true
          return false
        })

        // Account-switch guard: a switch may have happened mid-fetch (this outlives the page now), so
        // don't write another account's notifications into the (reset) store.
        if (useUserStore.getState().pubkey !== myPubkey) return
        set({ notifications: kind1Only, lastFetchedAt: Date.now() })
      } catch (err) {
        console.error('[Social] Failed to fetch notifications:', err)
      } finally {
        set({ loading: false })
        inFlight = null
      }
    })()
    return inFlight
  },

  reset: () => set({ notifications: [], loading: false, lastFetchedAt: 0 }),
}))
