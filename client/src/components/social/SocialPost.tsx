/**
 * SocialPost — Individual post card with interactions (reply, repost, react, bookmark)
 */

import { useState, useCallback, useRef, useEffect, forwardRef } from 'react'
import { createPortal } from 'react-dom'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { useBlockStore } from '@/stores/blockStore'
import { useWotStore } from '@/stores/wotStore'
import { publishToSpecificRelays, fetchEvents } from '@/lib/nostr/relay-pool'
import { getPublishRelays } from '@/stores/postingBehaviourStore'
import { signWithSigner } from '@/lib/nostr/events'
import { RichContent } from '@/components/social/RichContent'
import { DnnBadge } from '@/components/ui/DnnBadge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { EmojiPickerPopover } from '@/components/chat/EmojiPickerPopover'
import { useMediaUpload, MediaUploadStrip, AddMediaButton } from '@/components/social/MediaUploadStrip'
import { useComposeSettings, ComposeSettingsPanel, ComposeSettingsButton, isClientTagEnabled } from '@/components/social/ComposeSettings'
import { truncateNpub, formatTimestamp } from '@/lib/utils'
import { getEmojiMap } from '@/stores/emojiStore'
import { cn } from '@/lib/utils'
import {
  MessageCircle, Repeat2, Heart, Bookmark, ChevronDown, ChevronUp,
  Eye, EyeOff, Quote, Send, X, Loader2, Smile, MoreVertical, Copy, Code, Check, ShieldBan, Zap,
} from 'lucide-react'
import { nip19, nip04 } from 'nostr-tools'
import type { Event } from 'nostr-tools'
import { ZapModal } from '@/components/hub/ZapModal'
import { useZapStore } from '@/stores/zapStore'
import { parseZapReceipt, formatSats, type ZapInfo } from '@/lib/nostr/zap'
import { ZapListModal } from '@/components/hub/ZapListModal'
import { ReactionListModal, type ReactionInfo } from '@/components/social/ReactionListModal'

/** Namespace used in zapStore for social feed posts */
const SOCIAL_ZAP_NS = '__social__'

/** Module-level WoT cache — avoids re-traversing the graph for each post in the same render */
const wotHideCache = new Map<string, boolean>()
/** Clear WoT cache periodically (every 30 seconds) to pick up graph changes */
setInterval(() => wotHideCache.clear(), 30_000)

interface SocialPostProps {
  event: Event
  onOpenProfile?: (pubkey: string) => void
  onOpenThread?: (eventId: string) => void
  compact?: boolean
  /** Pre-fetched bookmark state from feed-level batch. Undefined = self-fetch. */
  isBookmarked?: boolean
  /** Pre-fetched reactions from feed-level batch. Undefined = self-fetch. */
  initialReactions?: ReactionInfo[]
  /** If true, zap data was batch-populated in zapStore by the parent — skip per-post fetch */
  skipZapFetch?: boolean
}

