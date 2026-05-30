/**
 * NostrCards — Shared card components for rendering nostr references inline
 *
 * Used by both MessageContent (hub chat + DMs) and RichContent (social posts).
 * Each card fetches its event data and renders a compact, styled preview.
 */

import { useState, useEffect } from 'react'
import { useProfileCache } from '@/hooks/useProfileCache'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { nip19 } from 'nostr-tools'
import { truncateNpub, formatTimestamp } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Copy, Check, Loader2, FileText, MessageSquare, Radio, ExternalLink } from 'lucide-react'
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
      className="inline text-primary font-medium bg-primary/10 hover:bg-primary/20 p-0.5 rounded transition-colors cursor-pointer"
    >
      @{name}
    </button>
  )
}

/* ─── Embedded Note (kind 1) ─────────────────────────────────── */

export function NoteCard({ eventId }: { eventId: string }) {
  const [event, setEvent] = useState<Event | null>(null)
  const [loading, setLoading] = useState(true)
  const { getProfile } = useProfileCache()

  useEffect(() => {
    fetchEvents({ ids: [eventId], limit: 1 }).then((events) => {
      if (events.length > 0) setEvent(events[0])
      setLoading(false)
    })
  }, [eventId])

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
      <div className="text-xs text-foreground/80 whitespace-pre-wrap break-words line-clamp-4">
        {event.content}
      </div>
      <CopyAddress bech32={nip19.noteEncode(eventId)} />
    </div>
  )
}

/* ─── Long-Form Article Card (kind 30023) ────────────────────── */

export function LongFormCard({ identifier, pubkey, relays }: {
  identifier: string
  pubkey: string
  relays?: string[]
}) {
  const [event, setEvent] = useState<Event | null>(null)
  const [loading, setLoading] = useState(true)
  const { getProfile } = useProfileCache()

  useEffect(() => {
    fetchEvents({
      kinds: [30023],
      authors: [pubkey],
      '#d': [identifier],
      limit: 1,
    }).then((events) => {
      if (events.length > 0) setEvent(events.sort((a, b) => b.created_at - a.created_at)[0])
      setLoading(false)
    })
  }, [identifier, pubkey])

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

        <CopyAddress bech32={naddr} />
      </div>
    </div>
  )
}

/* ─── Comment Card (kind 1111) ───────────────────────────────── */

export function CommentCard({ eventId, relays }: { eventId: string; relays?: string[] }) {
  const [event, setEvent] = useState<Event | null>(null)
  const [loading, setLoading] = useState(true)
  const { getProfile } = useProfileCache()

  useEffect(() => {
    fetchEvents({ ids: [eventId], limit: 1 }).then((events) => {
      if (events.length > 0) setEvent(events[0])
      setLoading(false)
    })
  }, [eventId])

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

        <CopyAddress bech32={nip19.neventEncode({ id: eventId, relays })} />
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
  const [event, setEvent] = useState<Event | null>(null)
  const [loading, setLoading] = useState(true)
  const { getProfile } = useProfileCache()

  useEffect(() => {
    fetchEvents({
      kinds: [30311],
      authors: [pubkey],
      '#d': [identifier],
      limit: 1,
    }).then((events) => {
      if (events.length > 0) setEvent(events.sort((a, b) => b.created_at - a.created_at)[0])
      setLoading(false)
    })
  }, [identifier, pubkey])

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
          <CopyAddress bech32={naddr} />
        </div>
      </div>
    </div>
  )
}

/* ─── Helpers ────────────────────────────────────────────────── */

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
