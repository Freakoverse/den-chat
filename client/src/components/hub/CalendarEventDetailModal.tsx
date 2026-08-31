/**
 * CalendarEventDetailModal — Full detail view for a calendar event
 *
 * Shows title, description, image, location, date/time, timezone.
 * RSVP buttons: Going / Not Going / Maybe.
 * Attendee list grouped by status.
 * Delete + Edit for creator. View Raw.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useUserStore } from '@/stores/userStore'
import { useCalendarStore } from '@/stores/calendarStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { KINDS } from '@/lib/crypto/constants'
import type { DecryptedCalendarEvent, DecryptedRsvp } from '@/hooks/useCalendar'
import { isEventLive } from '@/hooks/useCalendar'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { truncateNpub, formatTimestamp } from '@/lib/utils'
import { DeleteConfirmDialog } from '@/components/hub/ChannelView'
import {
  X, CalendarDays, MapPin, Clock, Users, Check, XIcon,
  HelpCircle, Trash2, Pencil, Code, ChevronDown, ChevronUp, Copy, ClipboardCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { nip19 } from 'nostr-tools'
import { getHour12 } from '@/stores/preferencesStore'

interface CalendarEventDetailModalProps {
  event: DecryptedCalendarEvent
  hubDTag: string
  onClose: () => void
  onEdit: () => void
  onDelete: (dTag: string) => void
  onRsvp: (
    eventARef: string,
    status: 'accepted' | 'declined' | 'tentative',
    existingDTag?: string
  ) => Promise<void>
  onDeleteRsvp: (dTag: string, eventARef: string) => Promise<void>
  decryptRsvps: (eventARef: string) => Promise<DecryptedRsvp[]>
}

function formatEventTime(ts: number): string {
  const d = new Date(ts * 1000)
  const hour12 = getHour12()
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(hour12 !== undefined ? { hour12 } : {}),
  })
}

function formatEventTimeUtc(ts: number): string {
  const d = new Date(ts * 1000)
  const hour12 = getHour12()
  return d.toLocaleString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
    ...(hour12 !== undefined ? { hour12 } : {}),
  })
}

export function CalendarEventDetailModal({
  event,
  hubDTag,
  onClose,
  onEdit,
  onDelete,
  onRsvp,
  onDeleteRsvp,
  decryptRsvps,
}: CalendarEventDetailModalProps) {
  const pubkey = useUserStore((s) => s.pubkey)
  const { getProfile } = useProfileCache()
  const fetchRsvps = useCalendarStore((s) => s.fetchRsvps)

  // Event author's real key `R` — identity-tag-verified in useCalendar (unforgeable even by the owner),
  // with a roster/wire fallback. Drives own-event controls + the author profile on v2.
  const eventAuthorReal = event.realPubkey
  const isMine = eventAuthorReal === pubkey
  const eventARef = `${KINDS.CALENDAR_TIME_EVENT}:${event.pubkey}:${event.dTag}`

  const [rsvps, setRsvps] = useState<DecryptedRsvp[]>([])
  const [rsvpLoading, setRsvpLoading] = useState(true)
  const [submittingRsvp, setSubmittingRsvp] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [expandedGroup, setExpandedGroup] = useState<string | null>('accepted')
  const [pendingUnRsvpStatus, setPendingUnRsvpStatus] = useState<'accepted' | 'declined' | 'tentative' | null>(null)
  const fetchedRef = useRef(false)

  // Fetch and decrypt RSVPs
  useEffect(() => {
    if (fetchedRef.current) return
    fetchedRef.current = true

    const load = async () => {
      setRsvpLoading(true)
      await fetchRsvps(eventARef, hubDTag)
      const decrypted = await decryptRsvps(eventARef)
      setRsvps(decrypted)
      setRsvpLoading(false)
    }
    load()
  }, [eventARef, hubDTag, fetchRsvps, decryptRsvps])

  // Re-decrypt when store changes
  const rawRsvps = useCalendarStore((s) => s.rsvps[eventARef])
  useEffect(() => {
    if (!rawRsvps) return
    decryptRsvps(eventARef).then(setRsvps)
  }, [rawRsvps, eventARef, decryptRsvps])

  // My RSVP — RSVP authors are stored as `P` on v2, so resolve `P` → `R` before matching.
  const myRsvp = useMemo(
    () => rsvps.find((r) => r.realPubkey === pubkey),
    [rsvps, pubkey]
  )

  // Grouped RSVPs
  const grouped = useMemo(() => ({
    accepted: rsvps.filter((r) => r.status === 'accepted'),
    tentative: rsvps.filter((r) => r.status === 'tentative'),
    declined: rsvps.filter((r) => r.status === 'declined'),
  }), [rsvps])

  // Handle RSVP click
  const handleRsvp = useCallback(
    async (status: 'accepted' | 'declined' | 'tentative') => {
      if (submittingRsvp) return
      if (myRsvp && myRsvp.status === status) {
        // Show confirmation for un-RSVP
        setPendingUnRsvpStatus(status)
        return
      }
      // Submit or change RSVP
      setSubmittingRsvp(true)
      try {
        await onRsvp(eventARef, status, myRsvp?.dTag)
        const decrypted = await decryptRsvps(eventARef)
        setRsvps(decrypted)
      } catch (err) {
        console.error('[Calendar] RSVP failed:', err)
      } finally {
        setSubmittingRsvp(false)
      }
    },
    [submittingRsvp, myRsvp, eventARef, onRsvp, decryptRsvps]
  )

  const confirmUnRsvp = useCallback(
    async () => {
      if (!myRsvp || !pendingUnRsvpStatus) return
      setSubmittingRsvp(true)
      try {
        await onDeleteRsvp(myRsvp.dTag, eventARef)
        const decrypted = await decryptRsvps(eventARef)
        setRsvps(decrypted)
      } catch (err) {
        console.error('[Calendar] RSVP delete failed:', err)
      } finally {
        setSubmittingRsvp(false)
        setPendingUnRsvpStatus(null)
      }
    },
    [myRsvp, pendingUnRsvpStatus, eventARef, onDeleteRsvp, decryptRsvps]
  )

  // Handle delete event
  const handleDelete = useCallback(
    async () => {
      await onDelete(event.dTag)
      onClose()
    },
    [event.dTag, onDelete, onClose]
  )

  // Creator profile
  const creatorProfile = getProfile(eventAuthorReal)
  const creatorName =
    creatorProfile?.display_name || creatorProfile?.name || truncateNpub(eventAuthorReal)

  const isPast = event.endTimestamp
    ? event.endTimestamp < Math.floor(Date.now() / 1000)
    : event.startTimestamp < Math.floor(Date.now() / 1000)

  const live = isEventLive(event)

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      >
        <div
          className="w-[560px] max-h-[85vh] bg-card border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <CalendarDays size={18} className="text-primary shrink-0" />
              <h3 className="text-base font-semibold text-foreground truncate">
                {event.title}
              </h3>
              {live ? (
                <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 font-bold shrink-0">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
                  </span>
                  LIVE
                </span>
              ) : isPast ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted-foreground/20 text-muted-foreground shrink-0">
                  Past
                </span>
              ) : null}
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0 ml-2"
            >
              <X size={18} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto">
            {/* Image */}
            {event.image && (
              <img
                src={event.image}
                alt={event.title}
                className="w-full max-h-48 object-cover"
              />
            )}

            <div className="px-5 py-4 space-y-4">
              {/* Creator */}
              <div className="flex items-center gap-2">
                <Avatar className="w-6 h-6">
                  {creatorProfile?.picture && (
                    <AvatarImage src={creatorProfile.picture} />
                  )}
                  <AvatarFallback className="text-[9px] bg-primary/20 text-primary">
                    {creatorName.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm text-foreground/80">{creatorName}</span>
                <span className="text-xs text-muted-foreground">
                  · Created {formatTimestamp(event.createdAt)}
                </span>
              </div>

              {/* Date/Time */}
              <div className="flex items-start gap-2">
                <Clock size={14} className="text-muted-foreground mt-0.5 shrink-0" />
                <div className="text-sm">
                  <div className="text-foreground">
                    {formatEventTime(event.startTimestamp)}
                  </div>
                  <div className="text-[10px] text-muted-foreground/50">
                    {formatEventTimeUtc(event.startTimestamp)}
                  </div>
                  {event.endTimestamp && (
                    <>
                      <div className="text-muted-foreground mt-1">
                        → {formatEventTime(event.endTimestamp)}
                      </div>
                      <div className="text-[10px] text-muted-foreground/50">
                        {formatEventTimeUtc(event.endTimestamp)}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Location */}
              {event.locations.length > 0 && (
                <div className="flex items-start gap-2">
                  <MapPin size={14} className="text-muted-foreground mt-0.5 shrink-0" />
                  <div className="text-sm text-foreground/80">
                    {event.locations.map((loc, i) => (
                      <div key={i}>{loc}</div>
                    ))}
                  </div>
                </div>
              )}

              {/* Summary */}
              {(event.summary || event.description) && (
                <p className="text-sm text-muted-foreground italic">
                  {event.summary || (event.description.length > 120 ? event.description.slice(0, 120) + '…' : event.description)}
                </p>
              )}

              {/* Description */}
              {event.description && (
                <div className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed border-t border-border/30 pt-3">
                  {event.description}
                </div>
              )}

              {/* RSVP buttons */}
              <div className="border-t border-border/30 pt-3">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 block">
                  RSVP
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleRsvp('accepted')}
                    disabled={submittingRsvp}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer border',
                      myRsvp?.status === 'accepted'
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400'
                        : 'bg-secondary/30 border-border/30 text-muted-foreground hover:text-foreground hover:border-emerald-500/30'
                    )}
                  >
                    <Check size={13} /> Going
                  </button>
                  <button
                    onClick={() => handleRsvp('tentative')}
                    disabled={submittingRsvp}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer border',
                      myRsvp?.status === 'tentative'
                        ? 'bg-amber-500/15 border-amber-500/40 text-amber-400'
                        : 'bg-secondary/30 border-border/30 text-muted-foreground hover:text-foreground hover:border-amber-500/30'
                    )}
                  >
                    <HelpCircle size={13} /> Maybe
                  </button>
                  <button
                    onClick={() => handleRsvp('declined')}
                    disabled={submittingRsvp}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer border',
                      myRsvp?.status === 'declined'
                        ? 'bg-red-500/15 border-red-500/40 text-red-400'
                        : 'bg-secondary/30 border-border/30 text-muted-foreground hover:text-foreground hover:border-red-500/30'
                    )}
                  >
                    <XIcon size={13} /> Not Going
                  </button>
                </div>
              </div>

              {/* Attendee list — tabs */}
              <div className="border-t border-border/30 pt-3">
                <div className="flex items-center gap-2 mb-3">
                  <Users size={14} className="text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground">Responses</span>
                </div>

                {rsvpLoading ? (
                  <div className="text-xs text-muted-foreground/50 py-2">Loading RSVPs...</div>
                ) : (
                  <>
                    {/* Tabs */}
                    <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-secondary/30 mb-3">
                      {([
                        { key: 'accepted' as const, label: 'Going', color: 'emerald', count: grouped.accepted.length },
                        { key: 'tentative' as const, label: 'Maybe', color: 'amber', count: grouped.tentative.length },
                        { key: 'declined' as const, label: 'Declined', color: 'red', count: grouped.declined.length },
                      ]).map(({ key, label, color, count }) => (
                        <button
                          key={key}
                          onClick={() => setExpandedGroup(key)}
                          className={cn(
                            'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[11px] font-medium transition-all cursor-pointer',
                            expandedGroup === key
                              ? 'bg-card shadow-sm text-foreground'
                              : 'text-muted-foreground/60 hover:text-muted-foreground'
                          )}
                        >
                          <span
                            className={cn(
                              'w-1.5 h-1.5 rounded-full',
                              color === 'emerald' && 'bg-emerald-400',
                              color === 'amber' && 'bg-amber-400',
                              color === 'red' && 'bg-red-400',
                            )}
                          />
                          {label}
                          <span className={cn(
                            'text-[10px] min-w-[18px] h-[18px] flex items-center justify-center rounded-full',
                            expandedGroup === key
                              ? cn(
                                color === 'emerald' && 'bg-emerald-500/15 text-emerald-400',
                                color === 'amber' && 'bg-amber-500/15 text-amber-400',
                                color === 'red' && 'bg-red-500/15 text-red-400',
                              )
                              : 'bg-muted-foreground/10 text-muted-foreground/50'
                          )}>
                            {count}
                          </span>
                        </button>
                      ))}
                    </div>

                    {/* Tab content */}
                    <div className="min-h-[40px]">
                      {(() => {
                        const activeGroup = expandedGroup as 'accepted' | 'tentative' | 'declined' | null
                        const items = activeGroup ? grouped[activeGroup] : []

                        if (!activeGroup) return null

                        if (items.length === 0) {
                          const emptyLabel = activeGroup === 'accepted' ? 'going' : activeGroup === 'tentative' ? 'maybe' : 'declined'
                          return (
                            <p className="text-[11px] text-muted-foreground/40 text-center py-3">
                              No one has responded {emptyLabel} yet
                            </p>
                          )
                        }

                        return (
                          <div className="space-y-0.5">
                            {items.map((r) => {
                              const attendeeReal = r.realPubkey
                              const profile = getProfile(attendeeReal)
                              const name =
                                profile?.display_name ||
                                profile?.name ||
                                truncateNpub(attendeeReal)
                              return (
                                <div
                                  key={r.pubkey}
                                  className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg hover:bg-accent/15 transition-colors"
                                >
                                  <Avatar className="w-6 h-6">
                                    {profile?.picture && (
                                      <AvatarImage src={profile.picture} />
                                    )}
                                    <AvatarFallback className="text-[9px] bg-primary/10 text-primary">
                                      {name.slice(0, 2).toUpperCase()}
                                    </AvatarFallback>
                                  </Avatar>
                                  <span className="text-xs text-foreground/80 truncate flex-1">
                                    {name}
                                  </span>
                                </div>
                              )
                            })}
                          </div>
                        )
                      })()}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Footer actions */}
          <div className="flex items-center justify-between px-5 py-3 border-t border-border">
            <div className="flex items-center gap-1">
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setShowRaw(!showRaw)}
                      className="p-1.5 rounded-md text-muted-foreground/50 hover:text-muted-foreground hover:bg-accent/30 transition-colors cursor-pointer"
                    >
                      <Code size={14} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    View raw event
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <CopyEventAddressButton pubkey={event.pubkey} dTag={event.dTag} />
            </div>
            <div className="flex items-center gap-2">
              {isMine && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setShowDeleteConfirm(true)}
                  >
                    <Trash2 size={12} className="mr-1" /> Delete
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={onEdit}
                  >
                    <Pencil size={12} className="mr-1" /> Edit
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* Raw event view */}
          {showRaw && event.rawEvent && (
            <div className="border-t border-border px-5 py-3 max-h-48 overflow-y-auto bg-secondary/20">
              <pre className="text-[10px] text-muted-foreground font-mono whitespace-pre-wrap break-all">
                {JSON.stringify(JSON.parse(event.rawEvent), null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>

      {/* Delete event confirm dialog */}
      {showDeleteConfirm && (
        <DeleteConfirmDialog
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
          title="Request Delete Event"
          confirmLabel="Yes, Delete Event"
        />
      )}

      {/* Un-RSVP confirm dialog */}
      {pendingUnRsvpStatus && (
        <DeleteConfirmDialog
          onConfirm={confirmUnRsvp}
          onCancel={() => setPendingUnRsvpStatus(null)}
          title="Remove RSVP"
          confirmLabel="Yes, Remove RSVP"
        />
      )}
    </>
  )
}

/** Small icon button that copies the naddr1 event address to clipboard */
function CopyEventAddressButton({ pubkey, dTag }: { pubkey: string; dTag: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    try {
      const naddr = nip19.naddrEncode({
        kind: KINDS.CALENDAR_TIME_EVENT,
        pubkey,
        identifier: dTag,
      })
      navigator.clipboard.writeText(naddr)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to encode naddr:', err)
    }
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleCopy}
            className="p-1.5 rounded-md text-muted-foreground/50 hover:text-muted-foreground hover:bg-accent/30 transition-colors cursor-pointer"
          >
            {copied ? <ClipboardCheck size={14} className="text-green-400" /> : <Copy size={14} />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {copied ? 'Copied!' : 'Copy event address'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
