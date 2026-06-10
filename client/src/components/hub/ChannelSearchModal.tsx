/**
 * ChannelSearchModal — Local search through fetched messages in the current hub.
 *
 * Searches decrypted message content (text) from the message store.
 * Two modes:
 *   1. Channel search (default) — searches only the current channel
 *   2. Global search — searches all channels in the current hub
 *
 * Results are clickable: clicking navigates to that message in the chat.
 * For cross-channel results (global mode), switches the active channel first.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useMessageStore } from '@/stores/messageStore'
import type { Attachment } from '@/stores/messageStore'
import { useHubStore, type Channel } from '@/stores/hubStore'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { useProfileCache } from '@/hooks/useProfileCache'
import { DnnBadge } from '@/components/ui/DnnBadge'
import { ContentMediaImage } from '@/components/chat/ContentMediaGrouping'
import { aesDecrypt } from '@/lib/crypto/aes'
import { deriveChannelKey } from '@/lib/crypto/hkdf'
import { truncateNpub, cn } from '@/lib/utils'
import { useDnnStore } from '@/stores/dnnStore'
import { getHour12 } from '@/stores/preferencesStore'
import { nip19 } from 'nostr-tools'
import { Search, X, Globe, Hash, Megaphone, MessageSquare, Loader2, Radio, User, Image, Music, Video, FileIcon, Link2 } from 'lucide-react'
import { CustomAudioPlayer } from '@/components/ui/CustomAudioPlayer'

interface SearchResult {
  /** Raw message id */
  id: string
  /** Message d-tag */
  dTag: string
  /** Sender pubkey */
  pubkey: string
  /** Decrypted text content */
  text: string
  /** Timestamp */
  createdAt: number
  /** Channel this message belongs to */
  channelId: string
  /** Channel name (resolved from hub data) */
  channelName: string
  /** Channel type */
  channelType: string
  /** Whether message has image/audio/video attachments */
  hasImage: boolean
  hasAudio: boolean
  hasVideo: boolean
  /** Full attachment list for rendering previews */
  attachments: Attachment[]
  /** Inline media URLs extracted from text */
  inlineImageUrls: string[]
  inlineVideoUrls: string[]
  inlineAudioUrls: string[]
}

interface ChannelSearchModalProps {
  hubDTag: string
  channelId: string
  onClose: () => void
}

