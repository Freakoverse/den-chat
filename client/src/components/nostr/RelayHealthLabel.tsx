/**
 * RelayHealthLabel: a small working/broken/checking pill shown beside a relay anywhere relays are listed.
 *
 * Reflects the REAL write+read-back health (see lib/nostr/relayHealthProbe), not just reachability, so a
 * relay that connects but won't accept/serve the user's events (like degmods did) reads "broken". Auto-
 * probes on mount and shares the cached result across the whole UI. Pairs with the reachability dot:
 * dot = can connect, label = actually works for me.
 */

import { useEffect } from 'react'
import { useRelayHealthStore } from '@/lib/nostr/relayHealthProbe'

const norm = (u: string) => u.replace(/\/+$/, '')

export function RelayHealthLabel({ url, className = '' }: { url: string; className?: string }) {
  const key = norm(url)
  const status = useRelayHealthStore((s) => s.status[key])
  const probe = useRelayHealthStore((s) => s.probe)

  useEffect(() => { probe(url) }, [url, probe])

  if (!status) return null

  const cls = status === 'working'
    ? 'text-emerald-400 bg-emerald-500/10'
    : status === 'broken'
      ? 'text-destructive bg-destructive/10'
      : 'text-muted-foreground bg-muted-foreground/10'
  const label = status === 'working' ? 'working' : status === 'broken' ? 'broken' : 'checking'

  return (
    <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded ${cls} ${className}`}>
      {label}
    </span>
  )
}
