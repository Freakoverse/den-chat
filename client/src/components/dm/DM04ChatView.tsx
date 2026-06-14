/**
 * DM04ChatView — NIP-04 DM chat view with full hub-chat features
 *
 * Supports: replies, thread replies, emoji reactions, edit, delete.
 * Visual style matches ChannelView.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useUserStore } from '@/stores/userStore'
import { useDM04Store, type DM04Message, type DM04Reaction } from '@/stores/dm04Store'
import { useBlockStore } from '@/stores/blockStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { UserProfileModal } from '@/components/hub/UserProfileModal'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { truncateNpub, formatTimestamp } from '@/lib/utils'
import { getHour12 } from '@/stores/preferencesStore'

import { nip19 } from 'nostr-tools'
import {
  Loader2, Lock, AlertCircle, X, Reply, MoreVertical,
  Smile, Sticker, Trash2, Copy, Clipboard, ClipboardCheck, Code,
  MessageSquarePlus, ShieldBan, Eye, EyeOff, Shield, ShieldCheck,
  Check, RotateCcw, Star, ChevronLeft,
} from 'lucide-react'
import { MessageContent } from '@/components/chat/MessageContent'
import { ContentMediaGroupsWithGallery, extractContentMediaGroups } from '@/components/chat/ContentMediaGrouping'
import { DnnBadge } from '@/components/ui/DnnBadge'
import { useGifStore } from '@/stores/gifStore'
import { publishGifFavorites } from '@/lib/nostr/customGif'
import { ChatInputBar, type FileAttachment } from '@/components/chat/ChatInputBar'
import { EmojiPickerPopover, EmojiDiscoveryModal } from '@/components/chat/EmojiPickerPopover'
import { StickerPickerPopover, StickerDiscoveryModal } from '@/components/chat/StickerPickerPopover'
import { DeleteConfirmDialog, RawEventModal } from '@/components/hub/ChannelView'
import { DMGifStarOverlay } from '@/components/dm/DMPage'
import { AlertTriangle, Download } from 'lucide-react'
import { getEmojiMap } from '@/stores/emojiStore'
import { BlossomImg } from '@/components/ui/BlossomImg'
import { extractEmojiTags } from '@/lib/nostr/customEmoji'
import { useNotificationStore } from '@/stores/notificationStore'
import { useUnreadDivider } from '@/hooks/useUnreadDivider'
import { NewMessagesDivider } from '@/components/chat/NewMessagesDivider'
import { UnreadBanner } from '@/components/chat/UnreadBanner'
import { ScrollableContent } from '../chat/ScrollableContent'
import { getDraft, setDraft, clearDraft, dm04DraftKey } from '@/stores/draftStore'

/* ─── Helpers ─── */

const GROUP_WINDOW_S = 5 * 60

/** Extract NIP-30 emoji tags from a raw event JSON string */
function extractDM04EmojiTags(rawEvent?: string): [string, string, string?][] | undefined {
  if (!rawEvent) return undefined
  try {
    const event = JSON.parse(rawEvent)
    const tags = event.tags?.filter((t: string[]) => t[0] === 'emoji' && t[1] && t[2])
    if (!tags || tags.length === 0) return undefined
    return tags.map((t: string[]) => [t[1], t[2], t[3]] as [string, string, string?])
  } catch {
    return undefined
  }
}

function isDifferentDay(ts1: number, ts2: number): boolean {
  return new Date(ts1 * 1000).toDateString() !== new Date(ts2 * 1000).toDateString()
}

function formatDaySeparator(ts: number): string {
  const d = new Date(ts * 1000)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)

  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
}

function formatShortTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: getHour12() })
}

/** Reply context for the input bar */
interface ReplyContext {
  eventId: string
  pubkey: string
  displayName: string
  content: string
  isThread?: boolean
}

/** Optimistic message shown before relay confirms */
interface OptimisticDM04 {
  tempId: string
  content: string
  timestamp: number
  status: 'publishing' | 'published' | 'failed'
  replyDisplayName?: string
  replyPreview?: string
  relayProgress?: { confirmed: number; total: number }
  sentEventId?: string  // event ID for reconciliation with store
}

/* ═══════════════════════════════════════════ */
/*  MAIN COMPONENT                             */
/* ═══════════════════════════════════════════ */

