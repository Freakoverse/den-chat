/**
 * DraftPreviewPage — Read-only preview of a kind:30024 draft
 *
 * Shows the draft rendered as a full article with a "Back to Drafts" button
 * and an "Edit Draft" button in the header. No interaction bar (no reactions,
 * bookmarks, or comments since it's an unpublished draft).
 */

import { useState, useEffect, useMemo } from 'react'
import { useSocialStore } from '@/stores/socialStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { useBlossomMedia } from '@/hooks/useBlossomMedia'
import { VerificationBadge } from '@/components/ui/VerificationBadge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { DnnBadge } from '@/components/ui/DnnBadge'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Loader2, ArrowLeft, Pencil, Clock, BookOpen } from 'lucide-react'
import { cn, truncateNpub, formatTimestamp } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import type { Event } from 'nostr-tools'

/* ─── Markdown Image with Blossom Integrity ─── */

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const blossom = useBlossomMedia(src)

  if (!src) return null

  const resolvedSrc = blossom.src || src

  return (
    <span className="block relative my-4 rounded-lg overflow-hidden border border-border/50">
      <img
        src={resolvedSrc}
        alt={alt || ''}
        className="w-full rounded-lg"
        loading="lazy"
      />
      {blossom.verified !== 'verified' && blossom.totalServers > 0 && (
        <VerificationBadge
          verified={blossom.verified}
          expectedHash={blossom.expectedHash}
          servers={blossom.servers}
          ext={blossom.ext}
          onRecovered={blossom.acceptVerifiedUrl}
          position="top-right"
        />
      )}
    </span>
  )
}

/* ─── Draft Preview ─── */

export function DraftPreviewPage() {
  const previewDraftNaddr = useSocialStore((s) => s.previewDraftNaddr)
  const goBack = useSocialStore((s) => s.goBack)
  const setEditingArticle = useSocialStore((s) => s.setEditingArticle)

  const [event, setEvent] = useState<Event | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)


  const { getProfile } = useProfileCache()

  // Decode naddr and fetch draft
  useEffect(() => {
    if (!previewDraftNaddr) return
    setLoading(true)
    setError(null)

    const fetchDraft = async () => {
      try {
        const result = nip19.decode(previewDraftNaddr)
        if (result.type !== 'naddr') throw new Error('Invalid naddr')
        const decoded = result.data as nip19.AddressPointer

        const events = await fetchEvents({
          kinds: [decoded.kind],
          authors: [decoded.pubkey],
          '#d': [decoded.identifier],
          limit: 1,
        })

        if (events.length === 0) throw new Error('Draft not found')

        const sorted = events.sort((a, b) => b.created_at - a.created_at)
        setEvent(sorted[0])
      } catch (err: any) {
        setError(err.message || 'Failed to load draft')
      } finally {
        setLoading(false)
      }
    }

    fetchDraft()
  }, [previewDraftNaddr])

  // Extract metadata from event
  const meta = useMemo(() => {
    if (!event) return null
    const tags = event.tags
    const title = tags.find(t => t[0] === 'title')?.[1] || 'Untitled Draft'
    const summary = tags.find(t => t[0] === 'summary')?.[1] || ''
    const image = tags.find(t => t[0] === 'image')?.[1] || ''
    const videoUrl = tags.find(t => t[0] === 'video')?.[1] || ''
    const publishedAtStr = tags.find(t => t[0] === 'published_at')?.[1]
    const publishedAt = publishedAtStr ? parseInt(publishedAtStr, 10) : event.created_at
    const articleTags = tags.filter(t => t[0] === 't').map(t => t[1])
    const wordCount = event.content.split(/\s+/).filter(Boolean).length
    const readingTime = Math.max(1, Math.ceil(wordCount / 230))

    return { title, summary, image, videoUrl, publishedAt, articleTags, wordCount, readingTime }
  }, [event])

  const profile = event ? getProfile(event.pubkey) : null
  const displayName = profile?.display_name || profile?.name || (event ? truncateNpub(nip19.npubEncode(event.pubkey), 8) : '')

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={24} className="animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error || !event || !meta) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4">
        <p className="text-sm text-destructive">{error || 'Draft not found'}</p>
        <button onClick={goBack} className="text-xs text-primary hover:underline cursor-pointer">
          Go back
        </button>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-12 min-h-12 border-b border-border shrink-0">
        <button onClick={goBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
          <ArrowLeft size={16} />
          Back to Drafts
        </button>
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 text-[10px] font-medium">Draft</span>
          <button
            onClick={() => previewDraftNaddr && setEditingArticle(previewDraftNaddr)}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
          >
            <Pencil size={13} />
            Edit Draft
          </button>
        </div>
      </div>

      {/* Article content */}
      <div className="flex-1 overflow-y-auto">
        <article className="w-full mx-auto py-6 px-6 max-[1080px]:px-4" style={{ maxWidth: 720 }}>
          {/* Featured media */}
          {(meta.videoUrl || meta.image) && (
            <div className="relative rounded-xl overflow-hidden mb-6 border border-border/50 aspect-[16/9] bg-secondary/40">
              {meta.videoUrl ? (
                <video
                  src={meta.videoUrl}
                  controls
                  preload="none"
                  className="w-full h-full object-cover rounded-xl"
                />
              ) : meta.image ? (
                <BlossomImage
                  src={meta.image}
                  alt={meta.title}
                  className="w-full h-full"
                />
              ) : null}
            </div>
          )}

          {/* Tags */}
          {meta.articleTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {meta.articleTags.map(tag => (
                <span key={tag} className="px-2.5 py-0.5 rounded-full bg-primary/10 text-primary text-[11px] font-medium">
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Title */}
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground leading-tight mb-4">
            {meta.title}
          </h1>

          {/* Author row */}
          <div className="flex items-center gap-3 mb-6 pb-6 border-b border-border/50">
            <Avatar className="w-10 h-10 shrink-0">
              {profile?.picture && <AvatarImage src={profile.picture} />}
              <AvatarFallback className="text-sm bg-primary/20 text-primary">
                {displayName.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground truncate">{displayName}</span>
                <DnnBadge pubkey={event.pubkey} />
              </div>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Clock size={11} />
                  Last saved {formatTimestamp(meta.publishedAt)}
                </span>
                <span>·</span>
                <span className="flex items-center gap-1">
                  <BookOpen size={11} />
                  {meta.readingTime} min read
                </span>
                <span>·</span>
                <span>{meta.wordCount.toLocaleString()} words</span>
              </div>
            </div>
          </div>

          {/* Summary */}
          {meta.summary && (
            <div className="mb-6 px-4 py-3 rounded-r-lg bg-secondary/40 border-l-3 border-primary/40">
              <p className="text-sm text-foreground/80 italic leading-relaxed">{meta.summary}</p>
            </div>
          )}

          {/* Markdown body */}
          <div className="prose prose-sm dark:prose-invert max-w-none article-body">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                    {children}
                  </a>
                ),
                pre: ({ children }) => (
                  <pre className="rounded-lg bg-secondary/80 border border-border p-4 overflow-x-auto text-xs">
                    {children}
                  </pre>
                ),
                code: ({ children, className }) => {
                  const isInline = !className
                  if (isInline) {
                    return <code className="px-1.5 py-0.5 rounded bg-secondary text-primary text-[12px] font-mono">{children}</code>
                  }
                  return <code className={cn("text-[12px] font-mono", className)}>{children}</code>
                },
              }}
            >
              {event.content}
            </ReactMarkdown>
          </div>
        </article>
      </div>
    </div>
  )
}
