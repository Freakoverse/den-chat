/**
 * NostrCards — Shared card components for rendering nostr references inline
 *
 * Used by both MessageContent (hub chat + DMs) and RichContent (social posts).
 * Each card fetches its event data and renders a compact, styled preview.
 */

import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useProfileCache } from '@/hooks/useProfileCache'
import { fetchEvents, fetchEventsFromRelays } from '@/lib/nostr/relay-pool'
import { MOD_KIND, getModRelays, parseModEvent, type Mod } from '@/lib/mods/modEvent'
import { ModCard, ModOpenModal } from '@/components/discover/ModsTab'
import { useCachedFetch } from '@/hooks/useCachedFetch'
import { useDnnStore } from '@/stores/dnnStore'
import { verifiedShortAddress, shareableShortAddress } from '@/lib/nostr/nipShort'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { CustomAudioPlayer } from '@/components/ui/CustomAudioPlayer'
import { getRenderLimit } from '@/lib/imageSizeGuard'
import { usePreferencesStore } from '@/stores/preferencesStore'
import { nip19 } from 'nostr-tools'
import { truncateNpub, formatTimestamp, openExternalUrl } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Copy, Check, Loader2, FileText, MessageSquare, Radio, ExternalLink, ArrowUpRight, Link2, ImageOff } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { useNavigationStore } from '@/stores/navigationStore'
import { useSocialStore } from '@/stores/socialStore'
import type { Event } from 'nostr-tools'

/* ─── Profile Mention (inline @name) ─────────────────────────── */

export function ProfileCard({ pubkey, onProfileClick }: { pubkey: string; onProfileClick?: (pubkey: string) => void }) {
  const { getProfile } = useProfileCache()
  const profile = getProfile(pubkey)
  const name = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(pubkey))

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (onProfileClick) {
      onProfileClick(pubkey)
    } else {
      // Default: navigate to social profile page
      useSocialStore.getState().setActiveProfile(pubkey)
      useNavigationStore.getState().setActivePage('social')
    }
  }

  return (
    <button
      onClick={handleClick}
      className="inline text-primary font-medium bg-primary/10 hover:bg-primary/20 p-1 leading-none rounded transition-colors cursor-pointer"
    >
      @{name}
    </button>
  )
}

/* ─── Embedded Note (kind 1) ─────────────────────────────────── */

export function NoteCard({ eventId }: { eventId: string }) {
  const { getProfile } = useProfileCache()
  const { data: event, loading } = useCachedFetch<Event>(`e:${eventId}`, () =>
    fetchEvents({ ids: [eventId], limit: 1 }).then((events) => events[0] ?? null))

  if (loading) {
    return (
      <div className="my-2 rounded-lg border border-border p-3 flex items-center gap-2 text-xs text-muted-foreground max-w-[350px]">
        <Loader2 size={12} className="animate-spin" /> Loading note...
      </div>
    )
  }

  if (!event) {
    return <FallbackBadge label="Note not found" bech32={nip19.noteEncode(eventId)} />
  }

  const profile = getProfile(event.pubkey)
  const displayName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(event.pubkey))

  return (
    <div className="my-2 rounded-lg border border-border p-3 bg-secondary/10 hover:bg-secondary/20 transition-colors max-w-[350px]">
      <div className="flex items-center gap-2 mb-1.5">
        <Avatar className="h-5 w-5">
          {profile?.picture && <AvatarImage src={profile.picture} />}
          <AvatarFallback className="text-[8px] bg-primary/20 text-primary">
            {displayName.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <span className="text-xs font-semibold text-foreground">{displayName}</span>
        <span className="text-[10px] text-muted-foreground">{formatTimestamp(event.created_at)}</span>
      </div>
      <NoteBody content={event.content} />
      <div className="flex items-center gap-3">
        <CopyAddress bech32={nip19.noteEncode(eventId)} />
        <CopyShort event={event} />
        <OpenInDen onOpen={() => {
          useSocialStore.getState().setActiveThread(eventId)
          useNavigationStore.getState().setActivePage('social')
        }} />
      </div>
    </div>
  )
}

/* ─── Note body: text + inline media ─────────────────────────── */

