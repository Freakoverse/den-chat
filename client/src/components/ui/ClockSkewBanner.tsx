/**
 * ClockSkewBanner: tells the user once when their device clock is off by a minute or more. Outgoing
 * events are already being stamped with the corrected time (lib/time/clockOffset); this just
 * explains why their messages may carry a different time than their clock shows, and nudges them
 * to fix the clock. Dismissed per measured value, so a new, different offset shows again.
 */
import { useEffect, useState } from 'react'
import { Clock, X } from 'lucide-react'
import { getClockState, subscribeClock, describeOffset } from '@/lib/time/clockOffset'

const DISMISS_KEY = 'den-chat-clock-banner-dismissed'
const SHOW_FROM_MS = 60_000

export function ClockSkewBanner() {
  const [state, setState] = useState(getClockState)
  const [dismissedFor, setDismissedFor] = useState<number | null>(() => {
    try { const v = localStorage.getItem(DISMISS_KEY); return v ? Number(v) : null } catch { return null }
  })
  useEffect(() => subscribeClock(() => setState(getClockState())), [])

  const rounded = Math.round(state.offsetMs / 60_000)
  if (!state.applied || Math.abs(state.offsetMs) < SHOW_FROM_MS || dismissedFor === rounded) return null

  const dismiss = () => {
    setDismissedFor(rounded)
    try { localStorage.setItem(DISMISS_KEY, String(rounded)) } catch { /* ignore */ }
  }

  return (
    <div className="flex items-center justify-center gap-2 px-4 py-1.5 bg-amber-500/15 text-amber-600 dark:text-amber-400 text-xs font-medium shrink-0 select-none">
      <Clock size={13} className="shrink-0" />
      <span>Your device clock is {describeOffset(state.offsetMs)}. Messages are stamped with the corrected time; fixing the clock in your system settings is still a good idea.</span>
      <button onClick={dismiss} className="ml-1 p-0.5 rounded hover:bg-amber-500/20 cursor-pointer" aria-label="Dismiss">
        <X size={13} />
      </button>
    </div>
  )
}