export function ChannelSearchModal({ hubDTag, channelId, onClose }: ChannelSearchModalProps) {
  const [query, setQuery] = useState('')
  const [globalMode, setGlobalMode] = useState(false)
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchDone, setSearchDone] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const { getProfile } = useProfileCache()

  // Filters
  const [fromFilter, setFromFilter] = useState('')
  const [hasImage, setHasImage] = useState(false)
  const [hasAudio, setHasAudio] = useState(false)
  const [hasVideo, setHasVideo] = useState(false)
  const [hasFile, setHasFile] = useState(false)
  const [hasLink, setHasLink] = useState(false)

  const hub = useHubStore((s) => hubDTag ? s.hubs[hubDTag] : null)
  const setActiveChannel = useHubStore((s) => s.setActiveChannel)

  // Focus input on mount
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  // Build channel lookup map
  const channelMap = useMemo(() => {
    const map = new Map<string, Channel>()
    if (!hub) return map
    for (const ch of hub.channels) {
      map.set(ch.channelId, ch)
    }
    return map
  }, [hub])

  // Derive a channel key (synchronous — same pattern as useMessages)
  const getChannelKey = useCallback((targetChannelId: string, msgEpoch?: number): Uint8Array | null => {
    if (!hub) return null

    const state = useHubStore.getState()
    const hubSecrets = state.hubSecrets
    const groupSecrets = state.groupSecrets
    const epochSecrets = state.epochSecrets
    const groupEpochSecrets = state.groupEpochSecrets

    // Check if channel uses group encryption
    const channel = hub.channels.find(ch => ch.channelId === targetChannelId)
    let groupId: string | null = null
    if (channel?.encryption) {
      groupId = channel.encryption
    } else if (channel?.synced && channel.categoryId) {
      const cat = hub.categories.find(c => c.categoryId === channel.categoryId)
      if (cat?.encryption) groupId = cat.encryption
    }

    let secretHex: string | undefined
    let epoch: number

    if (groupId) {
      const group = hub.groupedRoles?.find(g => g.groupId === groupId)
      const currentGroupEpoch = group?.epoch || 1
      epoch = msgEpoch ?? currentGroupEpoch

      if (epoch === currentGroupEpoch) {
        secretHex = groupSecrets[hubDTag]?.[groupId]
      } else {
        secretHex = groupEpochSecrets[hubDTag]?.[groupId]?.[epoch]
        if (!secretHex) {
          secretHex = groupSecrets[hubDTag]?.[groupId]
          epoch = currentGroupEpoch
        }
      }
    } else {
      const currentEpoch = hub.epoch || 1
      epoch = msgEpoch ?? currentEpoch

      if (epoch === currentEpoch) {
        secretHex = hubSecrets[hubDTag]
      } else {
        secretHex = epochSecrets[hubDTag]?.[epoch]
        if (!secretHex) {
          secretHex = hubSecrets[hubDTag]
          epoch = currentEpoch
        }
      }
    }

    if (!secretHex) return null

    const secret = new Uint8Array(secretHex.length / 2)
    for (let i = 0; i < secretHex.length; i += 2) {
      secret[i / 2] = parseInt(secretHex.substring(i, i + 2), 16)
    }

    return deriveChannelKey(secret, targetChannelId, epoch)
  }, [hub, hubDTag])

  // Perform search
  const doSearch = useCallback(async () => {
    const q = query.trim().toLowerCase()
    const fromQ = fromFilter.trim().toLowerCase()
    const anyFilter = hasImage || hasAudio || hasVideo || hasFile || hasLink

    // Need at least a text query or a filter active
    if (!hub || (!q && !fromQ && !anyFilter)) {
      setResults([])
      setSearchDone(false)
      return
    }

    setSearching(true)
    setSearchDone(false)

    try {
      const storeState = useMessageStore.getState()
      const hubMessages = storeState.messages[hubDTag] || {}

      // Determine which channels to search
      const channelsToSearch = globalMode
        ? Object.keys(hubMessages)
        : [channelId]

      const foundResults: SearchResult[] = []
      const MAX_RESULTS = 50

      for (const chId of channelsToSearch) {
        if (foundResults.length >= MAX_RESULTS) break

        const rawMsgs = hubMessages[chId] || []
        if (rawMsgs.length === 0) continue

        const ch = channelMap.get(chId)
        const chName = ch?.name || chId
        const chType = ch?.type || 'chat'

        // Get channel key for decryption
        // Try with default epoch first
        const defaultKey = getChannelKey(chId)

        for (const msg of rawMsgs) {
          if (foundResults.length >= MAX_RESULTS) break
          if (msg.deleted) continue

          let text = msg.content
          let decrypted = false

          // Try to decrypt
          if (defaultKey && text) {
            try {
              // Use epoch-specific key if available
              const key = msg.epoch ? getChannelKey(chId, msg.epoch) : defaultKey
              if (key) {
                text = await aesDecrypt(key, text)
                decrypted = true
              }
            } catch {
              // Decryption failed — skip this message entirely
              continue
            }
          }

          // No key available — can't search encrypted content
          if (!decrypted) continue

          // Parse JSON format {text: "...", attachments: [...]}
          let attachments: Array<{ type: string }> | undefined
          if (text) {
            try {
              const parsed = JSON.parse(text)
              if (parsed && typeof parsed.text === 'string') {
                text = parsed.text
                if (Array.isArray(parsed.attachments) && parsed.attachments.length > 0) {
                  attachments = parsed.attachments
                }
              }
            } catch {
              // Not JSON — use as-is
            }
          }

          // Apply "from" filter — match against profile name, npub, or DNN ID
          if (fromQ) {
            const profile = getProfile(msg.pubkey)
            const displayName = (profile?.display_name || profile?.name || '').toLowerCase()
            const npub = nip19.npubEncode(msg.pubkey).toLowerCase()
            const dnnId = useDnnStore.getState().getVerifiedDnnId(msg.pubkey)?.toLowerCase() || ''
            if (!displayName.includes(fromQ) && !npub.includes(fromQ) && !dnnId.includes(fromQ)) continue
          }

          // Detect inline media URLs in text
          const urlsInText = text ? (text.match(/https?:\/\/\S+/gi) || []) : []
          const MEDIA_IMG_RE = /\.(jpg|jpeg|png|gif|webp|svg|bmp)(\?[^\s]*)?$/i
          const BLOSSOM_RE = /^https?:\/\/(blossom\.(primal\.net|band|nostr\.hu|data\.haus)|cdn\.sovbit\.host)\/[a-f0-9]{64}/i
          const MEDIA_VID_RE = /\.(mp4|webm|mov|avi|mkv)(\?[^\s]*)?$/i
          const MEDIA_AUD_RE = /\.(mp3|ogg|wav|flac|m4a|aac)(\?[^\s]*)?$/i

          const inlineImageUrls = urlsInText.filter(u => MEDIA_IMG_RE.test(u) || BLOSSOM_RE.test(u))
          const inlineVideoUrls = urlsInText.filter(u => MEDIA_VID_RE.test(u))
          const inlineAudioUrls = urlsInText.filter(u => MEDIA_AUD_RE.test(u))
          const allMediaUrls = new Set([...inlineImageUrls, ...inlineVideoUrls, ...inlineAudioUrls])
          // Non-media links = URLs that aren't media
          const nonMediaLinks = urlsInText.filter(u => !allMediaUrls.has(u))

          const attTypes = attachments?.map(a => a.type?.toLowerCase() || '') || []
          const msgHasImage = attTypes.some(t => t.startsWith('image/')) || inlineImageUrls.length > 0
          const msgHasAudio = attTypes.some(t => t.startsWith('audio/')) || inlineAudioUrls.length > 0
          const msgHasVideo = attTypes.some(t => t.startsWith('video/')) || inlineVideoUrls.length > 0
          // File = non-media attachments
          const msgHasFile = attachments ? attachments.some(a => {
            const t = a.type?.toLowerCase() || ''
            return !t.startsWith('image/') && !t.startsWith('audio/') && !t.startsWith('video/')
          }) : false
          // Link = non-media URLs in text
          const msgHasLink = nonMediaLinks.length > 0

          // Apply content filters (AND logic — must match ALL selected)
          if (anyFilter) {
            if (hasImage && !msgHasImage) continue
            if (hasAudio && !msgHasAudio) continue
            if (hasVideo && !msgHasVideo) continue
            if (hasFile && !msgHasFile) continue
            if (hasLink && !msgHasLink) continue
          }

          // Match query against decrypted text (if query is provided)
          if (q && (!text || !text.toLowerCase().includes(q))) continue

          foundResults.push({
            id: msg.id,
            dTag: msg.dTag,
            pubkey: msg.pubkey,
            text: text || '',
            createdAt: msg.createdAt,
            channelId: chId,
            channelName: chName,
            channelType: chType,
            hasImage: msgHasImage,
            hasAudio: msgHasAudio,
            hasVideo: msgHasVideo,
            attachments: (attachments || []) as Attachment[],
            inlineImageUrls,
            inlineVideoUrls,
            inlineAudioUrls,
          })
        }
      }

      // Sort by most recent first
      foundResults.sort((a, b) => b.createdAt - a.createdAt)
      setResults(foundResults)
    } catch (err) {
      console.error('Search failed:', err)
      setResults([])
    } finally {
      setSearching(false)
      setSearchDone(true)
    }
  }, [query, globalMode, hubDTag, channelId, hub, channelMap, getChannelKey, fromFilter, hasImage, hasAudio, hasVideo, hasFile, hasLink, getProfile])

  // Escape to close
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
    }
  }

  // Live search — debounce 150ms as user types or toggles filters
  useEffect(() => {
    const q = query.trim()
    const fromQ = fromFilter.trim()
    const anyFilter = hasImage || hasAudio || hasVideo || hasFile || hasLink
    if (!q && !fromQ && !anyFilter) {
      setResults([])
      setSearchDone(false)
      return
    }
    const timer = setTimeout(() => {
      doSearch()
    }, 150)
    return () => clearTimeout(timer)
  }, [query, globalMode, fromFilter, hasImage, hasAudio, hasVideo, hasFile, hasLink])

  // Navigate to a search result
  const handleResultClick = (result: SearchResult) => {
    // If in a different channel, switch to it first
    if (result.channelId !== channelId) {
      setActiveChannel(result.channelId)
    }

    // Close modal
    onClose()

    // Dispatch pin-jump event to scroll to the message (use same mechanism as pins)
    // Format: "36943:pubkey:dTag"
    const aRef = `36943:${result.pubkey}:${result.dTag}`
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('pin-jump-to-message', { detail: { aRef } }))
    }, result.channelId !== channelId ? 200 : 50) // Longer delay for channel switch
  }

  const formatResultTime = (ts: number): string => {
    const d = new Date(ts * 1000)
    const today = new Date()
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)

    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: getHour12() })
    if (d.toDateString() === today.toDateString()) return `Today at ${time}`
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ` at ${time}`
  }

  // Highlight matching text in results
  const highlightMatch = (text: string, q: string): React.ReactNode => {
    if (!q) return text
    const lower = text.toLowerCase()
    const idx = lower.indexOf(q.toLowerCase())
    if (idx === -1) return text

    // Show snippet around the match
    const CONTEXT = 60
    const start = Math.max(0, idx - CONTEXT)
    const end = Math.min(text.length, idx + q.length + CONTEXT)
    const prefix = start > 0 ? '...' : ''
    const suffix = end < text.length ? '...' : ''
    const before = text.slice(start, idx)
    const match = text.slice(idx, idx + q.length)
    const after = text.slice(idx + q.length, end)

    return (
      <span>
        {prefix}{before}
        <mark className="bg-primary/25 text-primary rounded-sm px-0.5">{match}</mark>
        {after}{suffix}
      </span>
    )
  }

  const ChannelTypeIcon = ({ type }: { type: string }) => {
    switch (type) {
      case 'announcement': return <Megaphone size={12} className="text-amber-400 shrink-0" />
      case 'forum': return <MessageSquare size={12} className="text-blue-400 shrink-0" />
      case 'voice': return <Radio size={12} className="text-emerald-400 shrink-0" />
      default: return <Hash size={12} className="text-muted-foreground shrink-0" />
    }
  }

  const currentChannelName = channelMap.get(channelId)?.name || channelId

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-2 pt-[10vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-xl rounded-xl border border-border bg-background shadow-2xl animate-in fade-in-0 zoom-in-95 flex flex-col max-h-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title bar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
          <span className="text-sm font-semibold text-foreground">Local search</span>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
          <Search size={16} className="text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder={globalMode ? `Search all channels in this hub...` : `Search in #${currentChannelName}...`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
          {query && (
            <button
              onClick={() => { setQuery(''); setResults([]); setSearchDone(false) }}
              className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Global toggle */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 shrink-0">
          <div className="flex items-center gap-2">
            <Globe size={13} className={cn('transition-colors', globalMode ? 'text-primary' : 'text-muted-foreground')} />
            <span className="text-xs text-muted-foreground">Search all channels</span>
          </div>
          <button
            onClick={() => setGlobalMode(!globalMode)}
            className={cn(
              'relative w-9 h-[20px] rounded-full transition-colors cursor-pointer shrink-0',
              globalMode ? 'bg-primary' : 'bg-muted-foreground/30'
            )}
          >
            <div className={cn(
              'absolute top-[2px] w-4 h-4 rounded-full bg-white shadow transition-transform',
              globalMode ? 'translate-x-[18px]' : 'translate-x-[2px]'
            )} />
          </button>
        </div>

        {/* Filters row */}
        <div className="px-4 py-2.5 border-b border-border/50 shrink-0 space-y-2">
          {/* From person */}
          <div className="flex items-center gap-2">
            <User size={13} className="text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground shrink-0 w-10">From</span>
            <input
              type="text"
              placeholder="Anyone"
              value={fromFilter}
              onChange={(e) => setFromFilter(e.target.value)}
              className="flex-1 bg-secondary/60 border border-border rounded-md px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/40 transition-colors"
            />
            {fromFilter && (
              <button onClick={() => setFromFilter('')} className="text-muted-foreground hover:text-foreground cursor-pointer">
                <X size={12} />
              </button>
            )}
          </div>

          {/* Media type toggles */}
          <div className="flex items-center gap-2">
            <FileIcon size={13} className="text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground shrink-0 w-10">Has</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => setHasImage(!hasImage)}
                className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border transition-colors cursor-pointer',
                  hasImage
                    ? 'bg-primary/15 border-primary/30 text-primary'
                    : 'bg-secondary/50 border-border text-muted-foreground hover:text-foreground hover:border-primary/20'
                )}
              >
                <Image size={11} />
                Image
              </button>
              <button
                onClick={() => setHasAudio(!hasAudio)}
                className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border transition-colors cursor-pointer',
                  hasAudio
                    ? 'bg-primary/15 border-primary/30 text-primary'
                    : 'bg-secondary/50 border-border text-muted-foreground hover:text-foreground hover:border-primary/20'
                )}
              >
                <Music size={11} />
                Audio
              </button>
              <button
                onClick={() => setHasVideo(!hasVideo)}
                className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border transition-colors cursor-pointer',
                  hasVideo
                    ? 'bg-primary/15 border-primary/30 text-primary'
                    : 'bg-secondary/50 border-border text-muted-foreground hover:text-foreground hover:border-primary/20'
                )}
              >
                <Video size={11} />
                Video
              </button>
              <button
                onClick={() => setHasFile(!hasFile)}
                className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border transition-colors cursor-pointer',
                  hasFile
                    ? 'bg-primary/15 border-primary/30 text-primary'
                    : 'bg-secondary/50 border-border text-muted-foreground hover:text-foreground hover:border-primary/20'
                )}
              >
                <FileIcon size={11} />
                File
              </button>
              <button
                onClick={() => setHasLink(!hasLink)}
                className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border transition-colors cursor-pointer',
                  hasLink
                    ? 'bg-primary/15 border-primary/30 text-primary'
                    : 'bg-secondary/50 border-border text-muted-foreground hover:text-foreground hover:border-primary/20'
                )}
              >
                <Link2 size={11} />
                Link
              </button>
            </div>
          </div>
        </div>



        {/* Results */}
        <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin">
          {searching && (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 size={16} className="animate-spin mr-2" />
              <span className="text-sm">Searching messages...</span>
            </div>
          )}

          {!searching && searchDone && results.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-center px-4">
              <Search size={24} className="text-muted-foreground/40 mb-2" />
              <p className="text-sm text-muted-foreground">No messages found matching "{query}"</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                Only locally cached messages are searched. Try scrolling back to load older messages.
              </p>
            </div>
          )}

          {!searching && !searchDone && !query.trim() && !fromFilter.trim() && !hasImage && !hasAudio && !hasVideo && !hasFile && !hasLink && (
            <div className="flex flex-col items-center justify-center py-10 text-center px-4">
              <Search size={24} className="text-muted-foreground/30 mb-2" />
              <p className="text-sm text-muted-foreground/60">Start typing to search messages</p>
            </div>
          )}

          {!searching && results.length > 0 && (
            <div className="py-1">
              <div className="px-4 py-1.5">
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
                  {results.length} result{results.length !== 1 ? 's' : ''}
                </span>
              </div>
              {results.map((result) => {
                const profile = getProfile(result.pubkey)
                const displayName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(result.pubkey), 10)

                return (
                  <button
                    key={result.id}
                    onClick={() => handleResultClick(result)}
                    className="w-full text-left px-4 py-2.5 hover:bg-accent/50 transition-colors cursor-pointer border-b border-border/30 last:border-0 group"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <Avatar className="h-5 w-5 shrink-0">
                        {profile?.picture && <AvatarImage src={profile.picture} />}
                        <AvatarFallback className="text-[8px] bg-muted">{displayName.charAt(0).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <span className="text-sm font-semibold text-foreground">{displayName}</span>
                      <DnnBadge pubkey={result.pubkey} />
                      <span className="text-xs text-muted-foreground">{formatResultTime(result.createdAt)}</span>
                      {/* Show channel info in global mode */}
                      {globalMode && (
                        <div className="flex items-center gap-1 ml-auto">
                          <ChannelTypeIcon type={result.channelType} />
                          <span className="text-xs text-muted-foreground font-medium">{result.channelName}</span>
                        </div>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground leading-relaxed line-clamp-2 group-hover:text-foreground/80 transition-colors pl-7">
                      {highlightMatch(result.text, query.trim())}
                    </p>
                    {/* Attachment previews */}
                    {result.attachments.length > 0 && (
                      <div className="flex flex-col gap-1.5 mt-1.5 pl-7">
                        {result.attachments.map((att, i) => {
                          const t = att.type?.toLowerCase() || ''
                          if (t.startsWith('image/')) {
                            const blossomUrl = hub?.blossomServers?.[0]
                              ? `${hub.blossomServers[0].replace(/\/+$/, '')}/${att.hash}`
                              : undefined
                            return blossomUrl ? (
                              <div key={i} className="max-w-[300px]">
                                <ContentMediaImage
                                  src={blossomUrl}
                                  className="w-full rounded-lg object-cover border border-border/40"
                                />
                              </div>
                            ) : (
                              <div key={i} className="flex items-center gap-1 text-xs text-muted-foreground bg-secondary/50 px-1.5 py-0.5 rounded w-fit">
                                <Image size={12} />
                                <span className="truncate max-w-[150px]">{att.name}</span>
                              </div>
                            )
                          }
                          if (t.startsWith('video/')) {
                            const blossomUrl = hub?.blossomServers?.[0]
                              ? `${hub.blossomServers[0].replace(/\/+$/, '')}/${att.hash}`
                              : undefined
                            return blossomUrl ? (
                              <div key={i} className="max-w-[300px]">
                                <video
                                  src={blossomUrl}
                                  controls
                                  preload="none"
                                  className="w-full rounded-lg border border-border/40"
                                />
                              </div>
                            ) : (
                              <div key={i} className="flex items-center gap-1 text-xs text-muted-foreground bg-secondary/50 px-1.5 py-0.5 rounded w-fit">
                                <Video size={12} className="text-blue-400" />
                                <span className="truncate max-w-[150px]">{att.name}</span>
                              </div>
                            )
                          }
                          if (t.startsWith('audio/')) {
                            const blossomUrl = hub?.blossomServers?.[0]
                              ? `${hub.blossomServers[0].replace(/\/+$/, '')}/${att.hash}`
                              : undefined
                            return blossomUrl ? (
                              <div key={i} className="max-w-[300px]">
                                <CustomAudioPlayer
                                  src={blossomUrl}
                                  preload="none"
                                  className="w-full"
                                />
                              </div>
                            ) : (
                              <div key={i} className="flex items-center gap-1 text-xs text-muted-foreground bg-secondary/50 px-1.5 py-0.5 rounded w-fit">
                                <Music size={12} className="text-purple-400" />
                                <span className="truncate max-w-[150px]">{att.name}</span>
                              </div>
                            )
                          }
                          return (
                            <div key={i} className="flex items-center gap-1 text-xs text-muted-foreground bg-secondary/50 px-1.5 py-0.5 rounded w-fit">
                              <FileIcon size={12} />
                              <span className="truncate max-w-[150px]">{att.name}</span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {/* Inline media URL previews */}
                    {(result.inlineImageUrls.length > 0 || result.inlineVideoUrls.length > 0 || result.inlineAudioUrls.length > 0) && (
                      <div className="flex flex-col gap-1.5 mt-1.5 pl-7">
                        {result.inlineImageUrls.map((url, i) => (
                          <div key={`iimg-${i}`} className="max-w-[300px]">
                            <ContentMediaImage
                              src={url}
                              className="w-full rounded-lg object-cover border border-border/40"
                            />
                          </div>
                        ))}
                        {result.inlineVideoUrls.map((url, i) => (
                          <div key={`ivid-${i}`} className="max-w-[300px]">
                            <video
                              src={url}
                              controls
                              preload="none"
                              className="w-full rounded-lg border border-border/40"
                            />
                          </div>
                        ))}
                        {result.inlineAudioUrls.map((url, i) => (
                          <div key={`iaud-${i}`} className="max-w-[300px]">
                            <CustomAudioPlayer
                              src={url}
                              preload="none"
                              className="w-full"
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
