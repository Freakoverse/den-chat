import { ArrowUp, X } from 'lucide-react'
import { getHour12 } from '@/stores/preferencesStore'

interface UnreadBannerProps {
  count: number
  sinceTimestamp: number
  onJump: () => void
  onDismiss: () => void
}

/**
 * Floating "N new messages since TIME" banner.
 * Sits sticky at the top of the chat scroll container.
 */
export function UnreadBanner({ count, sinceTimestamp, onJump, onDismiss }: UnreadBannerProps) {
  if (count <= 0) return null

  const sinceLabel = formatSince(sinceTimestamp)

  return (
    <div className="sticky top-0 z-20 mx-4 mt-1 mb-1 flex items-center justify-between gap-2 rounded-md bg-primary backdrop-blur-sm text-destructive-foreground px-3 py-1.5 shadow-lg cursor-pointer animate-in slide-in-from-top-2 duration-200"
      onClick={onJump}
    >
      <div className="flex items-center gap-2 min-w-0">
        <ArrowUp size={14} className="shrink-0" />
        <span className="text-xs font-medium truncate">
          {count} new message{count !== 1 ? 's' : ''} since {sinceLabel}
        </span>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onDismiss() }}
        className="shrink-0 p-0.5 rounded hover:bg-white/20 transition-colors cursor-pointer"
        aria-label="Dismiss"
      >
        <X size={12} />
      </button>
    </div>
  )
}

function formatSince(ts: number): string {
  if (ts <= 0) return ''
  const d = new Date(ts * 1000)
  const now = new Date()
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)

  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: getHour12() })
  }
  if (d.toDateString() === yesterday.toDateString()) {
    return 'yesterday ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: getHour12() })
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: getHour12() })
}