export function SocialPost({ event, onOpenProfile, onOpenThread, compact, isBookmarked: isBookmarkedProp, initialReactions, skipZapFetch }: SocialPostProps) {
  const { getProfile } = useProfileCache()
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const [liked, setLiked] = useState(() => {
    if (initialReactions && myPubkey) return initialReactions.some(r => r.pubkey === myPubkey)
    return false
  })
  const [reactions, setReactions] = useState<ReactionInfo[]>(initialReactions ?? [])
  const [showReactionList, setShowReactionList] = useState(false)
  const [reposted, setReposted] = useState(false)
  const [bookmarked, setBookmarked] = useState(isBookmarkedProp ?? false)
  const [likeLoading, setLikeLoading] = useState(false)
  const [repostLoading, setRepostLoading] = useState(false)
  const [bookmarkLoading, setBookmarkLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [isOverflowing, setIsOverflowing] = useState(false)
  const [nsfwRevealed, setNsfwRevealed] = useState(false)
  const [blockedRevealed, setBlockedRevealed] = useState(false)
  const [showRepostMenu, setShowRepostMenu] = useState(false)
  const [showQuoteModal, setShowQuoteModal] = useState(false)
  const [quoteText, setQuoteText] = useState('')
  const [quotePosting, setQuotePosting] = useState(false)
  const [showZapModal, setShowZapModal] = useState(false)
  const [showZapList, setShowZapList] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const repostRef = useRef<HTMLDivElement>(null)
  const repostDropdownRef = useRef<HTMLDivElement>(null)

  // Check if post has content-warning tag
  const isNsfw = event.tags.some(t => t[0] === 'content-warning')
  const showNsfwPref = typeof window !== 'undefined' && localStorage.getItem('SHOW_NSFW') === 'true'
  const shouldBlur = isNsfw && !showNsfwPref && !nsfwRevealed

  // Block check
  const isBlockedUser = useBlockStore((s) => s.isBlocked)(event.pubkey)
  const hideBlockedCompletely = useBlockStore((s) => s.hideBlockedCompletely)
  const mutedWords = useBlockStore((s) => s.mutedWords)

  // Completely hide if setting enabled
  if (isBlockedUser && hideBlockedCompletely) return null

  // WoT filter — hide if score below threshold
  let wotHidden = wotHideCache.get(event.pubkey)
  if (wotHidden === undefined) {
    wotHidden = useWotStore.getState().shouldHide(event.pubkey, 'social')
    wotHideCache.set(event.pubkey, wotHidden)
  }
  if (wotHidden) return null

  const shouldBlurBlocked = isBlockedUser && !blockedRevealed

  const MAX_HEIGHT = 500
  const shouldCollapse = !compact

  // Use ResizeObserver to detect overflow after images/embeds finish loading
  useEffect(() => {
    if (!shouldCollapse || !contentRef.current) return

    const el = contentRef.current
    const check = () => setIsOverflowing(el.scrollHeight > MAX_HEIGHT)
    check()

    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [event.content, shouldCollapse])

  // Close repost menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        repostRef.current && !repostRef.current.contains(target) &&
        (!repostDropdownRef.current || !repostDropdownRef.current.contains(target))
      ) {
        setShowRepostMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Check initial bookmark state
  useEffect(() => {
    if (isBookmarkedProp !== undefined) return  // Fed from batch — skip per-post fetch
    if (!myPubkey) return
    fetchEvents({ kinds: [10003], authors: [myPubkey], limit: 1 }).then(async (events) => {
      if (events.length > 0) {
        const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
        // Check encrypted content for private bookmarks
        if (latest.content) {
          try {
            let decrypted: string
            if (privateKey) {
              decrypted = await nip04.decrypt(privateKey, myPubkey, latest.content)
            } else if (signer?.nip04Decrypt) {
              decrypted = await signer.nip04Decrypt(myPubkey, latest.content)
            } else if (signer?.nip04?.decrypt) {
              decrypted = await signer.nip04.decrypt(myPubkey, latest.content)
            } else {
              return
            }
            const privateTags: string[][] = JSON.parse(decrypted)
            const isBookmarked = privateTags.some(t => t[0] === 'e' && t[1] === event.id)
            setBookmarked(isBookmarked)
          } catch (err) {
            console.warn('[bookmarks] Failed to decrypt bookmark list:', err)
            // Fallback: check public tags for legacy bookmarks
            const isBookmarked = latest.tags.some(t => t[0] === 'e' && t[1] === event.id)
            setBookmarked(isBookmarked)
          }
        } else {
          // Legacy: check public tags
          const isBookmarked = latest.tags.some(t => t[0] === 'e' && t[1] === event.id)
          setBookmarked(isBookmarked)
        }
      }
    })
  }, [myPubkey, event.id])

  // Fetch historical reactions for this post
  useEffect(() => {
    if (initialReactions !== undefined) return  // Fed from batch — skip per-post fetch
    fetchEvents({ kinds: [7], '#e': [event.id], limit: 100 }).then((rawReactions) => {
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

  // Fetch historical zap receipts for this post
  const zaps = useZapStore((s) => s.zaps[SOCIAL_ZAP_NS]?.[event.id]) || []
  const zapTotal = zaps.reduce((sum: number, z: ZapInfo) => sum + z.amount, 0)

  useEffect(() => {
    if (skipZapFetch) return  // Fed from batch — skip per-post fetch
    fetchEvents({ kinds: [9735], '#e': [event.id], limit: 50 }).then((receipts) => {
      const zapStore = useZapStore.getState()
      for (const receipt of receipts) {
        if (!zapStore.markZapProcessed(receipt.id)) continue
        const zapInfo = parseZapReceipt(receipt)
        if (zapInfo) {
          zapStore.addZap(SOCIAL_ZAP_NS, event.id, zapInfo)
        }
      }
    })
  }, [event.id])

  const profile = getProfile(event.pubkey)
  const displayName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(event.pubkey))
  const avatarUrl = profile?.picture
  const npubStr = nip19.npubEncode(event.pubkey)
  const shortNpub = npubStr.length > 20 ? `${npubStr.slice(0, 10)}...${npubStr.slice(-5)}` : npubStr

  const [showReactionPicker, setShowReactionPicker] = useState(false)
  const [reactionEmoji, setReactionEmoji] = useState<string | null>(() => {
    if (initialReactions && myPubkey) {
      const my = initialReactions.find(r => r.pubkey === myPubkey)
      if (my) return my.emoji === '+' ? '❤️' : my.emoji
    }
    return null
  })
  const [reactionCustomUrl, setReactionCustomUrl] = useState<string | null>(() => {
    if (initialReactions && myPubkey) {
      const my = initialReactions.find(r => r.pubkey === myPubkey)
      if (my) return my.emojiUrl || null
    }
    return null
  })
  const [showDotMenu, setShowDotMenu] = useState(false)
  const [rawEventJson, setRawEventJson] = useState<string | null>(null)
  const [copyFeedback, setCopyFeedback] = useState(false)
  const reactionBtnRef = useRef<HTMLButtonElement>(null)
  const dotMenuRef = useRef<HTMLDivElement>(null)

  // Close dot menu on outside click
  useEffect(() => {
    if (!showDotMenu) return
    const handler = (e: MouseEvent) => {
      if (dotMenuRef.current && !dotMenuRef.current.contains(e.target as Node)) {
        setShowDotMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showDotMenu])

  const handleEmojiReact = useCallback(async (emoji: string) => {
    if (!myPubkey || (!signer && !privateKey) || liked) return
    setLikeLoading(true)
    try {
      const tags: [string, ...string[]][] = [['e', event.id], ['p', event.pubkey]]
      // Add emoji tag for custom emojis (NIP-30)
      const scMatch = emoji.match(/^:([a-zA-Z0-9_-]+):$/)
      if (scMatch) {
        const entry = getEmojiMap().get(scMatch[1])
        if (entry) {
          tags.push(['emoji', scMatch[1], entry.url])
        }
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
      setReactions((prev) => [...prev, {
        eventId: signed.id,
        pubkey: myPubkey,
        emoji,
        createdAt: Math.floor(Date.now() / 1000),
      }])
      // Store custom URL if available
      const scMatch2 = emoji.match(/^:([a-zA-Z0-9_-]+):$/)
      if (scMatch2) {
        const entry2 = getEmojiMap().get(scMatch2[1])
        if (entry2) setReactionCustomUrl(entry2.url)
      }
    } catch (err) {
      console.error('Failed to react:', err)
    } finally {
      setLikeLoading(false)
    }
  }, [event, myPubkey, signer, privateKey, liked])

  const handleRepost = useCallback(async () => {
    if (!myPubkey || (!signer && !privateKey)) return
    setShowRepostMenu(false)
    setRepostLoading(true)
    try {
      const unsigned = {
        kind: 6,
        pubkey: myPubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['e', event.id, ''], ['p', event.pubkey]],
        content: JSON.stringify(event),
      }
      const signed = await signWithSigner(unsigned, signer, privateKey)
      await publishToSpecificRelays(getPublishRelays(), signed)
      setReposted(true)
    } catch (err) {
      console.error('Failed to repost:', err)
    } finally {
      setRepostLoading(false)
    }
  }, [event, myPubkey, signer, privateKey])

  const handleBookmark = useCallback(async () => {
    if (!myPubkey || (!signer && !privateKey)) return
    setBookmarkLoading(true)
    try {
      const existing = await fetchEvents({ kinds: [10003], authors: [myPubkey], limit: 1 })
      const latest = existing.sort((a, b) => b.created_at - a.created_at)[0]

      // Decrypt existing private bookmarks
      let tags: string[][] = []
      if (latest?.content) {
        try {
          let decrypted: string
          if (privateKey) {
            decrypted = await nip04.decrypt(privateKey, myPubkey, latest.content)
          } else if (signer?.nip04Decrypt) {
            decrypted = await signer.nip04Decrypt(myPubkey, latest.content)
          } else if (signer?.nip04?.decrypt) {
            decrypted = await signer.nip04.decrypt(myPubkey, latest.content)
          } else {
            throw new Error('No decryption method available')
          }
          tags = (JSON.parse(decrypted) as string[][]).filter(t => t[0] === 'e')
        } catch {
          // Fallback: migrate from public tags
          tags = latest?.tags.filter(t => t[0] === 'e') || []
        }
      } else {
        // Legacy: migrate from public tags
        tags = latest?.tags.filter(t => t[0] === 'e') || []
      }

      if (bookmarked) {
        tags = tags.filter(t => t[1] !== event.id)
      } else {
        if (!tags.some(t => t[1] === event.id)) {
          tags.push(['e', event.id])
        }
      }

      // Encrypt tags into content
      let encrypted: string
      if (privateKey) {
        encrypted = await nip04.encrypt(privateKey, myPubkey, JSON.stringify(tags))
      } else if (signer?.nip04Encrypt) {
        encrypted = await signer.nip04Encrypt(myPubkey, JSON.stringify(tags))
      } else if (signer?.nip04?.encrypt) {
        encrypted = await signer.nip04.encrypt(myPubkey, JSON.stringify(tags))
      } else {
        throw new Error('No encryption method available')
      }

      const unsigned = {
        kind: 10003,
        pubkey: myPubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [] as string[][], // empty public tags — bookmarks are private
        content: encrypted,
      }
      const signed = await signWithSigner(unsigned, signer, privateKey)
      await publishToSpecificRelays(getPublishRelays(), signed)
      setBookmarked(!bookmarked)
    } catch (err) {
      console.error('Failed to toggle bookmark:', err)
    } finally {
      setBookmarkLoading(false)
    }
  }, [event, myPubkey, signer, privateKey, bookmarked])

  const copyEventId = useCallback(() => {
    navigator.clipboard.writeText(event.id)
    setCopyFeedback(true)
    setTimeout(() => setCopyFeedback(false), 1500)
    setShowDotMenu(false)
  }, [event.id])

  const copyNpub = useCallback(() => {
    navigator.clipboard.writeText(npubStr)
  }, [npubStr])

  return (
    <TooltipProvider delayDuration={300}>
      <div className={`relative py-4 px-4 hover:bg-accent/20 transition-colors ${compact ? 'py-2' : ''}`}>
        {/* Header row: avatar + name + npub + timestamp + dots */}
        <div className="flex items-center gap-2.5">
          <button onClick={() => onOpenProfile?.(event.pubkey)} className="shrink-0 cursor-pointer">
            <Avatar className="h-9 w-9">
              {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
              <AvatarFallback className="text-sm bg-primary/20 text-primary">
                {displayName.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          </button>

          <div className="flex items-center gap-2 min-w-0 flex-1 max-[1080px]:flex-wrap">
            <button
              onClick={() => onOpenProfile?.(event.pubkey)}
              className="text-sm font-semibold text-foreground hover:underline cursor-pointer truncate"
            >
              {displayName}
            </button>
            <DnnBadge pubkey={event.pubkey} />
            <div className="flex items-center gap-1 min-w-0 max-[1080px]:hidden">
              <span className="text-[11px] text-muted-foreground/60 truncate">{shortNpub}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); copyNpub() }}
                    className="p-0.5 rounded text-muted-foreground/40 hover:text-muted-foreground transition-colors cursor-pointer shrink-0"
                  >
                    <Copy size={10} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">Copy npub</TooltipContent>
              </Tooltip>
            </div>
            <span className="text-[11px] text-muted-foreground shrink-0">
              · {formatTimestamp(event.created_at)}
              {(() => {
                const clientTag = event.tags.find(t => t[0] === 'client')
                return clientTag ? <span className="text-muted-foreground/60"> · via {clientTag[1]}</span> : null
              })()}
            </span>
          </div>

          {/* Three-dot menu */}
          <div className="relative shrink-0" ref={dotMenuRef}>
            <button
              onClick={(e) => { e.stopPropagation(); setShowDotMenu(!showDotMenu) }}
              className="p-1 rounded cursor-pointer text-muted-foreground/50 hover:text-muted-foreground hover:bg-accent/50 transition-colors"
            >
              <MoreVertical size={14} />
            </button>
            {showDotMenu && (
              <div className="absolute right-0 top-full mt-1 w-44 bg-popover/95 backdrop-blur-md border border-border rounded-xl shadow-xl p-1 flex flex-col gap-1 z-50 animate-in fade-in-0 zoom-in-95">
                <button
                  onClick={copyEventId}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
                >
                  <Copy size={13} /> {copyFeedback ? 'Copied!' : 'Copy Event ID'}
                </button>
                <button
                  onClick={() => { setRawEventJson(JSON.stringify(event)); setShowDotMenu(false) }}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
                >
                  <Code size={13} /> View Raw Event
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Content — full width */}
        {shouldBlurBlocked ? (
          <div className="relative z-10 flex items-center gap-2.5 py-2.5 px-3 mt-2.5 rounded-lg bg-muted/50 border border-border/50">
            <ShieldBan size={14} className="text-destructive/70 shrink-0" />
            <span className="text-xs text-muted-foreground">Post hidden — blocked user</span>
            <button
              onClick={(e) => { e.stopPropagation(); setBlockedRevealed(true) }}
              className="flex items-center gap-1 ml-auto text-xs font-medium text-primary hover:text-primary/80 bg-primary/10 hover:bg-primary/15 px-2.5 py-1 rounded-full transition-colors cursor-pointer"
            >
              <Eye size={12} /> Show
            </button>
          </div>
        ) : !shouldBlur && (
        <div className="relative mt-2.5">
          <div
            ref={contentRef}
            className="overflow-hidden"
            style={!expanded && isOverflowing && shouldCollapse ? { maxHeight: MAX_HEIGHT } : undefined}
          >
            <div
              onClick={() => onOpenThread?.(event.id)}
              className="cursor-pointer"
            >
              <RichContent
                content={event.content}
                onOpenProfile={onOpenProfile}
                onOpenThread={onOpenThread}
                mutedWords={mutedWords}
              />
            </div>
          </div>

          {shouldCollapse && isOverflowing && (
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
              className="w-full flex items-center bg-secondary/50 gap-1 px-1.5 py-1.5 justify-center rounded-sm text-xs text-primary/50 hover:text-primary cursor-pointer mt-1 transition-colors"
            >
              {expanded ? (
                <><ChevronUp size={14} /> Show less</>
              ) : (
                <><ChevronDown size={14} /> Show more</>
              )}
            </button>
          )}
        </div>
        )}

        {/* Hide blocked button (shown after reveal) */}
        {isBlockedUser && blockedRevealed && (
          <button
            onClick={(e) => { e.stopPropagation(); setBlockedRevealed(false) }}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer mt-1"
          >
            <EyeOff size={12} /> Hide blocked content
          </button>
        )}

        {/* NSFW overlay — scoped to content area only */}
        {shouldBlur && (
          <div className="relative z-10 flex flex-col items-center justify-center py-8 bg-background/90 backdrop-blur-[80px] rounded-md border border-border/50 mt-2.5">
            <span className="text-sm font-medium text-muted-foreground mb-2">Content Warning — Not Safe For Work</span>
            <button
              onClick={(e) => { e.stopPropagation(); setNsfwRevealed(true) }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-secondary text-sm text-foreground hover:bg-secondary/80 transition-colors cursor-pointer"
            >
              <Eye size={14} /> Show Content
            </button>
          </div>
        )}

        {/* Hide NSFW button (shown after reveal) */}
        {isNsfw && !showNsfwPref && nsfwRevealed && (
          <button
            onClick={(e) => { e.stopPropagation(); setNsfwRevealed(false) }}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer mt-1"
          >
            <EyeOff size={12} /> Hide NSFW content
          </button>
        )}

        {/* Interaction bar — full width with border-top */}
        <div className="flex items-center gap-5 max-[1080px]:gap-2 mt-3 pt-2.5 border-t border-border/40">
          {/* Reply */}
          <InteractionButton
            icon={<MessageCircle size={16} />}
            label="Reply"
            onClick={() => onOpenThread?.(event.id)}
          />

          {/* Repost with dropdown */}
          <div ref={repostRef}>
            <InteractionButton
              icon={repostLoading ? <Loader2 size={16} className="animate-spin" /> : <Repeat2 size={16} />}
              label="Repost"
              onClick={() => !repostLoading && setShowRepostMenu(!showRepostMenu)}
              active={reposted}
              activeColor="text-green-500"
            />
            {showRepostMenu && repostRef.current && createPortal(
              <RepostDropdown
                ref={repostDropdownRef}
                anchorEl={repostRef.current}
                onRepost={(e: React.MouseEvent) => { e.stopPropagation(); handleRepost() }}
                onQuoteRepost={(e: React.MouseEvent) => { e.stopPropagation(); setShowRepostMenu(false); setShowQuoteModal(true) }}
              />,
              document.body
            )}
          </div>

          {/* Emoji reaction */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                ref={reactionBtnRef}
                onClick={(e) => { e.stopPropagation(); if (!liked) setShowReactionPicker(!showReactionPicker) }}
                className={`flex items-center gap-1 p-1.5 rounded-full transition-colors cursor-pointer hover:bg-accent/50
                  ${liked ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {likeLoading ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : reactionEmoji ? (
                  <span className="text-sm leading-none">{(() => {
                    if (reactionCustomUrl) return <img src={reactionCustomUrl} alt={reactionEmoji} className="h-4 w-4 object-contain inline" />
                    const scMatch = reactionEmoji.match(/^:([a-zA-Z0-9_-]+):$/)
                    if (scMatch) {
                      const entry = getEmojiMap().get(scMatch[1])
                      if (entry) return <img src={entry.url} alt={reactionEmoji} className="h-4 w-4 object-contain inline" />
                    }
                    return reactionEmoji
                  })()}</span>
                ) : (
                  <Smile size={16} />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">React</TooltipContent>
          </Tooltip>
          {reactions.length > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowReactionList(true) }}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs cursor-pointer transition-colors border bg-primary/10 border-primary/30 text-primary hover:bg-primary/20"
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

          {/* Bookmark — pushed to the right */}
          <div className="ml-auto flex items-center gap-1">
            {/* Zap total badge */}
            {zaps.length > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); setShowZapList(true) }}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs cursor-pointer transition-colors border bg-yellow-400/10 border-yellow-400/30 text-yellow-400 hover:bg-yellow-400/20 mr-1"
              >
                <Zap size={12} fill="currentColor" />
                <span className="font-semibold">{formatSats(zapTotal)}</span>
                {zaps.length > 1 && (
                  <span className="text-yellow-400/60">({zaps.length})</span>
                )}
              </button>
            )}
            {/* Zap button */}
            <InteractionButton
              icon={<Zap size={16} />}
              label="Zap"
              onClick={() => setShowZapModal(true)}
            />
            <InteractionButton
              icon={bookmarkLoading ? <Loader2 size={16} className="animate-spin" /> : <Bookmark size={16} />}
              label={bookmarked ? 'Remove Bookmark' : 'Bookmark'}
              onClick={handleBookmark}
              active={bookmarked}
              activeColor="text-yellow-500"
              activeFill
            />
          </div>
        </div>

        {/* Quote Repost Modal — portaled into social content area */}
        {showQuoteModal && (() => {
          const container = document.getElementById('social-content')
          if (!container) return null
          return createPortal(
            <QuoteRepostModal
              event={event}
              displayName={displayName}
              avatarUrl={avatarUrl}
              quoteText={quoteText}
              setQuoteText={setQuoteText}
              quotePosting={quotePosting}
              setQuotePosting={setQuotePosting}
              onPosted={() => { setQuoteText(''); setShowQuoteModal(false); setReposted(true) }}
              onClose={() => setShowQuoteModal(false)}
              signer={signer}
              privateKey={privateKey}
              myPubkey={myPubkey}
            />,
            container
          )
        })()}

        {/* Raw Event Modal */}
        {rawEventJson && (
          <RawEventModal rawJson={rawEventJson} onClose={() => setRawEventJson(null)} />
        )}

        {/* Zap Modal */}
        <ZapModal
          open={showZapModal}
          onClose={() => setShowZapModal(false)}
          recipientPubkey={event.pubkey}
          messageEventId={event.id}
          messageKind={1}
          disableSplit
          storeNamespace={SOCIAL_ZAP_NS}
        />

        {/* Zap List Modal */}
        {showZapList && (
          <ZapListModal
            open={showZapList}
            onClose={() => setShowZapList(false)}
            zaps={zaps}
            onOpenProfile={onOpenProfile}
          />
        )}

        {/* Reaction List Modal */}
        {showReactionList && (
          <ReactionListModal
            open={showReactionList}
            onClose={() => setShowReactionList(false)}
            reactions={reactions}
            onOpenProfile={onOpenProfile}
          />
        )}
      </div>
    </TooltipProvider>
  )
}

function InteractionButton({ icon, label, onClick, active, activeColor, activeFill }: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  active?: boolean
  activeColor?: string
  activeFill?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={(e) => { e.stopPropagation(); onClick() }}
          className={`flex items-center gap-1 p-1.5 rounded-full transition-colors cursor-pointer
            ${active ? activeColor : 'text-muted-foreground hover:text-foreground'}
            hover:bg-accent/50
          `}
        >
          <span className={activeFill && active ? 'fill-current' : ''}>{icon}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/* ─── Raw Event Modal (reused from hub pattern) ─── */

function RawEventModal({ rawJson, onClose }: { rawJson: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)

  let pretty: string
  try {
    pretty = JSON.stringify(JSON.parse(rawJson), null, 2)
  } catch {
    pretty = rawJson
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(pretty)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-secondary border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">Raw Nostr Event</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 cursor-pointer transition-colors"
            >
              {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button
              onClick={onClose}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 cursor-pointer transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="overflow-auto p-4">
          <pre className="text-xs text-foreground/80 font-mono whitespace-pre-wrap break-words">{pretty}</pre>
        </div>
      </div>
    </div>
  )
}

/* ─── Quote Repost Modal ─── */

interface QuoteRepostModalProps {
  event: Event
  displayName: string
  avatarUrl?: string
  quoteText: string
  setQuoteText: (v: string) => void
  quotePosting: boolean
  setQuotePosting: (v: boolean) => void
  onPosted: () => void
  onClose: () => void
  signer?: import('@/stores/userStore').ISigner | null
  privateKey?: string | null
  myPubkey?: string | null
}

function QuoteRepostModal({
  event, displayName, avatarUrl, quoteText, setQuoteText,
  quotePosting, setQuotePosting, onPosted, onClose, signer, privateKey, myPubkey,
}: QuoteRepostModalProps) {
  const [showEmoji, setShowEmoji] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const emojiBtnRef = useRef<HTMLButtonElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const media = useMediaUpload(signer, privateKey)
  const settings = useComposeSettings()

  const handleSubmit = async () => {
    // If there are pending files, upload them first
    if (media.hasPendingOrFailed) {
      await media.uploadAll()
      return
    }
    // Build the final content with media URLs
    const mediaUrls = media.getUploadedUrls()
    const textContent = mediaUrls.length > 0
      ? [quoteText.trim(), ...mediaUrls].filter(Boolean).join('\n')
      : quoteText.trim()

    if (!textContent || !myPubkey) return

    setQuotePosting(true)
    try {
      const nevent = nip19.neventEncode({ id: event.id })
      const content = `${textContent}\n\nnostr:${nevent}`
      const unsigned = {
        kind: 1,
        pubkey: myPubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['q', event.id], ['p', event.pubkey]],
        content,
      }
      await settings.publishWithSettings(unsigned)
      onPosted()
    } catch (err) {
      console.error('Failed to quote repost:', err)
    } finally {
      setQuotePosting(false)
    }
  }

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg mx-4 rounded-xl border border-border bg-background shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Modal header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="font-semibold text-sm text-foreground">Quote Repost</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
            <X size={18} />
          </button>
        </div>

        {/* Compose area */}
        <div className="px-4 py-3">
          <textarea
            ref={textareaRef}
            value={quoteText}
            onChange={(e) => setQuoteText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleSubmit() } }}
            placeholder="Add your comment..."
            className="w-full bg-transparent resize-none outline-none text-sm min-h-[80px] text-foreground placeholder:text-muted-foreground rounded-sm py-2 px-2"
            rows={3}
            autoFocus
          />
        </div>

        {/* Media upload previews */}
        <div className="px-4">
          <MediaUploadStrip
            pendingFiles={media.pendingFiles}
            isUploading={media.isUploading}
            onRemove={media.removeFile}
            onUpload={() => media.uploadAll()}
            onRetry={(id) => media.setPendingFiles((prev) => prev.map((f) => f.id === id ? { ...f, status: 'pending' as const } : f))}
            onSkipServer={() => { media.uploadAbortRef.current?.abort(); media.uploadAbortRef.current = null }}
            fileSizeWarning={media.fileSizeWarning}
            onDismissSizeWarning={media.dismissSizeWarning}
          />
        </div>

        {/* Quoted post preview */}
        <div className="mx-4 mb-3 rounded-lg border border-border/60 bg-secondary/30 p-3">
          <div className="flex items-center gap-2 mb-1.5">
            <Avatar className="h-5 w-5">
              {avatarUrl && <AvatarImage src={avatarUrl} />}
              <AvatarFallback className="text-[10px] bg-primary/20 text-primary">{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="text-xs font-medium text-foreground">{displayName}</span>
            <span className="text-[10px] text-muted-foreground">{formatTimestamp(event.created_at)}</span>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-3 whitespace-pre-wrap">{event.content}</p>
        </div>

        {/* Actions bar */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border">
          <div className="flex items-center gap-1">
            {/* Emoji */}
            <button
              ref={emojiBtnRef}
              onClick={() => setShowEmoji(!showEmoji)}
              className="p-1.5 rounded-full cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            >
              <Smile size={18} />
            </button>
            {showEmoji && (
              <EmojiPickerPopover
                anchorRef={emojiBtnRef}
                onClose={() => setShowEmoji(false)}
                onSelect={(emoji) => {
                  setQuoteText(quoteText + emoji)
                  setShowEmoji(false)
                  textareaRef.current?.focus()
                }}
              />
            )}

            {/* Media upload */}
            <AddMediaButton
              onFilesSelected={(files) => media.addFiles(files)}
              uploading={media.isUploading}
            />

            {/* Settings gear */}
            <ComposeSettingsButton
              open={showSettings}
              onClick={() => setShowSettings(!showSettings)}
            />
          </div>

          <Button
            onClick={handleSubmit}
            disabled={(!quoteText.trim() && !media.allSuccess) || quotePosting || media.isUploading}
            size="sm"
            className="gap-2"
          >
            {quotePosting ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
            {media.hasPendingOrFailed ? 'Upload & Post' : quotePosting ? 'Posting...' : 'Post'}
          </Button>
        </div>

        {/* Settings panel (collapsible) — below the toolbar */}
        {showSettings && (
          <div className="px-4 mb-3">
            <ComposeSettingsPanel settings={settings} />
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── Repost Dropdown (portal-based, viewport-aware) ─── */

const RepostDropdown = forwardRef<HTMLDivElement, {
  anchorEl: HTMLElement
  onRepost: (e: React.MouseEvent) => void
  onQuoteRepost: (e: React.MouseEvent) => void
}>(({ anchorEl, onRepost, onQuoteRepost }, ref) => {
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

  useEffect(() => {
    const rect = anchorEl.getBoundingClientRect()
    const menuH = 88
    const gap = 4
    const vh = window.innerHeight
    const vw = window.innerWidth

    let top = rect.bottom + gap
    if (top + menuH > vh - gap) {
      top = rect.top - menuH - gap
    }
    top = Math.max(gap, top)

    let left = rect.left
    if (left + 160 > vw - gap) left = vw - 160 - gap
    left = Math.max(gap, left)

    setPos({ top, left })
  }, [anchorEl])

  return (
    <div
      ref={ref}
      className="fixed w-40 rounded-xl border border-border bg-popover/95 backdrop-blur-md shadow-xl z-[100] p-1 flex flex-col gap-1 animate-in fade-in-0 zoom-in-95"
      style={{ top: pos.top, left: pos.left }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        onClick={onRepost}
        className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-foreground hover:bg-accent/50 transition-colors cursor-pointer rounded-md"
      >
        <Repeat2 size={14} className="text-muted-foreground" /> Repost
      </button>
      <button
        onClick={onQuoteRepost}
        className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-foreground hover:bg-accent/50 transition-colors cursor-pointer rounded-md"
      >
        <Quote size={14} className="text-muted-foreground" /> Quote Repost
      </button>
    </div>
  )
})
