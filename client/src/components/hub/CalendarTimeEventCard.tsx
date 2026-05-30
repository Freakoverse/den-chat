/**
 * CalendarTimeEventCard — Inline card for rendering calendar event links (naddr for kind 31923)
 *
 * Three states based on event origin:
 * 1. Same hub — decrypt and show full event details + "View Event" button
 * 2. Different hub — show locked/encrypted card
 * 3. Public NIP-52 — show plaintext tag data (no h tag)
 *
 * Plus loading / not-found / decrypting states.
 */

import { useState, useEffect, useCallback } from 'react'
import { useHubStore } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { useCalendar, isEventLive, type DecryptedCalendarEvent } from '@/hooks/useCalendar'
import { CalendarEventDetailModal } from '@/components/hub/CalendarEventDetailModal'
import { CreateCalendarEventModal } from '@/components/hub/CreateCalendarEventModal'
import { fetchEvents, subscribeToRelays } from '@/lib/nostr/relay-pool'
import { KINDS } from '@/lib/crypto/constants'
import { aesDecrypt } from '@/lib/crypto/aes'
import { deriveEventsKey } from '@/lib/crypto/hkdf'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { truncateNpub } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import {
  CalendarDays, Clock, MapPin, Lock, Loader2, AlertTriangle, ExternalLink, Globe,
} from 'lucide-react'
import { getHour12 } from '@/stores/preferencesStore'

interface CalendarTimeEventCardProps {
  identifier: string
  pubkey: string
  relays?: string[]
}

interface FetchedEvent {
  id: string
  pubkey: string
  content: string
  createdAt: number
  hubDTag: string | null  // null = public NIP-52 event
  dTag: string
  tags: string[][]
  rawEvent: string
}

/** Format a unix timestamp to a short local date/time string */
function formatShortDateTime(ts: number): string {
  const d = new Date(ts * 1000)
  const hour12 = getHour12()
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', ...(hour12 !== undefined ? { hour12 } : {}) })
}

