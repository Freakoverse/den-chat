import { useHubStore } from '@/stores/hubStore'
import { getDraft, setDraft, clearDraft, hubDraftKey, hubThreadDraftKey, getFileDraft, setFileDraft, clearFileDraft } from '@/stores/draftStore'
import { useDnnStore } from '@/stores/dnnStore'
import { formatDnnId } from '@/lib/dnn/formatDnnId'
import { useMessageStore } from '@/stores/messageStore'
import { useUserStore } from '@/stores/userStore'
import { useBlockStore } from '@/stores/blockStore'
import { useWotStore } from '@/stores/wotStore'
import { useDMStore } from '@/stores/dmStore'
import { useDM04Store } from '@/stores/dm04Store'
import { useNavigationStore } from '@/stores/navigationStore'
import { useMessages, type ChatMessage, type Attachment } from '@/hooks/useMessages'
import { fetchOlderMessages, fetchNewerMessages, fetchSingleMessage, fetchMessageContext, fetchChannelLatest, PAGE_SIZE } from '@/hooks/useHubSubscriptions'
import { useProfileCache, getCachedProfile } from '@/hooks/useProfileCache'
import { useBlossomMedia, shareableMediaUrl } from '@/hooks/useBlossomMedia'
import { formatDuration } from '@/lib/hub/messageExpiration'
import { useDecryptedMedia, getDecryptedBlobUrl } from '@/hooks/useDecryptedMedia'
import { UserProfileModal } from '@/components/hub/UserProfileModal'
import { HubSettingsModal } from '@/components/hub/HubSettingsModal'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Hash, Megaphone, Users, Pin, PinOff, Bell, Search, Send, Plus, Smile, Sticker, Check, X, RotateCcw, Pencil, Reply, MoreVertical, Copy, MessageSquarePlus, Trash2, Loader2, Zap, Code, Bold, Italic, Strikethrough, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, List, ListOrdered, Link, CodeSquare, ALargeSmall, Clipboard, ClipboardCheck, ClipboardPaste, Upload, FileIcon, Download, Image, Paperclip, AlertTriangle, AlertCircle, Eye, EyeOff, ShieldBan, ShieldAlert, ShieldOff, Lock, LockOpen, Settings, ArrowDown, ArrowLeft, ImagePlay, Star, Vote, Clock, Flag, Shield, Globe, Radio, History, BadgeCheck, Mic, WifiOff, Scissors, Type } from 'lucide-react'
import { useState, useEffect, useRef, useCallback, memo, useMemo, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { truncateNpub, formatTimestamp, cn, npubShort } from '@/lib/utils'
import { getHour12 } from '@/stores/preferencesStore'
import { nip19 } from 'nostr-tools'
import EmojiPickerReact, { EmojiStyle, Theme } from 'emoji-picker-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { buildHubEvent } from '@/lib/hub/buildHubEvent'
import { signWithSigner, mineAndSign } from '@/lib/nostr'
import { publishToSpecificRelays, fetchEvents, fetchEventsFromRelays, getRelays } from '@/lib/nostr/relay-pool'
import { getPublishRelays } from '@/stores/postingBehaviourStore'
import { useTypingHeartbeat } from '@/hooks/useTypingHeartbeat'
import { TypingIndicator } from '@/components/chat/TypingIndicator'
import { hubTypingKey } from '@/stores/typingStore'
import { setNameFromAddress } from '@/lib/customSets'
import type { Channel, HubData, HubMember } from '@/stores/hubStore'
import { uploadToBlossomServers, computeHash } from '@/lib/blossom'
import type { UploadProgress } from '@/lib/blossom'
import { getUploadBlossoms } from '@/stores/postingBehaviourStore'
import { isV2 } from '@/lib/hub/version'
import { ImageGallery } from '@/components/social/RichContent'
import { extractContentMediaGroups, ContentMediaGroups, ContentMediaImage, type ContentMediaGroup } from '@/components/chat/ContentMediaGrouping'
import { MessageContent } from '@/components/chat/MessageContent'
import { DnnBadge } from '@/components/ui/DnnBadge'
import { EmojiPickerPopover, EmojiDiscoveryModal } from '@/components/chat/EmojiPickerPopover'
import { StickerPickerPopover, StickerDiscoveryModal } from '@/components/chat/StickerPickerPopover'
import { GifPickerPopover, GifFavoriteModal } from '@/components/chat/GifPickerPopover'
import { VoiceNoteModal } from '@/components/chat/VoiceNoteModal'
import { CustomAudioPlayer } from '@/components/ui/CustomAudioPlayer'
import { getEmojiMap } from '@/stores/emojiStore'
import { getStickerMap } from '@/stores/stickerStore'
import { BlossomImg } from '@/components/ui/BlossomImg'
import { useGifStore } from '@/stores/gifStore'
import { publishGifFavorites } from '@/lib/nostr/customGif'
import { UserHubSettingsModal } from '@/components/hub/UserHubSettingsModal'
import { VerificationBadge } from '@/components/ui/VerificationBadge'
import { HashRecoveryModal } from '@/components/ui/HashRecoveryModal'
import { usePinStore } from '@/stores/pinStore'
import { PinModal } from '@/components/hub/PinModal'
import { ChannelSearchModal } from '@/components/hub/ChannelSearchModal'
import { usePollStore, type RawPoll } from '@/stores/pollStore'
import { CreatePollModal, PollCard } from '@/components/hub/PollComponents'
import { DatePicker } from '@/components/ui/DatePicker'
import { TimePicker } from '@/components/ui/TimePicker'
import { useZapStore } from '@/stores/zapStore'
import { ZapModal } from '@/components/hub/ZapModal'
import { ZapListModal } from '@/components/hub/ZapListModal'
import { ZapTotalBadge } from '@/components/hub/ZapTotalBadge'
import { formatSats, type ZapInfo } from '@/lib/nostr/zap'
import { ReactionListModal, type ReactionInfo } from '@/components/social/ReactionListModal'
import { ReportModal } from '@/components/hub/ReportModal'
import { usePermissions, getPermissionsForUser, getChannelGroupId, isAuthorizedFacilitator } from '@/lib/hub/permissions'
import { useMentionAutocomplete } from './useMentionAutocomplete'
import { MentionSuggestionsDropdown } from './MentionSuggestionsDropdown'
import { useNotificationStore } from '@/stores/notificationStore'
import { useUnreadDivider } from '@/hooks/useUnreadDivider'
import { NewMessagesDivider } from '@/components/chat/NewMessagesDivider'
import { UnreadBanner } from '@/components/chat/UnreadBanner'
import { useMobile } from '@/hooks/useMobile'
import { MESSAGE_MAX_LENGTH, MESSAGE_CHAR_WARN_THRESHOLD } from '@/components/chat/ChatInputBar'
import { ScrollableContent } from '@/components/chat/ScrollableContent'

/** Optimistic message -- shown immediately before publish confirms */
export interface OptimisticMessage {
  tempId: string
  channelId: string
  content: string
  timestamp: number
  status: 'mining' | 'publishing' | 'published' | 'failed'
  replyDisplayName?: string
  replyPreview?: string
  relayProgress?: { confirmed: number; total: number }
  /** The d-tag assigned to this message after signing — used to reconcile
   *  the optimistic bubble with the real decrypted message in the list */
  sentDTag?: string
  /** Stored arguments for retry — enables re-sending on failure */
  retryData?: {
    text: string
    replyTo?: { pubkey: string; dTag: string; eventId?: string }
    rootRef?: string
    attachments?: Attachment[]
    nsfw?: boolean
    isThread?: boolean
    isEncrypted?: boolean
    facilitator?: string
    stickerTags?: [string, string, string, string][]
    gifTags?: [string, string, string, string][]
  }
}

/** Reply-to context for the message input */
export interface ReplyContext {
  dTag: string
  pubkey: string
  displayName: string
  preview: string
  rootRef?: string  // thread root a-tag value (if replying to a reply)
  isThread?: boolean  // true when this is a thread reply
  eventId?: string  // event ID for non-addressable events (polls etc) — uses e-tag instead of a-tag
}

/** Local reaction on a message */
export interface Reaction {
  emoji: string
  count: number
  reacted: boolean // did current user react with this
  customUrl?: string // URL for custom emoji (NIP-30)
  pubkeys?: string[] // who reacted with this emoji (filtered set, for avatar previews)
}

/** Stable empty object to prevent Zustand selector from returning new reference each render */
const EMPTY_REACTIONS: Record<string, import('@/stores/messageStore').StoredReaction[]> = {}

/**
 * Shared hook: subscribe to store reactions, lazy-decrypt, and convert to Reaction[].
 * Used by MessageList, ThreadModal, and ForumView.
 */
export function useDecryptedReactions(hubDTag: string, getChannelKey: (epoch?: number) => Uint8Array | null, hub?: HubData | null, hubMembers?: HubMember[], channelId?: string) {
  const myPubkey = useUserStore((s) => s.pubkey)
  const storeReactions = useMessageStore((s) => s.reactions[hubDTag] || EMPTY_REACTIONS)

  // Lazy-decrypt raw reactions when channel key becomes available
  useEffect(() => {
    // The channel-key decrypt path is version-AGNOSTIC (v1 private hubs also encrypt reactions). Only v2
    // reactions carry an identity attestation, so the "no identity tag → drop" rule below must apply to v2
    // ONLY — otherwise every (legitimately tag-less) v1 encrypted-hub reaction would be wrongly dropped.
    const isV2Hub = isV2(useHubStore.getState().hubs[hubDTag] || { version: undefined })
    for (const [, stored] of Object.entries(storeReactions)) {
      for (const r of stored) {
        if (r.decrypted === false && r.rawContent) {
          // Use the reaction's OWN epoch key, not the hub's current one — a reaction made before a
          // rotation is encrypted under the epoch it carries, so getChannelKey(r.epoch) is what decrypts
          // it (falls back to current when the tag is absent). Skip if that epoch's key isn't loaded.
          const key = getChannelKey(r.epoch)
          if (!key) continue
          ; (async () => {
            try {
              const { aesDecrypt } = await import('@/lib/crypto/aes')
              let emoji = await aesDecrypt(key, r.rawContent!)
              let customUrl: string | undefined
              if (r.rawEmojiTag) {
                try {
                  const shortcode = await aesDecrypt(key, r.rawEmojiTag[0])
                  customUrl = await aesDecrypt(key, r.rawEmojiTag[1])
                  emoji = `:${shortcode}:`
                } catch {
                  if (r.rawEmojiTag[1]?.startsWith('http')) customUrl = r.rawEmojiTag[1]
                }
              }
              // v2: resolve the reactor's real key R from the identity tag — but VERIFY the per-
              // reaction R-signature, not just decrypt it. Any member holds the channel key, so a
              // decrypt-only path would let anyone forge an `identity` tag naming another member's R
              // and have the reaction attributed (and ban/permission-checked) as that member. If the
              // attestation fails to verify, drop the reaction rather than trust a forged R.
              let realPubkey: string | undefined
              let identityForged = false
              if (r.identityTag) {
                try {
                  const { verifyEventIdentity } = await import('@/lib/nostr/identity')
                  const res = r.rawEvent ? await verifyEventIdentity(JSON.parse(r.rawEvent), key) : { ok: false }
                  if (res.ok) realPubkey = res.rPub
                  else identityForged = true
                } catch { identityForged = true }
              } else if (isV2Hub) {
                // v2 reaction with NO identity attestation — unattributable, could be injected under any
                // wire P. Drop it, consistent with the message/poll-vote drop-rule. (v1 reactions carry no
                // identity tag by design — pubkey IS R — so they are NOT dropped here.)
                identityForged = true
              }
              const store = useMessageStore.getState()
              const hubReactions = store.reactions[hubDTag]
              if (!hubReactions) return
              for (const [msgId, arr] of Object.entries(hubReactions)) {
                const idx = arr.findIndex((x) => x.eventId === r.eventId)
                if (idx >= 0) {
                  const updated = [...arr]
                  if (identityForged) updated.splice(idx, 1) // forged identity attestation → drop
                  else updated[idx] = { ...updated[idx], emoji, customUrl, decrypted: true, realPubkey }
                  store.reactions[hubDTag] = { ...hubReactions, [msgId]: updated }
                  useMessageStore.setState({ reactions: { ...store.reactions } })
                  break
                }
              }
            } catch { /* decryption failed */ }
          })()
        }
      }
    }
  }, [storeReactions, getChannelKey, hubDTag])

  // Convert StoredReaction[] to Reaction[] (skip undecrypted + filter by add_reactions permission + banned)
  const modBanLists = useHubStore((s) => hub ? s.modBanLists[hub.dTag] : undefined)
  const hubBanListForReactions = useHubStore((s) => hub ? s.hubBanLists[hub.dTag] : undefined)
  const reactions = useMemo(() => {
    // Build set of banned pubkeys (mod-banned excluding whitelisted + creator-banned)
    const bannedSet = new Set<string>()
    if (modBanLists && hubMembers) {
      const whitelisted = new Set(hubMembers.filter(m => m.flags?.includes('w')).map(m => m.pubkey))
      for (const pks of Object.values(modBanLists)) {
        for (const pk of pks) {
          if (!whitelisted.has(pk)) bannedSet.add(pk)
        }
      }
    }
    if (hubBanListForReactions) {
      for (const pk of hubBanListForReactions) bannedSet.add(pk)
    }

    const result: Record<string, Reaction[]> = {}
    for (const [msgId, stored] of Object.entries(storeReactions)) {
      const grouped = new Map<string, { count: number; reacted: boolean; customUrl?: string; pubkeys: string[] }>()
      for (const r of stored) {
        if (r.decrypted === false) continue
        // v2: the reactor's true key is realPubkey (decoded from the identity tag); in v1 pubkey IS R.
        const rKey = r.realPubkey ?? r.pubkey
        // Filter out reactions from banned users
        if (bannedSet.has(rKey)) continue
        // Enforce add_reactions permission — suppress reactions from users
        // whose role lacks add_reactions (even if published via modified client)
        if (hub && rKey !== hub.creatorPubkey) {
          const reactorPerms = getPermissionsForUser(hub, rKey, hubMembers, channelId)
          if (!reactorPerms.add_reactions) continue
        }
        const key = r.emoji
        if (grouped.has(key)) {
          const g = grouped.get(key)!
          g.count++
          if (!g.pubkeys.includes(rKey)) g.pubkeys.push(rKey)
          if (rKey === myPubkey) g.reacted = true
        } else {
          grouped.set(key, { count: 1, reacted: rKey === myPubkey, customUrl: r.customUrl, pubkeys: [rKey] })
        }
      }
      const arr = Array.from(grouped.entries()).map(([emoji, data]) => ({
        emoji,
        count: data.count,
        reacted: data.reacted,
        customUrl: data.customUrl,
        pubkeys: data.pubkeys,
      }))
      if (arr.length > 0) result[msgId] = arr
    }
    return result
  }, [storeReactions, myPubkey, hub, hubMembers, channelId, modBanLists, hubBanListForReactions])

  return { storeReactions, reactions }
}

export function ChannelView({ hideHeader = false }: { hideHeader?: boolean } = {}) {
  const activeHubId = useHubStore((s) => s.activeHubId)
  const activeChannelId = useHubStore((s) => s.activeChannelId)
  const hub = useHubStore((s) => (activeHubId ? s.hubs[activeHubId] : null))
  const pubkey = useUserStore((s) => s.pubkey)
  const hubMembers = useHubStore((s) => activeHubId ? s.hubMembers[activeHubId] : undefined)
  const hubPrefs = useHubStore((s) => activeHubId ? s.hubPrefs[activeHubId] : undefined)
  const groupSecrets = useHubStore((s) => activeHubId ? s.groupSecrets[activeHubId] : undefined)
  const activeHubSecret = useHubStore((s) => activeHubId ? s.hubSecrets[activeHubId] : undefined)

  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessage[]>([])
  const [replyContext, setReplyContext] = useState<ReplyContext | null>(null)

  const channelContainerRef = useRef<HTMLDivElement>(null)

  // Membership / facilitation gate (hooks must be called unconditionally).
  // The creator is always an owner/member — hubMembers isn't populated at creation
  // time (only after the member tree is loaded from Blossom), so gate on it directly
  // to avoid a spurious "you must be a member" on a freshly created hub.
  // v2: the owner authors as O (creatorPubkey) but recognizes themselves by their real key R
  // (ownerRealPubkey). Members carry R in `m.pubkey` (resolved from the roster).
  const isCreator = !!(pubkey && hub && (hub.creatorPubkey === pubkey || hub.ownerRealPubkey === pubkey))
  const isMember = isCreator || !!(pubkey && hubMembers?.some((m) => m.pubkey === pubkey))
  const hubFacilitatorMembers = useHubStore((s) => activeHubId ? s.hubFacilitatorMembers[activeHubId] : undefined)

  // Whether blossom secret resolution has completed for this hub.
  // Until resolved, we don't know if the user is a member or not.
  const secretsResolved = useHubStore((s) => activeHubId ? !!s.hubSecretsResolved[activeHubId] : false)

  // Role-based permission resolution
  const perms = usePermissions(activeHubId || undefined, activeChannelId || undefined)

  const channel = hub?.channels.find((c) => c.channelId === activeChannelId)
  if (!channel) return null

  // Defense-in-depth: even if an inaccessible channel is somehow opened (e.g. a
  // stale deep link), never render its messages. Mirrors the sidebar's visibility
  // rule — view_channel permission plus any required group secret. Non-members fall
  // back to the 'everyone' role, so this only hides channels genuinely gated.
  const activeGroupId = getChannelGroupId(hub!, channel.channelId)
  const noChannelAccess = !!pubkey && !isCreator && (
    !perms.view_channel || (!!activeGroupId && !(groupSecrets && groupSecrets[activeGroupId]))
  )

  const facilitatorPk = hubPrefs?.facilitator
  // We're facilitated if: not a direct member, we have a saved facilitator, and we hold the hub
  // secret (proof we're actually in their tree — couldn't decrypt otherwise). We DON'T require the
  // facilitator to be in our local roster: a v2 facilitated user is a non-member with no roster, so
  // that would wrongly deny them. We only DROP facilitation if we can positively see the facilitator
  // lost the permission (they're in our roster but their role no longer grants `facilitate`).
  // Only DROP facilitation if we can positively see the facilitator (by P or R) is a member whose
  // role no longer grants `facilitate`. Unknown (no roster, the usual v2 case) → keep it.
  const facInRoster = !!facilitatorPk && !!hubMembers?.some((m) => m.pubkey === facilitatorPk || m.p === facilitatorPk)
  const facLostPerm = facInRoster && !!hub && !isAuthorizedFacilitator(hub, facilitatorPk!, hubMembers)
  const isFacilitated = !isMember && !!facilitatorPk && !!activeHubSecret && !facLostPerm

  const canPublish = (isMember || isFacilitated) && perms.send_messages
  const isAnnouncement = channel.type === 'announcement'

  return (
    <div ref={channelContainerRef} className="flex flex-col h-full bg-background relative py-2 gap-2">
      {!hideHeader && <ChannelHeader channel={channel} channelId={activeChannelId!} isCreator={isCreator} />}
      {/* Loading overlay while blossom membership is being resolved.
          Starts below the 48px header (unless hidden) so the back button stays usable. */}
      {!secretsResolved && (
        <div className={`absolute inset-x-0 bottom-0 ${hideHeader ? 'top-0' : 'top-12'} z-40 flex flex-col items-center justify-center bg-background/90 backdrop-blur-sm`}>
          <Loader2 size={28} className="animate-spin text-primary mb-3" />
          <span className="text-sm text-muted-foreground">Loading hub data...</span>
        </div>
      )}
      {/* No-access cover — shown once membership is resolved if the user can't view
          this channel. Belt-and-suspenders behind the sidebar/#channel-link gating. */}
      {secretsResolved && noChannelAccess && (
        <div className={`absolute inset-x-0 bottom-0 ${hideHeader ? 'top-0' : 'top-12'} z-40 flex flex-col items-center justify-center bg-background/95 backdrop-blur-sm px-6 text-center`}>
          <Lock size={28} className="text-muted-foreground mb-3" />
          <span className="text-sm font-medium text-foreground mb-1">You don’t have access to this channel</span>
          <span className="text-xs text-muted-foreground">You don’t have permission to view its messages.</span>
        </div>
      )}
      {/* Messages — bordered, rounded card */}
      <div className="flex-1 flex flex-col min-h-0 border border-border rounded-md overflow-hidden">
      <MessageList
        hubDTag={activeHubId!}
        channelId={activeChannelId!}
        channelName={channel.name}
        optimisticMessages={optimisticMessages}
        setOptimisticMessages={setOptimisticMessages}
        onReply={setReplyContext}
        onThreadReply={setReplyContext}
        canPublish={canPublish}
        isAnnouncement={isAnnouncement}
      />
      </div>
      {/* Composer — outside the messages card, flush */}
      <MessageInput
        hubDTag={activeHubId!}
        channelId={activeChannelId!}
        channelName={channel.name}
        optimisticMessages={optimisticMessages}
        setOptimisticMessages={setOptimisticMessages}
        replyContext={isAnnouncement ? null : replyContext}
        onCancelReply={() => setReplyContext(null)}
        dragContainerRef={channelContainerRef}
        canPublish={canPublish}
        bare
      />
    </div>
  )
}

function ChannelHeader({ channel, channelId, isCreator }: { channel: { name: string; type: string; description?: string }; channelId: string; isCreator: boolean }) {
  const [showHubSettings, setShowHubSettings] = useState(false)
  const activeHubId = useHubStore((s) => s.activeHubId)
  const hubForSettings = useHubStore((s) => (activeHubId ? s.hubs[activeHubId] : null))
  const [showDescModal, setShowDescModal] = useState(false)
  const [showPinModal, setShowPinModal] = useState(false)
  const [showSearchModal, setShowSearchModal] = useState(false)
  const desc = channel.description
  const isMobile = useMobile()
  const setMobileView = useNavigationStore((s) => s.setMobileView)
  const setShowMobileMembers = useNavigationStore((s) => s.setShowMobileMembers)

  // Pin subscription
  const hub = useHubStore((s) => activeHubId ? s.hubs[activeHubId] : null)
  const subscribePins = usePinStore((s) => s.subscribePins)
  const unsubscribePins = usePinStore((s) => s.unsubscribePins)
  // Select raw store data (stable reference) — filter in useMemo to avoid infinite re-renders
  const hubPins = usePinStore((s) => activeHubId ? s.pinsByHub[activeHubId] : undefined)
  const totalChannelPins = useMemo(() => {
    if (!hubPins) return 0
    let count = 0
    for (const pe of hubPins) {
      for (const p of pe.pins) {
        if (p.channelId === channelId) count++
      }
    }
    return count
  }, [hubPins, channelId])

  // Subscribe to pins when hub is active
  useEffect(() => {
    if (!activeHubId || !hub) return
    const relays = [...hub.generalRelays]
    subscribePins(activeHubId, relays)
    return () => unsubscribePins(activeHubId)
  }, [activeHubId, hub?.generalRelays?.join(',')])

  return (
    <>
      <div className="flex items-center justify-between px-4 h-12 min-h-12 bg-secondary/50 rounded-md shadow-md shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {isMobile && (
            <button
              onClick={() => setMobileView('home')}
              className="shrink-0 p-1 -ml-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
            >
              <ArrowLeft size={18} />
            </button>
          )}
          {channel.type === 'announcement' ? (
            <Megaphone size={18} className="text-muted-foreground shrink-0" />
          ) : (
            <Hash size={18} className="text-muted-foreground shrink-0" />
          )}
          <span className="font-semibold text-sm text-foreground shrink-0">{channel.name}</span>
          <div className="h-4 w-px bg-border mx-1 shrink-0" />
          <button
            onClick={() => setShowDescModal(true)}
            className="text-xs text-muted-foreground truncate hover:text-foreground transition-colors cursor-pointer min-w-0"
          >
            {desc || <span className="italic">No channel description</span>}
          </button>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon" className="text-muted-foreground cursor-pointer" onClick={() => setShowSearchModal(true)}>
            <Search size={18} />
          </Button>
          {totalChannelPins > 0 ? (
            <button
              onClick={() => setShowPinModal(true)}
              className="flex items-center gap-0 h-8 rounded-md border border-border/60 text-muted-foreground hover:text-foreground hover:border-border transition-colors cursor-pointer"
            >
              <span className="flex items-center justify-center px-2">
                <Pin size={15} />
              </span>
              <span className="h-4 w-px bg-border/60" />
              <span className="px-2 text-xs tabular-nums">{totalChannelPins}</span>
            </button>
          ) : (
            <Button variant="ghost" size="icon" className="text-muted-foreground cursor-pointer" onClick={() => setShowPinModal(true)}>
              <Pin size={18} />
            </Button>
          )}
          {isMobile && (
            <Button variant="ghost" size="icon" className="text-muted-foreground cursor-pointer" onClick={() => setShowMobileMembers(true)}>
              <Users size={18} />
            </Button>
          )}
        </div>
      </div>

      {showDescModal && (
        <ChannelDescriptionModal
          channelId={(channel as any).channelId}
          channelName={channel.name}
          description={desc}
          isCreator={isCreator}
          onClose={() => setShowDescModal(false)}
        />
      )}

      {showPinModal && activeHubId && (
        <PinModal
          hubDTag={activeHubId}
          channelId={channelId}
          onClose={() => setShowPinModal(false)}
          onJumpToMessage={(aRef) => {
            setShowPinModal(false)
            // Dispatch custom event for MessageList to handle time-travel
            window.dispatchEvent(new CustomEvent('pin-jump-to-message', { detail: { aRef } }))
          }}
        />
      )}

      {showSearchModal && activeHubId && (
        <ChannelSearchModal
          hubDTag={activeHubId}
          channelId={channelId}
          onClose={() => setShowSearchModal(false)}
        />
      )}

    </>
  )
}

