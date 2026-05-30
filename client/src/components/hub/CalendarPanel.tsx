/**
 * CalendarPanel — Modal overlay for hub calendar events
 *
 * Two tabs:
 *   1. Upcoming — paginated list of future events
 *   2. Calendar — month grid with event counts per day
 *
 * Plus a "Create Event" button.
 */

import { useState, useMemo, useCallback, useEffect } from 'react'
import { useCalendar, isEventLive, type DecryptedCalendarEvent, type CalendarEventData } from '@/hooks/useCalendar'
import { CalendarEventCard } from '@/components/hub/CalendarEventCard'
import { CalendarEventDetailModal } from '@/components/hub/CalendarEventDetailModal'
import { CreateCalendarEventModal } from '@/components/hub/CreateCalendarEventModal'
import { Pagination } from '@/components/ui/Pagination'
import { X, CalendarDays, Plus, ChevronLeft, ChevronRight, Loader2, Radio, Clock, History } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'

interface CalendarPanelProps {
  hubDTag: string
  open: boolean
  onClose: () => void
}

type PanelTab = 'live' | 'upcoming' | 'past' | 'calendar'

const PAGE_SIZE = 6
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export function CalendarPanel({ hubDTag, open, onClose }: CalendarPanelProps) {
  const {
    decryptedEvents,
    liveEventCount,
    loading,
    createEvent,
    editEvent,
    deleteEvent,
    submitRsvp,
    deleteRsvp,
    decryptRsvps,
  } = useCalendar(hubDTag)

  const [tab, setTab] = useState<PanelTab>(liveEventCount > 0 ? 'live' : 'upcoming')
  const [page, setPage] = useState(1)
  const [showCreate, setShowCreate] = useState(false)
  const [editingEvent, setEditingEvent] = useState<DecryptedCalendarEvent | null>(null)
  const [detailEvent, setDetailEvent] = useState<DecryptedCalendarEvent | null>(null)

  // Auto-switch to live tab when live events appear
  useEffect(() => {
    if (liveEventCount > 0 && tab === 'upcoming') {
      setTab('live')
      setPage(1)
    }
  }, [liveEventCount])

  // Calendar view state
  const now = new Date()
  const [viewMonth, setViewMonth] = useState(now.getMonth())
  const [viewYear, setViewYear] = useState(now.getFullYear())
  const [selectedDay, setSelectedDay] = useState<number | null>(null)

  // Sorted events
  const sortedByStart = useMemo(
    () =>
      [...decryptedEvents].sort((a, b) => a.startTimestamp - b.startTimestamp),
    [decryptedEvents]
  )

  const nowTs = Math.floor(Date.now() / 1000)

  // Live events
  const liveEvents = useMemo(
    () => sortedByStart.filter(isEventLive),
    [sortedByStart]
  )

  // Upcoming (future, not live)
  const upcomingEvents = useMemo(
    () => sortedByStart.filter((e) => {
      if (isEventLive(e)) return false
      const endTs = e.endTimestamp || e.startTimestamp
      return endTs >= nowTs
    }),
    [sortedByStart, nowTs]
  )

  // Past
  const pastEvents = useMemo(
    () => sortedByStart.filter((e) => {
      if (isEventLive(e)) return false
      const endTs = e.endTimestamp || e.startTimestamp
      return endTs < nowTs
    }).reverse(),
    [sortedByStart, nowTs]
  )

  // Current list based on tab
  const currentList = useMemo(() => {
    if (tab === 'live') return liveEvents
    if (tab === 'upcoming') return upcomingEvents
    if (tab === 'past') return pastEvents
    return []
  }, [tab, liveEvents, upcomingEvents, pastEvents])

  const totalPages = Math.max(1, Math.ceil(currentList.length / PAGE_SIZE))
  const pageEvents = useMemo(
    () => currentList.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [currentList, page]
  )

  // ─── Calendar tab ───

  // Get days in month grid
  const calendarDays = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1).getDay()
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
    const cells: (number | null)[] = []

    // Leading empty cells
    for (let i = 0; i < firstDay; i++) cells.push(null)
    for (let d = 1; d <= daysInMonth; d++) cells.push(d)
    // Trailing empty cells to fill grid
    while (cells.length % 7 !== 0) cells.push(null)

    return cells
  }, [viewYear, viewMonth])

  // Event counts per day
  const eventCountsByDay = useMemo(() => {
    const counts: Record<number, number> = {}
    for (const event of decryptedEvents) {
      const startDate = new Date(event.startTimestamp * 1000)
      const endDate = event.endTimestamp
        ? new Date(event.endTimestamp * 1000)
        : startDate

      // Check if event overlaps with current view month
      const monthStart = new Date(viewYear, viewMonth, 1)
      const monthEnd = new Date(viewYear, viewMonth + 1, 0, 23, 59, 59)

      if (startDate <= monthEnd && endDate >= monthStart) {
        // Find which days of this month the event spans
        const firstDay = startDate >= monthStart ? startDate.getDate() : 1
        const lastDay =
          endDate <= monthEnd
            ? endDate.getDate()
            : new Date(viewYear, viewMonth + 1, 0).getDate()

        for (let d = firstDay; d <= lastDay; d++) {
          counts[d] = (counts[d] || 0) + 1
        }
      }
    }
    return counts
  }, [decryptedEvents, viewYear, viewMonth])

  // Events for selected day
  const selectedDayEvents = useMemo(() => {
    if (selectedDay === null) return []
    const dayStart = new Date(viewYear, viewMonth, selectedDay, 0, 0, 0).getTime() / 1000
    const dayEnd = new Date(viewYear, viewMonth, selectedDay, 23, 59, 59).getTime() / 1000

    return sortedByStart.filter((e) => {
      const endTs = e.endTimestamp || e.startTimestamp
      return e.startTimestamp <= dayEnd && endTs >= dayStart
    })
  }, [selectedDay, sortedByStart, viewYear, viewMonth])

  const today = new Date()
  const isToday = (day: number) =>
    day === today.getDate() &&
    viewMonth === today.getMonth() &&
    viewYear === today.getFullYear()

  const isPastDay = (day: number) => {
    const d = new Date(viewYear, viewMonth, day, 23, 59, 59)
    return d < today
  }

  // Navigation
  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11)
      setViewYear(viewYear - 1)
    } else {
      setViewMonth(viewMonth - 1)
    }
    setSelectedDay(null)
  }
  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0)
      setViewYear(viewYear + 1)
    } else {
      setViewMonth(viewMonth + 1)
    }
    setSelectedDay(null)
  }

  // Handlers
  const handleCreate = useCallback(
    async (data: CalendarEventData) => {
      await createEvent(data)
      setShowCreate(false)
    },
    [createEvent]
  )

  const handleEdit = useCallback(
    async (data: CalendarEventData) => {
      if (!editingEvent) return
      await editEvent(editingEvent.dTag, data)
      setEditingEvent(null)
      setDetailEvent(null)
    },
    [editEvent, editingEvent]
  )

  const handleRsvp = useCallback(
    async (eventARef: string, status: 'accepted' | 'declined' | 'tentative', existingDTag?: string) => {
      await submitRsvp(eventARef, status, undefined, existingDTag)
    },
    [submitRsvp]
  )

  if (!open) return null

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      >
        <div
          className="w-[640px] max-h-[85vh] bg-card border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div className="flex items-center gap-3">
              <CalendarDays size={18} className="text-primary" />
              <h3 className="text-base font-semibold text-foreground">Events</h3>
              <span className="text-xs text-muted-foreground/60">
                {decryptedEvents.length} event{decryptedEvents.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={() => setShowCreate(true)}
              >
                <Plus size={13} className="mr-1" /> Create Event
              </Button>
              <button
                onClick={onClose}
                className="p-1 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              >
                <X size={18} />
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1 px-3 pt-2 pb-0">
            {/* Live tab */}
            <button
              onClick={() => { setTab('live'); setPage(1) }}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer',
                tab === 'live'
                  ? 'bg-blue-500/15 text-blue-400'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/30'
              )}
            >
              <Radio size={13} />
              Live
              {liveEventCount > 0 && (
                <span className="text-[10px] min-w-[16px] h-4 flex items-center justify-center rounded-full bg-blue-500/20 text-blue-400">
                  {liveEventCount}
                </span>
              )}
            </button>
            <button
              onClick={() => { setTab('upcoming'); setPage(1) }}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer',
                tab === 'upcoming'
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/30'
              )}
            >
              <Clock size={13} /> Upcoming
            </button>
            <button
              onClick={() => { setTab('past'); setPage(1) }}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer',
                tab === 'past'
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/30'
              )}
            >
              <History size={13} /> Past
            </button>

            {/* Calendar icon button — pushed to the right */}
            <div className="ml-auto">
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => { setTab('calendar'); setPage(1) }}
                      className={cn(
                        'p-1.5 rounded-lg transition-colors cursor-pointer',
                        tab === 'calendar'
                          ? 'bg-primary/15 text-primary'
                          : 'text-muted-foreground hover:text-foreground hover:bg-accent/30'
                      )}
                    >
                      <CalendarDays size={14} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    Calendar view
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-3">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 size={20} className="animate-spin text-primary/50" />
                <span className="ml-2 text-sm text-muted-foreground">Loading events...</span>
              </div>
            ) : tab === 'live' || tab === 'upcoming' || tab === 'past' ? (
              /* ─── List tabs ─── */
              <>
                {currentList.length === 0 ? (
                  <div className="text-center py-12">
                    <CalendarDays size={32} className="mx-auto text-muted-foreground/30 mb-3" />
                    <p className="text-sm text-muted-foreground">
                      {tab === 'live' ? 'No events are live right now' :
                        tab === 'upcoming' ? 'No upcoming events' :
                          'No past events'}
                    </p>
                    {tab === 'upcoming' && (
                      <p className="text-xs text-muted-foreground/50 mt-1">
                        Create one to get started
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    {pageEvents.map((event) => (
                      <CalendarEventCard
                        key={event.id}
                        event={event}
                        onClick={() => setDetailEvent(event)}
                        onEdit={() => setEditingEvent(event)}
                      />
                    ))}
                  </div>
                )}
                <Pagination
                  currentPage={page}
                  totalPages={totalPages}
                  onPageChange={setPage}
                />
              </>
            ) : (
              /* ─── Calendar grid ─── */
              <>
                {/* Month navigation */}
                <div className="flex items-center justify-between mb-3">
                  <button
                    onClick={prevMonth}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <h4 className="text-sm font-semibold text-foreground">
                    {MONTHS[viewMonth]} {viewYear}
                  </h4>
                  <button
                    onClick={nextMonth}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>

                {/* Day headers */}
                <div className="grid grid-cols-7 gap-px mb-1">
                  {DAYS.map((d) => (
                    <div
                      key={d}
                      className="text-center text-[10px] font-medium text-muted-foreground/60 py-1"
                    >
                      {d}
                    </div>
                  ))}
                </div>

                {/* Day cells */}
                <div className="grid grid-cols-7 gap-1">
                  {calendarDays.map((day, i) => {
                    if (day === null) {
                      return <div key={`empty-${i}`} className="h-12" />
                    }

                    const count = eventCountsByDay[day] || 0
                    const isSelected = selectedDay === day
                    const todayHighlight = isToday(day)
                    const past = isPastDay(day)

                    return (
                      <button
                        key={day}
                        onClick={() => setSelectedDay(isSelected ? null : day)}
                        className={cn(
                          'h-12 rounded-lg flex flex-col items-center justify-center gap-0.5 transition-all cursor-pointer relative',
                          isSelected
                            ? 'bg-primary/15 border border-primary/40'
                            : 'hover:bg-accent/30 border border-transparent',
                          past && !todayHighlight && 'opacity-50'
                        )}
                      >
                        <span
                          className={cn(
                            'text-xs font-medium',
                            todayHighlight
                              ? 'text-primary font-bold'
                              : 'text-foreground/80'
                          )}
                        >
                          {day}
                        </span>
                        {todayHighlight && (
                          <div className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-primary" />
                        )}
                        {count > 0 && (
                          <span className="text-[9px] font-bold px-1.5 py-0 rounded-full bg-primary/20 text-primary leading-tight">
                            {count}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>

                {/* Selected day events */}
                {selectedDay !== null && (
                  <div className="mt-3 border-t border-border/30 pt-3">
                    <h5 className="text-xs font-medium text-muted-foreground mb-2">
                      {MONTHS[viewMonth]} {selectedDay}, {viewYear}
                      {selectedDayEvents.length > 0 && (
                        <span className="ml-1 text-muted-foreground/50">
                          · {selectedDayEvents.length} event{selectedDayEvents.length !== 1 ? 's' : ''}
                        </span>
                      )}
                    </h5>
                    {selectedDayEvents.length === 0 ? (
                      <p className="text-xs text-muted-foreground/50 py-2">
                        No events on this day
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {selectedDayEvents.map((event) => (
                          <CalendarEventCard
                            key={event.id}
                            event={event}
                            onClick={() => setDetailEvent(event)}
                            onEdit={() => setEditingEvent(event)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Create modal */}
      {showCreate && (
        <CreateCalendarEventModal
          onClose={() => setShowCreate(false)}
          onSubmit={handleCreate}
        />
      )}

      {/* Edit modal */}
      {editingEvent && (
        <CreateCalendarEventModal
          onClose={() => setEditingEvent(null)}
          onSubmit={handleEdit}
          editEvent={editingEvent}
        />
      )}

      {/* Detail modal */}
      {detailEvent && (
        <CalendarEventDetailModal
          event={detailEvent}
          hubDTag={hubDTag}
          onClose={() => setDetailEvent(null)}
          onEdit={() => {
            setEditingEvent(detailEvent)
            setDetailEvent(null)
          }}
          onDelete={(dTag) => {
            deleteEvent(dTag)
            setDetailEvent(null)
          }}
          onRsvp={handleRsvp}
          onDeleteRsvp={deleteRsvp}
          decryptRsvps={decryptRsvps}
        />
      )}
    </>
  )
}
