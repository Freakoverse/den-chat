/**
 * LongFormBookmarksPage — Displays bookmarked kind:30023 articles
 *
 * Fetches the user's kind:10003 bookmark list, resolves event IDs,
 * filters to only kind:30023 articles, and renders them as article cards.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useSocialStore } from '@/stores/socialStore'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Loader2, Bookmark, RefreshCw, Search } from 'lucide-react'
import { truncateNpub, formatTimestamp } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import { decryptNip04 } from '@/lib/nostr/nip04dm'
import type { Event } from 'nostr-tools'

/* ─── Types ─── */

interface ArticleCard {
  event: Event
  dTag: string
  title: string
  summary: string
  image: string
  publishedAt: number
  tags: string[]
  wordCount: number
}

/* ─── Helper: parse article metadata from event tags ─── */

function parseArticle(event: Event): ArticleCard {
  const tags = event.tags
  const dTag = tags.find(t => t[0] === 'd')?.[1] || ''
  const title = tags.find(t => t[0] === 'title')?.[1] || 'Untitled'
  const summary = tags.find(t => t[0] === 'summary')?.[1] || ''
  const image = tags.find(t => t[0] === 'image')?.[1] || ''
  const publishedAtStr = tags.find(t => t[0] === 'published_at')?.[1]
  const publishedAt = publishedAtStr ? parseInt(publishedAtStr, 10) : event.created_at
  const articleTags = tags.filter(t => t[0] === 't').map(t => t[1])
  const wordCount = event.content.split(/\s+/).filter(Boolean).length

  return { event, dTag, title, summary, image, publishedAt, tags: articleTags, wordCount }
}

/* ─── Article Card Component ─── */

function BookmarkedArticleCard({ article, onOpenArticle, onOpenProfile }: {
  article: ArticleCard
  onOpenArticle: (naddr: string) => void
  onOpenProfile: (pubkey: string) => void
}) {
  const { getProfile } = useProfileCache()
  const profile = getProfile(article.event.pubkey)
  const npub = nip19.npubEncode(article.event.pubkey)
  const displayName = profile?.display_name || profile?.name || truncateNpub(npub, 8)
  const readingTime = Math.max(1, Math.ceil(article.wordCount / 230))

  const naddr = useMemo(() => {
    try {
      return nip19.naddrEncode({
        kind: 30023,
        pubkey: article.event.pubkey,
        identifier: article.dTag,
      })
    } catch { return article.event.id }
  }, [article])

  return (
    <button
      onClick={() => onOpenArticle(naddr)}
      className="w-full h-full text-left rounded-xl border border-border bg-card hover:bg-accent/30 overflow-hidden transition-all duration-200 group cursor-pointer hover:border-primary/20 flex flex-col"
    >
      {/* Featured image */}
      {article.image && /^https?:\/\//.test(article.image) ? (
        <BlossomImage
          src={article.image}
          alt={article.title}
          className="w-full h-40 shrink-0"
          imgClassName="group-hover:scale-[1.02] transition-transform duration-300"
          fallback={
            <div className="w-full h-40 shrink-0 bg-secondary/80 flex items-center justify-center">
              <img src="/app-icon.png" alt="" className="w-16 h-16 object-contain opacity-40" />
            </div>
          }
        />
      ) : (
        <div className="w-full h-40 shrink-0 bg-secondary/80 flex items-center justify-center">
          <img src="/app-icon.png" alt="" className="w-16 h-16 object-contain opacity-40" />
        </div>
      )}

      {/* Content */}
      <div className="p-4 flex flex-col flex-1 min-h-0">
        <h3 className="text-sm font-semibold text-foreground line-clamp-2 leading-snug group-hover:text-primary transition-colors">
          {article.title}
        </h3>

        {article.summary && (
          <p className="text-xs text-muted-foreground line-clamp-3 leading-relaxed mt-1.5">
            {article.summary}
          </p>
        )}

        {/* Footer */}
        <div className="mt-auto pt-3">
          <div className="border-t border-border/40 pt-2.5 space-y-1.5">
            <div className="flex items-center gap-2">
              <Avatar className="w-5 h-5 shrink-0">
                {profile?.picture && <AvatarImage src={profile.picture} />}
                <AvatarFallback className="text-[8px] bg-primary/20 text-primary">
                  {displayName.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <button
                onClick={(e) => { e.stopPropagation(); onOpenProfile(article.event.pubkey) }}
                className="text-xs font-medium text-foreground hover:underline cursor-pointer truncate"
              >
                {displayName}
              </button>
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span>{formatTimestamp(article.publishedAt)}</span>
              <span>·</span>
              <span>{readingTime} min read</span>
            </div>
          </div>
        </div>
      </div>
    </button>
  )
}

