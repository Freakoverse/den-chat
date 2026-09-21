/**
 * GroupVersionPill: the same Private / Public pill hubs show (violet for v2, sky for v1), with a
 * tooltip that says what the version means for a group. Used in the details modal and the invite card.
 */
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export function GroupVersionPill({ version, className, aboveModal }: { version?: number; className?: string; aboveModal?: boolean }) {
  const v2 = version === 2
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn('px-1.5 py-0.5 rounded text-[9px] font-medium cursor-help select-none', v2 ? 'bg-violet-500/15 text-violet-400' : 'bg-sky-500/15 text-sky-400', className)}>
            {v2 ? 'Private' : 'Public'}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className={cn('text-xs max-w-[240px]', aboveModal && 'z-[300]')}>
          {v2
            ? 'Messages are encrypted, and who created the group, who is in it, and who is posting are hidden behind mask addresses.'
            : 'Messages are encrypted, but the creator and the member keys are visible in the group event.'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
