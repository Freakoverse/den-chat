/**
 * NotificationList — shared renderer for forum + long-form notifications.
 *
 * Reactions are aggregated into 24-hour buckets (one summary card per day) so a
 * burst of votes doesn't fill the page; replies are shown individually. The two
 * kinds are interleaved chronologically (newest first).
 */

import { useMemo } from 'react'
import { nip19 } from 'nostr-tools'
import { useProfileCache } from '@/hooks/useProfileCache'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { ArrowBigUp, ArrowBigDown, MessageSquare, Loader2 } from 'lucide-react'
import { truncateNpub, formatTimestamp } from '@/lib/utils'

export interface NotifItem {
  id: string
  type: 'reaction' | 'reply'
  actor: string
  createdAt: number
  bucket?: 'positive' | 'negative'
  body?: string
  /** Open the source post/article. */
  onOpen?: () => void
}

function useName(pubkey: string) {
  const { getProfile } = useProfileCache()
  const p = getProfile(pubkey)
  return { name: p?.display_name || p?.name || truncateNpub(nip19.npubEncode(pubkey), 8), picture: p?.picture as string | undefined }
}

function ActorAvatar({ pubkey }: { pubkey: string }) {
  const { name, picture } = useName(pubkey)
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Avatar className="h-5 w-5"><AvatarImage src={picture} /><AvatarFallback className="text-[8px]">{name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
        </TooltipTrigger>
        <TooltipContent className="text-xs">{name}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function ActorName({ pubkey }: { pubkey: string }) {
  const { name } = useName(pubkey)
  return <span className="font-medium text-foreground truncate">{name}</span>
}

type Row =
  | { kind: 'reply'; sortTime: number; item: NotifItem }
  | { kind: 'bucket'; sortTime: number; positive: number; negative: number; actors: string[]; newest: number }

export function NotificationList({ items, loading, emptyHint }: { items: NotifItem[]; loading: boolean; emptyHint: string }) {
  const rows = useMemo<Row[]>(() => {
    const replies = items.filter((n) => n.type === 'reply')
    const reactions = items.filter((n) => n.type === 'reaction')

    // Group reactions into 24h windows, anchored to the most recent reaction
    // (pure — avoids reading the clock during render).
    const anchor = reactions.reduce((m, r) => Math.max(m, r.createdAt), 0)
    const byDay = new Map<number, NotifItem[]>()
    for (const r of reactions) {
      const day = Math.max(0, Math.floor((anchor - r.createdAt) / 86400))
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day)!.push(r)
    }

    const out: Row[] = []
    for (const r of replies) out.push({ kind: 'reply', sortTime: r.createdAt, item: r })
    for (const group of byDay.values()) {
      const newest = Math.max(...group.map((g) => g.createdAt))
      const actors: string[] = []
      for (const g of group) if (!actors.includes(g.actor)) actors.push(g.actor)
      out.push({
        kind: 'bucket',
        sortTime: newest,
        newest,
        positive: group.filter((g) => g.bucket !== 'negative').length,
        negative: group.filter((g) => g.bucket === 'negative').length,
        actors,
      })
    }
    return out.sort((a, b) => b.sortTime - a.sortTime)
  }, [items])

  if (loading) return <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-muted-foreground" /></div>
  if (rows.length === 0) return <p className="text-center text-sm text-muted-foreground py-12">{emptyHint}</p>

  return (
    <div className="space-y-2">
      {rows.map((row, i) => row.kind === 'reply' ? (
        <button key={row.item.id} onClick={row.item.onOpen} className="w-full text-left rounded-xl border border-border bg-card p-3 hover:border-border/80 transition-colors cursor-pointer">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
            <ActorAvatar pubkey={row.item.actor} />
            <ActorName pubkey={row.item.actor} />
            <MessageSquare size={12} /> <span>replied</span>
            <span className="ml-auto shrink-0">{formatTimestamp(row.item.createdAt)}</span>
          </div>
          {row.item.body && <p className="text-sm text-foreground/90 line-clamp-3 whitespace-pre-wrap break-words">{row.item.body}</p>}
        </button>
      ) : (
        <div key={`bucket-${i}`} className="rounded-xl border border-border bg-card p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
            {row.positive > 0 && <span className="flex items-center gap-0.5 text-emerald-500 font-medium"><ArrowBigUp size={14} className="fill-current" /> {row.positive}</span>}
            {row.negative > 0 && <span className="flex items-center gap-0.5 text-destructive font-medium"><ArrowBigDown size={14} className="fill-current" /> {row.negative}</span>}
            <span>reaction{row.positive + row.negative !== 1 ? 's' : ''} on your posts and comments</span>
            <span className="ml-auto shrink-0">{formatTimestamp(row.newest)}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {row.actors.slice(0, 14).map((a) => <ActorAvatar key={a} pubkey={a} />)}
            {row.actors.length > 14 && <span className="text-[11px] text-muted-foreground self-center">+{row.actors.length - 14}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}
