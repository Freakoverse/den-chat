/**
 * useHideMessages — Fetch and manage hidden message state for a hub
 *
 * Strategy:
 * 1. On hub enter: fetch hide events from the last 30 days (one query)
 * 2. Live updates: handled by useHubSubscriptions adding HIDE_MESSAGE to its filter
 * 3. Lazy backfill: for messages older than 30 days (on demand)
 * 4. Prune: clear on hub leave
 */

import { useEffect, useCallback, useRef } from 'react'
import { useHubStore, type HideEntry } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { getPermissionsForUser } from '@/lib/hub/permissions'
import { KINDS } from '@/lib/crypto/constants'
import { isV2 } from '@/lib/hub/version'

/**
 * Parse a hide message event into a HideEntry, or null if invalid/deleted.
 */
export function parseHideEvent(event: any): HideEntry | null {
  // Skip events with deleted tag
  if (event.tags?.some((t: string[]) => t[0] === 'deleted' && t[1] === 'true')) {
    return null
  }

  const aTag = event.tags?.find((t: string[]) => t[0] === 'a')
  const eTag = event.tags?.find((t: string[]) => t[0] === 'e')
  const pTag = event.tags?.find((t: string[]) => t[0] === 'p')
  const kTag = event.tags?.find((t: string[]) => t[0] === 'k')

  const ref = aTag?.[1] || eTag?.[1]
  if (!ref) return null

  return {
    ref,
    hiderPubkey: event.pubkey,
    kind: kTag?.[1] ? parseInt(kTag[1], 10) : KINDS.MESSAGE,
    targetPubkey: pTag?.[1] || '',
    createdAt: event.created_at || 0,
    channelId: event.tags?.find((t: string[]) => t[0] === 'c')?.[1],
  }
}

/**
 * Hook: fetch and manage hidden messages for the active hub.
 * Call this once per hub view (e.g. in the main hub layout).
 */
export function useHideMessages(hubDTag: string | null) {
  const fetchedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!hubDTag || fetchedRef.current === hubDTag) return
    fetchedRef.current = hubDTag

    const hub = useHubStore.getState().hubs[hubDTag]
    if (!hub) return

    const members = useHubStore.getState().hubMembers[hubDTag] || []

    // Build the set of pubkeys allowed to hide. v1: real keys R (creator + hide_messages roles).
    // v2: the pseudonyms P of those members (moderation is pseudonymous). We can authorize by P
    // because members hold the roster (P→R map): a P is allowed iff its R has hide permission, or
    // its R is the owner (R_owner, from the attestation). The owner's role is `O`, not R_owner, so
    // `getPermissionsForUser` won't flag them — hence the explicit owner check.
    const v2 = isV2(hub)
    const authorizedPubkeys: string[] = []
    // Query set = anyone who can hide at hub-level OR via ANY per-channel override (so channel-scoped
    // moderators' hides are fetched); each fetched hide is then re-validated against ITS channel below.
    const canHideAnywhere = (userKey: string) =>
      getPermissionsForUser(hub, userKey, members).hide_messages
      || (hub.channels || []).some(ch => getPermissionsForUser(hub, userKey, members, ch.channelId).hide_messages)
    if (v2) {
      // Owner authors hides as O (creatorPubkey — globally known, so cross-page verifiable).
      authorizedPubkeys.push(hub.creatorPubkey)
      for (const m of members) {
        if (!m.p || m.pubkey === hub.ownerRealPubkey) continue // owner handled via O above
        if (canHideAnywhere(m.pubkey)) authorizedPubkeys.push(m.p)
      }
    } else {
      authorizedPubkeys.push(hub.creatorPubkey)
      for (const m of members) {
        if (m.pubkey === hub.creatorPubkey) continue
        if (canHideAnywhere(m.pubkey)) authorizedPubkeys.push(m.pubkey)
      }
    }

    if (authorizedPubkeys.length === 0) return

    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 3600

    ;(async () => {
      try {
        const { fetchEvents } = await import('@/lib/nostr/relay-pool')
        const events = await fetchEvents({
          kinds: [KINDS.HIDE_MESSAGE],
          authors: authorizedPubkeys,
          '#h': [hubDTag],
          since: thirtyDaysAgo,
        } as any)

        const entries: Record<string, HideEntry> = {}
        for (const ev of events) {
          const entry = parseHideEvent(ev)
          if (!entry) continue
          // Re-validate the author is authorized to hide IN THIS HIDE'S CHANNEL (`c` tag) — not just at
          // hub level — so a channel-scoped mod's out-of-channel hides aren't applied. Owner (O) always ok.
          if (entry.hiderPubkey !== hub.creatorPubkey) {
            const chId = ev.tags.find((t: string[]) => t[0] === 'c')?.[1]
            const hiderR = v2 ? members.find(m => m.p === entry.hiderPubkey)?.pubkey : entry.hiderPubkey
            if (!hiderR || !getPermissionsForUser(hub, hiderR, members, chId).hide_messages) continue
          }
          entries[entry.ref] = entry
        }

        useHubStore.getState().setHiddenMessages(hubDTag, entries)
      } catch (err) {
        console.warn('[useHideMessages] Failed to fetch hide events:', err)
      }
    })()

    // Cleanup on hub change
    return () => {
      // Don't clear immediately — let the store keep it for fast re-entry
    }
  }, [hubDTag])
}

