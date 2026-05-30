/**
 * TimePicker — Custom styled time picker matching DEN Chat UI
 *
 * Automatically switches between 12h (AM/PM toggle) and 24h (0-23 range)
 * based on the user's time format preference in Settings > Preferences.
 * Value is stored as "HH:mm" in 24h format internally regardless of display mode.
 */

import { useState, useMemo, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { usePreferencesStore, type TimeFormat } from '@/stores/preferencesStore'

interface TimePickerProps {
  value: string // "HH:mm" 24h format
  onChange: (value: string) => void
  placeholder?: string
}

/** Detect whether the browser locale defaults to 12h */
function browserUses12h(): boolean {
  try {
    const formatted = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions()
    return formatted.hourCycle === 'h12' || formatted.hourCycle === 'h11'
  } catch {
    return true // fallback to 12h
  }
}

export function TimePicker({ value, onChange }: TimePickerProps) {
  const timeFormat = usePreferencesStore((s) => s.timeFormat)
  const use12h = timeFormat === '12h' || (timeFormat === 'auto' && browserUses12h())

  if (use12h) {
    return <TimePicker12h value={value} onChange={onChange} />
  }
  return <TimePicker24h value={value} onChange={onChange} />
}

// ── 12-hour mode ──

function TimePicker12h({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const parsed = useMemo(() => {
    if (!value) return { hour12: '', minute: '', period: 'AM' as 'AM' | 'PM' }
    const [hStr, mStr] = value.split(':')
    let h = parseInt(hStr, 10)
    const period: 'AM' | 'PM' = h >= 12 ? 'PM' : 'AM'
    if (h === 0) h = 12
    else if (h > 12) h -= 12
    return { hour12: h.toString(), minute: mStr || '00', period }
  }, [value])

  const [hourInput, setHourInput] = useState(parsed.hour12)
  const [minuteInput, setMinuteInput] = useState(parsed.minute)
  const [period, setPeriod] = useState<'AM' | 'PM'>(parsed.period)

  const emitChange = useCallback(
    (h: string, m: string, p: 'AM' | 'PM') => {
      const hourNum = parseInt(h, 10)
      const minNum = parseInt(m, 10)
      if (isNaN(hourNum) || isNaN(minNum)) return
      if (hourNum < 1 || hourNum > 12 || minNum < 0 || minNum > 59) return

      let h24 = hourNum
      if (p === 'AM' && h24 === 12) h24 = 0
      else if (p === 'PM' && h24 !== 12) h24 += 12

      const val = `${String(h24).padStart(2, '0')}:${String(minNum).padStart(2, '0')}`
      onChange(val)
    },
    [onChange]
  )

  const handleHourChange = (val: string) => {
    const clean = val.replace(/\D/g, '').slice(0, 2)
    setHourInput(clean)
    if (clean) emitChange(clean, minuteInput || '00', period)
  }

  const handleMinuteChange = (val: string) => {
    const clean = val.replace(/\D/g, '').slice(0, 2)
    setMinuteInput(clean)
    if (hourInput) emitChange(hourInput, clean || '00', period)
  }

  const handleHourBlur = () => {
    if (!hourInput) return
    let h = parseInt(hourInput, 10)
    if (h < 1) h = 1
    if (h > 12) h = 12
    setHourInput(h.toString())
    emitChange(h.toString(), minuteInput || '00', period)
  }

  const handleMinuteBlur = () => {
    if (!minuteInput) { setMinuteInput('00'); return }
    let m = parseInt(minuteInput, 10)
    if (m < 0) m = 0
    if (m > 59) m = 59
    const padded = String(m).padStart(2, '0')
    setMinuteInput(padded)
    emitChange(hourInput || '12', padded, period)
  }

  const togglePeriod = () => {
    const newPeriod = period === 'AM' ? 'PM' : 'AM'
    setPeriod(newPeriod)
    if (hourInput) emitChange(hourInput, minuteInput || '00', newPeriod)
  }

  return (
    <div className="flex items-center gap-0">
      <div className="flex items-center bg-secondary/50 border border-border rounded-lg px-2 py-1.5 gap-0.5 flex-1">
        <input
          type="text"
          inputMode="numeric"
          value={hourInput}
          onChange={(e) => handleHourChange(e.target.value)}
          onBlur={handleHourBlur}
          placeholder="--"
          className="w-7 bg-transparent text-sm text-foreground text-center outline-none placeholder:text-muted-foreground/40 rounded-sm"
          maxLength={2}
        />
        <span className="text-sm text-muted-foreground/50 font-medium">:</span>
        <input
          type="text"
          inputMode="numeric"
          value={minuteInput}
          onChange={(e) => handleMinuteChange(e.target.value)}
          onBlur={handleMinuteBlur}
          placeholder="--"
          className="w-7 bg-transparent text-sm text-foreground text-center outline-none placeholder:text-muted-foreground/40 rounded-sm"
          maxLength={2}
        />

        {/* AM/PM toggle */}
        <button
          type="button"
          onClick={togglePeriod}
          className={cn(
            'ml-1.5 px-2 py-0.5 rounded text-[11px] font-bold transition-colors cursor-pointer',
            'bg-primary/15 text-primary hover:bg-primary/25',
          )}
        >
          {period}
        </button>
      </div>
    </div>
  )
}

// ── 24-hour mode ──

function TimePicker24h({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const parsed = useMemo(() => {
    if (!value) return { hour: '', minute: '' }
    const [hStr, mStr] = value.split(':')
    return { hour: String(parseInt(hStr, 10)), minute: mStr || '00' }
  }, [value])

  const [hourInput, setHourInput] = useState(parsed.hour)
  const [minuteInput, setMinuteInput] = useState(parsed.minute)

  const emitChange = useCallback(
    (h: string, m: string) => {
      const hourNum = parseInt(h, 10)
      const minNum = parseInt(m, 10)
      if (isNaN(hourNum) || isNaN(minNum)) return
      if (hourNum < 0 || hourNum > 23 || minNum < 0 || minNum > 59) return

      const val = `${String(hourNum).padStart(2, '0')}:${String(minNum).padStart(2, '0')}`
      onChange(val)
    },
    [onChange]
  )

  const handleHourChange = (val: string) => {
    const clean = val.replace(/\D/g, '').slice(0, 2)
    setHourInput(clean)
    if (clean) emitChange(clean, minuteInput || '00')
  }

  const handleMinuteChange = (val: string) => {
    const clean = val.replace(/\D/g, '').slice(0, 2)
    setMinuteInput(clean)
    if (hourInput) emitChange(hourInput, clean || '00')
  }

  const handleHourBlur = () => {
    if (!hourInput) return
    let h = parseInt(hourInput, 10)
    if (h < 0) h = 0
    if (h > 23) h = 23
    const padded = String(h).padStart(2, '0')
    setHourInput(padded)
    emitChange(padded, minuteInput || '00')
  }

  const handleMinuteBlur = () => {
    if (!minuteInput) { setMinuteInput('00'); return }
    let m = parseInt(minuteInput, 10)
    if (m < 0) m = 0
    if (m > 59) m = 59
    const padded = String(m).padStart(2, '0')
    setMinuteInput(padded)
    emitChange(hourInput || '00', padded)
  }

  return (
    <div className="flex items-center gap-0">
      <div className="flex items-center bg-secondary/50 border border-border rounded-lg px-2 py-1.5 gap-0.5 flex-1">
        <input
          type="text"
          inputMode="numeric"
          value={hourInput}
          onChange={(e) => handleHourChange(e.target.value)}
          onBlur={handleHourBlur}
          placeholder="--"
          className="w-7 bg-transparent text-sm text-foreground text-center outline-none placeholder:text-muted-foreground/40 rounded-sm"
          maxLength={2}
        />
        <span className="text-sm text-muted-foreground/50 font-medium">:</span>
        <input
          type="text"
          inputMode="numeric"
          value={minuteInput}
          onChange={(e) => handleMinuteChange(e.target.value)}
          onBlur={handleMinuteBlur}
          placeholder="--"
          className="w-7 bg-transparent text-sm text-foreground text-center outline-none placeholder:text-muted-foreground/40 rounded-sm"
          maxLength={2}
        />
      </div>
    </div>
  )
}

/**
 * Get a preview string showing the OPPOSITE format of the current input mode.
 * If input is 12h → preview shows 24h. If input is 24h → preview shows 12h AM/PM.
 */
export function format24hPreview(value: string): string {
  if (!value) return ''
  const timeFormat = usePreferencesStore.getState().timeFormat
  const use12h = timeFormat === '12h' || (timeFormat === 'auto' && browserUses12h())

  const [hStr, mStr] = value.split(':')
  const h = parseInt(hStr, 10)
  const m = mStr || '00'

  if (use12h) {
    // Input is 12h → show 24h preview
    return `${String(h).padStart(2, '0')}:${m}`
  }

  // Input is 24h → show 12h AM/PM preview
  const period = h >= 12 ? 'PM' : 'AM'
  let h12 = h
  if (h12 === 0) h12 = 12
  else if (h12 > 12) h12 -= 12
  return `${h12}:${m} ${period}`
}