/* ─── Bookmarks Page ─── */

export function LongFormBookmarksPage() {
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const setActiveArticle = useSocialStore((s) => s.setActiveArticle)
  const setActiveProfile = useSocialStore((s) => s.setActiveProfile)

  const [articles, setArticles] = useState<ArticleCard[]>([])
  const [loading, setLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const loadedRef = useRef(false)

  const loadBookmarks = useCallback(async () => {
    if (!pubkey) return
    setLoading(true)
    try {
      // Fetch the user's bookmark list
      const lists = await fetchEvents({ kinds: [10003], authors: [pubkey], limit: 1 })
      const latest = lists.sort((a, b) => b.created_at - a.created_at)[0]
      if (!latest) { setArticles([]); return }

      // Decrypt private bookmarks
      let eventIds: string[] = []
      if (latest.content) {
        try {
          const decrypted = await decryptNip04(latest.content, pubkey, signer, privateKey)
          const privateTags: string[][] = JSON.parse(decrypted)
          eventIds = privateTags.filter(t => t[0] === 'e').map(t => t[1])
        } catch {
          // Fallback: legacy public tags
          eventIds = latest.tags.filter(t => t[0] === 'e').map(t => t[1])
        }
      } else {
        eventIds = latest.tags.filter(t => t[0] === 'e').map(t => t[1])
      }

      if (eventIds.length === 0) { setArticles([]); return }

      // Resolve events and filter to kind:30023 articles only
      const resolved = await fetchEvents({ ids: eventIds.slice(0, 100), limit: 100 })
      const articleEvents = resolved.filter(e => e.kind === 30023)

      // Deduplicate by pubkey:d-tag coordinate
      const coordMap = new Map<string, Event>()
      for (const ev of articleEvents) {
        const d = ev.tags.find(t => t[0] === 'd')?.[1] || ''
        const coord = `${ev.pubkey}:${d}`
        const existing = coordMap.get(coord)
        if (!existing || ev.created_at > existing.created_at) {
          coordMap.set(coord, ev)
        }
      }

      // Filter out deleted articles (those with 'deleted' tag or empty content from deletion replacement)
      const alive = Array.from(coordMap.values()).filter(ev => {
        if (ev.tags.some(t => t[0] === 'deleted')) return false
        if (ev.content === '' && ev.tags.length <= 2) return false
        return true
      })
      const parsed = alive.map(parseArticle)
      parsed.sort((a, b) => b.publishedAt - a.publishedAt)
      setArticles(parsed)
    } catch (err) {
      console.error('[LongForm Bookmarks] Failed to load:', err)
    } finally {
      setLoading(false)
    }
  }, [pubkey, signer, privateKey])

  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    loadBookmarks()
  }, [loadBookmarks])

  // Filtered articles (search)
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return articles
    const q = searchQuery.toLowerCase()
    return articles.filter(a =>
      a.title.toLowerCase().includes(q) ||
      a.summary.toLowerCase().includes(q) ||
      a.tags.some(t => t.toLowerCase().includes(q))
    )
  }, [articles, searchQuery])

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-12 min-h-12 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Bookmark size={16} className="text-yellow-500" />
          <span className="font-semibold text-sm text-foreground">Long Form — Bookmarks</span>
        </div>
        <button onClick={() => { loadedRef.current = false; loadBookmarks() }} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer">
          <RefreshCw size={16} />
        </button>
      </div>

      {/* Search bar */}
      <div className="px-4 py-3 border-b border-border/50 shrink-0">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/60 border border-border focus-within:border-primary/40 transition-colors">
          <Search size={14} className="text-muted-foreground shrink-0" />
          <input
            type="text"
            placeholder="Search bookmarked articles..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="w-full mx-auto py-4 px-4 max-[1080px]:px-2 max-[1080px]:pb-12" style={{ maxWidth: 1200 }}>
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={24} className="animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center px-4">
              <Bookmark size={32} className="text-muted-foreground/40" />
              <h3 className="text-sm font-semibold text-foreground">
                {searchQuery ? 'No matching bookmarks' : 'No bookmarked articles'}
              </h3>
              <p className="text-xs text-muted-foreground max-w-xs">
                {searchQuery
                  ? 'Try a different search term.'
                  : 'Bookmark articles while reading and they will appear here.'}
              </p>
            </div>
          ) : (
            <div className="grid gap-4 grid-cols-1 min-[640px]:grid-cols-2 min-[1080px]:grid-cols-3 min-[1400px]:grid-cols-4">
              {filtered.map((article) => (
                <BookmarkedArticleCard
                  key={`${article.event.pubkey}:${article.dTag}`}
                  article={article}
                  onOpenArticle={setActiveArticle}
                  onOpenProfile={setActiveProfile}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
