/**
 * ArticleComments — NIP-22 comment section for kind:30023 articles
 *
 * Design: Flat top-level comments on the article page. Clicking "Reply" opens
 * a modal showing that comment + its direct replies + a compose box.
 * Clicking reply on a nested comment drills deeper (modal swaps view),
 * with a back button to navigate up.
 *
 * Tag structure follows NIP-22 (see previous implementation for full spec).
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { useComposeSettings, ComposeSettingsPanel, ComposeSettingsButton } from '@/components/social/ComposeSettings'
import { EmojiPickerPopover } from '@/components/chat/EmojiPickerPopover'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { DnnBadge } from '@/components/ui/DnnBadge'
import {
  MessageSquare, Send, Smile, Loader2, ArrowLeft, CornerDownRight, X, MessageCircle
} from 'lucide-react'
import { cn, truncateNpub, formatTimestamp } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import type { Event } from 'nostr-tools'

/* ─── Types ─── */

interface ArticleCommentsProps {
  articleEvent: Event
}

/* ─── Main Component ─── */

export function ArticleComments({ articleEvent }: ArticleCommentsProps) {
  const [comments, setComments] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [modalStack, setModalStack] = useState<Event[]>([])

  const pubkey = useUserStore((s) => s.pubkey)

  // Build the article's addressable coordinate
  const dTag = articleEvent.tags.find(t => t[0] === 'd')?.[1] || ''
  const aCoordinate = `30023:${articleEvent.pubkey}:${dTag}`

  // Fetch comments
  useEffect(() => {
    setLoading(true)
    fetchEvents({
      kinds: [1111],
      '#A': [aCoordinate],
      limit: 200,
    }).then(events => {
      setComments(events.sort((a, b) => a.created_at - b.created_at))
    }).catch(err => {
      console.error('[ArticleComments] Fetch failed:', err)
    }).finally(() => setLoading(false))
  }, [aCoordinate])

  // Separate top-level vs replies
  const { topLevel, replyMap, replyCountMap } = useMemo(() => {
    const top: Event[] = []
    const replies = new Map<string, Event[]>()
    const counts = new Map<string, number>()

    // First pass: identify direct parent for each comment
    for (const c of comments) {
      const parentId = c.tags.find(t => t[0] === 'e')?.[1]
      if (parentId) {
        const arr = replies.get(parentId) || []
        arr.push(c)
        replies.set(parentId, arr)
      } else {
        top.push(c)
      }
    }

    // Count all descendants (recursive)
    const countDescendants = (id: string): number => {
      const direct = replies.get(id) || []
      let total = direct.length
      for (const r of direct) total += countDescendants(r.id)
      return total
    }
    for (const c of comments) {
      counts.set(c.id, countDescendants(c.id))
    }

    return { topLevel: top, replyMap: replies, replyCountMap: counts }
  }, [comments])

  const handleCommentPosted = useCallback((newComment: Event) => {
    setComments(prev => [...prev, newComment].sort((a, b) => a.created_at - b.created_at))
  }, [])

  // Modal navigation
  const openReplies = useCallback((comment: Event) => {
    setModalStack([comment])
  }, [])

  const drillInto = useCallback((comment: Event) => {
    setModalStack(prev => [...prev, comment])
  }, [])

  const goBack = useCallback(() => {
    setModalStack(prev => prev.length > 1 ? prev.slice(0, -1) : [])
  }, [])

  const closeModal = useCallback(() => {
    setModalStack([])
  }, [])

  const activeComment = modalStack.length > 0 ? modalStack[modalStack.length - 1] : null
  const commentCount = comments.length

  return (
    <div className="mt-4 pt-4 border-t border-border/50">
      {/* Section header */}
      <div className="flex items-center gap-2 mb-5">
        <MessageSquare size={18} className="text-primary" />
        <h2 className="text-base font-semibold text-foreground">
          {loading ? 'Comments' : `${commentCount} ${commentCount === 1 ? 'Comment' : 'Comments'}`}
        </h2>
      </div>

      {/* Compose box for top-level comments */}
      {pubkey && (
        <CommentComposeBox
          articleEvent={articleEvent}
          aCoordinate={aCoordinate}
          replyTo={null}
          onPosted={handleCommentPosted}
        />
      )}

      {!pubkey && (
        <div className="flex items-center justify-center py-4 mb-4 rounded-lg bg-secondary/30 border border-border/50">
          <p className="text-xs text-muted-foreground">Sign in to leave a comment</p>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={18} className="animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">Loading comments...</span>
        </div>
      )}

      {/* Empty state */}
      {!loading && commentCount === 0 && (
        <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
          <MessageSquare size={28} className="mb-2 opacity-40" />
          <p className="text-sm">No comments yet</p>
          <p className="text-xs mt-1 opacity-60">Be the first to share your thoughts</p>
        </div>
      )}

      {/* Flat list of top-level comments */}
      {!loading && topLevel.length > 0 && (
        <div className="space-y-2">
          {topLevel.map(comment => (
            <CommentRow
              key={comment.id}
              comment={comment}
              replyCount={replyCountMap.get(comment.id) || 0}
              onReply={() => openReplies(comment)}
            />
          ))}
        </div>
      )}

      {/* Reply drill-down modal */}
      {activeComment && (
        <CommentModal
          comment={activeComment}
          canGoBack={modalStack.length > 1}
          onGoBack={goBack}
          onClose={closeModal}
          onDrillInto={drillInto}
          replyMap={replyMap}
          replyCountMap={replyCountMap}
          articleEvent={articleEvent}
          aCoordinate={aCoordinate}
          onPosted={handleCommentPosted}
        />
      )}
    </div>
  )
}

