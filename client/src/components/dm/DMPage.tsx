/**
 * DMPage — Encrypted Direct Messages
 *
 * Supports two protocols:
 * - "Private" (NIP-04): standard encrypted DMs with replies, threads, reactions
 * - "Extra Private" (NIP-17): gift-wrapped DMs with metadata protection
 *
 * Two-panel layout:
 * - Left: conversation list with protocol tabs, search, Following/Other tabs
 * - Right: chat view (DM04ChatView for NIP-04, DMChatView for NIP-17)
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { getDraft, setDraft, clearDraft, dm17DraftKey } from '@/stores/draftStore'
import { createPortal } from 'react-dom'
import { useUserStore } from '@/stores/userStore'
import { useDMStore, type DMMessage } from '@/stores/dmStore'
import { setNameFromAddress } from '@/lib/customSets'
import { useDM04Store } from '@/stores/dm04Store'
import { DM04ChatView } from '@/components/dm/DM04ChatView'
import { useBlockStore } from '@/stores/blockStore'
import { useFollowStore } from '@/stores/followStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { NewDMModal } from '@/components/dm/NewDMModal'
import { UserProfileModal } from '@/components/hub/UserProfileModal'
import { UserPanel } from '@/components/ui/UserPanel'
import { ResizablePanel } from '@/components/ui/ResizablePanel'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { truncateNpub, formatTimestamp } from '@/lib/utils'
import { getHour12 } from '@/stores/preferencesStore'
import { nip19, type Event } from 'nostr-tools'
import { getUploadBlossoms, getPublishRelays } from '@/stores/postingBehaviourStore'
import {
  Search, Plus, MessageSquare, Loader2,
  Lock, Users, UserPlus, AlertCircle, X, ShieldBan, Eye, EyeOff, Shield, ShieldCheck, Info,
  AlertTriangle, Download, Star, ChevronLeft, Check, NotebookPen,
} from 'lucide-react'
import { MessageContent } from '@/components/chat/MessageContent'
import { ScrollableContent } from '../chat/ScrollableContent'
import { ContentMediaGroupsWithGallery, extractContentMediaGroups } from '@/components/chat/ContentMediaGrouping'
import { ImageGallery } from '@/components/social/RichContent'
import { DnnBadge } from '@/components/ui/DnnBadge'
import { useBlossomMedia } from '@/hooks/useBlossomMedia'
import { VerificationBadge } from '@/components/ui/VerificationBadge'
import { useGifStore } from '@/stores/gifStore'
import { publishGifFavorites } from '@/lib/nostr/customGif'
import { ChatInputBar, type FileAttachment } from '@/components/chat/ChatInputBar'
import { EmojiPickerPopover, EmojiDiscoveryModal } from '@/components/chat/EmojiPickerPopover'
import { StickerPickerPopover, StickerDiscoveryModal } from '@/components/chat/StickerPickerPopover'
import { BlossomImg } from '@/components/ui/BlossomImg'
import { getEmojiMap } from '@/stores/emojiStore'
import { decryptFile } from '@/lib/crypto/fileEncryption'
import { downloadFromBlossom } from '@/lib/blossom/client'
import { CustomAudioPlayer } from '@/components/ui/CustomAudioPlayer'
import { createFileGiftWrap } from '@/lib/nostr/nip17'

import { publishToSpecificRelays } from '@/lib/nostr/relay-pool'
import { useNotificationStore } from '@/stores/notificationStore'
import { useUnreadDivider } from '@/hooks/useUnreadDivider'
import { NewMessagesDivider } from '@/components/chat/NewMessagesDivider'
import { UnreadBanner } from '@/components/chat/UnreadBanner'
import { discoverRecipientRelays } from '@/lib/nostr/relayDiscovery'

/* ═══════════════════════════════════════════ */
/*  HELPERS                                    */
/* ═══════════════════════════════════════════ */

/** GIF star overlay for DMs — with publish spinner + blossom failover (matches hub chat) */
export function DMGifStarOverlay({ name, url, nsfw }: { name: string; url: string; nsfw: string }) {
  const isFav = useGifStore((s) => s.favorites.some((f) => f.url === url))
  const [publishing, setPublishing] = useState(false)
  const blossom = useBlossomMedia(url)

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (publishing) return
    setPublishing(true)
    const started = Date.now()
    try {
      const store = useGifStore.getState()
      const { signer: s, privateKey: pk } = useUserStore.getState()
      const updated = isFav
        ? store.favorites.filter((f) => f.url !== url)
        : [...store.favorites, { name: name || '', url, nsfw: nsfw === 'nsfw', tagged: true }]
      store.setFavorites(updated)
      await publishGifFavorites(updated, s, pk)
    } catch {
      // silently ignore
    }
    const elapsed = Date.now() - started
    if (elapsed < 800) await new Promise((r) => setTimeout(r, 800 - elapsed))
    setPublishing(false)
  }

  const [loaded, setLoaded] = useState(false)

  if (blossom.loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <Loader2 size={14} className="animate-spin" />
        {blossom.serverIndex > 0
          ? <span>Trying server {blossom.serverIndex + 1} of {blossom.totalServers}…</span>
          : <span>Loading image…</span>}
      </div>
    )
  }

  if (blossom.error === 'not-found') {
    return (
      <div className="rounded-lg mt-1 bg-destructive/10 border border-destructive/30 flex flex-col items-center text-xs py-3 px-3 gap-1 max-w-[400px]">
        <span className="text-muted-foreground">Image not found on any server</span>
        <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary text-xs hover:underline">⬇ Try direct link</a>
      </div>
    )
  }

  return (
    <div className="relative group/gif inline-block w-fit mt-1">
      {!loaded && (
        <span className="media-skeleton inline-block" style={{ width: 300, height: 200, maxWidth: '100%' }} />
      )}
      <img
        src={blossom.src || url}
        alt={name || 'GIF'}
        className={`max-w-[400px] max-[1080px]:max-w-full max-h-[300px] rounded-lg border border-transparent hover:border-border transition-colors object-contain hover:brightness-110 transition-all ${nsfw === 'nsfw' ? 'blur-lg hover:blur-none' : ''} ${!loaded ? 'opacity-0 h-0 overflow-hidden block' : ''}`}
        onLoad={() => setLoaded(true)}
      />
      {loaded && blossom.verified !== 'verified' && blossom.expectedHash && (
        <VerificationBadge
          verified={blossom.verified}
          expectedHash={blossom.expectedHash}
          servers={blossom.servers}
          ext={blossom.ext}
          onRecovered={blossom.acceptVerifiedUrl}
        />
      )}
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleToggle}
              disabled={publishing}
              className={`absolute top-1 right-1 w-6 h-6 rounded-full flex items-center justify-center transition-all cursor-pointer ${
                publishing
                  ? 'bg-yellow-500/70 text-white opacity-100 animate-pulse'
                  : isFav
                    ? 'bg-yellow-500/90 text-white opacity-80 hover:opacity-100'
                    : 'bg-black/50 text-white/80 opacity-0 group-hover/gif:opacity-100 hover:bg-black/70'
              }`}
            >
              {publishing
                ? <Loader2 size={12} className="animate-spin" />
                : <Star size={12} fill={isFav ? 'currentColor' : 'none'} />
              }
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">{publishing ? 'Publishing…' : isFav ? 'Remove from favorites' : 'Add to favorites'}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}

