/**
 * LongFormNotificationsPage — replies + reactions on the user's articles and
 * their comments. Scoped to long-form (kind 30023/30024) only, so it never
 * overlaps the forum or social-feed notification surfaces.
 */

import { useState, useEffect } from 'react'
import { nip19 } from 'nostr-tools'
import type { Event } from 'nostr-tools'
import { useUserStore } from '@/stores/userStore'
import { useSocialStore } from '@/stores/socialStore'
import { useWotStore } from '@/stores/wotStore'
import { fetchEventsWide } from '@/lib/nostr/readRelays'
import { classifyReaction, reactionTargetId } from '@/lib/nostr/forum'
import { NotificationList, type NotifItem } from '@/components/social/NotificationList'

const LONGFORM_KINDS = new Set(['30023', '30024'])

/** Build an naddr from a `30023:<pubkey>:<dTag>` coordinate. */
function naddrFromCoord(coord: string): string | null {
  const parts = coord.split(':')
  const kind = parseInt(parts[0], 10)
  const pubkey = parts[1]
  const identifier = parts.slice(2).join(':')
  if (!pubkey || !identifier || (kind !== 30023 && kind !== 30024)) return null
  try { return nip19.naddrEncode({ identifier, pubkey, kind, relays: [] }) } catch { return null }
}

const rootCoordOf = (ev: Event) => ev.tags.find((t) => t[0] === 'A')?.[1]

export function LongFormNotificationsPage() {
  const myPubkey = useUserStore((s) => s.pubkey)
  const setActiveArticle = useSocialStore((s) => s.setActiveArticle)
  const wotShouldHide = useWotStore((s) => s.shouldHide)
  const [items, setItems] = useState<NotifItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!myPubkey) { setLoading(false); return }
    let cancelled = false

    ;(async () => {
      setLoading(true)
      try {
        const [reactions, replies] = await Promise.all([
          fetchEventsWide({ kinds: [7], '#p': [myPubkey], limit: 200 }),
          fetchEventsWide({ kinds: [1111], '#p': [myPubkey], limit: 200 }),
        ])
        const out: NotifItem[] = []
        const openArticle = (coord: string | undefined) => {
          const naddr = coord ? naddrFromCoord(coord) : null
          return naddr ? () => setActiveArticle(naddr) : undefined
        }

        // Replies whose root is a long-form article (K = 30023/30024).
        for (const rep of replies) {
          if (rep.pubkey === myPubkey || wotShouldHide(rep.pubkey, 'social')) continue
          const rootKind = rep.tags.find((t) => t[0] === 'K')?.[1]
          if (!rootKind || !LONGFORM_KINDS.has(rootKind)) continue
          out.push({ id: rep.id, type: 'reply', actor: rep.pubkey, createdAt: rep.created_at, body: rep.content, onOpen: openArticle(rootCoordOf(rep)) })
        }

        // Reactions on my articles (carry an `a` coordinate to my 30023/30024).
        const commentTargets = new Set<string>()
        for (const r of reactions) {
          if (r.pubkey === myPubkey || wotShouldHide(r.pubkey, 'social')) continue
          const coord = r.tags.find((t) => t[0] === 'a' && (t[1]?.startsWith('30023:') || t[1]?.startsWith('30024:')))?.[1]
          if (coord) {
            if (coord.split(':')[1] !== myPubkey) continue
            out.push({ id: r.id, type: 'reaction', actor: r.pubkey, createdAt: r.created_at, bucket: classifyReaction(r.content), onOpen: openArticle(coord) })
          } else {
            const e = reactionTargetId(r)
            if (e) commentTargets.add(e)
          }
        }

        // Reactions on my long-form *comments* — resolve to confirm (K = 30023/24).
        if (commentTargets.size) {
          const targets = await fetchEventsWide({ ids: [...commentTargets].slice(0, 200) })
          const tmap = new Map(targets.map((e) => [e.id, e]))
          for (const r of reactions) {
            if (r.pubkey === myPubkey || wotShouldHide(r.pubkey, 'social')) continue
            const e = reactionTargetId(r); if (!e || !commentTargets.has(e)) continue
            const tgt = tmap.get(e); if (!tgt || tgt.pubkey !== myPubkey) continue
            const rootKind = tgt.tags.find((t) => t[0] === 'K')?.[1]
            if (!rootKind || !LONGFORM_KINDS.has(rootKind)) continue
            out.push({ id: r.id, type: 'reaction', actor: r.pubkey, createdAt: r.created_at, bucket: classifyReaction(r.content), onOpen: openArticle(rootCoordOf(tgt)) })
          }
        }

        if (!cancelled) setItems(out)
      } catch (e) {
        console.error('[longform] notifications failed:', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [myPubkey, setActiveArticle, wotShouldHide])

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[680px] px-4 py-4 space-y-3">
        <div className="px-1">
          <h2 className="text-lg font-bold text-foreground">Notifications</h2>
          <p className="text-xs text-muted-foreground">Replies and reactions on your articles and comments.</p>
        </div>
        <NotificationList items={items} loading={loading} emptyHint="No replies or reactions on your articles yet." />
      </div>
    </div>
  )
}
