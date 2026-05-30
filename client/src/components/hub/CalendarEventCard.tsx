/**
 * CalendarEventCard — Compact card for calendar event lists
 *
 * Shows title, date/time, location, description snippet, attendee count.
 * Inline RSVP mini-buttons. Click opens detail modal.
 * Edit button for creator.
 */

import { useMemo } from 'react'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import type { DecryptedCalendarEvent } from '@/hooks/useCalendar'
import { isEventLive } from '@/hooks/useCalendar'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { truncateNpub } from '@/lib/utils'
import { CalendarDays, MapPin, Clock, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { getHour12 } from '@/stores/preferencesStore'

interface CalendarEventCardProps {
  event: DecryptedCalendarEvent
  onClick: () => void
  onEdit?: () => void
}

function formatShortTime(ts: number): string {
  const d = new Date(ts * 1000)
  const hour12 = getHour12()
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(hour12 !== undefined ? { hour12 } : {}),
  })
}

function formatShortDate(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

export function CalendarEventCard({ event, onClick, onEdit }: CalendarEventCardProps) {
  const pubkey = useUserStore((s) => s.pubkey)
  const { getProfile } = useProfileCache()
  const isMine = event.pubkey === pubkey

  const creatorProfile = getProfile(event.pubkey)
  const creatorName =
    creatorProfile?.display_name ||
    creatorProfile?.name ||
    truncateNpub(event.pubkey)

  const isPast = event.endTimestamp
    ? event.endTimestamp < Math.floor(Date.now() / 1000)
    : event.startTimestamp < Math.floor(Date.now() / 1000)

  const live = isEventLive(event)

  const timeStr = useMemo(() => {
    const start = formatShortTime(event.startTimestamp)
    if (event.endTimestamp) {
      const end = formatShortTime(event.endTimestamp)
      return `${start} – ${end}`
    }
    return start
  }, [event])

  return (
    <div
      onClick={onClick}
      className={cn(
        'w-full text-left rounded-xl border transition-all duration-150 cursor-pointer group',
        live
          ? 'bg-blue-500/5 border-blue-500/30 hover:border-blue-500/50 hover:bg-blue-500/10'
          : 'bg-secondary/15 border-border/40 hover:border-primary/30 hover:bg-secondary/30',
        isPast && !live && 'opacity-60'
      )}
    >
      {/* Image strip */}
      {event.image && (
        <img
          src={event.image}
          alt={event.title}
          className="w-full h-24 object-cover rounded-t-xl"
        />
      )}

      <div className="px-4 py-3 space-y-2">
        {/* Title + edit */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <CalendarDays size={14} className="text-primary shrink-0" />
            <h4 className="text-sm font-semibold text-foreground truncate">
              {event.title}
            </h4>
          </div>
          {isMine && onEdit && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onEdit()
                    }}
                    className="p-1 rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all cursor-pointer shrink-0"
                  >
                    <Pencil size={12} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  Edit event
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>

        {/* Time + Live/Past badge */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock size={11} className="shrink-0" />
          <span className="truncate">{timeStr}</span>
          {live ? (
            <span className="flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400 font-bold shrink-0">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
              </span>
              LIVE
            </span>
          ) : isPast ? (
            <span className="text-[9px] px-1 py-0.5 rounded bg-muted-foreground/15 text-muted-foreground/70 shrink-0">
              Past
            </span>
          ) : null}
        </div>

        {/* Location */}
        {event.locations.length > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground/80">
            <MapPin size={11} className="shrink-0" />
            <span className="truncate">{event.locations[0]}</span>
          </div>
        )}

        {/* Summary / description snippet */}
        {(event.summary || event.description) && (
          <p className="text-xs text-muted-foreground/70 line-clamp-2 leading-relaxed">
            {event.summary || event.description}
          </p>
        )}

        {/* Creator */}
        <div className="flex items-center gap-1.5 pt-1">
          <Avatar className="w-4 h-4">
            {creatorProfile?.picture && <AvatarImage src={creatorProfile.picture} />}
            <AvatarFallback className="text-[7px] bg-muted">
              {creatorName.slice(0, 2)}
            </AvatarFallback>
          </Avatar>
          <span className="text-[10px] text-muted-foreground/60 truncate">
            {creatorName}
          </span>
        </div>
      </div>
    </div>
  )
}
