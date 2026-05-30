/**
 * LongFormFeedPage — Feed of kind:30023 articles from followed users
 *
 * Fetches long-form articles, displays as cards sorted by published_at
 * (boomerang sort), with Blossom media integrity for featured images.
 *
 * Pagination: show 12 at a time, pre-fetch next 12 in background.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSocialStore } from '@/stores/socialStore'
import { useFollowStore } from '@/stores/followStore'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Loader2, Newspaper, RefreshCw, Search, ChevronDown } from 'lucide-react'
import { truncateNpub, formatTimestamp } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import type { Event } from 'nostr-tools'

const PAGE_SIZE = 12

/* ─── Types ─── */

export interface ArticleCard {
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

export function parseArticle(event: Event): ArticleCard {
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

/* ─── Helper: deduplicate + filter deleted articles ─── */

export function dedupeAndFilter(events: Event[]): ArticleCard[] {
  const coordMap = new Map<string, Event>()
  for (const ev of events) {
    const d = ev.tags.find(t => t[0] === 'd')?.[1] || ''
    const coord = `${ev.pubkey}:${d}`
    const existing = coordMap.get(coord)
    if (!existing || ev.created_at > existing.created_at) {
      coordMap.set(coord, ev)
    }
  }

  const alive = Array.from(coordMap.values()).filter(ev => {
    if (ev.tags.some(t => t[0] === 'deleted')) return false
    if (ev.content === '' && ev.tags.length <= 2) return false
    return true
  })

  return alive.map(parseArticle).sort((a, b) => b.event.created_at - a.event.created_at)
}

/* ─── Article Card Component ─── */

export function ArticleCardItem({ article, onOpenArticle, onOpenProfile }: {
  article: ArticleCard
  onOpenArticle: (naddr: string) => void
  onOpenProfile: (pubkey: string) => void
}) {
  const { getProfile } = useProfileCache()
  const profile = getProfile(article.event.pubkey)
  const npub = nip19.npubEncode(article.event.pubkey)
  const displayName = profile?.display_name || profile?.name || truncateNpub(npub, 8)
  const readingTime = Math.max(1, Math.ceil(article.wordCount / 230))

  // Build naddr for navigation
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
      {/* Featured image — flush to card top, 16:9 aspect ratio */}
      {article.image && /^https?:\/\//.test(article.image) ? (
        <BlossomImage
          src={article.image}
          alt={article.title}
          className="w-full aspect-video shrink-0"
          imgClassName="group-hover:scale-[1.02] transition-transform duration-300"
          fallback={
            <div className="w-full aspect-video shrink-0 bg-secondary/80 flex items-center justify-center">
              <img src="/app-icon.png" alt="" className="w-16 h-16 object-contain opacity-40" />
            </div>
          }
        />
      ) : (
        <div className="w-full aspect-video shrink-0 bg-secondary/80 flex items-center justify-center">
          <img src="/app-icon.png" alt="" className="w-16 h-16 object-contain opacity-40" />
        </div>
      )}

      {/* Content — fills remaining height */}
      <div className="p-4 flex flex-col flex-1 min-h-0">
        {/* Title */}
        <h3 className="text-sm font-semibold text-foreground line-clamp-2 leading-snug group-hover:text-primary transition-colors">
          {article.title}
        </h3>

        {/* Summary */}
        {article.summary && (
          <p className="text-xs text-muted-foreground line-clamp-3 leading-relaxed mt-1.5">
            {article.summary}
          </p>
        )}

        {/* Footer — pushed to bottom */}
        <div className="mt-auto pt-3">
          <div className="border-t border-border/40 pt-2.5 space-y-1.5">
            {/* Author */}
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
            {/* Date + reading time */}
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

/* ─── Feed Page ─── */

export function LongFormFeedPage() {
  const follows = useFollowStore((s) => s.followedPubkeys)
  const followsLoaded = useFollowStore((s) => s.loaded)
  const pubkey = useUserStore((s) => s.pubkey)
  const setActiveArticle = useSocialStore((s) => s.setActiveArticle)
  const setActiveProfile = useSocialStore((s) => s.setActiveProfile)

  // All fetched articles (raw events, deduped+filtered)
  const [allArticles, setAllArticles] = useState<ArticleCard[]>([])
  // How many to show (increments by PAGE_SIZE on "Load More")
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  // Background buffer: articles fetched but not yet shown
  const [buffer, setBuffer] = useState<ArticleCard[]>([])

  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [hasMore, setHasMore] = useState(true)
  const loadedRef = useRef(false)
  const authorsRef = useRef<string[]>([])

  // Build author list
  useEffect(() => {
    const authorSet = new Set(follows)
    if (pubkey) authorSet.add(pubkey)
    authorsRef.current = Array.from(authorSet).slice(0, 500)
  }, [follows, pubkey])

  // Fetch a batch of articles older than `until`, returns parsed+deduped results
  const fetchBatch = useCallback(async (limit: number, until?: number): Promise<ArticleCard[]> => {
    const authors = authorsRef.current
    if (authors.length === 0) return []

    const filter: any = { kinds: [30023], authors, limit }
    if (until) filter.until = until

    const events = await fetchEvents(filter)
    return dedupeAndFilter(events)
  }, [])

  // Initial load: fetch 24, show 12, buffer 12
  const loadArticles = useCallback(async () => {
    setLoading(true)
    setError(null)
    setAllArticles([])
    setBuffer([])
    setVisibleCount(PAGE_SIZE)
    setHasMore(true)
    try {
      const batch = await fetchBatch(PAGE_SIZE * 2)
      const visible = batch.slice(0, PAGE_SIZE)
      const buffered = batch.slice(PAGE_SIZE)
      setAllArticles(visible)
      setBuffer(buffered)
      if (batch.length < PAGE_SIZE * 2) setHasMore(false)
    } catch (err) {
      console.error('[LongForm] Failed to fetch articles:', err)
      setError('Failed to load articles')
    } finally {
      setLoading(false)
    }
  }, [fetchBatch])

  // Prefetch the next batch in the background
  const prefetchNext = useCallback(async (currentArticles: ArticleCard[]) => {
    if (currentArticles.length === 0) return
    const oldest = currentArticles[currentArticles.length - 1]
    const until = oldest.event.created_at
    try {
      const batch = await fetchBatch(PAGE_SIZE, until)
      // Filter out articles we already have (by coord)
      const existingCoords = new Set(currentArticles.map(a => `${a.event.pubkey}:${a.dTag}`))
      const fresh = batch.filter(a => !existingCoords.has(`${a.event.pubkey}:${a.dTag}`))
      setBuffer(fresh)
      if (fresh.length === 0) setHasMore(false)
    } catch {
      // Silent fail — prefetch is best-effort
    }
  }, [fetchBatch])

  // Load More: merge buffer into visible, then prefetch next batch
  const handleLoadMore = useCallback(async () => {
    if (buffer.length === 0) return
    setLoadingMore(true)

    // Merge buffer into visible articles
    const merged = [...allArticles, ...buffer]
    setAllArticles(merged)
    setBuffer([])

    // Prefetch next batch in background
    await prefetchNext(merged)
    setLoadingMore(false)
  }, [allArticles, buffer, prefetchNext])

  useEffect(() => {
    if (!followsLoaded || loadedRef.current) return
    loadedRef.current = true
    loadArticles()
  }, [followsLoaded, loadArticles])

  // Filtered articles (search)
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return allArticles
    const q = searchQuery.toLowerCase()
    return allArticles.filter(a =>
      a.title.toLowerCase().includes(q) ||
      a.summary.toLowerCase().includes(q) ||
      a.tags.some(t => t.toLowerCase().includes(q))
    )
  }, [allArticles, searchQuery])