/** 5 minutes grouping window (same as hub chat) */
const DM_GROUP_WINDOW_S = 5 * 60

function isDMDifferentDay(ts1: number, ts2: number): boolean {
  return new Date(ts1 * 1000).toDateString() !== new Date(ts2 * 1000).toDateString()
}

function formatDMDaySeparator(ts: number): string {
  const d = new Date(ts * 1000)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)

  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
}

function formatDMTimestamp(ts: number): string {
  return formatTimestamp(ts)
}

function formatDMShortTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: getHour12() })
}

/* ═══════════════════════════════════════════ */
/*  MAIN PAGE                                  */
/* ═══════════════════════════════════════════ */

export type DMProtocol = 'nip17' | 'nip04'

export function DMPage() {
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  // NIP-17 (Extra Private)
  const loadingNip17 = useDMStore((s) => s.loading)
  const nip17Active = useDMStore((s) => s.activeConversation)
  const setNip17Active = useDMStore((s) => s.setActiveConversation)

  // NIP-04 (Private)
  const loadingNip04 = useDM04Store((s) => s.loading)
  const nip04Active = useDM04Store((s) => s.activeConversation)
  const setNip04Active = useDM04Store((s) => s.setActiveConversation)

  const [dmProtocol, setDmProtocol] = useState<DMProtocol>('nip04')
  const [showNewDM, setShowNewDM] = useState(false)
  // Start with list hidden on mobile if there's already an active conversation
  // (e.g. navigated here via UserProfileModal → onDM)
  const [mobileShowList, setMobileShowList] = useState(
    () => !useDM04Store.getState().activeConversation && !useDMStore.getState().activeConversation
  )

  // Use the follow store loaded at startup — no re-fetch needed on mount
  const followSet = useFollowStore((s) => s.followedPubkeys)

  // Active conversation based on protocol
  const activeConversation = dmProtocol === 'nip04' ? nip04Active : nip17Active
  const setActiveConversation = dmProtocol === 'nip04' ? setNip04Active : setNip17Active
  const loading = dmProtocol === 'nip04' ? loadingNip04 : loadingNip17

  // When the active conversation changes externally (e.g. onDM from profile),
  // automatically switch to the chat panel on mobile.
  useEffect(() => {
    if (activeConversation) {
      setMobileShowList(false)
    }
  }, [activeConversation])

  // DM subscriptions are now started at app launch in useStartup.ts
  // No need to start/stop them on DMPage mount/unmount

  const handleSelectConversation = useCallback((pubkey: string) => {
    setActiveConversation(pubkey)
    setMobileShowList(false)
  }, [setActiveConversation])

  const handleStartConversation = useCallback((pubkey: string) => {
    setActiveConversation(pubkey)
    setMobileShowList(false)
  }, [setActiveConversation])

  const handleMobileBack = useCallback(() => {
    setMobileShowList(true)
  }, [])

  return (
    <div className="flex flex-1 h-full overflow-hidden">
      {/* Left — Conversation list */}
      <ConversationList
        onNewMessage={() => setShowNewDM(true)}
        activePubkey={activeConversation}
        onSelect={handleSelectConversation}
        loading={loading}
        followSet={followSet}
        dmProtocol={dmProtocol}
        onProtocolChange={setDmProtocol}
        mobileShowList={mobileShowList}
      />

      {/* Right — Chat */}
      <div className={`flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-background pr-2 py-2 gap-2 max-[1080px]:px-2 ${mobileShowList ? 'max-[1080px]:hidden' : ''}`}>
        {activeConversation ? (
          dmProtocol === 'nip04'
            ? <DM04ChatView recipientPubkey={activeConversation} onSwitchProtocol={() => { setDmProtocol('nip17'); setNip17Active(activeConversation) }} onBack={handleMobileBack} />
            : <DMChatView recipientPubkey={activeConversation} onSwitchProtocol={() => { setDmProtocol('nip04'); setNip04Active(activeConversation) }} onBack={handleMobileBack} />
        ) : (
          <DMEmptyState />
        )}
      </div>

      <NewDMModal
        open={showNewDM}
        onClose={() => setShowNewDM(false)}
        onStartConversation={handleStartConversation}
      />
    </div>
  )
}

/* ═══════════════════════════════════════════ */
/*  CONVERSATION LIST (Left Panel)             */
/* ═══════════════════════════════════════════ */