/* ─── Flat Comment Row (top-level, on article page) ─── */

function CommentRow({ comment, replyCount, onReply }: {
  comment: Event
  replyCount: number
  onReply: () => void
}) {
  const { getProfile } = useProfileCache()
  const profile = getProfile(comment.pubkey)
  const displayName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(comment.pubkey), 8)

  return (
    <div className="group rounded-lg bg-secondary/20 hover:bg-secondary/30 transition-colors p-3">
      {/* Author row */}
      <div className="flex items-center gap-2 mb-1.5">
        <Avatar className="w-6 h-6 shrink-0">
          {profile?.picture && <AvatarImage src={profile.picture} />}
          <AvatarFallback className="text-[9px] bg-primary/20 text-primary">
            {displayName.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <span className="text-xs font-semibold text-foreground truncate">{displayName}</span>
        <DnnBadge pubkey={comment.pubkey} />
        <span className="text-[10px] text-muted-foreground">{formatTimestamp(comment.created_at)}</span>
      </div>

      {/* Body */}
      <div className="text-sm text-foreground/90 whitespace-pre-wrap break-words leading-relaxed pl-8 mb-2">
        {comment.content}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pl-8">
        <button
          onClick={onReply}
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-primary transition-colors cursor-pointer"
        >
          <MessageCircle size={12} />
          {replyCount > 0
            ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`
            : 'Reply'
          }
        </button>
      </div>
    </div>
  )
}

/* ─── Reply Drill-Down Modal ─── */

function CommentModal({ comment, canGoBack, onGoBack, onClose, onDrillInto, replyMap, replyCountMap, articleEvent, aCoordinate, onPosted }: {
  comment: Event
  canGoBack: boolean
  onGoBack: () => void
  onClose: () => void
  onDrillInto: (comment: Event) => void
  replyMap: Map<string, Event[]>
  replyCountMap: Map<string, number>
  articleEvent: Event
  aCoordinate: string
  onPosted: (event: Event) => void
}) {
  const { getProfile } = useProfileCache()
  const profile = getProfile(comment.pubkey)
  const displayName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(comment.pubkey), 8)
  const pubkey = useUserStore((s) => s.pubkey)

  const directReplies = replyMap.get(comment.id) || []

  // Close on backdrop click
  const backdropRef = useRef<HTMLDivElement>(null)
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose()
  }

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
    >
      <div className="w-full max-w-lg max-h-[80vh] flex flex-col bg-background rounded-xl border border-border shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Modal header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
          {canGoBack && (
            <button
              onClick={onGoBack}
              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors cursor-pointer"
            >
              <ArrowLeft size={16} />
            </button>
          )}
          <MessageSquare size={15} className="text-primary" />
          <span className="text-sm font-semibold text-foreground flex-1">
            {directReplies.length > 0
              ? `${directReplies.length} ${directReplies.length === 1 ? 'Reply' : 'Replies'}`
              : 'Replies'
            }
          </span>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {/* Featured / focused comment */}
          <div className="rounded-lg bg-primary/5 border border-primary/15 p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <Avatar className="w-7 h-7 shrink-0">
                {profile?.picture && <AvatarImage src={profile.picture} />}
                <AvatarFallback className="text-[9px] bg-primary/20 text-primary">
                  {displayName.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="text-xs font-semibold text-foreground truncate">{displayName}</span>
              <DnnBadge pubkey={comment.pubkey} />
              <span className="text-[10px] text-muted-foreground">{formatTimestamp(comment.created_at)}</span>
            </div>
            <div className="text-sm text-foreground/90 whitespace-pre-wrap break-words leading-relaxed pl-9">
              {comment.content}
            </div>
          </div>

          {/* Compose reply */}
          {pubkey && (
            <CommentComposeBox
              articleEvent={articleEvent}
              aCoordinate={aCoordinate}
              replyTo={comment}
              onPosted={onPosted}
              compact
            />
          )}

          {/* Separator */}
          {directReplies.length > 0 && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground pt-1">
              <div className="flex-1 h-px bg-border/50" />
              <span>{directReplies.length} {directReplies.length === 1 ? 'reply' : 'replies'}</span>
              <div className="flex-1 h-px bg-border/50" />
            </div>
          )}

          {/* Direct replies */}
          {directReplies.map(reply => (
            <ModalReplyRow
              key={reply.id}
              comment={reply}
              replyCount={replyCountMap.get(reply.id) || 0}
              onDrillInto={() => onDrillInto(reply)}
            />
          ))}

          {/* No replies yet */}
          {directReplies.length === 0 && (
            <div className="flex flex-col items-center py-6 text-muted-foreground">
              <MessageCircle size={22} className="mb-1.5 opacity-40" />
              <p className="text-xs opacity-60">No replies yet</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ─── Reply Row inside Modal ─── */

function ModalReplyRow({ comment, replyCount, onDrillInto }: {
  comment: Event
  replyCount: number
  onDrillInto: () => void
}) {
  const { getProfile } = useProfileCache()
  const profile = getProfile(comment.pubkey)
  const displayName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(comment.pubkey), 8)

  return (
    <div className="rounded-lg bg-secondary/20 hover:bg-secondary/30 transition-colors p-3">
      <div className="flex items-center gap-2 mb-1.5">
        <Avatar className="w-5 h-5 shrink-0">
          {profile?.picture && <AvatarImage src={profile.picture} />}
          <AvatarFallback className="text-[8px] bg-primary/20 text-primary">
            {displayName.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <span className="text-xs font-semibold text-foreground truncate">{displayName}</span>
        <DnnBadge pubkey={comment.pubkey} />
        <span className="text-[10px] text-muted-foreground">{formatTimestamp(comment.created_at)}</span>
      </div>

      <div className="text-[13px] text-foreground/90 whitespace-pre-wrap break-words leading-relaxed pl-7 mb-1.5">
        {comment.content}
      </div>

      <div className="pl-7">
        <button
          onClick={onDrillInto}
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-primary transition-colors cursor-pointer"
        >
          <MessageCircle size={11} />
          {replyCount > 0
            ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`
            : 'Reply'
          }
        </button>
      </div>
    </div>
  )
}