  const showLoadMore = hasMore && (buffer.length > 0 || loadingMore) && !searchQuery.trim()

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-12 min-h-12 border-b border-border shrink-0">
        <span className="font-semibold text-sm text-foreground">Long Form — Feed</span>
        <button onClick={() => { loadedRef.current = false; loadArticles() }} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer">
          <RefreshCw size={16} />
        </button>
      </div>

      {/* Search bar */}
      <div className="px-4 py-3 border-b border-border/50 shrink-0">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/60 border border-border focus-within:border-primary/40 transition-colors">
          <Search size={14} className="text-muted-foreground shrink-0" />
          <input
            type="text"
            placeholder="Search articles..."
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
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <p className="text-sm text-destructive">{error}</p>
              <button onClick={() => { loadedRef.current = false; loadArticles() }} className="text-xs text-primary hover:underline cursor-pointer">
                Try again
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center px-4">
              <Newspaper size={32} className="text-muted-foreground/40" />
              <h3 className="text-sm font-semibold text-foreground">
                {searchQuery ? 'No matching articles' : 'No articles yet'}
              </h3>
              <p className="text-xs text-muted-foreground max-w-xs">
                {searchQuery
                  ? 'Try a different search term.'
                  : 'Articles from people you follow will appear here.'}
              </p>
            </div>
          ) : (
            <>
              <div className="grid gap-4 grid-cols-1 min-[640px]:grid-cols-2 min-[1080px]:grid-cols-3 min-[1400px]:grid-cols-4">
                {filtered.map((article) => (
                  <ArticleCardItem
                    key={`${article.event.pubkey}:${article.dTag}`}
                    article={article}
                    onOpenArticle={setActiveArticle}
                    onOpenProfile={setActiveProfile}
                  />
                ))}
              </div>

              {/* Load More */}
              {showLoadMore && (
                <div className="flex justify-center py-6">
                  <button
                    onClick={handleLoadMore}
                    disabled={loadingMore || buffer.length === 0}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-xs font-medium border border-border text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loadingMore ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <ChevronDown size={14} />
                    )}
                    {loadingMore ? 'Loading...' : `Load More (${buffer.length})`}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
