/**
 * BlossomHealthLabel: a small working/broken/checking pill shown beside a Blossom server anywhere servers
 * are listed.
 *
 * Reflects the REAL upload+read-back health (see lib/blossom/blossomHealthProbe), not just reachability, so
 * a server that answers HEAD but rejects uploads (415/401/CORS) or won't serve a blob back reads "broken".
 * Auto-probes on mount and shares the cached result across the whole UI. Pairs with the reachability dot:
 * dot = responds, label = actually works for me (accepts my uploads and serves them back).
 *
 * With `interactive`, the pill is a button with a refresh icon: clicking re-checks THAT ONE server, without
 * touching any other server's cached result or its automatic re-check schedule.
 */

import { useEffect } from 'react'
import { RefreshCw, Loader2 } from 'lucide-react'
import { useBlossomHealthStore } from '@/lib/blossom/blossomHealthProbe'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'

const norm = (u: string) => u.replace(/\/+$/, '')

export function BlossomHealthLabel({ url, className = '', interactive = false }: { url: string; className?: string; interactive?: boolean }) {
  const key = norm(url)
  const status = useBlossomHealthStore((s) => s.status[key])
  const progress = useBlossomHealthStore((s) => s.progress[key])
  const probe = useBlossomHealthStore((s) => s.probe)
  const recheck = useBlossomHealthStore((s) => s.recheck)

  useEffect(() => { probe(url) }, [url, probe])

  if (!status) return null

  const checking = status === 'checking'
  const cls = status === 'working'
    ? 'text-emerald-400 bg-emerald-500/10'
    : status === 'broken'
      ? 'text-destructive bg-destructive/10'
      : 'text-muted-foreground bg-muted-foreground/10'
  const label = status === 'working'
    ? 'working'
    : status === 'broken'
      ? 'broken'
      : progress ? `checking (${progress.done}/${progress.total})` : 'checking'

  const base = `shrink-0 inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded ${cls} ${className}`

  if (interactive) {
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); if (!checking) recheck(url) }}
              disabled={checking}
              className={`${base} ${checking ? '' : 'cursor-pointer hover:brightness-125 transition'}`}
            >
              {label}
              {checking
                ? <Loader2 size={9} className="animate-spin" />
                : <RefreshCw size={9} className="opacity-60" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" className="text-xs">Re-check this server (uploads a tiny test file + reads it back)</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return <span className={base}>{label}</span>
}