export function CalendarTimeEventCard({ identifier, pubkey, relays }: CalendarTimeEventCardProps) {
  const hubs = useHubStore((s) => s.hubs)
  const hubEntries = useHubStore((s) => s.hubEntries)
  const hubSecrets = useHubStore((s) => s.hubSecrets)
  const activeHubId = useHubStore((s) => s.activeHubId)
  const { getProfile } = useProfileCache()

  const [fetchedEvent, setFetchedEvent] = useState<FetchedEvent | null>(null)
  const [loading, setLoading] = useState(true)
  const [decrypted, setDecrypted] = useState<DecryptedCalendarEvent | null>(null)
  const [publicEvent, setPublicEvent] = useState<{
    title: string
    description?: string
    location?: string
    startTs?: number
    endTs?: number
  } | null>(null)
  const [decryptionFailed, setDecryptionFailed] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const [showEdit, setShowEdit] = useState(false)

  // For the detail modal we need the calendar hook for RSVP support
  const isSameHub = fetchedEvent?.hubDTag === activeHubId && !!activeHubId
  const calendarHubDTag = isSameHub ? activeHubId : null

  const calendar = useCalendar(calendarHubDTag)

  // Fetch the event
  useEffect(() => {
    let cancelled = false

    const filter: any = {
      kinds: [KINDS.CALENDAR_TIME_EVENT],
      authors: [pubkey],
      '#d': [identifier],
      limit: 1,
    }

    const handleEvent = (event: any) => {
      if (cancelled) return
      const dTag = event.tags.find((t: string[]) => t[0] === 'd')?.[1] || identifier
      const hubDTag = event.tags.find((t: string[]) => t[0] === 'h')?.[1] || null

      setFetchedEvent({
        id: event.id,
        pubkey: event.pubkey,
        content: event.content,
        createdAt: event.created_at,
        hubDTag,
        dTag,
        tags: event.tags,
        rawEvent: JSON.stringify(event),
      })
    }

    if (relays && relays.length > 0) {
      const sub = subscribeToRelays(
        relays,
        filter,
        handleEvent,
        () => { sub.close(); if (!cancelled) setLoading(false) }
      )
      const timer = setTimeout(() => { sub.close(); if (!cancelled) setLoading(false) }, 10000)
      return () => { cancelled = true; clearTimeout(timer); sub.close() }
    } else {
      fetchEvents(filter).then((events) => {
        if (!cancelled && events.length > 0) handleEvent(events[0])
        if (!cancelled) setLoading(false)
      }).catch(() => { if (!cancelled) setLoading(false) })
      return () => { cancelled = true }
    }
  }, [identifier, pubkey, relays])

  // Attempt decryption / parse public event
  useEffect(() => {
    if (!fetchedEvent) return

    // ── Public NIP-52 event (no h tag) ──
    if (!fetchedEvent.hubDTag) {
      const title = fetchedEvent.tags.find(t => t[0] === 'title')?.[1] ||
                    fetchedEvent.tags.find(t => t[0] === 'name')?.[1] || 'Untitled Event'
      const startTag = fetchedEvent.tags.find(t => t[0] === 'start')
      const endTag = fetchedEvent.tags.find(t => t[0] === 'end')
      const locationTag = fetchedEvent.tags.find(t => t[0] === 'location')

      setPublicEvent({
        title,
        description: fetchedEvent.content || undefined,
        location: locationTag?.[1],
        startTs: startTag ? parseInt(startTag[1], 10) : undefined,
        endTs: endTag ? parseInt(endTag[1], 10) : undefined,
      })
      return
    }

    // ── Hub event — try to decrypt ──
    const secretHex = hubSecrets[fetchedEvent.hubDTag]
    if (!secretHex) {
      setDecryptionFailed(true)
      return
    }

    const tryDecrypt = async () => {
      try {
        const secret = new Uint8Array(secretHex.length / 2)
        for (let i = 0; i < secretHex.length; i += 2) {
          secret[i / 2] = parseInt(secretHex.substring(i, i + 2), 16)
        }

        const hub = hubs[fetchedEvent.hubDTag!]
        const epoch = hub?.epoch || 1
        const key = deriveEventsKey(secret, fetchedEvent.hubDTag!, epoch)

        // Check if deleted
        const isDeleted = fetchedEvent.tags.some(t => t[0] === 'deleted')
        if (isDeleted) {
          setDecryptionFailed(true)
          return
        }

        // Decrypt tag values
        const decryptTag = async (tagName: string): Promise<string | undefined> => {
          const tag = fetchedEvent.tags.find(t => t[0] === tagName)
          if (!tag || !tag[1]) return undefined
          try { return await aesDecrypt(key, tag[1]) } catch { return undefined }
        }

        const decryptTags = async (tagName: string): Promise<string[]> => {
          const matching = fetchedEvent.tags.filter(t => t[0] === tagName && t[1])
          const results: string[] = []
          for (const tag of matching) {
            try { results.push(await aesDecrypt(key, tag[1])) } catch { /* skip */ }
          }
          return results
        }

        const title = await decryptTag('title') || 'Untitled Event'
        const description = fetchedEvent.content
          ? await (async () => { try { return await aesDecrypt(key, fetchedEvent.content) } catch { return '' } })()
          : ''
        const summary = await decryptTag('summary')
        const image = await decryptTag('image')
        const locations = await decryptTags('location')
        const geohash = await decryptTag('g')

        const startStr = await decryptTag('start')
        const endStr = await decryptTag('end')

        const startTimestamp = startStr ? parseInt(startStr, 10) : 0
        const endTimestamp = endStr ? parseInt(endStr, 10) : undefined

        setDecrypted({
          id: fetchedEvent.id,
          pubkey: fetchedEvent.pubkey,
          dTag: fetchedEvent.dTag,
          createdAt: fetchedEvent.createdAt,
          title,
          summary,
          image,
          description,
          locations,
          geohash,
          startTimestamp,
          endTimestamp,
          deleted: false,
          rawEvent: fetchedEvent.rawEvent,
        })
      } catch {
        setDecryptionFailed(true)
      }
    }

    tryDecrypt()
  }, [fetchedEvent, hubSecrets, hubs])

  // Hub membership check
  const isMember = fetchedEvent?.hubDTag
    ? hubEntries.some(e => e.dTag === fetchedEvent.hubDTag) || !!hubs[fetchedEvent.hubDTag]
    : false

  // ── Loading ──
  if (loading) {
    return (
      <div className="my-2 rounded-lg border border-border p-3 max-w-[350px] animate-pulse">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-full bg-secondary" />
          <div className="h-3 bg-secondary rounded w-32" />
        </div>
        <div className="h-3 bg-secondary rounded w-full mt-2" />
        <div className="h-3 bg-secondary rounded w-2/3 mt-1" />
      </div>
    )
  }

  // ── Not found ──
  if (!fetchedEvent) {
    return (
      <div className="my-2 rounded-lg border border-border p-3 max-w-[350px] text-xs text-muted-foreground flex items-center gap-2">
        <AlertTriangle size={12} />
        Calendar event not found
      </div>
    )
  }

  const profile = getProfile(fetchedEvent.pubkey)
  const authorName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(fetchedEvent.pubkey))
  const hubName = fetchedEvent.hubDTag
    ? (hubs[fetchedEvent.hubDTag]?.name || fetchedEvent.hubDTag.slice(0, 12) + '…')
    : null

  // ── Public NIP-52 Event ──
  if (publicEvent) {
    const isLive = publicEvent.startTs && publicEvent.endTs
      ? publicEvent.startTs <= Date.now() / 1000 && Date.now() / 1000 <= publicEvent.endTs
      : false

    return (
      <div
        className="my-2 rounded-lg border border-border overflow-hidden bg-secondary/20 hover:bg-secondary/30 transition-colors max-w-[350px]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header — public event */}
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary/40 border-b border-border/50 text-[10px] text-muted-foreground">
          <Globe size={10} className="shrink-0" />
          <span className="font-medium">Public Calendar Event</span>
        </div>

        <div className="p-3 space-y-2">
          {/* Title */}
          <div className="flex items-center gap-2">
            <CalendarDays size={14} className="text-primary shrink-0" />
            <h4 className="text-sm font-semibold text-foreground truncate">{publicEvent.title}</h4>
            {isLive && (
              <span className="flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400 font-bold shrink-0">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
                </span>
                LIVE
              </span>
            )}
          </div>

          {/* Time */}
          {publicEvent.startTs && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock size={11} className="shrink-0" />
              <span>{formatShortDateTime(publicEvent.startTs)}</span>
              {publicEvent.endTs && (
                <span>– {formatShortDateTime(publicEvent.endTs)}</span>
              )}
            </div>
          )}

          {/* Location */}
          {publicEvent.location && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground/80">
              <MapPin size={11} className="shrink-0" />
              <span className="truncate">{publicEvent.location}</span>
            </div>
          )}

          {/* Description preview */}
          {publicEvent.description && (
            <p className="text-xs text-foreground/70 whitespace-pre-wrap break-words line-clamp-3">
              {publicEvent.description}
            </p>
          )}

          {/* Author */}
          <div className="flex items-center gap-2 pt-0.5">
            <Avatar className="h-4 w-4">
              {profile?.picture && <AvatarImage src={profile.picture} />}
              <AvatarFallback className="text-[7px] bg-primary/20 text-primary">
                {authorName.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="text-[10px] text-muted-foreground">{authorName}</span>
          </div>
        </div>
      </div>
    )
  }

  // ── Hub Event — Decrypted ──
  if (decrypted) {
    const live = isEventLive(decrypted)
    const isExternal = fetchedEvent.hubDTag !== activeHubId

    return (
      <>
        <div
          className="my-2 rounded-lg border border-border overflow-hidden bg-secondary/20 hover:bg-secondary/30 transition-colors max-w-[350px]"
          onClick={e => e.stopPropagation()}
        >
          {/* Header — hub context */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary/40 border-b border-border/50 text-[10px] text-muted-foreground">
            <CalendarDays size={10} className="shrink-0" />
            <span className="font-medium truncate">{hubName}</span>
            <span className="text-muted-foreground/50">›</span>
            <span className="truncate">Event</span>
            {isExternal && (
              <span className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 text-[9px] font-medium shrink-0">
                <ExternalLink size={8} />
                External
              </span>
            )}
          </div>

          <div className="p-3 space-y-2">
            {/* Image */}
            {decrypted.image && (
              <img
                src={decrypted.image}
                alt={decrypted.title}
                className="w-full h-20 object-cover rounded-md"
              />
            )}

            {/* Title */}
            <div className="flex items-center gap-2">
              <CalendarDays size={14} className="text-primary shrink-0" />
              <h4 className="text-sm font-semibold text-foreground truncate">{decrypted.title}</h4>
              {live && (
                <span className="flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400 font-bold shrink-0">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
                  </span>
                  LIVE
                </span>
              )}
            </div>

            {/* Time */}
            {decrypted.startTimestamp > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock size={11} className="shrink-0" />
                <span>{formatShortDateTime(decrypted.startTimestamp)}</span>
                {decrypted.endTimestamp && (
                  <span>– {formatShortDateTime(decrypted.endTimestamp)}</span>
                )}
              </div>
            )}

            {/* Location */}
            {decrypted.locations.length > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground/80">
                <MapPin size={11} className="shrink-0" />
                <span className="truncate">{decrypted.locations[0]}</span>
              </div>
            )}

            {/* Description */}
            {decrypted.description && (
              <p className="text-xs text-foreground/70 whitespace-pre-wrap break-words line-clamp-3">
                {decrypted.description}
              </p>
            )}

            {/* External hub note */}
            {isExternal && (
              <div className="flex items-center gap-1.5 text-[10px] text-amber-400/80 bg-amber-500/5 rounded px-2 py-1 border border-amber-500/10">
                <ExternalLink size={10} className="shrink-0" />
                <span>From <strong>{hubName}</strong> — not this hub</span>
              </div>
            )}

            {/* Author */}
            <div className="flex items-center gap-2 pt-0.5">
              <Avatar className="h-4 w-4">
                {profile?.picture && <AvatarImage src={profile.picture} />}
                <AvatarFallback className="text-[7px] bg-primary/20 text-primary">
                  {authorName.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="text-[10px] text-muted-foreground">{authorName}</span>
            </div>

            {/* View Event button */}
            <button
              onClick={() => setShowDetail(true)}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 transition-colors cursor-pointer"
            >
              <ExternalLink size={12} />
              View Event
            </button>
          </div>
        </div>

        {/* Detail modal */}
        {showDetail && (
          <CalendarEventDetailModal
            event={decrypted}
            hubDTag={fetchedEvent.hubDTag!}
            onClose={() => setShowDetail(false)}
            onRsvp={calendar.submitRsvp}
            onDeleteRsvp={calendar.deleteRsvp}
            onDelete={calendar.deleteEvent}
            onEdit={() => {
              setShowDetail(false)
              setShowEdit(true)
            }}
            decryptRsvps={calendar.decryptRsvps}
          />
        )}

        {/* Edit modal */}
        {showEdit && (
          <CreateCalendarEventModal
            onClose={() => setShowEdit(false)}
            onSubmit={async (data) => {
              await calendar.editEvent(decrypted.dTag, data)
              setShowEdit(false)
            }}
            editEvent={decrypted}
          />
        )}
      </>
    )
  }

  // ── Hub Event — Not a member / can't decrypt ──
  return (
    <div
      className="my-2 rounded-lg border border-border overflow-hidden bg-secondary/20 max-w-[350px]"
      onClick={e => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary/40 border-b border-border/50 text-[10px] text-muted-foreground">
        <CalendarDays size={10} className="shrink-0" />
        <span className="font-medium truncate">{hubName || 'Hub Event'}</span>
        <span className="text-muted-foreground/50">›</span>
        <span className="truncate">Event</span>
      </div>

      <div className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <CalendarDays size={14} className="text-muted-foreground/50 shrink-0" />
          <h4 className="text-sm font-semibold text-foreground/50">Calendar Event</h4>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
          <Lock size={12} className="shrink-0 text-amber-400/70" />
          <span>
            {!isMember
              ? "You're not a member of this hub — join to view this event"
              : 'Encrypted event — unable to decrypt'
            }
          </span>
        </div>

        {/* Author */}
        <div className="flex items-center gap-2 pt-0.5">
          <Avatar className="h-4 w-4">
            {profile?.picture && <AvatarImage src={profile.picture} />}
            <AvatarFallback className="text-[7px] bg-primary/20 text-primary">
              {authorName.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="text-[10px] text-muted-foreground">{authorName}</span>
        </div>
      </div>
    </div>
  )
}
