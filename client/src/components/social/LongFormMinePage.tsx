/**
 * LongFormMinePage — Show user's own published kind:30023 articles
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSocialStore } from '@/stores/socialStore'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Loader2, FileText, RefreshCw, Pencil } from 'lucide-react'
import { cn, formatTimestamp } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import type { Event } from 'nostr-tools'

interface MyArticle {
  event: Event; dTag: string; title: string; summary: string
  image: string; publishedAt: number; wordCount: number
}

function parseMyArticle(ev: Event): MyArticle {
  const t = ev.tags
  return {
    event: ev, dTag: t.find(x => x[0] === 'd')?.[1] || '',
    title: t.find(x => x[0] === 'title')?.[1] || 'Untitled',
    summary: t.find(x => x[0] === 'summary')?.[1] || '',
    image: t.find(x => x[0] === 'image')?.[1] || '',
    publishedAt: parseInt(t.find(x => x[0] === 'published_at')?.[1] || String(ev.created_at), 10),
    wordCount: ev.content.split(/\s+/).filter(Boolean).length,
  }
}

export function LongFormMinePage() {
  const pubkey = useUserStore((s) => s.pubkey)
  const setActiveArticle = useSocialStore((s) => s.setActiveArticle)
  const setEditingArticle = useSocialStore((s) => s.setEditingArticle)
  const [articles, setArticles] = useState<MyArticle[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!pubkey) return
    setLoading(true)
    try {
      const events = await fetchEvents({ kinds: [30023], authors: [pubkey], limit: 100 })
      const coordMap = new Map<string, Event>()
      for (const ev of events) {
        const d = ev.tags.find(t => t[0] === 'd')?.[1] || ''
        const existing = coordMap.get(d)
        if (!existing || ev.created_at > existing.created_at) coordMap.set(d, ev)
      }
      // Filter out deleted articles (those with 'deleted' tag or empty content from deletion replacement)
      const alive = Array.from(coordMap.values()).filter(ev => {
        if (ev.tags.some(t => t[0] === 'deleted')) return false
        if (ev.content === '' && ev.tags.length <= 2) return false
        return true
      })
      const parsed = alive.map(parseMyArticle)
      parsed.sort((a, b) => b.publishedAt - a.publishedAt)
      setArticles(parsed)
    } catch (err) { console.error('[LongForm] Failed to load my articles:', err) }
    finally { setLoading(false) }
  }, [pubkey])

  useEffect(() => { load() }, [load])

  const handleOpen = (a: MyArticle) => {
    try {
      const naddr = nip19.naddrEncode({ kind: 30023, pubkey: a.event.pubkey, identifier: a.dTag })
      setActiveArticle(naddr)
    } catch { /* fallback */ }
  }

  const handleEdit = (a: MyArticle) => {
    try {
      const naddr = nip19.naddrEncode({ kind: 30023, pubkey: a.event.pubkey, identifier: a.dTag })
      setEditingArticle(naddr)
    } catch { /* fallback */ }
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-background overflow-hidden">
      <div className="flex items-center justify-between px-4 h-12 min-h-12 border-b border-border shrink-0">
        <span className="font-semibold text-sm text-foreground">My Articles</span>
        <button onClick={load} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"><RefreshCw size={16} /></button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="w-full mx-auto py-4 px-4 max-[1080px]:px-2 max-[1080px]:pb-12" style={{ maxWidth: 720 }}>
          {loading ? (
            <div className="flex items-center justify-center py-16"><Loader2 size={24} className="animate-spin text-muted-foreground" /></div>
          ) : articles.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center px-4">
              <FileText size={32} className="text-muted-foreground/40" />
              <h3 className="text-sm font-semibold text-foreground">No articles yet</h3>
              <p className="text-xs text-muted-foreground">Write your first article to see it here.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {articles.map(a => (
                <div key={a.dTag} className="flex items-start gap-3 p-3 rounded-xl border border-border bg-card hover:bg-accent/20 transition-colors group">
                  {a.image && (
                    <div className="w-20 h-14 rounded-lg overflow-hidden shrink-0 border border-border/50">
                      <BlossomImage src={a.image} alt={a.title} className="w-full h-full" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <button onClick={() => handleOpen(a)} className="text-sm font-semibold text-foreground hover:text-primary transition-colors cursor-pointer text-left line-clamp-1">{a.title}</button>
                    {a.summary && <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{a.summary}</p>}
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
                      <span>{formatTimestamp(a.publishedAt)}</span>
                      <span>·</span>
                      <span>{a.wordCount.toLocaleString()} words</span>
                    </div>
                  </div>
                  <button onClick={() => handleEdit(a)} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer opacity-0 group-hover:opacity-100"><Pencil size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
