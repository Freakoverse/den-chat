/**
 * LongFormArticleReader — Full reading view for a kind:30023 article
 *
 * Renders markdown body via react-markdown, featured image with Blossom integrity,
 * author info, and action buttons (edit/delete for own articles).
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useSocialStore } from '@/stores/socialStore'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { publishEventProgressive, publishToSpecificRelays } from '@/lib/nostr/relay-pool'
import { fetchEventsWide } from '@/lib/nostr/readRelays'
import { getPublishRelays } from '@/stores/postingBehaviourStore'
import { signWithSigner, createDeletionEvent } from '@/lib/nostr/events'
import { DeleteConfirmDialog, RawEventModal } from '@/components/hub/ChannelView'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { VerificationBadge } from '@/components/ui/VerificationBadge'
import { useBlossomMedia } from '@/hooks/useBlossomMedia'
import { useCachedImageUrl } from '@/lib/imageCache'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { DnnBadge } from '@/components/ui/DnnBadge'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { EmojiPickerPopover } from '@/components/chat/EmojiPickerPopover'
import { ReactionListModal, type ReactionInfo } from '@/components/social/ReactionListModal'
import { ZapModal } from '@/components/hub/ZapModal'
import { ZapListModal } from '@/components/hub/ZapListModal'
import { useZapStore } from '@/stores/zapStore'
import { parseZapReceipt, formatSats, type ZapInfo } from '@/lib/nostr/zap'
import { getEmojiMap } from '@/stores/emojiStore'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Loader2, ArrowLeft, Pencil, Trash2, Copy, Check, Clock, BookOpen, Smile, Bookmark, Zap, MoreVertical, FileCode } from 'lucide-react'
import { ArticleComments } from '@/components/social/ArticleComments'
import { cn, truncateNpub, formatTimestamp } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import { decryptNip04, encryptNip04 } from '@/lib/nostr/nip04dm'
import type { Event } from 'nostr-tools'
import { getRenderLimit } from '@/lib/imageSizeGuard'
import { ImageTooLarge } from '@/components/ui/ImageTooLarge'

/* ─── Markdown Image with Blossom Integrity ─── */

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const socialLimitMB = getRenderLimit('social')
  const blossom = useBlossomMedia(src, socialLimitMB)
  const resolvedSrc = blossom.src || src
  const cachedSrc = useCachedImageUrl(resolvedSrc)
  const [loaded, setLoaded] = useState(false)
  const [errored, setErrored] = useState(false)
  const [overridden, setOverridden] = useState(false)

  // Reset state when the underlying source changes or blossom fails over
  useEffect(() => { setLoaded(false); setErrored(false); setOverridden(false) }, [src, blossom.src])

  if (!src) return null

  // Size limit exceeded
  if (blossom.sizeExceeded && !overridden) {
    return (
      <ImageTooLarge
        url={src}
        detectedSize={blossom.detectedSize}
        onOverride={() => setOverridden(true)}
        className="my-4 rounded-lg"
      />
    )
  }

  return (
    <span className="block relative my-4 rounded-lg overflow-hidden border border-border/50">
      {/* Pulsating skeleton placeholder — visible until image loads */}
      {!loaded && !errored && (
        <span className="media-skeleton flex items-center justify-center w-full" style={{ minHeight: 200 }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/40">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </span>
      )}

      {/* Actual image — hidden until loaded, then fades in */}
      {!errored && (
        <img
          src={cachedSrc || resolvedSrc}
          alt={alt || ''}
          className={`w-full rounded-lg transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0 absolute inset-0'}`}
          loading="eager"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => { blossom.onImgError(); setErrored(true) }}
        />
      )}

      {/* Error state */}
      {errored && (
        <span className="flex items-center justify-center w-full bg-secondary/40 text-muted-foreground/50 rounded-lg" style={{ minHeight: 120 }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="9" y1="9" x2="15" y2="15" />
            <line x1="15" y1="9" x2="9" y2="15" />
          </svg>
        </span>
      )}

      {loaded && blossom.verified !== 'verified' && blossom.totalServers > 0 && (
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

/* ─── Code Block with Copy Button ─── */

function ArticleCodeBlock({ children, language }: { children: React.ReactNode; language?: string }) {
  const [copied, setCopied] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)

  const handleCopy = () => {
    const text = preRef.current?.textContent || ''
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between px-3 py-1.5 rounded-t-lg bg-secondary/60 border border-border border-b-0">
        <span className="text-[10px] text-muted-foreground/60 font-mono">{language || ''}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre ref={preRef} className="rounded-b-lg rounded-t-none bg-secondary/80 border border-border p-4 overflow-x-auto text-xs !mt-0">
        {children}
      </pre>
    </div>
  )
}

/* ─── Featured Media (video-first with image fallback) ─── */

function ArticleFeaturedMedia({ videoUrl, imageUrl, title }: { videoUrl?: string; imageUrl?: string; title: string }) {
  const socialLimitMB = getRenderLimit('social')
  const [videoFailed, setVideoFailed] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // If video stalls for 10s on initial load, treat as failed
  useEffect(() => {
    if (!videoUrl || videoFailed) return
    const el = videoRef.current
    if (!el) return

    const handleStall = () => {
      stallTimerRef.current = setTimeout(() => setVideoFailed(true), 10_000)
    }
    const clearStall = () => {
      if (stallTimerRef.current) { clearTimeout(stallTimerRef.current); stallTimerRef.current = null }
    }

    el.addEventListener('stalled', handleStall)
    el.addEventListener('playing', clearStall)
    el.addEventListener('loadeddata', clearStall)

    return () => {
      clearStall()
      el.removeEventListener('stalled', handleStall)
      el.removeEventListener('playing', clearStall)
      el.removeEventListener('loadeddata', clearStall)
    }
  }, [videoUrl, videoFailed])

  const showVideo = !!videoUrl && !videoFailed

  return (
    <div className="relative rounded-xl overflow-hidden mb-6 border border-border/50 aspect-[16/9] bg-secondary/40">
      {showVideo ? (
        <video
          ref={videoRef}
          src={videoUrl}
          controls
          preload="none"
          className="w-full h-full object-cover rounded-xl"
          onError={() => setVideoFailed(true)}
        />
      ) : imageUrl ? (
        <BlossomImage
          src={imageUrl}
          alt={title}
          className="w-full h-full"
          maxSizeMB={socialLimitMB}
        />
      ) : null}
    </div>
  )
}

/* ─── Article Reader ─── */

export function LongFormArticleReader() {
  const activeArticleNaddr = useSocialStore((s) => s.activeArticleNaddr)
  const goBack = useSocialStore((s) => s.goBack)
  const setEditingArticle = useSocialStore((s) => s.setEditingArticle)
  const myPubkey = useUserStore((s) => s.pubkey)

  const [event, setEvent] = useState<Event | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const [showRawEvent, setShowRawEvent] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const { getProfile } = useProfileCache()

  // Decode naddr and fetch article
  useEffect(() => {
    if (!activeArticleNaddr) return
    setLoading(true)
    setError(null)

    const fetchArticle = async () => {
      try {
        let decoded: nip19.AddressPointer
        try {
          const result = nip19.decode(activeArticleNaddr)
          if (result.type !== 'naddr') throw new Error('Invalid naddr')
          decoded = result.data as nip19.AddressPointer
        } catch {
          // Fallback: treat as event ID
          const events = await fetchEventsWide({ ids: [activeArticleNaddr], limit: 1 })
          if (events.length > 0) { setEvent(events[0]); return }
          throw new Error('Article not found')
        }

        const events = await fetchEventsWide({
          kinds: [decoded.kind],
          authors: [decoded.pubkey],
          '#d': [decoded.identifier],
          limit: 1,
        })

        if (events.length === 0) throw new Error('Article not found')

        // Take the newest version (highest created_at)
        const sorted = events.sort((a, b) => b.created_at - a.created_at)
        setEvent(sorted[0])
      } catch (err: any) {
        setError(err.message || 'Failed to load article')
      } finally {
        setLoading(false)
      }
    }

    fetchArticle()
  }, [activeArticleNaddr])

  // Extract metadata from event
  const meta = useMemo(() => {
    if (!event) return null
    const tags = event.tags
    const title = tags.find(t => t[0] === 'title')?.[1] || 'Untitled'
    const summary = tags.find(t => t[0] === 'summary')?.[1] || ''
    const image = tags.find(t => t[0] === 'image')?.[1] || ''
    const videoUrl = tags.find(t => t[0] === 'video')?.[1] || ''
    const publishedAtStr = tags.find(t => t[0] === 'published_at')?.[1]
    const publishedAt = publishedAtStr ? parseInt(publishedAtStr, 10) : event.created_at
    const articleTags = tags.filter(t => t[0] === 't').map(t => t[1])
    const wordCount = event.content.split(/\s+/).filter(Boolean).length
    const readingTime = Math.max(1, Math.ceil(wordCount / 230))
    const isOwn = event.pubkey === myPubkey

    return { title, summary, image, videoUrl, publishedAt, articleTags, wordCount, readingTime, isOwn }
  }, [event, myPubkey])

  const profile = event ? getProfile(event.pubkey) : null
  const displayName = profile?.display_name || profile?.name || (event ? truncateNpub(nip19.npubEncode(event.pubkey), 8) : '')

  const handleCopyNaddr = useCallback(() => {
    if (!activeArticleNaddr) return
    navigator.clipboard.writeText(`nostr:${activeArticleNaddr}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [activeArticleNaddr])

  const handleDeleteConfirm = useCallback(async () => {
    if (!event || !myPubkey) return
    const { signer, privateKey } = useUserStore.getState()

    const dTag = event.tags.find(t => t[0] === 'd')?.[1] || ''
    const aRef = `30023:${myPubkey}:${dTag}`
    const publishRelays = getPublishRelays()

    // Step 1: Re-publish with 'deleted' tag — relay replaces the original
    const deletedEvent = {
      kind: 30023,
      pubkey: myPubkey,
      created_at: event.created_at + 1,
      tags: [['d', dTag], ['deleted', 'true']],
      content: '',
    }
    const signedDeleted = await signWithSigner(deletedEvent, signer, privateKey)
    await publishEventProgressive(signedDeleted, () => {}, publishRelays)

    // Step 2: NIP-09 deletion request as fallback
    const deletionEvent = createDeletionEvent([], [aRef], 'User requested deletion')
    const signedDeletion = await signWithSigner(deletionEvent, signer, privateKey)
    await publishEventProgressive(signedDeletion, () => {}, publishRelays)

    setShowDeleteModal(false)
    goBack()
  }, [event, myPubkey, goBack])

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
        <p className="text-sm text-destructive">{error || 'Article not found'}</p>
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
          Back
        </button>

        {/* 3-dot dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setShowDropdown(!showDropdown)}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
          >
            <MoreVertical size={18} />
          </button>

          {showDropdown && (
            <>
              {/* Backdrop */}
              <div className="fixed inset-0 z-40" onClick={() => setShowDropdown(false)} />
              {/* Menu */}
              <div className="absolute right-0 top-full mt-1 z-50 w-48 rounded-md border border-border bg-popover shadow-lg p-1 flex flex-col gap-1 animate-in fade-in-0 zoom-in-95">
                {/* Copy Event Address */}
                <button
                  onClick={() => { handleCopyNaddr(); setShowDropdown(false) }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 transition-colors cursor-pointer rounded-md"
                >
                  {copied ? <Check size={14} className="text-emerald-400 shrink-0" /> : <Copy size={14} className="shrink-0" />}
                  {copied ? 'Copied!' : 'Copy Event Address'}
                </button>

                {/* View Raw Event */}
                <button
                  onClick={() => { setShowRawEvent(true); setShowDropdown(false) }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 transition-colors cursor-pointer rounded-md"
                >
                  <FileCode size={14} className="shrink-0" />
                  View Raw Event
                </button>

                {meta.isOwn && (
                  <>
                    <div className="h-px bg-border mx-2" />

                    {/* Edit */}
                    <button
                      onClick={() => { activeArticleNaddr && setEditingArticle(activeArticleNaddr); setShowDropdown(false) }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 transition-colors cursor-pointer rounded-md"
                    >
                      <Pencil size={14} className="shrink-0" />
                      Edit
                    </button>

                    {/* Request Delete */}
                    <button
                      onClick={() => { setShowDeleteModal(true); setShowDropdown(false) }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer rounded-md"
                    >
                      <Trash2 size={14} className="shrink-0" />
                      Request Delete
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Article content */}
      <div className="flex-1 overflow-y-auto">
        <article className="w-full mx-auto py-6 px-6 max-[1080px]:px-4" style={{ maxWidth: 720 }}>
          {/* Featured media — video takes priority, image as fallback */}
          {(meta.videoUrl || meta.image) && (
            <ArticleFeaturedMedia
              videoUrl={meta.videoUrl}
              imageUrl={meta.image}
              title={meta.title}
            />
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
                  {formatTimestamp(meta.publishedAt)}
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
                pre: ({ node, children }) => {
                  // Extract language from the code child in the AST
                  const codeNode = (node?.children as any[])?.find((c: any) => c.tagName === 'code')
                  const langClass = codeNode?.properties?.className?.[0] || ''
                  const language = langClass.replace('language-', '')
                  return <ArticleCodeBlock language={language}>{children}</ArticleCodeBlock>
                },
                code: ({ children, className }) => {
                  const isInline = !className
                  if (isInline) {
                    return <code className="px-1.5 py-0.5 rounded bg-secondary text-primary text-[12px] font-mono">{children}</code>
                  }
                  return <code className={cn("text-[12px] font-mono", className)}>{children}</code>
                },
                blockquote: ({ children }) => (
                  <blockquote className="border-l-3 border-primary/40 pl-4 py-1 text-foreground/70 italic my-4">
                    {children}
                  </blockquote>
                ),
                h1: ({ children }) => <h1 className="text-xl font-bold text-foreground mt-8 mb-3">{children}</h1>,
                h2: ({ children }) => <h2 className="text-lg font-bold text-foreground mt-6 mb-2.5">{children}</h2>,
                h3: ({ children }) => <h3 className="text-base font-semibold text-foreground mt-5 mb-2">{children}</h3>,
                h4: ({ children }) => <h4 className="text-sm font-semibold text-foreground mt-4 mb-1.5">{children}</h4>,
                p: ({ children }) => <p className="text-sm leading-relaxed text-foreground/90 mb-4">{children}</p>,
                ul: ({ children }) => <ul className="list-disc list-outside pl-5 text-sm text-foreground/90 mb-4 space-y-1">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal list-outside pl-5 text-sm text-foreground/90 mb-4 space-y-1">{children}</ol>,
                table: ({ children }) => (
                  <div className="overflow-x-auto my-4 rounded-lg border border-border">
                    <table className="w-full text-xs">{children}</table>
                  </div>
                ),
                th: ({ children }) => <th className="px-3 py-2 bg-secondary text-left text-xs font-semibold text-foreground border-b border-border">{children}</th>,
                td: ({ children }) => <td className="px-3 py-2 text-xs text-foreground/80 border-b border-border/50">{children}</td>,
                hr: () => <hr className="my-6 border-border/50" />,
              }}
            >
              {event.content}
            </ReactMarkdown>
          </div>

          {/* Interaction bar (react, zap, bookmark) */}
          <ArticleInteractionBar event={event} />

          {/* Tags */}
          {meta.articleTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-4 mb-2">
              {meta.articleTags.map(tag => (
                <span key={tag} className="px-2.5 py-0.5 rounded-full bg-primary/10 text-primary text-[11px] font-medium">
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Comments section (NIP-22 kind:1111) */}
          <ArticleComments articleEvent={event} />
        </article>
      </div>

      {/* Delete confirmation modal */}
      {showDeleteModal && (
        <DeleteConfirmDialog
          onCancel={() => setShowDeleteModal(false)}
          onConfirm={handleDeleteConfirm}
          title="Request Delete"
          description="This will send a deletion request to the relays. The article will be replaced with a deleted version and a NIP-09 deletion event will be published. Some relays may not honor the request."
          progressSteps={[
            'Replacing article with deleted version...',
            'Publishing deletion request...',
            'Notifying relays...',
          ]}
          confirmLabel="Yes, Request Delete"
        />
      )}

      {/* Raw Event modal */}
      {showRawEvent && event && (
        <RawEventModal
          rawJson={JSON.stringify(event)}
          decryptedContent=""
          isDecrypted={false}
          onClose={() => setShowRawEvent(false)}
          hideDecryptedTab
        />
      )}
    </div>
  )
}

/* ─── Article Interaction Bar ─── */

const ARTICLE_ZAP_NS = '__article__'

function ArticleInteractionBar({ event }: { event: Event }) {
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const [liked, setLiked] = useState(false)
  const [reactions, setReactions] = useState<ReactionInfo[]>([])
  const [showReactionList, setShowReactionList] = useState(false)
  const [showReactionPicker, setShowReactionPicker] = useState(false)
  const [reactionEmoji, setReactionEmoji] = useState<string | null>(null)
  const [reactionCustomUrl, setReactionCustomUrl] = useState<string | null>(null)
  const [likeLoading, setLikeLoading] = useState(false)

  const [bookmarked, setBookmarked] = useState(false)
  const [bookmarkLoading, setBookmarkLoading] = useState(false)

  const [showZapModal, setShowZapModal] = useState(false)
  const [showZapList, setShowZapList] = useState(false)

  const reactionBtnRef = useRef<HTMLButtonElement>(null)

  // Fetch reactions
  useEffect(() => {
    fetchEventsWide({ kinds: [7], '#e': [event.id], limit: 100 }).then((rawReactions) => {
      const parsed: ReactionInfo[] = rawReactions.map((r) => {
        const emojiTag = r.tags.find((t) => t[0] === 'emoji')
        let emoji = r.content || '+'
        let emojiUrl: string | undefined
        if (emojiTag && emojiTag[1] && emojiTag[2]) {
          emoji = `:${emojiTag[1]}:`
          emojiUrl = emojiTag[2]
        }
        return {
          eventId: r.id,
          pubkey: r.pubkey,
          emoji,
          emojiUrl,
          createdAt: r.created_at,
        }
      })
      setReactions(parsed)

      if (!myPubkey) return
      const myReaction = parsed.find((r) => r.pubkey === myPubkey)
      if (myReaction) {
        setLiked(true)
        const displayEmoji = myReaction.emoji === '+' ? '❤️' : myReaction.emoji
        setReactionEmoji(displayEmoji)
        if (myReaction.emojiUrl) setReactionCustomUrl(myReaction.emojiUrl)
      }
    })
  }, [event.id, myPubkey])

  // Fetch zaps
  const zaps = useZapStore((s) => s.zaps[ARTICLE_ZAP_NS]?.[event.id]) || []
  const zapTotal = zaps.reduce((sum: number, z: ZapInfo) => sum + z.amount, 0)

  useEffect(() => {
    fetchEventsWide({ kinds: [9735], '#e': [event.id], limit: 50 }).then((receipts) => {
      const zapStore = useZapStore.getState()
      for (const receipt of receipts) {
        if (!zapStore.markZapProcessed(receipt.id)) continue
        const zapInfo = parseZapReceipt(receipt)
        if (zapInfo) zapStore.addZap(ARTICLE_ZAP_NS, event.id, zapInfo)
      }
    })
  }, [event.id])

  // Check bookmark state
  useEffect(() => {
    if (!myPubkey) return
    fetchEventsWide({ kinds: [10003], authors: [myPubkey], limit: 1 }).then(async (events) => {
      if (events.length === 0) return
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
      if (latest.content) {
        try {
          const decrypted = await decryptNip04(latest.content, myPubkey, signer, privateKey)
          if (!decrypted) return
          const privateTags: string[][] = JSON.parse(decrypted)
          setBookmarked(privateTags.some(t => t[0] === 'e' && t[1] === event.id))
        } catch {
          setBookmarked(latest.tags.some(t => t[0] === 'e' && t[1] === event.id))
        }
      } else {
        setBookmarked(latest.tags.some(t => t[0] === 'e' && t[1] === event.id))
      }
    })
  }, [myPubkey, event.id])

  const handleEmojiReact = useCallback(async (emoji: string) => {
    if (!myPubkey || (!signer && !privateKey) || liked) return
    setLikeLoading(true)
    try {
      const tags: [string, ...string[]][] = [['e', event.id], ['p', event.pubkey]]
      const scMatch = emoji.match(/^:([a-zA-Z0-9_-]+):$/)
      if (scMatch) {
        const entry = getEmojiMap().get(scMatch[1])
        if (entry) tags.push(['emoji', scMatch[1], entry.url])
      }
      const unsigned = {
        kind: 7,
        pubkey: myPubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: emoji,
      }
      const signed = await signWithSigner(unsigned, signer, privateKey)
      await publishToSpecificRelays(getPublishRelays(), signed)
      setLiked(true)
      setReactionEmoji(emoji)
      setReactions(prev => [...prev, {
        eventId: signed.id,
        pubkey: myPubkey,
        emoji,
        createdAt: Math.floor(Date.now() / 1000),
      }])
      const scMatch2 = emoji.match(/^:([a-zA-Z0-9_-]+):$/)
      if (scMatch2) {
        const entry2 = getEmojiMap().get(scMatch2[1])
        if (entry2) setReactionCustomUrl(entry2.url)
      }
    } catch (err) {
      console.error('[ArticleReader] Failed to react:', err)
    } finally {
      setLikeLoading(false)
    }
  }, [event, myPubkey, signer, privateKey, liked])

  const handleBookmark = useCallback(async () => {
    if (!myPubkey || (!signer && !privateKey)) return
    setBookmarkLoading(true)
    try {
      const existing = await fetchEventsWide({ kinds: [10003], authors: [myPubkey], limit: 1 })
      const latest = existing.sort((a, b) => b.created_at - a.created_at)[0]

      let tags: string[][] = []
      if (latest?.content) {
        try {
          const decrypted = await decryptNip04(latest.content, myPubkey, signer, privateKey)
          tags = (JSON.parse(decrypted) as string[][]).filter(t => t[0] === 'e')
        } catch {
          tags = latest?.tags.filter(t => t[0] === 'e') || []
        }
      } else {
        tags = latest?.tags.filter(t => t[0] === 'e') || []
      }

      if (bookmarked) {
        tags = tags.filter(t => t[1] !== event.id)
      } else {
        if (!tags.some(t => t[1] === event.id)) tags.push(['e', event.id])
      }

      const encrypted = await encryptNip04(JSON.stringify(tags), myPubkey, signer, privateKey)

      const unsigned = {
        kind: 10003,
        pubkey: myPubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [] as string[][],
        content: encrypted,
      }
      const signed = await signWithSigner(unsigned, signer, privateKey)
      await publishToSpecificRelays(getPublishRelays(), signed)
      setBookmarked(!bookmarked)
    } catch (err) {
      console.error('[ArticleReader] Failed to toggle bookmark:', err)
    } finally {
      setBookmarkLoading(false)
    }
  }, [event, myPubkey, signer, privateKey, bookmarked])

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center gap-4 mt-6 mb-2 pt-4 pb-3 border-t border-b border-border/40">
        {/* Emoji react */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              ref={reactionBtnRef}
              onClick={() => { if (!liked) setShowReactionPicker(!showReactionPicker) }}
              className={cn(
                'flex items-center gap-1.5 p-2 rounded-full transition-colors cursor-pointer hover:bg-accent/50',
                liked ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {likeLoading ? (
                <Loader2 size={18} className="animate-spin" />
              ) : reactionEmoji ? (
                <span className="text-base leading-none">{(() => {
                  if (reactionCustomUrl) return <img src={reactionCustomUrl} alt={reactionEmoji} className="h-[18px] w-[18px] object-contain inline" />
                  const scMatch = reactionEmoji.match(/^:([a-zA-Z0-9_-]+):$/)
                  if (scMatch) {
                    const entry = getEmojiMap().get(scMatch[1])
                    if (entry) return <img src={entry.url} alt={reactionEmoji} className="h-[18px] w-[18px] object-contain inline" />
                  }
                  return reactionEmoji
                })()}</span>
              ) : (
                <Smile size={18} />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">React</TooltipContent>
        </Tooltip>

        {/* Reaction count badge */}
        {reactions.length > 0 && (
          <button
            onClick={() => setShowReactionList(true)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs cursor-pointer transition-colors border bg-primary/10 border-primary/30 text-primary hover:bg-primary/20"
          >
            <Smile size={12} />
            <span className="font-semibold">{reactions.length}</span>
          </button>
        )}

        {showReactionPicker && (
          <EmojiPickerPopover
            anchorRef={reactionBtnRef}
            onClose={() => setShowReactionPicker(false)}
            onSelect={(emoji) => {
              setShowReactionPicker(false)
              handleEmojiReact(emoji)
            }}
          />
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Zap total badge */}
        {zaps.length > 0 && (
          <button
            onClick={() => setShowZapList(true)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs cursor-pointer transition-colors border bg-yellow-400/10 border-yellow-400/30 text-yellow-400 hover:bg-yellow-400/20"
          >
            <Zap size={12} fill="currentColor" />
            <span className="font-semibold">{formatSats(zapTotal)}</span>
            {zaps.length > 1 && (
              <span className="text-yellow-400/60">({zaps.length})</span>
            )}
          </button>
        )}

        {/* Zap button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setShowZapModal(true)}
              className="flex items-center gap-1 p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
            >
              <Zap size={18} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">Zap</TooltipContent>
        </Tooltip>

        {/* Bookmark button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleBookmark}
              className={cn(
                'flex items-center gap-1 p-2 rounded-full transition-colors cursor-pointer hover:bg-accent/50',
                bookmarked ? 'text-yellow-500' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {bookmarkLoading ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <Bookmark size={18} className={bookmarked ? 'fill-current' : ''} />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">{bookmarked ? 'Remove Bookmark' : 'Bookmark'}</TooltipContent>
        </Tooltip>
      </div>

      {/* Reaction List Modal */}
      {showReactionList && (
        <ReactionListModal
          open={showReactionList}
          onClose={() => setShowReactionList(false)}
          reactions={reactions}
        />
      )}

      {/* Zap Modal */}
      <ZapModal
        open={showZapModal}
        onClose={() => setShowZapModal(false)}
        recipientPubkey={event.pubkey}
        messageEventId={event.id}
        messageKind={30023}
        disableSplit
        storeNamespace={ARTICLE_ZAP_NS}
      />

      {/* Zap List Modal */}
      {showZapList && (
        <ZapListModal
          open={showZapList}
          onClose={() => setShowZapList(false)}
          zaps={zaps}
        />
      )}
    </TooltipProvider>
  )
}