/**
 * Hook: check if a specific message ref is hidden.
 * Returns the HideEntry if hidden, or undefined.
 */
export function useIsHidden(hubDTag: string | undefined, ref: string | undefined): HideEntry | undefined {
  return useHubStore((s) => {
    if (!hubDTag || !ref) return undefined
    return s.hiddenMessages[hubDTag]?.[ref]
  })
}

/**
 * Process a hide event received from a live subscription.
 * Validates permission and updates the store.
 */
export function processHideEvent(event: any, hubDTag: string) {
  const hub = useHubStore.getState().hubs[hubDTag]
  if (!hub) return

  const entry = parseHideEvent(event)

  // If it's a deleted hide event, remove from store
  if (!entry) {
    // Extract the ref from the event's a or e tag
    const aTag = event.tags?.find((t: string[]) => t[0] === 'a')
    const eTag = event.tags?.find((t: string[]) => t[0] === 'e')
    let ref = aTag?.[1] || eTag?.[1]

    // Fallback: parse ref from d-tag (format: "hubDTag:targetRef")
    // The deleted hide event strips a/e tags, so d-tag is the only source
    if (!ref) {
      const dTagValue = event.tags?.find((t: string[]) => t[0] === 'd')?.[1]
      if (dTagValue && dTagValue.startsWith(hubDTag + ':')) {
        ref = dTagValue.slice(hubDTag.length + 1)
      }
    }

    if (ref) {
      // Only remove if the existing hide was by this author
      const existing = useHubStore.getState().hiddenMessages[hubDTag]?.[ref]
      if (existing && existing.hiderPubkey === event.pubkey) {
        useHubStore.getState().removeHiddenMessage(hubDTag, ref)
      }
    }
    return
  }

  // Validate permission. v2: the hider is a pseudonym P — map P→R via the roster, then check.
  // Scope the check to the hidden message's CHANNEL (from the `c` tag) so PER-CHANNEL hide_messages
  // overrides are honored — a mod restricted to certain channels can't hide elsewhere, and a mod granted
  // hide only via a channel override isn't wrongly rejected. Absent `c` tag (legacy) → hub-level check.
  const members = useHubStore.getState().hubMembers[hubDTag] || []
  const hideChannelId = event.tags.find((t: string[]) => t[0] === 'c')?.[1]
  if (isV2(hub)) {
    if (event.pubkey !== hub.creatorPubkey) {
      // Not the owner (who signs as O) — must be a same-page member with the hide role.
      const hider = members.find(m => m.p === event.pubkey)
      if (!hider || !getPermissionsForUser(hub, hider.pubkey, members, hideChannelId).hide_messages) return
    }
  } else {
    const isCreator = event.pubkey === hub.creatorPubkey
    if (!isCreator && !getPermissionsForUser(hub, event.pubkey, members, hideChannelId).hide_messages) return
  }

  useHubStore.getState().addHiddenMessage(hubDTag, entry)
}
