/**
 * Mod moderation hooks (Discover → Mods). Ported from DEG MODS' useModeration.
 *
 * useModerationFilter removes the authority's blocked mods + blocked users from discovery (soft
 * moderation). useModStatus reports, per mod, whether it is moderated (for the badge) and whether it
 * should be render-blocked (hard moderation). Authors are always exempt for their own mods: a blocked
 * author still sees their own mod (with the badge) so moderation doesn't bait them into reposting.
 */

import { useMemo } from 'react'
import { useModModerationStore } from '@/stores/modModerationStore'
import { useUserStore } from '@/stores/userStore'

export function useModerationFilter(): <T extends { pubkey: string; aTag: string }>(items: T[]) => T[] {
  const blockedMods = useModModerationStore((s) => s.blockedMods)
  const blockedUsers = useModModerationStore((s) => s.blockedUsers)
  const softOn = useModModerationStore((s) => s.softModeration)
  const myPubkey = useUserStore((s) => s.pubkey)

  return useMemo(() => {
    if (!softOn) return <T extends { pubkey: string; aTag: string }>(items: T[]) => items
    const coords = new Set(blockedMods.map((b) => b.coord))
    const users = new Set(blockedUsers)
    return <T extends { pubkey: string; aTag: string }>(items: T[]) => items.filter((m) =>
      m.pubkey === myPubkey || (!coords.has(m.aTag) && !users.has(m.pubkey))
    )
  }, [blockedMods, blockedUsers, softOn, myPubkey])
}

export interface ModStatus {
  /** In a blocklist (blocked mod or blocked user). The badge shows regardless of the opt-outs. */
  moderated: boolean
  /** Render-blocked — don't render the mod (hard moderation on, and not the author's own mod). */
  blockRender: boolean
}

export function useModStatus(aTag?: string, pubkey?: string): ModStatus {
  const blockedMods = useModModerationStore((s) => s.blockedMods)
  const blockedUsers = useModModerationStore((s) => s.blockedUsers)
  const hardOn = useModModerationStore((s) => s.hardModeration)
  const myPubkey = useUserStore((s) => s.pubkey)

  return useMemo(() => {
    const entry = aTag ? blockedMods.find((b) => b.coord === aTag) : undefined
    const userBlocked = pubkey ? blockedUsers.includes(pubkey) : false
    const isAuthor = !!pubkey && pubkey === myPubkey
    return {
      moderated: !!entry || userBlocked,
      blockRender: !isAuthor && !!entry?.viewBlocked && hardOn,
    }
  }, [aTag, pubkey, blockedMods, blockedUsers, hardOn, myPubkey])
}
