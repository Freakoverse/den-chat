/**
 * MessageExpiryNote — the inline "· disappears after <duration>" marker shown on any message that
 * carries a NIP-40 expiration tag, whether the expiry came from a hub's disappearing-messages policy
 * or the sender's own per-message auto-delete (the fire-icon picker). Same UI everywhere: hub channel
 * messages, hub forum posts, and DMs.
 */

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDuration } from '@/lib/hub/messageExpiration'

export function MessageExpiryNote({
  expiration,
  createdAt,
  className,
}: {
  /** Absolute NIP-40 expiration, unix seconds. Falsy → renders nothing. */
  expiration?: number
  /** The message's created_at (unix seconds), used to show the duration until it disappears. */
  createdAt: number
  className?: string
}) {
  if (!expiration) return null
  const when = new Date(expiration * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={className ?? 'text-muted-foreground/50 cursor-default'}> · disappears after {formatDuration(Math.max(0, expiration - createdAt))}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          Best-effort disappearing message. Relays that honor the expiration tag delete it around {when}; clients hide and purge it locally.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