export function DM04ChatView({ recipientPubkey, onSwitchProtocol, onBack }: { recipientPubkey: string; onSwitchProtocol?: () => void; onBack?: () => void }) {
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const conversations = useDM04Store((s) => s.conversations)
  const sendMessage = useDM04Store((s) => s.sendMessage)
  const deleteMessage = useDM04Store((s) => s.deleteMessage)
  const addReaction = useDM04Store((s) => s.addReaction)
  const getReactions = useDM04Store((s) => s.getReactions)
  const loadOlderMessages = useDM04Store((s) => s.loadOlderMessages)
  const loadingOlder = useDM04Store((s) => s.loadingOlder)
  const registryOnlyContacts = useDM04Store((s) => s.registryOnlyContacts)
  const { getProfile } = useProfileCache()

  const _dm04Key = dm04DraftKey(recipientPubkey)
  const [message, setMessage] = useState(() => getDraft(_dm04Key))
  // Load correct draft when switching conversations
  const _prevDm04Key = useRef(_dm04Key)
  useEffect(() => {
    if (_prevDm04Key.current !== _dm04Key) {
      _prevDm04Key.current = _dm04Key
      setMessage(getDraft(_dm04Key))
    }
  }, [_dm04Key])
  useEffect(() => { setDraft(_dm04Key, message) }, [_dm04Key, message])
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [replyContext, setReplyContext] = useState<ReplyContext | null>(null)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const [threadModalParent, setThreadModalParent] = useState<DM04Message | null>(null)
  const [showProfile, setShowProfile] = useState(false)
  const [deleteModalMsg, setDeleteModalMsg] = useState<DM04Message | null>(null)
  const [rawEventData, setRawEventData] = useState<{ rawJson: string; decryptedContent: string } | null>(null)
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticDM04[]>([])

  // Clear optimistic messages when switching conversations (component is reused, not remounted)
  useEffect(() => {
    setOptimisticMessages([])
  }, [recipientPubkey])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const chatContainerRef = useRef<HTMLDivElement>(null)

  // ─── Emoji click modal state ───
  const [clickedEmoji, setClickedEmoji] = useState<{ shortcode: string; url: string; setAddress: string | null } | null>(null)
  const [discoverSearch, setDiscoverSearch] = useState<{ search: string; author: string } | null>(null)

  // ─── Sticker state ───
  const [showSticker, setShowSticker] = useState(false)
  type PendingSticker = { shortcode: string; url: string; setAddress: string }
  const [pendingStickers, setPendingStickers] = useState<PendingSticker[]>([])

  // ─── GIF state ───
  type PendingGif = { name: string; url: string; nsfw: boolean }
  const [pendingGifs, setPendingGifs] = useState<PendingGif[]>([])

  // ─── Sticker click modal state ───
  const [clickedSticker, setClickedSticker] = useState<{ shortcode: string; url: string; setAddress: string | null } | null>(null)
  const [stickerDiscoverSearch, setStickerDiscoverSearch] = useState<{ search: string; author: string } | null>(null)

  useEffect(() => {
    const emojiHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { shortcode: string; url: string; setAddress: string | null }
      setClickedEmoji(detail)
    }
    const stickerHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { shortcode: string; url: string; setAddress: string | null }
      setClickedSticker(detail)
    }
    window.addEventListener('emoji-click', emojiHandler)
    window.addEventListener('sticker-click', stickerHandler)
    return () => {
      window.removeEventListener('emoji-click', emojiHandler)
      window.removeEventListener('sticker-click', stickerHandler)
    }
  }, [])

  const conv = conversations.get(recipientPubkey)
  const allMessages = conv?.messages || []
  const hasMore = conv?.hasMore ?? true
  const profile = getProfile(recipientPubkey)
  const npubStr = nip19.npubEncode(recipientPubkey)
  const hasNip04 = !!(privateKey || signer?.nip04)

  const myProfile = getProfile(myPubkey || '')
  const myDisplayName = myProfile?.display_name || myProfile?.name || (myPubkey ? truncateNpub(nip19.npubEncode(myPubkey)) : 'You')
  const myAvatar = myProfile?.picture

  // Filter out deleted messages and thread replies from main view
  const mainMessages = useMemo(() => {
    // Build set of parent IDs that have threads
    const parentIds = new Set<string>()
    for (const m of allMessages) {
      if (m.isThread && m.rootRef) parentIds.add(m.rootRef)
      if (m.isThread && m.replyTo) parentIds.add(m.replyTo)
    }
    return allMessages.filter((m) => {
      if (m.deleted) return false
      // Hide thread replies when their root is visible
      if (m.isThread && (
        (m.rootRef && parentIds.has(m.rootRef) && allMessages.some(p => p.id === m.rootRef)) ||
        (m.replyTo && allMessages.some(p => p.id === m.replyTo))
      )) return false
      return true
    })
  }, [allMessages])

  // ── New-messages divider ──
  const dm04LastRead = useNotificationStore((s) => s.dm04Unreads[recipientPubkey]?.lastRead ?? 0)
  const {
    dividerRef: newMsgDividerRef,
    unreadCount: newMsgUnreadCount,
    dividerTimestamp: newMsgSnapshot,
    showBanner: showUnreadBanner,
    dismissBanner: dismissUnreadBanner,
    jumpToDivider: jumpToNewMsgDivider,
    shouldInsertDivider,
    dividerHidden,
  } = useUnreadDivider(dm04LastRead, mainMessages, (m) => m.createdAt, `dm04:${recipientPubkey}`, myPubkey, (m) => m.senderPubkey)

  // Thread replies map: parentId -> thread replies
  const threadRepliesMap = useMemo(() => {
    const map: Record<string, DM04Message[]> = {}
    for (const m of allMessages) {
      if (!m.isThread || m.deleted) continue
      const rootId = m.rootRef || m.replyTo
      if (!rootId) continue
      if (!map[rootId]) map[rootId] = []
      map[rootId].push(m)
    }
    // Sort each group by time
    for (const key in map) {
      map[key].sort((a, b) => a.createdAt - b.createdAt)
    }
    return map
  }, [allMessages])

  // Get a message by ID for reply preview
  const getMessageById = useCallback((id: string): DM04Message | undefined => {
    return allMessages.find((m) => m.id === id)
  }, [allMessages])

  // Track whether user is near bottom (column-reverse: scrollTop=0 is bottom)
  const isAtBottomRef = useRef(true)
  const handleScroll = useCallback(() => {
    const el = messagesContainerRef.current
    if (!el) return
    const threshold = 80
    isAtBottomRef.current = Math.abs(el.scrollTop) < threshold
  }, [])

  // Auto-scroll on new messages — only if user is near bottom
  const prevMsgCountRef = useRef(mainMessages.length)
  useEffect(() => {
    if (mainMessages.length > prevMsgCountRef.current && isAtBottomRef.current) {
      if (messagesContainerRef.current) messagesContainerRef.current.scrollTop = 0
    } else if (prevMsgCountRef.current === 0 && mainMessages.length > 0) {
      if (messagesContainerRef.current) messagesContainerRef.current.scrollTop = 0
    }
    prevMsgCountRef.current = mainMessages.length
  }, [mainMessages.length])

  // Also scroll when optimistic messages are added (user sends)
  useEffect(() => {
    if (optimisticMessages.length > 0) {
      if (messagesContainerRef.current) messagesContainerRef.current.scrollTop = 0
      isAtBottomRef.current = true
    }
  }, [optimisticMessages.length])

  // Reconcile optimistic messages with store — remove when real message appears
  useEffect(() => {
    if (optimisticMessages.length === 0) return
    const toRemove = optimisticMessages.filter((opt) =>
      mainMessages.some((m) =>
        m.isMine &&
        m.content === opt.content &&
        Math.abs(m.createdAt - opt.timestamp) < 10
      )
    )
    if (toRemove.length > 0) {
      const removeIds = new Set(toRemove.map((o) => o.tempId))
      // Small delay so the transition is visible briefly
      const timer = setTimeout(() => {
        setOptimisticMessages((prev) => prev.filter((m) => !removeIds.has(m.tempId)))
      }, 300)
      return () => clearTimeout(timer)
    }
  }, [mainMessages, optimisticMessages])

  // Safety net: remove stale published optimistic messages after 30s
  useEffect(() => {
    if (optimisticMessages.length === 0) return
    const now = Math.floor(Date.now() / 1000)
    const stale = optimisticMessages.filter(
      (opt) => opt.status === 'published' && (now - opt.timestamp) > 30
    )
    if (stale.length > 0) {
      const staleIds = new Set(stale.map((o) => o.tempId))
      setOptimisticMessages((prev) => prev.filter((m) => !staleIds.has(m.tempId)))
    }
  }, [optimisticMessages])

  // Auto-load older messages when viewport isn't full (can't scroll to trigger pagination)
  // Triggers on conversation open and after each batch of older messages arrives
  useEffect(() => {
    if (!hasNip04 || !myPubkey || loadingOlder || !hasMore) return
    // Small delay to let the DOM render
    const timer = setTimeout(() => {
      const el = messagesContainerRef.current
      if (!el) return
      // If content doesn't overflow (no scrollbar), auto-load more
      if (el.scrollHeight <= el.clientHeight + 10) {
        loadOlderMessages(recipientPubkey, myPubkey, signer, privateKey)
      }
    }, 200)
    return () => clearTimeout(timer)
  }, [recipientPubkey, mainMessages.length, hasMore, loadingOlder, hasNip04, myPubkey])

  // Scroll to a specific message
  const scrollToMessage = useCallback((messageId: string) => {
    const el = document.getElementById(`dm04-msg-${messageId}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlightedId(messageId)
      setTimeout(() => setHighlightedId(null), 2000)
    }
  }, [])

  const handleReply = useCallback((msg: DM04Message) => {
    const p = getProfile(msg.senderPubkey)
    setReplyContext({
      eventId: msg.id,
      pubkey: msg.senderPubkey,
      displayName: p?.display_name || p?.name || truncateNpub(nip19.npubEncode(msg.senderPubkey)),
      content: msg.content,
    })
  }, [getProfile])

  const handleThreadReply = useCallback((msg: DM04Message) => {
    setThreadModalParent(msg)
  }, [])

  const handleSend = useCallback(async (attachments?: FileAttachment[]) => {
    const text = message.trim()
    if (!text && !attachments?.length && pendingStickers.length === 0 && pendingGifs.length === 0) return
    if (!myPubkey || sending) return

    setSending(true)
    setSendError(null)

    let content = text
    if (attachments && attachments.length > 0) {
      // Bare hash URL — standard Blossom format (BUD-01), universally supported.
      // useBlossomMedia handles server failover across all configured servers.
      const links = attachments.map((a) => `https://blossom.primal.net/${a.hash}`)
      content = content ? `${content}\n${links.join('\n')}` : links.join('\n')
    }

    // Append GIF URLs to content (like normal media uploads)
    if (pendingGifs.length > 0) {
      const gifLinks = pendingGifs.map((g) => g.url).join('\n')
      content = content ? `${content}\n${gifLinks}` : gifLinks
    }

    const tempId = `opt-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setMessage('')
    clearDraft(_dm04Key)

    // Add optimistic message immediately
    setOptimisticMessages((prev) => [
      ...prev,
      {
        tempId,
        content,
        timestamp: Math.floor(Date.now() / 1000),
        status: 'publishing',
        replyDisplayName: replyContext?.displayName,
        replyPreview: replyContext?.content?.slice(0, 60),
      },
    ])

    try {
      // Extract NIP-30 emoji tags from message content
      const emojiMap = getEmojiMap()
      const emojiShortcodes = content.match(/:([a-zA-Z0-9_-]+):/g)
      const emojiTagsToSend: [string, string, string, string][] = []
      if (emojiShortcodes) {
        const seen = new Set<string>()
        for (const match of emojiShortcodes) {
          const sc = match.slice(1, -1)
          if (seen.has(sc)) continue
          seen.add(sc)
          const entry = emojiMap.get(sc)
          if (entry) emojiTagsToSend.push(['emoji', sc, entry.url, entry.setAddress || ''])
        }
      }

      // Build sticker tags from pending stickers
      const stickerTagsToSend: [string, string, string, string][] = pendingStickers.map((s) => [
        'sticker', s.shortcode, s.url, s.setAddress,
      ])

      await sendMessage(
        recipientPubkey, content, myPubkey, signer, privateKey,
        replyContext?.eventId, undefined, false,
        (phase, relayProgress) => {
          setOptimisticMessages((prev) =>
            prev.map((m) => {
              if (m.tempId !== tempId) return m
              if (phase === 'publishing' && relayProgress && relayProgress.confirmed > 0) {
                return { ...m, status: 'published' as const, relayProgress }
              }
              return { ...m, status: phase, relayProgress: relayProgress || m.relayProgress }
            })
          )
        },
        emojiTagsToSend.length > 0 ? emojiTagsToSend : undefined,
        stickerTagsToSend.length > 0 ? stickerTagsToSend : undefined,
        pendingGifs.length > 0
          ? pendingGifs.map((g): [string, string, string, string] => ['j', g.name, g.url, g.nsfw ? 'nsfw' : 'sfw'])
          : undefined,
      )
      setReplyContext(null)
      setPendingStickers([])
      setPendingGifs([])
      // Optimistic removal is handled by the reconciliation useEffect
    } catch (err) {
      console.error('[DM04] Send failed:', err)
      setSendError((err as Error).message)
      setOptimisticMessages((prev) =>
        prev.map((m) => (m.tempId === tempId ? { ...m, status: 'failed' as const } : m))
      )
      setMessage(text)
    } finally {
      setSending(false)
    }
  }, [message, myPubkey, recipientPubkey, signer, privateKey, sendMessage, sending, replyContext, pendingStickers, pendingGifs])

  const handleAddReaction = useCallback(async (messageId: string, msgPubkey: string, emoji: string, customUrl?: string) => {
    if (!myPubkey) return
    await addReaction(messageId, msgPubkey, emoji, myPubkey, recipientPubkey, signer, privateKey, customUrl)
  }, [myPubkey, recipientPubkey, signer, privateKey, addReaction])

  // Reply banner for input
  const replyBanner = replyContext ? (
    <div className="flex items-center gap-2 px-3 py-2 bg-secondary/80 border border-border border-b-0 rounded-t-xl">
      <Reply size={14} className="text-primary shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="text-xs font-medium text-primary">{replyContext.displayName}</span>
        <p className="text-xs text-muted-foreground truncate">{replyContext.content}</p>
      </div>
      <button onClick={() => setReplyContext(null)} className="p-0.5 rounded hover:bg-accent/50 text-muted-foreground cursor-pointer">
        <X size={14} />
      </button>
    </div>
  ) : null

  return (
    <div ref={chatContainerRef} className="flex flex-col flex-1 min-w-0 h-full overflow-hidden relative">
      {/* Chat header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0 bg-background">
        {onBack && (
          <button onClick={onBack} className="hidden max-[1080px]:flex p-1.5 -ml-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer shrink-0">
            <ChevronLeft size={18} />
          </button>
        )}
        <div
          className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer hover:opacity-80 transition-opacity"
          onClick={() => setShowProfile(true)}
        >
          <Avatar className="h-8 w-8">
            {profile?.picture && <AvatarImage src={profile.picture} />}
            <AvatarFallback className="text-xs bg-primary/20 text-primary">
              {(profile?.display_name || profile?.name || npubStr).slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground truncate">
              {profile?.display_name || profile?.name || truncateNpub(npubStr, 10)}
            </p>
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Shield size={9} />
              <span>Private (NIP-04 Encrypted)</span>
            </div>
          </div>
        </div>
        {onSwitchProtocol && (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onSwitchProtocol}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 border border-border/50 transition-colors cursor-pointer shrink-0"
                >
                  <ShieldCheck size={12} /> Switch to Extra Private
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs max-w-[200px]">
                Switch to NIP-17 Extra Private mode. Hides message metadata from relays.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      {/* Messages */}
      <div
        ref={messagesContainerRef}
        className="flex-1 min-h-0 overflow-y-auto flex flex-col-reverse px-4 py-3"
        onScroll={() => {
          handleScroll()
          const el = messagesContainerRef.current
          if (!el || loadingOlder || !hasMore || !hasNip04 || !myPubkey) return
          // With column-reverse, scrolling towards older = scrollTop goes more negative
          if (el.scrollHeight + el.scrollTop - el.clientHeight < 60) {
            loadOlderMessages(recipientPubkey, myPubkey, signer, privateKey)
          }
        }}
      >
        <div className="relative">
        {/* Floating unread banner */}
        {showUnreadBanner && (
          <UnreadBanner
            count={newMsgUnreadCount}
            sinceTimestamp={newMsgSnapshot}
            onJump={jumpToNewMsgDivider}
            onDismiss={dismissUnreadBanner}
          />
        )}
        <div>
          {loadingOlder && (
            <div className="flex items-center justify-center py-3 text-muted-foreground">
              <Loader2 size={14} className="animate-spin mr-2" />
              <span className="text-xs">Loading older messages...</span>
            </div>
          )}

          {mainMessages.length === 0 ? (
            registryOnlyContacts.has(recipientPubkey) ? (
              /* Loading state for contacts loaded from NIP-78 registry (not yet per-person fetched) */
              <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center animate-pulse">
                  <Loader2 size={24} className="text-primary animate-spin" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">Loading messages…</p>
                  <p className="text-xs text-muted-foreground mt-1 max-w-[250px]">
                    Fetching conversation history with{' '}
                    <span className="font-medium">{profile?.display_name || profile?.name || truncateNpub(npubStr, 8)}</span>
                  </p>
                </div>
                {/* Skeleton message placeholders */}
                <div className="w-full max-w-md space-y-3 px-4 mt-2">
                  {[0.7, 0.5, 0.85].map((w, i) => (
                    <div key={i} className="flex gap-3 animate-pulse">
                      <div className="w-8 h-8 rounded-full bg-muted/40 shrink-0" />
                      <div className="flex-1 space-y-1.5">
                        <div className="h-3 bg-muted/40 rounded" style={{ width: '30%' }} />
                        <div className="h-3 bg-muted/30 rounded" style={{ width: `${w * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Lock size={24} className="text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">Start a private conversation</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-[250px]">
                  Messages are encrypted using NIP-04. Replies, threads, and reactions are supported.
                </p>
              </div>
            </div>
            )
          ) : (
            <div>
              {mainMessages.map((msg, i) => {
                const prev = i > 0 ? mainMessages[i - 1] : null
                const showDateSep = !prev || isDifferentDay(prev.createdAt, msg.createdAt)
                const senderPubkey = msg.senderPubkey
                const prevSender = prev?.senderPubkey
                const hasReply = !!msg.replyTo
                const isGrouped = prev
                  && senderPubkey === prevSender
                  && !showDateSep
                  && !hasReply
                  && (msg.createdAt - prev.createdAt) <= GROUP_WINDOW_S

                const repliedMsg = msg.replyTo ? getMessageById(msg.replyTo) : undefined
                const replyStatus = msg.replyTo ? (repliedMsg ? (repliedMsg.deleted ? 'deleted' : 'found') : 'not-found') : undefined

                const reactions = getReactions(msg.id, myPubkey || '')
                const threadReplies = threadRepliesMap[msg.id]

                return (
                  <div key={msg.id}>
                    {shouldInsertDivider(msg.createdAt, prev ? prev.createdAt : null, msg.senderPubkey) && (
                      <NewMessagesDivider ref={newMsgDividerRef} hidden={dividerHidden} />
                    )}
                    <DM04MessageRow
                      msg={msg}
                      showDateSep={showDateSep}
                      isGrouped={!!isGrouped}
                      isMine={msg.isMine}
                      highlighted={highlightedId === msg.id}
                      repliedMessage={repliedMsg}
                      replyStatus={replyStatus}
                      reactions={reactions}
                      onReply={() => handleReply(msg)}
                      onThreadReply={() => handleThreadReply(msg)}
                      onAddReaction={(emoji, customUrl) => handleAddReaction(msg.id, msg.senderPubkey, emoji, customUrl)}
                      onScrollToMessage={scrollToMessage}
                      onViewRaw={() => msg.rawEvent && setRawEventData({ rawJson: msg.rawEvent, decryptedContent: msg.content })}
                      onRequestDelete={() => setDeleteModalMsg(msg)}
                      onShowProfile={() => !msg.isMine && setShowProfile(true)}
                      getProfile={getProfile}
                      myPubkey={myPubkey}
                    />
                    {/* Thread indicator — hub-chat-style rich button */}
                    {threadReplies && threadReplies.length > 0 && (() => {
                      const latest = threadReplies[threadReplies.length - 1]
                      const latestProfile = getProfile(latest.senderPubkey)
                      const latestName = latestProfile?.display_name || latestProfile?.name || truncateNpub(nip19.npubEncode(latest.senderPubkey))
                      return (
                        <button
                          onClick={() => setThreadModalParent(msg)}
                          className="flex items-center gap-2 ml-12 mt-0.5 mb-1 px-3 py-1.5 rounded-md bg-primary/5 hover:bg-primary/10 border border-primary/15 transition-colors cursor-pointer group"
                        >
                          <MessageSquarePlus size={14} className="text-primary/70 shrink-0" />
                          <span className="text-xs font-semibold text-primary">{threadReplies.length} {threadReplies.length === 1 ? 'Thread Reply' : 'Thread Replies'}</span>
                          <span className="text-[10px] text-muted-foreground mx-1">·</span>
                          <Avatar className="w-4 h-4">
                            <AvatarImage src={latestProfile?.picture} />
                            <AvatarFallback className="text-[8px] bg-muted">{latestName.slice(0, 2)}</AvatarFallback>
                          </Avatar>
                          <span className="text-xs text-foreground/70 truncate max-w-[200px]">{latestName}</span>
                          <span className="text-xs text-muted-foreground truncate max-w-[150px] opacity-70">{latest.content.slice(0, 40)}{latest.content.length > 40 ? '…' : ''}</span>
                          <span className="text-[10px] text-muted-foreground ml-auto shrink-0">{formatShortTime(latest.createdAt)}</span>
                        </button>
                      )
                    })()}
                  </div>
                )
              })}

              {/* Optimistic messages (hub-chat-style publishing/relay progress) */}
              {optimisticMessages.filter((o) =>
                !mainMessages.some((m) =>
                  m.isMine && m.content === o.content && Math.abs(m.createdAt - o.timestamp) < 10
                )
              ).map((optMsg) => (
                <div
                  key={optMsg.tempId}
                  className={`flex gap-3 mt-4 py-1 px-2 rounded-md -mx-2 transition-opacity ${optMsg.status === 'published' ? 'opacity-70' : 'opacity-50'}`}
                >
                  <div className="w-10 shrink-0 flex flex-col items-center">
                    {optMsg.replyDisplayName && (
                      <div className="w-full flex">
                        <div
                          className="ml-auto border-l-2 border-t-2 border-muted-foreground/30 rounded-tl-md"
                          style={{ width: 20, height: 10 }}
                        />
                      </div>
                    )}
                    <Avatar className="h-10 w-10 shrink-0">
                      {myAvatar && <AvatarImage src={myAvatar} alt={myDisplayName} />}
                      <AvatarFallback className="text-xs bg-primary/20 text-primary">
                        {myDisplayName.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                  </div>
                  <div className="min-w-0 flex-1">
                    {optMsg.replyDisplayName && (
                      <div className="flex items-center gap-1 pb-0.5">
                        <span className="text-xs font-semibold text-foreground/70">{optMsg.replyDisplayName}</span>
                        <span className="text-xs truncate text-muted-foreground/60">{optMsg.replyPreview}</span>
                      </div>
                    )}
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-semibold text-foreground">{myDisplayName}</span>
                      <span className="text-xs text-muted-foreground">{formatShortTime(optMsg.timestamp)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="text-sm text-foreground/90 break-words"><MessageContent content={optMsg.content} /></div>
                      {optMsg.status === 'publishing' && !optMsg.relayProgress?.confirmed && (
                        <span className="text-[10px] text-muted-foreground italic whitespace-nowrap">
                          publishing...
                        </span>
                      )}
                      {optMsg.status === 'publishing' && optMsg.relayProgress && optMsg.relayProgress.confirmed > 0 && (
                        <span className="text-[10px] text-muted-foreground/60 flex items-center gap-1 whitespace-nowrap">
                          <Loader2 size={9} className="animate-spin" />
                          {optMsg.relayProgress.confirmed}/{optMsg.relayProgress.total}
                        </span>
                      )}
                      {optMsg.status === 'published' && <Check size={13} className="text-green-500 shrink-0" />}
                      {optMsg.status === 'failed' && (
                        <div className="flex items-center gap-1 shrink-0">
                          <X size={13} className="text-destructive" />
                          <TooltipProvider delayDuration={300}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  onClick={() => setOptimisticMessages((prev) => prev.filter((m) => m.tempId !== optMsg.tempId))}
                                  className="p-0.5 rounded cursor-pointer text-muted-foreground hover:text-destructive transition-colors"
                                >
                                  <X size={12} />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="text-xs">Dismiss</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
        </div>
      </div>

      {/* NIP-04 unavailable banner */}
      {!hasNip04 && (
        <div className="mx-2 mb-1 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400 flex items-center gap-2">
          <AlertCircle size={14} className="shrink-0" />
          <span>Your login method doesn't support NIP-04 encryption.</span>
        </div>
      )}

      {/* Send error toast */}
      {sendError && (
        <div className="mx-2 mb-1 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/20 text-xs text-destructive flex items-center gap-2">
          <AlertCircle size={14} className="shrink-0" />
          <span className="flex-1 truncate">{sendError}</span>
          <button onClick={() => setSendError(null)} className="p-0.5 rounded hover:bg-destructive/20 transition-colors cursor-pointer">
            <X size={12} />
          </button>
        </div>
      )}

      {/* Pending stickers preview */}
      {pendingStickers.length > 0 && (
        <div className="mx-2 mb-1 px-3 py-2 rounded-lg bg-secondary/60 border border-border">
          <p className="text-[10px] text-muted-foreground mb-1">Stickers to send:</p>
          <div className="flex flex-wrap gap-2">
            {pendingStickers.map((s, i) => (
              <div key={`${s.shortcode}-${i}`} className="relative group">
                <img src={s.url} alt={`:${s.shortcode}:`} className="w-14 h-14 object-contain rounded-lg bg-muted/30 p-1" />
                <button
                  onClick={() => setPendingStickers((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-destructive text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pending GIFs preview */}
      {pendingGifs.length > 0 && (
        <div className="mx-2 mb-1 px-3 py-2 rounded-lg bg-secondary/60 border border-border">
          <p className="text-[10px] text-muted-foreground mb-1">GIFs to send:</p>
          <div className="flex flex-wrap gap-2">
            {pendingGifs.map((g, i) => (
              <div key={`${g.url}-${i}`} className="relative group">
                <img src={g.url} alt={g.name || 'GIF'} className="w-14 h-14 object-cover rounded-lg bg-muted/30 p-1" />
                <button
                  onClick={() => setPendingGifs((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-destructive text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Input */}
      <ChatInputBar
        draftKey={_dm04Key}
        message={message}
        onMessageChange={setMessage}
        onSend={handleSend}
        disabled={!hasNip04}
        sending={sending}
        canSend={(message.trim() || pendingStickers.length > 0 || pendingGifs.length > 0) ? true : undefined}
        placeholder={hasNip04
          ? `Message ${profile?.display_name || profile?.name || truncateNpub(npubStr, 8)}`
          : 'NIP-04 encryption unavailable'
        }
        topContent={replyBanner}
        hasTopContent={!!replyContext}
        enableFileUpload={hasNip04}
        signer={signer}
        privateKey={privateKey}

        dragContainerRef={chatContainerRef}
        onStickerSelect={(sticker) => setPendingStickers((prev) => [...prev, sticker])}
        onGifSelect={(gif) => setPendingGifs((prev) => [...prev, gif])}
      />

      {/* Profile modal */}
      <UserProfileModal
        open={showProfile}
        onClose={() => setShowProfile(false)}
        targetPubkey={recipientPubkey}
      />

      {/* Delete confirm dialog */}
      {deleteModalMsg && (
        <DeleteConfirmDialog
          onCancel={() => setDeleteModalMsg(null)}
          onConfirm={async () => {
            if (myPubkey && deleteModalMsg) {
              await deleteMessage(deleteModalMsg.id, myPubkey, signer, privateKey)
              setDeleteModalMsg(null)
            }
          }}
        />
      )}

      {/* Raw event modal */}
      {rawEventData && (
        <RawEventModal
          rawJson={rawEventData.rawJson}
          decryptedContent={rawEventData.decryptedContent}
          isDecrypted={true}
          onClose={() => setRawEventData(null)}
        />
      )}

      {/* Thread modal */}
      {threadModalParent && (
        <DM04ThreadModal
          parentMsg={threadModalParent}
          threadReplies={threadRepliesMap[threadModalParent.id] || []}
          recipientPubkey={recipientPubkey}
          getProfile={getProfile}
          onClose={() => setThreadModalParent(null)}
        />
      )}

      {/* Emoji click info modal */}
      {clickedEmoji && createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) setClickedEmoji(null) }}>
          <div className="w-[340px] bg-card border border-border rounded-xl shadow-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <img src={clickedEmoji.url} alt={`:${clickedEmoji.shortcode}:`} className="w-12 h-12 object-contain rounded-lg bg-muted/30 p-1.5" />
              <div>
                <p className="text-sm font-semibold text-foreground">:{clickedEmoji.shortcode}:</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Custom emoji</p>
              </div>
            </div>

            {clickedEmoji.setAddress ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  This emoji is part of set <span className="font-mono text-foreground/80">{clickedEmoji.setAddress.split(':').slice(2).join(':').replace(/[-_]/g, ' ')}</span>
                </p>
                <button
                  onClick={() => {
                    const parts = clickedEmoji.setAddress!.split(':')
                    const pubkey = parts[1]
                    const dTag = parts.slice(2).join(':')
                    const npub = nip19.npubEncode(pubkey)
                    setClickedEmoji(null)
                    setDiscoverSearch({ search: dTag, author: npub })
                  }}
                  className="w-full h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  Find this set
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3">
                  <div className="flex items-start gap-2">
                    <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      This emoji is not part of any emoji set. To use it, you'll need to download the image and upload it to one of your own sets.
                    </p>
                  </div>
                </div>
                <a
                  href={clickedEmoji.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-1.5 w-full h-9 rounded-lg bg-secondary border border-border text-foreground text-sm font-medium hover:bg-muted transition-colors cursor-pointer"
                >
                  <Download size={14} />
                  Download Image
                </a>
              </div>
            )}

            <button onClick={() => setClickedEmoji(null)} className="w-full h-8 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer">
              Close
            </button>
          </div>
        </div>,
        document.body
      )}

      {/* Standalone emoji discovery modal */}
      {discoverSearch && (
        <EmojiDiscoveryModal
          onClose={() => setDiscoverSearch(null)}
          initialSearch={discoverSearch.search}
          initialAuthor={discoverSearch.author}
        />
      )}

      {/* Sticker click modal */}
      {clickedSticker && createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) setClickedSticker(null) }}>
          <div className="w-[340px] bg-card border border-border rounded-xl shadow-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <img src={clickedSticker.url} alt={`:${clickedSticker.shortcode}:`} className="w-16 h-16 object-contain rounded-lg bg-muted/30 p-1.5" />
              <div>
                <p className="text-sm font-semibold text-foreground">:{clickedSticker.shortcode}:</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Custom sticker</p>
              </div>
            </div>
            {clickedSticker.setAddress ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  This sticker is part of set <span className="font-mono text-foreground/80">{clickedSticker.setAddress.split(':').slice(2).join(':').replace(/[-_]/g, ' ')}</span>
                </p>
                <button
                  onClick={() => {
                    const parts = clickedSticker.setAddress!.split(':')
                    const pubkey = parts[1]
                    const dTag = parts.slice(2).join(':')
                    const npub = nip19.npubEncode(pubkey)
                    setClickedSticker(null)
                    setStickerDiscoverSearch({ search: dTag, author: npub })
                  }}
                  className="w-full h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  Find this set
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3">
                  <div className="flex items-start gap-2">
                    <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      This sticker is not part of any sticker set. To use it, you'll need to download the image and upload it to one of your own sets.
                    </p>
                  </div>
                </div>
                <a
                  href={clickedSticker.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-1.5 w-full h-9 rounded-lg bg-secondary border border-border text-foreground text-sm font-medium hover:bg-muted transition-colors cursor-pointer"
                >
                  <Download size={14} />
                  Download Image
                </a>
              </div>
            )}
            <button onClick={() => setClickedSticker(null)} className="w-full h-8 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer">
              Close
            </button>
          </div>
        </div>,
        document.body
      )}

      {/* Standalone sticker discovery modal */}
      {stickerDiscoverSearch && (
        <StickerDiscoveryModal
          onClose={() => setStickerDiscoverSearch(null)}
          initialSearch={stickerDiscoverSearch.search}
          initialAuthor={stickerDiscoverSearch.author}
        />
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════ */
/*  DM04 RELAY PROGRESS INDICATOR              */
/* ═══════════════════════════════════════════ */

function DM04RelayProgressIndicator({ eventId }: { eventId: string }) {
  const progress = useDM04Store((s) => s.relayProgress[eventId])
  const [showPopover, setShowPopover] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showPopover) return
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setShowPopover(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showPopover])

  if (!progress) return null
  const done = progress.confirmed >= progress.total
  return (
    <span className="relative inline-flex items-center">
      <button
        onClick={(e) => { e.stopPropagation(); setShowPopover(!showPopover) }}
        className={`text-[10px] inline-flex items-center gap-1 ml-1 cursor-pointer hover:text-muted-foreground transition-colors ${done ? 'text-muted-foreground/40' : 'text-muted-foreground/70'}`}
      >
        {!done && <Loader2 size={9} className="animate-spin" />}
        {progress.confirmed}/{progress.total}
      </button>
      {showPopover && (
        <div ref={popRef} className="absolute bottom-full left-0 mb-1 z-50 bg-popover border border-border rounded-lg shadow-xl p-2.5 min-w-[200px]" onClick={(e) => e.stopPropagation()}>
          <p className="text-[10px] font-medium text-foreground mb-1.5">Relay Status</p>
          <div className="space-y-1">
            {progress.acceptedRelays.map((url) => (
              <div key={url} className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                <span className="text-[10px] text-muted-foreground font-mono truncate">{url.replace('wss://', '')}</span>
              </div>
            ))}
            {progress.confirmed < progress.total && (
              <div className="flex items-center gap-2">
                <Loader2 size={8} className="animate-spin text-muted-foreground/50 shrink-0" />
                <span className="text-[10px] text-muted-foreground/50">{progress.total - progress.confirmed} pending...</span>
              </div>
            )}
          </div>
        </div>
      )}
    </span>
  )
}

/* ═══════════════════════════════════════════ */
/*  DM04 MESSAGE ROW                           */
/* ═══════════════════════════════════════════ */

function DM04MessageRow({
  msg, showDateSep, isGrouped, isMine, highlighted,
  repliedMessage, replyStatus, reactions,
  onReply, onThreadReply, onAddReaction, onScrollToMessage,
  onViewRaw, onRequestDelete, onShowProfile, getProfile, myPubkey,
}: {
  msg: DM04Message
  showDateSep: boolean
  isGrouped: boolean
  isMine: boolean
  highlighted: boolean
  repliedMessage?: DM04Message
  replyStatus?: 'found' | 'not-found' | 'deleted'
  reactions: DM04Reaction[]
  onReply: () => void
  onThreadReply: () => void
  onAddReaction: (emoji: string, customUrl?: string) => void
  onScrollToMessage: (id: string) => void
  onViewRaw: () => void
  onRequestDelete: () => void
  onShowProfile: () => void
  getProfile: (pk: string) => any
  myPubkey: string | null
}) {
  const [showActions, setShowActions] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  const emojiButtonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const dotsRef = useRef<HTMLButtonElement>(null)

  const [blockedRevealed, setBlockedRevealed] = useState(false)
  const isBlockedUser = useBlockStore((s) => s.isBlocked)(msg.senderPubkey)
  const hideBlockedCompletely = useBlockStore((s) => s.hideBlockedCompletely)
  const mutedWords = useBlockStore((s) => s.mutedWords)

  // Relay progress — dim own messages that haven't been accepted by any relay yet
  const relayPending = useDM04Store((s) => {
    const p = s.relayProgress[msg.id]
    return p && p.confirmed === 0
  })

  const senderProfile = getProfile(msg.senderPubkey)
  const displayName = senderProfile?.display_name || senderProfile?.name || truncateNpub(nip19.npubEncode(msg.senderPubkey))

  // Close menu on outside click
  useEffect(() => {
    if (!showMenu) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('[data-emoji-picker]')) return
      if (menuRef.current && !menuRef.current.contains(target) &&
        dotsRef.current && !dotsRef.current.contains(target)) {
        setShowMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showMenu])

  // Edge-aware: decide if menu should open up or down based on actual menu height
  useEffect(() => {
    if (!showMenu || !dotsRef.current) return
    const raf = requestAnimationFrame(() => {
      const menuEl = menuRef.current?.querySelector('[data-action-menu]') as HTMLElement | null
      const dotsRect = dotsRef.current!.getBoundingClientRect()
      const menuHeight = menuEl?.offsetHeight || 300
      const spaceBelow = window.innerHeight - dotsRect.bottom - 8
      const spaceAbove = dotsRect.top - 8
      setDropUp(spaceBelow < menuHeight && spaceAbove > menuHeight)
    })
    return () => cancelAnimationFrame(raf)
  }, [showMenu])

  if (!isMine && isBlockedUser && hideBlockedCompletely) return null

  const shouldBlurBlocked = !isMine && isBlockedUser && !blockedRevealed

  // Shared content block (used by both grouped and ungrouped)
  const contentBlock = (
    <>
      <div className="flex-1 min-w-0">
        {!isGrouped && (
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-sm font-semibold text-foreground cursor-pointer hover:underline" onClick={onShowProfile}>
              {displayName}
            </span>
            <DnnBadge pubkey={msg.senderPubkey} />
            <span className="text-[11px] text-muted-foreground">{formatTimestamp(msg.createdAt)}</span>
            {msg.clientTag && (
              <span className="text-[10px] text-muted-foreground/50">· via {msg.clientTag}</span>
            )}
          </div>
        )}

        <ScrollableContent>
        {shouldBlurBlocked ? (
          <div className="flex items-center gap-2.5 py-1.5 px-3 my-1 rounded-lg bg-muted/50 border border-border/50">
            <ShieldBan size={14} className="text-destructive/70 shrink-0" />
            <span className="text-xs text-muted-foreground">Message hidden — blocked user</span>
            <button
              onClick={() => setBlockedRevealed(true)}
              className="flex items-center gap-1 ml-auto text-xs font-medium text-primary hover:text-primary/80 bg-primary/10 hover:bg-primary/15 px-2.5 py-1 rounded-full transition-colors cursor-pointer"
            >
              <Eye size={12} /> Show
            </button>
          </div>
        ) : (
          <>
            {(() => {
              // Extract GIF URLs from content — render them via DMGifStarOverlay (with star + blossom failover)
              const gifUrlRegex = /https?:\/\/\S+\.gif(?:\?\S*)?/gi
              const contentGifUrls = msg.content.match(gifUrlRegex) || []
              const afterGifStrip = contentGifUrls.length > 0
                ? msg.content.split('\n').filter((l: string) => !contentGifUrls.some((u) => l.trim() === u)).join('\n').trim()
                : msg.content
              // Extract grouped image URLs from remaining content
              const { groups: mediaGroups, strippedContent: filteredContent } = extractContentMediaGroups(afterGifStrip)
              return (
                <>
                  {filteredContent && (
                    <div className={`text-sm text-foreground/90 break-words prose-sm [&_p]:m-0 [&_pre]:my-1 [&_code]:text-xs transition-opacity ${relayPending ? 'opacity-50' : ''}`}>
                      <MessageContent content={filteredContent} emojiTags={msg.emojiTags} mutedWords={mutedWords} suffix={msg.isMine ? <DM04RelayProgressIndicator eventId={msg.id} /> : undefined} />
                    </div>
                  )}
                  {mediaGroups.length > 0 && (
                    <ContentMediaGroupsWithGallery content={afterGifStrip} />
                  )}
                  {contentGifUrls.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {contentGifUrls.map((gifUrl, i) => {
                        const gTag = msg.gifTags?.find(([, u]) => u === gifUrl)
                        return (
                          <DMGifStarOverlay
                            key={`gif-${gifUrl}-${i}`}
                            name={gTag?.[0] || ''}
                            url={gifUrl}
                            nsfw={gTag?.[2] || 'sfw'}
                          />
                        )
                      })}
                    </div>
                  )}
                  {/* Render g-tag GIFs NOT in content (fallback for older msgs) */}
                  {msg.gifTags && msg.gifTags.length > 0 && (() => {
                    const unmatched = msg.gifTags.filter(([, u]) => !msg.content.includes(u))
                    if (unmatched.length === 0) return null
                    return (
                      <div className="flex flex-wrap gap-2">
                        {unmatched.map(([name, url, nsfw], i) => (
                          <DMGifStarOverlay key={`gif-fallback-${url}-${i}`} name={name} url={url} nsfw={nsfw} />
                        ))}
                      </div>
                    )
                  })()}
                </>
              )
            })()}
            {/* Stickers */}
            {msg.stickerTags && msg.stickerTags.length > 0 && (
              <div className={`flex flex-wrap gap-2 ${msg.content ? 'mt-1' : ''}`}>
                {msg.stickerTags.map(([shortcode, url, setRef], i) => (
                  <TooltipProvider key={`sticker-${shortcode}-${i}`} delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <BlossomImg
                          src={url || ''}
                          alt={`:${shortcode}:`}
                          className="rounded-lg cursor-pointer hover:opacity-80 transition-opacity"
                          style={{ maxWidth: 180, maxHeight: 180, objectFit: 'contain' }}
                          loading="lazy"
                          showBadge
                          onClick={() => {
                            window.dispatchEvent(new CustomEvent('sticker-click', {
                              detail: { shortcode, url, setAddress: setRef || null },
                            }))
                          }}
                        />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">:{shortcode}:</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ))}
              </div>
            )}
          </>
        )}
        </ScrollableContent>

        {!isMine && isBlockedUser && blockedRevealed && (
          <button
            onClick={() => setBlockedRevealed(false)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-muted/60 px-2 py-0.5 rounded-full transition-colors cursor-pointer mt-1 w-fit"
          >
            <EyeOff size={11} /> Hide
          </button>
        )}

        {/* Reactions */}
        {reactions.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {reactions.map((r) => (
              <button
                key={r.emoji}
                onClick={() => onAddReaction(r.emoji, r.customUrl)}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs border transition-colors cursor-pointer ${r.reacted
                  ? 'bg-primary/15 border-primary/30 text-primary'
                  : 'bg-secondary/60 border-border hover:border-primary/20'
                  }`}
              >
                <span>{(() => {
                  if (r.customUrl) return <img src={r.customUrl} alt={r.emoji} className="h-4 w-4 object-contain inline" />
                  const scMatch = r.emoji.match(/^:([a-zA-Z0-9_-]+):$/)
                  if (scMatch) {
                    const entry = getEmojiMap().get(scMatch[1])
                    if (entry) return <img src={entry.url} alt={r.emoji} className="h-4 w-4 object-contain inline" />
                  }
                  return r.emoji
                })()}</span>
                <span className="text-[10px] font-medium">{r.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Action bar */}
      {showActions && !shouldBlurBlocked && (
        <TooltipProvider delayDuration={300}>
          <div
            className="absolute -top-3 right-2 flex items-center gap-0.5 bg-secondary border border-border rounded-md shadow-md px-0.5 py-0.5 z-10"
            onClick={(e) => e.stopPropagation()}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  ref={emojiButtonRef}
                  onClick={() => setShowEmoji(!showEmoji)}
                  className="p-1 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                >
                  <Smile size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">Add Reaction</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onReply}
                  className="p-1 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                >
                  <Reply size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">Reply</TooltipContent>
            </Tooltip>
            {/* More actions */}
            <div className="relative" ref={menuRef}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    ref={dotsRef}
                    onClick={() => setShowMenu(!showMenu)}
                    className="p-1 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  >
                    <MoreVertical size={16} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">More</TooltipContent>
              </Tooltip>
              {showMenu && (
                <div data-action-menu className={`absolute right-0 w-44 bg-popover border border-border rounded-lg shadow-xl p-1 flex flex-col gap-1 z-20 ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
                  <button
                    onClick={() => { navigator.clipboard.writeText(msg.content); setShowMenu(false) }}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
                  >
                    <Clipboard size={14} /> Copy Text
                  </button>
                  <button
                    onClick={() => { setShowMenu(false); onViewRaw() }}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
                  >
                    <Code size={14} /> View Raw Event
                  </button>
                  <button
                    onClick={() => { setShowMenu(false); onThreadReply() }}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
                  >
                    <MessageSquarePlus size={14} /> Thread Reply
                  </button>
                  {isMine && (
                    <button
                      onClick={() => { setShowMenu(false); onRequestDelete() }}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 cursor-pointer transition-colors rounded-md"
                    >
                      <Trash2 size={14} /> Delete Message
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </TooltipProvider>
      )}

      {/* Emoji picker */}
      {showEmoji && (
        <EmojiPickerPopover
          anchorRef={emojiButtonRef}
          onClose={() => { setShowEmoji(false); setShowActions(false) }}
          onSelect={(emoji, custom) => {
            onAddReaction(emoji, custom?.url)
            setShowEmoji(false)
            setShowActions(false)
          }}
        />
      )}
    </>
  )

  // ── Grouped (same user, within 5 min) ──
  if (isGrouped) {
    return (
      <div
        id={`dm04-msg-${msg.id}`}
        className={`group relative flex gap-3 py-0.5 px-2 rounded-md -mx-2 hover:bg-accent/30 transition-colors duration-100 ${highlighted ? 'bg-primary/10 ring-1 ring-primary/30' : ''}`}
        onMouseEnter={() => setShowActions(true)}
        onMouseLeave={() => { if (!showMenu && !showEmoji) setShowActions(false) }}
      >
        <div className="w-11 shrink-0 flex items-center justify-center">
          <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity select-none cursor-default">
            {formatShortTime(msg.createdAt)}
          </span>
        </div>
        {contentBlock}
      </div>
    )
  }

  // ── Full message (with avatar + name) ──
  return (
    <div className="mt-4">
      {showDateSep && (
        <div className="flex items-center gap-3 my-3">
          <div className="flex-1 h-px bg-border" />
          <span className="text-[11px] font-medium text-muted-foreground">{formatDaySeparator(msg.createdAt)}</span>
          <div className="flex-1 h-px bg-border" />
        </div>
      )}

      {/* Reply preview -- shown above the message if it's a reply */}
      {replyStatus === 'found' && repliedMessage && (
        <ReplyPreview repliedMessage={repliedMessage} getProfile={getProfile} onScrollTo={onScrollToMessage} />
      )}
      {replyStatus === 'not-found' && (
        <div className="flex gap-3 px-2 -mx-2 items-end">
          <div className="w-10 shrink-0 flex"><div className="ml-auto border-l-2 border-t-2 border-muted-foreground/20 rounded-tl-md" style={{ width: 20, height: 10 }} /></div>
          <span className="text-xs text-muted-foreground/50 italic pb-0.5">Original message not found</span>
        </div>
      )}
      {replyStatus === 'deleted' && (
        <div className="flex gap-3 px-2 -mx-2 items-end">
          <div className="w-10 shrink-0 flex"><div className="ml-auto border-l-2 border-t-2 border-muted-foreground/20 rounded-tl-md" style={{ width: 20, height: 10 }} /></div>
          <span className="text-xs text-muted-foreground/50 italic pb-0.5 line-through">Message deleted</span>
        </div>
      )}

      <div
        id={`dm04-msg-${msg.id}`}
        className={`group relative flex items-start gap-4 py-1 px-2 rounded-md -mx-2 hover:bg-accent/30 transition-colors duration-100 ${highlighted ? 'bg-primary/10 ring-1 ring-primary/30' : ''}`}
        onMouseEnter={() => setShowActions(true)}
        onMouseLeave={() => { if (!showMenu && !showEmoji) setShowActions(false) }}
      >
        <button onClick={onShowProfile} className="shrink-0 cursor-pointer">
          <Avatar className="h-10 w-10 mt-0.5">
            {senderProfile?.picture && <AvatarImage src={senderProfile.picture} alt={displayName} />}
            <AvatarFallback className="text-xs bg-primary/20 text-primary">
              {displayName.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </button>
        {contentBlock}
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════ */
/*  REPLY PREVIEW                              */
/* ═══════════════════════════════════════════ */

function ReplyPreview({ repliedMessage, getProfile, onScrollTo }: {
  repliedMessage: DM04Message
  getProfile: (pk: string) => any
  onScrollTo: (id: string) => void
}) {
  const p = getProfile(repliedMessage.senderPubkey)
  const name = p?.display_name || p?.name || truncateNpub(nip19.npubEncode(repliedMessage.senderPubkey))

  return (
    <button
      onClick={() => onScrollTo(repliedMessage.id)}
      className="flex gap-3 px-2 -mx-2 items-end cursor-pointer hover:opacity-80 transition-opacity w-full text-left"
    >
      {/* Same w-10 column as avatar -- connector anchored to center */}
      <div className="w-10 shrink-0 flex">
        <div
          className="ml-auto border-l-2 border-t-2 border-muted-foreground/30 rounded-tl-md"
          style={{ width: 20, height: 10 }}
        />
      </div>
      {/* Preview content -- aligns with message content column */}
      <div className="flex items-center gap-1 min-w-0 pb-0.5">
        <Avatar className="h-4 w-4 shrink-0">
          {p?.picture && <AvatarImage src={p.picture} alt={name} />}
          <AvatarFallback className="text-[8px] bg-primary/20 text-primary">
            {name.slice(0, 1).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <span className="text-xs font-semibold text-foreground/70 shrink-0">{name}</span>
        <span className="text-xs truncate text-muted-foreground/60">{repliedMessage.content.slice(0, 60)}</span>
      </div>
    </button>
  )
}

/* ═══════════════════════════════════════════ */
/*  THREAD MODAL                               */
/* ═══════════════════════════════════════════ */

function DM04ThreadModal({ parentMsg, threadReplies, recipientPubkey, getProfile, onClose }: {
  parentMsg: DM04Message
  threadReplies: DM04Message[]
  recipientPubkey: string
  getProfile: (pk: string) => any
  onClose: () => void
}) {
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const sendMessage = useDM04Store((s) => s.sendMessage)
  const getReactions = useDM04Store((s) => s.getReactions)
  const addReaction = useDM04Store((s) => s.addReaction)
  const mutedWords = useBlockStore((s) => s.mutedWords)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticDM04[]>([])
  const [inThreadReply, setInThreadReply] = useState<ReplyContext | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const modalContainerRef = useRef<HTMLDivElement>(null)

  const parentProfile = getProfile(parentMsg.senderPubkey)
  const parentName = parentProfile?.display_name || parentProfile?.name || truncateNpub(nip19.npubEncode(parentMsg.senderPubkey))

  const myProfile = getProfile(myPubkey || '')
  const myDisplayName = myProfile?.display_name || myProfile?.name || (myPubkey ? truncateNpub(nip19.npubEncode(myPubkey)) : 'You')
  const myAvatar = myProfile?.picture

  const GROUP_WINDOW = 5 * 60

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [threadReplies.length, optimisticMessages.length])

  const handleReplyInThread = useCallback((msg: DM04Message) => {
    if (msg.id === parentMsg.id) {
      setInThreadReply(null)
      return
    }
    const p = getProfile(msg.senderPubkey)
    const name = p?.display_name || p?.name || truncateNpub(nip19.npubEncode(msg.senderPubkey))
    setInThreadReply({
      eventId: msg.id,
      pubkey: msg.senderPubkey,
      displayName: name,
      content: msg.content,
      isThread: true,
    })
  }, [parentMsg.id, getProfile])

  const replyBanner = inThreadReply ? (
    <div className="flex items-center gap-2 px-3 py-2 bg-secondary/80 border border-border border-b-0 rounded-t-xl">
      <Reply size={14} className="text-primary shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="text-xs font-medium text-primary">{inThreadReply.displayName}</span>
        <p className="text-xs text-muted-foreground truncate">{inThreadReply.content}</p>
      </div>
      <button onClick={() => setInThreadReply(null)} className="p-0.5 rounded hover:bg-accent/50 text-muted-foreground cursor-pointer">
        <X size={14} />
      </button>
    </div>
  ) : null

  const handleSend = useCallback(async (attachments?: FileAttachment[]) => {
    const text = message.trim()
    if (!text && !attachments?.length) return
    if (!myPubkey || sending) return

    setSending(true)

    let content = text
    if (attachments && attachments.length > 0) {
      const links = attachments.map((a) => `https://blossom.primal.net/${a.hash}`)
      content = content ? `${content}\n${links.join('\n')}` : links.join('\n')
    }

    const tempId = `opt-thread-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setMessage('')

    setOptimisticMessages((prev) => [
      ...prev,
      {
        tempId,
        content,
        timestamp: Math.floor(Date.now() / 1000),
        status: 'publishing',
        replyDisplayName: inThreadReply?.displayName,
        replyPreview: inThreadReply?.content?.slice(0, 60),
      },
    ])

    try {
      const replyTo = inThreadReply?.eventId || parentMsg.id
      await sendMessage(
        recipientPubkey, content, myPubkey, signer, privateKey,
        replyTo,
        parentMsg.id, // rootRef — thread root is the parent
        true,         // isThread
        (phase, relayProgress) => {
          setOptimisticMessages((prev) =>
            prev.map((m) => {
              if (m.tempId !== tempId) return m
              if (phase === 'publishing' && relayProgress && relayProgress.confirmed > 0) {
                return { ...m, status: 'published' as const, relayProgress }
              }
              return { ...m, status: phase, relayProgress: relayProgress || m.relayProgress }
            })
          )
        },
      )
      setInThreadReply(null)
      setTimeout(() => {
        setOptimisticMessages((prev) => prev.filter((m) => m.tempId !== tempId))
      }, 3000)
    } catch (err) {
      console.error('[DM04 Thread] Send failed:', err)
      setOptimisticMessages((prev) =>
        prev.map((m) => (m.tempId === tempId ? { ...m, status: 'failed' as const } : m))
      )
      setMessage(text)
    } finally {
      setSending(false)
    }
  }, [message, myPubkey, recipientPubkey, signer, privateKey, sendMessage, sending, parentMsg.id, inThreadReply])

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        ref={modalContainerRef}
        className="w-full max-w-3xl h-[90vh] flex flex-col bg-background rounded-xl border border-border shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary/30 shrink-0">
          <div className="flex items-center gap-2">
            <MessageSquarePlus size={16} className="text-primary" />
            <span className="text-sm font-semibold text-foreground">Thread</span>
            <span className="text-xs text-muted-foreground">
              {threadReplies.length} {threadReplies.length === 1 ? 'reply' : 'replies'}
            </span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent/50 transition-colors cursor-pointer">
            <X size={16} className="text-muted-foreground" />
          </button>
        </div>

        {/* Scrollable body */}
        <TooltipProvider delayDuration={300}>
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
            {/* Parent message */}
            <div className="pb-2 mb-2 border-b border-border">
              <div className="flex gap-3 px-1 py-1">
                <Avatar className="h-10 w-10 shrink-0">
                  {parentProfile?.picture && <AvatarImage src={parentProfile.picture} />}
                  <AvatarFallback className="text-xs bg-primary/20 text-primary">{parentName.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 mb-0.5">
                    <span className="text-sm font-semibold text-foreground">{parentName}</span>
                    <span className="text-[11px] text-muted-foreground">{formatTimestamp(parentMsg.createdAt)}</span>
                  </div>
                  <div className="text-sm text-foreground/90 break-words prose-sm [&_p]:m-0">
                    <MessageContent content={parentMsg.content} emojiTags={parentMsg.emojiTags} mutedWords={mutedWords} />
                  </div>
                  {parentMsg.stickerTags && parentMsg.stickerTags.length > 0 && (
                    <div className={`flex flex-wrap gap-2 ${parentMsg.content ? 'mt-1' : ''}`}>
                      {parentMsg.stickerTags.map(([shortcode, url, setRef], i) => (
                        <TooltipProvider key={`sticker-${shortcode}-${i}`} delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <BlossomImg
                                src={url || ''}
                                alt={`:${shortcode}:`}
                                className="rounded-lg cursor-pointer hover:opacity-80 transition-opacity"
                                style={{ maxWidth: 120, maxHeight: 120, objectFit: 'contain' }}
                                loading="lazy"
                                showBadge
                                onClick={() => {
                                  window.dispatchEvent(new CustomEvent('sticker-click', {
                                    detail: { shortcode, url, setAddress: setRef || null },
                                  }))
                                }}
                              />
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-xs">:{shortcode}:</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Thread replies */}
            {threadReplies.map((reply, i) => {
              const prev = i > 0 ? threadReplies[i - 1] : null
              const rProfile = getProfile(reply.senderPubkey)
              const rName = rProfile?.display_name || rProfile?.name || truncateNpub(nip19.npubEncode(reply.senderPubkey))
              const isGrouped = prev && prev.senderPubkey === reply.senderPubkey && (reply.createdAt - prev.createdAt) <= GROUP_WINDOW
              const reactions = getReactions(reply.id, myPubkey || '')

              if (reply.deleted) return null

              return (
                <div key={reply.id} className={`group relative flex gap-3 px-1 py-0.5 hover:bg-secondary/40 rounded-md transition-colors ${isGrouped ? 'mt-0' : 'mt-3'}`}>
                  <div className="w-10 shrink-0 flex items-start justify-center pt-0.5">
                    {!isGrouped ? (
                      <Avatar className="h-10 w-10">
                        {rProfile?.picture && <AvatarImage src={rProfile.picture} />}
                        <AvatarFallback className="text-xs bg-primary/20 text-primary">{rName.slice(0, 2).toUpperCase()}</AvatarFallback>
                      </Avatar>
                    ) : (
                      <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity pt-1 select-none">
                        {formatShortTime(reply.createdAt)}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    {!isGrouped && (
                      <div className="flex items-baseline gap-2 mb-0.5">
                        <span className="text-sm font-semibold text-foreground">{rName}</span>
                        <span className="text-[11px] text-muted-foreground">{formatTimestamp(reply.createdAt)}</span>
                      </div>
                    )}
                    <div className="text-sm text-foreground/90 break-words prose-sm [&_p]:m-0 [&_pre]:my-1 [&_code]:text-xs">
                      <MessageContent content={reply.gifTags && reply.gifTags.length > 0 ? reply.content.split('\n').filter((l: string) => !reply.gifTags!.some(([, u]: [string, string, string]) => l.trim() === u)).join('\n').trim() : reply.content} emojiTags={reply.emojiTags} mutedWords={mutedWords} />
                    </div>
                    {reply.stickerTags && reply.stickerTags.length > 0 && (
                      <div className={`flex flex-wrap gap-2 ${reply.content ? 'mt-1' : ''}`}>
                        {reply.stickerTags.map(([shortcode, url, setRef], si) => (
                          <TooltipProvider key={`sticker-${shortcode}-${si}`} delayDuration={200}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <BlossomImg
                                  src={url || ''}
                                  alt={`:${shortcode}:`}
                                  className="rounded-lg cursor-pointer hover:opacity-80 transition-opacity"
                                  style={{ maxWidth: 120, maxHeight: 120, objectFit: 'contain' }}
                                  loading="lazy"
                                  showBadge
                                  onClick={() => {
                                    window.dispatchEvent(new CustomEvent('sticker-click', {
                                      detail: { shortcode, url, setAddress: setRef || null },
                                    }))
                                  }}
                                />
                              </TooltipTrigger>
                              <TooltipContent side="top" className="text-xs">:{shortcode}:</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ))}
                      </div>
                    )}
                    {/* GIFs in thread replies */}
                    {reply.gifTags && reply.gifTags.length > 0 && (
                      <div className={`flex flex-wrap gap-2 ${reply.content ? 'mt-1' : ''}`}>
                        {reply.gifTags.map(([name, url, nsfw], gi) => (
                          <div key={`gif-${url}-${gi}`} className="relative group/gif">
                            <TooltipProvider delayDuration={200}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <img
                                    src={url || ''}
                                    alt={name || 'GIF'}
                                    className={`rounded-lg hover:opacity-80 transition-opacity ${nsfw === 'nsfw' ? 'blur-lg hover:blur-none' : ''}`}
                                    style={{ maxWidth: 120, maxHeight: 120, objectFit: 'contain' }}
                                    loading="lazy"
                                  />
                                </TooltipTrigger>
                                <TooltipContent side="top" className="text-xs">{name || 'GIF'}{nsfw === 'nsfw' ? ' (NSFW)' : ''}</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            <TooltipProvider delayDuration={300}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    onClick={async (e) => {
                                      e.stopPropagation()
                                      const store = useGifStore.getState()
                                      const { signer: s, privateKey: pk } = useUserStore.getState()
                                      const exists = store.favorites.some((f) => f.url === url)
                                      const updated = exists ? store.favorites.filter((f) => f.url !== url) : [...store.favorites, { name: name || '', url, nsfw: nsfw === 'nsfw', tagged: true }]
                                      store.setFavorites(updated)
                                      await publishGifFavorites(updated, s, pk).catch(() => { })
                                    }}
                                    className={`absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center transition-all cursor-pointer ${useGifStore.getState().favorites.some((f) => f.url === url)
                                        ? 'bg-yellow-500/90 text-white opacity-80 hover:opacity-100'
                                        : 'bg-black/50 text-white/80 opacity-0 group-hover/gif:opacity-100 hover:bg-black/70'
                                      }`}
                                  >
                                    <Star size={10} fill={useGifStore.getState().favorites.some((f) => f.url === url) ? 'currentColor' : 'none'} />
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="text-xs">{useGifStore.getState().favorites.some((f) => f.url === url) ? 'Remove from favorites' : 'Add to favorites'}</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </div>
                        ))}
                      </div>
                    )}
                    {reactions.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {reactions.map((r) => (
                          <button
                            key={r.emoji}
                            onClick={() => addReaction(reply.id, reply.senderPubkey, r.emoji, myPubkey!, recipientPubkey, signer, privateKey, r.customUrl)}
                            className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs border transition-colors cursor-pointer ${r.reacted ? 'bg-primary/15 border-primary/30 text-primary' : 'bg-secondary/60 border-border hover:border-primary/20'}`}
                          >
                            <span>{(() => {
                              if (r.customUrl) return <img src={r.customUrl} alt={r.emoji} className="h-4 w-4 object-contain inline" />
                              const scMatch = r.emoji.match(/^:([a-zA-Z0-9_-]+):$/)
                              if (scMatch) {
                                const entry = getEmojiMap().get(scMatch[1])
                                if (entry) return <img src={entry.url} alt={r.emoji} className="h-4 w-4 object-contain inline" />
                              }
                              return r.emoji
                            })()}</span>
                            <span className="text-[10px] font-medium">{r.count}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Reply action on hover */}
                  <div className="absolute -top-3 right-2 hidden group-hover:flex items-center gap-0.5 bg-secondary border border-border rounded-md shadow-md px-0.5 py-0.5 z-10">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => handleReplyInThread(reply)}
                          className="p-1 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                        >
                          <Reply size={16} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">Reply</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              )
            })}

            {/* Optimistic messages */}
            {optimisticMessages.map((optMsg) => (
              <div
                key={optMsg.tempId}
                className={`flex gap-3 mt-4 py-1 px-2 rounded-md -mx-2 transition-opacity ${optMsg.status === 'published' ? 'opacity-70' : 'opacity-50'}`}
              >
                <div className="w-10 shrink-0 flex flex-col items-center">
                  <Avatar className="h-10 w-10 shrink-0">
                    {myAvatar && <AvatarImage src={myAvatar} alt={myDisplayName} />}
                    <AvatarFallback className="text-xs bg-primary/20 text-primary">
                      {myDisplayName.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold text-foreground">{myDisplayName}</span>
                    <span className="text-xs text-muted-foreground">{formatShortTime(optMsg.timestamp)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-sm text-foreground/90 break-words"><MessageContent content={optMsg.content} /></div>
                    {optMsg.status === 'publishing' && !optMsg.relayProgress?.confirmed && (
                      <span className="text-[10px] text-muted-foreground italic whitespace-nowrap">publishing...</span>
                    )}
                    {optMsg.status === 'publishing' && optMsg.relayProgress && optMsg.relayProgress.confirmed > 0 && (
                      <span className="text-[10px] text-muted-foreground/60 flex items-center gap-1 whitespace-nowrap">
                        <Loader2 size={9} className="animate-spin" />
                        {optMsg.relayProgress.confirmed}/{optMsg.relayProgress.total}
                      </span>
                    )}
                    {optMsg.status === 'published' && <Check size={13} className="text-green-500 shrink-0" />}
                    {optMsg.status === 'failed' && <X size={13} className="text-destructive shrink-0" />}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </TooltipProvider>

        {/* Thread input */}
        <ChatInputBar
          message={message}
          onMessageChange={setMessage}
          onSend={handleSend}
          sending={sending}
          placeholder="Reply to thread..."
          topContent={replyBanner}
          hasTopContent={!!inThreadReply}
          enableFileUpload
          signer={signer}
          privateKey={privateKey}

          dragContainerRef={modalContainerRef}
        />
      </div>
    </div>,
    document.body
  )
}