export function ChannelDescriptionModal({ channelId, channelName, description, isCreator, onClose }: {
  channelId: string
  channelName: string
  description?: string
  isCreator: boolean
  onClose: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(description || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hub = useHubStore((s) => {
    const activeHubId = s.activeHubId
    return activeHubId ? s.hubs[activeHubId] : null
  })
  const activeHubId = useHubStore((s) => s.activeHubId)
  const setHubData = useHubStore((s) => s.setHubData)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const handleSave = async () => {
    if (!hub || !activeHubId) return
    setSaving(true)
    setError(null)
    try {
      // Update the channel's description in the channels list
      const updatedChannels: Channel[] = hub.channels.map(ch =>
        ch.channelId === channelId
          ? { ...ch, description: draft.trim() || undefined }
          : ch
      )

      const { signHubEventForPublish } = await import('@/lib/hub/buildHubEvent')
      const signedEvent = await signHubEventForPublish(hub, {
        dTag: hub.dTag,
        name: hub.name,
        description: hub.description || undefined,
        epoch: hub.epoch,
        icon: hub.icon || undefined,
        banner: hub.banner || undefined,
        tags: hub.tags,
        relays: [...hub.generalRelays],
        blossomServers: hub.blossomServers,
        indexFileHash: hub.indexFileHash,
        channels: updatedChannels,
        categories: hub.categories,
        roles: hub.roles,
        // Preserve these — buildHubEvent drops the corresponding tags when they're
        // absent, so omitting them here silently reset the hub's PoW to 0 (and cleared
        // its NSFW flag) whenever a channel description was edited.
        minPow: hub.minPow > 0 ? hub.minPow : undefined,
        joinMinPow: hub.joinMinPow > 0 ? hub.joinMinPow : undefined,
        messageExpiration: hub.messageExpiration || undefined, // preserve the disappearing-messages timer
        nsfw: hub.nsfw || undefined,
        discoverable: hub.discoverable,
        groupedRoles: hub.groupedRoles,
        publishedAt: hub.publishedAt,
        eventCreatedAt: hub.eventCreatedAt,
      }, { pubkey: useUserStore.getState().pubkey!, privateKey, signer, minPow: hub.minPow })
      await publishToSpecificRelays(getPublishRelays([...hub.generalRelays], { hubOnly: isV2(hub) }), signedEvent)

      // Update local store
      setHubData(activeHubId, {
        ...hub,
        channels: updatedChannels,
        eventCreatedAt: signedEvent.created_at,
      })

      setEditing(false)
    } catch (err: any) {
      console.error('Failed to publish channel description:', err)
      setError(err.message || 'Failed to publish')
    } finally {
      setSaving(false)
    }
  }

  // Use live description from store (updates after save)
  const liveDesc = hub?.channels.find(c => c.channelId === channelId)?.description

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-card border border-border rounded-lg p-6 max-w-lg w-full mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-foreground">#{channelName}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
            <X size={18} />
          </button>
        </div>

        {editing ? (
          <div className="space-y-3">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Enter a channel description..."
              className="w-full min-h-[120px] rounded-md border border-border bg-secondary/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none resize-y"
              autoFocus
              disabled={saving}
            />
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setEditing(false); setDraft(liveDesc || ''); setError(null) }} disabled={saving}>Cancel</Button>
              <Button onClick={handleSave} disabled={saving || draft.trim() === (liveDesc || '')}>
                {saving ? (
                  <><Loader2 size={14} className="animate-spin mr-1.5" /> Publishing...</>
                ) : (
                  'Save'
                )}
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">
              {liveDesc || <span className="italic">No channel description</span>}
            </p>
            {isCreator && (
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => { setEditing(true); setDraft(liveDesc || '') }}
              >
                <Pencil size={14} className="mr-1.5" />
                {liveDesc ? 'Edit Description' : 'Add Description'}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

const GROUP_WINDOW_S = 5 * 60 // 5 minutes in seconds
/** Stable empty-object reference — avoids Zustand getSnapshot infinite loop */
const EMPTY_HIDDEN: Record<string, any> = {}

function formatFullDate(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: getHour12() })
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

function isDifferentDay(ts1: number, ts2: number): boolean {
  return new Date(ts1 * 1000).toDateString() !== new Date(ts2 * 1000).toDateString()
}

export function formatShortTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: getHour12() })
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Message List â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

interface MessageListProps {
  hubDTag: string
  channelId: string
  channelName: string
  optimisticMessages: OptimisticMessage[]
  setOptimisticMessages: React.Dispatch<React.SetStateAction<OptimisticMessage[]>>
  onReply: (ctx: ReplyContext) => void
  onThreadReply: (ctx: ReplyContext) => void
  canPublish: boolean
  isAnnouncement?: boolean
}

function MessageList({ hubDTag, channelId, channelName, optimisticMessages, setOptimisticMessages, onReply, onThreadReply, canPublish, isAnnouncement }: MessageListProps) {
  const { messages, sendMessage, editMessage, deleteMessage, publishReaction, unreactReaction, getChannelKey } = useMessages(hubDTag, channelId)
  const { getProfile } = useProfileCache()

  // Disappearing messages: when this hub has a timer, tick every 30s so expired
  // messages drop out of the render even in an idle channel (the render maps below
  // read `expiryNow`). No timer → no interval.
  const hubExpirationTimer = useHubStore((s) => (hubDTag ? s.hubs[hubDTag]?.messageExpiration || 0 : 0))
  const [expiryTick, setExpiryTick] = useState(0)
  useEffect(() => {
    if (hubExpirationTimer <= 0) return
    const id = setInterval(() => setExpiryTick((t) => t + 1), 30000)
    return () => clearInterval(id)
  }, [hubExpirationTimer])
  const expiryNow = Math.floor(Date.now() / 1000)
  const bottomRef = useRef<HTMLDivElement>(null)
  const myPubkey = useUserStore((s) => s.pubkey)
  const myDisplayName = useUserStore((s) => s.displayName)
  const myAvatar = useUserStore((s) => s.avatar)
  const channelPollsRaw = usePollStore((s) => s.polls[hubDTag]?.[channelId])
  // Filter polls by mod-ban and creator-ban lists
  const modBanListsForPolls = useHubStore((s) => s.modBanLists[hubDTag])
  const hubBanListForPolls = useHubStore((s) => s.hubBanLists[hubDTag])
  const hubMembersForPolls = useHubStore((s) => s.hubMembers[hubDTag])
  const channelPolls = useMemo(() => {
    const raw = channelPollsRaw || []
    const bannedSet = new Set<string>()
    const whitelisted = new Set(
      (hubMembersForPolls || []).filter(m => m.flags?.includes('w')).map(m => m.pubkey)
    )
    // Add mod-banned pubkeys
    if (modBanListsForPolls) {
      for (const pks of Object.values(modBanListsForPolls)) {
        for (const pk of pks) {
          if (!whitelisted.has(pk)) bannedSet.add(pk)
        }
      }
    }
    // Add creator-banned pubkeys
    if (hubBanListForPolls) {
      for (const pk of hubBanListForPolls) bannedSet.add(pk)
    }
    if (bannedSet.size === 0) return raw
    return raw.filter(p => !bannedSet.has(p.pubkey))
  }, [channelPollsRaw, modBanListsForPolls, hubBanListForPolls, hubMembersForPolls])
  const [profileModalPubkey, setProfileModalPubkey] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  // Reactions: lazy-decrypt + convert to Reaction[]
  const hub = useHubStore((s) => s.hubs[hubDTag])
  const hubMembers = useHubStore((s) => s.hubMembers[hubDTag])
  const { storeReactions, reactions } = useDecryptedReactions(hubDTag, getChannelKey, hub, hubMembers, channelId)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const [deleteModalMsg, setDeleteModalMsg] = useState<ChatMessage | null>(null)
  const [rawEventData, setRawEventData] = useState<{ rawJson: string; decryptedContent: string; isDecrypted: boolean } | null>(null)
  // Pending unreact — stores info needed to confirm + execute unreact
  const [pendingUnreact, setPendingUnreact] = useState<{ messageId: string; emoji: string; eventId: string } | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [threadModalParent, setThreadModalParent] = useState<ChatMessage | null>(null)
  const [pendingThreadScrollId, setPendingThreadScrollId] = useState<string | null>(null)

  // Report state
  const [reportModal, setReportModal] = useState<{ pubkey: string; messageATag?: string; messagePreview?: string } | null>(null)

  // Hidden messages state. A channel-scoped hide (entry.channelId set) only applies in THAT channel, so
  // a mod authorized only in another channel can't hide here by mis-tagging the `c` value. Legacy/hub-wide
  // hides (no channelId) apply everywhere.
  const rawHiddenMessages = useHubStore((s) => s.hiddenMessages[hubDTag]) ?? EMPTY_HIDDEN
  const hiddenMessages = useMemo(() => {
    let scoped: Record<string, typeof rawHiddenMessages[string]> | null = null
    for (const ref in rawHiddenMessages) {
      const e = rawHiddenMessages[ref]
      if (e.channelId && e.channelId !== channelId) {
        if (!scoped) scoped = { ...rawHiddenMessages }
        delete scoped[ref]
      }
    }
    return scoped ?? rawHiddenMessages
  }, [rawHiddenMessages, channelId])
  const permsForHide = usePermissions(hubDTag, channelId)
  const isCreator = !!(hub && myPubkey && (hub.creatorPubkey === myPubkey || hub.ownerRealPubkey === myPubkey))
  const canHide = isCreator || permsForHide.hide_messages

  // ── New-messages divider ──
  const channelLastRead = useNotificationStore((s) => s.hubUnreads[hubDTag]?.[channelId]?.lastRead ?? 0)
  const {
    dividerRef: newMsgDividerRef,
    dividerTimestamp: newMsgSnapshot,
    unreadCount: newMsgUnreadCount,
    showBanner: showUnreadBanner,
    dismissBanner: dismissUnreadBanner,
    jumpToDivider: jumpToNewMsgDivider,
    shouldInsertDivider,
    dividerHidden,
  } = useUnreadDivider(channelLastRead, messages, (m) => m.timestamp, `${hubDTag}:${channelId}`, myPubkey, (m) => m.pubkey)

  const handleHideMessage = useCallback(async (targetRef: string, targetPubkey: string, targetKind: number, isAddressable: boolean) => {
    if (!canHide) return
    try {
      const { createHideMessageEvent } = await import('@/lib/nostr/events')
      const { signWithSigner: signFn } = await import('@/lib/nostr')
      const { publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
      const { getPublishRelays } = await import('@/stores/postingBehaviourStore')
      const { signer, privateKey } = useUserStore.getState()
      const unsigned = createHideMessageEvent(hubDTag, targetRef, targetPubkey, targetKind, isAddressable, channelId)
      // v2: owner authors the hide as O (global), a mod as their pseudonym P (same-page).
      const { signHubModEvent } = await import('@/lib/hub/hubMemberSign')
      const signed = hub ? await signHubModEvent({ hub, unsigned, pubkey: myPubkey!, privateKey, signer }) : await signFn(unsigned, signer, privateKey)
      const relays = hub ? [...hub.generalRelays] : []
      await publishToSpecificRelays(getPublishRelays(relays, { hubOnly: !!hub && isV2(hub) }), signed)
      // Optimistic update
      useHubStore.getState().addHiddenMessage(hubDTag, {
        ref: targetRef,
        hiderPubkey: signed.pubkey,
        kind: targetKind,
        targetPubkey,
        createdAt: Math.floor(Date.now() / 1000),
      })
    } catch (err) {
      console.error('[ChannelView] Failed to hide message:', err)
    }
  }, [canHide, hubDTag, hub, myPubkey])

  const handleUnhideMessage = useCallback(async (targetRef: string) => {
    try {
      const { createDeletedHideEvent, createDeletionEvent } = await import('@/lib/nostr/events')
      const { signWithSigner: signFn } = await import('@/lib/nostr')
      const { publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
      const { getDeletePublishRelays } = await import('@/stores/postingBehaviourStore')
      const { KINDS } = await import('@/lib/crypto/constants')
      const { signer, privateKey } = useUserStore.getState()
      const relays = hub ? [...hub.generalRelays] : []
      const publishRelays = getDeletePublishRelays(relays, { hubOnly: !!hub && isV2(hub) })

      // Look up original hide event timestamp for created_at + 1 ordering
      const hideEntry = useHubStore.getState().hiddenMessages[hubDTag]?.[targetRef]
      const originalCreatedAt = hideEntry?.createdAt

      // Phase 1: Re-publish with deleted tag (authored by O/owner or P/mod in v2)
      const { signHubModEvent } = await import('@/lib/hub/hubMemberSign')
      const deletedHide = createDeletedHideEvent(hubDTag, targetRef, originalCreatedAt)
      const signedDeleted = hub ? await signHubModEvent({ hub, unsigned: deletedHide, pubkey: myPubkey!, privateKey, signer }) : await signFn(deletedHide, signer, privateKey)
      await publishToSpecificRelays(publishRelays, signedDeleted)

      // Phase 2: NIP-09 deletion request — the hide's coordinate is HIDE_MESSAGE:<O|P>:dTag in v2.
      const dTag = `${hubDTag}:${targetRef}`
      const aRef = `${KINDS.HIDE_MESSAGE}:${signedDeleted.pubkey}:${dTag}`
      const deletionReq = createDeletionEvent([], [aRef], 'unhide')
      const signedDeletion = hub ? await signHubModEvent({ hub, unsigned: deletionReq, pubkey: myPubkey!, privateKey, signer }) : await signFn(deletionReq, signer, privateKey)
      await publishToSpecificRelays(publishRelays, signedDeletion)

      // Optimistic update
      useHubStore.getState().removeHiddenMessage(hubDTag, targetRef)
    } catch (err) {
      console.error('[ChannelView] Failed to unhide message:', err)
    }
  }, [hubDTag, hub, myPubkey])

  // ── Time-travel state ──
  const [timeTravelMode, setTimeTravelMode] = useState(false)
  const [timeTravelTargetId, setTimeTravelTargetId] = useState<string | null>(null)
  const [loadingNewer, setLoadingNewer] = useState(false)
  const [hasNewer, setHasNewer] = useState(true)
  const [loadingTimeTravel, setLoadingTimeTravel] = useState(false)
  const [showScrollBanner, setShowScrollBanner] = useState(false)
  const bottomSentinelRef = useRef<HTMLDivElement>(null)

  // Reply preview cache — stores fetched reply target messages for preview display
  const [replyPreviewCache, setReplyPreviewCache] = useState<Map<string, ChatMessage>>(new Map())
  const fetchingRefsRef = useRef<Set<string>>(new Set())

  // Compute thread replies map: rootRef -> thread replies sorted by time
  // Uses rootRef (thread root) instead of replyTo so ALL thread replies are grouped
  // under the parent, even nested replies to other messages within the thread.
  const threadRepliesMap = useMemo(() => {
    const map: Record<string, ChatMessage[]> = {}
    // Disappearing messages: exclude EXPIRED replies here so every consumer of this map — the thread-reply
    // previews AND the ThreadModal (which reads threadRepliesMap[parentRef]) — hides them mid-session, not
    // just on reload. The main message list filters expired at render; these secondary surfaces read this
    // map, so filtering at the source covers them all. Recomputes on the 30s expiryTick (in deps).
    const now = Math.floor(Date.now() / 1000)
    for (const msg of messages) {
      if (msg.isThread && msg.rootRef && !msg.deleted) {
        if (msg.expiration && msg.expiration <= now) continue
        if (!map[msg.rootRef]) map[msg.rootRef] = []
        map[msg.rootRef].push(msg)
      }
    }
    // Sort each group by timestamp ascending
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => a.timestamp - b.timestamp)
    }
    return map
  }, [messages, expiryTick])

  const [loadingHistory, setLoadingHistory] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // ── Per-channel fetch on open ──
  // The hub-wide initial subscription fetches the latest 50 events across ALL
  // channels, so quieter channels may have zero messages in the store.
  // When we open such a channel, fire a targeted per-channel fetch.
  const [loadingChannelFetch, setLoadingChannelFetch] = useState(false)
  const channelFetchedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const key = `${hubDTag}:${channelId}`
    // Skip only if a previous open already succeeded in loading this channel — see below,
    // we deliberately mark it fetched ONLY once messages actually arrived.
    if (channelFetchedRef.current.has(key)) return

    const getCount = () => useMessageStore.getState().messages[hubDTag]?.[channelId]?.length ?? 0
    // Only show the loading spinner if the store has no messages yet (cache miss).
    if (getCount() === 0) setLoadingChannelFetch(true)

    // A single relay hiccup on channel open used to leave the channel permanently blank
    // (the fetch ran exactly once and its result was never checked). Retry a few times
    // with backoff, and only cache the channel as "fetched" once it actually has messages
    // — so a transient empty result recovers on the next open instead of sticking.
    let cancelled = false
    let attempts = 0
    const MAX_ATTEMPTS = 3
    const run = () => {
      fetchChannelLatest(hubDTag, channelId)
        .then((count) => {
          if (cancelled) return
          attempts++
          if (count > 0 || getCount() > 0) {
            channelFetchedRef.current.add(key)
            setLoadingChannelFetch(false)
          } else if (attempts < MAX_ATTEMPTS) {
            setTimeout(() => { if (!cancelled) run() }, 1200 * attempts)
          } else {
            // Gave up for now (channel may genuinely be empty, or relays are down).
            // Not cached, so re-opening the channel will try again.
            setLoadingChannelFetch(false)
          }
        })
        .catch(() => {
          if (cancelled) return
          attempts++
          if (attempts < MAX_ATTEMPTS) setTimeout(() => { if (!cancelled) run() }, 1200 * attempts)
          else setLoadingChannelFetch(false)
        })
    }
    run()

    return () => { cancelled = true }
  }, [hubDTag, channelId])

  // Build set of visible parent refs for thread filter
  const parentRefs = useMemo(() => {
    const refs = new Set<string>()
    for (const msg of messages) {
      if (!msg.isThread && !msg.deleted) {
        refs.add(`36943:${msg.pubkey}:${msg.dTag}`)
      }
    }
    // Also include poll event IDs as valid thread roots
    for (const poll of channelPolls) {
      refs.add(poll.id)
    }
    return refs
  }, [messages, channelPolls])

  useEffect(() => {
    if (optimisticMessages.length === 0 || messages.length === 0) return
    const toRemove: string[] = []
    for (const opt of optimisticMessages) {
      // v2: the real message is authored by the pseudonym P; its true author is `realPubkey`
      // (identity tag → R). Match on that so the optimistic bubble reconciles in v2 hubs too.
      const hasReal = messages.some((m) => (m.realPubkey ?? m.pubkey) === myPubkey && m.content === opt.content)
      if (hasReal) toRemove.push(opt.tempId)
    }
    if (toRemove.length > 0) {
      setOptimisticMessages((prev) => prev.filter((m) => !toRemove.includes(m.tempId)))
    }
  }, [messages, optimisticMessages, myPubkey, setOptimisticMessages])

  // Auto-scroll: with flex-col-reverse the browser natively pins to bottom.
  // We only need to track if the user scrolled away from bottom to suppress auto-scroll.
  const isFirstLoadRef = useRef(true)
  const isAtBottomRef = useRef(true)

  // With column-reverse: scrollTop = 0 means bottom, scrollTop < 0 means scrolled up
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const threshold = 80
    isAtBottomRef.current = Math.abs(el.scrollTop) < threshold
    // Show "jump to latest" banner when scrolled ~4 full viewports from bottom
    setShowScrollBanner(Math.abs(el.scrollTop) > el.clientHeight * 4)
  }, [])

  useEffect(() => {
    if (isFirstLoadRef.current && messages.length > 0) {
      // column-reverse starts at bottom, but force it for safety
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0
      isFirstLoadRef.current = false
    } else if (isAtBottomRef.current && messages.length > 0) {
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0
    }
  }, [messages])

  useEffect(() => {
    if (optimisticMessages.length > 0) {
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0
      isAtBottomRef.current = true
    }
  }, [optimisticMessages])

  // Scroll-triggered history loading via IntersectionObserver
  useEffect(() => {
    if (!sentinelRef.current || !scrollContainerRef.current) return
    if (!hasMore || loadingHistory) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loadingHistory && messages.length > 0) {
          // Find oldest message timestamp
          const oldest = messages.reduce((min, m) => Math.min(min, m.timestamp), Infinity)
          if (oldest === Infinity) return

          setLoadingHistory(true)

          fetchOlderMessages(hubDTag, channelId, oldest).then((count) => {
            if (count < PAGE_SIZE) {
              setHasMore(false)
            }
            // column-reverse handles scroll restoration natively —
            // older content prepends above without pushing the viewport
            setLoadingHistory(false)
          }).catch(() => {
            setLoadingHistory(false)
          })
        }
      },
      { root: scrollContainerRef.current, threshold: 0.1 }
    )

    observer.observe(sentinelRef.current)
    return () => observer.disconnect()
  }, [hasMore, loadingHistory, messages, hubDTag, channelId])

  // Reset pagination state when channel changes
  useEffect(() => {
    setHasMore(true)
    setLoadingHistory(false)
    isFirstLoadRef.current = true
    // Reset time-travel
    setTimeTravelMode(false)
    setTimeTravelTargetId(null)
    setHasNewer(true)
    setLoadingNewer(false)
    setLoadingTimeTravel(false)
    setShowScrollBanner(false)
    setReplyPreviewCache(new Map())
    fetchingRefsRef.current = new Set()
  }, [hubDTag, channelId])

  // ── Eager reply preview fetching ──
  // For messages with replyTo that aren't in the local messages list,
  // fetch the referenced event from relays for preview display.
  useEffect(() => {
    const missingRefs: string[] = []
    for (const msg of messages) {
      if (!msg.replyTo) continue
      // Already in messages?
      const parts = msg.replyTo.split(':')
      if (parts.length >= 3) {
        // a-tag format: "36943:pubkey:dTag"
        const refDTag = parts.slice(2).join(':')
        const refPubkey = parts[1]
        if (messages.some((m) => m.dTag === refDTag && m.pubkey === refPubkey)) continue
      } else {
        // Event ID format (non-addressable: polls) — check messages and poll store
        if (messages.some((m) => m.id === msg.replyTo)) continue
        const allPolls = usePollStore.getState().polls
        let foundPoll = false
        for (const hubKey of Object.keys(allPolls)) {
          for (const chKey of Object.keys(allPolls[hubKey])) {
            if (allPolls[hubKey][chKey].some((p) => p.id === msg.replyTo)) { foundPoll = true; break }
          }
          if (foundPoll) break
        }
        if (foundPoll) continue
      }
      // Already in cache or being fetched?
      if (replyPreviewCache.has(msg.replyTo)) continue
      if (fetchingRefsRef.current.has(msg.replyTo)) continue
      missingRefs.push(msg.replyTo)
    }

    for (const ref of missingRefs) {
      fetchingRefsRef.current.add(ref)
      fetchSingleMessage(hubDTag, ref).then((rawMsg) => {
        if (!rawMsg) return
        // Decrypt the fetched message for preview
        // We have access to the decryptContent logic via the hook, but the raw msg
        // is in store format. We need to create a ChatMessage from it.
        // The message is added to the store by fetchSingleMessage, so it will
        // appear in useMessages on next render. Just mark it in cache.
        setReplyPreviewCache(prev => {
          const next = new Map(prev)
          next.set(ref, { id: rawMsg.id, dTag: rawMsg.dTag, pubkey: rawMsg.pubkey, content: rawMsg.content, timestamp: rawMsg.createdAt, decrypted: false } as ChatMessage)
          return next
        })
      })
    }
  }, [messages, hubDTag, replyPreviewCache])

  // ── Scroll-down observer for time-travel (load newer messages) ──
  useEffect(() => {
    if (!timeTravelMode || !bottomSentinelRef.current || !scrollContainerRef.current) return
    if (!hasNewer || loadingNewer) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNewer && !loadingNewer && messages.length > 0) {
          const newest = messages.reduce((max, m) => Math.max(max, m.timestamp), 0)
          if (newest === 0) return

          setLoadingNewer(true)

          const container = scrollContainerRef.current
          const prevScrollTop = container?.scrollTop || 0

          fetchNewerMessages(hubDTag, channelId, newest).then((count) => {
            if (count < PAGE_SIZE) {
              // Reached the present — exit time-travel mode
              setHasNewer(false)
              setTimeTravelMode(false)
              setTimeTravelTargetId(null)
            }
            // Preserve scroll position
            requestAnimationFrame(() => {
              if (container) {
                container.scrollTop = prevScrollTop
              }
            })
            setLoadingNewer(false)
          }).catch(() => {
            setLoadingNewer(false)
          })
        }
      },
      { root: scrollContainerRef.current, threshold: 0.1 }
    )

    observer.observe(bottomSentinelRef.current)
    return () => observer.disconnect()
  }, [timeTravelMode, hasNewer, loadingNewer, messages, hubDTag, channelId])

  // ── Time-travel jump handler ──
  const handleTimeTravel = useCallback(async (ref: string) => {
    // Parse the a-tag ref to get the target message's timestamp
    // First check if it's in cache or messages
    const parts = ref.split(':')
    if (parts.length < 3) return
    const refDTag = parts.slice(2).join(':')
    const refPubkey = parts[1]

    // Find target in messages or cache
    let target = messages.find(m => m.dTag === refDTag && m.pubkey === refPubkey)
    if (!target) {
      // Check store directly
      const allMsgs = useMessageStore.getState().messages[hubDTag]?.[channelId] || []
      const rawTarget = allMsgs.find(m => m.dTag === refDTag && m.pubkey === refPubkey)
      if (rawTarget) {
        target = { id: rawTarget.id, dTag: rawTarget.dTag, pubkey: rawTarget.pubkey, content: '', timestamp: rawTarget.createdAt, decrypted: false } as ChatMessage
      }
    }

    if (!target) {
      // Need to fetch the target first
      setLoadingTimeTravel(true)
      const rawMsg = await fetchSingleMessage(hubDTag, ref)
      setLoadingTimeTravel(false)
      if (!rawMsg) return // couldn't find the message on relays
      target = { id: rawMsg.id, dTag: rawMsg.dTag, pubkey: rawMsg.pubkey, content: '', timestamp: rawMsg.createdAt, decrypted: false } as ChatMessage
    }

    // Now fetch context around the target
    setLoadingTimeTravel(true)
    await fetchMessageContext(hubDTag, channelId, target.timestamp)
    setLoadingTimeTravel(false)

    // Enter time-travel mode
    setTimeTravelMode(true)
    setTimeTravelTargetId(target.id)
    setHasNewer(true)
    setHasMore(true)

    // Scroll to target after render
    requestAnimationFrame(() => {
      setTimeout(() => {
        const el = document.getElementById(`msg-${target!.id}`)
        if (el) {
          el.scrollIntoView({ behavior: 'auto', block: 'center' })
          setHighlightedId(target!.id)
          setTimeout(() => setHighlightedId(null), 2000)
        }
      }, 100)
    })
  }, [messages, hubDTag, channelId])


  // Jump to latest — exit time-travel
  const jumpToLatest = useCallback(() => {
    setTimeTravelMode(false)
    setTimeTravelTargetId(null)
    setHasNewer(true)
    setHasMore(true)
    setShowScrollBanner(false)
    // Scroll to bottom of real messages
    requestAnimationFrame(() => {
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0
    })
  }, [])

  // Scroll to bottom when user has scrolled far up (messages still in DOM, not time-travel)
  const scrollToBottom = useCallback(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' })
    }
    setShowScrollBanner(false)
  }, [])

  const myNpubName = myDisplayName || (myPubkey ? truncateNpub(nip19.npubEncode(myPubkey)) : 'You')

  const handleRetry = useCallback(async (tempId: string) => {
    // Find the failed message and its retry data
    const failedMsg = optimisticMessages.find((m) => m.tempId === tempId)
    if (!failedMsg?.retryData) {
      // No retry data — dismiss instead of hanging
      setOptimisticMessages((prev) => prev.filter((m) => m.tempId !== tempId))
      return
    }

    const rd = failedMsg.retryData
    setOptimisticMessages((prev) =>
      prev.map((m) => (m.tempId === tempId ? { ...m, status: 'mining' as const, relayProgress: undefined } : m))
    )

    try {
      await sendMessage(
        rd.text,
        rd.replyTo,
        (phase, relayProgress, sentDTag) => {
          setOptimisticMessages((prev) =>
            prev.map((m) => {
              if (m.tempId !== tempId) return m
              if (phase === 'publishing' && relayProgress && relayProgress.confirmed > 0) {
                return { ...m, status: 'published' as const, relayProgress, sentDTag: sentDTag || m.sentDTag }
              }
              return { ...m, status: phase, relayProgress: relayProgress || m.relayProgress, sentDTag: sentDTag || m.sentDTag }
            })
          )
        },
        rd.rootRef,
        rd.attachments,
        rd.nsfw,
        rd.isThread,
        rd.isEncrypted,
        rd.facilitator,
        undefined, // forumFields
        rd.stickerTags,
        rd.gifTags
      )
      // Success — mark published; reconciliation effect handles cleanup
      setOptimisticMessages((prev) =>
        prev.map((m) => (m.tempId === tempId ? { ...m, status: 'published' as const } : m))
      )
    } catch {
      setOptimisticMessages((prev) =>
        prev.map((m) => (m.tempId === tempId ? { ...m, status: 'failed' as const } : m))
      )
    }
  }, [optimisticMessages, sendMessage, setOptimisticMessages])

  const handleDismiss = useCallback((tempId: string) => {
    setOptimisticMessages((prev) => prev.filter((m) => m.tempId !== tempId))
  }, [setOptimisticMessages])

  // Reconciliation: remove optimistic messages once the real decrypted version
  // appears in the message list. This replaces the fragile 2-second timer and
  // is immune to startup timing issues (decrypt effect cancellation during
  // initial subscription batch loading).
  useEffect(() => {
    if (optimisticMessages.length === 0 || messages.length === 0) return
    const toRemove = optimisticMessages.filter((opt) =>
      // v2 authors as P; reconcile on the real author (realPubkey = identity → R, else pubkey).
      opt.sentDTag && opt.status === 'published' && messages.some((m) => m.dTag === opt.sentDTag && (m.realPubkey ?? m.pubkey) === myPubkey)
    )
    if (toRemove.length > 0) {
      // Small delay so the ✓ check is visible briefly before the optimistic
      // bubble disappears and the real message takes over
      const timer = setTimeout(() => {
        const ids = new Set(toRemove.map((m) => m.tempId))
        setOptimisticMessages((prev) => prev.filter((m) => !ids.has(m.tempId)))
      }, 600)
      return () => clearTimeout(timer)
    }
  }, [messages, optimisticMessages, myPubkey, setOptimisticMessages])

  // Safety: clean up very old optimistic messages (> 60s) that somehow
  // never got reconciled (e.g. relay accepted but subscription never delivered)
  useEffect(() => {
    const stale = optimisticMessages.filter((m) =>
      m.status === 'published' && (Date.now() / 1000 - m.timestamp) > 60
    )
    if (stale.length > 0) {
      const ids = new Set(stale.map((m) => m.tempId))
      setOptimisticMessages((prev) => prev.filter((m) => !ids.has(m.tempId)))
    }
  }, [optimisticMessages, setOptimisticMessages])

  const startEdit = useCallback((msg: ChatMessage) => {
    setEditingId(msg.id)
    setEditText(msg.content)
  }, [])

  const cancelEdit = useCallback(() => {
    setEditingId(null)
    setEditText('')
  }, [])

  const saveEdit = useCallback(async (originalMsg: ChatMessage, newText: string, removedHashes?: Set<string>) => {
    const attachmentsChanged = removedHashes && removedHashes.size > 0
    if (!newText.trim() || (newText === originalMsg.content && !attachmentsChanged)) return
    // Filter out removed attachments
    const remainingAttachments = attachmentsChanged && originalMsg.attachments
      ? originalMsg.attachments.filter(a => !removedHashes.has(a.hash))
      : originalMsg.attachments
    // Pass replyTo, rootRef, attachments, and nsfw to preserve them on edit.
    // Let errors (e.g. signer unavailable / wrong account) propagate so the edit
    // field can show them instead of closing as if the edit succeeded.
    await editMessage(originalMsg.dTag, newText, originalMsg.replyTo, originalMsg.rootRef, undefined, remainingAttachments, originalMsg.nsfw || undefined, originalMsg.isThread || undefined)
    setEditingId(null)
    setEditText('')
  }, [editMessage])

  const handleReply = useCallback((msg: ChatMessage) => {
    const profile = getProfile(msg.pubkey)
    const name = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(msg.pubkey))
    // If replying to a reply, inherit its root; otherwise this message becomes the root
    const root = msg.rootRef || `36943:${msg.pubkey}:${msg.dTag}`
    onReply({
      dTag: msg.dTag,
      pubkey: msg.pubkey,
      displayName: name,
      preview: msg.content.slice(0, 80),
      rootRef: root,
    })
  }, [getProfile, onReply])

  const handleThreadReply = useCallback((msg: ChatMessage) => {
    // Open the thread modal for this message and let the user reply in its own input,
    // rather than hooking the reply into the main composer. Replying in the main
    // composer adds an optimistic message to the main list, which scrolls the channel
    // to the bottom on send — losing the user's scroll position.
    setThreadModalParent(msg)
  }, [])

  const addReaction = useCallback((messageId: string, emoji: string, customUrl?: string) => {
    // Gate on add_reactions permission
    if (hub && myPubkey) {
      const myPerms = getPermissionsForUser(hub, myPubkey, hubMembers, channelId)
      if (!myPerms.add_reactions) return
    }

    // Find the target message to get its pubkey + dTag for publishing
    const targetMsg = messages.find((m) => m.id === messageId)
    if (!targetMsg) return

    // Check if already reacted with this emoji — toggle (unreact)
    const existing = storeReactions[messageId] || []
    const myExisting = existing.find((r) => r.emoji === emoji && (r.realPubkey ?? r.pubkey) === myPubkey)
    if (myExisting) {
      // Show confirmation dialog instead of immediately unreacting
      setPendingUnreact({ messageId, emoji, eventId: myExisting.eventId })
      return
    }

    // Add locally (optimistic)
    useMessageStore.getState().addReaction(hubDTag, messageId, {
      emoji,
      pubkey: myPubkey!,
      eventId: 'optimistic-' + Date.now(),
      createdAt: Math.floor(Date.now() / 1000),
      customUrl,
    })

    // Publish to relay
    publishReaction(emoji, messageId, targetMsg.pubkey, targetMsg.dTag, customUrl).catch(() => { })
  }, [messages, storeReactions, myPubkey, hubDTag, publishReaction, unreactReaction, hub, hubMembers, channelId])

  // Look up a message by ID -- used for reply previews
  // Find message by a-tag value ("36943:pubkey:dTag") or by d-tag directly
  // Also checks the reply preview cache for eagerly-fetched old messages
  const getMessageByRef = useCallback((ref: string): ChatMessage | undefined => {
    // ref is in format "36943:pubkey:dTag" for addressable events
    const parts = ref.split(':')
    if (parts.length >= 3) {
      const refDTag = parts.slice(2).join(':') // d-tag may contain colons
      const refPubkey = parts[1]
      const found = messages.find((m) => m.dTag === refDTag && m.pubkey === refPubkey)
      if (found) return found
      // Check reply preview cache
      return replyPreviewCache.get(ref)
    }
    // ref is an event ID (for non-addressable events like polls)
    const byId = messages.find((m) => m.id === ref)
    if (byId) return byId
    // Check if it's a poll — synthesize a minimal ChatMessage for preview
    const allPolls = usePollStore.getState().polls
    for (const hubKey of Object.keys(allPolls)) {
      for (const chKey of Object.keys(allPolls[hubKey])) {
        const poll = allPolls[hubKey][chKey].find((p) => p.id === ref)
        if (poll) {
          return {
            id: poll.id,
            dTag: '',
            hubDTag: poll.hubDTag,
            channelId: poll.channelId,
            pubkey: poll.pubkey,
            content: poll.content,
            timestamp: poll.createdAt,
            createdAt: poll.createdAt,
            epoch: poll.epoch,
            decrypted: false,
            isPoll: true,
          } as ChatMessage
        }
      }
    }
    return undefined
  }, [messages, replyPreviewCache])

  const scrollToMessage = useCallback((messageId: string) => {
    const el = document.getElementById(`msg-${messageId}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlightedId(messageId)
      setTimeout(() => setHighlightedId(null), 2000)
    } else {
      // Message not in DOM — find its a-tag ref and time-travel to it
      const foundMsg = messages.find(m => m.id === messageId)
      if (foundMsg) {
        handleTimeTravel(`36943:${foundMsg.pubkey}:${foundMsg.dTag}`)
      } else {
        // Check reply preview cache
        for (const [ref, cached] of replyPreviewCache) {
          if (cached.id === messageId) {
            handleTimeTravel(ref)
            break
          }
        }
      }
    }
  }, [messages, replyPreviewCache, handleTimeTravel])

  // Listen for pin-jump events from PinModal
  useEffect(() => {
    const handler = (e: Event) => {
      const { aRef } = (e as CustomEvent).detail
      if (!aRef) return
      // Parse aRef (36943:pubkey:dTag) → find the message
      const parts = aRef.split(':')
      if (parts.length >= 3) {
        const refPubkey = parts[1]
        const refDTag = parts.slice(2).join(':')
        const msg = messages.find(m => m.dTag === refDTag && m.pubkey === refPubkey)
        if (msg) {
          // Check if this is a thread reply — if so, open the thread modal
          if (msg.isThread && msg.rootRef) {
            // Find the thread parent via rootRef
            const rootParts = msg.rootRef.split(':')
            if (rootParts.length >= 3) {
              const rootPubkey = rootParts[1]
              const rootDTag = rootParts.slice(2).join(':')
              const parentMsg = messages.find(m => m.dTag === rootDTag && m.pubkey === rootPubkey)
              if (parentMsg) {
                setThreadModalParent(parentMsg)
                setPendingThreadScrollId(msg.id)
                return
              }
            }
          }
          scrollToMessage(msg.id)
          return
        }
      }
      // Message not found locally — fall back to time-travel
      handleTimeTravel(aRef)
    }
    window.addEventListener('pin-jump-to-message', handler)
    return () => window.removeEventListener('pin-jump-to-message', handler)
  }, [messages, scrollToMessage, handleTimeTravel])

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex-1 overflow-y-auto relative flex flex-col-reverse" ref={scrollContainerRef} onScroll={handleScroll}>
        {/* Floating unread banner — above the scroll area */}
        {showUnreadBanner && (
          <UnreadBanner
            count={newMsgUnreadCount}
            sinceTimestamp={newMsgSnapshot}
            onJump={jumpToNewMsgDivider}
            onDismiss={dismissUnreadBanner}
          />
        )}
        <div className="px-4 py-4">
          <div>
            <WelcomeMessage channelName={channelName} />

            {/* Loading spinner for per-channel fetch on open */}
            {loadingChannelFetch && messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-8">
                <Loader2 size={22} className="animate-spin text-primary mb-2" />
                <span className="text-sm text-muted-foreground">Loading messages...</span>
              </div>
            )}

            {/* Loading spinner for history */}
            {loadingHistory && (
              <div className="flex items-center justify-center py-3">
                <Loader2 size={18} className="animate-spin text-muted-foreground" />
                <span className="text-xs text-muted-foreground ml-2">Loading older messages...</span>
              </div>
            )}

            {!hasMore && messages.length > 0 && (
              <div className="text-center text-xs text-muted-foreground py-2">Beginning of conversation</div>
            )}

            {/* Sentinel element for IntersectionObserver — triggers history loading when visible */}
            {hasMore && <div ref={sentinelRef} className="h-1" />}

            {/* Build merged timeline: messages + polls sorted by timestamp */}
            {(() => {
              type TimelineItem =
                | { type: 'message'; data: ChatMessage; index: number }
                | { type: 'poll'; data: RawPoll }

              const timeline: TimelineItem[] = [
                ...messages.map((m, i) => ({ type: 'message' as const, data: m, index: i })),
                ...channelPolls.map((p) => ({ type: 'poll' as const, data: p })),
              ].sort((a, b) => {
                const tsA = a.type === 'message' ? a.data.timestamp : a.data.createdAt
                const tsB = b.type === 'message' ? b.data.timestamp : b.data.createdAt
                return tsA - tsB
              })

              // Track previous visible message for grouping logic
              let lastVisibleMsg: ChatMessage | null = null

              return timeline.map((item) => {
                if (item.type === 'poll') {
                  // Reset message grouping across poll boundaries
                  lastVisibleMsg = null
                  const pollData = item.data

                  // Enforce create_polls permission — suppress polls from users
                  // whose role lacks create_polls (even if published via modified client)
                  if (hub && pollData.pubkey !== hub.creatorPubkey) {
                    const pollAuthorPerms = getPermissionsForUser(hub, pollData.pubkey, hubMembers, channelId)
                    if (!pollAuthorPerms.create_polls) return null
                  }

                  return (
                    <Fragment key={`poll-${pollData.id}`}>
                      <PollCard
                        poll={pollData}
                        hubDTag={hubDTag}
                        channelId={channelId}
                        onOpenProfile={setProfileModalPubkey}
                        onReply={(pollMsg) => {
                          const profile = getProfile(pollMsg.pubkey)
                          const name = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(pollMsg.pubkey))
                          onReply({
                            dTag: '',
                            pubkey: pollMsg.pubkey,
                            displayName: name,
                            preview: pollMsg.content.slice(0, 80),
                            rootRef: pollMsg.id,
                            eventId: pollMsg.id,
                          })
                        }}
                        onThreadReply={(pollMsg) => {
                          const profile = getProfile(pollMsg.pubkey)
                          const name = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(pollMsg.pubkey))
                          onThreadReply({
                            dTag: '',
                            pubkey: pollMsg.pubkey,
                            displayName: name,
                            preview: pollMsg.content.slice(0, 80),
                            rootRef: pollMsg.id,
                            isThread: true,
                            eventId: pollMsg.id,
                          })
                        }}
                        onRequestDelete={(eventId) => {
                          setDeleteModalMsg({ id: pollData.id, pubkey: pollData.pubkey, dTag: '', content: '', timestamp: pollData.createdAt, decrypted: true } as ChatMessage)
                        }}
                        onViewRaw={(raw) => {
                          setRawEventData({ rawJson: raw, decryptedContent: '', isDecrypted: false })
                        }}
                        onAddReaction={(messageId, emoji, customUrl) => {
                          // Unreact check
                          const existing = storeReactions[messageId] || []
                          const myExisting = existing.find((r) => r.emoji === emoji && (r.realPubkey ?? r.pubkey) === myPubkey)
                          if (myExisting) {
                            setPendingUnreact({ messageId, emoji, eventId: myExisting.eventId })
                            return
                          }
                          // Optimistic add
                          useMessageStore.getState().addReaction(hubDTag, messageId, {
                            emoji,
                            pubkey: myPubkey!,
                            eventId: 'optimistic-' + Date.now(),
                            createdAt: Math.floor(Date.now() / 1000),
                            customUrl,
                          })
                          // Publish — no dTag for polls (non-addressable)
                          publishReaction(emoji, messageId, pollData.pubkey, undefined, customUrl).catch(() => { })
                        }}
                        reactions={reactions[pollData.id] || []}
                        canPublish={canPublish}
                        highlighted={highlightedId === pollData.id}
                        onHideMessage={canHide ? () => handleHideMessage(pollData.id, pollData.pubkey, 1067, false) : undefined}
                        onUnhideMessage={canHide ? () => handleUnhideMessage(pollData.id) : undefined}
                        isHidden={!!hiddenMessages[pollData.id]}
                        canHide={canHide}
                        hiddenBy={(() => {
                          const entry = hiddenMessages[pollData.id]
                          if (!entry) return undefined
                          const p = getProfile(entry.hiderPubkey)
                          return p?.display_name || p?.name || truncateNpub(nip19.npubEncode(entry.hiderPubkey))
                        })()}
                      />
                      {/* Thread indicator for poll — show if this poll has thread replies */}
                      {!isAnnouncement && (() => {
                        const threadReplies = threadRepliesMap[pollData.id]
                        if (!threadReplies || threadReplies.length === 0) return null
                        const latest = threadReplies[threadReplies.length - 1]
                        const latestProfile = getProfile(latest.pubkey)
                        const latestName = latestProfile?.display_name || latestProfile?.name || truncateNpub(nip19.npubEncode(latest.pubkey))
                        const ago = formatTimestamp(latest.timestamp)
                        return (
                          <button
                            onClick={() => setThreadModalParent({ id: pollData.id, dTag: '', pubkey: pollData.pubkey, content: '', timestamp: pollData.createdAt, decrypted: false } as ChatMessage)}
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
                            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">{ago}</span>
                          </button>
                        )
                      })()}
                    </Fragment>
                  )
                }

                // Message rendering — same logic as before
                const msg = item.data
                const i = item.index

                // Find the previous VISIBLE (non-deleted, non-thread-hidden) message for grouping
                let prev: ChatMessage | null = null
                for (let j = i - 1; j >= 0; j--) {
                  const candidate = messages[j]
                  if (candidate.deleted) continue
                  if (candidate.isThread === true && (
                    (candidate.replyTo && parentRefs.has(candidate.replyTo)) ||
                    (candidate.rootRef && parentRefs.has(candidate.rootRef))
                  )) continue
                  prev = candidate
                  break
                }
                // Also account for polls breaking the grouping
                if (lastVisibleMsg === null && prev) {
                  // Check if a poll appears between prev and msg in timeline
                  const prevTs = prev.timestamp
                  const msgTs = msg.timestamp
                  const pollBetween = channelPolls.some((p) => p.createdAt > prevTs && p.createdAt < msgTs)
                  if (pollBetween) prev = null
                }

                const showDateSep = !prev || isDifferentDay(prev.timestamp, msg.timestamp)
                // Replies always break grouping so they show with full header
                const hasReply = !!msg.replyTo
                const isGrouped = prev
                  && prev.pubkey === msg.pubkey
                  && !showDateSep
                  && !hasReply
                  && (msg.timestamp - prev.timestamp) <= GROUP_WINDOW_S

                // Don't render deleted messages
                if (msg.deleted) return null
                // Disappearing messages: hide any that have expired (re-evaluated on
                // each render; the expiryTick below forces a periodic re-render so
                // they vanish even in an idle channel). Ingest/cache already exclude
                // ones that were expired on arrival/load.
                if (msg.expiration && msg.expiration <= expiryNow) return null
                // In announcement channels, hide all replies and thread replies (even if posted externally)
                if (isAnnouncement && (msg.replyTo || msg.isThread)) return null
                // Only hide thread replies when their thread root (rootRef) is visible in the current view
                if (msg.isThread === true && (
                  (msg.replyTo && parentRefs.has(msg.replyTo)) ||
                  (msg.rootRef && parentRefs.has(msg.rootRef))
                )) return null

                // Enforce send_messages permission — suppress messages from users whose role lacks
                // send_messages (even if published via a modified client). Resolve against the IDENTITY-
                // VERIFIED real key (realPubkey), NOT the wire pseudonym: on v2 a restricted member could
                // author under a throwaway P' (with a valid identity tag naming their real R) — P' is in
                // neither m.pubkey nor m.p, so it would fall through to the permissive `everyone` role and
                // bypass a per-channel/role restriction. realPubkey resolves to their true roster role.
                const sendAuthorKey = msg.realPubkey ?? msg.pubkey
                if (hub && sendAuthorKey !== hub.creatorPubkey) {
                  const authorPerms = getPermissionsForUser(hub, sendAuthorKey, hubMembers, channelId)
                  if (!authorPerms.send_messages) return null
                }
                // Track for next iteration
                lastVisibleMsg = msg

                // Determine reply state for the preview
                const repliedMsg = msg.replyTo ? getMessageByRef(msg.replyTo) : undefined
                // Disappearing messages: treat an EXPIRED replied-to message as gone so the reply-quote
                // preview doesn't keep showing its content mid-session (the quote holds its own copy, which
                // the main-list expiry filter above doesn't reach).
                const replyDeleted = repliedMsg?.deleted || (!!repliedMsg?.expiration && repliedMsg.expiration <= expiryNow)
                const replyNotFound = msg.replyTo && !repliedMsg

                // Check if the new-messages divider should be inserted before this message
                const prevTimestampForDivider = prev ? prev.timestamp : null
                const insertNewMsgDivider = shouldInsertDivider(msg.timestamp, prevTimestampForDivider, msg.pubkey)

                return (
                  <div key={msg.id} id={`msg-${msg.id}`}>
                    {showDateSep && <DateSeparator timestamp={msg.timestamp} />}
                    {insertNewMsgDivider && <NewMessagesDivider ref={newMsgDividerRef} hidden={dividerHidden} />}
                    <ChatMessageRow
                      msg={msg}
                      hubDTag={hubDTag}
                      isGrouped={!!isGrouped}
                      isMine={(msg.realPubkey ?? msg.pubkey) === myPubkey}
                      onOpenProfile={setProfileModalPubkey}
                      onEdit={startEdit}
                      onReply={isAnnouncement ? () => { } : handleReply}
                      onThreadReply={isAnnouncement ? () => { } : handleThreadReply}
                      canPublish={canPublish}
                      hideThreadReply={isAnnouncement}
                      hideReply={isAnnouncement}
                      onSaveEdit={saveEdit}
                      editingId={editingId}
                      editText={editText}
                      setEditText={setEditText}
                      cancelEdit={cancelEdit}
                      getProfile={getProfile}
                      reactions={reactions[msg.id] || []}
                      rawReactions={storeReactions[msg.id]}
                      onAddReaction={addReaction}
                      repliedMessage={replyNotFound ? undefined : (replyDeleted ? undefined : repliedMsg)}
                      replyStatus={replyNotFound ? 'not-found' : (replyDeleted ? 'deleted' : undefined)}
                      getProfileForReply={getProfile}
                      highlighted={highlightedId === msg.id}
                      onScrollToMessage={scrollToMessage}
                      onTimeTravel={handleTimeTravel}
                      onRequestDelete={() => setDeleteModalMsg(msg)}
                      onViewRaw={(raw) => {
                        const payload = msg.attachments?.length || msg.nsfw
                          ? JSON.stringify({ text: msg.content, ...(msg.attachments?.length ? { attachments: msg.attachments } : {}), ...(msg.nsfw ? { nsfw: true } : {}) }, null, 2)
                          : msg.content
                        setRawEventData({ rawJson: raw, decryptedContent: payload, isDecrypted: msg.decrypted })
                      }}
                      channelId={channelId}
                      onReport={(rpk, aTag, preview) => setReportModal({ pubkey: rpk, messageATag: aTag, messagePreview: preview })}
                      isHidden={!!hiddenMessages[`36943:${msg.pubkey}:${msg.dTag}`]}
                      canHide={canHide}
                      hiddenBy={(() => {
                        const entry = hiddenMessages[`36943:${msg.pubkey}:${msg.dTag}`]
                        if (!entry) return undefined
                        const p = getProfile(entry.hiderPubkey)
                        return p?.display_name || p?.name || truncateNpub(nip19.npubEncode(entry.hiderPubkey))
                      })()}
                      onHideMessage={canHide ? () => handleHideMessage(`36943:${msg.pubkey}:${msg.dTag}`, msg.pubkey, 36943, true) : undefined}
                      onUnhideMessage={canHide ? () => handleUnhideMessage(`36943:${msg.pubkey}:${msg.dTag}`) : undefined}
                    />
                    {/* Thread indicator — show if this message has thread replies (hidden for announcement channels) */}
                    {!isAnnouncement && (() => {
                      const msgRef = `36943:${msg.pubkey}:${msg.dTag}`
                      const threadReplies = threadRepliesMap[msgRef]
                      if (!threadReplies || threadReplies.length === 0) return null
                      const latest = threadReplies[threadReplies.length - 1]
                      const latestProfile = getProfile(latest.pubkey)
                      const latestName = latestProfile?.display_name || latestProfile?.name || truncateNpub(nip19.npubEncode(latest.pubkey))
                      const ago = formatTimestamp(latest.timestamp)
                      return (
                        <button
                          onClick={() => setThreadModalParent(msg)}
                          className="flex flex-wrap items-center gap-x-2 gap-y-1 ml-12 mt-0.5 mb-1 px-3 py-1.5 rounded-md bg-primary/5 hover:bg-primary/10 border border-primary/15 transition-colors cursor-pointer group"
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
                          <span className="text-[10px] text-muted-foreground ml-auto shrink-0">{ago}</span>
                        </button>
                      )
                    })()}
                  </div>
                )
              })
            })()}

            {/* Optimistic messages (scoped to this channel, excluding those already reconciled with real messages) */}
            {optimisticMessages.filter((o) => o.channelId === channelId && !(o.sentDTag && messages.some((m) => m.dTag === o.sentDTag && (m.realPubkey ?? m.pubkey) === myPubkey))).map((optMsg) => (
              <div
                key={optMsg.tempId}
                className={`flex gap-3 mt-4 py-1 px-2 rounded-md -mx-2 transition-opacity ${optMsg.status === 'published' ? 'opacity-70' : 'opacity-50'
                  }`}
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
                    {myAvatar && <AvatarImage src={myAvatar} alt={myNpubName} />}
                    <AvatarFallback className="text-xs bg-primary/20 text-primary">
                      {myNpubName.slice(0, 2).toUpperCase()}
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
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{myNpubName}</span>
                    <span className="text-xs text-muted-foreground">{formatTimestamp(optMsg.timestamp)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-base text-foreground/90 break-words"><MessageContent content={optMsg.content} /></div>
                    {optMsg.status === 'mining' && (
                      <span className="text-[10px] text-muted-foreground italic whitespace-nowrap">
                        processing...
                      </span>
                    )}
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
                  </div>
                  {optMsg.status === 'failed' && (
                    <div className="mt-1.5 flex items-center gap-3 px-3 py-2 rounded-lg bg-secondary border border-destructive/25">
                      <AlertCircle size={16} className="shrink-0" />
                      <span className="text-xs font-medium">Failed to send</span>
                      <div className="flex items-center gap-2 ml-auto shrink-0">
                        <button
                          onClick={() => handleRetry(optMsg.tempId)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
                        >
                          <RotateCcw size={12} />
                          Retry
                        </button>
                        <button
                          onClick={() => handleDismiss(optMsg.tempId)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-white bg-secondary/80 hover:bg-destructive border border-border/50 transition-colors cursor-pointer"
                        >
                          <X size={12} />
                          Dismiss
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Bottom sentinel for scroll-down (load newer in time-travel) */}
            {timeTravelMode && hasNewer && <div ref={bottomSentinelRef} className="h-1" />}

            {/* Loading spinner for newer messages */}
            {loadingNewer && (
              <div className="flex items-center justify-center py-3">
                <Loader2 size={18} className="animate-spin text-muted-foreground" />
                <span className="text-xs text-muted-foreground ml-2">Loading newer messages...</span>
              </div>
            )}

            {/* Jump-to-latest bar — shown in time-travel mode or when scrolled far from bottom */}
            {(timeTravelMode || showScrollBanner) && (
              <div className="sticky bottom-4 z-10 flex items-center justify-center">
                <div className="flex items-center gap-3 py-1.5 pl-4 pr-1.5 bg-secondary/95 backdrop-blur-sm outline outline-1 outline-white/15 shadow-lg rounded-full">
                  <span className="text-[13px] text-muted-foreground leading-none">You're viewing older messages</span>
                  <button
                    onClick={timeTravelMode ? jumpToLatest : scrollToBottom}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-primary-foreground text-xs font-medium leading-none hover:bg-primary-hover transition-colors cursor-pointer"
                  >
                    <ArrowDown size={11} />
                    Jump to latest
                  </button>
                </div>
              </div>
            )}

            {/* Time-travel loading overlay */}
            {loadingTimeTravel && (
              <div className="flex items-center justify-center py-6">
                <Loader2 size={20} className="animate-spin text-primary" />
                <span className="text-sm text-muted-foreground ml-2">Jumping to message...</span>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        </div>

        <UserProfileModal
          open={!!profileModalPubkey}
          onClose={() => setProfileModalPubkey(null)}
          targetPubkey={profileModalPubkey}
          hubContext={(() => {
            const hub = useHubStore.getState().hubs[hubDTag]
            return hub ? { dTag: hubDTag, creatorPubkey: hub.creatorPubkey, ownerRealPubkey: hub.ownerRealPubkey } : null
          })()}
          onDM={(pubkey) => {
            useDM04Store.getState().setActiveConversation(pubkey)
            useDMStore.getState().setActiveConversation(pubkey)
            useNavigationStore.getState().setActivePage('dms')
          }}
        />
      </div>

      {/* Delete confirmation modal */}
      {deleteModalMsg && (
        <DeleteConfirmDialog
          onCancel={() => setDeleteModalMsg(null)}
          onConfirm={async () => {
            await deleteMessage(deleteModalMsg.dTag)
            setDeleteModalMsg(null)
          }}
        />
      )}

      {/* Unreact confirmation modal */}
      {pendingUnreact && (
        <DeleteConfirmDialog
          onCancel={() => setPendingUnreact(null)}
          onConfirm={async () => {
            useMessageStore.getState().removeReaction(hubDTag, pendingUnreact.messageId, pendingUnreact.emoji, myPubkey!)
            await unreactReaction(pendingUnreact.eventId)
            setPendingUnreact(null)
          }}
          title="Remove Reaction"
          progressSteps={['Sending deletion request...']}
          confirmLabel="Yes, Remove"
        />
      )}
      {/* Raw event modal */}
      {rawEventData && (
        <RawEventModal
          rawJson={rawEventData.rawJson}
          decryptedContent={rawEventData.decryptedContent}
          isDecrypted={rawEventData.isDecrypted}
          onClose={() => setRawEventData(null)}
        />
      )}

      {/* Thread modal */}
      {threadModalParent && (() => {
        const parentRef = threadModalParent.dTag
          ? `36943:${threadModalParent.pubkey}:${threadModalParent.dTag}`
          : threadModalParent.id
        const replies = threadRepliesMap[parentRef] || []
        return (
          <ThreadModal
            parentMsg={threadModalParent}
            threadReplies={replies}
            hubDTag={hubDTag}
            channelId={channelId}
            getProfile={getProfile}
            sendMessage={sendMessage}
            editMessage={editMessage}
            deleteMessage={deleteMessage}
            publishReaction={publishReaction}
            unreactReaction={unreactReaction}
            getChannelKey={getChannelKey}
            onClose={() => { setThreadModalParent(null); setPendingThreadScrollId(null) }}
            canPublish={canPublish}
            initialScrollToId={pendingThreadScrollId}
            onInitialScrollComplete={() => setPendingThreadScrollId(null)}
          />
        )
      })()}
      {/* Report modal */}
      {reportModal && hub && (
        <ReportModal
          open={!!reportModal}
          onClose={() => setReportModal(null)}
          hubDTag={hubDTag}
          hubCreatorPubkey={hub.creatorPubkey}
          reportedPubkey={reportModal.pubkey}
          reportedMessageATag={reportModal.messageATag}
          reportedMessagePreview={reportModal.messagePreview}
        />
      )}
    </TooltipProvider>
  )
}


/* --- Relay Progress Indicator (inline, next to "via DEN Chat") --- */

function RelayProgressIndicator({ eventId }: { eventId: string }) {
  const progress = useMessageStore((s) => s.relayProgress[eventId])
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


/* --- Message rendering components (LinkPreview, VideoEmbed, SpoilerText, MessageContent, CodeBlock) are now in @/components/chat/MessageContent.tsx --- */


/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

/** Map common MIME types to file extensions (for blossom URL suffix) */
function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
    'video/x-msvideo': '.avi', 'video/x-matroska': '.mkv',
    'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
    'audio/flac': '.flac', 'audio/aac': '.aac', 'audio/mp4': '.m4a',
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/bmp': '.bmp',
  }
  return map[mime] || ''
}

/** Compute SHA-256 hex hash of an ArrayBuffer using Web Crypto */
async function hashBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function BlobMedia({ servers, hash, ext, type, className, tag, encryption }: {
  servers: string[]; hash: string; ext: string; type: string; className?: string; tag: 'video' | 'audio'
  encryption?: { algorithm: string; key: string; nonce: string; originalHash: string }
}) {
  // ── Encrypted path: download → decrypt → blob URL ──
  const fakeAtt = useMemo(() => ({ hash, type, name: '', size: 0, encryption }), [hash, type, encryption])
  const decrypted = useDecryptedMedia(fakeAtt, servers)

  if (encryption) {
    if (decrypted.loading) {
      return (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border border-border/50 bg-secondary/30 ${tag === 'video' ? 'max-w-[400px]' : 'max-w-[340px]'}`}>
          <Lock size={14} className="text-emerald-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="inline-block w-3 h-3 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
              Decrypting {tag}… {decrypted.progress > 0 ? `${decrypted.progress}%` : ''}
            </div>
          </div>
        </div>
      )
    }
    if (decrypted.error || !decrypted.src) {
      return (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-destructive/30 bg-destructive/10 max-w-[400px]">
          <AlertTriangle size={14} className="text-destructive shrink-0" />
          <span className="text-xs text-muted-foreground">{decrypted.error || 'Failed to decrypt'}</span>
        </div>
      )
    }
    // Decrypted — render from blob URL
    if (tag === 'video') {
      return (
        <div className="relative inline-block max-w-[400px] group">
          <video src={decrypted.src} controls className={className || ''} />
          <div className="absolute top-1.5 right-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/30 text-[9px] text-emerald-400 font-medium opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            <Lock size={8} /> Encrypted
          </div>
        </div>
      )
    }
    return (
      <div className="relative inline-block group">
        <CustomAudioPlayer src={decrypted.src} className={className} />
        <div className="absolute -top-1.5 right-1 flex items-center gap-0.5 px-1 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/30 text-[8px] text-emerald-400 font-medium opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <Lock size={7} />
        </div>
      </div>
    )
  }

  // ── Unencrypted path (original logic) ──
  const [currentIdx, setCurrentIdx] = useState(0)
  const [verified, setVerified] = useState<import('@/hooks/useBlossomMedia').VerificationStatus>('pending')
  const [errorState, setErrorState] = useState<false | 'not-found'>(false)
  const cancelRef = useRef(false)

  const buildSrc = useCallback((idx: number) => {
    if (idx >= servers.length) return ''
    const baseUrl = servers[idx].replace(/\/+$/, '')
    return `${baseUrl}/${hash}${ext}`
  }, [servers, hash, ext])

  const currentSrc = buildSrc(currentIdx)

  // Background hash verification
  useEffect(() => {
    cancelRef.current = false
    let hadTampered = false

    const verify = async () => {
      for (let i = 0; i < servers.length; i++) {
        if (cancelRef.current) return
        const baseUrl = servers[i].replace(/\/+$/, '')
        const srcUrl = `${baseUrl}/${hash}${ext}`

        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 15000)
          const res = await fetch(srcUrl, { signal: controller.signal })
          clearTimeout(timer)
          if (!res.ok) continue

          const blob = await res.blob()
          if (cancelRef.current) return

          const actualHash = await hashBlob(blob)
          if (actualHash === hash) {
            if (!cancelRef.current) {
              if (i !== currentIdx) setCurrentIdx(i)
              setVerified('verified')
            }
            return
          } else {
            console.warn(`⚠ Blossom hash mismatch from ${baseUrl}: expected ${hash}, got ${actualHash}`)
            hadTampered = true
          }
        } catch { /* try next */ }
      }
      if (!cancelRef.current) {
        setVerified(hadTampered ? 'tampered' : 'pending')
        if (!hadTampered) setErrorState('not-found')
      }
    }

    verify()
    return () => { cancelRef.current = true }
  }, [servers, hash, ext])

  // Handle native media error — try next server
  const handleError = useCallback(() => {
    if (currentIdx + 1 < servers.length) {
      setCurrentIdx(currentIdx + 1)
    }
  }, [currentIdx, servers.length])

  if (errorState === 'not-found' && !currentSrc) {
    const fallbackUrl = `${servers[0]?.replace(/\/+$/, '') || ''}/${hash}${ext}`
    return (
      <div className="flex flex-col items-center gap-1 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/30 max-w-[400px]">
        <span className="text-xs text-muted-foreground">File not found on any server</span>
        <a href={fallbackUrl} target="_blank" rel="noopener noreferrer" className="text-primary text-xs hover:underline">
          ⬇ Try direct download
        </a>
      </div>
    )
  }

  const [mediaLoaded, setMediaLoaded] = useState(false)
  const isMediaLoading = !mediaLoaded

  if (tag === 'video') {
    return (
      <div className="relative inline-block max-w-[400px]">
        <video
          src={currentSrc}
          controls
          className={className || ''}
          preload="none"
          onError={handleError}
        />
        {verified !== 'verified' && (
          <VerificationBadge
            verified={verified}
            expectedHash={hash}
            servers={servers}
            ext={ext}
            onRecovered={(blobUrl: string) => { setVerified('verified') }}
          />
        )}
      </div>
    )
  }

  return (
    <div className="relative inline-block w-full">
      {/* Shimmer skeleton while audio loads */}
      {isMediaLoading && (
        <div className="media-skeleton" style={{ width: 300, height: 44 }} />
      )}
      <div className={`transition-opacity duration-300 ${mediaLoaded ? 'opacity-100' : 'opacity-0 h-0 overflow-hidden'}`}>
        <CustomAudioPlayer src={currentSrc} className={className} preload="metadata" onError={handleError} onLoadedData={() => setMediaLoaded(true)} />
      </div>
      {mediaLoaded && verified !== 'verified' && (
        <VerificationBadge
          verified={verified}
          expectedHash={hash}
          servers={servers}
          ext={ext}
          onRecovered={(blobUrl: string) => { setVerified('verified') }}
          size="sm"
        />
      )}
    </div>
  )
}