function ConversationList({
  onNewMessage,
  activePubkey,
  onSelect,
  loading,
  followSet,
  dmProtocol,
  onProtocolChange,
  mobileShowList,
}: {
  onNewMessage: () => void
  activePubkey: string | null
  onSelect: (pubkey: string) => void
  loading: boolean
  followSet: Set<string>
  dmProtocol: DMProtocol
  onProtocolChange: (protocol: DMProtocol) => void
  mobileShowList: boolean
}) {
  // NIP-17 store
  const getNip17Conversations = useDMStore((s) => s.getFilteredConversations)
  const nip17Conversations = useDMStore((s) => s.conversations)
  const nip17Pending = useDMStore((s) => s.pendingConversations)
  // NIP-04 store
  const getNip04Conversations = useDM04Store((s) => s.getFilteredConversations)
  const nip04Conversations = useDM04Store((s) => s.conversations)
  const nip04Pending = useDM04Store((s) => s.pendingConversations)

  // Block list — needed so the memo re-runs when users are blocked/unblocked
  const blockedPubkeys = useBlockStore((s) => s.blockedPubkeys)
  const myPubkey = useUserStore((s) => s.pubkey)

  const { getProfile } = useProfileCache()

  const [tab, setTab] = useState<'following' | 'other'>('following')
  const [search, setSearch] = useState('')
  const [showProtocolInfo, setShowProtocolInfo] = useState(false)

  // Get conversations from the active protocol's store
  const { following, other } = useMemo(
    () => dmProtocol === 'nip04'
      ? getNip04Conversations(followSet)
      : getNip17Conversations(followSet),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [followSet, dmProtocol, nip17Conversations, nip17Pending, nip04Conversations, nip04Pending, blockedPubkeys],
  )

  const activeList = tab === 'following' ? following : other

  // Filter by search
  const filteredList = useMemo(() => {
    if (!search.trim()) return activeList
    const q = search.toLowerCase().trim()
    return activeList.filter((conv) => {
      const profile = getProfile(conv.pubkey)
      const name = (profile?.display_name || profile?.name || '').toLowerCase()
      const npubStr = nip19.npubEncode(conv.pubkey).toLowerCase()
      return name.includes(q) || npubStr.includes(q)
    })
  }, [search, activeList, getProfile])

  return (
    <ResizablePanel id="dm" defaultWidth={280} minWidth={200} maxWidth={420} className={`flex flex-col bg-background pr-2 py-2 gap-2 h-full overflow-hidden max-[1080px]:p-2 max-[1080px]:!w-full max-[1080px]:!min-w-0 max-[1080px]:!max-w-none ${mobileShowList ? '' : 'max-[1080px]:!hidden'}`}>
      {/* Header */}
      <div className="px-3 py-3 bg-secondary/50 rounded-md shadow-md flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Lock size={14} className="text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Direct Messages</h2>
        </div>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onNewMessage}
                className="p-1.5 rounded-lg hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                <Plus size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">New Message</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Protocol tabs — Private (NIP-04) / Extra Private (NIP-17) */}
      <div className="pt-2 pb-1 shrink-0">
        <div className="flex items-center gap-1 p-0.5 rounded-lg bg-secondary/60 border border-border">
          <button
            onClick={() => onProtocolChange('nip04')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-medium rounded-md transition-all cursor-pointer
              ${dmProtocol === 'nip04'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Shield size={12} /> Private
          </button>
          <button
            onClick={() => onProtocolChange('nip17')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-medium rounded-md transition-all cursor-pointer
              ${dmProtocol === 'nip17'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'}`}
          >
            <ShieldCheck size={12} /> Extra Private
          </button>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setShowProtocolInfo(!showProtocolInfo)}
                  className="px-1 py-1 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                  <Info size={11} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="text-xs max-w-[220px]">
                <p className="font-medium">Private (NIP-04)</p>
                <p className="text-muted-foreground">Encrypted messages with replies, threads, and reactions. Relay can see who the sender and receivers are.</p>
                <p className="font-medium mt-1.5">Extra Private (NIP-17)</p>
                <p className="text-muted-foreground">Gift-wrapped messages. Relay cannot see who the sender is and timming is obfuscated.</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {/* DM self (NIP-04 only) — open an encrypted conversation with your own key */}
      {dmProtocol === 'nip04' && myPubkey && (
        <div className="pb-0.5 shrink-0 mt-1.5">
          <button
            onClick={() => onSelect(myPubkey)}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-medium rounded-md bg-secondary/40 border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer"
          >
            <NotebookPen size={12} /> DM self
          </button>
        </div>
      )}

      {/* Following/Other tabs + Search + conversation list — one card */}
      <div className="flex-1 min-h-0 flex flex-col gap-2 p-2 rounded-md bg-secondary/50 shadow-md">
      {/* Following / Other tabs */}
      <div className="flex gap-1 shrink-0">
        <button
          onClick={() => setTab('following')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer
            ${tab === 'following' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}`}
        >
          <Users size={13} /> Following {following.length > 0 && `(${following.length})`}
        </button>
        <button
          onClick={() => setTab('other')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer
            ${tab === 'other' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}`}
        >
          <UserPlus size={13} /> Other {other.length > 0 && `(${other.length})`}
        </button>
      </div>

      {/* Search */}
      <div className="shrink-0">
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-secondary/50 border border-border">
          <Search size={13} className="text-muted-foreground shrink-0" />
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
          />
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 size={16} className="animate-spin mr-2" />
            <span className="text-xs">Loading messages...</span>
          </div>
        ) : filteredList.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2 text-center">
            <MessageSquare size={20} className="text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground">
              {search ? 'No conversations match your search.' : tab === 'following'
                ? 'No DMs with followed users yet.'
                : 'No DMs from other users yet.'}
            </p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {filteredList.map((conv) => {
              const profile = getProfile(conv.pubkey)
              const npubStr = nip19.npubEncode(conv.pubkey)
              const isActive = activePubkey === conv.pubkey
              return (
                <button
                  key={conv.pubkey}
                  onClick={() => onSelect(conv.pubkey)}
                  className={`flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg transition-colors cursor-pointer text-left
                    ${isActive
                      ? 'bg-primary/10 border border-primary/20'
                      : 'hover:bg-secondary/60 border border-transparent'
                    }`}
                >
                  <Avatar className="h-9 w-9 shrink-0">
                    {profile?.picture && <AvatarImage src={profile.picture} />}
                    <AvatarFallback className="text-xs bg-primary/20 text-primary">
                      {(profile?.display_name || profile?.name || npubStr).slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-foreground truncate">
                        {profile?.display_name || profile?.name || truncateNpub(npubStr, 8)}
                      </p>
                      {conv.lastMessageAt > 0 && (
                        <span className="text-[10px] text-muted-foreground shrink-0 ml-1">
                          {formatTimestamp(conv.lastMessageAt)}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {conv.lastMessagePreview || 'No messages yet'}
                    </p>
                  </div>
                  {conv.unread > 0 && (
                    <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center shrink-0">
                      <span className="text-[10px] font-bold text-primary-foreground">{conv.unread > 9 ? '9+' : conv.unread}</span>
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
      </div>

      <div className="max-[1080px]:hidden">
        <UserPanel />
      </div>
    </ResizablePanel>
  )
}

/* ═══════════════════════════════════════════ */
/*  CHAT VIEW (Right Panel)                    */
/* ═══════════════════════════════════════════ */

interface OptimisticDM17 {
  tempId: string
  content: string
  timestamp: number
  status: 'publishing' | 'published' | 'failed'
  relayProgress?: { confirmed: number; total: number }
}

function DMChatView({ recipientPubkey, onSwitchProtocol, onBack }: { recipientPubkey: string; onSwitchProtocol: () => void; onBack?: () => void }) {
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const conversations = useDMStore((s) => s.conversations)
  const sendMessage = useDMStore((s) => s.sendMessage)
  const loadOlderMessages = useDMStore((s) => s.loadOlderMessages)
  const loadingOlder = useDMStore((s) => s.loadingOlder)
  const { getProfile } = useProfileCache()

  const _dm17Key = dm17DraftKey(recipientPubkey)
  const [message, setMessage] = useState(() => getDraft(_dm17Key))
  // Load correct draft when switching conversations
  const _prevDm17Key = useRef(_dm17Key)
  useEffect(() => {
    if (_prevDm17Key.current !== _dm17Key) {
      _prevDm17Key.current = _dm17Key
      setMessage(getDraft(_dm17Key))
    }
  }, [_dm17Key])
  useEffect(() => { setDraft(_dm17Key, message) }, [_dm17Key, message])
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const chatContainerRef = useRef<HTMLDivElement>(null)

  // ─── Emoji click modal state ───
  const [clickedEmoji, setClickedEmoji] = useState<{ shortcode: string; url: string; setAddress: string | null } | null>(null)
  const [discoverSearch, setDiscoverSearch] = useState<{ search: string; author: string } | null>(null)

  // ─── Sticker state ───
  type PendingSticker = { shortcode: string; url: string; setAddress: string }
  const [pendingStickers, setPendingStickers] = useState<PendingSticker[]>([])

  // ─── GIF state ───
  type PendingGif = { name: string; url: string; nsfw: boolean }
  const [pendingGifs, setPendingGifs] = useState<PendingGif[]>([])

  // ─── Optimistic messages ───
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticDM17[]>([])

  // Clear optimistic messages when switching conversations (component is reused, not remounted)
  useEffect(() => {
    setOptimisticMessages([])
  }, [recipientPubkey])

  // ─── Sticker click modal state ───
  const [clickedSticker, setClickedSticker] = useState<{ shortcode: string; url: string; setAddress: string | null } | null>(null)
  const [stickerDiscoverSearch, setStickerDiscoverSearch] = useState<{ search: string; author: string } | null>(null)

  useEffect(() => {
    const emojiHandler = ((e: unknown) => {
      const detail = (e as CustomEvent).detail as { shortcode: string; url: string; setAddress: string | null }
      setClickedEmoji(detail)
    }) as unknown as EventListener
    const stickerHandler = ((e: unknown) => {
      const detail = (e as CustomEvent).detail as { shortcode: string; url: string; setAddress: string | null }
      setClickedSticker(detail)
    }) as unknown as EventListener
    window.addEventListener('emoji-click', emojiHandler)
    window.addEventListener('sticker-click', stickerHandler)
    return () => {
      window.removeEventListener('emoji-click', emojiHandler)
      window.removeEventListener('sticker-click', stickerHandler)
    }
  }, [])

  const conv = conversations.get(recipientPubkey)
  const messages = conv?.messages || []
  const hasMore = conv?.hasMore ?? true
  const profile = getProfile(recipientPubkey)
  const npubStr = nip19.npubEncode(recipientPubkey)
  const hasNip44 = !!(privateKey || signer?.nip44)

  const [showProfile, setShowProfile] = useState(false)

  // ── New-messages divider ──
  const dm17LastRead = useNotificationStore((s) => s.dm17Unreads[recipientPubkey]?.lastRead ?? 0)
  const {
    dividerRef: newMsgDividerRef,
    unreadCount: newMsgUnreadCount,
    dividerTimestamp: newMsgSnapshot,
    showBanner: showUnreadBanner,
    dismissBanner: dismissUnreadBanner,
    jumpToDivider: jumpToNewMsgDivider,
    shouldInsertDivider,
    dividerHidden,
  } = useUnreadDivider(dm17LastRead, messages, (m) => m.createdAt, `dm17:${recipientPubkey}`, myPubkey, (m) => m.isMine ? (myPubkey || '') : recipientPubkey)

  // Track whether user is near bottom (column-reverse: scrollTop=0 is bottom)
  const isAtBottomRef = useRef(true)
  const handleScroll = useCallback(() => {
    const el = messagesContainerRef.current
    if (!el) return
    const threshold = 80
    isAtBottomRef.current = Math.abs(el.scrollTop) < threshold
  }, [])

  // Auto-scroll to bottom on new messages — only if user is near bottom
  const prevMsgCountRef = useRef(messages.length)
  useEffect(() => {
    if (messages.length > prevMsgCountRef.current && isAtBottomRef.current) {
      if (messagesContainerRef.current) messagesContainerRef.current.scrollTop = 0
    } else if (prevMsgCountRef.current === 0 && messages.length > 0) {
      if (messagesContainerRef.current) messagesContainerRef.current.scrollTop = 0
    }
    prevMsgCountRef.current = messages.length
  }, [messages.length])

  // Reconcile optimistic messages with store — remove when real message appears
  useEffect(() => {
    if (optimisticMessages.length === 0) return
    const toRemove = optimisticMessages.filter((opt) =>
      messages.some((m) =>
        m.isMine &&
        m.content === opt.content &&
        Math.abs(m.createdAt - opt.timestamp) < 10
      )
    )
    if (toRemove.length > 0) {
      const removeIds = new Set(toRemove.map((o) => o.tempId))
      const timer = setTimeout(() => {
        setOptimisticMessages((prev) => prev.filter((m) => !removeIds.has(m.tempId)))
      }, 300)
      return () => clearTimeout(timer)
    }
  }, [messages, optimisticMessages])

  // Safety: remove stale published optimistic messages after 30s
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

  // Auto-scroll when optimistic messages added
  useEffect(() => {
    if (optimisticMessages.length > 0) {
      if (messagesContainerRef.current) messagesContainerRef.current.scrollTop = 0
      isAtBottomRef.current = true
    }
  }, [optimisticMessages.length])

  const handleSend = useCallback(async (attachments?: FileAttachment[]) => {
    const text = message.trim()
    if (!text && !attachments?.length && pendingStickers.length === 0 && pendingGifs.length === 0) return
    if (!myPubkey || sending) return

    setSending(true)
    setSendError(null)
    isAtBottomRef.current = true // Ensure we scroll when our own message arrives

    // Separate file attachments (with encryption metadata from ChatInputBar) from the rest
    const fileAttachments = attachments?.filter((a) => a.encryption) || []
    const hasFiles = fileAttachments.length > 0

    // Build the text message content (NO attachment URLs — files go as kind 15)
    let content = text

    // Append GIF URLs to content (GIFs stay as kind 14 content, not kind 15)
    if (pendingGifs.length > 0) {
      const gifLinks = pendingGifs.map((g) => g.url).join('\n')
      content = content ? `${content}\n${gifLinks}` : gifLinks
    }

    setMessage('')
    clearDraft(_dm17Key)

    const tempId = `opt-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setOptimisticMessages((prev) => [
      ...prev,
      { tempId, content: content || text, timestamp: Math.floor(Date.now() / 1000), status: 'publishing' },
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

      // Build GIF tags from pending GIFs
      const gifTagsToSend: [string, string, string, string][] = pendingGifs.map((g) => [
        'j', g.name, g.url, g.nsfw ? 'nsfw' : 'sfw',
      ])

      // ─── Send text message (kind 14) ───
      // Always send if there's text/stickers/gifs, OR if files need a parent to link to
      let parentRumorId: string | undefined

      if (content || stickerTagsToSend.length > 0 || hasFiles) {
        // If there's no text but we have files, we still send a kind 14 to serve as parent
        const textContent = content || ''

        const { rumorId } = await sendMessage(
          recipientPubkey, textContent, myPubkey, signer, privateKey,
          emojiTagsToSend.length > 0 ? emojiTagsToSend : undefined,
          stickerTagsToSend.length > 0 ? stickerTagsToSend : undefined,
          gifTagsToSend.length > 0 ? gifTagsToSend : undefined,
          (phase, relayProgress) => {
            setOptimisticMessages((prev) =>
              prev.map((m) => {
                if (m.tempId !== tempId) return m
                if (phase === 'publishing' && relayProgress && relayProgress.confirmed > 0) {
                  return { ...m, status: 'published' as const, relayProgress }
                }
                return { ...m, relayProgress: relayProgress || m.relayProgress }
              })
            )
          },
        )

        // Use the actual rumor ID from createGiftWrap for e-tag linking
        if (hasFiles) {
          parentRumorId = rumorId
        }
      }

      // ─── Send encrypted file attachments (kind 15) ───
      // Files are already encrypted + uploaded by ChatInputBar (encryptBeforeUpload).
      // We only need to create the kind 15 gift wraps with the stored metadata.
      if (hasFiles) {
        const publishRelays = getPublishRelays()

        // Discover recipient's preferred relays (NIP-65 + DM relay list + DNN metadata)
        const extraRelays = await discoverRecipientRelays(recipientPubkey, publishRelays)
        const recipientRelays = extraRelays.length > 0
          ? [...publishRelays, ...extraRelays]
          : publishRelays

        const blossomServers = getUploadBlossoms()

        for (const attachment of fileAttachments) {
          if (!attachment.encryption) continue

          // Build Blossom URL from the ciphertext hash
          // Prefer the server where the file was actually uploaded (from ChatInputBar)
          const uploadedServer = attachment.serverUrls?.[0]?.replace(/\/+$/, '')
          const fallbackServer = blossomServers[0]?.replace(/\/+$/, '') || 'https://blossom.primal.net'
          const baseUrl = uploadedServer || fallbackServer
          const fileUrl = `${baseUrl}/${attachment.hash}`

          // Create kind 15 gift wrap with file metadata
          const fileWraps = await createFileGiftWrap(
            {
              fileUrl,
              mimeType: attachment.type,
              decryptionKey: attachment.encryption.keyHex,
              decryptionNonce: attachment.encryption.nonceHex,
              encryptedHash: attachment.encryption.encryptedHashHex,
              originalHash: attachment.encryption.originalHashHex,
              size: attachment.encryption.cipherSize,
              parentRumorId,
            },
            recipientPubkey,
            myPubkey,
            signer,
            privateKey,
          )

          // Publish gift wraps for kind 15
          await publishToSpecificRelays(recipientRelays, fileWraps.wrapForRecipient as unknown as Event)
          await publishToSpecificRelays(publishRelays, fileWraps.wrapForSelf as unknown as Event)
        }
      }

      setPendingStickers([])
      setPendingGifs([])
      setOptimisticMessages((prev) =>
        prev.map((m) => m.tempId === tempId ? { ...m, status: 'published' as const } : m)
      )
    } catch (err) {
      console.error('[DM] Send failed:', err)
      setSendError((err as Error).message)
      setMessage(text) // restore on failure
      setOptimisticMessages((prev) =>
        prev.map((m) => m.tempId === tempId ? { ...m, status: 'failed' as const } : m)
      )
    } finally {
      setSending(false)
    }
  }, [message, myPubkey, recipientPubkey, signer, privateKey, sendMessage, sending, pendingStickers, pendingGifs])

  return (
    <div ref={chatContainerRef} className="flex flex-col flex-1 min-w-0 h-full overflow-hidden relative gap-2">
      {/* Chat header — clickable to open profile */}
      <div className="flex items-center gap-3 px-4 py-3 bg-secondary/50 rounded-md shadow-md shrink-0">
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
              <ShieldCheck size={9} />
              <span>Extra Private (NIP-17)</span>
            </div>
          </div>
        </div>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onSwitchProtocol}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 border border-border/50 transition-colors cursor-pointer shrink-0"
              >
                <Shield size={12} /> Switch to Private
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs max-w-[200px]">
              Switch to NIP-04 Private mode for this user. Enables replies, threads, and reactions.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Messages */}
      <div
        ref={messagesContainerRef}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col-reverse px-4 py-3 border border-border rounded-md"
        onScroll={() => {
          handleScroll()
          const el = messagesContainerRef.current
          if (!el || loadingOlder || !hasMore || !hasNip44 || !myPubkey) return
          // With column-reverse, scrolling towards older = scrollTop goes more negative
          // Trigger load when near the "top" (most negative scrollTop)
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
        {/* Loading older messages indicator */}
        {loadingOlder && (
          <div className="flex items-center justify-center py-3 text-muted-foreground">
            <Loader2 size={14} className="animate-spin mr-2" />
            <span className="text-xs">Loading older messages...</span>
          </div>
        )}

        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <Lock size={24} className="text-primary" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">
                Start a private conversation
              </p>
              <p className="text-xs text-muted-foreground mt-1 max-w-[250px]">
                Messages are end-to-end encrypted using NIP-17 gift wrap. Only you and{' '}
                <span className="font-medium">{profile?.display_name || profile?.name || truncateNpub(npubStr, 8)}</span>{' '}
                can read them.
              </p>
            </div>
          </div>
        ) : (
          <div>
            {messages.map((msg, i) => {
              const prev = i > 0 ? messages[i - 1] : null
              const showDateSep = !prev || isDMDifferentDay(prev.createdAt, msg.createdAt)
              const senderPubkey = msg.isMine ? myPubkey : recipientPubkey
              const prevSenderPubkey = prev ? (prev.isMine ? myPubkey : recipientPubkey) : null
              const isGrouped = prev
                && senderPubkey === prevSenderPubkey
                && !showDateSep
                && (msg.createdAt - prev.createdAt) <= DM_GROUP_WINDOW_S

              const senderProfile = msg.isMine ? getProfile(myPubkey || '') : profile
              const displayName = senderProfile?.display_name || senderProfile?.name || (senderPubkey ? truncateNpub(nip19.npubEncode(senderPubkey), 8) : 'Unknown')

              return (
                <div key={msg.id}>
                  {shouldInsertDivider(msg.createdAt, prev ? prev.createdAt : null, senderPubkey || undefined) && (
                    <NewMessagesDivider ref={newMsgDividerRef} hidden={dividerHidden} />
                  )}
                  <DMMessageRow
                    msg={msg}
                    showDateSep={showDateSep}
                    isGrouped={!!isGrouped}
                    senderProfile={senderProfile}
                    displayName={displayName}
                    onShowProfile={() => !msg.isMine && setShowProfile(true)}
                  />
                </div>
              )
            })}
            {/* Optimistic messages */}
            {optimisticMessages.filter((o) =>
              !messages.some((m) =>
                m.isMine && m.content === o.content && Math.abs(m.createdAt - o.timestamp) < 10
              )
            ).map((optMsg) => {
              const myProfile = getProfile(myPubkey || '')
              const myDisplayName = myProfile?.display_name || myProfile?.name || (myPubkey ? truncateNpub(nip19.npubEncode(myPubkey), 8) : 'You')
              return (
                <div
                  key={optMsg.tempId}
                  className={`flex gap-3 mt-4 py-1 px-2 rounded-md -mx-2 transition-opacity ${optMsg.status === 'published' ? 'opacity-70' : 'opacity-50'}`}
                >
                  <div className="w-10 shrink-0 flex flex-col items-center">
                    <Avatar className="h-10 w-10 shrink-0">
                      {myProfile?.picture && <AvatarImage src={myProfile.picture} alt={myDisplayName} />}
                      <AvatarFallback className="text-xs bg-primary/20 text-primary">
                        {myDisplayName.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-semibold text-foreground">{myDisplayName}</span>
                      <span className="text-xs text-muted-foreground">{new Date(optMsg.timestamp * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="text-sm text-foreground/90 break-words">{optMsg.content}</div>
                      {optMsg.status === 'publishing' && !optMsg.relayProgress?.confirmed && (
                        <span className="text-[10px] text-muted-foreground italic whitespace-nowrap flex items-center gap-1">
                          <Loader2 size={9} className="animate-spin" /> encrypting...
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
                          <button
                            onClick={() => setOptimisticMessages((prev) => prev.filter((m) => m.tempId !== optMsg.tempId))}
                            className="p-0.5 rounded cursor-pointer text-muted-foreground hover:text-destructive transition-colors"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
            <div ref={messagesEndRef} />
          </div>
        )}
       </div>
       </div>
      </div>

      {/* NIP-44 unavailable banner */}
      {!hasNip44 && (
        <div className="mx-2 mb-1 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400 flex items-center gap-2">
          <AlertCircle size={14} className="shrink-0" />
          <span>Your login method doesn't support NIP-44 encryption. DMs require a signer or extension with NIP-44 support.</span>
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


      {/* Input — shared ChatInputBar with emoji, markdown toolbar, file upload */}
      <ChatInputBar
        draftKey={_dm17Key}
        message={message}
        onMessageChange={setMessage}
        onSend={handleSend}
        disabled={!hasNip44}
        sending={sending}
        canSend={(message.trim() || pendingStickers.length > 0 || pendingGifs.length > 0) ? true : undefined}
        placeholder={hasNip44
          ? `Message ${profile?.display_name || profile?.name || truncateNpub(npubStr, 8)}`
          : 'NIP-44 encryption unavailable'
        }
        enableFileUpload={hasNip44}
        signer={signer}
        privateKey={privateKey}

        dragContainerRef={chatContainerRef}
        onStickerSelect={(sticker) => setPendingStickers((prev) => [...prev, sticker])}
        onGifSelect={(gif) => setPendingGifs((prev) => [...prev, gif])}
        encryptBeforeUpload
        forceEncrypt
      />

      {/* Profile modal */}
      <UserProfileModal
        open={showProfile}
        onClose={() => setShowProfile(false)}
        targetPubkey={recipientPubkey}
      />

      {/* Emoji click modal */}
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
                  This emoji is part of set <span className="font-mono text-foreground/80">{setNameFromAddress(clickedEmoji.setAddress)}</span>
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
                      This emoji is not part of any emoji set. To use it, download the image and upload it to one of your own sets.
                    </p>
                  </div>
                </div>
                <a href={clickedEmoji.url} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-1.5 w-full h-9 rounded-lg bg-secondary border border-border text-foreground text-sm font-medium hover:bg-muted transition-colors cursor-pointer">
                  <Download size={14} /> Download Image
                </a>
              </div>
            )}
            <button onClick={() => setClickedEmoji(null)} className="w-full h-8 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer">Close</button>
          </div>
        </div>,
        document.body
      )}

      {/* Emoji discovery modal */}
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
                  This sticker is part of set <span className="font-mono text-foreground/80">{setNameFromAddress(clickedSticker.setAddress)}</span>
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
                      This sticker is not part of any sticker set. To use it, download the image and upload it to one of your own sets.
                    </p>
                  </div>
                </div>
                <a href={clickedSticker.url} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-1.5 w-full h-9 rounded-lg bg-secondary border border-border text-foreground text-sm font-medium hover:bg-muted transition-colors cursor-pointer">
                  <Download size={14} /> Download Image
                </a>
              </div>
            )}
            <button onClick={() => setClickedSticker(null)} className="w-full h-8 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer">Close</button>
          </div>
        </div>,
        document.body
      )}

      {/* Sticker discovery modal */}
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
/*  EMPTY STATE                                */
/* ═══════════════════════════════════════════ */

function DMEmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center flex flex-col items-center gap-4">
        <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
          <MessageSquare size={32} className="text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-foreground">Your Messages</h2>
          <p className="text-sm text-muted-foreground max-w-xs mt-1">
            Select a conversation or start a new one. All messages are end-to-end encrypted.
          </p>
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════ */
/*  DM RELAY PROGRESS INDICATOR                */
/* ═══════════════════════════════════════════ */

function DMRelayProgressIndicator({ eventId }: { eventId: string }) {
  const progress = useDMStore((s) => s.relayProgress[eventId])
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
/*  DM MESSAGE ROW (with block handling)       */
/* ═══════════════════════════════════════════ */

function DMMessageRow({ msg, showDateSep, isGrouped, senderProfile, displayName, onShowProfile }: {
  msg: DMMessage
  showDateSep: boolean
  isGrouped: boolean
  senderProfile: any
  displayName: string
  onShowProfile: () => void
}) {
  const [blockedRevealed, setBlockedRevealed] = useState(false)
  const isBlockedUser = useBlockStore((s) => s.isBlocked)(msg.senderPubkey)
  const hideBlockedCompletely = useBlockStore((s) => s.hideBlockedCompletely)
  const mutedWords = useBlockStore((s) => s.mutedWords)

  // Own messages are never hidden
  if (msg.isMine) {
    return (
      <DMMessageContent
        msg={msg} showDateSep={showDateSep} isGrouped={isGrouped}
        senderProfile={senderProfile} displayName={displayName} onShowProfile={onShowProfile}
      />
    )
  }

  // Completely hide if setting enabled
  if (isBlockedUser && hideBlockedCompletely) return null

  const shouldBlurBlocked = isBlockedUser && !blockedRevealed

  return (
    <div>
      {showDateSep && (
        <div className="flex items-center gap-3 my-3">
          <div className="flex-1 h-px bg-border" />
          <span className="text-[11px] font-medium text-muted-foreground">{formatDMDaySeparator(msg.createdAt)}</span>
          <div className="flex-1 h-px bg-border" />
        </div>
      )}
      <div className={`group relative flex gap-3 px-1 py-0.5 hover:bg-secondary/40 rounded-md transition-colors ${isGrouped ? 'mt-0' : 'mt-3'}`}>
        <div className="w-10 shrink-0 flex items-start justify-center pt-0.5">
          {!isGrouped ? (
            <Avatar className="h-10 w-10 cursor-pointer" onClick={onShowProfile}>
              {senderProfile?.picture && <AvatarImage src={senderProfile.picture} />}
              <AvatarFallback className="text-xs bg-primary/20 text-primary">
                {displayName.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          ) : (
            <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity pt-1 select-none">
              {formatDMShortTime(msg.createdAt)}
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          {!isGrouped && (
            <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 mb-0.5">
              <span className="text-sm font-semibold text-foreground cursor-pointer hover:underline" onClick={onShowProfile}>
                {displayName}
              </span>
              <DnnBadge pubkey={msg.senderPubkey} />
              <span className="text-[11px] text-muted-foreground">{formatDMTimestamp(msg.createdAt)}</span>
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
                      <div className="text-sm text-foreground/90 break-words prose-sm [&_p]:m-0 [&_pre]:my-1 [&_code]:text-xs">
                        <MessageContent content={filteredContent} emojiTags={msg.emojiTags} mutedWords={mutedWords} suffix={msg.isMine ? <DMRelayProgressIndicator eventId={msg.id} /> : undefined} />
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
            </>
          )}
          {/* NIP-17 kind 15 encrypted file attachment */}
          {msg.fileUrl && msg.fileDecryptionKey && msg.fileDecryptionNonce && (
            <EncryptedFileAttachment
              messageId={msg.id}
              fileUrl={msg.fileUrl}
              mimeType={msg.fileMimeType}
              decryptionKey={msg.fileDecryptionKey}
              decryptionNonce={msg.fileDecryptionNonce}
              hasTextContent={!!msg.content}
            />
          )}
          </ScrollableContent>
          {isBlockedUser && blockedRevealed && (
            <button
              onClick={() => setBlockedRevealed(false)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-muted/60 px-2 py-0.5 rounded-full transition-colors cursor-pointer mt-1 w-fit"
            >
              <EyeOff size={11} /> Hide
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Original DM message content (no block handling, used for own messages) */
function DMMessageContent({ msg, showDateSep, isGrouped, senderProfile, displayName, onShowProfile }: {
  msg: DMMessage
  showDateSep: boolean
  isGrouped: boolean
  senderProfile: any
  displayName: string
  onShowProfile: () => void
}) {
  const mutedWords = useBlockStore((s) => s.mutedWords)

  // Relay progress — dim own messages that haven't been accepted by any relay yet
  const relayPending = useDMStore((s) => {
    const p = s.relayProgress[msg.id]
    return p && p.confirmed === 0
  })
  return (
    <div>
      {showDateSep && (
        <div className="flex items-center gap-3 my-3">
          <div className="flex-1 h-px bg-border" />
          <span className="text-[11px] font-medium text-muted-foreground">{formatDMDaySeparator(msg.createdAt)}</span>
          <div className="flex-1 h-px bg-border" />
        </div>
      )}
      <div className={`group relative flex gap-3 px-1 py-0.5 hover:bg-secondary/40 rounded-md transition-colors ${isGrouped ? 'mt-0' : 'mt-3'}`}>
        <div className="w-10 shrink-0 flex items-start justify-center pt-0.5">
          {!isGrouped ? (
            <Avatar className="h-10 w-10 cursor-pointer" onClick={onShowProfile}>
              {senderProfile?.picture && <AvatarImage src={senderProfile.picture} />}
              <AvatarFallback className="text-xs bg-primary/20 text-primary">
                {displayName.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          ) : (
            <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity pt-1 select-none">
              {formatDMShortTime(msg.createdAt)}
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          {!isGrouped && (
            <div className="flex items-baseline flex-wrap gap-x-2 gap-y-0.5 mb-0.5">
              <span className="text-sm font-semibold text-foreground cursor-pointer hover:underline" onClick={onShowProfile}>
                {displayName}
              </span>
              <span className="text-[11px] text-muted-foreground">{formatDMTimestamp(msg.createdAt)}</span>
              {msg.clientTag && (
                <span className="text-[10px] text-muted-foreground/50">· via {msg.clientTag}</span>
              )}
            </div>
          )}
          <ScrollableContent>
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
                    <MessageContent content={filteredContent} emojiTags={msg.emojiTags} mutedWords={mutedWords} suffix={msg.isMine ? <DMRelayProgressIndicator eventId={msg.id} /> : undefined} />
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
          {/* NIP-17 kind 15 encrypted file attachment */}
          {msg.fileUrl && msg.fileDecryptionKey && msg.fileDecryptionNonce && (
            <EncryptedFileAttachment
              messageId={msg.id}
              fileUrl={msg.fileUrl}
              mimeType={msg.fileMimeType}
              decryptionKey={msg.fileDecryptionKey}
              decryptionNonce={msg.fileDecryptionNonce}
              hasTextContent={!!msg.content}
            />
          )}
          </ScrollableContent>
        </div>
      </div>
    </div>
  )
}

/* ─── Encrypted File Attachment (NIP-17 kind 15) ─── */

/** In-memory cache of decrypted file Blob URLs keyed by message ID */
const decryptedBlobCache = new Map<string, string>()

/**
 * Custom hook: fetch + decrypt an encrypted file, returning the decrypted blob URL.
 * Caches blob URLs in-memory by messageId so re-renders don't re-fetch.
 */
function useDecryptedBlob(messageId: string, fileUrl: string, mimeType: string | undefined, decryptionKey: string, decryptionNonce: string) {
  const [blobUrl, setBlobUrl] = useState<string | null>(() => decryptedBlobCache.get(messageId) || null)
  const [loading, setLoading] = useState(!decryptedBlobCache.has(messageId))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (decryptedBlobCache.has(messageId)) {
      setBlobUrl(decryptedBlobCache.get(messageId)!)
      setLoading(false)
      return
    }

    let cancelled = false

    const fetchAndDecrypt = async () => {
      try {
        setLoading(true)
        setError(null)

        // Extract hash from blossom URL and use multi-server failover download.
        // The fileUrl may point to a server that doesn't have the file (upload shuffles randomly),
        // so downloadFromBlossom tries all configured servers.
        const urlHash = fileUrl.split('/').pop()?.replace(/\.[^.]+$/, '') // strip any extension
        let cipherBytes: Uint8Array
        if (urlHash && /^[a-f0-9]{64}$/i.test(urlHash)) {
          cipherBytes = await downloadFromBlossom(urlHash)
        } else {
          // Fallback: direct fetch for non-blossom URLs
          const response = await fetch(fileUrl)
          if (!response.ok) throw new Error(`Failed to fetch file: ${response.status}`)
          cipherBytes = new Uint8Array(await response.arrayBuffer())
        }
        const plainBytes = await decryptFile(cipherBytes, decryptionKey, decryptionNonce)

        if (cancelled) return

        const blob = new Blob([plainBytes.slice() as Uint8Array<ArrayBuffer>], { type: mimeType || 'application/octet-stream' })
        const url = URL.createObjectURL(blob)

        decryptedBlobCache.set(messageId, url)
        setBlobUrl(url)
      } catch (err) {
        if (!cancelled) {
          console.error('[DM] Failed to decrypt file:', err)
          setError((err as Error).message)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchAndDecrypt()
    return () => { cancelled = true }
  }, [messageId, fileUrl, decryptionKey, decryptionNonce, mimeType])

  return { blobUrl, loading, error }
}

function EncryptedFileAttachment({ messageId, fileUrl, mimeType, decryptionKey, decryptionNonce, hasTextContent }: {
  messageId: string
  fileUrl: string
  mimeType?: string
  decryptionKey: string
  decryptionNonce: string
  hasTextContent?: boolean
}) {
  const { blobUrl, loading, error } = useDecryptedBlob(messageId, fileUrl, mimeType || undefined, decryptionKey, decryptionNonce)
  const [galleryOpen, setGalleryOpen] = useState(false)

  const isImage = mimeType?.startsWith('image/')
  const isVideo = mimeType?.startsWith('video/')
  const isAudio = mimeType?.startsWith('audio/')
  const fileName = fileUrl.split('/').pop() || 'encrypted-file'

  if (loading) {
    return (
      <div className={`flex items-center gap-2 ${hasTextContent ? 'mt-2' : ''}`}>
        <div className="media-skeleton rounded-lg" style={{ width: 200, height: 140 }} />
      </div>
    )
  }

  if (error) {
    return (
      <div className={`flex items-center gap-2 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/30 ${hasTextContent ? 'mt-2' : ''}`}>
        <AlertTriangle size={14} className="text-destructive/70 shrink-0" />
        <span className="text-xs text-destructive/80">Failed to decrypt file</span>
      </div>
    )
  }

  if (!blobUrl) return null

  // Image — render with gallery lightbox (same UX as non-encrypted images)
  if (isImage) {
    return (
      <>
        <img
          src={blobUrl}
          alt="Encrypted attachment"
          className={`rounded-lg max-w-[400px] max-[1080px]:max-w-full max-h-[300px] object-contain cursor-pointer hover:brightness-110 transition-all border border-transparent hover:border-border ${hasTextContent ? 'mt-2' : ''}`}
          loading="lazy"
          onClick={() => setGalleryOpen(true)}
        />
        {galleryOpen && (
          <ImageGallery
            images={[blobUrl]}
            startIndex={0}
            onClose={() => setGalleryOpen(false)}
          />
        )}
      </>
    )
  }

  if (isVideo) {
    return (
      <video
        src={blobUrl}
        controls
        className={`rounded-lg max-w-[400px] max-[1080px]:max-w-full max-h-[300px] border border-transparent hover:border-border transition-colors ${hasTextContent ? 'mt-2' : ''}`}
      />
    )
  }

  if (isAudio) {
    return (
      <CustomAudioPlayer
        src={blobUrl}
        className={`max-w-[300px] ${hasTextContent ? 'mt-2' : ''}`}
      />
    )
  }

  // Generic file download
  return (
    <a
      href={blobUrl}
      download={fileName}
      className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/60 border border-border hover:bg-secondary/80 transition-colors ${hasTextContent ? 'mt-2' : ''}`}
    >
      <Download size={14} className="text-primary" />
      <span className="text-sm text-foreground">{mimeType?.split('/')[1] || 'File'}</span>
      <span className="text-xs text-muted-foreground">Download</span>
    </a>
  )
}