const NOTE_URL_RE = /https?:\/\/[^\s<]+/g
const NOTE_IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?[^#\s]*)?(#\S*)?$/i
const NOTE_VIDEO_RE = /\.(mp4|webm|mov|m4v|mkv|avi)(\?[^#\s]*)?(#\S*)?$/i
const NOTE_AUDIO_RE = /\.(mp3|ogg|wav|flac|aac|m4a)(\?[^#\s]*)?(#\S*)?$/i

/** Pull media URLs out of a note's text so they render as media instead of as raw links. */
function splitNoteMedia(content: string): { text: string; images: string[]; videos: string[]; audios: string[] } {
  const images: string[] = []
  const videos: string[] = []
  const audios: string[] = []
  const text = content.replace(NOTE_URL_RE, (url) => {
    if (NOTE_IMAGE_RE.test(url)) { images.push(url); return '' }
    if (NOTE_VIDEO_RE.test(url)) { videos.push(url); return '' }
    if (NOTE_AUDIO_RE.test(url)) { audios.push(url); return '' }
    return url
  }).replace(/\n{3,}/g, '\n\n').trim()
  return { text, images, videos, audios }
}

/**
 * A note card's body. Images go through BlossomImage with the Settings › Moderation "chat" render
 * limit (too-large images show the size prompt with an override, like everywhere else in chat).
 * Video and audio render as players that preload NOTHING — the bytes only start moving when the
 * user presses play. The global "show media" preference hides all of it.
 */
function NoteBody({ content }: { content: string }) {
  const showMedia = usePreferencesStore((s) => s.showMedia)
  const { text, images, videos, audios } = useMemo(() => splitNoteMedia(content), [content])
  const hasMedia = images.length + videos.length + audios.length > 0
  const chatLimitMB = getRenderLimit('chat')

  return (
    <>
      {text && (
        <div className="text-xs text-foreground/80 whitespace-pre-wrap break-words line-clamp-4">
          {text}
        </div>
      )}
      {hasMedia && !showMedia && (
        <p className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground"><ImageOff size={10} /> Media hidden</p>
      )}
      {hasMedia && showMedia && (
        <div className="mt-1.5 space-y-1.5">
          {images.length > 0 && (
            <div className={images.length > 1 ? 'grid grid-cols-2 gap-1' : ''}>
              {images.slice(0, 4).map((url) => (
                <BlossomImage
                  key={url}
                  src={url}
                  alt=""
                  maxSizeMB={chatLimitMB}
                  className={`rounded-md overflow-hidden ${images.length > 1 ? 'h-[120px]' : 'max-h-[220px]'}`}
                />
              ))}
            </div>
          )}
          {videos.map((url) => <NoteVideo key={url} src={url} />)}
          {audios.map((url) => (
            <CustomAudioPlayer key={url} src={url} title={url.split('/').pop()?.split('?')[0] || 'Audio'} preload="none" />
          ))}
        </div>
      )}
    </>
  )
}

/** Plain <video preload="none">: nothing is fetched until the user presses play. */
function NoteVideo({ src }: { src: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <a href={src} target="_blank" rel="noopener noreferrer" className="text-primary text-xs hover:underline break-all">{src}</a>
  }
  return (
    <video
      src={src}
      controls
      preload="none"
      className="w-full max-h-[220px] rounded-md bg-black/40"
      onError={() => setFailed(true)}
    />
  )
}

/* ─── Long-Form Article Card (kind 30023) ────────────────────── */

export function LongFormCard({ identifier, pubkey, relays }: {
  identifier: string
  pubkey: string
  relays?: string[]
}) {
  const { getProfile } = useProfileCache()
  const { data: event, loading } = useCachedFetch<Event>(`30023:${pubkey}:${identifier}`, () =>
    fetchEvents({ kinds: [30023], authors: [pubkey], '#d': [identifier], limit: 1 })
      .then((events) => [...events].sort((a, b) => b.created_at - a.created_at)[0] ?? null))

  if (loading) {
    return (
      <div className="my-2 rounded-lg border border-border p-3 flex items-center gap-2 text-xs text-muted-foreground max-w-[350px]">
        <Loader2 size={12} className="animate-spin" /> Loading article...
      </div>
    )
  }

  if (!event) {
    return <FallbackBadge label="Article not found" bech32={nip19.naddrEncode({ identifier, pubkey, kind: 30023, relays: relays || [] })} />
  }

  const title = event.tags.find(t => t[0] === 'title')?.[1] || 'Untitled'
  const summary = event.tags.find(t => t[0] === 'summary')?.[1] || event.content.slice(0, 200)
  const image = event.tags.find(t => t[0] === 'image')?.[1]
  const publishedAt = event.tags.find(t => t[0] === 'published_at')?.[1]
  const wordCount = event.content.split(/\s+/).length

  const profile = getProfile(event.pubkey)
  const displayName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(event.pubkey))

  const naddr = nip19.naddrEncode({ identifier, pubkey, kind: 30023, relays: relays || [] })

  return (
    <div className="my-2 rounded-lg border border-border overflow-hidden bg-secondary/10 hover:bg-secondary/20 transition-colors max-w-[350px]">
      {/* Article image */}
      {image && (
        <div className="h-28 overflow-hidden">
          <img src={image} alt="" className="w-full h-full object-cover" loading="lazy" />
        </div>
      )}

      <div className="p-3 space-y-1.5">
        {/* Icon + Title */}
        <div className="flex items-start gap-2">
          <FileText size={14} className="text-primary shrink-0 mt-0.5" />
          <h4 className="text-sm font-semibold text-foreground line-clamp-2">{title}</h4>
        </div>

        {/* Summary */}
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3 whitespace-pre-line">
          {summary}
        </p>

        {/* Author + meta */}
        <div className="flex items-center gap-2 pt-1">
          <Avatar className="h-4 w-4">
            {profile?.picture && <AvatarImage src={profile.picture} />}
            <AvatarFallback className="text-[6px] bg-primary/20 text-primary">
              {displayName.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="text-[10px] font-medium text-foreground">{displayName}</span>
          <span className="text-[10px] text-muted-foreground">
            {publishedAt ? formatTimestamp(parseInt(publishedAt)) : formatTimestamp(event.created_at)}
          </span>
          <span className="text-[10px] text-muted-foreground">· {wordCount.toLocaleString()} words</span>
        </div>

        <div className="flex items-center gap-3">
          <CopyAddress bech32={naddr} />
          <CopyShort event={event} />
          <OpenInDen onOpen={() => {
            useSocialStore.getState().setActiveArticle(naddr)
            useNavigationStore.getState().setActivePage('social')
          }} />
        </div>
      </div>
    </div>
  )
}

/* ─── Game Mod Card (kind 31142, DEG Mods) ───────────────────── */

/**
 * Inline preview for a shared game-mod naddr: the same card Discover › Game Mods renders, and the
 * same "Open this mod" chooser (degmods.com or a saved custom domain) on click. Fetches from the
 * naddr's relay hints + the DEG source relay + the user's relays, so a mod that only lives on
 * brs.degmods.com still resolves from chat. Plain https://degmods.com/... links are untouched —
 * they stay ordinary links.
 */
export function GameModCard({ identifier, pubkey, relays, openUrl }: {
  identifier: string
  pubkey: string
  relays?: string[]
  /** When the address came from a link (https://degmods.com/mod/naddr…), clicking opens THAT link instead of the chooser. */
  openUrl?: string
}) {
  const [open, setOpen] = useState(false)
  // `relays` is a fresh array from nip19.decode on every parent render — keying the fetch on the
  // array itself re-ran it (loading → card → loading…) each time e.g. the profile cache updated.
  const relayKey = (relays || []).join('|')
  // Keeps the raw event next to the parsed Mod: "Copy short" needs the event's own `s` tag + fields.
  const { data, loading } = useCachedFetch<{ mod: Mod; event: Event }>(`31142:${pubkey}:${identifier}|${relayKey}`, async () => {
    const seen = new Set<string>()
    const relaySet = [...(relays || []), ...getModRelays()].filter((r) => {
      const n = r.replace(/\/+$/, '')
      if (!n || seen.has(n)) return false
      seen.add(n)
      return true
    })
    const events = await fetchEventsFromRelays(relaySet, { kinds: [MOD_KIND], authors: [pubkey], '#d': [identifier], limit: 1 })
    const latest = [...events].sort((a, b) => b.created_at - a.created_at)[0]
    const parsed = latest ? parseModEvent(latest) : null
    return parsed && !parsed.isDeleted ? { mod: parsed, event: latest } : null
  })
  const mod = data?.mod ?? null

  const naddr = nip19.naddrEncode({ identifier, pubkey, kind: MOD_KIND, relays: relays || [] })

  if (loading) {
    return (
      <div className="my-2 rounded-lg border border-border p-3 flex items-center gap-2 text-xs text-muted-foreground max-w-[350px]">
        <Loader2 size={12} className="animate-spin" /> Loading game mod...
      </div>
    )
  }

  if (!mod) {
    return <FallbackBadge label="Game mod not found" bech32={naddr} />
  }

  return (
    <>
      <div className="my-2 max-w-[350px]">
        <ModCard mod={mod} compact onOpen={() => { if (openUrl) openExternalUrl(openUrl); else setOpen(true) }} />
        <div className="flex items-center gap-3 px-1">
          <CopyAddress bech32={naddr} />
          {data?.event && <CopyShort event={data.event} />}
        </div>
      </div>
      {open && createPortal(<ModOpenModal mod={mod} onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}

/* ─── Comment Card (kind 1111) ───────────────────────────────── */

export function CommentCard({ eventId, relays }: { eventId: string; relays?: string[] }) {
  const { getProfile } = useProfileCache()
  const { data: event, loading } = useCachedFetch<Event>(`e:${eventId}`, () =>
    fetchEvents({ ids: [eventId], limit: 1 }).then((events) => events[0] ?? null))

  if (loading) {
    return (
      <div className="my-2 rounded-lg border border-border p-3 flex items-center gap-2 text-xs text-muted-foreground max-w-[350px]">
        <Loader2 size={12} className="animate-spin" /> Loading comment...
      </div>
    )
  }

  if (!event) {
    return <FallbackBadge label="Comment not found" bech32={nip19.neventEncode({ id: eventId, relays })} />
  }

  // Extract parent reference from tags
  const parentEventId = event.tags.find(t => t[0] === 'e')?.[1]
  const parentNaddr = event.tags.find(t => t[0] === 'a')?.[1]
  const parentLabel = parentNaddr
    ? `Re: ${parentNaddr.split(':').pop()?.slice(0, 20) || 'post'}…`
    : parentEventId
      ? `Re: ${parentEventId.slice(0, 12)}…`
      : null

  const profile = getProfile(event.pubkey)
  const displayName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(event.pubkey))

  return (
    <div className="my-2 rounded-lg border border-border bg-secondary/10 hover:bg-secondary/20 transition-colors max-w-[350px]">
      {/* Parent reference header */}
      {parentLabel && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border text-[10px] text-muted-foreground bg-secondary/30">
          <MessageSquare size={10} />
          <span className="truncate">{parentLabel}</span>
        </div>
      )}

      <div className="p-3 space-y-1.5">
        <div className="flex items-center gap-2">
          <Avatar className="h-5 w-5">
            {profile?.picture && <AvatarImage src={profile.picture} />}
            <AvatarFallback className="text-[8px] bg-primary/20 text-primary">
              {displayName.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="text-xs font-semibold text-foreground">{displayName}</span>
          <span className="text-[10px] text-muted-foreground">{formatTimestamp(event.created_at)}</span>
        </div>

        <div className="text-xs text-foreground/80 whitespace-pre-wrap break-words line-clamp-4">
          {event.content}
        </div>

        <div className="flex items-center gap-3">
          <CopyAddress bech32={nip19.neventEncode({ id: eventId, relays })} />
          <CopyShort event={event} />
        </div>
      </div>
    </div>
  )
}

/* ─── Live Activity Card (kind 30311) ────────────────────────── */

export function LiveActivityCard({ identifier, pubkey, relays }: {
  identifier: string
  pubkey: string
  relays?: string[]
}) {
  const { getProfile } = useProfileCache()
  const { data: event, loading } = useCachedFetch<Event>(`30311:${pubkey}:${identifier}`, () =>
    fetchEvents({ kinds: [30311], authors: [pubkey], '#d': [identifier], limit: 1 })
      .then((events) => [...events].sort((a, b) => b.created_at - a.created_at)[0] ?? null))

  if (loading) {
    return (
      <div className="my-2 rounded-lg border border-border p-3 flex items-center gap-2 text-xs text-muted-foreground max-w-[350px]">
        <Loader2 size={12} className="animate-spin" /> Loading stream...
      </div>
    )
  }

  if (!event) {
    return <FallbackBadge label="Stream not found" bech32={nip19.naddrEncode({ identifier, pubkey, kind: 30311, relays: relays || [] })} />
  }

  const title = event.tags.find(t => t[0] === 'title')?.[1] || 'Untitled Stream'
  const summary = event.tags.find(t => t[0] === 'summary')?.[1]
  const status = event.tags.find(t => t[0] === 'status')?.[1] || 'ended'
  const streaming = event.tags.find(t => t[0] === 'streaming')?.[1]
  const image = event.tags.find(t => t[0] === 'image')?.[1]
  const viewers = event.tags.find(t => t[0] === 'current_participants')?.[1]

  const profile = getProfile(event.pubkey)
  const displayName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(event.pubkey))

  const naddr = nip19.naddrEncode({ identifier, pubkey, kind: 30311, relays: relays || [] })

  const isLive = status === 'live'
  const statusColor = isLive ? 'bg-red-500' : status === 'planned' ? 'bg-amber-500' : 'bg-muted-foreground/40'
  const statusLabel = isLive ? 'LIVE' : status === 'planned' ? 'PLANNED' : 'ENDED'

  return (
    <div className="my-2 rounded-lg border border-border overflow-hidden bg-secondary/10 hover:bg-secondary/20 transition-colors max-w-[350px]">
      {/* Stream image / thumbnail */}
      {image && (
        <div className="relative h-32 overflow-hidden">
          <img src={image} alt="" className="w-full h-full object-cover" loading="lazy" />
          {/* Status badge overlay */}
          <div className="absolute top-2 left-2 flex items-center gap-1.5">
            <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold text-white ${statusColor}`}>
              {isLive && <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />}
              {statusLabel}
            </span>
          </div>
        </div>
      )}

      <div className="p-3 space-y-1.5">
        {/* Title row */}
        <div className="flex items-start gap-2">
          <Radio size={14} className={`shrink-0 mt-0.5 ${isLive ? 'text-red-500' : 'text-muted-foreground'}`} />
          <h4 className="text-sm font-semibold text-foreground line-clamp-2">{title}</h4>
        </div>

        {/* No image — show status badge inline */}
        {!image && (
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold text-white ${statusColor}`}>
            {isLive && <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />}
            {statusLabel}
          </span>
        )}

        {/* Summary */}
        {summary && (
          <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
            {summary}
          </p>
        )}

        {/* Author + meta */}
        <div className="flex items-center gap-2 pt-0.5">
          <Avatar className="h-4 w-4">
            {profile?.picture && <AvatarImage src={profile.picture} />}
            <AvatarFallback className="text-[6px] bg-primary/20 text-primary">
              {displayName.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="text-[10px] font-medium text-foreground">{displayName}</span>
          {viewers && <span className="text-[10px] text-muted-foreground">· {viewers} watching</span>}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          {streaming && (
            <a
              href={streaming}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <ExternalLink size={10} /> {isLive ? 'Watch' : 'Open'}
            </a>
          )}
          <div className="flex items-center gap-3">
            <CopyAddress bech32={naddr} />
            <CopyShort event={event} />
          </div>
        </div>
      </div>
    </div>
  )
}

/* ─── Helpers ────────────────────────────────────────────────── */

/** "Open in DEN Chat" — jumps to the in-app view for the referenced event (thread / article reader). */
function OpenInDen({ onOpen }: { onOpen: () => void }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={(e) => { e.stopPropagation(); onOpen() }}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer mt-1"
          >
            <ArrowUpRight size={10} />
            Open in DEN Chat
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">Open in DEN Chat</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * "Copy short" — the event's NIP-SHORT address (`s` + author + 6-hex code). Only shown when the
 * event carries an `s` tag that verifies against its own fields. The author's verified DNN ID is
 * used as the authority when known (dramatically shorter); otherwise the npub. Copying needs one
 * relay round-trip to see whether the author has another event on the same code (collision
 * selector), hence the spinner.
 */
function CopyShort({ event }: { event: Event }) {
  const [state, setState] = useState<'idle' | 'busy' | 'copied'>('idle')
  if (!verifiedShortAddress(event)) return null

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (state === 'busy') return
    setState('busy')
    try {
      const authority = useDnnStore.getState().getVerifiedDnnId(event.pubkey) || undefined
      const address = await shareableShortAddress(event, authority)
      if (!address) { setState('idle'); return }
      await navigator.clipboard.writeText(address)
      setState('copied')
      setTimeout(() => setState('idle'), 2000)
    } catch {
      setState('idle')
    }
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer mt-1"
          >
            {state === 'copied' ? <Check size={10} className="text-green-500" /> : state === 'busy' ? <Loader2 size={10} className="animate-spin" /> : <Link2 size={10} />}
            {state === 'copied' ? 'Copied' : 'Copy short'}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs max-w-[220px]">Copy the NIP-SHORT address — a compact reference that resolves without any link shortener</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function CopyAddress({ bech32 }: { bech32: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(bech32)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer mt-1"
          >
            {copied ? <Check size={10} className="text-green-500" /> : <Copy size={10} />}
            {copied ? 'Copied' : 'Copy address'}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">Copy address</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function FallbackBadge({ label, bech32 }: { label: string; bech32: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <span className="inline-flex items-center gap-1.5 my-1 px-2 py-1 rounded-md border border-border text-xs text-muted-foreground">
      {label}
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={(e) => {
                e.stopPropagation()
                navigator.clipboard.writeText(bech32)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              }}
              className="hover:text-foreground cursor-pointer"
            >
              {copied ? <Check size={10} className="text-green-500" /> : <Copy size={10} />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">Copy address</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  )
}