/** BlobImage — image with optimistic render + background SHA-256 hash verification */
function BlobImage({ servers, hash, ext, type, className, wrapperClassName, alt, onClick, encryption }: {
  servers: string[]; hash: string; ext: string; type: string; className?: string; wrapperClassName?: string; alt?: string
  onClick?: () => void
  encryption?: { algorithm: string; key: string; nonce: string; originalHash: string }
}) {
  // ── Encrypted path: download → decrypt → blob URL ──
  const fakeAtt = useMemo(() => ({ hash, type, name: '', size: 0, encryption }), [hash, type, encryption])
  const decrypted = useDecryptedMedia(fakeAtt, servers)

  if (encryption) {
    if (decrypted.loading) {
      return (
        <div className={wrapperClassName || "relative inline-block max-w-[400px]"}>
          <div className="flex items-center gap-2 px-3 py-4 rounded-lg border border-border/50 bg-secondary/30" style={{ minHeight: 100 }}>
            <Lock size={14} className="text-emerald-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="inline-block w-3 h-3 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
                Decrypting image… {decrypted.progress > 0 ? `${decrypted.progress}%` : ''}
              </div>
            </div>
          </div>
        </div>
      )
    }
    if (decrypted.error || !decrypted.src) {
      return (
        <div className={wrapperClassName || "relative inline-block max-w-[400px]"}>
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-destructive/30 bg-destructive/10">
            <AlertTriangle size={14} className="text-destructive shrink-0" />
            <span className="text-xs text-muted-foreground">{decrypted.error || 'Failed to decrypt'}</span>
          </div>
        </div>
      )
    }
    // Decrypted — render from blob URL
    return (
      <div className={`${wrapperClassName || "relative inline-block max-w-[400px]"} group`}>
        <img
          src={decrypted.src}
          alt={alt || ''}
          className={className || ''}
          onClick={onClick}
        />
        <div className="absolute top-1.5 right-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/30 text-[9px] text-emerald-400 font-medium opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <Lock size={8} /> Encrypted
        </div>
      </div>
    )
  }

  // ── Unencrypted path (original logic) ──
  const [currentIdx, setCurrentIdx] = useState(0)
  const [verified, setVerified] = useState<import('@/hooks/useBlossomMedia').VerificationStatus>('pending')
  const [errorState, setErrorState] = useState<false | 'not-found'>(false)
  const cancelRef = useRef(false)

  const buildSrc = useCallback((idx: number) => {
    if (idx >= servers.length) return ''
    const baseUrl = servers[idx].replace(/\/+$/, '')
    return `${baseUrl}/${hash}${ext}`
  }, [servers, hash, ext])

  const currentSrc = buildSrc(currentIdx)

  // Background hash verification
  useEffect(() => {
    cancelRef.current = false
    let hadTampered = false

    const verify = async () => {
      for (let i = 0; i < servers.length; i++) {
        if (cancelRef.current) return
        const baseUrl = servers[i].replace(/\/+$/, '')
        const srcUrl = `${baseUrl}/${hash}${ext}`

        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 15000)
          const res = await fetch(srcUrl, { signal: controller.signal })
          clearTimeout(timer)
          if (!res.ok) continue

          const blob = await res.blob()
          if (cancelRef.current) return

          const actualHash = await hashBlob(blob)
          if (actualHash === hash) {
            if (!cancelRef.current) {
              if (i !== currentIdx) setCurrentIdx(i)
              setVerified('verified')
            }
            return
          } else {
            console.warn(`⚠ Blossom image hash mismatch from ${baseUrl}: expected ${hash}, got ${actualHash}`)
            hadTampered = true
          }
        } catch { /* try next */ }
      }
      if (!cancelRef.current) {
        setVerified(hadTampered ? 'tampered' : 'pending')
        if (!hadTampered) setErrorState('not-found')
      }
    }

    verify()
    return () => { cancelRef.current = true }
  }, [servers, hash, ext])

  // Handle <img> load error — try next server
  const handleError = useCallback(() => {
    if (currentIdx + 1 < servers.length) {
      setCurrentIdx(currentIdx + 1)
    }
  }, [currentIdx, servers.length])

  if (errorState === 'not-found' && !currentSrc) {
    const fallbackUrl = `${servers[0]?.replace(/\/+$/, '') || ''}/${hash}${ext}`
    return (
      <div className="flex flex-col items-center gap-1 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/30 max-w-[400px]">
        <span className="text-xs text-muted-foreground">Image not found on any server</span>
        <a href={fallbackUrl} target="_blank" rel="noopener noreferrer" className="text-primary text-xs hover:underline">
          ⬇ Try direct download
        </a>
      </div>
    )
  }

  const [imgLoaded, setImgLoaded] = useState(false)
  const [imgError, setImgError] = useState(false)
  const isImgLoading = !imgLoaded && !imgError

  return (
    <div className={wrapperClassName || "relative inline-block max-w-[400px]"}>
      {/* Shimmer skeleton while image loads */}
      {isImgLoading && (
        <div className="media-skeleton" style={wrapperClassName ? { width: '100%', height: '100%' } : { minHeight: 160, width: 400, maxWidth: '100%' }} />
      )}
      {imgError && (
        <div className={`rounded-lg bg-secondary/40 border border-border/50 flex items-center justify-center text-xs text-muted-foreground/60 py-6 ${wrapperClassName ? 'w-full h-full' : 'max-w-[400px]'}`}>
          Failed to load image
        </div>
      )}
      <img
        src={currentSrc}
        alt={alt || ''}
        className={`${className || ''} transition-opacity duration-300 ${imgLoaded ? 'opacity-100' : 'opacity-0 h-0 overflow-hidden'}`}
        onClick={onClick}
        onLoad={() => { setImgLoaded(true); setImgError(false) }}
        onError={() => { setImgError(true); handleError() }}
      />
      {imgLoaded && verified !== 'verified' && (
        <VerificationBadge
          verified={verified}
          expectedHash={hash}
          servers={servers}
          ext={ext}
          onRecovered={(blobUrl: string) => { setVerified('verified') }}
        />
      )}
    </div>
  )
}

/* ────────────── BlobFile — Generic file download with progress + hash verification ────────────── */