/* ─── Comment Compose Box ─── */

function CommentComposeBox({ articleEvent, aCoordinate, replyTo, onPosted, compact }: {
  articleEvent: Event
  aCoordinate: string
  replyTo: Event | null
  onPosted: (event: Event) => void
  compact?: boolean
}) {
  const [text, setText] = useState('')
  const [posting, setPosting] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  const pubkey = useUserStore((s) => s.pubkey)
  const avatar = useUserStore((s) => s.avatar)
  const displayName = useUserStore((s) => s.displayName)

  const settings = useComposeSettings()
  const emojiBtnRef = useRef<HTMLButtonElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handlePost = async () => {
    if (!pubkey || !text.trim()) return
    setPosting(true)

    try {
      const tags: string[][] = []

      // Root scope — always the article (uppercase tags per NIP-22)
      tags.push(['A', aCoordinate, ''])
      tags.push(['K', '30023'])
      tags.push(['P', articleEvent.pubkey])

      if (replyTo) {
        // Replying to another comment
        tags.push(['e', replyTo.id, ''])
        tags.push(['k', '1111'])
        tags.push(['p', replyTo.pubkey])
      } else {
        // Top-level comment — parent = the article itself
        tags.push(['a', aCoordinate, ''])
        tags.push(['k', '30023'])
        tags.push(['p', articleEvent.pubkey])
      }

      const unsigned = {
        kind: 1111,
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: text.trim(),
      }

      const signed = await settings.publishWithSettings(unsigned)
      setText('')
      onPosted(signed)
    } catch (err) {
      console.error('[ArticleComments] Failed to post comment:', err)
    } finally {
      setPosting(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handlePost()
    }
  }

  // Reply target name
  const { getProfile } = useProfileCache()
  const replyProfile = replyTo ? getProfile(replyTo.pubkey) : null
  const replyName = replyProfile?.display_name || replyProfile?.name || (replyTo ? truncateNpub(nip19.npubEncode(replyTo.pubkey), 8) : '')

  return (
    <div className={cn('flex gap-2.5', compact ? 'p-2.5 bg-secondary/30 rounded-lg border border-border/40' : 'p-3 bg-secondary/40 border border-border/50 rounded-lg mb-4')}>
      <Avatar className={cn('shrink-0', compact ? 'h-6 w-6' : 'h-8 w-8')}>
        {avatar && <AvatarImage src={avatar} />}
        <AvatarFallback className={cn('bg-primary text-primary-foreground', compact ? 'text-[8px]' : 'text-xs')}>
          {(displayName || 'U').slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={replyTo ? `Reply to ${replyName}...` : 'Write a comment...'}
          className={cn('w-full bg-transparent resize-none outline-none text-foreground placeholder:text-muted-foreground rounded-sm py-1 px-1', compact ? 'text-[13px] min-h-[60px]' : 'text-sm min-h-[36px]')}
          rows={compact ? 3 : 2}
        />

        <div className="flex justify-between items-center gap-2 pt-1.5 border-t border-border/30">
          <div className="flex items-center gap-1">
            <button
              ref={emojiBtnRef}
              onClick={() => setShowEmoji(!showEmoji)}
              className="p-1 rounded-full cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            >
              <Smile size={compact ? 14 : 16} />
            </button>
            {showEmoji && (
              <EmojiPickerPopover
                anchorRef={emojiBtnRef}
                onClose={() => setShowEmoji(false)}
                onSelect={(emoji) => {
                  setText(text + emoji)
                  setShowEmoji(false)
                  textareaRef.current?.focus()
                }}
              />
            )}

            {/* Settings gear */}
            <ComposeSettingsButton
              open={showSettings}
              onClick={() => setShowSettings(!showSettings)}
            />
          </div>

          <button
            onClick={handlePost}
            disabled={!text.trim() || posting}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-2 rounded-md text-xs font-medium transition-all cursor-pointer',
              text.trim() && !posting
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-muted text-muted-foreground cursor-not-allowed'
            )}
          >
            {posting ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
            {posting ? 'Posting...' : replyTo ? 'Reply' : 'Comment'}
          </button>
        </div>

        {/* Settings panel (collapsible) */}
        {showSettings && (
          <div className="mt-2">
            <ComposeSettingsPanel settings={settings} />
          </div>
        )}
      </div>
    </div>
  )
}
