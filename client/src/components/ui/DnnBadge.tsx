/**
 * DnnBadge — Verified DNN ID badge
 *
 * Shows a BadgeCheck icon + @dnnid text next to usernames when their DNN ID is verified.
 * Reactively subscribes to the DNN verification store.
 */

import { BadgeCheck, Loader2 } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { useDnnStore } from '@/stores/dnnStore'

export function DnnBadge({ pubkey }: { pubkey: string }) {
  const status = useDnnStore((s) => s.status[pubkey])
  const dnnId = useDnnStore((s) => s.verified[pubkey]?.dnnId)

  // Don't show anything for non-DNN users or failures
  if (!status || status === 'not-dnn' || status === 'failed') return null

  // Show spinner while verifying
  if (status === 'pending') {
    return <Loader2 size={12} className="animate-spin text-primary/40 shrink-0 inline-block ml-0.5" />
  }

  // Verified — show badge + @dnnid
  if (status === 'verified' && dnnId) {
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1 shrink-0 ml-0.5 cursor-default">
              <span className="text-sm text-primary font-medium">@{dnnId}</span>
              <BadgeCheck size={14} className="text-primary shrink-0 -mb-0.5" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            <span className="flex items-center gap-1">
              <BadgeCheck size={11} className="text-primary" />
              DNN verified: <span className="font-mono font-medium">{dnnId}</span>
            </span>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return null
}
