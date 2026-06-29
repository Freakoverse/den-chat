/**
 * PublicChatPage — Permissionless topic-based public chat (Kind 1312)
 * No encryption, no authority, PoW-based spam filtering.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { getDraft, setDraft, clearDraft, pcDraftKey } from '@/stores/draftStore'
import { usePublicChatStore, type PublicChatMessage, type PCStoredReaction } from '@/stores/publicChatStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { useUserStore } from '@/stores/userStore'
import { useNavigationStore } from '@/stores/navigationStore'
import { useBlockStore } from '@/stores/blockStore'
import { useWotStore } from '@/stores/wotStore'
import { usePreferencesStore } from '@/stores/preferencesStore'
import { useProfileCache, getCachedProfile } from '@/hooks/useProfileCache'
import { UserPanel } from '@/components/ui/UserPanel'
import { ResizablePanel } from '@/components/ui/ResizablePanel'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ChatInputBar, type FileAttachment } from '@/components/chat/ChatInputBar'
import { MessageContent } from '@/components/chat/MessageContent'
import { ContentMediaGroupsWithGallery, extractContentMediaGroups } from '@/components/chat/ContentMediaGrouping'
import { DeleteConfirmDialog, ReactionBar, type Reaction } from '@/components/hub/ChannelView'
import { EmojiPickerPopover } from '@/components/chat/EmojiPickerPopover'
import { ScrollableContent } from '../chat/ScrollableContent'
import { ZapModal } from '@/components/hub/ZapModal'
import { ZapListModal } from '@/components/hub/ZapListModal'
import { UserProfileModal } from '@/components/hub/UserProfileModal'
import { DnnBadge } from '@/components/ui/DnnBadge'
import { BlossomImg } from '@/components/ui/BlossomImg'
import { useDnnStore } from '@/stores/dnnStore'
import { useGifStore } from '@/stores/gifStore'
import { publishGifFavorites } from '@/lib/nostr/customGif'
import { Plus, Info, Hash, X, Loader2, MessagesSquare, Trash2, Reply, ArrowDown, Shield, Smile, Zap, MoreVertical, Copy, Code, Check, Filter, Minus, RotateCcw, Eye, EyeOff, AlertTriangle, ImageOff, LinkIcon, Sticker, Crown, BadgeCheck, Users, MessageCircleOff, Bell, ChevronRight, Star } from 'lucide-react'
import { DoodleBackground } from '@/components/ui/DoodleBackground'
import { nip19 } from 'nostr-tools'
import { cn, truncateNpub, formatTimestamp } from '@/lib/utils'

import { getEmojiMap } from '@/stores/emojiStore'
import { getHour12 } from '@/stores/preferencesStore'
import { STANDARD_KINDS, KINDS } from '@/lib/crypto/constants'
import { createUnsignedEvent } from '@/lib/nostr/events'
import { signWithSigner } from '@/lib/nostr'
import { publishEvent, fetchEvents } from '@/lib/nostr/relay-pool'
import { benchmarkHashRate, estimateSolveTime, countLeadingZeroBits } from '@/lib/pow/pow'
import { useUnreadDivider } from '@/hooks/useUnreadDivider'
import { NewMessagesDivider } from '@/components/chat/NewMessagesDivider'
import { UnreadBanner } from '@/components/chat/UnreadBanner'
import { formatSats, type ZapInfo } from '@/lib/nostr/zap'

const EMPTY_MSGS: PublicChatMessage[] = []

export function PublicChatPage() {
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const topics = usePublicChatStore((s) => s.topics)
  const activeTopic = usePublicChatStore((s) => s.activeTopic)
  const setActiveTopic = usePublicChatStore((s) => s.setActiveTopic)
  const fetchTopicList = usePublicChatStore((s) => s.fetchTopicList)
  const topicListLoaded = usePublicChatStore((s) => s.topicListLoaded)

  const [showAddTopic, setShowAddTopic] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showNotifications, setShowNotifications] = useState(false)
  const [pendingHighlightId, setPendingHighlightId] = useState<string | null>(null)

  // Load topic list on mount
  useEffect(() => {
    if (myPubkey && !topicListLoaded) fetchTopicList(myPubkey)
  }, [myPubkey, topicListLoaded, fetchTopicList])

  return (
    <div className="flex flex-1 h-full overflow-hidden">
      {/* Left — Topic list */}
      <TopicListPanel
        topics={topics}
        activeTopic={activeTopic}
        onSelect={(t) => { setShowNotifications(false); setActiveTopic(t) }}
        onAdd={() => setShowAddTopic(true)}
        onInfo={() => setShowInfo(true)}
        onSettings={() => setShowSettings(true)}
        onNotifications={() => { setShowNotifications(true); setActiveTopic(null) }}
        showingNotifications={showNotifications}
        loading={!topicListLoaded}
      />

      {/* Right — Chat view or Notification view */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-background">
        {showNotifications ? (
          <PublicChatNotificationView onNavigate={(topic, msgId) => { setShowNotifications(false); setActiveTopic(topic); setPendingHighlightId(msgId || null) }} />
        ) : activeTopic ? (
          <PublicChatView topic={activeTopic} pendingHighlightId={pendingHighlightId} onHighlightConsumed={() => setPendingHighlightId(null)} />
        ) : (
          <PublicChatEmptyState />
        )}
      </div>

      {/* Add topic modal */}
      {showAddTopic && (
        <AddTopicModal onClose={() => setShowAddTopic(false)} />
      )}

      {/* Info modal */}
      {showInfo && (
        <InfoModal onClose={() => setShowInfo(false)} />
      )}

      {/* Settings modal */}
      {showSettings && (
        <PublicChatSettingsModal onClose={() => setShowSettings(false)} />
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════ */
/*  TOPIC LIST (Left Panel)                    */
/* ═══════════════════════════════════════════ */

function TopicListPanel({ topics, activeTopic, onSelect, onAdd, onInfo, onSettings, onNotifications, showingNotifications, loading }: {
  topics: string[]
  activeTopic: string | null
  onSelect: (t: string) => void
  onAdd: () => void
  onInfo: () => void
  onSettings: () => void
  onNotifications: () => void
  showingNotifications: boolean
  loading: boolean
}) {
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const removeTopic = usePublicChatStore((s) => s.removeTopic)
  const allMessages = usePublicChatStore((s) => s.messages)
  const pcReadTimes = useNotificationStore((s) => s.pcReadTimes)

  // Compute unread count per topic
  const topicUnreads = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const topic of topics) {
      const msgs = allMessages[topic]
      const lastRead = pcReadTimes[topic] ?? 0
      if (msgs && lastRead > 0) {
        counts[topic] = msgs.filter(m => m.createdAt > lastRead).length
      } else if (msgs && lastRead === 0) {
        // Never opened — all messages are unread (but cap to avoid noise on first use)
        counts[topic] = 0 // Don't show badge for never-opened topics
      } else {
        counts[topic] = 0
      }
    }
    return counts
  }, [topics, allMessages, pcReadTimes])

  return (
    <ResizablePanel id="public-chat" defaultWidth={240} minWidth={180} maxWidth={360} className="flex flex-col bg-background pr-2 py-2 gap-2 h-full overflow-hidden max-[1080px]:p-2">
      {/* Header card */}
      <div className="px-3 pt-3 pb-2 bg-secondary/50 rounded-md shadow-md shrink-0">
        <div className="flex items-center gap-2 mb-2">
          <MessagesSquare size={14} className="text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Public Chat</h2>
        </div>
        <div className="flex items-center gap-1">
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={onNotifications} className={cn(
                  'relative flex-1 p-1.5 rounded-lg transition-colors cursor-pointer flex items-center justify-center',
                  showingNotifications ? 'bg-primary/15 text-primary' : 'hover:bg-accent/50 text-muted-foreground hover:text-foreground'
                )}>
                  <Bell size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">Notifications</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={onInfo} className="flex-1 p-1.5 rounded-lg hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex items-center justify-center">
                  <Info size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">What is Public Chat?</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={onSettings} className="flex-1 p-1.5 rounded-lg hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex items-center justify-center">
                  <Filter size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">Chat Settings</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={onAdd} className="flex-1 p-1.5 rounded-lg hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex items-center justify-center">
                  <Plus size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">Join a Topic</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {/* Topic list card */}
      <div className="flex-1 overflow-y-auto px-2 py-2 bg-secondary/50 rounded-md shadow-md">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 size={16} className="animate-spin mr-2" />
            <span className="text-xs">Loading topics...</span>
          </div>
        ) : topics.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 gap-3 text-center">
            <Hash size={20} className="text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground">No topics yet.</p>
            <button
              onClick={onAdd}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors cursor-pointer"
            >
              <Plus size={14} />
              Add a topic
            </button>
          </div>
        ) : (
          <div className="space-y-1">
            {topics.map((topic) => {
              const unread = topicUnreads[topic] ?? 0
              return (
                <div key={topic} className="group relative">
                  <button
                    onClick={() => onSelect(topic)}
                    className={`w-full flex items-center gap-2 px-2.5 pr-7 py-2 rounded-lg transition-colors cursor-pointer text-left
                      ${activeTopic === topic
                        ? 'bg-primary/10'
                        : 'hover:bg-secondary/60'
                      }`}
                  >
                    <Hash size={18} className="text-muted-foreground shrink-0" />
                    <span className={cn(
                      'text-sm truncate flex-1',
                      unread > 0 && activeTopic !== topic ? 'font-semibold text-foreground' : 'text-foreground'
                    )}>{topic}</span>
                    {unread > 0 && activeTopic !== topic && (
                      <span className="min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-[10px] font-bold px-1 bg-foreground text-background shrink-0 group-hover:opacity-0 transition-opacity">
                        {unread > 99 ? '99+' : unread}
                      </span>
                    )}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeTopic(topic, myPubkey || '', signer, privateKey) }}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all cursor-pointer"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <UserPanel />
    </ResizablePanel>
  )
}

/* ═══════════════════════════════════════════ */
/*  EMPTY STATE                                */
/* ═══════════════════════════════════════════ */

function PublicChatEmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center relative overflow-hidden">
      <DoodleBackground />
      <div className="text-center flex flex-col items-center gap-4 relative z-10">
        <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
          <MessagesSquare size={28} className="text-primary" />
        </div>
        <h2 className="text-xl font-semibold text-foreground">Public Chat</h2>
        <p className="text-sm max-w-xs text-muted-foreground">
          Select a topic from the list or add a new one to start chatting.
        </p>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════ */
/*  NOTIFICATION VIEW                          */
/* ═══════════════════════════════════════════ */

interface PCNotification {
  id: string
  pubkey: string
  content: string
  createdAt: number
  topic: string
  type: 'mention' | 'reply'
  replyTo?: string
  pow: number
}

function PublicChatNotificationView({ onNavigate }: { onNavigate: (topic: string, msgId?: string) => void }) {
  const myPubkey = useUserStore((s) => s.pubkey)
  const [notifications, setNotifications] = useState<PCNotification[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'all' | 'mentions' | 'replies'>('all')
  const { getProfile } = useProfileCache()

  // Fetch notifications on mount — kind 1312 messages that #p tag us
  useEffect(() => {
    if (!myPubkey) { setLoading(false); return }

    const load = async () => {
      setLoading(true)
      try {
        const events = await fetchEvents({
          kinds: [KINDS.PUBLIC_CHAT],
          '#p': [myPubkey],
          limit: 100,
        })

        const notifs: PCNotification[] = events
          .filter(e => e.pubkey !== myPubkey) // Exclude own messages
          .map(event => {
            const tTag = event.tags.find(t => t[0] === 't')
            const topic = tTag?.[1]?.toLowerCase() || 'unknown'
            const replyTag = event.tags.find(t => t[0] === 'e' && (t[3] === 'reply' || t[3] === 'root'))
            const isReply = !!replyTag
            const pow = countLeadingZeroBits(event.id)

            return {
              id: event.id,
              pubkey: event.pubkey,
              content: event.content,
              createdAt: event.created_at,
              topic,
              type: isReply ? 'reply' as const : 'mention' as const,
              replyTo: replyTag?.[1],
              pow,
            }
          })
          .sort((a, b) => b.createdAt - a.createdAt)

        setNotifications(notifs)
      } catch (err) {
        console.error('[PublicChat] Failed to fetch notifications:', err)
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [myPubkey])

  const filtered = useMemo(() => {
    if (activeTab === 'all') return notifications
    return notifications.filter(n => n.type === (activeTab === 'mentions' ? 'mention' : 'reply'))
  }, [notifications, activeTab])

  const tabs: { id: 'all' | 'mentions' | 'replies'; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'mentions', label: 'Mentions' },
    { id: 'replies', label: 'Replies' },
  ]

  const handleJumpToMessage = useCallback((topic: string, msgId?: string) => {
    onNavigate(topic, msgId)
  }, [onNavigate])

  return (
    <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden pr-2 py-2 gap-2 max-[1080px]:px-2">
      {/* Header + tabs card */}
      <div className="bg-secondary/50 rounded-md shadow-md shrink-0 overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border/50">
          <Bell size={16} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground flex-1">Notifications</h3>
        </div>
        <div className="flex items-center gap-1 px-4 py-2">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer',
                activeTab === tab.id
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Notification list — bordered, rounded card */}
      <div className="flex-1 overflow-y-auto px-4 py-3 border border-border rounded-md">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 size={16} className="animate-spin mr-2" />
            <span className="text-xs">Loading notifications...</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <Bell size={24} className="text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No notifications yet</p>
            <p className="text-xs text-muted-foreground">When someone mentions you or replies to your messages in public chat, it will appear here.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(notif => (
              <PCNotificationRow key={notif.id} notif={notif} onJump={handleJumpToMessage} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function PCNotificationRow({ notif, onJump }: { notif: PCNotification; onJump: (topic: string, msgId?: string) => void }) {
  const { getProfile } = useProfileCache()
  const profile = getProfile(notif.pubkey)
  const npub = nip19.npubEncode(notif.pubkey)
  const displayName = profile?.display_name || profile?.name || truncateNpub(npub, 8)

  const timeAgo = useMemo(() => {
    const now = Math.floor(Date.now() / 1000)
    const diff = now - notif.createdAt
    if (diff < 60) return 'just now'
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    return `${Math.floor(diff / 86400)}d ago`
  }, [notif.createdAt])

  return (
    <div
      className="flex gap-3 p-3 rounded-lg bg-secondary/30 hover:bg-secondary/50 transition-colors cursor-pointer group"
      onClick={() => onJump(notif.topic, notif.id)}
    >
      {/* Avatar */}
      <Avatar className="w-9 h-9 shrink-0 mt-0.5">
        {profile?.picture && <AvatarImage src={profile.picture} />}
        <AvatarFallback className="text-xs bg-primary/20 text-primary">
          {displayName.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-foreground">{displayName}</span>
          <span className="text-[10px] text-muted-foreground">
            {notif.type === 'mention' ? 'mentioned you' : 'replied to you'}
          </span>
          <span className="text-[10px] text-muted-foreground">· {timeAgo}</span>
        </div>

        {/* Topic badge */}
        <span
          className="inline-flex items-center gap-1 mt-0.5 mb-1 px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-medium"
        >
          <Hash size={10} />
          {notif.topic}
        </span>

        {/* Message preview */}
        <p className="text-sm text-foreground/80 break-words line-clamp-3">
          <MessageContent content={notif.content} />
        </p>
      </div>

      {/* Jump arrow — visible on hover */}
      <div className="flex items-center shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <ChevronRight size={16} className="text-muted-foreground" />
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════ */
/*  ADD TOPIC MODAL                            */
/* ═══════════════════════════════════════════ */

function AddTopicModal({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState('')
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const addTopic = usePublicChatStore((s) => s.addTopic)
  const setActiveTopic = usePublicChatStore((s) => s.setActiveTopic)

  const suggestions = ['games', 'movies', 'shows', 'music', 'travel', 'programming', 'ai', 'software', 'hardware', 'football', 'basketball', 'memes']

  const handleAdd = async () => {
    const t = value.trim().toLowerCase()
    if (!t || !myPubkey) return
    await addTopic(t, myPubkey, signer, privateKey)
    setActiveTopic(t)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative z-10 w-full max-w-sm rounded-xl border border-border bg-background shadow-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-foreground">Join a Topic</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={16} /></button>
        </div>
        <p className="text-[11px] text-muted-foreground mb-4">Topics are open public chatrooms anyone can join — like hashtags.</p>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder="e.g. gaming, reading, cooking, japan..."
          className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground outline-none focus:ring-1 focus:ring-primary/50"
          autoFocus
        />
        <p className="text-[10px] text-muted-foreground mt-1.5 mb-3">Type any topic name or pick a suggestion below.</p>

        {/* Suggestions */}
        <div className="flex flex-wrap gap-1.5 mb-4">
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => setValue(s)}
              className={cn(
                'px-2.5 py-1 rounded-full text-xs transition-colors cursor-pointer',
                value.toLowerCase() === s
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary hover:bg-accent text-muted-foreground hover:text-foreground border border-border/50'
              )}
            >
              {s}
            </button>
          ))}
        </div>

        <button
          onClick={handleAdd}
          disabled={!value.trim()}
          className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Join Topic
        </button>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════ */
/*  INFO MODAL                                 */
/* ═══════════════════════════════════════════ */

function InfoModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-border bg-background shadow-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-foreground">About Public Chat</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={16} /></button>
        </div>
        <div className="space-y-3 text-sm text-muted-foreground">
          <p><span className="text-foreground font-medium">Permissionless.</span> Anyone can post to any topic. There are no owners, admins, or moderators.</p>
          <p><span className="text-foreground font-medium">PoW filtered.</span> Messages require Proof of Work (NIP-13). Adjust the difficulty slider to filter spam — higher = fewer messages but higher quality.</p>
          <p><span className="text-foreground font-medium">Public.</span> Messages are not encrypted. Everything you post is visible to everyone.</p>
          <p><span className="text-foreground font-medium">Chaos.</span> This is an experiment in unmoderated, decentralized communication. Use at your own discretion.</p>
        </div>
        <button onClick={onClose} className="w-full mt-5 py-2 rounded-lg bg-secondary text-foreground text-sm font-medium hover:bg-secondary/80 transition-colors cursor-pointer">Got it</button>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════ */
/*  HELPERS                                    */
/* ═══════════════════════════════════════════ */

const GROUP_WINDOW_S = 5 * 60

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

function formatFullDate(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: getHour12() })
}

/** GIF image with skeleton placeholder (matches hub chat pattern) */
function GifImg({ src, alt, className, style }: { src: string; alt: string; className?: string; style?: React.CSSProperties }) {
  const [loaded, setLoaded] = useState(false)
  const w = (style?.maxWidth as number) || 220
  const h = (style?.maxHeight as number) || 220

  return (
    <>
      {!loaded && (
        <span className="media-skeleton inline-block" style={{ width: w, height: h, maxWidth: '100%' }} />
      )}
      <img
        src={src}
        alt={alt}
        className={`${className || ''} ${!loaded ? 'opacity-0 h-0 overflow-hidden block' : ''}`}
        style={style}
        onLoad={() => setLoaded(true)}
      />
    </>
  )
}

/* ═══════════════════════════════════════════ */
/*  CHAT VIEW                                  */
/* ═══════════════════════════════════════════ */

function PublicChatView({ topic, pendingHighlightId, onHighlightConsumed }: { topic: string; pendingHighlightId?: string | null; onHighlightConsumed?: () => void }) {
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const topicMessages = usePublicChatStore((s) => s.messages[topic])
  const messages = topicMessages || EMPTY_MSGS
  const powDifficulty = usePublicChatStore((s) => s.powDifficulty)
  const setPowDifficulty = usePublicChatStore((s) => s.setPowDifficulty)
  const fetchMessages = usePublicChatStore((s) => s.fetchMessages)
  const fetchOlderMessages = usePublicChatStore((s) => s.fetchOlderMessages)
  const startSubscription = usePublicChatStore((s) => s.startSubscription)
  const stopSubscription = usePublicChatStore((s) => s.stopSubscription)
  const startDeletionSubscription = usePublicChatStore((s) => s.startDeletionSubscription)
  const stopDeletionSubscription = usePublicChatStore((s) => s.stopDeletionSubscription)
  const removeMessage = usePublicChatStore((s) => s.removeMessage)
  const sendMessage = usePublicChatStore((s) => s.sendMessage)
  const loadingTopic = usePublicChatStore((s) => s.loadingTopic[topic])
  const loadingOlder = usePublicChatStore((s) => s.loadingOlder)
  const hasMore = usePublicChatStore((s) => s.hasMore[topic])
  const blockedPubkeys = useBlockStore((s) => s.blockedPubkeys)

  // Reaction + Zap store selectors
  const pcReactions = usePublicChatStore((s) => s.pcReactions)
  const pcZaps = usePublicChatStore((s) => s.pcZaps)
  const startReactionSubscription = usePublicChatStore((s) => s.startReactionSubscription)
  const stopReactionSubscription = usePublicChatStore((s) => s.stopReactionSubscription)
  const startZapSubscription = usePublicChatStore((s) => s.startZapSubscription)
  const stopZapSubscription = usePublicChatStore((s) => s.stopZapSubscription)
  const { getProfile } = useProfileCache()
  const myProfile = myPubkey ? getProfile(myPubkey) : null
  const myDisplayName = myProfile?.display_name || myProfile?.name || (myPubkey ? truncateNpub(nip19.npubEncode(myPubkey)) : 'You')

  const _pcKey = pcDraftKey(topic)
  const [message, setMessage] = useState(() => getDraft(_pcKey))
  // Load correct draft when switching topics
  const _prevPcKey = useRef(_pcKey)
  useEffect(() => {
    if (_prevPcKey.current !== _pcKey) {
      _prevPcKey.current = _pcKey
      setMessage(getDraft(_pcKey))
    }
  }, [_pcKey])
  useEffect(() => { setDraft(_pcKey, message) }, [_pcKey, message])
  const [sending, setSending] = useState(false)
  const [sendingContent, setSendingContent] = useState('')
  const [isNsfw, setIsNsfw] = useState(false)
  const [replyTo, setReplyTo] = useState<PublicChatMessage | null>(null)
  const [showBackToBottom, setShowBackToBottom] = useState(false)
  const [deleteModalMsg, setDeleteModalMsg] = useState<PublicChatMessage | null>(null)
  const [pendingStickers, setPendingStickers] = useState<{ shortcode: string; url: string; setAddress: string }[]>([])
  const [pendingGifs, setPendingGifs] = useState<{ name: string; url: string; nsfw: boolean }[]>([])
  const [showFilterSettings, setShowFilterSettings] = useState(false)
  const [profilePubkey, setProfilePubkey] = useState<string | null>(null)
  const [pendingUnreact, setPendingUnreact] = useState<{ messageId: string; emoji: string; eventId: string } | null>(null)

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const chatContainerRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)

  // ── Highlight flash for notification jump ──
  const [highlightedId, setHighlightedId] = useState<string | null>(null)

  useEffect(() => {
    if (!pendingHighlightId) return
    // Wait for messages to render, then scroll + highlight
    const timer = setTimeout(() => {
      const el = document.getElementById(`pc-msg-${pendingHighlightId}`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        setHighlightedId(pendingHighlightId)
        setTimeout(() => setHighlightedId(null), 2000)
      }
      onHighlightConsumed?.()
    }, 300)
    return () => clearTimeout(timer)
  }, [pendingHighlightId, onHighlightConsumed])

  // ── Scroll to message + highlight (used by reply preview clicks) ──
  const scrollToMessage = useCallback((messageId: string) => {
    const el = document.getElementById(`pc-msg-${messageId}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlightedId(messageId)
      setTimeout(() => setHighlightedId(null), 2000)
    }
  }, [])

  // Filter messages by PoW difficulty, blocked users, and WoT
  const wotShouldHide = useWotStore((s) => s.shouldHide)
  const filteredMessages = useMemo(() => {
    return messages.filter(m => {
      if (m.pow < powDifficulty) return false
      if (blockedPubkeys.has(m.pubkey)) return false
      if (wotShouldHide(m.pubkey, 'publicChat')) return false
      return true
    })
  }, [messages, powDifficulty, blockedPubkeys, wotShouldHide])

  // ── New-messages divider ──
  const pcLastRead = useNotificationStore((s) => s.pcReadTimes[topic] ?? 0)
  const {
    dividerRef: newMsgDividerRef,
    unreadCount: newMsgUnreadCount,
    dividerTimestamp: newMsgSnapshot,
    showBanner: showUnreadBanner,
    dismissBanner: dismissUnreadBanner,
    jumpToDivider: jumpToNewMsgDivider,
    shouldInsertDivider,
    dividerHidden,
  } = useUnreadDivider(pcLastRead, filteredMessages, (m) => m.createdAt, `pc:${topic}`, myPubkey, (m) => m.pubkey)


  // Mark topic as read when entering/switching topics
  const markTopicRead = useNotificationStore((s) => s.markTopicRead)
  useEffect(() => {
    markTopicRead(topic)
  }, [topic, markTopicRead])

  // Subscribe and fetch on topic change
  useEffect(() => {
    fetchMessages(topic)
    startSubscription(topic)
    startDeletionSubscription(topic)
    startReactionSubscription(topic)
    return () => {
      stopSubscription()
      stopDeletionSubscription()
      stopReactionSubscription()
    }
  }, [topic, fetchMessages, startSubscription, stopSubscription, startDeletionSubscription, stopDeletionSubscription, startReactionSubscription, stopReactionSubscription])

  // Zap subscription — depends on loaded messages (need event IDs)
  const messageCount = messages.length
  useEffect(() => {
    if (messageCount === 0) return
    startZapSubscription(topic)
    return () => { stopZapSubscription() }
  }, [topic, messageCount, startZapSubscription, stopZapSubscription])

  // ── Reaction handling ──
  const handleReaction = useCallback((messageId: string, emoji: string, customUrl?: string) => {
    if (!myPubkey) return

    const existing = pcReactions[messageId] || []
    const myExisting = existing.find((r) => r.emoji === emoji && r.pubkey === myPubkey)
    if (myExisting) {
      setPendingUnreact({ messageId, emoji, eventId: myExisting.eventId })
      return
    }

    // Optimistic add
    usePublicChatStore.getState().addReaction(messageId, {
      emoji,
      pubkey: myPubkey,
      eventId: 'optimistic-' + Date.now(),
      createdAt: Math.floor(Date.now() / 1000),
      customUrl,
    })

    // Publish
    usePublicChatStore.getState().publishReaction({
      emoji,
      targetEventId: messageId,
      targetPubkey: messages.find((m) => m.id === messageId)?.pubkey || '',
      topic,
      pubkey: myPubkey,
      signer,
      privateKey,
      customUrl,
    }).catch(() => {})
  }, [messages, pcReactions, myPubkey, topic, signer, privateKey])

  // Scroll handling
  const handleScroll = useCallback(() => {
    const el = messagesContainerRef.current
    if (!el) return
    const threshold = 80
    isAtBottomRef.current = Math.abs(el.scrollTop) < threshold
    setShowBackToBottom(!isAtBottomRef.current)
    // Fetch older on scroll to top (column-reverse)
    if (!loadingOlder && hasMore && el.scrollHeight + el.scrollTop - el.clientHeight < 60) {
      fetchOlderMessages(topic)
    }
  }, [loadingOlder, hasMore, topic, fetchOlderMessages])

  // Auto-scroll on new messages if at bottom
  const prevCountRef = useRef(filteredMessages.length)
  useEffect(() => {
    if (filteredMessages.length > prevCountRef.current && isAtBottomRef.current) {
      if (messagesContainerRef.current) messagesContainerRef.current.scrollTop = 0
    }
    prevCountRef.current = filteredMessages.length
  }, [filteredMessages.length])

  const scrollToBottom = useCallback(() => {
    if (messagesContainerRef.current) messagesContainerRef.current.scrollTop = 0
    setShowBackToBottom(false)
  }, [])

  // Send handler
  const handleSend = useCallback(async (attachments?: FileAttachment[]) => {
    const text = message.trim()
    if (!text && !attachments?.length && pendingStickers.length === 0 && pendingGifs.length === 0) return
    if (!myPubkey || sending) return

    setSending(true)
    isAtBottomRef.current = true

    let content = text
    if (attachments && attachments.length > 0) {
      const links = attachments.map(a => {
        const ext = a.type ? `.${a.type.split('/')[1]?.split('+')[0] || 'bin'}` : ''
        return `https://blossom.primal.net/${a.hash}${ext}`
      })
      content = content ? `${content}\n${links.join('\n')}` : links.join('\n')
    }

    // Snapshot and clear sticker/GIF state before async work
    const sentStickers = [...pendingStickers]
    const sentGifs = [...pendingGifs]
    setPendingStickers([])
    setPendingGifs([])

    setMessage('')
    clearDraft(_pcKey)
    setSendingContent(content || (sentStickers.length > 0 ? ':sticker:' : sentGifs.length > 0 ? 'GIF' : ''))

    try {
      // Extract emoji tags
      const emojiMap = getEmojiMap()
      const extraTags: string[][] = []
      const emojiMatches = content.match(/:([a-zA-Z0-9_-]+):/g)
      if (emojiMatches) {
        const seen = new Set<string>()
        for (const match of emojiMatches) {
          const sc = match.slice(1, -1)
          if (seen.has(sc)) continue
          seen.add(sc)
          const entry = emojiMap.get(sc)
          if (entry) extraTags.push(['emoji', sc, entry.url, entry.setAddress || ''])
        }
      }

      // Add sticker tags (unencrypted)
      for (const s of sentStickers) {
        extraTags.push(['sticker', s.shortcode, s.url, s.setAddress])
      }

      // Add GIF tags (unencrypted)
      for (const g of sentGifs) {
        extraTags.push(['j', g.name, g.url, g.nsfw ? 'nsfw' : 'sfw'])
      }

      await sendMessage({
        content, topic, pubkey: myPubkey, signer, privateKey,
        replyTo: replyTo?.id,
        replyToPubkey: replyTo?.pubkey,
        rootRef: replyTo?.rootRef || replyTo?.id,
        extraTags: extraTags.length > 0 ? extraTags : undefined,
        nsfw: isNsfw || undefined,
      })
      setReplyTo(null)
      setIsNsfw(false)
    } catch (err) {
      console.error('[PublicChat] Send failed:', err)
      setMessage(text)
      // Restore stickers/gifs on failure
      setPendingStickers(sentStickers)
      setPendingGifs(sentGifs)
    } finally {
      setSending(false)
      setSendingContent('')
    }
  }, [message, myPubkey, signer, privateKey, topic, sendMessage, sending, replyTo, pendingStickers, pendingGifs])

  // Find reply target message content for preview
  const replyTargetProfile = replyTo ? getProfile(replyTo.pubkey) : null

  return (
    <div ref={chatContainerRef} className="flex flex-col flex-1 min-w-0 h-full overflow-hidden relative pr-2 py-2 gap-2 max-[1080px]:px-2">
      {/* Header card */}
      <div className="flex items-center gap-3 px-4 py-3 bg-secondary/50 rounded-md shadow-md shrink-0">
        <Hash size={16} className="text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground flex-1">{topic}</h3>
      </div>

      {/* Messages — bordered, rounded card */}
      <div
        ref={messagesContainerRef}
        className="flex-1 min-h-0 overflow-y-auto flex flex-col-reverse px-4 py-3 border border-border rounded-md"
        onScroll={handleScroll}
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

            {loadingTopic ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 size={16} className="animate-spin mr-2" />
                <span className="text-xs">Loading messages...</span>
              </div>
            ) : filteredMessages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
                <Hash size={24} className="text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">No messages yet in #{topic}</p>
                <p className="text-xs text-muted-foreground">Be the first to say something.</p>
              </div>
            ) : (
              filteredMessages.map((msg, i) => {
                const prev = i > 0 ? filteredMessages[i - 1] : null
                const showDateSep = !prev || isDifferentDay(prev.createdAt, msg.createdAt)
                const isGrouped = prev
                  && msg.pubkey === prev.pubkey
                  && !showDateSep
                  && (msg.createdAt - prev.createdAt) <= GROUP_WINDOW_S
                  && !msg.replyTo

                return (
                  <div key={msg.id} id={`pc-msg-${msg.id}`}>
                    {shouldInsertDivider(msg.createdAt, prev ? prev.createdAt : null, msg.pubkey) && (
                      <NewMessagesDivider ref={newMsgDividerRef} hidden={dividerHidden} />
                    )}
                    <PublicMessageRow
                      msg={msg}
                      showDateSep={showDateSep}
                      isGrouped={!!isGrouped}
                      onReply={() => setReplyTo(msg)}
                      onRequestDelete={() => setDeleteModalMsg(msg)}
                      allMessages={filteredMessages}
                      onOpenSettings={() => setShowFilterSettings(true)}
                      onOpenProfile={(pk) => setProfilePubkey(pk)}
                      highlighted={highlightedId === msg.id}
                      onScrollToMessage={scrollToMessage}
                      onAddReaction={handleReaction}
                      rawReactions={pcReactions[msg.id]}
                      msgZaps={pcZaps[msg.id]}
                    />
                  </div>
                )
              })
            )}

            {sending && sendingContent && (
              <div className={`flex gap-3 px-1 py-1 mt-2 rounded-md transition-opacity opacity-50`}>
                <Avatar className="w-10 h-10 shrink-0 mt-0.5">
                  {myProfile?.picture && <AvatarImage src={myProfile.picture} />}
                  <AvatarFallback className="text-xs bg-primary/20 text-primary">
                    {myDisplayName.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{myDisplayName}</span>
                    <span className="text-[10px] text-muted-foreground">{formatShortTime(Math.floor(Date.now() / 1000))}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-sm text-foreground/90 break-words"><MessageContent content={sendingContent} /></div>
                    <span className="text-[10px] text-muted-foreground italic whitespace-nowrap">
                      processing...
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Back to bottom */}
      {showBackToBottom && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-20 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-primary-foreground text-xs font-medium shadow-lg hover:bg-primary/90 transition-colors cursor-pointer"
        >
          <ArrowDown size={12} /> Latest messages
        </button>
      )}

      {/* Input bar */}
      <ChatInputBar
        bare
        draftKey={_pcKey}
        message={message}
        onMessageChange={setMessage}
        onSend={handleSend}
        placeholder={`Message #${topic}...`}
        sending={sending}
        enableFileUpload
        hideUploadWarning
        signer={signer}
        privateKey={privateKey}

        dragContainerRef={chatContainerRef}
        topContent={(replyTo || pendingStickers.length > 0 || pendingGifs.length > 0) ? (
          <>
            {replyTo && (
              <div className="flex items-center gap-2 px-3 py-2 bg-secondary/80 border border-border border-b-0 rounded-t-xl">
                <Reply size={12} className="text-primary shrink-0" />
                <span className="text-xs text-muted-foreground truncate flex-1">
                  Replying to <span className="font-medium text-foreground">{replyTargetProfile?.display_name || replyTargetProfile?.name || truncateNpub(nip19.npubEncode(replyTo.pubkey), 8)}</span>: {replyTo.content.slice(0, 60)}{replyTo.content.length > 60 ? '...' : ''}
                </span>
                <button onClick={() => setReplyTo(null)} className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={12} /></button>
              </div>
            )}
            {pendingStickers.length > 0 && (
              <div className={`flex items-center gap-2 px-3 py-1.5 bg-secondary/60 border border-border border-b-0 ${!replyTo ? 'rounded-t-xl' : ''}`}>
                <span className="text-[10px] text-muted-foreground shrink-0">Stickers:</span>
                {pendingStickers.map((st, i) => (
                  <div key={`ps-${i}`} className="relative group/ps">
                    <img src={st.url} alt={`:${st.shortcode}:`} className="w-10 h-10 rounded object-contain bg-muted/30" />
                    <button
                      onClick={() => setPendingStickers(prev => prev.filter((_, idx) => idx !== i))}
                      className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover/ps:opacity-100 transition-opacity cursor-pointer"
                    >
                      <X size={8} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {pendingGifs.length > 0 && (
              <div className={`flex items-center gap-2 px-3 py-1.5 bg-secondary/60 border border-border border-b-0 ${!replyTo && pendingStickers.length === 0 ? 'rounded-t-xl' : ''}`}>
                <span className="text-[10px] text-muted-foreground shrink-0">GIFs:</span>
                {pendingGifs.map((g, i) => (
                  <div key={`pg-${i}`} className="relative group/pg">
                    <img src={g.url} alt={g.name || 'GIF'} className="w-10 h-10 rounded object-contain bg-muted/30" />
                    <button
                      onClick={() => setPendingGifs(prev => prev.filter((_, idx) => idx !== i))}
                      className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover/pg:opacity-100 transition-opacity cursor-pointer"
                    >
                      <X size={8} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : undefined}
        hasTopContent={!!replyTo || pendingStickers.length > 0 || pendingGifs.length > 0}
        canSend={(message.trim() || pendingStickers.length > 0 || pendingGifs.length > 0) ? true : undefined}
        onStickerSelect={(sticker) => setPendingStickers(prev => [...prev, sticker])}
        onGifSelect={(gif) => setPendingGifs(prev => [...prev, gif])}
        leftActions={
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setIsNsfw(!isNsfw)}
                  className={`p-1 cursor-pointer transition-colors text-xs font-bold rounded ${isNsfw ? 'text-red-400 bg-red-400/10' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  NSFW
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">Mark as NSFW</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        }
      />

      {/* Delete confirm dialog */}
      {deleteModalMsg && (
        <DeleteConfirmDialog
          onCancel={() => setDeleteModalMsg(null)}
          onConfirm={async () => {
            // Optimistic local removal — instant UI feedback
            removeMessage(topic, deleteModalMsg.id)
            try {
              const unsigned = createUnsignedEvent(STANDARD_KINDS.DELETION, 'delete', [
                ['e', deleteModalMsg.id],
                ['k', String(KINDS.PUBLIC_CHAT)],
                ['t', topic.toLowerCase()],
              ])
              const signed = await signWithSigner(unsigned, signer, privateKey)
              await publishEvent(signed)
            } catch (err) {
              console.error('[PublicChat] Delete failed:', err)
            }
            setDeleteModalMsg(null)
          }}
          progressSteps={['Sending deletion request...']}
        />
      )}

      {/* Filter settings modal (triggered from media disabled placeholder) */}
      {showFilterSettings && (
        <PublicChatSettingsModal onClose={() => setShowFilterSettings(false)} />
      )}

      {/* User profile modal */}
      <UserProfileModal
        open={!!profilePubkey}
        onClose={() => setProfilePubkey(null)}
        targetPubkey={profilePubkey}
      />

      {/* Unreact confirmation dialog */}
      {pendingUnreact && (
        <DeleteConfirmDialog
          onCancel={() => setPendingUnreact(null)}
          onConfirm={async () => {
            const { messageId, emoji, eventId } = pendingUnreact
            // Optimistic remove
            usePublicChatStore.getState().removeReaction(messageId, emoji, myPubkey!)
            // Publish deletion
            usePublicChatStore.getState().unreactReaction({
              reactionEventId: eventId,
              signer,
              privateKey,
            }).catch(() => {})
            setPendingUnreact(null)
          }}
        />
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════ */
/*  MESSAGE ROW                                */
/* ═══════════════════════════════════════════ */

function PublicMessageRow({ msg, showDateSep, isGrouped, onReply, onRequestDelete, allMessages, onOpenSettings, onOpenProfile, highlighted, onScrollToMessage, onAddReaction, rawReactions, msgZaps }: {
  msg: PublicChatMessage
  showDateSep: boolean
  isGrouped: boolean
  onReply: () => void
  onRequestDelete: () => void
  allMessages: PublicChatMessage[]
  onOpenSettings?: () => void
  onOpenProfile?: (pubkey: string) => void
  highlighted?: boolean
  onScrollToMessage?: (messageId: string) => void
  onAddReaction?: (messageId: string, emoji: string, customUrl?: string) => void
  rawReactions?: PCStoredReaction[]
  msgZaps?: ZapInfo[]
}) {
  const myPubkey = useUserStore((s) => s.pubkey)
  const { getProfile } = useProfileCache()
  const profile = getProfile(msg.pubkey)
  const npub = nip19.npubEncode(msg.pubkey)
  const displayName = profile?.display_name || profile?.name || truncateNpub(npub, 8)

  // Relay progress — gray-to-white publishing transition
  const relayProgress = usePublicChatStore((s) => s.relayProgress[msg.id])
  const isPublishing = !!relayProgress && relayProgress.confirmed < relayProgress.total
  const hasConfirmation = !!relayProgress && relayProgress.confirmed > 0

  const [nsfwRevealed, setNsfwRevealed] = useState(false)
  const [mediaPreview, setMediaPreview] = useState(false)
  const showNsfwPref = typeof window !== 'undefined' && localStorage.getItem('SHOW_NSFW') === 'true'
  const shouldBlurMsg = msg.nsfw && !showNsfwPref && !nsfwRevealed

  // Content filters (must be above reaction aggregation since it uses showCustomEmojis)
  const showMedia = usePublicChatStore((s) => s.showMedia)
  const showLinkPreviews = usePublicChatStore((s) => s.showLinkPreviews)
  const showCustomEmojis = usePublicChatStore((s) => s.showCustomEmojis)

  // Aggregate reactions: PCStoredReaction[] -> Reaction[] for ReactionBar
  // When showCustomEmojis is OFF, strip custom emoji URLs so ReactionBar shows shortcodes instead of images
  const reactions: Reaction[] = useMemo(() => {
    if (!rawReactions || rawReactions.length === 0) return []
    const map = new Map<string, { emoji: string; count: number; reacted: boolean; customUrl?: string }>()
    for (const r of rawReactions) {
      const existing = map.get(r.emoji)
      if (existing) {
        existing.count++
        if (r.pubkey === myPubkey) existing.reacted = true
      } else {
        map.set(r.emoji, { emoji: r.emoji, count: 1, reacted: r.pubkey === myPubkey, customUrl: showCustomEmojis ? r.customUrl : undefined })
      }
    }
    return Array.from(map.values())
  }, [rawReactions, myPubkey, showCustomEmojis])

  // Muted words filter
  const hideMutedWords = usePublicChatStore((s) => s.hideMutedWords)
  const mutedWords = useBlockStore((s) => s.mutedWords)

  // DNN ID filter — hide messages from non-DNN users when enabled
  const dnnIdOnly = usePublicChatStore((s) => s.dnnIdOnly)
  const dnnVerified = useDnnStore((s) => s.status[msg.pubkey] === 'verified')

  // Always extract media so URLs are stripped from text content
  const { groups: mediaGroups, strippedContent } = useMemo(
    () => shouldBlurMsg ? { groups: [], strippedContent: msg.content } : extractContentMediaGroups(msg.content),
    [msg.content, shouldBlurMsg]
  )
  const hasMedia = mediaGroups.length > 0

  // Show placeholder when media rendering is off and there IS media to hide
  const hasMediaUrls = !showMedia && (
    hasMedia || (msg.stickerTags && msg.stickerTags.length > 0) || (msg.gifTags && msg.gifTags.length > 0)
  )

  // Reply preview
  const replyTarget = msg.replyTo ? allMessages.find(m => m.id === msg.replyTo) : null
  const replyProfile = replyTarget ? getProfile(replyTarget.pubkey) : null

  // Mention highlight detection (matches hub chat pattern)
  const isMentioned = useMemo(() => {
    if (!myPubkey || !msg.content) return false
    const content = msg.content
    const myNpub = nip19.npubEncode(myPubkey)
    if (content.includes(`@${myNpub}`)) return true
    if (content.includes('@everyone')) return true
    if (content.includes('@here')) return true
    return false
  }, [msg.content, myPubkey])

  // DNN filter — must be after all hooks
  if (dnnIdOnly && !dnnVerified) return null

  return (
    <>
      {showDateSep && (
        <div className="flex items-center gap-3 py-3">
          <div className="flex-1 h-px bg-border" />
          <span className="text-[11px] text-muted-foreground font-medium">{formatDaySeparator(msg.createdAt)}</span>
          <div className="flex-1 h-px bg-border" />
        </div>
      )}

      {/* Reply reference — hub-style curved connector */}
      {msg.replyTo && replyTarget && (
        <button
          onClick={() => onScrollToMessage?.(replyTarget.id)}
          className="flex gap-3 px-2 items-end cursor-pointer hover:opacity-80 transition-opacity w-full text-left"
        >
          {/* Curved connector line — same w-10 column as avatar */}
          <div className="w-10 shrink-0 flex">
            <div
              className="ml-auto border-l-2 border-t-2 border-muted-foreground/30 rounded-tl-md"
              style={{ width: 20, height: 10 }}
            />
          </div>
          {/* Preview content */}
          <div className="flex items-center gap-1 min-w-0 pb-0.5">
            <Avatar className="h-4 w-4 shrink-0">
              {replyProfile?.picture && <AvatarImage src={replyProfile.picture} />}
              <AvatarFallback className="text-[8px] bg-primary/20 text-primary">
                {(replyProfile?.display_name || replyProfile?.name || 'U').slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="text-xs font-semibold text-foreground/70 shrink-0">{replyProfile?.display_name || replyProfile?.name || 'Unknown'}</span>
            <span className="text-xs truncate text-muted-foreground/60">{replyTarget.content.slice(0, 60)}</span>
          </div>
        </button>
      )}
      {msg.replyTo && !replyTarget && (
        <div className="flex gap-3 px-2 items-end">
          <div className="w-10 shrink-0 flex"><div className="ml-auto border-l-2 border-t-2 border-muted-foreground/20 rounded-tl-md" style={{ width: 20, height: 10 }} /></div>
          <span className="text-xs text-muted-foreground/50 italic pb-0.5">Original message not loaded</span>
        </div>
      )}

      <div className={`group relative flex gap-3 px-2 hover:bg-accent/30 rounded-lg transition-all duration-300 ${isGrouped ? '' : 'py-2'} ${highlighted ? 'bg-primary/10' : ''} ${isMentioned && !highlighted ? 'bg-amber-500/[0.08]' : ''} ${isPublishing && !hasConfirmation ? 'opacity-50' : isPublishing ? 'opacity-75' : ''}`}>
        {/* Avatar or timestamp gutter */}
        {isGrouped ? (
          <div className="w-10 shrink-0 flex items-center justify-end">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity cursor-default">
                  {formatShortTime(msg.createdAt)}
                </span>
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">
                {formatFullDate(msg.createdAt)}
              </TooltipContent>
            </Tooltip>
          </div>
        ) : (
          <Avatar className="w-10 h-10 shrink-0 mt-0.5 cursor-pointer" onClick={() => onOpenProfile?.(msg.pubkey)}>
            {profile?.picture && <AvatarImage src={profile.picture} />}
            <AvatarFallback className="text-xs bg-primary/20 text-primary">
              {displayName.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        )}

        {/* Content */}
        <div className="flex-1 min-w-0">
          {!isGrouped && (
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground hover:underline cursor-pointer" onClick={() => onOpenProfile?.(msg.pubkey)}>{displayName}</span>
              <DnnBadge pubkey={msg.pubkey} />
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-[10px] text-muted-foreground cursor-default">{formatShortTime(msg.createdAt)}</span>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {formatFullDate(msg.createdAt)}
                </TooltipContent>
              </Tooltip>
              {msg.clientTag && (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="text-[10px] text-muted-foreground/60 cursor-default">· via {msg.clientTag}</span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">
                      This message was sent via {msg.clientTag}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          )}
          <ScrollableContent>
          {shouldBlurMsg ? (
            <div className="flex items-center gap-2.5 py-1.5 px-3 my-1 rounded-lg bg-muted/50 border border-border/50">
              <AlertTriangle size={14} className="text-amber-500 shrink-0" />
              <span className="text-xs text-muted-foreground">Content warning — not safe for work</span>
              <button
                onClick={() => setNsfwRevealed(true)}
                className="flex items-center gap-1 ml-auto text-xs font-medium text-primary hover:text-primary/80 bg-primary/10 hover:bg-primary/15 px-2.5 py-1 rounded-full transition-colors cursor-pointer"
              >
                <Eye size={12} /> Show
              </button>
            </div>
          ) : (
            <>
              {strippedContent && (
                <div className="text-sm text-foreground break-words">
                  <MessageContent content={strippedContent} emojiTags={msg.emojiTags} onProfileClick={(pk) => onOpenProfile?.(pk)} disableLinkPreviews={!showLinkPreviews} disableCustomEmojis={!showCustomEmojis} disableMedia={!showMedia} mutedWords={hideMutedWords ? mutedWords : undefined} suffix={msg.pubkey === myPubkey ? <PCRelayProgressIndicator eventId={msg.id} /> : undefined} />
                </div>
              )}
              {/* Media disabled placeholder (above media so it doesn't jump when preview loads) */}
              {!showMedia && hasMediaUrls && (
                <div className="flex items-center gap-2.5 py-1.5 px-3 my-1 rounded-lg bg-muted/40 border border-border/40">
                  <ImageOff size={14} className="text-muted-foreground shrink-0" />
                  <span className="text-xs text-muted-foreground">Media rendering disabled</span>
                  <div className="flex items-center gap-1.5 ml-auto">
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => setMediaPreview(p => !p)}
                            className={cn(
                              'flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full transition-colors cursor-pointer',
                              mediaPreview
                                ? 'text-amber-400 bg-amber-400/15 hover:bg-amber-400/20'
                                : 'text-muted-foreground hover:text-foreground bg-muted/60 hover:bg-muted'
                            )}
                          >
                            {mediaPreview ? <EyeOff size={11} /> : <Eye size={11} />}
                            {mediaPreview ? 'Hide' : 'Preview'}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">{mediaPreview ? 'Hide preview' : 'Quick preview'}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    {onOpenSettings && (
                      <button
                        onClick={onOpenSettings}
                        className="flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 bg-primary/10 hover:bg-primary/15 px-2.5 py-1 rounded-full transition-colors cursor-pointer"
                      >
                        <Filter size={11} /> Filter Settings
                      </button>
                    )}
                  </div>
                </div>
              )}
              {/* Media gallery (renders below placeholder when previewing) */}
              {(showMedia || mediaPreview) && hasMedia && <ContentMediaGroupsWithGallery content={msg.content} />}
              {/* Stickers — BlossomImg for integrity verification */}
              {(showMedia || mediaPreview) && msg.stickerTags && msg.stickerTags.length > 0 && (
                <div className={`flex flex-wrap gap-2 ${strippedContent ? 'mt-1' : ''}`}>
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
                            showSkeleton
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
              {/* GIFs — GifImg with skeleton + star-to-favorite */}
              {(showMedia || mediaPreview) && msg.gifTags && msg.gifTags.length > 0 && (
                <div className={`flex flex-wrap gap-2 ${strippedContent ? 'mt-1' : ''}`}>
                  {msg.gifTags.map(([name, url, nsfwFlag], i) => (
                    <div key={`gif-${url}-${i}`} className="relative group/gif">
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <GifImg
                              src={url || ''}
                              alt={name || 'GIF'}
                              className={`rounded-lg hover:opacity-80 transition-opacity ${nsfwFlag === 'nsfw' ? 'blur-lg hover:blur-none' : ''}`}
                              style={{ maxWidth: 220, maxHeight: 220, objectFit: 'contain' }}
                            />
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">{name || 'GIF'}{nsfwFlag === 'nsfw' ? ' (NSFW)' : ''}</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={async (e) => {
                                e.stopPropagation()
                                const store = useGifStore.getState()
                                const { signer: s, privateKey: pk } = useUserStore.getState()
                                const exists = store.favorites.some((f) => f.url === url)
                                const updated = exists ? store.favorites.filter((f) => f.url !== url) : [...store.favorites, { name: name || '', url, nsfw: nsfwFlag === 'nsfw', tagged: true }]
                                store.setFavorites(updated)
                                await publishGifFavorites(updated, s, pk).catch(() => { })
                              }}
                              className={`absolute top-1 right-1 w-6 h-6 rounded-full flex items-center justify-center transition-all cursor-pointer ${useGifStore.getState().favorites.some((f) => f.url === url)
                                ? 'bg-yellow-500/90 text-white opacity-80 hover:opacity-100'
                                : 'bg-black/50 text-white/80 opacity-0 group-hover/gif:opacity-100 hover:bg-black/70'
                                }`}
                            >
                              <Star size={12} fill={useGifStore.getState().favorites.some((f) => f.url === url) ? 'currentColor' : 'none'} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="text-xs">{useGifStore.getState().favorites.some((f) => f.url === url) ? 'Remove from favorites' : 'Add to favorites'}</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                  ))}
                </div>
              )}
              {msg.nsfw && !showNsfwPref && nsfwRevealed && (
                <button
                  onClick={() => setNsfwRevealed(false)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-muted/60 px-2 py-0.5 rounded-full transition-colors cursor-pointer mt-1 w-fit"
                >
                  <EyeOff size={11} /> Hide
                </button>
              )}
            </>
          )}
          </ScrollableContent>

          {/* Reaction bar + Zap badge — inside content div so it renders below message text */}
          {onAddReaction && (
            <ReactionBar
              reactions={reactions}
              messageId={msg.id}
              onAddReaction={onAddReaction}
              rawReactions={rawReactions?.map(r => ({ ...r, decrypted: true as const }))}
              onOpenProfile={onOpenProfile}
              disableCustomEmojis={!showCustomEmojis}
            >
              <PCZapBadge zaps={msgZaps} onOpenProfile={onOpenProfile} />
            </ReactionBar>
          )}
        </div>

        {/* Actions */}
        <PublicMessageActions msg={msg} onReply={onReply} onRequestDelete={onRequestDelete} onAddReaction={onAddReaction} />
      </div>
    </>
  )
}

/* ═══════════════════════════════════════════ */
/*  RELAY PROGRESS INDICATOR                   */
/* ═══════════════════════════════════════════ */

function PCRelayProgressIndicator({ eventId }: { eventId: string }) {
  const progress = usePublicChatStore((s) => s.relayProgress[eventId])
  const [showPopover, setShowPopover] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)

  // Close popover on click outside
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
/*  PUBLIC CHAT ZAP BADGE                      */
/* ═══════════════════════════════════════════ */

function PCZapBadge({ zaps, onOpenProfile }: { zaps?: ZapInfo[]; onOpenProfile?: (pubkey: string) => void }) {
  const [showZapList, setShowZapList] = useState(false)

  if (!zaps || zaps.length === 0) return null

  const totalSats = zaps.reduce((sum, z) => sum + z.amount, 0)

  return (
    <>
      <button
        onClick={() => setShowZapList(true)}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs cursor-pointer transition-colors border bg-yellow-400/10 border-yellow-400/30 text-yellow-400 hover:bg-yellow-400/20"
      >
        <Zap size={12} fill="currentColor" />
        <span className="font-semibold">{formatSats(totalSats)}</span>
        {zaps.length > 1 && (
          <span className="text-yellow-400/60">({zaps.length})</span>
        )}
      </button>
      {showZapList && (
        <ZapListModal
          open={showZapList}
          onClose={() => setShowZapList(false)}
          zaps={zaps}
          onOpenProfile={onOpenProfile}
        />
      )}
    </>
  )
}

/* ═══════════════════════════════════════════ */
/*  MESSAGE ACTIONS                            */
/* ═══════════════════════════════════════════ */

function PublicMessageActions({ msg, onReply, onRequestDelete, onAddReaction }: { msg: PublicChatMessage; onReply: () => void; onRequestDelete: () => void; onAddReaction?: (messageId: string, emoji: string, customUrl?: string) => void }) {
  const myPubkey = useUserStore((s) => s.pubkey)
  const isMine = msg.pubkey === myPubkey
  const [showMenu, setShowMenu] = useState(false)
  const [copied, setCopied] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [showZap, setShowZap] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top?: number; bottom?: number; left?: number; right?: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const dotsRef = useRef<HTMLButtonElement>(null)
  const reactBtnRef = useRef<HTMLButtonElement>(null)

  // Only show zap if author has a lightning address and it's not our own message
  const recipientProfile = getCachedProfile(msg.pubkey)
  const canZap = msg.pubkey !== myPubkey && !!recipientProfile?.lud16

  // Close menu on outside click
  useEffect(() => {
    if (!showMenu) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          dotsRef.current && !dotsRef.current.contains(e.target as Node)) setShowMenu(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showMenu])

  // Edge-aware: compute fixed position for dropdown so it escapes overflow containers
  useEffect(() => {
    if (!showMenu || !dotsRef.current) { setMenuPos(null); return }
    const raf = requestAnimationFrame(() => {
      const dotsRect = dotsRef.current!.getBoundingClientRect()
      const menuWidth = 192 // w-48 = 12rem = 192px
      const menuEl = menuRef.current
      const menuHeight = menuEl?.offsetHeight || 200

      const spaceBelow = window.innerHeight - dotsRect.bottom - 8
      const spaceAbove = dotsRect.top - 8
      const spaceRight = window.innerWidth - dotsRect.right - 8
      const spaceLeft = dotsRect.left - 8

      const pos: { top?: number; bottom?: number; left?: number; right?: number } = {}

      // Vertical: prefer below, flip up if not enough room
      if (spaceBelow >= menuHeight || spaceBelow >= spaceAbove) {
        pos.top = dotsRect.bottom + 4
      } else {
        pos.bottom = window.innerHeight - dotsRect.top + 4
      }

      // Horizontal: prefer anchoring right edge to dots right edge, flip if needed
      if (spaceRight >= 0 || dotsRect.right >= menuWidth) {
        // Anchor menu's right edge to dot button's right edge
        pos.right = window.innerWidth - dotsRect.right
      } else {
        // Not enough room — anchor menu's left edge to dot button's left edge
        pos.left = dotsRect.left
      }

      setMenuPos(pos)
    })
    return () => cancelAnimationFrame(raf)
  }, [showMenu])

  const copyEventId = () => {
    const nevent = nip19.neventEncode({ id: msg.id })
    navigator.clipboard.writeText(nevent)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
    setShowMenu(false)
  }

  return (
    <>
      <div className="absolute -top-1 right-2 hidden group-hover:flex items-center gap-0.5 bg-secondary border border-border rounded-md shadow-md px-0.5 py-1 z-10 animate-action-bar-in" onClick={(e) => e.stopPropagation()}>
        <TooltipProvider delayDuration={200}>
          {/* React */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button ref={reactBtnRef} onClick={() => setShowPicker(!showPicker)} className="p-1 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
                <Smile size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">React</TooltipContent>
          </Tooltip>
          {/* Reply */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={onReply} className="p-1 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
                <Reply size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">Reply</TooltipContent>
          </Tooltip>
          {/* Zap — only if author has lightning address */}
          {canZap && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={() => setShowZap(true)} className="p-1 rounded cursor-pointer text-muted-foreground hover:text-yellow-400 hover:bg-yellow-400/10 transition-colors">
                  <Zap size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">Zap</TooltipContent>
            </Tooltip>
          )}
          {/* More menu trigger */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button ref={dotsRef} onClick={() => setShowMenu(!showMenu)} className="p-1 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
                <MoreVertical size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">More</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Fixed-position dropdown — rendered outside the scroll container's overflow */}
      {showMenu && menuPos && (
        <div
          ref={menuRef}
          className="fixed w-48 bg-popover border border-border rounded-md shadow-lg p-1 flex flex-col gap-1 z-50"
          style={menuPos}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={copyEventId}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
          >
            {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
            {copied ? 'Copied!' : 'Copy Event Address'}
          </button>
          <button
            onClick={() => { setShowRaw(true); setShowMenu(false) }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
          >
            <Code size={14} /> View Raw Event
          </button>
          {isMine && (
            <>
              <div className="h-px bg-border mx-2" />
              <button
                onClick={() => { setShowMenu(false); onRequestDelete() }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10 cursor-pointer transition-colors rounded-md"
              >
                <Trash2 size={14} /> Request Delete
              </button>
            </>
          )}
        </div>
      )}

      {/* Raw event modal */}
      {showRaw && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-2" onClick={() => setShowRaw(false)}>
          <div className="absolute inset-0 bg-black/60" />
          <div className="relative z-10 w-full max-w-lg max-h-[80vh] rounded-xl border border-border bg-background shadow-2xl p-4 flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-foreground">Raw Event</h3>
              <button onClick={() => setShowRaw(false)} className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={16} /></button>
            </div>
            <pre className="flex-1 overflow-auto text-xs text-foreground bg-secondary/50 rounded-lg p-3 font-mono whitespace-pre-wrap break-all">
              {JSON.stringify({ id: msg.id, pubkey: msg.pubkey, created_at: msg.createdAt, kind: 1312, content: msg.content, topic: msg.topic, pow: msg.pow, nsfw: msg.nsfw, clientTag: msg.clientTag, replyTo: msg.replyTo, rootRef: msg.rootRef }, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {/* Emoji picker for reactions */}
      {showPicker && onAddReaction && (
        <EmojiPickerPopover
          anchorRef={reactBtnRef}
          onClose={() => setShowPicker(false)}
          onSelect={(emoji, customEmoji) => {
            onAddReaction(msg.id, emoji, customEmoji?.url)
            setShowPicker(false)
          }}
        />
      )}

      {/* Zap modal */}
      {showZap && recipientProfile?.lud16 && (
        <ZapModal
          open={showZap}
          onClose={() => setShowZap(false)}
          recipientPubkey={msg.pubkey}
          messageEventId={msg.id}
          messageKind={1312}
          disableSplit
        />
      )}
    </>
  )
}

/* ═══════════════════════════════════════════ */
/*  SETTINGS MODAL                             */
/* ═══════════════════════════════════════════ */

function PublicChatSettingsModal({ onClose }: { onClose: () => void }) {
  const powDifficulty = usePublicChatStore((s) => s.powDifficulty)
  const setPowDifficulty = usePublicChatStore((s) => s.setPowDifficulty)
  const showMedia = usePublicChatStore((s) => s.showMedia)
  const setShowMedia = usePublicChatStore((s) => s.setShowMedia)
  const showLinkPreviews = usePublicChatStore((s) => s.showLinkPreviews)
  const setShowLinkPreviews = usePublicChatStore((s) => s.setShowLinkPreviews)
  const showCustomEmojis = usePublicChatStore((s) => s.showCustomEmojis)
  const setShowCustomEmojis = usePublicChatStore((s) => s.setShowCustomEmojis)
  const dnnIdOnly = usePublicChatStore((s) => s.dnnIdOnly)
  const setDnnIdOnly = usePublicChatStore((s) => s.setDnnIdOnly)
  const wotApplyPublicChat = useWotStore((s) => s.settings.applyPublicChat)
  const updateWotSettings = useWotStore((s) => s.updateSettings)
  const globalEmbedsOn = usePreferencesStore((s) => s.showEmbeds)
  const globalMediaOn = usePreferencesStore((s) => s.showMedia)
  const globalEmojisOn = usePreferencesStore((s) => s.showCustomEmojis)

  const [hashRate, setHashRate] = useState<number | null>(null)
  const [manualInput, setManualInput] = useState(powDifficulty.toString())

  // Benchmark on mount
  useEffect(() => {
    benchmarkHashRate().then(setHashRate)
  }, [])

  // Keep manual input in sync
  useEffect(() => {
    setManualInput(powDifficulty.toString())
  }, [powDifficulty])

  const solveTimeStr = useMemo(() => {
    if (powDifficulty <= 0) return 'Disabled'
    const seconds = estimateSolveTime(powDifficulty, hashRate ?? undefined)
    if (seconds < 0.001) return '<1ms on this device'
    if (seconds < 1) return `~${Math.round(seconds * 1000)}ms on this device`
    if (seconds < 60) return `~${seconds.toFixed(1)}s on this device`
    if (seconds < 3600) return `~${(seconds / 60).toFixed(1)} min on this device`
    if (seconds < 86400) return `~${(seconds / 3600).toFixed(1)} hours on this device`
    return `~${(seconds / 86400).toFixed(1)} days on this device`
  }, [powDifficulty, hashRate])

  // Toggle switch helper
  const ToggleSwitch = ({ enabled, onToggle, icon, label, description, disabled }: {
    enabled: boolean
    onToggle: (v: boolean) => void
    icon: React.ReactNode
    label: string | React.ReactNode
    description: React.ReactNode
    disabled?: boolean
  }) => (
    <div className={cn('flex items-center justify-between gap-3 py-2', disabled && 'opacity-50')}>
      <div className="flex items-start gap-2.5 min-w-0">
        <div className="mt-0.5 shrink-0 text-muted-foreground">{icon}</div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <button
        onClick={() => !disabled && onToggle(!enabled)}
        className={cn(
          'relative shrink-0 w-9 h-5 rounded-full transition-colors',
          disabled ? 'cursor-not-allowed' : 'cursor-pointer',
          enabled ? 'bg-primary' : 'bg-muted-foreground/30'
        )}
      >
        <div className={cn(
          'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform',
          enabled ? 'translate-x-[18px]' : 'translate-x-0.5'
        )} />
      </button>
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-border bg-background shadow-2xl p-6 flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
            <Filter size={16} className="text-muted-foreground" />
            Public Chat Settings
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={18} /></button>
        </div>

        {/* Content Filters Section */}
        <div>
          <label className="text-sm font-medium text-foreground mb-1 flex items-center gap-1.5">
            <Eye size={14} className="text-blue-400" />
            Content Filters
          </label>
          <p className="text-xs text-muted-foreground mb-2">
            Control what content is rendered in public chat messages. Disabled content will show a placeholder.
          </p>

          <div className="flex flex-col divide-y divide-border/50">
            <ToggleSwitch
              enabled={globalMediaOn && showMedia}
              onToggle={setShowMedia}
              icon={<ImageOff size={14} />}
              label="Show Media"
              description={
                !globalMediaOn ? (
                  <span>
                    Disabled globally.{' '}
                    <button
                      onClick={() => {
                        onClose()
                        useNavigationStore.getState().setSettingsTab('moderation')
                        useNavigationStore.getState().setActivePage('settings')
                      }}
                      className="text-primary hover:underline cursor-pointer"
                    >
                      Enable in Settings → Moderation
                    </button>
                  </span>
                ) : 'Render images, stickers, and GIFs inline'
              }
              disabled={!globalMediaOn}
            />
            <ToggleSwitch
              enabled={globalEmbedsOn && showLinkPreviews}
              onToggle={setShowLinkPreviews}
              icon={<LinkIcon size={14} />}
              label="Show Link Previews & Embeds"
              description={
                !globalEmbedsOn ? (
                  <span>
                    Disabled globally.{' '}
                    <button
                      onClick={() => {
                        onClose()
                        useNavigationStore.getState().setSettingsTab('moderation')
                        useNavigationStore.getState().setActivePage('settings')
                      }}
                      className="text-primary hover:underline cursor-pointer"
                    >
                      Enable in Settings → Moderation
                    </button>
                  </span>
                ) : 'Render link preview cards and media embeds for URLs'
              }
              disabled={!globalEmbedsOn}
            />
            <ToggleSwitch
              enabled={globalEmojisOn && showCustomEmojis}
              onToggle={setShowCustomEmojis}
              icon={<Sticker size={14} />}
              label="Show Custom Emojis"
              description={
                !globalEmojisOn ? (
                  <span>
                    Disabled globally.{' '}
                    <button
                      onClick={() => {
                        onClose()
                        useNavigationStore.getState().setSettingsTab('moderation')
                        useNavigationStore.getState().setActivePage('settings')
                      }}
                      className="text-primary hover:underline cursor-pointer"
                    >
                      Enable in Settings → Moderation
                    </button>
                  </span>
                ) : 'Render custom emoji images in text and reactions'
              }
              disabled={!globalEmojisOn}
            />
            <ToggleSwitch
              enabled={wotApplyPublicChat}
              onToggle={(v) => updateWotSettings({ applyPublicChat: v })}
              icon={<Users size={14} />}
              label="Web of Trust filter"
              description={
                <span>
                  Only show messages from users who meet your trust threshold.{' '}
                  <button
                    onClick={() => {
                      onClose()
                      useNavigationStore.getState().setSettingsTab('moderation')
                      useNavigationStore.getState().setActivePage('settings')
                    }}
                    className="text-primary hover:underline cursor-pointer"
                  >
                    Adjust your WoT settings → Moderation
                  </button>
                </span>
              }
            />
            <ToggleSwitch
              enabled={dnnIdOnly}
              onToggle={setDnnIdOnly}
              icon={<BadgeCheck size={14} />}
              label="DNN ID holders only"
              description={
                <span>
                  Only show messages from users with a verified DNN ID.{' '}
                  <button
                    onClick={() => {
                      onClose()
                      useNavigationStore.getState().setSettingsSearchPrefill('dnn')
                      useNavigationStore.getState().setSettingsTab('faq')
                      useNavigationStore.getState().setActivePage('settings')
                    }}
                    className="text-primary hover:underline cursor-pointer"
                  >
                    Learn more about DNN → FAQ
                  </button>
                </span>
              }
            />
            <MutedWordsToggle onClose={onClose} />
            <ToggleSwitch
              enabled={false}
              onToggle={() => { }}
              disabled
              icon={<Crown size={14} />}
              label={
                <span className="flex items-center gap-2">
                  Premium subscribers only
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-400/15 text-amber-400 font-medium">Coming soon</span>
                </span>
              }
              description={
                <span>
                  Only show messages from users with an active DEN Chat premium subscription.{' '}
                  <button
                    onClick={() => {
                      onClose()
                      useNavigationStore.getState().setSettingsTab('premium')
                      useNavigationStore.getState().setActivePage('settings')
                    }}
                    className="text-primary hover:underline cursor-pointer"
                  >
                    Learn more about Premium →
                  </button>
                </span>
              }
            />
          </div>
        </div>


        <div className="h-px bg-border" />

        {/* PoW Section */}
        <div>
          <label className="text-sm font-medium text-foreground mb-1 flex items-center gap-1.5">
            <Shield size={14} className="text-amber-400" />
            Proof of Work
          </label>
          <p className="text-xs text-muted-foreground mb-3">
            Controls both what messages you see and the work your own messages require. Higher difficulty = more spam protection but slower sending.
          </p>

          <div className="flex items-center gap-3 mb-2">
            <div className="flex-1 relative h-6 flex items-center">
              {/* Track background */}
              <div className="absolute left-0 right-0 h-1.5 rounded-full bg-muted-foreground/20" />
              {/* Filled track */}
              <div
                className="absolute left-0 h-1.5 rounded-full bg-amber-400 transition-all"
                style={{ width: `${Math.min(powDifficulty, 100)}%` }}
              />
              {/* Visible thumb */}
              <div
                className="absolute w-4 h-4 rounded-full bg-amber-400 border-2 border-background shadow-lg pointer-events-none transition-all"
                style={{ left: `calc(${Math.min(powDifficulty, 100)}% - 8px)` }}
              />
              {/* Invisible native range */}
              <input
                type="range"
                min={0}
                max={100}
                value={Math.min(powDifficulty, 100)}
                onChange={(e) => setPowDifficulty(parseInt(e.target.value, 10))}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
            </div>
            <div className="flex items-center h-7 rounded-md border border-input bg-background overflow-hidden">
              <button
                onClick={() => { const v = Math.max(0, powDifficulty - 1); setPowDifficulty(v) }}
                className="h-full px-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer flex items-center"
              >
                <Minus size={12} />
              </button>
              <span className="px-2 text-sm text-foreground tabular-nums min-w-[28px] text-center">
                {powDifficulty}
              </span>
              <button
                onClick={() => setPowDifficulty(powDifficulty + 1)}
                className="h-full px-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer flex items-center"
              >
                <Plus size={12} />
              </button>
            </div>
            {powDifficulty !== 15 ? (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setPowDifficulty(15)}
                      className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    >
                      <RotateCcw size={14} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">Reset to default (15)</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <div className="p-1 w-[22px]" />
            )}
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className={cn(
              'font-medium',
              powDifficulty === 0 ? 'text-muted-foreground' : powDifficulty <= 16 ? 'text-emerald-400' : powDifficulty <= 24 ? 'text-amber-400' : 'text-red-400'
            )}>
              {powDifficulty === 0 ? 'No PoW required' : `Difficulty: ${powDifficulty} bits`}
            </span>
            <span className="text-muted-foreground">
              {hashRate ? solveTimeStr : 'Benchmarking…'}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════ */
/*  MUTED WORDS TOGGLE                         */
/* ═══════════════════════════════════════════ */

function MutedWordsToggle({ onClose }: { onClose: () => void }) {
  const hideMutedWords = usePublicChatStore((s) => s.hideMutedWords)
  const setHideMutedWords = usePublicChatStore((s) => s.setHideMutedWords)
  const mutedWordsCount = useBlockStore((s) => s.mutedWords).size
  const globalHideMuted = usePreferencesStore((s) => s.hideMutedWords)

  const effectiveEnabled = globalHideMuted && hideMutedWords
  const isDisabled = !globalHideMuted

  return (
    <div className={cn('flex items-center justify-between gap-3 py-1', isDisabled && 'opacity-50')}>
      <div className="flex items-start gap-2.5 min-w-0">
        <div className="mt-0.5 shrink-0 text-muted-foreground"><MessageCircleOff size={14} /></div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Hide Muted Words</p>
          <p className="text-xs text-muted-foreground">
            {!globalHideMuted ? (
              <span>
                Disabled globally.{' '}
                <button
                  onClick={() => {
                    onClose()
                    useNavigationStore.getState().setSettingsTab('moderation')
                    useNavigationStore.getState().setActivePage('settings')
                  }}
                  className="text-primary hover:underline cursor-pointer"
                >
                  Enable in Settings → Moderation
                </button>
              </span>
            ) : (
              <span>
                Redact words from your muted words list ({mutedWordsCount} word{mutedWordsCount !== 1 ? 's' : ''}).{' '}
                <button
                  onClick={() => {
                    onClose()
                    useNavigationStore.getState().setSettingsTab('moderation')
                    useNavigationStore.getState().setActivePage('settings')
                  }}
                  className="text-primary hover:underline cursor-pointer"
                >
                  Manage in Settings → Moderation
                </button>
              </span>
            )}
          </p>
        </div>
      </div>
      <button
        onClick={() => !isDisabled && setHideMutedWords(!hideMutedWords)}
        className={cn(
          'relative shrink-0 w-9 h-5 rounded-full transition-colors',
          isDisabled ? 'cursor-not-allowed' : 'cursor-pointer',
          effectiveEnabled ? 'bg-primary' : 'bg-muted-foreground/30'
        )}
      >
        <div className={cn(
          'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform',
          effectiveEnabled ? 'translate-x-[18px]' : 'translate-x-0.5'
        )} />
      </button>
    </div>
  )
}
