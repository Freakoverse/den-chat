/**
 * DatePicker — Custom styled date picker matching DEN Chat UI
 *
 * Renders a clickable input that opens a month-grid dropdown calendar.
 * Supports minDate to disable earlier dates.
 */

import { useState, useRef, useEffect, useMemo } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

interface DatePickerProps {
  value: string // YYYY-MM-DD
  onChange: (value: string) => void
  placeholder?: string
  /** Minimum selectable date (YYYY-MM-DD). Days before this are disabled. */
  minDate?: string
}

function parseDateStr(s: string) {
  const [y, m, d] = s.split('-').map(Number)
  return { year: y, month: m - 1, day: d }
}

export function DatePicker({ value, onChange, placeholder = 'Select date', minDate }: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Parse value
  const selected = useMemo(() => {
    if (!value) return null
    return parseDateStr(value)
  }, [value])

  // Parse minDate
  const min = useMemo(() => {
    if (!minDate) return null
    return parseDateStr(minDate)
  }, [minDate])

  const now = new Date()
  const [viewMonth, setViewMonth] = useState(selected?.month ?? now.getMonth())
  const [viewYear, setViewYear] = useState(selected?.year ?? now.getFullYear())

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Grid days
  const calendarDays = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1).getDay()
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
    const cells: (number | null)[] = []
    for (let i = 0; i < firstDay; i++) cells.push(null)
    for (let d = 1; d <= daysInMonth; d++) cells.push(d)
    while (cells.length % 7 !== 0) cells.push(null)
    return cells
  }, [viewYear, viewMonth])

  const isToday = (day: number) =>
    day === now.getDate() && viewMonth === now.getMonth() && viewYear === now.getFullYear()

  const isSelected = (day: number) =>
    selected !== null &&
    day === selected.day &&
    viewMonth === selected.month &&
    viewYear === selected.year

  const isDisabled = (day: number) => {
    if (!min) return false
    const cellDate = new Date(viewYear, viewMonth, day)
    const minD = new Date(min.year, min.month, min.day)
    // Compare date-only (strip time)
    cellDate.setHours(0, 0, 0, 0)
    minD.setHours(0, 0, 0, 0)
    return cellDate < minD
  }

  const handleSelect = (day: number) => {
    if (isDisabled(day)) return
    const m = String(viewMonth + 1).padStart(2, '0')
    const d = String(day).padStart(2, '0')
    onChange(`${viewYear}-${m}-${d}`)
    setOpen(false)
  }

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(viewYear - 1) }
    else setViewMonth(viewMonth - 1)
  }
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(viewYear + 1) }
    else setViewMonth(viewMonth + 1)
  }

  // Display value
  const displayText = selected
    ? `${SHORT_MONTHS[selected.month]} ${selected.day}, ${selected.year}`
    : placeholder

  return (
    <div ref={ref} className="relative">
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          'w-full flex items-center justify-between gap-2 px-3 py-1.5 bg-secondary/50 border border-border rounded-lg text-sm outline-none transition-colors cursor-pointer',
          'hover:border-primary/30',
          value ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        <span>{displayText}</span>
        <CalendarDays size={13} className="text-muted-foreground/50 shrink-0" />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-[60] mt-1 left-0 w-[260px] bg-card border border-border rounded-xl shadow-2xl p-3">
          {/* Month nav */}
          <div className="flex items-center justify-between mb-2">
            <button
              onClick={prevMonth}
              className="p-1 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="text-xs font-semibold text-foreground">
              {MONTHS[viewMonth]} {viewYear}
            </span>
            <button
              onClick={nextMonth}
              className="p-1 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <ChevronRight size={14} />
            </button>
          </div>

          {/* Day headers */}
          <div className="grid grid-cols-7 gap-0.5 mb-0.5">
            {DAYS.map((d) => (
              <div key={d} className="text-center text-[9px] font-medium text-muted-foreground/50 py-0.5">
                {d}
              </div>
            ))}
          </div>

          {/* Day cells */}
          <div className="grid grid-cols-7 gap-0.5">
            {calendarDays.map((day, i) => {
              if (day === null) return <div key={`e-${i}`} className="h-8" />

              const disabled = isDisabled(day)

              return (
                <button
                  key={day}
                  onClick={() => handleSelect(day)}
                  disabled={disabled}
                  className={cn(
                    'h-8 rounded-md text-xs font-medium transition-all',
                    disabled
                      ? 'text-muted-foreground/20 cursor-not-allowed'
                      : 'cursor-pointer',
                    !disabled && isSelected(day)
                      ? 'bg-primary text-primary-foreground'
                      : !disabled && isToday(day)
                        ? 'text-primary font-bold hover:bg-accent/40'
                        : !disabled
                          ? 'text-foreground/70 hover:bg-accent/40'
                          : ''
                  )}
                >
                  {day}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