function BlobFile({ servers, hash, ext, name, size, type, encryption }: {
  servers: string[]; hash: string; ext: string; name: string; size: number; type: string
  encryption?: { algorithm: string; key: string; nonce: string; originalHash: string }
}) {
  const [state, setState] = useState<'idle' | 'downloading' | 'verifying' | 'decrypting' | 'complete' | 'tampered' | 'error'>('idle')
  const [progress, setProgress] = useState({ loaded: 0, total: 0, percent: 0, speed: 0 })
  const [serverIdx, setServerIdx] = useState(0)
  const [showRecovery, setShowRecovery] = useState(false)
  const cancelRef = useRef<AbortController | null>(null)
  const blobRef = useRef<Blob | null>(null)

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const formatSpeed = (bps: number) => {
    if (bps < 1024) return `${Math.round(bps)} B/s`
    if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
    return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
  }

  const triggerBrowserDownload = (blob: Blob) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name || `${hash.slice(0, 12)}${ext}`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const handleDownload = async () => {
    setState('downloading')
    setProgress({ loaded: 0, total: size || 0, percent: 0, speed: 0 })

    for (let i = serverIdx; i < servers.length; i++) {
      const baseUrl = servers[i].replace(/\/+$/, '')
      const srcUrl = `${baseUrl}/${hash}${ext}`
      setServerIdx(i)

      const controller = new AbortController()
      cancelRef.current = controller

      try {
        const startTime = Date.now()
        const res = await fetch(srcUrl, { signal: controller.signal })
        if (!res.ok) continue

        const contentLength = res.headers.get('content-length')
        const total = contentLength ? parseInt(contentLength, 10) : (size || 0)

        if (!res.body) {
          // No streaming — fallback to blob
          const blob = await res.blob()
          setProgress({ loaded: blob.size, total: blob.size, percent: 100, speed: 0 })
          setState('verifying')

          const actualHash = await hashBlob(blob)
          if (actualHash === hash) {
            if (encryption) {
              setState('decrypting')
              const { decryptFile } = await import('@/lib/crypto/fileEncryption')
              const cipherBytes = new Uint8Array(await blob.arrayBuffer())
              const plainBytes = await decryptFile(cipherBytes, encryption.key, encryption.nonce)
              const plainBlob = new Blob([plainBytes.slice() as Uint8Array<ArrayBuffer>], { type: type || 'application/octet-stream' })
              blobRef.current = plainBlob
              setState('complete')
              triggerBrowserDownload(plainBlob)
            } else {
              blobRef.current = blob
              setState('complete')
              triggerBrowserDownload(blob)
            }
            return
          } else {
            blobRef.current = blob
            setState('tampered')
            return
          }
        }

        // Streaming download with progress
        const reader = res.body.getReader()
        const chunks: BlobPart[] = []
        let loaded = 0

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          loaded += value.length
          const elapsed = (Date.now() - startTime) / 1000
          const speed = elapsed > 0 ? loaded / elapsed : 0
          const percent = total > 0 ? Math.round((loaded / total) * 100) : 0
          setProgress({ loaded, total, percent, speed })
        }

        // Assemble blob
        const blob = new Blob(chunks, { type: type || 'application/octet-stream' })
        setState('verifying')

        // Hash verify
        const actualHash = await hashBlob(blob)
        if (actualHash === hash) {
          if (encryption) {
            setState('decrypting')
            const { decryptFile } = await import('@/lib/crypto/fileEncryption')
            const cipherBytes = new Uint8Array(await blob.arrayBuffer())
            const plainBytes = await decryptFile(cipherBytes, encryption.key, encryption.nonce)
            const plainBlob = new Blob([plainBytes.slice() as Uint8Array<ArrayBuffer>], { type: type || 'application/octet-stream' })
            blobRef.current = plainBlob
            setState('complete')
            triggerBrowserDownload(plainBlob)
          } else {
            blobRef.current = blob
            setState('complete')
            triggerBrowserDownload(blob)
          }
          return
        } else {
          console.warn(`⚠ Blossom file hash mismatch from ${baseUrl}: expected ${hash}, got ${actualHash}`)
          blobRef.current = blob
          // Try next server
          if (i + 1 < servers.length) {
            setState('downloading')
            continue
          }
          setState('tampered')
          return
        }
      } catch (err) {
        if (controller.signal.aborted) {
          setState('idle')
          return
        }
        // Try next server
        if (i + 1 < servers.length) continue
        setState('error')
        return
      }
    }

    setState('error')
  }

  const handleCancel = () => {
    cancelRef.current?.abort()
    setState('idle')
  }

  // SVG circular progress
  const circleR = 18
  const circleC = 2 * Math.PI * circleR
  const dashOffset = circleC * (1 - progress.percent / 100)

  if (state === 'idle') {
    return (
      <button
        onClick={handleDownload}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-secondary/50 hover:bg-secondary transition-colors max-w-[300px] group cursor-pointer"
      >
        {encryption ? <Lock size={16} className="text-emerald-400 shrink-0" /> : <FileIcon size={18} className="text-muted-foreground shrink-0" />}
        <div className="min-w-0 flex-1 text-left">
          <p className="text-sm text-foreground truncate">{name}</p>
          <p className="text-[10px] text-muted-foreground">{formatSize(size)}{encryption ? ' • Encrypted' : ''}</p>
        </div>
        <Download size={16} className="text-muted-foreground group-hover:text-foreground shrink-0" />
      </button>
    )
  }

  if (state === 'downloading' || state === 'verifying' || state === 'decrypting') {
    return (
      <div className="inline-flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-secondary/50 max-w-[340px]">
        {/* Circular progress */}
        <div className="relative shrink-0">
          <svg width="44" height="44" viewBox="0 0 44 44" className="transform -rotate-90">
            {/* Background circle */}
            <circle cx="22" cy="22" r={circleR} fill="none" stroke="currentColor" strokeWidth="3"
              className="text-border" />
            {/* Progress arc */}
            <circle cx="22" cy="22" r={circleR} fill="none" stroke="currentColor" strokeWidth="3"
              className={state === 'verifying' ? 'text-amber-400' : state === 'decrypting' ? 'text-emerald-400' : 'text-primary'}
              strokeDasharray={circleC} strokeDashoffset={dashOffset}
              strokeLinecap="round"
              style={{ transition: 'stroke-dashoffset 0.3s ease' }} />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-[10px] font-medium text-foreground">
            {state === 'verifying' ? '✓' : state === 'decrypting' ? '🔓' : `${progress.percent}%`}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground truncate">{name}</p>
          <p className="text-[10px] text-muted-foreground">
            {state === 'verifying' ? (
              'Verifying integrity…'
            ) : state === 'decrypting' ? (
              'Decrypting…'
            ) : (
              <>{formatSize(progress.loaded)} / {formatSize(progress.total)}  •  {formatSpeed(progress.speed)}</>
            )}
          </p>
          {servers.length > 1 && serverIdx > 0 && (
            <p className="text-[10px] text-muted-foreground/60">Server {serverIdx + 1} of {servers.length}</p>
          )}
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={handleCancel} className="text-muted-foreground hover:text-destructive cursor-pointer transition-colors shrink-0">
              <X size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">Cancel</TooltipContent>
        </Tooltip>
      </div>
    )
  }

  if (state === 'complete') {
    return (
      <div className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 max-w-[300px]">
        <Check size={16} className="text-emerald-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground truncate">{name}</p>
          <p className="text-[10px] text-emerald-400">{encryption ? 'Decrypted & downloaded ✓' : 'Downloaded & verified ✓'}</p>
        </div>
      </div>
    )
  }

  if (state === 'tampered') {
    return (
      <>
        <div className="inline-flex flex-col gap-2 px-3 py-2.5 rounded-lg border border-red-500/30 bg-red-500/10 max-w-[340px]">
          <div className="flex items-center gap-2">
            <ShieldAlert size={16} className="text-red-400 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-foreground truncate">{name}</p>
              <p className="text-[10px] text-red-400">Hash mismatch — file may be tampered</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowRecovery(true)}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-secondary/50 hover:bg-secondary text-xs text-foreground cursor-pointer transition-colors"
            >
              <Search size={12} /> Try other servers
            </button>
            <button
              onClick={() => {
                if (blobRef.current) triggerBrowserDownload(blobRef.current)
              }}
              className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border border-red-500/30 bg-red-500/5 hover:bg-red-500/15 text-xs text-red-400 cursor-pointer transition-colors"
            >
              <Download size={12} /> Download anyway
            </button>
          </div>
          <p className="text-[9px] text-muted-foreground/50 text-center">Downloading unverified files is highly unrecommended</p>
        </div>

        {showRecovery && (
          <HashRecoveryModal
            expectedHash={hash}
            servers={servers}
            ext={ext}
            onClose={() => setShowRecovery(false)}
            onRecovered={(blobUrl: string) => {
              // Fetch the blob from the URL and trigger download
              fetch(blobUrl).then(r => r.blob()).then(blob => {
                triggerBrowserDownload(blob)
                setState('complete')
              })
              setShowRecovery(false)
            }}
          />
        )}
      </>
    )
  }

  // error
  return (
    <div className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-secondary/50 max-w-[300px]">
      <AlertTriangle size={16} className="text-muted-foreground shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground truncate">{name}</p>
        <p className="text-[10px] text-muted-foreground">Download failed</p>
      </div>
      <button
        onClick={() => { setServerIdx(0); handleDownload() }}
        className="text-primary text-xs hover:underline cursor-pointer shrink-0"
      >
        Retry
      </button>
    </div>
  )
}

/* ────────────── GIF Image with skeleton ────────────── */

function GifImg({ src, alt, nsfw, className, style }: { src: string; alt: string; nsfw?: boolean; className?: string; style?: React.CSSProperties }) {
  // Route through blossom media so a GIF whose origin server is down/CORS-blocked
  // fails over to the other configured servers instead of showing a broken image
  // (previously a bare <img> with no onError → infinite skeleton on any failure).
  const blossom = useBlossomMedia(src)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const w = (style?.maxWidth as number) || 220
  const h = (style?.maxHeight as number) || 220

  // Reset load/error state on src change or blossom failover to a new server.
  useEffect(() => { setLoaded(false); setError(false) }, [src, blossom.src])

  if (blossom.error === 'not-found' || error) {
    return (
      <span
        className="inline-flex items-center justify-center rounded-lg bg-secondary/40 border border-border/50 text-[11px] text-muted-foreground/60 px-3"
        style={{ width: w, height: Math.min(h, 80), maxWidth: '100%' }}
      >
        GIF failed to load
      </span>
    )
  }

  const resolvedSrc = blossom.src || src

  return (
    <>
      {!loaded && (
        <span className="media-skeleton inline-block" style={{ width: w, height: h, maxWidth: '100%' }} />
      )}
      <img
        src={resolvedSrc}
        data-media-src={shareableMediaUrl(blossom, src)}
        alt={alt}
        className={`${className || ''} ${!loaded ? 'opacity-0 h-0 overflow-hidden block' : ''}`}
        style={style}
        onLoad={() => { setLoaded(true); setError(false) }}
        onError={() => { blossom.onImgError(); setError(true) }}
      />
    </>
  )
}

/* ────────────── GIF Star Overlay (with publish spinner) ────────────── */

function GifStarOverlay({ att, ext, url, imgIdx, matchingGTag, allServers, setGalleryIndex, setFavModalUrl, inGrid }: {
  att: Attachment
  ext: string
  url: string
  imgIdx: number
  matchingGTag: [string, string, string] | undefined
  allServers: string[]
  setGalleryIndex: (i: number) => void
  setFavModalUrl: (url: string) => void
  inGrid?: boolean
}) {
  // Subscribe directly so re-renders from parent don't reset our state
  const isFav = useGifStore((s) => s.favorites.some((f) => f.url.includes(att.hash)))
  const [publishing, setPublishing] = useState(false)

  const handleToggleFav = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (publishing) return
    setPublishing(true)
    const started = Date.now()
    try {
      if (isFav) {
        const store = useGifStore.getState()
        const { signer: s, privateKey: pk } = useUserStore.getState()
        const updated = store.favorites.filter((f) => !f.url.includes(att.hash))
        store.setFavorites(updated)
        await publishGifFavorites(updated, s, pk)
      } else if (matchingGTag) {
        const store = useGifStore.getState()
        const { signer: s, privateKey: pk } = useUserStore.getState()
        const [name, gUrl, nsfw] = matchingGTag
        const updated = [...store.favorites, { name: name || '', url: gUrl, nsfw: nsfw === 'nsfw', tagged: true }]
        store.setFavorites(updated)
        await publishGifFavorites(updated, s, pk)
      } else {
        setFavModalUrl(url)
        setPublishing(false)
        return
      }
    } catch {
      // silently ignore publish failures
    }
    // Ensure spinner is visible for at least 800ms so user sees feedback
    const elapsed = Date.now() - started
    if (elapsed < 800) await new Promise((r) => setTimeout(r, 800 - elapsed))
    setPublishing(false)
  }

  return (
    <div className={inGrid ? "relative group/gif w-full h-full" : "relative group/gif inline-block w-fit"}>
      <BlobImage
        servers={allServers}
        hash={att.hash}
        ext={ext}
        type={att.type}
        alt={att.name}
        wrapperClassName={inGrid ? "relative w-full h-full" : undefined}
        className={inGrid
          ? "w-full h-full object-cover cursor-pointer transition-all"
          : "max-w-[400px] max-h-[300px] rounded-lg border border-transparent hover:border-border object-contain cursor-pointer transition-all"
        }
        onClick={() => setGalleryIndex(imgIdx >= 0 ? imgIdx : 0)}
      />
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleToggleFav}
              disabled={publishing}
              className={`absolute top-1 right-1 w-6 h-6 rounded-full flex items-center justify-center transition-all cursor-pointer ${publishing
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

/* ────────────── Content inline image grouping ────────────── */
/* Shared utilities imported from '@/components/chat/ContentMediaGrouping' */

/* ────────────── Attachment Renderer ────────────── */

/** Groups consecutive image/GIF attachments together, breaking on video/audio/file */
type AttachmentBlock =
  | { kind: 'image-group'; items: { att: Attachment; ext: string; url: string; imgIdx: number; isGif: boolean; matchingGTag?: [string, string, string] }[] }
  | { kind: 'video'; att: Attachment; ext: string }
  | { kind: 'audio'; att: Attachment; ext: string }
  | { kind: 'file'; att: Attachment; ext: string }

function groupAttachments(attachments: Attachment[], baseUrl: string, imageUrls: string[], gifTags?: [string, string, string][]): AttachmentBlock[] {
  const blocks: AttachmentBlock[] = []
  let currentImages: Extract<AttachmentBlock, { kind: 'image-group' }>['items'] = []
  let imageCounter = 0

  const flushImages = () => {
    if (currentImages.length > 0) {
      blocks.push({ kind: 'image-group', items: [...currentImages] })
      currentImages = []
    }
  }

  for (const att of attachments) {
    const ext = mimeToExt(att.type)
    const url = `${baseUrl}/${att.hash}${ext}`

    if (att.type.startsWith('image/')) {
      // Use running counter instead of indexOf — encrypted images have
      // blob URLs in imageUrls but blossom URLs here, so indexOf fails
      const imgIdx = imageCounter
      imageCounter++
      const isGif = att.type === 'image/gif'
      const matchingGTag = isGif && gifTags
        ? gifTags.find(([, gUrl]) => gUrl.includes(att.hash))
        : undefined
      currentImages.push({ att, ext, url, imgIdx, isGif, matchingGTag })
    } else if (att.type.startsWith('video/')) {
      flushImages()
      blocks.push({ kind: 'video', att, ext })
    } else if (att.type.startsWith('audio/')) {
      flushImages()
      blocks.push({ kind: 'audio', att, ext })
    } else {
      flushImages()
      blocks.push({ kind: 'file', att, ext })
    }
  }

  flushImages()
  return blocks
}

function AttachmentRenderer({ attachments, hubDTag, gifTags }: { attachments: Attachment[]; hubDTag: string; gifTags?: [string, string, string][] }) {
  const hub = useHubStore((s) => s.hubs[hubDTag])
  const hubServers = hub?.blossomServers || []
  // Merge hub servers with global defaults, deduplicated
  const allServers = useMemo(() => {
    const defaults = ['https://blossom.primal.net', 'https://blossom.band', 'https://blossom.nostr.hu', 'https://cdn.sovbit.host', 'https://blossom.data.haus']
    const merged = [...hubServers]
    for (const d of defaults) {
      if (!merged.includes(d)) merged.push(d)
    }
    return merged
  }, [hubServers])
  const baseUrl = allServers[0]?.replace(/\/+$/, '') || 'https://blossom.primal.net'
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null)
  const [favModalUrl, setFavModalUrl] = useState<string | null>(null)

  // Collect all image URLs for gallery navigation.
  // For encrypted images, use the decrypted blob URL from cache (BlobImage
  // already decrypted it before the user can click to open the gallery).
  // Re-evaluated when galleryIndex changes so the cache lookup picks up
  // blob URLs that were populated after the initial render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const imageUrls = useMemo(() => attachments
    .filter((att) => att.type.startsWith('image/'))
    .map((att) => {
      if (att.encryption) {
        return getDecryptedBlobUrl(att.hash) || `${baseUrl}/${att.hash}${mimeToExt(att.type)}`
      }
      return `${baseUrl}/${att.hash}${mimeToExt(att.type)}`
    }), [attachments, baseUrl, galleryIndex])

  // Group consecutive image attachments
  const blocks = useMemo(() => groupAttachments(attachments, baseUrl, imageUrls, gifTags), [attachments, baseUrl, imageUrls, gifTags])

  return (
    <div className="flex flex-col gap-2 mt-1.5">
      {blocks.map((block, blockIdx) => {
        if (block.kind === 'image-group') {
          const { items } = block

          // Single image — render full-width
          if (items.length === 1) {
            const { att, ext, url, imgIdx, isGif, matchingGTag } = items[0]
            if (isGif) {
              return (
                <GifStarOverlay
                  key={att.hash}
                  att={att}
                  ext={ext}
                  url={url}
                  imgIdx={imgIdx}
                  matchingGTag={matchingGTag}
                  allServers={allServers}
                  setGalleryIndex={setGalleryIndex}
                  setFavModalUrl={setFavModalUrl}
                />
              )
            }
            return (
              <BlobImage
                key={att.hash}
                servers={allServers}
                hash={att.hash}
                ext={ext}
                type={att.type}
                alt={att.name}
                className="max-w-[400px] max-h-[300px] rounded-lg border border-transparent hover:border-border object-contain cursor-pointer transition-all"
                onClick={() => setGalleryIndex(imgIdx >= 0 ? imgIdx : 0)}
                encryption={att.encryption}
              />
            )
          }

          // Multiple images — 2-column grid with equal row heights
          return (
            <div key={`img-group-${blockIdx}`} className="grid grid-cols-2 gap-1 rounded-lg overflow-hidden max-w-[500px]" style={{ gridAutoRows: '200px' }}>
              {items.map(({ att, ext, url, imgIdx, isGif, matchingGTag }) => {
                if (isGif) {
                  return (
                    <div key={att.hash} className="relative overflow-hidden">
                      <GifStarOverlay
                        att={att}
                        ext={ext}
                        url={url}
                        imgIdx={imgIdx}
                        matchingGTag={matchingGTag}
                        allServers={allServers}
                        setGalleryIndex={setGalleryIndex}
                        setFavModalUrl={setFavModalUrl}
                        inGrid
                      />
                    </div>
                  )
                }
                return (
                  <div key={att.hash} className="relative overflow-hidden">
                    <BlobImage
                      servers={allServers}
                      hash={att.hash}
                      ext={ext}
                      type={att.type}
                      alt={att.name}
                      wrapperClassName="relative w-full h-full"
                      className="w-full h-full object-cover cursor-pointer transition-all"
                      onClick={() => setGalleryIndex(imgIdx >= 0 ? imgIdx : 0)}
                      encryption={att.encryption}
                    />
                  </div>
                )
              })}
            </div>
          )
        }

        if (block.kind === 'video') {
          return (
            <BlobMedia
              key={block.att.hash}
              servers={allServers}
              hash={block.att.hash}
              ext={block.ext}
              type={block.att.type}
              tag="video"
              className="max-w-[400px] max-h-[300px] rounded-lg border border-transparent hover:border-border transition-colors"
              encryption={block.att.encryption}
            />
          )
        }

        if (block.kind === 'audio') {
          return (
            <div key={block.att.hash} className="flex flex-col gap-2 px-2 py-1.5 rounded-lg border border-border/50 bg-secondary/30">
              <span className="text-xs text-muted-foreground truncate">{block.att.name}</span>
              <BlobMedia
                servers={allServers}
                hash={block.att.hash}
                ext={block.ext}
                type={block.att.type}
                tag="audio"
                className="h-8"
                encryption={block.att.encryption}
              />
            </div>
          )
        }

        // file
        return (
          <BlobFile
            key={block.att.hash}
            servers={allServers}
            hash={block.att.hash}
            ext={block.ext}
            name={block.att.name}
            size={block.att.size}
            type={block.att.type}
            encryption={block.att.encryption}
          />
        )
      })}

      {/* Image gallery lightbox */}
      {galleryIndex !== null && (
        <ImageGallery
          images={imageUrls}
          startIndex={galleryIndex}
          onClose={() => setGalleryIndex(null)}
        />
      )}

      {/* GIF Favorite modal for untagged GIFs */}
      {favModalUrl && (
        <GifFavoriteModal gifUrl={favModalUrl} onClose={() => setFavModalUrl(null)} />
      )}
    </div>
  )
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Date Separator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

function DateSeparator({ timestamp }: { timestamp: number }) {
  return (
    <div className="flex items-center gap-3 my-4">
      <div className="flex-1 h-px bg-border" />
      <span className="text-xs text-muted-foreground font-medium select-none">
        {formatDaySeparator(timestamp)}
      </span>
      <div className="flex-1 h-px bg-border" />
    </div>
  )
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Reply Preview (shown above replied messages) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

function ReplyPreview({ repliedMessage, getProfile, onScrollTo }: {
  repliedMessage: ChatMessage
  getProfile: (pubkey: string) => any
  onScrollTo: (messageId: string) => void
}) {
  const profile = getProfile(repliedMessage.pubkey)
  const name = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(repliedMessage.pubkey))
  const avatarUrl = profile?.picture
  const isMobile = useMobile()

  return (
    <button
      onClick={() => onScrollTo(repliedMessage.id)}
      className={`flex ${isMobile ? 'gap-2' : 'gap-3'} px-2 -mx-2 items-end cursor-pointer hover:opacity-80 transition-opacity w-full text-left`}
    >
      {/* Connector column matches the AVATAR width so the preview lines up with the message author name:
          w-10 for the desktop 40px avatar, w-6 for the mobile 24px inline avatar. */}
      <div className={`${isMobile ? 'w-6' : 'w-10'} shrink-0 flex`}>
        <div
          className="ml-auto border-l-2 border-t-2 border-muted-foreground/30 rounded-tl-md"
          style={{ width: isMobile ? 12 : 20, height: 10 }}
        />
      </div>
      {/* Preview content -- aligns with message content column */}
      <div className="flex items-center gap-1 min-w-0 pb-0.5">
        <Avatar className="h-4 w-4 shrink-0">
          {avatarUrl && <AvatarImage src={avatarUrl} alt={name} />}
          <AvatarFallback className="text-[8px] bg-primary/20 text-primary">
            {name.slice(0, 1).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <span className="text-xs font-semibold text-foreground/70 shrink-0">{name}</span>
        <span className="text-xs truncate text-muted-foreground/60">{(repliedMessage as any).isPoll ? 'Poll' : repliedMessage.content.slice(0, 60)}</span>
      </div>
    </button>
  )
}

/* ──────────────── Reaction Pills ──────────────── */

export function ReactionBar({ reactions, messageId, onAddReaction, rawReactions, onOpenProfile, children, disableCustomEmojis }: {
  reactions: Reaction[]
  messageId: string
  onAddReaction: (messageId: string, emoji: string, customUrl?: string) => void
  rawReactions?: import('@/stores/messageStore').StoredReaction[]
  onOpenProfile?: (pubkey: string) => void
  children?: React.ReactNode
  /** When true, custom emoji images are not rendered (shows :shortcode: text instead) */
  disableCustomEmojis?: boolean
}) {
  const [showPicker, setShowPicker] = useState(false)
  const [showReactionList, setShowReactionList] = useState(false)
  const addReactionBtnRef = useRef<HTMLButtonElement>(null)
  const { getProfile } = useProfileCache()

  // Convert StoredReaction[] to ReactionInfo[] for the modal
  // NOTE: Must be above the early return to preserve hook ordering
  const reactionInfos: ReactionInfo[] = useMemo(() => {
    if (!rawReactions) return []
    return rawReactions
      .filter((r) => r.decrypted !== false)
      .map((r) => ({
        eventId: r.eventId,
        pubkey: r.realPubkey ?? r.pubkey, // v2: display the real reactor R (wire author is P)
        emoji: r.emoji,
        emojiUrl: r.customUrl,
        createdAt: r.createdAt || 0,
        rawEvent: r.rawEvent,
      }))
  }, [rawReactions])

  const totalCount = reactionInfos.length

  if (reactions.length === 0 && !children) return null

  return (
    <TooltipProvider delayDuration={200}>
    <div className="flex items-center gap-1 mt-1 flex-wrap relative">
      {/* Add reaction button (left-most) — only show if there are reactions */}
      {reactions.length > 0 && (
        <div className="relative">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                ref={addReactionBtnRef}
                onClick={() => setShowPicker(!showPicker)}
                className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-secondary/50 border border-border text-muted-foreground hover:bg-secondary hover:text-foreground cursor-pointer transition-colors"
              >
                <Smile size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">Add a reaction</TooltipContent>
          </Tooltip>
          {showPicker && (
            <EmojiPickerPopover
              anchorRef={addReactionBtnRef}
              onClose={() => setShowPicker(false)}
              onSelect={(emoji, custom) => {
                onAddReaction(messageId, emoji, custom?.url)
                setShowPicker(false)
              }}
            />
          )}
        </div>
      )}
      {/* Total reaction count badge — clickable to view who reacted. Kept neutral
          (gray) so blue is reserved exclusively for "you reacted / click to remove",
          otherwise the view-reactions badge and a reacted pill look identical. */}
      {totalCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setShowReactionList(true)}
              className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-base cursor-pointer transition-colors border bg-secondary/50 border-border text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <Users size={15} />
              <span className="font-semibold">{totalCount}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">See who reacted</TooltipContent>
        </Tooltip>
      )}
      {reactions.map((r) => (
        <Tooltip key={r.emoji}>
          <TooltipTrigger asChild>
          <button
            onClick={() => onAddReaction(messageId, r.emoji, r.customUrl)}
            className={`inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-base cursor-pointer transition-colors border ${r.reacted
              ? 'bg-primary/20 border-primary/40 text-foreground'
              : 'bg-secondary/50 border-border text-muted-foreground hover:bg-secondary'
              }`}
          >
          <span>{(() => {
            if (!disableCustomEmojis && r.customUrl) return <img src={r.customUrl} alt={r.emoji} className="h-5 w-5 object-contain inline" />
            if (!disableCustomEmojis) {
              const scMatch = r.emoji.match(/^:([a-zA-Z0-9_-]+):$/)
              if (scMatch) {
                const entry = getEmojiMap().get(scMatch[1])
                if (entry) return <img src={entry.url} alt={r.emoji} className="h-5 w-5 object-contain inline" />
              }
            }
            // When disabled, show 'n/a' for custom emojis instead of raw :shortcode:
            if (disableCustomEmojis && (r.customUrl || /^:[a-zA-Z0-9_-]+:$/.test(r.emoji))) return 'n/a'
            return r.emoji
          })()}</span>
          <span className="font-medium">{r.count}</span>
          {r.pubkeys && r.pubkeys.length > 0 && (
            <TooltipProvider delayDuration={200}>
              <span className="inline-flex items-center -space-x-1 ml-0.5">
                {r.pubkeys.slice(0, 3).map((pk) => {
                  const p = getProfile(pk)
                  const name = p?.display_name || p?.name || truncateNpub(nip19.npubEncode(pk), 10)
                  return (
                    <Tooltip key={pk}>
                      <TooltipTrigger asChild>
                        <span className="w-5 h-5 rounded-full overflow-hidden border border-background bg-secondary inline-flex items-center justify-center text-[9px] font-semibold text-muted-foreground shrink-0">
                          {p?.picture
                            ? <img src={p.picture} alt="" className="w-full h-full object-cover" />
                            : name.slice(0, 1).toUpperCase()}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">{name}</TooltipContent>
                    </Tooltip>
                  )
                })}
              </span>
            </TooltipProvider>
          )}
          </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">{r.reacted ? 'Remove your reaction' : 'React'}</TooltipContent>
        </Tooltip>
      ))}
      {children}
      {/* Reaction List Modal */}
      {showReactionList && (
        <ReactionListModal
          open={showReactionList}
          onClose={() => setShowReactionList(false)}
          reactions={reactionInfos}
          onOpenProfile={onOpenProfile}
          disableCustomEmojis={disableCustomEmojis}
        />
      )}
    </div>
    </TooltipProvider>
  )
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Chat Message Row â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export interface ChatMessageRowProps {
  msg: ChatMessage
  hubDTag: string
  isGrouped: boolean
  isMine: boolean
  onOpenProfile: (pubkey: string) => void
  onEdit: (msg: ChatMessage) => void
  onReply: (msg: ChatMessage) => void
  onThreadReply: (msg: ChatMessage) => void
  onSaveEdit: (msg: ChatMessage, newText: string, removedAttachmentHashes?: Set<string>) => void
  editingId: string | null
  editText: string
  setEditText: (t: string) => void
  cancelEdit: () => void
  getProfile: (pubkey: string) => any
  reactions: Reaction[]
  rawReactions?: import('@/stores/messageStore').StoredReaction[]
  onAddReaction: (messageId: string, emoji: string, customUrl?: string) => void
  repliedMessage?: ChatMessage
  replyStatus?: 'not-found' | 'deleted'
  getProfileForReply: (pubkey: string) => any
  highlighted: boolean
  onScrollToMessage: (id: string) => void
  onTimeTravel?: (ref: string) => void
  onRequestDelete: () => void
  onViewRaw: (raw: string) => void
  hideThreadReply?: boolean
  hideReply?: boolean
  hidePin?: boolean
  canPublish: boolean
  channelId: string
  onReport?: (reportedPubkey: string, reportedMessageATag?: string, reportedMessagePreview?: string) => void
  onHideMessage?: () => void
  onUnhideMessage?: () => void
  isHidden?: boolean
  canHide?: boolean
  hiddenBy?: string
}

export function ChatMessageRow({
  msg, hubDTag, isGrouped, isMine, onOpenProfile, onEdit, onReply, onThreadReply, onSaveEdit,
  editingId, editText, setEditText, cancelEdit, getProfile,
  reactions, rawReactions, onAddReaction, repliedMessage, replyStatus, getProfileForReply,
  highlighted, onScrollToMessage, onTimeTravel, onRequestDelete, onViewRaw, hideThreadReply, hideReply, hidePin, canPublish, channelId, onReport,
  onHideMessage, onUnhideMessage, isHidden, canHide, hiddenBy,
}: ChatMessageRowProps) {
  const isMobile = useMobile()
  // Mobile grouped (secondary) messages have no left time slot, so the timestamp trails the message text
  // (added to MessageContent's suffix). Null for the full-header message (its time is in the header row)
  // and on desktop — so it's safe to drop into every suffix.
  const mobileGroupedTime = isMobile && isGrouped
    ? <span className="text-[10px] text-muted-foreground/50 ml-1.5 select-none align-baseline">{formatShortTime(msg.timestamp)}</span>
    : null
  const [showActions, setShowActions] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [nsfwRevealed, setNsfwRevealed] = useState(false)
  const [blockedRevealed, setBlockedRevealed] = useState(false)
  const [removedAttachmentHashes, setRemovedAttachmentHashes] = useState<Set<string>>(new Set())
  const rowRef = useRef<HTMLDivElement>(null)
  const emojiButtonRef = useRef<HTMLButtonElement>(null)

  const showNsfwPref = typeof window !== 'undefined' && localStorage.getItem('SHOW_NSFW') === 'true'
  const shouldBlurMsg = msg.nsfw && !showNsfwPref && !nsfwRevealed
  const [hiddenPreviewRevealed, setHiddenPreviewRevealed] = useState(false)

  // v2: the real author R. msg.pubkey is the on-wire pseudonym P — kept for event
  // coordinates/refs (zaps, replies, reports); everything identity-facing uses R.
  // For v1, realPubkey is undefined so authorKey === msg.pubkey (no-op).
  const authorKey = msg.realPubkey ?? msg.pubkey

  // Blocked user check (hooks must be called before any early return)
  const isBlockedUser = useBlockStore((s) => s.isBlocked)(authorKey)
  const hideBlockedCompletely = useBlockStore((s) => s.hideBlockedCompletely)
  const mutedWords = useBlockStore((s) => s.mutedWords)

  const shouldBlurBlocked = isBlockedUser && !blockedRevealed

  // Relay progress — dim own messages that haven't been accepted by any relay yet
  const relayPending = useMessageStore((s) => {
    const p = s.relayProgress[msg.id]
    return p && p.confirmed === 0
  })

  // Content media grouping — extract consecutive image URL groups from text
  const baseContent = msg.gifTags && msg.gifTags.length > 0
    ? msg.content.split('\n').filter((l: string) => !msg.gifTags!.some(([, u]: [string, string, string]) => l.trim() === u)).join('\n').trim()
    : msg.content
  const { groups: contentMediaGroups, strippedContent: contentForRender } = useMemo(
    () => (msg.decrypted && !msg.deleted && !shouldBlurBlocked && !shouldBlurMsg) ? extractContentMediaGroups(baseContent) : { groups: [], strippedContent: baseContent },
    [baseContent, msg.decrypted, msg.deleted, shouldBlurBlocked, shouldBlurMsg]
  )
  const allContentImages = useMemo(() => contentMediaGroups.flatMap(g => g.urls), [contentMediaGroups])
  const [contentGalleryIndex, setContentGalleryIndex] = useState<number | null>(null)
  const openContentGallery = useCallback((url: string) => {
    const idx = allContentImages.indexOf(url)
    setContentGalleryIndex(idx >= 0 ? idx : 0)
  }, [allContentImages])

  // Enforce attach_files, embed_links, and create_invite permissions per-author
  const rowHub = useHubStore((s) => s.hubs[hubDTag])
  const rowHubMembers = useHubStore((s) => s.hubMembers[hubDTag])
  const { authorCanAttach, authorCanEmbed, authorCanInvite } = useMemo(() => {
    if (!rowHub || authorKey === rowHub.creatorPubkey) return { authorCanAttach: true, authorCanEmbed: true, authorCanInvite: true }
    const authorPerms = getPermissionsForUser(rowHub, authorKey, rowHubMembers, channelId)
    return { authorCanAttach: authorPerms.attach_files, authorCanEmbed: authorPerms.embed_links, authorCanInvite: authorPerms.create_invite }
  }, [rowHub, rowHubMembers, authorKey, channelId])

  // Derive hub role names for mention rendering in MessageContent
  const hubRoleNames = useMemo(() => rowHub?.roles?.map((r: any) => r.name).filter(Boolean) || [], [rowHub])
  // Derive hub channels for #channel mention rendering in MessageContent
  const hubChannels = useMemo(() => rowHub?.channels?.map((c: any) => ({ channelId: c.channelId, name: c.name, type: c.type })) || [], [rowHub])

  // ── Mention highlight detection ──
  // Check if the current user is mentioned in this message (by @npub, @everyone, @here, or @roleName)
  const myPubkeyForMention = useUserStore((s) => s.pubkey)
  const isMentioned = useMemo(() => {
    if (!myPubkeyForMention || !msg.content || msg.deleted) return false
    const content = msg.content
    // 1. Direct @npub mention
    const myNpub = nip19.npubEncode(myPubkeyForMention)
    if (content.includes(`@${myNpub}`)) return true
    // 2. @everyone
    if (content.includes('@everyone')) return true
    // 3. @here
    if (content.includes('@here')) return true
    // 4. @roleName — check if user holds any mentioned role
    if (rowHub?.roles && rowHubMembers) {
      const myMember = rowHubMembers.find((m) => m.pubkey === myPubkeyForMention)
      if (myMember) {
        const myRoleIds = myMember.roles ? myMember.roles.split(',').map((r) => r.trim()).filter(Boolean) : []
        for (const role of rowHub.roles) {
          if (role.name === 'everyone') continue
          if (myRoleIds.includes(role.roleId) && content.includes(`@${role.name}`)) return true
        }
      }
    }
    return false
  }, [msg.content, msg.deleted, myPubkeyForMention, rowHub?.roles, rowHubMembers])

  // Whether a popover is pinned open (prevents mouse-leave dismiss)
  const [zapModalOpen, setZapModalOpen] = useState(false)
  const popoverOpen = showEmoji || showMenu || zapModalOpen

  // Click-outside to dismiss when a popover is open
  useEffect(() => {
    if (!popoverOpen) return
    const handler = (e: MouseEvent) => {
      // Never dismiss while zap modal is open (it's portaled outside the row)
      if (zapModalOpen) return
      // Check if click is inside the row
      if (rowRef.current && rowRef.current.contains(e.target as Node)) return
      // Check if click is inside a portal (emoji picker)
      const target = e.target as HTMLElement
      if (target.closest('.EmojiPickerReact') || target.closest('[class*="epr"]') || target.closest('[data-emoji-picker]') || target.closest('[data-emoji-picker-portal]')) return
      setShowActions(false)
      setShowEmoji(false)
      setShowMenu(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [popoverOpen, zapModalOpen])

  const handleMouseLeave = () => {
    // Don't dismiss if a popover is pinned open
    if (popoverOpen) return
    setShowActions(false)
  }

  const profile = getProfile(authorKey)
  const displayName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(authorKey))
  const avatarUrl = profile?.picture
  const isEditing = editingId === msg.id
  const editUnchanged = editText === msg.content && removedAttachmentHashes.size === 0

  // ── Early returns (AFTER all hooks) ──

  // Completely hide blocked users if setting enabled
  if (isBlockedUser && hideBlockedCompletely) return null

  // WoT filter — hide if score below threshold
  const wotHidden = useWotStore.getState().shouldHide(authorKey, 'hubChat')
  if (wotHidden) return null

  // Hidden message placeholder — non-privileged users see a minimal placeholder
  if (isHidden && !canHide) {
    return (
      <div className={`${isGrouped ? 'mt-0.5' : 'mt-4'} py-2 px-3 -mx-2 rounded-lg border border-border/40 bg-muted/30`}>
        <div className="flex items-center gap-2.5 text-muted-foreground/60">
          <div className="flex items-center justify-center w-6 h-6 rounded-full bg-muted/60 shrink-0">
            <EyeOff size={12} />
          </div>
          <span className="text-xs font-medium">Message hidden by moderator</span>
        </div>
      </div>
    )
  }

  // Hidden message — mod/creator collapsed view (click to reveal)
  if (isHidden && canHide && !hiddenPreviewRevealed) {
    return (
      <div className={`${isGrouped ? 'mt-0.5' : 'mt-4'} py-2 px-3 -mx-2 rounded-lg border border-amber-500/30 bg-amber-500/5`}>
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-6 h-6 rounded-full bg-amber-500/15 shrink-0">
            <EyeOff size={12} className="text-amber-400" />
          </div>
          <span className="text-xs font-medium text-amber-400">Message hidden by {hiddenBy || 'moderator'}</span>
          <button
            onClick={() => setHiddenPreviewRevealed(true)}
            className="ml-auto text-[11px] px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors cursor-pointer font-medium"
          >
            Show
          </button>
        </div>
      </div>
    )
  }

  if (isGrouped) {
    // â”€â”€â”€ Grouped (same user, within 5 min) â”€â”€â”€
    return (
      <div
        ref={rowRef}
        className={`flex gap-3 py-0.5 px-2 rounded-md -mx-2 mt-0.5 group hover:bg-accent/30 relative transition-colors duration-100 ${highlighted ? 'bg-primary/10' : ''} ${isHidden && canHide ? 'border border-amber-500/30 bg-amber-500/5' : ''} ${isMentioned && !highlighted ? 'bg-amber-500/[0.08]' : ''}`}
        onMouseEnter={() => setShowActions(true)}
        onMouseLeave={handleMouseLeave}
      >
        {/* Time-on-hover in the left avatar slot — DESKTOP only. On mobile the left gutter is dropped so the
            body runs full-width, and the timestamp trails the message text instead (see the suffix below). */}
        {!isMobile && (
          <div className="w-11 shrink-0 flex items-center justify-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity select-none cursor-default">
                  {formatShortTime(msg.timestamp)}
                </span>
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">
                {formatFullDate(msg.timestamp)}
              </TooltipContent>
            </Tooltip>
          </div>
        )}

        <div className="min-w-0 flex-1">
          <ScrollableContent>
          {isEditing ? (
            <EditField text={editText} onChange={setEditText} onCancel={() => { cancelEdit(); setRemovedAttachmentHashes(new Set()) }} unchanged={editUnchanged} onSave={async () => { await onSaveEdit(msg, editText, removedAttachmentHashes); setRemovedAttachmentHashes(new Set()) }} hubDTag={hubDTag} channelId={channelId} />
          ) : !msg.decrypted && !msg.deleted ? (
            <EncryptedMessageCard hubDTag={hubDTag} />
          ) : shouldBlurBlocked ? (
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
          ) : shouldBlurMsg ? (
            <div className="flex items-center gap-2.5 py-1.5 px-3 my-1 rounded-lg bg-muted/50 border border-border/50">
              <AlertTriangle size={14} className="text-amber-500 shrink-0" />
              <span className="text-xs text-muted-foreground">Content warning - not safe for work</span>
              <button
                onClick={() => setNsfwRevealed(true)}
                className="flex items-center gap-1 ml-auto text-xs font-medium text-primary hover:text-primary/80 bg-primary/10 hover:bg-primary/15 px-2.5 py-1 rounded-full transition-colors cursor-pointer"
              >
                <Eye size={12} /> Show
              </button>
            </div>
          ) : (
            <>
              <div className={`text-base text-foreground/90 break-words transition-opacity ${relayPending ? 'opacity-50' : ''}`}>
                <MessageContent content={contentForRender} onProfileClick={onOpenProfile} emojiTags={msg.emojiTags} mutedWords={mutedWords} disableLinkPreviews={!authorCanEmbed} disableHubInviteCards={!authorCanInvite} hubRoleNames={hubRoleNames} hubChannels={hubChannels} suffix={
                  <>
                    {msg.edited && <span className="text-[10px] text-muted-foreground ml-1"> (edited)</span>}
                    {mobileGroupedTime}
                    <RelayProgressIndicator eventId={msg.id} />
                  </>
                } />
              </div>
              {contentMediaGroups.length > 0 && (
                <ContentMediaGroups groups={contentMediaGroups} galleryImages={allContentImages} onGalleryOpen={openContentGallery} />
              )}
            </>
          )}
          {(!shouldBlurMsg && authorCanAttach && msg.attachments && msg.attachments.length > 0) && (
            <div className="relative">
              <AttachmentRenderer attachments={msg.attachments.filter(a => !removedAttachmentHashes.has(a.hash))} hubDTag={hubDTag} gifTags={msg.gifTags} />
              {isEditing && msg.attachments.filter(a => !removedAttachmentHashes.has(a.hash)).length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {msg.attachments.filter(a => !removedAttachmentHashes.has(a.hash)).map((att) => (
                    <button
                      key={att.hash}
                      onClick={() => setRemovedAttachmentHashes(prev => new Set([...prev, att.hash]))}
                      className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors cursor-pointer"
                    >
                      <X size={10} />
                      Remove {att.name || att.hash.slice(0, 8)}
                    </button>
                  ))}
                </div>
              )}
              {isEditing && removedAttachmentHashes.size > 0 && msg.attachments.some(a => removedAttachmentHashes.has(a.hash)) && (
                <button
                  onClick={() => setRemovedAttachmentHashes(new Set())}
                  className="mt-1 flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
                >
                  Undo removal ({removedAttachmentHashes.size})
                </button>
              )}
            </div>
          )}
          {contentGalleryIndex !== null && (
            <ImageGallery images={allContentImages} startIndex={contentGalleryIndex} onClose={() => setContentGalleryIndex(null)} />
          )}
          {/* Stickers */}
          {!shouldBlurMsg && msg.stickerTags && msg.stickerTags.length > 0 && (
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
          {/* GIFs — only render g tags NOT already in attachments */}
          {!shouldBlurMsg && msg.gifTags && msg.gifTags.length > 0 && (() => {
            const attHashes = new Set((msg.attachments || []).map((a) => a.hash))
            const unmatched = msg.gifTags.filter(([, url]) => !Array.from(attHashes).some((h) => url.includes(h)))
            if (unmatched.length === 0) return null
            return (
              <div className={`flex flex-wrap gap-2 ${msg.content ? 'mt-1' : ''}`}>
                {unmatched.map(([name, url, nsfw], i) => (
                  <div key={`gif-${url}-${i}`} className="relative group/gif">
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <GifImg
                            src={url || ''}
                            alt={name || 'GIF'}
                            className={`rounded-lg hover:opacity-80 transition-opacity ${nsfw === 'nsfw' ? 'blur-lg hover:blur-none' : ''}`}
                            style={{ maxWidth: 220, maxHeight: 220, objectFit: 'contain' }}
                          />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">{name || 'GIF'}{nsfw === 'nsfw' ? ' (NSFW)' : ''}</TooltipContent>
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
                              const updated = exists ? store.favorites.filter((f) => f.url !== url) : [...store.favorites, { name: name || '', url, nsfw: nsfw === 'nsfw', tagged: true }]
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
            )
          })()}
          </ScrollableContent>
          <ReactionBar reactions={reactions} messageId={msg.id} onAddReaction={onAddReaction} rawReactions={rawReactions} onOpenProfile={onOpenProfile}>
            <ZapTotalBadge hubDTag={hubDTag} messageId={msg.dTag ? `36943:${msg.pubkey}:${msg.dTag}` : msg.id} onOpenProfile={onOpenProfile} />
          </ReactionBar>
          {msg.nsfw && !showNsfwPref && nsfwRevealed && (
            <button
              onClick={() => setNsfwRevealed(false)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-muted/60 px-2 py-0.5 rounded-full transition-colors cursor-pointer mt-1 w-fit"
            >
              <EyeOff size={11} /> Hide
            </button>
          )}
          {isBlockedUser && blockedRevealed && (
            <button
              onClick={() => setBlockedRevealed(false)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-muted/60 px-2 py-0.5 rounded-full transition-colors cursor-pointer mt-1 w-fit"
            >
              <EyeOff size={11} /> Hide
            </button>
          )}
        </div>

        {showActions && !isEditing && (
          <MessageActionBar
            isMine={isMine}
            msgId={msg.id}
            msgDTag={msg.dTag}
            msgPubkey={msg.pubkey}
            emojiButtonRef={emojiButtonRef}
            showMenu={showMenu}
            setShowMenu={setShowMenu}
            onEmoji={() => setShowEmoji(!showEmoji)}
            onEdit={() => onEdit(msg)}
            onReply={() => onReply(msg)}
            onThreadReply={() => onThreadReply(msg)}
            onRequestDelete={onRequestDelete}
            rawEvent={msg.rawEvent}
            onViewRaw={onViewRaw}
            hideThreadReply={hideThreadReply}
            hideReply={hideReply}
            hidePin={hidePin}
            canPublish={canPublish}
            hubDTag={hubDTag}
            channelId={channelId}
            onZapModalChange={setZapModalOpen}
            onReport={onReport ? () => {
              const aTag = msg.dTag ? `36943:${msg.pubkey}:${msg.dTag}` : undefined
              onReport(msg.pubkey, aTag, msg.content?.slice(0, 200))
            } : undefined}
            onHideMessage={onHideMessage}
            onUnhideMessage={onUnhideMessage}
            isHidden={isHidden}
          />
        )}
        {showEmoji && (
          <EmojiPickerPopover
            anchorRef={emojiButtonRef}
            onClose={() => setShowEmoji(false)}
            onSelect={(emoji, custom) => { onAddReaction(msg.id, emoji, custom?.url); setShowEmoji(false); setShowActions(false) }}
          />
        )}
      </div>
    )
  }

  // â”€â”€â”€ Full message (with avatar + name) â”€â”€â”€
  return (
    <div className="mt-4" ref={rowRef}>
      {/* Reply preview -- shown above the message if it's a reply */}
      {repliedMessage && (
        <ReplyPreview repliedMessage={repliedMessage} getProfile={getProfileForReply} onScrollTo={onScrollToMessage} />
      )}
      {replyStatus === 'not-found' && (
        <button
          onClick={() => msg.replyTo && onTimeTravel?.(msg.replyTo)}
          className={`flex ${isMobile ? 'gap-2' : 'gap-3'} px-2 -mx-2 items-end w-full text-left hover:opacity-70 transition-opacity cursor-pointer`}
        >
          <div className={`${isMobile ? 'w-6' : 'w-10'} shrink-0 flex`}><div className="ml-auto border-l-2 border-t-2 border-muted-foreground/20 rounded-tl-md" style={{ width: isMobile ? 12 : 20, height: 10 }} /></div>
          <span className="text-xs text-primary/60 italic pb-0.5 hover:text-primary transition-colors">Click to view original message</span>
        </button>
      )}
      {replyStatus === 'deleted' && (
        <div className={`flex ${isMobile ? 'gap-2' : 'gap-3'} px-2 -mx-2 items-end`}>
          <div className={`${isMobile ? 'w-6' : 'w-10'} shrink-0 flex`}><div className="ml-auto border-l-2 border-t-2 border-muted-foreground/20 rounded-tl-md" style={{ width: isMobile ? 12 : 20, height: 10 }} /></div>
          <span className="text-xs text-muted-foreground/50 italic pb-0.5">Original message was request-deleted</span>
        </div>
      )}
      <div
        className={`flex items-start ${isMobile ? 'gap-0' : 'gap-4'} py-1 px-2 rounded-md -mx-2 group hover:bg-accent/30 relative transition-colors duration-100 ${highlighted ? 'bg-primary/10' : ''} ${isHidden && canHide ? 'border border-amber-500/30 bg-amber-500/5' : ''} ${isMentioned && !highlighted ? 'bg-amber-500/[0.08]' : ''}`}
        onMouseEnter={() => setShowActions(true)}
        onMouseLeave={handleMouseLeave}
      >
        {/* Desktop: avatar sits in a left gutter spanning the whole message. On mobile the gutter is
            dropped (gap-0, no left avatar) so the message body below runs full-width; a compact avatar is
            rendered inline in the header row instead (see below). */}
        {!isMobile && (
          <button onClick={() => onOpenProfile(authorKey)} className="shrink-0 cursor-pointer">
            <Avatar className="h-10 w-10 mt-0.5">
              {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
              <AvatarFallback className="text-xs bg-primary/20 text-primary">
                {displayName.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-x-2 gap-y-0.5 mb-1 flex-wrap">
            {isMobile && (
              <button onClick={() => onOpenProfile(authorKey)} className="shrink-0 cursor-pointer">
                <Avatar className="h-6 w-6">
                  {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
                  <AvatarFallback className="text-[9px] bg-primary/20 text-primary">
                    {displayName.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              </button>
            )}
            <button
              onClick={() => onOpenProfile(authorKey)}
              className="text-base font-semibold cursor-pointer hover:underline text-foreground"
            >
              {displayName}
            </button>
            <DnnBadge pubkey={authorKey} />
            {msg.facilitator && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-medium cursor-default select-none">
                    facilitated
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  Facilitated by {(() => {
                    const fp = getProfile(msg.facilitator!)
                    return fp?.display_name || fp?.name || truncateNpub(nip19.npubEncode(msg.facilitator!))
                  })()}
                </TooltipContent>
              </Tooltip>
            )}
            <span className="text-xs text-muted-foreground cursor-default flex items-center gap-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-default">{formatTimestamp(msg.timestamp)}</span>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {formatFullDate(msg.timestamp)}
                </TooltipContent>
              </Tooltip>
              {msg.clientTag && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-muted-foreground/60 cursor-default"> · via {msg.clientTag}</span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    This post was published through the {msg.clientTag} client
                  </TooltipContent>
                </Tooltip>
              )}
              {msg.expiration && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-muted-foreground/50 cursor-default"> · disappears after {formatDuration(Math.max(0, msg.expiration - msg.timestamp))}</span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    Best-effort disappearing message. Relays that honor the expiration tag delete it around {formatFullDate(msg.expiration)}; clients hide and purge it locally.
                  </TooltipContent>
                </Tooltip>
              )}
              {isHidden && canHide && (
                <button
                  onClick={() => setHiddenPreviewRevealed(false)}
                  className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium cursor-pointer select-none ml-1 hover:bg-amber-500/25 transition-colors"
                >
                  hidden by {hiddenBy || 'moderator'}
                </button>
              )}
            </span>
          </div>
          <ScrollableContent>
          {isEditing ? (
            <EditField text={editText} onChange={setEditText} onCancel={() => { cancelEdit(); setRemovedAttachmentHashes(new Set()) }} unchanged={editUnchanged} onSave={async () => { await onSaveEdit(msg, editText, removedAttachmentHashes); setRemovedAttachmentHashes(new Set()) }} hubDTag={hubDTag} channelId={channelId} />
          ) : !msg.decrypted && !msg.deleted ? (
            <EncryptedMessageCard hubDTag={hubDTag} />
          ) : shouldBlurMsg ? (
            <div className="flex items-center gap-2.5 py-1.5 px-3 my-1 rounded-lg bg-muted/50 border border-border/50">
              <AlertTriangle size={14} className="text-amber-500 shrink-0" />
              <span className="text-xs text-muted-foreground">Content warning - not safe for work</span>
              <button
                onClick={() => setNsfwRevealed(true)}
                className="flex items-center gap-1 ml-auto text-xs font-medium text-primary hover:text-primary/80 bg-primary/10 hover:bg-primary/15 px-2.5 py-1 rounded-full transition-colors cursor-pointer"
              >
                <Eye size={12} /> Show
              </button>
            </div>
          ) : (
            <>
              <div className={`text-base text-foreground/90 break-words transition-opacity ${relayPending ? 'opacity-50' : ''}`}>
                <MessageContent content={contentForRender} onProfileClick={onOpenProfile} emojiTags={msg.emojiTags} mutedWords={mutedWords} disableLinkPreviews={!authorCanEmbed} disableHubInviteCards={!authorCanInvite} hubRoleNames={hubRoleNames} hubChannels={hubChannels} suffix={
                  <>
                    {msg.edited && <span className="text-[10px] text-muted-foreground ml-1"> (edited)</span>}
                    {mobileGroupedTime}
                    <RelayProgressIndicator eventId={msg.id} />
                  </>
                } />
              </div>
              {contentMediaGroups.length > 0 && (
                <ContentMediaGroups groups={contentMediaGroups} galleryImages={allContentImages} onGalleryOpen={openContentGallery} />
              )}
            </>
          )}
          {(!shouldBlurMsg && authorCanAttach && msg.attachments && msg.attachments.length > 0) && (
            <div className="relative">
              <AttachmentRenderer attachments={msg.attachments.filter(a => !removedAttachmentHashes.has(a.hash))} hubDTag={hubDTag} gifTags={msg.gifTags} />
              {isEditing && msg.attachments.filter(a => !removedAttachmentHashes.has(a.hash)).length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {msg.attachments.filter(a => !removedAttachmentHashes.has(a.hash)).map((att) => (
                    <button
                      key={att.hash}
                      onClick={() => setRemovedAttachmentHashes(prev => new Set([...prev, att.hash]))}
                      className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors cursor-pointer"
                    >
                      <X size={10} />
                      Remove {att.name || att.hash.slice(0, 8)}
                    </button>
                  ))}
                </div>
              )}
              {isEditing && removedAttachmentHashes.size > 0 && msg.attachments.some(a => removedAttachmentHashes.has(a.hash)) && (
                <button
                  onClick={() => setRemovedAttachmentHashes(new Set())}
                  className="mt-1 flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
                >
                  Undo removal ({removedAttachmentHashes.size})
                </button>
              )}
            </div>
          )}
          {contentGalleryIndex !== null && (
            <ImageGallery images={allContentImages} startIndex={contentGalleryIndex} onClose={() => setContentGalleryIndex(null)} />
          )}
          {/* Stickers */}
          {!shouldBlurMsg && msg.stickerTags && msg.stickerTags.length > 0 && (
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
          {/* GIFs — only render g tags NOT already in attachments */}
          {!shouldBlurMsg && msg.gifTags && msg.gifTags.length > 0 && (() => {
            const attHashes = new Set((msg.attachments || []).map((a) => a.hash))
            const unmatched = msg.gifTags.filter(([, url]) => !Array.from(attHashes).some((h) => url.includes(h)))
            if (unmatched.length === 0) return null
            return (
              <div className={`flex flex-wrap gap-2 ${msg.content ? 'mt-1' : ''}`}>
                {unmatched.map(([name, url, nsfw], i) => (
                  <div key={`gif-${url}-${i}`} className="relative group/gif">
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <GifImg
                            src={url || ''}
                            alt={name || 'GIF'}
                            className={`rounded-lg hover:opacity-80 transition-opacity ${nsfw === 'nsfw' ? 'blur-lg hover:blur-none' : ''}`}
                            style={{ maxWidth: 220, maxHeight: 220, objectFit: 'contain' }}
                          />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">{name || 'GIF'}{nsfw === 'nsfw' ? ' (NSFW)' : ''}</TooltipContent>
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
                              const updated = exists ? store.favorites.filter((f) => f.url !== url) : [...store.favorites, { name: name || '', url, nsfw: nsfw === 'nsfw', tagged: true }]
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
            )
          })()}
          </ScrollableContent>
          <ReactionBar reactions={reactions} messageId={msg.id} onAddReaction={onAddReaction} rawReactions={rawReactions} onOpenProfile={onOpenProfile}>
            <ZapTotalBadge hubDTag={hubDTag} messageId={msg.dTag ? `36943:${msg.pubkey}:${msg.dTag}` : msg.id} onOpenProfile={onOpenProfile} />
          </ReactionBar>
          {msg.nsfw && !showNsfwPref && nsfwRevealed && (
            <button
              onClick={() => setNsfwRevealed(false)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-muted/60 px-2 py-0.5 rounded-full transition-colors cursor-pointer mt-1 w-fit"
            >
              <EyeOff size={11} /> Hide
            </button>
          )}
        </div>

        {showActions && !isEditing && (
          <MessageActionBar
            isMine={isMine}
            msgId={msg.id}
            msgDTag={msg.dTag}
            msgPubkey={msg.pubkey}
            emojiButtonRef={emojiButtonRef}
            showMenu={showMenu}
            setShowMenu={setShowMenu}
            onEmoji={() => setShowEmoji(!showEmoji)}
            onEdit={() => onEdit(msg)}
            onReply={() => onReply(msg)}
            onThreadReply={() => onThreadReply(msg)}
            onRequestDelete={onRequestDelete}
            rawEvent={msg.rawEvent}
            onViewRaw={onViewRaw}
            hideThreadReply={hideThreadReply}
            hideReply={hideReply}
            hidePin={hidePin}
            canPublish={canPublish}
            hubDTag={hubDTag}
            channelId={channelId}
            onZapModalChange={setZapModalOpen}
            onReport={onReport ? () => {
              const aTag = msg.dTag ? `36943:${msg.pubkey}:${msg.dTag}` : undefined
              onReport(msg.pubkey, aTag, msg.content?.slice(0, 200))
            } : undefined}
            onHideMessage={onHideMessage}
            onUnhideMessage={onUnhideMessage}
            isHidden={isHidden}
          />
        )}
        {showEmoji && (
          <EmojiPickerPopover
            anchorRef={emojiButtonRef}
            onClose={() => setShowEmoji(false)}
            onSelect={(emoji, custom) => { onAddReaction(msg.id, emoji, custom?.url); setShowEmoji(false); setShowActions(false) }}
          />
        )}
      </div>
    </div>
  )
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Hover Action Bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export function MessageActionBar({ isMine, msgId, msgDTag, msgPubkey, emojiButtonRef, showMenu, setShowMenu, onEmoji, onEdit, onReply, onThreadReply, onRequestDelete, rawEvent, onViewRaw, hideThreadReply, hideReply, hideEdit, hidePin, canPublish, hubDTag, channelId, onZapModalChange, onReport, onHideMessage, onUnhideMessage, isHidden }: {
  isMine: boolean
  msgId: string
  msgDTag: string
  msgPubkey: string
  emojiButtonRef: React.RefObject<HTMLButtonElement | null>
  showMenu: boolean
  setShowMenu: (v: boolean) => void
  onEmoji: () => void
  onEdit: () => void
  onReply: () => void
  onThreadReply: () => void
  onRequestDelete: () => void
  rawEvent?: string
  onViewRaw: (raw: string) => void
  hideThreadReply?: boolean
  hideReply?: boolean
  hideEdit?: boolean
  hidePin?: boolean
  canPublish: boolean
  hubDTag: string
  channelId: string
  onZapModalChange?: (open: boolean) => void
  onReport?: () => void
  onHideMessage?: () => void | Promise<void>
  onUnhideMessage?: () => void | Promise<void>
  isHidden?: boolean
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const dotsRef = useRef<HTMLButtonElement>(null)
  const [dropUp, setDropUp] = useState(false)
  const [hideInProgress, setHideInProgress] = useState(false)
  const [showZapModal, _setShowZapModal] = useState(false)
  const setShowZapModal = (open: boolean) => { _setShowZapModal(open); onZapModalChange?.(open) }
  const [showHistory, setShowHistory] = useState(false)

  // Pin state from global store
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const hub = useHubStore((s) => hubDTag ? s.hubs[hubDTag] : null)
  // v2: pin lists must be authored + keyed by the member pseudonym P (never R, which would
  // reveal hub membership). Resolve P (cached) for the active hub; v1 uses the real key.
  const [pinKey, setPinKey] = useState<string | null>(myPubkey)
  const [pinAuthSigner, setPinAuthSigner] = useState<((u: any) => Promise<any>) | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (hub && myPubkey) {
        const { hubMemberIdentity } = await import('@/lib/hub/hubMemberSign')
        const id = await hubMemberIdentity(hub, { privateKey, signer })
        if (cancelled) return
        setPinKey(id ? id.authKey : myPubkey)
        setPinAuthSigner(() => id?.authSigner)
      } else { setPinKey(myPubkey); setPinAuthSigner(undefined) }
    })()
    return () => { cancelled = true }
  }, [hub, myPubkey, privateKey, signer])
  const aRef = msgDTag ? `36943:${msgPubkey}:${msgDTag}` : msgId
  const isPinned = usePinStore((s) => pinKey ? s.isMessagePinned(hubDTag, channelId, aRef, pinKey) : false)
  const pinMessage = usePinStore((s) => s.pinMessage)
  const unpinMessage = usePinStore((s) => s.unpinMessage)

  // Check if recipient has a lightning address for zap button
  const recipientProfile = getCachedProfile(msgPubkey)
  const canZap = !isMine && !!recipientProfile?.lud16 && canPublish

  const handleTogglePin = async () => {
    if (!myPubkey) return
    const relays = hub ? [...hub.generalRelays] : []
    if (isPinned) {
      await unpinMessage(hubDTag, channelId, aRef, pinKey ?? myPubkey, relays, signer, privateKey, pinAuthSigner)
    } else {
      await pinMessage(hubDTag, channelId, aRef, pinKey ?? myPubkey, relays, signer, privateKey, pinAuthSigner)
    }
    setShowMenu(false)
  }

  // Click-outside to close the dots menu
  useEffect(() => {
    if (!showMenu) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showMenu, setShowMenu])

  // Edge-aware: decide if menu should open up or down based on actual menu height
  useEffect(() => {
    if (!showMenu || !dotsRef.current) return
    // Wait a frame so the menu DOM is rendered and measurable
    const raf = requestAnimationFrame(() => {
      const menuEl = menuRef.current?.querySelector('[data-action-menu]') as HTMLElement | null
      const dotsRect = dotsRef.current!.getBoundingClientRect()
      const menuHeight = menuEl?.offsetHeight || 300 // fallback estimate
      const spaceBelow = window.innerHeight - dotsRect.bottom - 8
      const spaceAbove = dotsRect.top - 8
      // Prefer dropping down; only drop up if no room below AND there's room above
      setDropUp(spaceBelow < menuHeight && spaceAbove > menuHeight)
    })
    return () => cancelAnimationFrame(raf)
  }, [showMenu])

  const copyEventAddress = () => {
    try {
      let addr: string
      if (msgDTag) {
        // Addressable event — use naddr
        addr = nip19.naddrEncode({
          kind: 36943,
          pubkey: msgPubkey,
          identifier: msgDTag,
        })
      } else {
        // Non-addressable event (poll etc) — use nevent
        addr = nip19.neventEncode({
          id: msgId,
          author: msgPubkey,
        })
      }
      navigator.clipboard.writeText(addr)
    } catch {
      navigator.clipboard.writeText(msgId)
    }
    setShowMenu(false)
  }

  return (
    <div
      className="absolute -top-1 right-2 flex items-center gap-0.5 bg-secondary border border-border rounded-md shadow-md px-0.5 py-0.5 z-10 animate-action-bar-in"
      onClick={(e) => e.stopPropagation()}
    >
      {canPublish && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              ref={emojiButtonRef}
              onClick={onEmoji}
              className="p-1 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <Smile size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">Add Reaction</TooltipContent>
        </Tooltip>
      )}
      {isMine && !hideEdit && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onEdit}
              className="p-1 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <Pencil size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">Edit Message</TooltipContent>
        </Tooltip>
      )}
      {canPublish && !hideReply && (
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
      )}
      {canZap && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setShowZapModal(true)}
              className="p-1 rounded cursor-pointer text-muted-foreground hover:text-yellow-400 hover:bg-yellow-400/10 transition-colors"
            >
              <Zap size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">Zap</TooltipContent>
        </Tooltip>
      )}
      {/* More actions (vertical dots) */}
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
          <div data-action-menu className={`absolute right-0 w-48 bg-popover border border-border rounded-md shadow-lg p-1 flex flex-col gap-1 z-20 ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
            <button
              onClick={copyEventAddress}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
            >
              <Copy size={14} /> Copy Event Address
            </button>
            <button
              onClick={() => {
                if (rawEvent) onViewRaw(rawEvent)
                setShowMenu(false)
              }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
            >
              <Code size={14} /> View Raw Event
            </button>
            {msgDTag && (
              <button
                onClick={() => { setShowMenu(false); setShowHistory(true) }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
              >
                <History size={14} /> View History
              </button>
            )}
            {!hideThreadReply && canPublish && (
              <button
                onClick={() => { setShowMenu(false); onThreadReply() }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
              >
                <MessageSquarePlus size={14} /> Thread Reply
              </button>
            )}
            {!hidePin && canPublish && (
              <button
                onClick={handleTogglePin}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
              >
                {isPinned ? <><PinOff size={14} /> Unpin</> : <><Pin size={14} /> Pin Message</>}
              </button>
            )}
            {!isMine && onReport && (
              <button
                onClick={() => { setShowMenu(false); onReport() }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-amber-400 hover:bg-amber-500/10 cursor-pointer transition-colors rounded-md"
              >
                <Flag size={14} /> Report User
              </button>
            )}
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
            {onHideMessage && !isHidden && (
              <button
                disabled={hideInProgress}
                onClick={async () => {
                  setHideInProgress(true)
                  try { await onHideMessage() } finally { setHideInProgress(false); setShowMenu(false) }
                }}
                className={`flex items-center gap-2 w-full px-3 py-1.5 text-sm text-amber-400 hover:bg-amber-500/10 transition-colors rounded-md ${hideInProgress ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                {hideInProgress ? <Loader2 size={14} className="animate-spin" /> : <EyeOff size={14} />} {hideInProgress ? 'Hiding…' : 'Hide Message'}
              </button>
            )}
            {onUnhideMessage && isHidden && (
              <button
                disabled={hideInProgress}
                onClick={async () => {
                  setHideInProgress(true)
                  try { await onUnhideMessage() } finally { setHideInProgress(false); setShowMenu(false) }
                }}
                className={`flex items-center gap-2 w-full px-3 py-1.5 text-sm text-emerald-400 hover:bg-emerald-500/10 transition-colors rounded-md ${hideInProgress ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                {hideInProgress ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />} {hideInProgress ? 'Unhiding…' : 'Unhide Message'}
              </button>
            )}
          </div>
        )}
      </div>
      {showZapModal && createPortal(
        <ZapModal
          open={showZapModal}
          onClose={() => setShowZapModal(false)}
          recipientPubkey={msgPubkey}
          messageEventId={msgId}
          messageDTag={msgDTag}
          messageKind={36943}
          hubDTag={hubDTag}
        />,
        document.body
      )}
      {showHistory && msgDTag && createPortal(
        <MessageHistoryModal
          pubkey={msgPubkey}
          dTag={msgDTag}
          hubDTag={hubDTag}
          channelId={channelId}
          onClose={() => setShowHistory(false)}
        />,
        document.body
      )}
    </div>
  )
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Delete Confirm Dialog â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export function DeleteConfirmDialog({ onConfirm, onCancel, title, description, progressSteps, confirmLabel }: {
  onConfirm: () => Promise<void>
  onCancel: () => void
  title?: string
  description?: string
  progressSteps?: string[]
  confirmLabel?: string
}) {
  const [deleting, setDeleting] = useState(false)
  const [step, setStep] = useState(0)

  const steps = progressSteps || [
    'Marking post as deleted...',
    'Publishing changes...',
    'Sending deletion request...',
  ]

  const handleConfirm = async () => {
    setDeleting(true)
    setStep(0)
    if (steps.length > 1) {
      for (let i = 0; i < steps.length - 1; i++) {
        await new Promise((r) => setTimeout(r, 400))
        setStep(i + 1)
      }
    }
    await onConfirm()
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={!deleting ? onCancel : undefined}>
      <div className="bg-card border border-border rounded-lg p-6 max-w-md w-full mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-foreground mb-2">{title || 'Request Delete Message'}</h3>

        {!deleting ? (
          <>
            <p className="text-sm text-muted-foreground mb-4">
              {description || <>This will send a deletion request to the relays. Deletion is <strong>not guaranteed</strong>, as some relays may not honor the request, and other clients may have already cached the message.</>}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onCancel}>Cancel</Button>
              <Button variant="destructive" onClick={handleConfirm}>{confirmLabel || 'Yes, Request Delete'}</Button>
            </div>
          </>
        ) : (
          <div className="space-y-2 py-2">
            {steps.map((label, i) => (
              <div key={i} className="flex items-center gap-2.5">
                {i < step ? (
                  <Check size={16} className="text-green-400 shrink-0" />
                ) : i === step ? (
                  <svg className="animate-spin h-4 w-4 text-primary shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/30 shrink-0" />
                )}
                <span className={`text-sm ${i <= step ? 'text-foreground' : 'text-muted-foreground/50'}`}>
                  {label}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Inline Edit Field â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

function EditField({ text, onChange, onCancel, unchanged, onSave, hubDTag, channelId }: {
  text: string
  onChange: (v: string) => void
  onCancel: () => void
  unchanged: boolean
  onSave: () => void
  hubDTag: string
  channelId: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const autoResize = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 300)}px`
  }, [])

  // @mention autocomplete (people / @everyone / @here / roles) — same as the composer
  const mention = useMentionAutocomplete({ hubDTag, channelId, text, setText: onChange, textareaRef: ref, autoResize })

  useEffect(() => {
    if (ref.current) {
      ref.current.focus()
      // Place cursor at the end of the text (default is beginning)
      const len = ref.current.value.length
      ref.current.selectionStart = len
      ref.current.selectionEnd = len
      autoResize(ref.current)
    }
  }, [])

  const isEditOverLimit = text.length > MESSAGE_MAX_LENGTH
  const editCharsRemaining = MESSAGE_MAX_LENGTH - text.length
  const showEditCharCounter = editCharsRemaining <= MESSAGE_CHAR_WARN_THRESHOLD

  const handleSave = async () => {
    if (saving || unchanged || !text.trim() || isEditOverLimit) return
    setSaving(true)
    setSaveError(null)
    try {
      await onSave()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save your edit. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 mt-1">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => {
          onChange(e.target.value)
          autoResize(e.target)
          mention.updateMentionQuery(e.target.value, e.target.selectionStart)
        }}
        onKeyDown={(e) => {
          // Let the mention dropdown consume nav keys (arrows/enter/tab/escape) first
          if (mention.handleMentionKeyDown(e)) return
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Tab') {
            e.preventDefault()
            const ta = ref.current
            if (ta) {
              const start = ta.selectionStart
              const end = ta.selectionEnd
              const spaces = '   '
              const before = text.substring(0, start)
              const after = text.substring(end)
              onChange(`${before}${spaces}${after}`)
              requestAnimationFrame(() => {
                ta.focus()
                const pos = start + spaces.length
                ta.setSelectionRange(pos, pos)
                autoResize(ta)
              })
            }
            return
          }
          if (e.key === 'Enter' && !e.shiftKey && !unchanged && text.trim() && !saving && !isEditOverLimit) {
            e.preventDefault()
            handleSave()
          }
        }}
        disabled={saving}
        className="w-full bg-secondary rounded-md px-2 py-1 text-sm resize-none outline-none border border-border focus:border-primary transition-colors text-foreground disabled:opacity-50"
        style={{ maxHeight: '300px', overflowY: 'auto' }}
        rows={1}
      />
      <MentionSuggestionsDropdown
        suggestions={mention.mentionSuggestions}
        activeIndex={mention.mentionIndex}
        onSelect={mention.applyMention}
        onHover={mention.setMentionIndex}
        anchorRef={ref}
      />
      <div className="flex items-center gap-2 text-xs">
        <button
          onClick={onCancel}
          disabled={saving}
          className="px-2 py-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
        {showEditCharCounter && (
          <span className={`text-[11px] font-mono tabular-nums select-none transition-colors ${
            isEditOverLimit ? 'text-red-400 font-semibold' : editCharsRemaining <= 100 ? 'text-amber-400' : 'text-muted-foreground/60'
          }`}>
            {editCharsRemaining}
          </span>
        )}
        <button
          onClick={handleSave}
          disabled={unchanged || !text.trim() || saving || isEditOverLimit}
          className="px-3 py-0.5 rounded bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/80 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
        >
          {saving ? (
            <>
              <span className="inline-block w-3 h-3 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
              Saving...
            </>
          ) : 'Save'}
        </button>
      </div>
      {saveError && <p className="text-[11px] text-red-400">{saveError}</p>}
    </div>
  )
}


/* --- EmojiPickerPopover is now in @/components/chat/EmojiPickerPopover.tsx --- */


/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Welcome â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

function WelcomeMessage({ channelName }: { channelName: string }) {
  return (
    <div className="mb-6">
      <div className="w-16 h-16 rounded-full flex items-center justify-center text-2xl mb-3 bg-secondary text-muted-foreground">
        <Hash size={32} />
      </div>
      <h3 className="text-2xl font-bold mb-1 text-foreground">Welcome to #{channelName}</h3>
      <p className="text-sm text-muted-foreground">This is the start of the #{channelName} channel.</p>
    </div>
  )
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Message Input â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

/*
 * ⚠️ NOTE: This is a hub-specific input component. There is also a shared
 * ChatInputBar (chat/ChatInputBar.tsx) used by DMs, Forum, and Public chat.
 * When updating file preview cards, remove button styling, or encryption
 * toggle here, also update ChatInputBar.tsx to keep them in sync.
 */
export interface MessageInputProps {
  hubDTag: string
  channelId: string
  channelName: string
  optimisticMessages: OptimisticMessage[]
  setOptimisticMessages: React.Dispatch<React.SetStateAction<OptimisticMessage[]>>
  replyContext: ReplyContext | null
  onCancelReply: () => void
  dragContainerRef?: React.RefObject<HTMLDivElement | null>
  hideReplyBanner?: boolean
  canPublish?: boolean
  threadRootRef?: string
  bare?: boolean   // drop the px-2 pb-2 root padding (composer sits outside a card)
}

export function MessageInput({ hubDTag, channelId, channelName, optimisticMessages, setOptimisticMessages, replyContext, onCancelReply, dragContainerRef, hideReplyBanner, canPublish = true, threadRootRef, bare = false }: MessageInputProps) {
  const draftKey = threadRootRef ? hubThreadDraftKey(hubDTag, channelId, threadRootRef) : hubDraftKey(hubDTag, channelId)
  const [message, setMessage] = useState(() => getDraft(draftKey))
  // Load correct draft when switching channels
  const _prevDraftKey = useRef(draftKey)
  useEffect(() => {
    if (_prevDraftKey.current !== draftKey) {
      _prevDraftKey.current = draftKey
      setMessage(getDraft(draftKey))
    }
  }, [draftKey])
  useEffect(() => { setDraft(draftKey, message) }, [draftKey, message])
  const [showEmoji, setShowEmoji] = useState(false)
  const [showToolbar, setShowToolbar] = useState(false)
  const [showTimestamp, setShowTimestamp] = useState(false)
  const [isNsfw, setIsNsfw] = useState(false)
  const [encryptUploads, setEncryptUploads] = useState(() => localStorage.getItem('den-chat-encrypt-uploads') === 'true')
  const toggleEncryptUploads = useCallback(() => {
    setEncryptUploads((prev) => {
      const next = !prev
      localStorage.setItem('den-chat-encrypt-uploads', String(next))
      return next
    })
  }, [])
  const hubSecrets = useHubStore((s) => s.hubSecrets)
  const hubPrefs = useHubStore((s) => hubDTag ? s.hubPrefs[hubDTag] : undefined)
  const hasSecret = !!(hubDTag && hubSecrets[hubDTag])
  const isEncrypted = hasSecret  // Always encrypt when key available
  const { sendMessage } = useMessages(hubDTag, channelId)

  // ── Typing indicator heartbeat (NIP-CHAT §6.14) — main channel composer only ──
  const _hubForTyping = useHubStore((s) => s.hubs[hubDTag])
  const _typingRelays = useMemo(
    () => getPublishRelays(_hubForTyping ? [..._hubForTyping.generalRelays] : [], { hubOnly: !!_hubForTyping && isV2(_hubForTyping) }),
    [hubDTag, _hubForTyping?.generalRelays],
  )
  const typing = useTypingHeartbeat({ scope: 'hub', hubDTag, channelId, relays: _typingRelays })
  const signalTyping = useCallback((value: string) => {
    if (threadRootRef) return // thread typing isn't channel-scoped — skip
    if (value.trim()) typing.notifyTyping()
    else typing.notifyStop()
  }, [threadRootRef, typing])

  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const hub = useHubStore((s) => hubDTag ? s.hubs[hubDTag] : null)

  // ─── Poll state ───
  const [showPollModal, setShowPollModal] = useState(false)

  // ─── Permission-based gating ───
  const inputPerms = usePermissions(hubDTag || undefined, channelId || undefined)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Focus the composer when a reply is started, so you can type immediately.
  useEffect(() => {
    if (replyContext) textareaRef.current?.focus()
  }, [replyContext])
  const emojiButtonRef = useRef<HTMLButtonElement>(null)
  const stickerButtonRef = useRef<HTMLButtonElement>(null)
  const gifButtonRef = useRef<HTMLButtonElement>(null)
  const timestampButtonRef = useRef<HTMLButtonElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const knownHashesRef = useRef<Set<string>>((() => {
    // Pre-populate known hashes from restored draft files
    const s = new Set<string>()
    for (const f of getFileDraft(draftKey)) {
      if (f.hash) s.add(f.hash)
    }
    return s
  })())

  type PendingFile = {
    id: string
    file: File
    status: 'pending' | 'uploading' | 'encrypting' | 'success' | 'failed'
    hash?: string
    progress?: UploadProgress
    previewUrl?: string
    /** Present when the file was encrypted before upload */
    encryption?: {
      algorithm: string
      key: string
      nonce: string
      originalHash: string
    }
  }
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>(() => getFileDraft(draftKey) as unknown as PendingFile[])

  // ─── File Draft Persistence ───
  const pendingFilesRef = useRef(pendingFiles)
  pendingFilesRef.current = pendingFiles

  const _prevFileDraftKey = useRef(draftKey)
  useEffect(() => {
    if (_prevFileDraftKey.current !== draftKey) {
      // Switching context — save old files, load new
      if (_prevFileDraftKey.current) setFileDraft(_prevFileDraftKey.current, pendingFilesRef.current as any)
      _prevFileDraftKey.current = draftKey
      const restored = getFileDraft(draftKey) as unknown as PendingFile[]
      setPendingFiles(restored)
      // Update known hashes
      knownHashesRef.current.clear()
      for (const f of restored) {
        if (f.hash) knownHashesRef.current.add(f.hash)
      }
    }
  }, [draftKey])

  // Save files to draft store on unmount
  useEffect(() => {
    return () => {
      setFileDraft(draftKey, pendingFilesRef.current as any)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey])
  const [isUploading, setIsUploading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [fileSizeWarning, setFileSizeWarning] = useState<{ names: string[]; limitMb: number } | null>(null)
  const dragCounter = useRef(0)

  // ─── Emoji click modal state ───
  const [clickedEmoji, setClickedEmoji] = useState<{ shortcode: string; url: string; setAddress: string | null } | null>(null)
  const [discoverSearch, setDiscoverSearch] = useState<{ search: string; author: string } | null>(null)

  // ─── Sticker state ───
  const [showSticker, setShowSticker] = useState(false)
  type PendingSticker = { shortcode: string; url: string; setAddress: string }
  const [pendingStickers, setPendingStickers] = useState<PendingSticker[]>([])

  // ─── Sticker click modal state ───
  const [clickedSticker, setClickedSticker] = useState<{ shortcode: string; url: string; setAddress: string | null } | null>(null)
  const [stickerDiscoverSearch, setStickerDiscoverSearch] = useState<{ search: string; author: string } | null>(null)

  // ─── GIF state ───
  const [showGif, setShowGif] = useState(false)
  type PendingGif = { name: string; url: string; nsfw: boolean }
  const [pendingGifs, setPendingGifs] = useState<PendingGif[]>([])

  // ─── Voice note state ───
  const [showVoiceNote, setShowVoiceNote] = useState(false)

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

  // ─── @mention autocomplete state ───
  const hubMembers = useHubStore((s) => hubDTag ? s.hubMembers[hubDTag] : undefined)
  const { getProfile } = useProfileCache()
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionTrigger, setMentionTrigger] = useState<'@' | '#'>('@')   // '#' = channel autocomplete
  const [mentionIndex, setMentionIndex] = useState(0)
  const mentionStartRef = useRef<number | null>(null)
  const mentionListRef = useRef<HTMLDivElement>(null)

  // ─── :emoji: autocomplete state ───
  const [emojiQuery, setEmojiQuery] = useState<string | null>(null)
  const [emojiIndex, setEmojiIndex] = useState(0)
  const emojiStartRef = useRef<number | null>(null)
  const emojiListRef = useRef<HTMLDivElement>(null)

  // ─── Unified mention suggestion type ───
  type MentionSuggestion =
    | { type: 'user'; pubkey: string; name: string; npub: string; picture?: string; dnnId?: string }
    | { type: 'group'; keyword: 'everyone' | 'here'; label: string; description: string }
    | { type: 'role'; roleId: string; roleName: string; color?: string }
    | { type: 'channel'; channelId: string; channelName: string; categoryName?: string; position?: number }

  // Compute filtered suggestions from hub members + group mentions + roles (or #channels)
  const mentionSuggestions: MentionSuggestion[] = useMemo(() => {
    if (mentionQuery === null) return []
    const q = mentionQuery.toLowerCase()
    // #channel suggestions (trigger '#')
    if (mentionTrigger === '#') {
      return (hub?.channels || [])
        .filter((c) => c.name && (!q || c.name.toLowerCase().includes(q)))
        .slice(0, 10)
        .map((c) => {
          const cat = c.categoryId ? (hub?.categories || []).find((k) => k.categoryId === c.categoryId) : null
          return { type: 'channel' as const, channelId: c.channelId, channelName: c.name, categoryName: cat?.name, position: c.position }
        })
    }
    if (!hubMembers) return []
    const results: MentionSuggestion[] = []

    // 1. Group mentions (@everyone, @here) — permission-gated
    if (inputPerms.mention_everyone && 'everyone'.includes(q)) {
      results.push({ type: 'group', keyword: 'everyone', label: '@everyone', description: 'Notify all hub members' })
    }
    if (inputPerms.mention_here && 'here'.includes(q)) {
      results.push({ type: 'group', keyword: 'here', label: '@here', description: 'Notify members in this channel' })
    }

    // 2. Hub role mentions — permission-gated
    if (inputPerms.mention_roles && hub?.roles) {
      for (const role of hub.roles) {
        if (role.name === 'everyone') continue // skip — already handled as group mention
        if (!q || role.name.toLowerCase().includes(q)) {
          results.push({ type: 'role', roleId: role.roleId, roleName: role.name, color: role.color })
        }
      }
    }

    // 3. User mentions
    const dnnVerified = useDnnStore.getState().verified
    const userResults = hubMembers
      .map((m) => {
        const profile = getCachedProfile(m.pubkey)
        getProfile(m.pubkey)
        const name = profile?.display_name || profile?.name || ''
        const npub = nip19.npubEncode(m.pubkey)
        const dnnEntry = dnnVerified[m.pubkey]
        const dnnId = dnnEntry ? dnnEntry.dnnId : undefined
        return { type: 'user' as const, pubkey: m.pubkey, name, npub, picture: profile?.picture, dnnId }
      })
      .filter((s) => {
        if (!q) return true
        return s.name.toLowerCase().includes(q) || s.npub.toLowerCase().includes(q) || (s.dnnId && s.dnnId.toLowerCase().includes(q))
      })

    results.push(...userResults)
    return results.slice(0, 10) // limit total suggestions
  }, [mentionQuery, mentionTrigger, hub?.channels, hub?.categories, hubMembers, getProfile, inputPerms.mention_everyone, inputPerms.mention_here, inputPerms.mention_roles, hub?.roles])

  // Detect @mention or #channel query from cursor position
  const updateMentionQuery = useCallback((text: string, cursorPos: number) => {
    const beforeCursor = text.slice(0, cursorPos)
    const atMatch = beforeCursor.match(/@([^\s@]*)$/)
    if (atMatch) {
      setMentionTrigger('@')
      setMentionQuery(atMatch[1])
      mentionStartRef.current = cursorPos - atMatch[0].length
      setMentionIndex(0)
      return
    }
    // #channel — require start-of-line or whitespace before '#' (so colors/anchors don't trigger)
    const hashMatch = beforeCursor.match(/(?:^|\s)#([^\s#]*)$/)
    if (hashMatch) {
      setMentionTrigger('#')
      setMentionQuery(hashMatch[1])
      mentionStartRef.current = cursorPos - hashMatch[1].length - 1   // position of '#'
      setMentionIndex(0)
      return
    }
    setMentionQuery(null)
    mentionStartRef.current = null
  }, [])

  // Compute filtered emoji suggestions from the merged emoji map
  const emojiSuggestions = useMemo(() => {
    if (emojiQuery === null) return []
    const q = emojiQuery.toLowerCase()
    const map = getEmojiMap()
    const results: { shortcode: string; url: string }[] = []
    for (const [shortcode, entry] of map) {
      if (shortcode.toLowerCase().includes(q)) {
        results.push({ shortcode, url: entry.url })
      }
      if (results.length >= 8) break
    }
    return results
  }, [emojiQuery])

  // Detect :emoji: query from cursor position
  const updateEmojiQuery = useCallback((text: string, cursorPos: number) => {
    const beforeCursor = text.slice(0, cursorPos)
    // Match a colon followed by at least 1 char, not preceded by another colon (to avoid matching completed :shortcode:)
    const colonMatch = beforeCursor.match(/:([a-zA-Z0-9_-]+)$/)
    if (colonMatch) {
      // Make sure we're not inside an already-completed shortcode
      const prefix = beforeCursor.slice(0, colonMatch.index)
      const lastColonInPrefix = prefix.lastIndexOf(':')
      // If there's a colon just before, this might be a completed shortcode — check
      if (lastColonInPrefix >= 0) {
        const between = prefix.slice(lastColonInPrefix + 1)
        // If the text between the previous colon and our match start has no spaces, it's completed
        if (/^[a-zA-Z0-9_-]+$/.test(between)) {
          setEmojiQuery(null)
          emojiStartRef.current = null
          return
        }
      }
      setEmojiQuery(colonMatch[1])
      emojiStartRef.current = cursorPos - colonMatch[0].length
      setEmojiIndex(0)
    } else {
      setEmojiQuery(null)
      emojiStartRef.current = null
    }
  }, [])

  // Auto-resize textarea to fit content, up to 500px
  const autoResize = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 500)}px`
  }, [])

  // Re-run autoResize when message changes (including cleared after send)
  useEffect(() => {
    const ta = textareaRef.current
    if (ta) autoResize(ta)
  }, [message, autoResize])

  // Apply a selected mention (handles user, group, and role types)
  const applyMention = useCallback((suggestion: MentionSuggestion) => {
    const start = mentionStartRef.current
    if (start === null) return
    const ta = textareaRef.current
    const before = message.slice(0, start)
    const afterCursor = ta ? message.slice(ta.selectionStart) : ''
    // Build the mention text based on type
    let mention: string
    if (suggestion.type === 'user') {
      mention = `@${suggestion.npub}`
    } else if (suggestion.type === 'group') {
      mention = `@${suggestion.keyword}`
    } else if (suggestion.type === 'channel') {
      mention = `#${suggestion.channelName}`
    } else {
      mention = `@${suggestion.roleName}`
    }
    const newText = `${before}${mention} ${afterCursor}`
    setMessage(newText)
    setMentionQuery(null)
    mentionStartRef.current = null
    requestAnimationFrame(() => {
      if (ta) {
        const pos = before.length + mention.length + 1
        ta.focus()
        ta.setSelectionRange(pos, pos)
        autoResize(ta)
      }
    })
  }, [message, autoResize])

  // Apply a selected emoji shortcode
  const applyEmojiSuggestion = useCallback((suggestion: { shortcode: string; url: string }) => {
    const start = emojiStartRef.current
    if (start === null) return
    const ta = textareaRef.current
    const before = message.slice(0, start)
    const afterCursor = ta ? message.slice(ta.selectionStart) : ''
    const emojiText = `:${suggestion.shortcode}:`
    const newText = `${before}${emojiText} ${afterCursor}`
    setMessage(newText)
    setEmojiQuery(null)
    emojiStartRef.current = null
    requestAnimationFrame(() => {
      if (ta) {
        const pos = before.length + emojiText.length + 1
        ta.focus()
        ta.setSelectionRange(pos, pos)
        autoResize(ta)
      }
    })
  }, [message, autoResize])

  // Insert markdown syntax around selection or at cursor
  const insertMarkdown = useCallback((prefix: string, suffix = '', placeholder = '') => {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const selected = message.substring(start, end)
    const text = selected || placeholder
    const before = message.substring(0, start)
    const after = message.substring(end)
    const newText = `${before}${prefix}${text}${suffix}${after}`
    setMessage(newText)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(
        start + prefix.length,
        start + prefix.length + text.length
      )
      autoResize(ta)
    })
  }, [message, autoResize])

  const insertLinePrefix = useCallback((prefix: string) => {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const lineStart = message.lastIndexOf('\n', start - 1) + 1
    const before = message.substring(0, lineStart)
    const after = message.substring(lineStart)
    const newText = `${before}${prefix}${after}`
    setMessage(newText)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(start + prefix.length, start + prefix.length)
      autoResize(ta)
    })
  }, [message, autoResize])

  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    // Check file size limit
    const limitMb = Number(localStorage.getItem('den-chat-upload-limit-mb')) || 10
    const limitBytes = limitMb * 1024 * 1024
    const tooLarge = files.filter((f) => f.size > limitBytes)
    const allowed = files.filter((f) => f.size <= limitBytes)
    if (tooLarge.length > 0) {
      setFileSizeWarning({ names: tooLarge.map((f) => f.name), limitMb })
    }
    if (allowed.length === 0) return
    // Compute hashes and filter duplicates using ref
    const newPending: PendingFile[] = []
    for (const file of allowed) {
      const buffer = await file.arrayBuffer()
      const hash = computeHash(new Uint8Array(buffer))
      if (knownHashesRef.current.has(hash)) continue
      knownHashesRef.current.add(hash)
      const pf: PendingFile = {
        id: `file_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        file,
        status: 'pending',
        hash,
      }
      if (file.type.startsWith('image/')) {
        pf.previewUrl = URL.createObjectURL(file)
      }
      newPending.push(pf)
    }
    if (newPending.length > 0) {
      setPendingFiles((prev) => [...prev, ...newPending])
    }
  }, [])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files || []))
    e.target.value = '' // Reset so same file can be re-selected
  }, [addFiles])

  const removeFile = useCallback((fileId: string) => {
    setPendingFiles((prev) => {
      const removed = prev.find((f) => f.id === fileId)
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
      if (removed?.hash) knownHashesRef.current.delete(removed.hash)
      return prev.filter((f) => f.id !== fileId)
    })
  }, [])

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const formatSpeed = (bps: number) => {
    if (bps < 1024) return `${Math.round(bps)} B/s`
    if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
    return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
  }

  const shortServerName = (url: string) => {
    try { return new URL(url).hostname.replace('www.', '') } catch { return url }
  }

  const handleUploadFiles = useCallback(async () => {
    const toUpload = pendingFiles.filter((f) => f.status === 'pending' || f.status === 'failed')
    if (toUpload.length === 0) return
    setIsUploading(true)

    const servers = getUploadBlossoms(hub?.blossomServers, { hubOnly: !!hub && isV2(hub) })

    for (const pf of toUpload) {
      setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: encryptUploads ? 'encrypting' as const : 'uploading' as const, progress: undefined } : f))
      try {
        const buffer = await pf.file.arrayBuffer()
        let data = new Uint8Array(buffer)
        let encMeta: PendingFile['encryption'] = undefined

        // ── Encrypt before upload when toggle is on ──
        if (encryptUploads) {
          const { encryptFile } = await import('@/lib/crypto/fileEncryption')
          const result = await encryptFile(data)
          encMeta = {
            algorithm: 'aes-256-gcm',
            key: result.keyHex,
            nonce: result.nonceHex,
            originalHash: result.originalHashHex,
          }
          // Upload the ciphertext instead of the plaintext
          data = result.cipherBytes.slice() as Uint8Array<ArrayBuffer>
          setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: 'uploading' as const } : f))
        }

        // v2: sign the Blossom upload auth as the member pseudonym P (no R leak to the server).
        const uploadAuthSigner = hub ? await (await import('@/lib/hub/hubMemberSign')).hubBlossomAuthSigner(hub, { privateKey, signer }) : undefined
        const { hash } = await uploadToBlossomServers(
          data, signer, privateKey, servers, encryptUploads ? 'application/octet-stream' : pf.file.type,
          (progress) => {
            setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, progress: { ...progress } } : f))
          },
          () => { const c = new AbortController(); uploadAbortRef.current = c; return c.signal },
          uploadAuthSigner,
        )
        setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: 'success' as const, hash, progress: undefined, encryption: encMeta } : f))
      } catch {
        setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: 'failed' as const, progress: undefined } : f))
      }
    }
    setIsUploading(false)
  }, [pendingFiles, hub, signer, privateKey, encryptUploads])

  // Can send: has text or all files uploaded successfully, no pending/uploading/failed files
  const hasFailedFiles = pendingFiles.some((f) => f.status === 'failed')
  const hasPendingOrUploading = pendingFiles.some((f) => f.status === 'pending' || f.status === 'uploading' || f.status === 'encrypting')
  const allFilesSuccess = pendingFiles.length > 0 && pendingFiles.every((f) => f.status === 'success')
  const canSend = (message.trim() || allFilesSuccess || pendingStickers.length > 0 || pendingGifs.length > 0) && !hasPendingOrUploading && !hasFailedFiles && message.length <= MESSAGE_MAX_LENGTH

  // Character limit
  const charsRemaining = MESSAGE_MAX_LENGTH - message.length
  const isOverLimit = charsRemaining < 0
  const showCharCounter = charsRemaining <= MESSAGE_CHAR_WARN_THRESHOLD

  // Detect custom emoji shortcodes in current message for preview
  const detectedEmojis = useMemo(() => {
    const map = getEmojiMap()
    if (map.size === 0 || !message) return []
    const found: { shortcode: string; url: string }[] = []
    const seen = new Set<string>()
    const re = /:([a-zA-Z0-9_-]+):/g
    let m: RegExpExecArray | null
    while ((m = re.exec(message)) !== null) {
      const sc = m[1]
      if (seen.has(sc)) continue
      seen.add(sc)
      const entry = map.get(sc)
      if (entry) found.push({ shortcode: sc, url: entry.url })
    }
    return found
  }, [message])

  const handleSend = useCallback(async () => {
    const text = message.trim()
    if (!text && !allFilesSuccess && pendingStickers.length === 0 && pendingGifs.length === 0) return

    // Build attachments from successful uploads
    const attachments: Attachment[] = pendingFiles
      .filter((f) => f.status === 'success' && f.hash)
      .map((f) => ({
        hash: f.hash!,
        type: f.file.type || 'application/octet-stream',
        name: f.file.name,
        size: f.file.size,
        ...(f.encryption ? { encryption: f.encryption } : {}),
      }))

    const tempId = `opt_${Date.now()}_${Math.random().toString(36).slice(2)}`

    // Capture send arguments for retry before clearing state
    const retryReplyTo = replyContext ? { pubkey: replyContext.pubkey, dTag: replyContext.dTag, eventId: replyContext.eventId } : undefined
    const retryRootRef = replyContext?.rootRef
    const retryIsThread = replyContext?.isThread
    const sentNsfw = isNsfw
    const sentStickers = [...pendingStickers]
    const sentGifs = [...pendingGifs]
    const retryStickerTags = sentStickers.length > 0
      ? sentStickers.map((s): [string, string, string, string] => ['sticker', s.shortcode, s.url, s.setAddress])
      : undefined
    const retryGifTags = sentGifs.length > 0
      ? sentGifs.map((g): [string, string, string, string] => ['j', g.name, g.url, g.nsfw ? 'nsfw' : 'sfw'])
      : undefined

    setOptimisticMessages((prev) => [
      ...prev,
      {
        tempId,
        channelId,
        content: text || (attachments.length > 0 ? `\u{1F4CE} ${attachments.length} file${attachments.length > 1 ? 's' : ''}` : ''),
        timestamp: Math.floor(Date.now() / 1000),
        status: 'mining' as const,
        replyDisplayName: replyContext?.displayName,
        replyPreview: replyContext?.preview,
        retryData: {
          text,
          replyTo: retryReplyTo,
          rootRef: retryRootRef,
          attachments: attachments.length > 0 ? [...attachments] : undefined,
          nsfw: sentNsfw || undefined,
          isThread: retryIsThread,
          isEncrypted,
          facilitator: hubPrefs?.facilitator || undefined,
          stickerTags: retryStickerTags,
          gifTags: retryGifTags,
        },
      },
    ])
    setMessage('')
    typing.notifyStop()
    clearDraft(draftKey)
    // Clean up file previews and known-hash tracking
    pendingFiles.forEach((f) => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl) })
    setPendingFiles([])
    setPendingStickers([])
    setPendingGifs([])
    knownHashesRef.current.clear()
    clearFileDraft(draftKey)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setIsNsfw(false)
    onCancelReply()

    // Add GIFs as proper attachments (same format as normal media uploads)
    if (sentGifs.length > 0) {
      for (const g of sentGifs) {
        // Extract hash from blossom URL: https://server/HASH.ext
        const hashMatch = g.url.match(/\/([a-f0-9]{64})\.(\w+)(?:\?|$)/i)
        if (hashMatch) {
          attachments.push({
            hash: hashMatch[1],
            type: 'image/gif',
            name: `${g.name || 'gif'}.gif`,
            size: 0,
          })
        }
      }
    }

    try {
      await sendMessage(
        text,
        replyContext ? { pubkey: replyContext.pubkey, dTag: replyContext.dTag, eventId: replyContext.eventId } : undefined,
        (phase, relayProgress, sentDTag) => {
          setOptimisticMessages((prev) =>
            prev.map((m) => {
              if (m.tempId !== tempId) return m
              // On first relay confirm, mark as published so UI transitions
              if (phase === 'publishing' && relayProgress && relayProgress.confirmed > 0) {
                return { ...m, status: 'published' as const, relayProgress, sentDTag: sentDTag || m.sentDTag }
              }
              return { ...m, status: phase, relayProgress: relayProgress || m.relayProgress, sentDTag: sentDTag || m.sentDTag }
            })
          )
        },
        replyContext?.rootRef,
        attachments.length > 0 ? attachments : undefined,
        sentNsfw || undefined,
        replyContext?.isThread || undefined,
        isEncrypted,
        hubPrefs?.facilitator || undefined,
        undefined, // forumFields
        sentStickers.length > 0
          ? sentStickers.map((s): [string, string, string, string] => ['sticker', s.shortcode, s.url, s.setAddress])
          : undefined,
        sentGifs.length > 0
          ? sentGifs.map((g): [string, string, string, string] => ['j', g.name, g.url, g.nsfw ? 'nsfw' : 'sfw'])
          : undefined
      )
      // All relays responded — mark as published.
      // Cleanup happens via the reconciliation effect when the real
      // decrypted message appears in the message list — no fixed timer.
      setOptimisticMessages((prev) =>
        prev.map((m) => (m.tempId === tempId ? { ...m, status: 'published' as const } : m))
      )
    } catch {
      setOptimisticMessages((prev) =>
        prev.map((m) => (m.tempId === tempId ? { ...m, status: 'failed' as const } : m))
      )
    }
  }, [message, sendMessage, setOptimisticMessages, replyContext, onCancelReply, pendingFiles, allFilesSuccess, pendingStickers, pendingGifs])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // @mention autocomplete keyboard handling
    if (mentionQuery !== null && mentionSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((i) => Math.min(i + 1, mentionSuggestions.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        applyMention(mentionSuggestions[mentionIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionQuery(null)
        mentionStartRef.current = null
        return
      }
    }
    // :emoji: autocomplete keyboard handling
    if (emojiQuery !== null && emojiSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setEmojiIndex((i) => Math.min(i + 1, emojiSuggestions.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setEmojiIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        applyEmojiSuggestion(emojiSuggestions[emojiIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setEmojiQuery(null)
        emojiStartRef.current = null
        return
      }
    }
    // Tab without autocomplete → insert 3 spaces for markdown indentation
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = textareaRef.current
      if (ta) {
        const start = ta.selectionStart
        const end = ta.selectionEnd
        const spaces = '   '
        const before = message.substring(0, start)
        const after = message.substring(end)
        setMessage(`${before}${spaces}${after}`)
        requestAnimationFrame(() => {
          ta.focus()
          const pos = start + spaces.length
          ta.setSelectionRange(pos, pos)
          autoResize(ta)
        })
      }
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canSend && !isOverLimit) handleSend()
    }
  }

  // ─── Paste-to-attach: document-level listener for Ctrl+V ───
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const cd = e.clipboardData
      if (!cd) return
      const files: File[] = []
      if (cd.items) {
        for (let i = 0; i < cd.items.length; i++) {
          const item = cd.items[i]
          if (item.kind === 'file') {
            const file = item.getAsFile()
            if (file) files.push(file)
          }
        }
      }
      if (files.length === 0 && cd.files && cd.files.length > 0) {
        for (let i = 0; i < cd.files.length; i++) {
          files.push(cd.files[i])
        }
      }
      if (files.length > 0) {
        e.preventDefault()
        addFiles(files)
      }
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [addFiles])

  // ─── Custom context menu for textarea (right-click → Paste with file support) ───
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)

  // Use native listener so preventDefault() fires before the browser shows its own menu.
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    const onCtx = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setCtxMenu({ x: e.clientX, y: e.clientY })
    }
    ta.addEventListener('contextmenu', onCtx)
    return () => ta.removeEventListener('contextmenu', onCtx)
  }, [])

  // Close context menu on click-away / scroll / Escape
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [ctxMenu])

  const ctxPaste = useCallback(async () => {
    setCtxMenu(null)

    // Helper: insert text into the textarea at cursor
    const insertText = (text: string) => {
      const ta = textareaRef.current
      if (!ta || !text) return
      const start = ta.selectionStart
      const end = ta.selectionEnd
      setMessage(message.slice(0, start) + text + message.slice(end))
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + text.length
        autoResize(ta)
      })
    }

    // Helper: last-resort fallback — focus textarea and trigger native paste
    // which fires the document-level paste event our listener catches
    const execFallback = () => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      try { document.execCommand('paste') } catch { /* blocked */ }
    }

    try {
      // 1. Try Clipboard API read() for images/files
      if (navigator.clipboard && typeof navigator.clipboard.read === 'function') {
        const items = await navigator.clipboard.read()
        const files: File[] = []
        for (const item of items) {
          for (const type of item.types) {
            if (type.startsWith('image/')) {
              const blob = await item.getType(type)
              const ext = type.split('/')[1] || 'png'
              const file = new File([blob], `image.${ext}`, { type })
              files.push(file)
            }
          }
        }
        if (files.length > 0) {
          addFiles(files)
          return
        }
        // No images found — paste text
        const text = await navigator.clipboard.readText()
        insertText(text)
        return
      }
      // clipboard.read not available — try readText
      if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        const text = await navigator.clipboard.readText()
        insertText(text)
        return
      }
      // No Clipboard API at all — execCommand fallback
      execFallback()
    } catch {
      // clipboard.read() or readText() threw (permission denied / unsupported)
      try {
        const text = await navigator.clipboard.readText()
        insertText(text)
      } catch {
        // Everything failed — try native execCommand as last resort
        execFallback()
      }
    }
  }, [addFiles, message, setMessage, autoResize])

  const ctxPasteTextOnly = useCallback(async () => {
    setCtxMenu(null)
    try {
      const text = await navigator.clipboard.readText()
      if (text && textareaRef.current) {
        const ta = textareaRef.current
        const start = ta.selectionStart
        const end = ta.selectionEnd
        setMessage(message.slice(0, start) + text + message.slice(end))
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + text.length
          autoResize(ta)
        })
      }
    } catch {
      // Fallback for browsers without clipboard permission
      const ta = textareaRef.current
      if (ta) { ta.focus(); try { document.execCommand('paste') } catch { /* blocked */ } }
    }
  }, [message, setMessage, autoResize])

  const ctxCut = useCallback(() => {
    setCtxMenu(null)
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    if (start === end) return
    const selected = message.slice(start, end)
    navigator.clipboard.writeText(selected)
    setMessage(message.slice(0, start) + message.slice(end))
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start
      autoResize(ta)
    })
  }, [message, setMessage, autoResize])

  const ctxCopy = useCallback(() => {
    setCtxMenu(null)
    const ta = textareaRef.current
    if (!ta) return
    const selected = message.slice(ta.selectionStart, ta.selectionEnd)
    if (selected) navigator.clipboard.writeText(selected)
  }, [message])

  const ctxSelectAll = useCallback(() => {
    setCtxMenu(null)
    const ta = textareaRef.current
    if (!ta) return
    ta.focus()
    ta.selectionStart = 0
    ta.selectionEnd = message.length
  }, [message])

  // ─── Drag & Drop (scoped to dragContainerRef) ───

  useEffect(() => {
    const el = dragContainerRef?.current
    if (!el) return
    let counter = 0

    const onDragEnter = (e: DragEvent) => {
      e.preventDefault(); e.stopPropagation()
      counter++
      if (e.dataTransfer?.types.includes('Files')) setIsDragging(true)
    }
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault(); e.stopPropagation()
      counter--
      if (counter === 0) setIsDragging(false)
    }
    const onDragOver = (e: DragEvent) => {
      e.preventDefault(); e.stopPropagation()
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault(); e.stopPropagation()
      counter = 0
      setIsDragging(false)
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        addFiles(Array.from(e.dataTransfer.files))
      }
    }

    el.addEventListener('dragenter', onDragEnter)
    el.addEventListener('dragleave', onDragLeave)
    el.addEventListener('dragover', onDragOver)
    el.addEventListener('drop', onDrop)
    return () => {
      el.removeEventListener('dragenter', onDragEnter)
      el.removeEventListener('dragleave', onDragLeave)
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('drop', onDrop)
    }
  }, [dragContainerRef, addFiles])

  if (!canPublish) {
    // Determine reason for read-only
    const _hubMembers = useHubStore.getState().hubMembers[hubDTag]
    const _pubkey = useUserStore.getState().pubkey
    const _hub = useHubStore.getState().hubs[hubDTag]
    const _isOwner = !!(_pubkey && _hub && (_hub.creatorPubkey === _pubkey || _hub.ownerRealPubkey === _pubkey))
    const _isMemberOrFacilitated = _isOwner || (_pubkey && (_hubMembers?.some(m => m.pubkey === _pubkey) || false))
    const reason = _isMemberOrFacilitated
      ? 'You do not have permission to send messages in this channel.'
      : 'You must be a member to send messages in this hub.'
    return (
      <div className={bare ? '' : 'px-2 pb-2'}>
        <div className="flex items-center gap-2 px-4 py-3 rounded-xl border border-border bg-secondary/30">
          <Lock size={14} className="text-muted-foreground shrink-0" />
          <span className="text-sm text-muted-foreground">{reason}</span>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Drop overlay — rendered via portal into the channel container */}
      {isDragging && dragContainerRef?.current && createPortal(
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="rounded-xl border-2 border-dashed border-primary px-12 py-8 flex flex-col items-center gap-2 text-primary bg-background/60">
            <Upload size={24} />
            <span className="text-sm font-medium">Drop files here</span>
          </div>
        </div>,
        dragContainerRef.current
      )}

      {!threadRootRef && (
        <TypingIndicator
          convKey={hubTypingKey(hubDTag, channelId)}
          resolveName={(pk) => { const p = getProfile(pk); return p?.display_name || p?.name || npubShort(pk) }}
          className="px-3 pb-1"
        />
      )}

      <div
        className={bare ? '' : 'px-2 pb-2'}
      >
        {/* Reply indicator — hidden when hideReplyBanner is set (e.g. default thread context) */}
        {replyContext && !hideReplyBanner && (
          <div className="flex items-center gap-2 px-3 py-1.5 mb-1 bg-secondary/50 rounded-t-xl border border-border border-b-0 text-xs text-muted-foreground">
            <Reply size={12} className="shrink-0" />
            <span>{replyContext.isThread ? 'Thread replying to' : 'Replying to'} <strong className="text-foreground">{replyContext.displayName}</strong></span>
            <span className="truncate flex-1 opacity-60">{replyContext.preview}</span>
            <button onClick={onCancelReply} className="p-0.5 rounded cursor-pointer hover:text-foreground transition-colors">
              <X size={14} />
            </button>
          </div>
        )}

        {/* Markdown toolbar */}
        {showToolbar && (
          <TooltipProvider delayDuration={200}>
            <div className={`flex flex-wrap items-center gap-0.5 px-3 py-1.5 bg-secondary/80 border border-border border-b-0 ${replyContext ? '' : 'rounded-t-xl'}`}>
              {[
                { icon: Bold, action: () => insertMarkdown('**', '**', 'bold'), tip: 'Bold' },
                { icon: Italic, action: () => insertMarkdown('*', '*', 'italic'), tip: 'Italic' },
                { icon: Strikethrough, action: () => insertMarkdown('~~', '~~', 'strikethrough'), tip: 'Strikethrough' },
                { icon: Heading1, action: () => insertLinePrefix('# '), tip: 'Heading 1' },
                { icon: Heading2, action: () => insertLinePrefix('## '), tip: 'Heading 2' },
                { icon: Heading3, action: () => insertLinePrefix('### '), tip: 'Heading 3' },
                { icon: Heading4, action: () => insertLinePrefix('#### '), tip: 'Heading 4' },
                { icon: Heading5, action: () => insertLinePrefix('##### '), tip: 'Heading 5' },
                { icon: Heading6, action: () => insertLinePrefix('###### '), tip: 'Heading 6' },
                { icon: List, action: () => insertLinePrefix('- '), tip: 'Bullet List' },
                { icon: ListOrdered, action: () => insertLinePrefix('1. '), tip: 'Numbered List' },
                { icon: Link, action: () => insertMarkdown('[', '](url)', 'text'), tip: 'Link' },
                { icon: Code, action: () => insertMarkdown('`', '`', 'code'), tip: 'Inline Code' },
                { icon: CodeSquare, action: () => insertMarkdown('```\n', '\n```', 'code'), tip: 'Code Block' },
                { icon: Eye, action: () => insertMarkdown('||', '||', 'spoiler'), tip: 'Spoiler' },
              ].map(({ icon: Icon, action, tip }) => (
                <Tooltip key={tip}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={action}
                      className="p-1.5 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                    >
                      <Icon size={16} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    {tip}
                  </TooltipContent>
                </Tooltip>
              ))}
              {/* Clock button + popover — wrapped in relative so popover appears above the button */}
              <div className="relative">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      ref={timestampButtonRef}
                      onClick={() => setShowTimestamp(!showTimestamp)}
                      className="p-1.5 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                    >
                      <Clock size={16} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    Insert Timestamp
                  </TooltipContent>
                </Tooltip>
                {showTimestamp && (
                  <HubTimestampPickerPopover
                    triggerRef={timestampButtonRef}
                    onClose={() => setShowTimestamp(false)}
                    onInsert={(unix) => {
                      const token = `<t:${unix}>`
                      const ta = textareaRef.current
                      if (ta) {
                        const start = ta.selectionStart
                        const end = ta.selectionEnd
                        const before = message.substring(0, start)
                        const after = message.substring(end)
                        const newText = `${before}${token}${after}`
                        setMessage(newText)
                        requestAnimationFrame(() => {
                          ta.focus()
                          const pos = start + token.length
                          ta.setSelectionRange(pos, pos)
                          autoResize(ta)
                        })
                      } else {
                        setMessage(message + token)
                      }
                      setShowTimestamp(false)
                    }}
                  />
                )}
              </div>
            </div>
          </TooltipProvider>
        )}
        {/* File preview strip */}
        {pendingFiles.length > 0 && (
          <div className={`flex flex-col gap-2 px-3 py-2 bg-secondary/60 border border-border border-b-0 ${!replyContext && !showToolbar ? 'rounded-t-xl' : ''}`}>
            {/* Scrollable file cards row */}
            <div className="flex gap-2 overflow-x-auto">
              {pendingFiles.map((pf) => (
                <div key={pf.id} className="flex items-stretch bg-background rounded-lg border border-border min-w-[140px] max-w-[220px] shrink-0">
                  <div className="flex items-center gap-2 flex-1 min-w-0 px-2 py-1.5">
                    {/* Thumbnail or file icon */}
                    {pf.previewUrl ? (
                      <img src={pf.previewUrl} alt={pf.file.name} className="w-10 h-10 rounded object-cover shrink-0" />
                    ) : (
                      <div className="w-10 h-10 rounded bg-secondary flex items-center justify-center shrink-0">
                        <FileIcon size={18} className="text-muted-foreground" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-foreground truncate">{pf.file.name}</p>
                      <p className="text-[10px] text-muted-foreground">{formatFileSize(pf.file.size)}</p>
                      {/* Upload progress */}
                      {pf.status === 'uploading' && pf.progress && (
                        <div className="mt-0.5">
                          <div className="w-full h-1 rounded-full bg-secondary overflow-hidden">
                            <div className="h-full bg-amber-400 rounded-full transition-all duration-150" style={{ width: `${pf.progress.percent}%` }} />
                          </div>
                          <div className="flex items-center justify-between text-[9px] text-muted-foreground mt-0.5">
                            <span className="truncate">{shortServerName(pf.progress.serverUrl)} ({pf.progress.serverIndex + 1}/{pf.progress.totalServers})</span>
                            <span className="flex items-center gap-1">
                              {pf.progress.percent >= 100
                                ? <span className="text-amber-400">Processing...</span>
                                : formatSpeed(pf.progress.speed)
                              }
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    onClick={() => { uploadAbortRef.current?.abort(); uploadAbortRef.current = null }}
                                    className="text-muted-foreground hover:text-destructive cursor-pointer ml-0.5"
                                  >
                                    skip
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="text-xs">Skip this server</TooltipContent>
                              </Tooltip>
                            </span>
                          </div>
                        </div>
                      )}
                      {pf.status === 'encrypting' && <span className="text-[10px] text-emerald-400 flex items-center gap-1"><Lock size={9} /> Encrypting…</span>}
                      {pf.status === 'success' && (
                        pf.encryption
                          ? <span className="text-[10px] text-emerald-400 flex items-center gap-1"><Lock size={9} /> Encrypted & uploaded</span>
                          : <span className="text-[10px] text-amber-400 flex items-center gap-1"><LockOpen size={9} /> Unencrypted & uploaded</span>
                      )}
                      {pf.status === 'failed' && (
                        <button onClick={() => setPendingFiles((prev) => prev.map((f) => f.id === pf.id ? { ...f, status: 'pending' as const } : f))} className="text-[10px] text-destructive hover:underline cursor-pointer">Failed — retry</button>
                      )}
                    </div>
                  </div>
                  {/* Remove button — full-height column */}
                  {pf.status !== 'uploading' && (
                    <button
                      onClick={() => removeFile(pf.id)}
                      className="flex items-center justify-center px-1.5 border-l border-border text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer transition-colors rounded-r-lg"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {/* Upload button + status — always visible below scroll */}
            <div className="flex items-center gap-2">
              {/* Encryption toggle — sits to the LEFT of the Upload button; the full privacy explanation
                  is the tooltip on the toggle box itself. */}
              {pendingFiles.some((f) => f.status === 'pending' || f.status === 'failed') && !isUploading && (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={toggleEncryptUploads}
                        className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer select-none"
                        style={{ background: encryptUploads ? 'rgba(16,185,129,0.06)' : 'rgba(245,158,11,0.06)', border: `1px solid ${encryptUploads ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)'}` }}
                      >
                        <div className={`relative w-8 h-4 rounded-full shrink-0 transition-colors ${encryptUploads ? 'bg-emerald-500' : 'bg-muted-foreground/30'}`}>
                          <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${encryptUploads ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                        </div>
                        <span className={encryptUploads ? 'text-emerald-500/90' : 'text-amber-500/90'}>{encryptUploads ? 'Encrypted' : 'Not encrypted'}</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs max-w-[260px] leading-snug">
                      {encryptUploads
                        ? 'Files will be encrypted before upload — only chat participants can view them, but images/video/audio must fully download before displaying.'
                        : 'Media uploads are not encrypted — blossom server operators can view uploaded files, but images/video/audio are streamed immediately.'}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              {pendingFiles.some((f) => f.status === 'pending' || f.status === 'failed') && !isUploading && (
                <button
                  onClick={handleUploadFiles}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/50 bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors cursor-pointer"
                >
                  <Upload size={14} />
                  Upload {pendingFiles.filter((f) => f.status === 'pending' || f.status === 'failed').length} file{pendingFiles.filter((f) => f.status === 'pending' || f.status === 'failed').length > 1 ? 's' : ''}
                </button>
              )}
              {isUploading && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" />
                  Uploading...
                </div>
              )}
            </div>
          </div>
        )}

        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />

        {/* Custom emoji preview strip */}
        {detectedEmojis.length > 0 && (
          <div className={`flex items-center gap-1.5 px-3 py-1 bg-secondary/60 border border-border border-b-0 ${(replyContext && !hideReplyBanner) || showToolbar || pendingFiles.length > 0 ? '' : 'rounded-t-md'}`}>
            <span className="text-[10px] text-muted-foreground shrink-0">Emojis:</span>
            {detectedEmojis.map((e) => (
              <TooltipProvider key={e.shortcode} delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <img src={e.url} alt={`:${e.shortcode}:`} className="h-5 w-5 object-contain" loading="lazy" />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">:{e.shortcode}:</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ))}
          </div>
        )}

        {/* Pending stickers strip */}
        {pendingStickers.length > 0 && (
          <div className={`flex flex-col gap-2 px-3 py-2 bg-secondary/60 border border-border border-b-0 ${(replyContext && !hideReplyBanner) || showToolbar || pendingFiles.length > 0 || detectedEmojis.length > 0 ? '' : 'rounded-t-md'}`}>
            <div className="flex gap-2 overflow-x-auto">
              {pendingStickers.map((st, i) => (
                <div key={`${st.shortcode}-${i}`} className="flex items-stretch bg-background rounded-lg border border-border min-w-[140px] max-w-[220px] shrink-0">
                  <div className="flex items-center gap-2 flex-1 min-w-0 px-2 py-1.5">
                    <img src={st.url} alt={`:${st.shortcode}:`} className="w-10 h-10 object-contain rounded shrink-0" loading="lazy" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-foreground truncate">:{st.shortcode}:</p>
                      <p className="text-[10px] text-muted-foreground">Sticker</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setPendingStickers((prev) => prev.filter((_, idx) => idx !== i))}
                    className="flex items-center justify-center px-1.5 border-l border-border text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer transition-colors rounded-r-lg"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Pending GIFs strip */}
        {pendingGifs.length > 0 && (
          <div className={`flex flex-col gap-2 px-3 py-2 bg-secondary/60 border border-border border-b-0 ${(replyContext && !hideReplyBanner) || showToolbar || pendingFiles.length > 0 || detectedEmojis.length > 0 || pendingStickers.length > 0 ? '' : 'rounded-t-md'}`}>
            <div className="flex gap-2 overflow-x-auto">
              {pendingGifs.map((g, i) => (
                <div key={`${g.url}-${i}`} className="flex items-stretch bg-background rounded-lg border border-border min-w-[140px] max-w-[220px] shrink-0">
                  <div className="flex items-center gap-2 flex-1 min-w-0 px-2 py-1.5">
                    <img src={g.url} alt={g.name || 'GIF'} className="w-10 h-10 object-cover rounded shrink-0" loading="lazy" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-foreground truncate">{g.name || 'GIF'}</p>
                      <p className="text-[10px] text-muted-foreground">{g.nsfw ? 'GIF · NSFW' : 'GIF'}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setPendingGifs((prev) => prev.filter((_, idx) => idx !== i))}
                    className="flex items-center justify-center px-1.5 border-l border-border text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer transition-colors rounded-r-lg"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className={`relative flex items-center gap-2 px-3 py-2 bg-secondary border border-border ${(replyContext && !hideReplyBanner) || showToolbar || pendingFiles.length > 0 || detectedEmojis.length > 0 || pendingStickers.length > 0 || pendingGifs.length > 0 ? 'rounded-b-md' : 'rounded-md'} max-[1080px]:flex-wrap`}>
          <TooltipProvider delayDuration={300}>
            {inputPerms.attach_files && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={() => fileInputRef.current?.click()} className="p-1 cursor-pointer text-muted-foreground hover:text-foreground transition-colors">
                    <Plus size={20} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">Attach files</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={() => setShowToolbar(!showToolbar)} className={`p-1 cursor-pointer transition-colors ${showToolbar ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
                  <ALargeSmall size={20} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">Formatting toolbar</TooltipContent>
            </Tooltip>
            {/* Encryption is always on when key available — no toggle needed */}
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
            {/* Encryption is always on when key available — no toggle needed */}
          </TooltipProvider>



          {/* @mention suggestion dropdown */}
          {mentionQuery !== null && mentionSuggestions.length > 0 && (
            <div
              ref={mentionListRef}
              className="absolute bottom-full left-0 right-0 mb-1 mx-2 bg-popover/95 backdrop-blur-md border border-border rounded-lg shadow-xl overflow-hidden z-50 max-h-[240px] overflow-y-auto"
            >
              {mentionSuggestions.map((s, i) => {
                const key = s.type === 'user' ? s.pubkey : s.type === 'group' ? s.keyword : s.type === 'channel' ? s.channelId : s.roleId
                return (
                  <button
                    key={key}
                    onMouseDown={(e) => { e.preventDefault(); applyMention(s) }}
                    onMouseEnter={() => setMentionIndex(i)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors cursor-pointer ${i === mentionIndex ? 'bg-primary/15' : 'hover:bg-accent/40'
                      }`}
                  >
                    {s.type === 'user' ? (
                      /* ── User mention row ── */
                      <>
                        <Avatar className="h-6 w-6 shrink-0">
                          {s.picture && <AvatarImage src={s.picture} />}
                          <AvatarFallback className="text-[9px] bg-primary/20 text-primary">
                            {(s.name || s.npub.slice(5, 7)).slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <span className="text-sm font-medium text-foreground truncate flex items-center gap-1">
                            {s.name || truncateNpub(s.npub)}
                            {s.dnnId && (
                              <span className="inline-flex items-center gap-0.5 text-[10px] text-primary font-medium shrink-0">
                                @{formatDnnId(s.dnnId)}
                                <BadgeCheck size={11} className="text-primary" />
                              </span>
                            )}
                          </span>
                          {s.name && (
                            <span className="text-[10px] text-muted-foreground truncate block">
                              {truncateNpub(s.npub)}
                            </span>
                          )}
                        </div>
                      </>
                    ) : s.type === 'group' ? (
                      /* ── Group mention row (@everyone / @here) ── */
                      <>
                        <div className="h-6 w-6 shrink-0 rounded-full bg-amber-500/20 flex items-center justify-center">
                          {s.keyword === 'everyone' ? (
                            <Globe size={13} className="text-amber-400" />
                          ) : (
                            <Radio size={13} className="text-amber-400" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <span className="text-sm font-semibold text-amber-400 truncate block">
                            {s.label}
                          </span>
                          <span className="text-[10px] text-muted-foreground truncate block">
                            {s.description}
                          </span>
                        </div>
                      </>
                    ) : s.type === 'channel' ? (
                      /* ── Channel mention row (#channel) ── */
                      <>
                        <div className="h-6 w-6 shrink-0 rounded-full bg-primary/15 flex items-center justify-center">
                          <Hash size={13} className="text-primary" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <span className="text-sm font-semibold text-primary truncate block">#{s.channelName}</span>
                          <span className="text-[10px] text-muted-foreground truncate block">
                            {s.categoryName ? s.categoryName : 'Uncategorized'}
                            {s.position != null && <span className="text-muted-foreground/60"> · #{s.position}</span>}
                          </span>
                        </div>
                      </>
                    ) : (
                      /* ── Role mention row ── */
                      <>
                        <div
                          className="h-6 w-6 shrink-0 rounded-full flex items-center justify-center bg-secondary"
                        >
                          <Shield size={13} style={{ color: s.color || 'hsl(var(--primary))' }} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <span className="text-sm font-semibold truncate block" style={{ color: s.color || 'hsl(var(--primary))' }}>
                            @{s.roleName}
                          </span>
                          <span className="text-[10px] text-muted-foreground truncate block">
                            Notify all members with this role
                          </span>
                        </div>
                      </>
                    )}
                  </button>
                )
              })}
            </div>
          )}

          {/* :emoji: suggestion dropdown */}
          {emojiQuery !== null && emojiSuggestions.length > 0 && (
            <div
              ref={emojiListRef}
              className="absolute bottom-full left-0 right-0 mb-1 mx-2 bg-popover/95 backdrop-blur-md border border-border rounded-lg shadow-xl overflow-hidden z-50 max-h-[240px] overflow-y-auto"
            >
              {emojiSuggestions.map((s, i) => (
                <button
                  key={s.shortcode}
                  onMouseDown={(e) => { e.preventDefault(); applyEmojiSuggestion(s) }}
                  onMouseEnter={() => setEmojiIndex(i)}
                  className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors cursor-pointer ${i === emojiIndex ? 'bg-primary/15' : 'hover:bg-accent/40'
                    }`}
                >
                  <img src={s.url} alt={`:${s.shortcode}:`} className="h-6 w-6 object-contain shrink-0" loading="lazy" />
                  <span className="text-sm text-foreground truncate">:{s.shortcode}:</span>
                </button>
              ))}
            </div>
          )}

          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button ref={emojiButtonRef} onClick={() => setShowEmoji(!showEmoji)} className="p-1 cursor-pointer text-muted-foreground hover:text-foreground transition-colors min-[1081px]:order-1">
                  <Smile size={20} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">Emoji</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {showEmoji && (
            <EmojiPickerPopover
              anchorRef={emojiButtonRef}
              onClose={() => setShowEmoji(false)}
              onSelect={(emoji) => {
                setMessage((prev) => prev + emoji)
                setShowEmoji(false)
                textareaRef.current?.focus()
              }}
            />
          )}

          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button ref={stickerButtonRef} onClick={() => setShowSticker(!showSticker)} className="p-1 cursor-pointer text-muted-foreground hover:text-foreground transition-colors min-[1081px]:order-1">
                  <Sticker size={20} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">Stickers</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {showSticker && (
            <StickerPickerPopover
              anchorRef={stickerButtonRef}
              onClose={() => setShowSticker(false)}
              onSelect={(sticker) => {
                setPendingStickers((prev) => [...prev, sticker])
                setShowSticker(false)
                textareaRef.current?.focus()
              }}
            />
          )}

          {/* GIF picker */}
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button ref={gifButtonRef} onClick={() => setShowGif(!showGif)} className="p-1 cursor-pointer text-muted-foreground hover:text-foreground transition-colors min-[1081px]:order-1">
                  <ImagePlay size={20} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">GIFs</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {showGif && (
            <GifPickerPopover
              anchorRef={gifButtonRef}
              onClose={() => setShowGif(false)}
              onSelect={(gif) => {
                setPendingGifs((prev) => [...prev, gif])
                setShowGif(false)
                textareaRef.current?.focus()
              }}
            />
          )}

          {/* Voice note */}
          {inputPerms.attach_files && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={() => setShowVoiceNote(true)} className="p-1 cursor-pointer text-muted-foreground hover:text-foreground transition-colors min-[1081px]:order-1">
                    <Mic size={20} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">Voice Note</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {showVoiceNote && (
            <VoiceNoteModal
              onAttach={(file) => { addFiles([file]); setShowVoiceNote(false) }}
              onClose={() => setShowVoiceNote(false)}
            />
          )}

          {/* Poll creator */}
          {inputPerms.create_polls && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={() => setShowPollModal(true)} className="p-1 cursor-pointer text-muted-foreground hover:text-foreground transition-colors min-[1081px]:order-1">
                    <Vote size={20} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">Create Poll</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* Mobile: flex-break + divider between button row and textarea row */}
          <div className="hidden max-[1080px]:block basis-full h-px bg-border/30 order-[1]" aria-hidden />

          {/* Textarea — on mobile, drops to its own row below the buttons */}
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => {
              setMessage(e.target.value)
              autoResize(e.target)
              updateMentionQuery(e.target.value, e.target.selectionStart)
              updateEmojiQuery(e.target.value, e.target.selectionStart)
              signalTyping(e.target.value)
            }}
            onKeyDown={handleKeyDown}
            onClick={(e) => {
              updateMentionQuery(message, (e.target as HTMLTextAreaElement).selectionStart)
              updateEmojiQuery(message, (e.target as HTMLTextAreaElement).selectionStart)
            }}
            placeholder={`Message #${channelName}`}
            className="flex-1 p-2 bg-transparent resize-none outline-none text-sm min-h-[32px] text-foreground placeholder:text-muted-foreground rounded-sm max-[1080px]:order-[2]"
            style={{ maxHeight: '500px', overflowY: 'auto' }}
            rows={1}
          />

          {/* Custom context menu (right-click) */}
          {ctxMenu && createPortal(
            <div
              ref={(el) => {
                if (!el) return
                const rect = el.getBoundingClientRect()
                let x = ctxMenu.x
                let y = ctxMenu.y
                if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4
                if (x < 4) x = 4
                if (y + rect.height > window.innerHeight) y = ctxMenu.y - rect.height
                if (y < 4) y = 4
                el.style.left = `${x}px`
                el.style.top = `${y}px`
                el.style.opacity = '1'
              }}
              className="fixed z-[9999] w-48 bg-popover border border-border rounded-md shadow-lg p-1 flex flex-col gap-1"
              style={{ left: -9999, top: -9999, opacity: 0 }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                onMouseDown={(e) => { e.stopPropagation(); ctxCut() }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
              >
                <Scissors size={14} /> Cut
              </button>
              <button
                onMouseDown={(e) => { e.stopPropagation(); ctxCopy() }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
              >
                <Copy size={14} /> Copy
              </button>
              <button
                onMouseDown={(e) => { e.stopPropagation(); ctxPaste() }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
              >
                <ClipboardPaste size={14} /> Paste
              </button>
              <button
                onMouseDown={(e) => { e.stopPropagation(); ctxPasteTextOnly() }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
              >
                <Type size={14} /> Paste as text
              </button>
              <div className="h-px bg-border mx-2" />
              <button
                onMouseDown={(e) => { e.stopPropagation(); ctxSelectAll() }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground/80 hover:bg-accent/50 cursor-pointer transition-colors rounded-md"
              >
                <ALargeSmall size={14} /> Select all
              </button>
            </div>,
            document.body
          )}

          {/* Character counter */}
          {showCharCounter && (
            <span className={`text-[11px] font-mono tabular-nums select-none transition-colors min-[1081px]:order-1 max-[1080px]:order-[2] ${
              isOverLimit ? 'text-red-400 font-semibold' : charsRemaining <= 100 ? 'text-amber-400' : 'text-muted-foreground/60'
            }`}>
              {charsRemaining}
            </span>
          )}

          {canSend && (
            <Button onClick={handleSend} size="icon" className="h-8 w-8 min-[1081px]:order-1 max-[1080px]:order-[2]">
              <Send size={16} />
            </Button>
          )}
        </div>
      </div>

      {/* Poll creation modal */}
      {showPollModal && hubDTag && channelId && (
        <CreatePollModal
          hubDTag={hubDTag}
          channelId={channelId}
          onClose={() => setShowPollModal(false)}
        />
      )}

      {/* File size limit warning modal */}
      {fileSizeWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm" onClick={() => setFileSizeWarning(null)}>
          <div className="w-[400px] bg-card border border-border rounded-xl shadow-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <AlertTriangle size={18} className="text-amber-500 shrink-0" />
              <h4 className="text-sm font-semibold text-foreground">File Too Large</h4>
            </div>
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                The following file{fileSizeWarning.names.length > 1 ? 's exceed' : ' exceeds'} the {fileSizeWarning.limitMb} MB upload limit and {fileSizeWarning.names.length > 1 ? 'were' : 'was'} not added:
              </p>
              <div className="space-y-1">
                {fileSizeWarning.names.map((name) => (
                  <div key={name} className="text-xs font-mono text-foreground bg-secondary/50 px-2 py-1 rounded truncate">{name}</div>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground">
                This soft limit improves upload success rates across blossom servers. You can change it in <strong>Settings â†’ Network â†’ Media Upload Limit</strong>.
              </p>
            </div>
            <button onClick={() => setFileSizeWarning(null)} className="w-full h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer">
              Got it
            </button>
          </div>
        </div>
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
                  This emoji is part of set <span className="font-mono text-foreground/80">{setNameFromAddress(clickedEmoji.setAddress)}</span>
                </p>
                <button
                  onClick={() => {
                    // setAddress format: 30030:pubkey:dtag
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

      {/* Standalone discovery modal (from emoji click) */}
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

      {/* Standalone sticker discovery modal (from sticker click) */}
      {stickerDiscoverSearch && (
        <StickerDiscoveryModal
          onClose={() => setStickerDiscoverSearch(null)}
          initialSearch={stickerDiscoverSearch.search}
          initialAuthor={stickerDiscoverSearch.author}
        />
      )}
    </>
  )
}

// â”€â”€ Raw Event Modal â”€â”€

export function RawEventModal({ rawJson, decryptedContent, isDecrypted, onClose, hideDecryptedTab }: {
  rawJson: string
  decryptedContent: string
  isDecrypted: boolean
  onClose: () => void
  hideDecryptedTab?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [activeTab, setActiveTab] = useState<'raw' | 'decrypted'>('raw')

  let prettyRaw: string
  try {
    prettyRaw = JSON.stringify(JSON.parse(rawJson), null, 2)
  } catch {
    prettyRaw = rawJson
  }

  // Try to prettify decrypted content (might be JSON with attachments)
  let prettyDecrypted: string
  if (!isDecrypted) {
    prettyDecrypted = ''
  } else {
    try {
      prettyDecrypted = JSON.stringify(JSON.parse(decryptedContent), null, 2)
    } catch {
      prettyDecrypted = decryptedContent
    }
  }

  const currentContent = activeTab === 'raw' ? prettyRaw : prettyDecrypted

  const handleCopy = () => {
    navigator.clipboard.writeText(currentContent)
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
          {/* Tabs */}
          <div className="flex items-center gap-1">
            {hideDecryptedTab ? (
              <span className="px-2.5 py-1 text-xs font-medium text-foreground">Raw Event</span>
            ) : (
              <>
                <button
                  onClick={() => { setActiveTab('raw'); setCopied(false) }}
                  className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer transition-colors ${activeTab === 'raw'
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                    }`}
                >
                  Raw Event
                </button>
                <button
                  onClick={() => { setActiveTab('decrypted'); setCopied(false) }}
                  className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer transition-colors ${activeTab === 'decrypted'
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                    }`}
                >
                  Decrypted
                </button>
              </>
            )}
          </div>
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
          {activeTab === 'decrypted' && !isDecrypted ? (
            <div className="flex flex-col items-center justify-center py-8 gap-2 text-muted-foreground">
              <Lock size={20} />
              <span className="text-sm">Unable to decrypt</span>
              <span className="text-xs text-muted-foreground/60">You don't have the decryption key for this message.</span>
            </div>
          ) : (
            <pre className="text-xs text-foreground/80 font-mono whitespace-pre-wrap break-words">{currentContent}</pre>
          )}
        </div>
      </div>
    </div>
  )
}

/* ────────────── Message History Modal ────────────── */

interface HistoryVersion {
  id: string
  content: string
  createdAt: number
  isLatest: boolean
}

export function MessageHistoryModal({ pubkey, dTag, hubDTag, channelId, onClose }: {
  pubkey: string
  dTag: string
  hubDTag?: string
  channelId?: string
  onClose: () => void
}) {
  const [versions, setVersions] = useState<HistoryVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Hub state for key derivation
  const hubs = useHubStore((s) => s.hubs)
  const hubSecrets = useHubStore((s) => s.hubSecrets)
  const epochSecrets = useHubStore((s) => s.epochSecrets)
  const groupSecrets = useHubStore((s) => s.groupSecrets)
  const groupEpochSecrets = useHubStore((s) => s.groupEpochSecrets)

  useEffect(() => {
    let cancelled = false

    async function fetchHistory() {
      try {
        // Fetch all versions of this addressable event from relays
        // Most relays delete old versions, but some keep them — this is best-effort
        // Query both the hub's declared relays AND the user's configured relays
        // to maximize chances of finding historical versions
        const hub = hubDTag ? hubs[hubDTag] : undefined
        const hubRelays = hub
          ? [...(hub.generalRelays || [])]
          : []
        const userRelays = getRelays()
        const allRelays = [...new Set([...hubRelays, ...userRelays])]

        const events = await fetchEventsFromRelays(allRelays, {
          kinds: [36943],
          authors: [pubkey],
          '#d': [dTag],
        })

        if (cancelled) return

        if (events.length === 0) {
          setError('No versions found')
          setLoading(false)
          return
        }

        // Sort by created_at descending (newest first)
        const sorted = events.sort((a, b) => b.created_at - a.created_at)

        // Lazy-load decryption deps
        const { aesDecrypt } = await import('@/lib/crypto/aes')
        const { deriveChannelKey } = await import('@/lib/crypto/hkdf')

        // Try to decrypt content for each event
        const parsed: HistoryVersion[] = []
        for (let i = 0; i < sorted.length; i++) {
          const event = sorted[i]
          let content = event.content
          let decrypted = false

          // Derive the channel key from hub secret + epoch for this event version
          const evtHub = event.tags.find((t) => t[0] === 'h')?.[1] || hubDTag
          const evtChannel = event.tags.find((t) => t[0] === 'c')?.[1] || channelId
          const evtEpoch = parseInt(event.tags.find((t) => t[0] === 'epoch')?.[1] || '1', 10)

          if (evtHub && evtChannel) {
            const hub = hubs[evtHub]
            const channel = hub?.channels.find(ch => ch.channelId === evtChannel)

            // Determine if this channel uses a group key or hub-wide key
            let groupId: string | null = null
            if (channel?.encryption) {
              groupId = channel.encryption
            } else if (channel?.synced && channel.categoryId) {
              const cat = hub?.categories.find(c => c.categoryId === channel.categoryId)
              if (cat?.encryption) groupId = cat.encryption
            }

            let secretHex: string | undefined
            if (groupId) {
              const group = hub?.groupedRoles?.find(g => g.groupId === groupId)
              const currentGroupEpoch = group?.epoch || 1
              if (evtEpoch === currentGroupEpoch) {
                secretHex = groupSecrets[evtHub]?.[groupId]
              } else {
                secretHex = groupEpochSecrets[evtHub]?.[groupId]?.[evtEpoch] || groupSecrets[evtHub]?.[groupId]
              }
            } else {
              const currentEpoch = hub?.epoch || 1
              if (evtEpoch === currentEpoch) {
                secretHex = hubSecrets[evtHub]
              } else {
                secretHex = epochSecrets[evtHub]?.[evtEpoch] || hubSecrets[evtHub]
              }
            }

            if (secretHex) {
              try {
                const secret = new Uint8Array(secretHex.length / 2)
                for (let j = 0; j < secretHex.length; j += 2) {
                  secret[j / 2] = parseInt(secretHex.substring(j, j + 2), 16)
                }
                const key = deriveChannelKey(secret, evtChannel, evtEpoch)
                content = await aesDecrypt(key, content)
                decrypted = true
              } catch {
                // Wrong key or not encrypted — leave as-is
              }
            }
          }

          // Try to parse JSON content (hub messages wrap text in a JSON payload)
          if (decrypted) {
            try {
              const obj = JSON.parse(content)
              if (obj.text !== undefined) content = obj.text
            } catch {
              // Not JSON — use raw content as-is
            }
          }

          parsed.push({
            id: event.id,
            content: decrypted ? content : '[Encrypted]',
            createdAt: event.created_at,
            isLatest: i === 0,
          })
        }

        setVersions(parsed)
      } catch (err) {
        if (!cancelled) setError('Failed to fetch history')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchHistory()
    return () => { cancelled = true }
  }, [pubkey, dTag, hubDTag, channelId, hubs, hubSecrets, epochSecrets, groupSecrets, groupEpochSecrets])

  const formatDate = (ts: number) => {
    const d = new Date(ts * 1000)
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    })
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-secondary border border-border rounded-lg shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <History size={14} className="text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">Message History</span>
            {!loading && versions.length > 0 && (
              <span className="text-xs text-muted-foreground/60 tabular-nums">
                {versions.length} version{versions.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 cursor-pointer transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Content */}
        <div className="overflow-auto flex-1">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 size={20} className="animate-spin text-primary" />
              <span className="text-sm text-muted-foreground">Fetching versions from relays…</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
              <AlertCircle size={20} />
              <span className="text-sm">{error}</span>
            </div>
          ) : versions.length === 1 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
              <History size={20} />
              <span className="text-sm">No previous versions found</span>
              <span className="text-xs text-muted-foreground/60">This message has not been edited, or relays have discarded older versions.</span>
            </div>
          ) : (
            <div className="p-3 space-y-0">
              {versions.map((v, i) => (
                <div key={v.id} className="relative pl-6">
                  {/* Timeline line */}
                  {i < versions.length - 1 && (
                    <div className="absolute left-[9px] top-5 bottom-0 w-px bg-border" />
                  )}
                  {/* Timeline dot */}
                  <div className={`absolute left-0.5 top-1.5 w-3 h-3 rounded-full border-2 ${v.isLatest
                    ? 'border-primary bg-primary'
                    : 'border-muted-foreground/40 bg-secondary'
                    }`} />
                  {/* Version card */}
                  <div className={`mb-3 rounded-lg px-3 py-2.5 ${v.isLatest ? 'bg-primary/5 border border-primary/20' : 'bg-muted/30 border border-border/50'
                    }`}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-xs text-muted-foreground tabular-nums">{formatDate(v.createdAt)}</span>
                      {v.isLatest && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary/15 text-primary">
                          Current
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-foreground/90 break-words whitespace-pre-wrap">
                      {v.content || <span className="italic text-muted-foreground">Empty message</span>}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer disclaimer */}
        <div className="px-4 py-2.5 border-t border-border/50">
          <p className="text-[10px] text-muted-foreground/50 text-center leading-relaxed">
            Best effort — most relays discard old versions of messages. Results are not guaranteed.
          </p>
        </div>
      </div>
    </div>
  )
}

/* ────────────── Encrypted Message Card ────────────── */

/** Cache join-request checks per hub to avoid re-querying relays on every message render */
const joinRequestCache = new Map<string, 'pending' | 'none' | 'checking'>()

function EncryptedMessageCard({ hubDTag }: { hubDTag?: string }) {
  const myPubkey = useUserStore((s) => s.pubkey)
  const failReason = useHubStore((s) => hubDTag ? s.hubSecretFailReason[hubDTag] : undefined)
  const [status, setStatus] = useState<'pending' | 'none' | 'checking'>(() => {
    if (!hubDTag || !myPubkey) return 'none'
    return joinRequestCache.get(`${myPubkey}:${hubDTag}`) || 'checking'
  })

  useEffect(() => {
    // Skip join-request check if it's a signer issue (user IS a member)
    if (failReason === 'signer-issue') { setStatus('none'); return }
    if (!hubDTag || !myPubkey) { setStatus('none'); return }
    const cacheKey = `${myPubkey}:${hubDTag}`
    const cached = joinRequestCache.get(cacheKey)
    if (cached && cached !== 'checking') { setStatus(cached); return }

    joinRequestCache.set(cacheKey, 'checking')
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 3600

      ; (async () => {
        try {
          const { fetchEvents } = await import('@/lib/nostr/relay-pool')
          const { KINDS } = await import('@/lib/crypto/constants')
          const { isV2 } = await import('@/lib/hub/version')
          // v2: the join request is authored under a throwaway join-addr sub-key,
          // never under R. An authors:[R] probe would both leak R+hub to relays and
          // always return nothing, so skip it entirely on v2 (no pending badge).
          const hubForVersion = useHubStore.getState().hubs[hubDTag]
          if (hubForVersion && isV2(hubForVersion)) {
            joinRequestCache.set(cacheKey, 'none')
            setStatus('none')
            return
          }
          const events = await fetchEvents({
            kinds: [KINDS.JOIN_REQUEST],
            authors: [myPubkey],
            '#d': [hubDTag],
            since: sevenDaysAgo,
            limit: 1,
          } as any)
          const result = events.length > 0 ? 'pending' : 'none'
          joinRequestCache.set(cacheKey, result)
          setStatus(result)
        } catch {
          joinRequestCache.set(cacheKey, 'none')
          setStatus('none')
        }
      })()
  }, [hubDTag, myPubkey, failReason])

  const isPending = status === 'pending'
  const isSignerIssue = failReason === 'signer-issue'

  return (
    <div className="flex flex-col gap-2.5 py-3 px-4 my-1 rounded-lg bg-gradient-to-br from-primary/5 via-secondary/40 to-primary/5 border border-primary/20">
      <div className="flex items-center gap-2">
        <div className="flex items-center justify-center w-7 h-7 rounded-full bg-primary/10">
          <Lock size={14} className="text-primary" />
        </div>
        <span className="text-xs font-semibold text-foreground">Encrypted Message</span>
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        {isSignerIssue
          ? 'Your remote signer declined or was unavailable. Reconnect your signer and reload to decrypt these messages.'
          : isPending
            ? 'You currently don\'t have the decryption secret key to see this message. Your join request is pending — once accepted, you\'ll be able to read these messages.'
            : 'You currently don\'t have the decryption secret key to see this message. You must request to join the hub and be accepted by one of the appropriate members of the hub to see these messages properly.'
        }
      </p>
      <span
        className={cn(
          'self-start flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
          isSignerIssue
            ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
            : isPending
              ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
              : 'bg-primary/10 text-primary hover:bg-primary/20 cursor-pointer'
        )}
      >
        {isSignerIssue ? (
          <><WifiOff size={11} /> Signer unavailable</>
        ) : isPending ? (
          <><Clock size={11} /> Request pending</>
        ) : (
          <><Lock size={11} /> Request to join</>
        )}
      </span>
    </div>
  )
}

/* ────────────── Thread Modal ────────────── */

function ThreadModal({ parentMsg, threadReplies, hubDTag, channelId, getProfile, sendMessage, editMessage, deleteMessage, publishReaction, unreactReaction, getChannelKey, onClose, canPublish, initialScrollToId, onInitialScrollComplete }: {
  parentMsg: ChatMessage
  threadReplies: ChatMessage[]
  hubDTag: string
  channelId: string
  getProfile: (pubkey: string) => any
  sendMessage: (
    text: string,
    replyTo?: { pubkey: string; dTag: string },
    onPhase?: (phase: 'mining' | 'publishing', relayProgress?: { confirmed: number; total: number }) => void,
    rootRef?: string,
    attachments?: Attachment[],
    nsfw?: boolean,
    isThread?: boolean
  ) => Promise<void>
  editMessage: (dTag: string, newContent: string, replyTo?: string, rootRef?: string, forumFields?: { title: string; featuredImage?: string; tags?: string[] }, attachments?: Attachment[], nsfw?: boolean, isThread?: boolean) => Promise<void>
  deleteMessage: (dTag: string) => Promise<void>
  publishReaction: (emoji: string, targetEventId: string, targetPubkey: string, targetDTag: string, customUrl?: string) => Promise<void>
  unreactReaction: (reactionEventId: string) => Promise<void>
  getChannelKey: (epoch?: number) => Uint8Array | null
  onClose: () => void
  canPublish: boolean
  initialScrollToId?: string | null
  onInitialScrollComplete?: () => void
}) {
  const myPubkey = useUserStore((s) => s.pubkey)
  const myDisplayName = useUserStore((s) => s.displayName)
  const myAvatar = useUserStore((s) => s.avatar)
  const scrollRef = useRef<HTMLDivElement>(null)
  const modalContainerRef = useRef<HTMLDivElement>(null)

  // Editing state (local to modal)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  // Reactions: lazy-decrypt + convert to Reaction[]
  const threadHub = useHubStore((s) => s.hubs[hubDTag])
  const threadHubMembers = useHubStore((s) => s.hubMembers[hubDTag])
  const { storeReactions, reactions } = useDecryptedReactions(hubDTag, getChannelKey, threadHub, threadHubMembers, channelId)
  const allMessages = useMemo(() => [parentMsg, ...threadReplies], [parentMsg, threadReplies])

  const [rawEventData, setRawEventData] = useState<{ rawJson: string; decryptedContent: string; isDecrypted: boolean } | null>(null)
  const [deleteModalMsg, setDeleteModalMsg] = useState<ChatMessage | null>(null)
  const [pendingUnreact, setPendingUnreact] = useState<{ messageId: string; emoji: string; eventId: string } | null>(null)
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessage[]>([])

  // Reconcile optimistic thread replies with the real messages (mirrors the main
  // channel): once the real reply (matching sentDTag) lands in threadReplies, drop
  // the optimistic bubble after a brief delay so the ✓ stays visible momentarily.
  useEffect(() => {
    if (optimisticMessages.length === 0 || threadReplies.length === 0) return
    const toRemove = optimisticMessages.filter((opt) =>
      opt.sentDTag && opt.status === 'published' && threadReplies.some((m) => m.dTag === opt.sentDTag && m.pubkey === myPubkey)
    )
    if (toRemove.length > 0) {
      const timer = setTimeout(() => {
        const ids = new Set(toRemove.map((m) => m.tempId))
        setOptimisticMessages((prev) => prev.filter((m) => !ids.has(m.tempId)))
      }, 600)
      return () => clearTimeout(timer)
    }
  }, [threadReplies, optimisticMessages, myPubkey])

  // Safety: drop any optimistic reply stuck in 'published' for >60s (orphan cleanup).
  useEffect(() => {
    const stale = optimisticMessages.filter((m) =>
      m.status === 'published' && (Date.now() / 1000 - m.timestamp) > 60
    )
    if (stale.length > 0) {
      const ids = new Set(stale.map((m) => m.tempId))
      setOptimisticMessages((prev) => prev.filter((m) => !ids.has(m.tempId)))
    }
  }, [optimisticMessages])

  // Reply context: null = replying to thread parent (default), set = replying to specific message
  const [inThreadReply, setInThreadReply] = useState<ReplyContext | null>(null)
  const [profileModalPubkey, setProfileModalPubkey] = useState<string | null>(null)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)

  const parentProfile = getProfile(parentMsg.pubkey)
  const parentName = parentProfile?.display_name || parentProfile?.name || truncateNpub(nip19.npubEncode(parentMsg.pubkey))
  // Always use the parent message itself as the thread root — don't inherit its rootRef.
  // This ensures all replies within this thread stay grouped under this message.
  // For polls (empty dTag), use event ID; for messages, use a-tag.
  const isPollParent = !parentMsg.dTag
  const parentRoot = isPollParent ? parentMsg.id : `36943:${parentMsg.pubkey}:${parentMsg.dTag}`
  const myNpubName = myDisplayName || (myPubkey ? truncateNpub(nip19.npubEncode(myPubkey)) : 'You')

  // Default thread reply context — always points to parent
  const defaultThreadContext: ReplyContext = useMemo(() => ({
    dTag: parentMsg.dTag,
    pubkey: parentMsg.pubkey,
    displayName: parentName,
    preview: isPollParent ? 'Poll' : parentMsg.content.slice(0, 80),
    rootRef: parentRoot,
    isThread: true,
    ...(isPollParent ? { eventId: parentMsg.id } : {}),
  }), [parentMsg.dTag, parentMsg.pubkey, parentMsg.id, parentMsg.content, parentName, parentRoot, isPollParent])

  // Active reply context: specific in-thread reply or default thread parent
  const activeReplyContext = inThreadReply || defaultThreadContext

  const addReaction = useCallback((messageId: string, emoji: string, customUrl?: string) => {
    const targetMsg = allMessages.find((m) => m.id === messageId)
    if (!targetMsg) return

    const existing = storeReactions[messageId] || []
    const myExisting = existing.find((r) => r.emoji === emoji && (r.realPubkey ?? r.pubkey) === myPubkey)
    if (myExisting) {
      setPendingUnreact({ messageId, emoji, eventId: myExisting.eventId })
      return
    }

    useMessageStore.getState().addReaction(hubDTag, messageId, {
      emoji,
      pubkey: myPubkey!,
      eventId: 'optimistic-' + Date.now(),
      createdAt: Math.floor(Date.now() / 1000),
      customUrl,
    })
    publishReaction(emoji, messageId, targetMsg.pubkey, targetMsg.dTag, customUrl).catch(() => { })
  }, [allMessages, storeReactions, myPubkey, hubDTag, publishReaction, unreactReaction])

  // Auto-scroll to bottom when replies change or optimistic messages change
  useEffect(() => {
    // Skip auto-scroll-to-bottom if we have a pending initial scroll target
    if (initialScrollToId) return
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [threadReplies.length, optimisticMessages.length])

  // Initial scroll to a specific message (e.g. from pin-jump)
  useEffect(() => {
    if (!initialScrollToId) return
    // Defer to allow DOM to render
    requestAnimationFrame(() => {
      setTimeout(() => {
        const el = document.getElementById(`msg-${initialScrollToId}`)
        if (el) {
          el.scrollIntoView({ behavior: 'auto', block: 'center' })
          setHighlightedId(initialScrollToId)
          setTimeout(() => setHighlightedId(null), 2000)
        }
        onInitialScrollComplete?.()
      }, 150)
    })
  }, [initialScrollToId])

  const startEdit = useCallback((msg: ChatMessage) => {
    // editingId is matched against msg.id in the row (isEditing = editingId === msg.id),
    // so it must be the event id — not the d-tag. saveEdit still publishes via msg.dTag.
    setEditingId(msg.id)
    setEditText(msg.content)
  }, [])

  const cancelEdit = useCallback(() => {
    setEditingId(null)
    setEditText('')
  }, [])

  const saveEdit = useCallback(async (msg: ChatMessage, newText: string, removedHashes?: Set<string>) => {
    try {
      // Filter out removed attachments
      const remainingAttachments = removedHashes && removedHashes.size > 0 && msg.attachments
        ? msg.attachments.filter(a => !removedHashes.has(a.hash))
        : msg.attachments
      // Pass replyTo, rootRef, attachments, and nsfw to preserve them on edit
      await editMessage(msg.dTag, newText, msg.replyTo, msg.rootRef, undefined, remainingAttachments, msg.nsfw || undefined, msg.isThread || undefined)
      setEditingId(null)
      setEditText('')
    } catch (err) {
      console.error('Edit failed:', err)
    }
  }, [editMessage])

  const handleReplyInThread = useCallback((msg: ChatMessage) => {
    // Don't show reply banner if replying to thread parent — it's obvious
    if (msg.id === parentMsg.id) {
      setInThreadReply(null)
      return
    }
    const profile = getProfile(msg.pubkey)
    const name = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(msg.pubkey))
    setInThreadReply({
      dTag: msg.dTag,
      pubkey: msg.pubkey,
      displayName: name,
      preview: msg.content.slice(0, 80),
      rootRef: parentRoot, // always use thread root
      isThread: true,
      ...(isPollParent ? { eventId: parentMsg.id } : {}),
    })
  }, [parentMsg.id, parentRoot, isPollParent, getProfile])


  // Group window for thread replies
  const GROUP_WINDOW = 5 * 60 // 5 min

  // Find replied-to message within thread for reply previews
  const getThreadMsgByRef = useCallback((ref: string) => {
    // Check event ID format first (polls / non-addressable)
    if (ref === parentMsg.id) return parentMsg
    const byId = threadReplies.find((m) => m.id === ref)
    if (byId) return byId
    // a-tag format: "36943:pubkey:dTag"
    const parts = ref.split(':')
    if (parts.length >= 3) {
      const refDTag = parts.slice(2).join(':')
      const refPubkey = parts[1]
      // Check parent
      if (parentMsg.dTag === refDTag && parentMsg.pubkey === refPubkey) return parentMsg
      // Check thread replies
      return threadReplies.find((m) => m.dTag === refDTag && m.pubkey === refPubkey)
    }
    return undefined
  }, [parentMsg, threadReplies])

  // Scroll to a message within the thread modal + highlight it
  const scrollToThreadMessage = useCallback((messageId: string) => {
    const el = document.getElementById(`msg-${messageId}`)
    if (el && scrollRef.current) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlightedId(messageId)
      setTimeout(() => setHighlightedId(null), 2000)
    }
  }, [])

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

        {/* Scrollable body with ChatMessageRow */}
        <TooltipProvider delayDuration={300}>
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
            {/* Original (parent) message */}
            <div id={`msg-${parentMsg.id}`} className="pb-2 mb-2 border-b border-border">
              {isPollParent ? (() => {
                // Look up the poll from the store
                const allPolls = usePollStore.getState().polls
                let pollData: RawPoll | undefined
                for (const hubKey of Object.keys(allPolls)) {
                  for (const chKey of Object.keys(allPolls[hubKey])) {
                    pollData = allPolls[hubKey][chKey].find((p) => p.id === parentMsg.id)
                    if (pollData) break
                  }
                  if (pollData) break
                }
                if (!pollData) return <div className="text-sm text-muted-foreground italic">Poll not found</div>
                return (
                  <PollCard
                    poll={pollData}
                    hubDTag={hubDTag}
                    channelId={channelId}
                    onOpenProfile={setProfileModalPubkey}
                    onReply={(pollMsg) => handleReplyInThread(parentMsg)}
                    onThreadReply={() => { }}
                    onRequestDelete={() => setDeleteModalMsg(parentMsg)}
                    onViewRaw={(raw) => {
                      setRawEventData({ rawJson: raw, decryptedContent: '', isDecrypted: false })
                    }}
                    onAddReaction={addReaction}
                    reactions={reactions[parentMsg.id] || []}
                    canPublish={canPublish}
                    highlighted={highlightedId === parentMsg.id}
                  />
                )
              })() : (
                <ChatMessageRow
                  msg={parentMsg}
                  hubDTag={hubDTag}
                  isGrouped={false}
                  isMine={(parentMsg.realPubkey ?? parentMsg.pubkey) === myPubkey}
                  onOpenProfile={setProfileModalPubkey}
                  onEdit={startEdit}
                  onReply={handleReplyInThread}
                  onThreadReply={() => { }}
                  onSaveEdit={saveEdit}
                  editingId={editingId}
                  editText={editText}
                  setEditText={setEditText}
                  cancelEdit={cancelEdit}
                  getProfile={getProfile}
                  reactions={reactions[parentMsg.id] || []}
                  rawReactions={storeReactions[parentMsg.id]}
                  onAddReaction={addReaction}
                  highlighted={highlightedId === parentMsg.id}
                  onScrollToMessage={scrollToThreadMessage}
                  onRequestDelete={() => setDeleteModalMsg(parentMsg)}
                  onViewRaw={(raw) => {
                    const payload = parentMsg.attachments?.length || parentMsg.nsfw
                      ? JSON.stringify({ text: parentMsg.content, ...(parentMsg.attachments?.length ? { attachments: parentMsg.attachments } : {}), ...(parentMsg.nsfw ? { nsfw: true } : {}) }, null, 2)
                      : parentMsg.content
                    setRawEventData({ rawJson: raw, decryptedContent: payload, isDecrypted: parentMsg.decrypted })
                  }}
                  getProfileForReply={getProfile}
                  hideThreadReply
                  canPublish={canPublish}
                  channelId={channelId}
                />
              )}
            </div>

            {/* Thread replies — rendered as ChatMessageRow */}
            {threadReplies.map((reply, i) => {
              const prev = i > 0 ? threadReplies[i - 1] : null
              const parentARef = `36943:${parentMsg.pubkey}:${parentMsg.dTag}`
              const isReplyToParentForGrouping = reply.replyTo === parentARef || (isPollParent && reply.replyTo === parentMsg.id)
              const hasReply = !!reply.replyTo && !isReplyToParentForGrouping
              const isGrouped = prev
                && prev.pubkey === reply.pubkey
                && !hasReply
                && (reply.timestamp - prev.timestamp) <= GROUP_WINDOW

              if (reply.deleted) return null
              // Disappearing messages: hide a reply that expires while the modal is open (threadReplies is
              // already expiry-filtered at its source, but the open modal may not re-fetch it).
              const nowSec = Math.floor(Date.now() / 1000)
              if (reply.expiration && reply.expiration <= nowSec) return null

              // Find the replied-to message for preview (within thread)
              // Don't show reply preview if replying to the thread parent — it's already visible above
              const isReplyToParent = reply.replyTo === parentARef || (isPollParent && reply.replyTo === parentMsg.id)
              const repliedMsg = (reply.replyTo && !isReplyToParent) ? getThreadMsgByRef(reply.replyTo) : undefined
              const replyDeleted = repliedMsg?.deleted || (!!repliedMsg?.expiration && repliedMsg.expiration <= nowSec)
              const replyNotFound = (reply.replyTo && !isReplyToParent) && !repliedMsg

              return (
                <div key={reply.id} id={`msg-${reply.id}`}>
                  <ChatMessageRow
                    msg={reply}
                    hubDTag={hubDTag}
                    isGrouped={!!isGrouped}
                    isMine={(reply.realPubkey ?? reply.pubkey) === myPubkey}
                    onOpenProfile={setProfileModalPubkey}
                    onEdit={startEdit}
                    onReply={handleReplyInThread}
                    onThreadReply={() => { }}
                    onSaveEdit={saveEdit}
                    editingId={editingId}
                    editText={editText}
                    setEditText={setEditText}
                    cancelEdit={cancelEdit}
                    getProfile={getProfile}
                    reactions={reactions[reply.id] || []}
                    rawReactions={storeReactions[reply.id]}
                    onAddReaction={addReaction}
                    repliedMessage={replyNotFound ? undefined : (replyDeleted ? undefined : repliedMsg)}
                    replyStatus={replyNotFound ? 'not-found' : (replyDeleted ? 'deleted' : undefined)}
                    highlighted={highlightedId === reply.id}
                    onScrollToMessage={scrollToThreadMessage}
                    onRequestDelete={() => setDeleteModalMsg(reply)}
                    onViewRaw={(raw) => {
                      const payload = reply.attachments?.length || reply.nsfw
                        ? JSON.stringify({ text: reply.content, ...(reply.attachments?.length ? { attachments: reply.attachments } : {}), ...(reply.nsfw ? { nsfw: true } : {}) }, null, 2)
                        : reply.content
                      setRawEventData({ rawJson: raw, decryptedContent: payload, isDecrypted: reply.decrypted })
                    }}
                    getProfileForReply={getProfile}
                    hideThreadReply
                    canPublish={canPublish}
                    channelId={channelId}
                  />
                </div>
              )
            })}

            {/* Optimistic messages — hide once the real reply (matching sentDTag) arrives */}
            {optimisticMessages.filter((o) => o.channelId === channelId && !(o.sentDTag && threadReplies.some((m) => m.dTag === o.sentDTag && m.pubkey === myPubkey))).map((optMsg) => (
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
                    {myAvatar && <AvatarImage src={myAvatar} alt={myNpubName} />}
                    <AvatarFallback className="text-xs bg-primary/20 text-primary">
                      {myNpubName.slice(0, 2).toUpperCase()}
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
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{myNpubName}</span>
                    <span className="text-xs text-muted-foreground">{formatTimestamp(optMsg.timestamp)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-base text-foreground/90 break-words"><MessageContent content={optMsg.content} /></div>
                    {optMsg.status === 'mining' && (
                      <span className="text-[10px] text-muted-foreground italic whitespace-nowrap">
                        processing...
                      </span>
                    )}
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
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </TooltipProvider>

        {/* Message input — reusing the same component */}
        <MessageInput
          hubDTag={hubDTag}
          channelId={channelId}
          channelName="thread"
          optimisticMessages={optimisticMessages}
          setOptimisticMessages={setOptimisticMessages}
          replyContext={activeReplyContext}
          onCancelReply={() => setInThreadReply(null)}
          dragContainerRef={modalContainerRef}
          hideReplyBanner={!inThreadReply}
          canPublish={canPublish}
          threadRootRef={parentMsg.dTag}
        />

        {/* Delete confirmation */}
        {deleteModalMsg && (
          <DeleteConfirmDialog
            onCancel={() => setDeleteModalMsg(null)}
            onConfirm={async () => {
              await deleteMessage(deleteModalMsg.dTag)
              setDeleteModalMsg(null)
            }}
          />
        )}

        {/* Unreact confirmation */}
        {pendingUnreact && (
          <DeleteConfirmDialog
            onCancel={() => setPendingUnreact(null)}
            onConfirm={async () => {
              useMessageStore.getState().removeReaction(hubDTag, pendingUnreact.messageId, pendingUnreact.emoji, myPubkey!)
              await unreactReaction(pendingUnreact.eventId)
              setPendingUnreact(null)
            }}
            title="Remove Reaction"
            progressSteps={['Sending deletion request...']}
            confirmLabel="Yes, Remove"
          />
        )}

        {/* Raw event modal */}
        {rawEventData && (
          <RawEventModal
            rawJson={rawEventData.rawJson}
            decryptedContent={rawEventData.decryptedContent}
            isDecrypted={rawEventData.isDecrypted}
            onClose={() => setRawEventData(null)}
          />
        )}

        {/* User profile modal */}
        <UserProfileModal
          open={!!profileModalPubkey}
          onClose={() => setProfileModalPubkey(null)}
          targetPubkey={profileModalPubkey}
          hubContext={(() => {
            const hub = useHubStore.getState().hubs[hubDTag]
            return hub ? { dTag: hubDTag, creatorPubkey: hub.creatorPubkey, ownerRealPubkey: hub.ownerRealPubkey } : null
          })()}
          onDM={(pubkey) => {
            useDM04Store.getState().setActiveConversation(pubkey)
            useDMStore.getState().setActiveConversation(pubkey)
            useNavigationStore.getState().setActivePage('dms')
            onClose()
          }}
        />
      </div>
    </div>,
    document.body
  )
}

/* ─── Hub Timestamp Picker Popover ─── */

function HubTimestampPickerPopover({
  triggerRef,
  onClose,
  onInsert,
}: {
  triggerRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
  onInsert: (unix: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const now = new Date()
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

  const [dateVal, setDateVal] = useState(todayStr)
  const [timeVal, setTimeVal] = useState(nowTime)

  // Close on outside click (exclude trigger button to allow toggle)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, triggerRef])

  // Compute preview unix timestamp
  const unix = useMemo(() => {
    if (!dateVal || !timeVal) return null
    const [y, mo, d] = dateVal.split('-').map(Number)
    const [h, mi] = timeVal.split(':').map(Number)
    const dt = new Date(y, mo - 1, d, h, mi, 0)
    return Math.floor(dt.getTime() / 1000)
  }, [dateVal, timeVal])

  // Live-updating preview text
  const [previewText, setPreviewText] = useState('')
  useEffect(() => {
    if (!unix) { setPreviewText(''); return }
    const update = () => {
      const dt = new Date(unix * 1000)
      const datePart = dt.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
      const timePart = dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      const diffMs = dt.getTime() - Date.now()
      const absDiffMs = Math.abs(diffMs)
      let relative = ''
      if (absDiffMs < 60_000) {
        relative = diffMs >= 0 ? 'now' : 'just now'
      } else if (absDiffMs < 3_600_000) {
        const mins = Math.round(absDiffMs / 60_000)
        relative = diffMs >= 0 ? `in ${mins} minute${mins !== 1 ? 's' : ''}` : `${mins} minute${mins !== 1 ? 's' : ''} ago`
      } else if (absDiffMs < 86_400_000) {
        const hrs = Math.round(absDiffMs / 3_600_000)
        relative = diffMs >= 0 ? `in ${hrs} hour${hrs !== 1 ? 's' : ''}` : `${hrs} hour${hrs !== 1 ? 's' : ''} ago`
      } else {
        const days = Math.round(absDiffMs / 86_400_000)
        relative = diffMs >= 0 ? `in ${days} day${days !== 1 ? 's' : ''}` : `${days} day${days !== 1 ? 's' : ''} ago`
      }
      setPreviewText(`${datePart} – ${timePart} (${relative})`)
    }
    update()
    const id = setInterval(update, 30_000)
    return () => clearInterval(id)
  }, [unix])

  const handleAdd = () => {
    if (unix) onInsert(unix)
  }

  return (
    <div
      ref={ref}
      className="absolute bottom-full right-0 mb-2 z-[60] w-[290px] bg-card border border-border rounded-xl shadow-2xl p-4 space-y-3"
    >
      <h4 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
        <Clock size={13} className="text-primary" />
        Insert Timestamp
      </h4>

      {/* Date */}
      <div className="space-y-1">
        <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Date</label>
        <DatePicker value={dateVal} onChange={setDateVal} />
      </div>

      {/* Time */}
      <div className="space-y-1">
        <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Time</label>
        <TimePicker value={timeVal} onChange={setTimeVal} />
      </div>

      {/* Preview */}
      {previewText && (
        <div className="text-xs text-muted-foreground bg-secondary/50 rounded-lg px-2.5 py-1.5 border border-border/50">
          <span className="text-[10px] text-muted-foreground/60 block mb-0.5">Preview</span>
          <span className="inline-block bg-primary/10 text-primary rounded-sm px-1 py-0.5 text-xs font-medium">
            {previewText}
          </span>
        </div>
      )}

      {/* Add button */}
      <button
        onClick={handleAdd}
        disabled={!unix}
        className="w-full h-8 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Add Timestamp
      </button>
    </div>
  )
}

