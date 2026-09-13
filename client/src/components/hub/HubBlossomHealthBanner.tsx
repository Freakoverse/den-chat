/**
 * HubBlossomHealthBanner — creator-only notice that the hub's ADVERTISED Blossom servers failed to
 * serve its files on load, with a repair modal:
 *
 *   1. probe every candidate (advertised + healthy client defaults) with the hub's REAL index+spine,
 *      uploaded exactly as production does and read back hash-verified;
 *   2. the owner picks from the servers that passed;
 *   3. "Replace & mirror" puts EVERY tree blob on the chosen servers (BUD-04 → upload fallback),
 *      verifies each, drops any that fail, and only then republishes the hub event.
 *
 * Nothing publishes without the owner's explicit click; the banner only informs.
 */

import { useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Loader2, Check, X, RefreshCw, HardDrive } from 'lucide-react'
import { useEscToClose } from '@/hooks/useEscToClose'
import { useHubStore, type HubData } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import {
  probeServers, mirrorTreeToServers, republishHubWithBlossomServers, replacementCandidates, type ServerCheck,
} from '@/lib/hub/hubBlossomHealth'

/** Hubs whose banner the creator dismissed this session (it re-shows next launch if still broken). */
const dismissed = new Set<string>()

const short = (u: string) => u.replace(/^https?:\/\//, '')
const norm = (u: string) => u.replace(/\/+$/, '')

export function HubBlossomHealthBanner({ hub }: { hub: HubData }) {
  const failed = useHubStore((s) => s.blossomHealth[hub.dTag])
  const [open, setOpen] = useState(false)
  const [, bump] = useState(0)

  if (!failed || failed.length === 0 || dismissed.has(hub.dTag)) return null

  return (
    <>
      <div className="mx-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/8 border border-amber-500/20 text-xs shrink-0">
        <AlertTriangle size={14} className="text-amber-400 shrink-0" />
        <span className="flex-1 min-w-0 text-foreground">
          {failed.length} of this hub's {hub.blossomServers.length} Blossom server{hub.blossomServers.length === 1 ? '' : 's'} couldn't serve its files — members may load slowly or fail.
        </span>
        <button
          onClick={() => setOpen(true)}
          className="shrink-0 px-2.5 py-1 rounded-md bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 font-medium transition-colors cursor-pointer"
        >
          Check &amp; fix
        </button>
        <button
          onClick={() => { dismissed.add(hub.dTag); bump((n) => n + 1) }}
          aria-label="Dismiss for now"
          className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
        >
          <X size={13} />
        </button>
      </div>
      {open && <HubBlossomHealthModal hub={hub} failed={failed} onClose={() => setOpen(false)} />}
    </>
  )
}

type Phase = 'idle' | 'probing' | 'probed' | 'mirroring' | 'publishing' | 'done'

function HubBlossomHealthModal({ hub, failed, onClose }: { hub: HubData; failed: string[]; onClose: () => void }) {
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const [phase, setPhase] = useState<Phase>('idle')
  const [results, setResults] = useState<ServerCheck[]>([])
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [published, setPublished] = useState<string[] | null>(null)

  const busy = phase === 'probing' || phase === 'mirroring' || phase === 'publishing'
  useEscToClose(onClose, !busy)

  // Advertised first, then the curated client defaults the hub doesn't advertise yet.
  const advertised = useMemo(() => new Set(hub.blossomServers.map(norm)), [hub])
  const candidates = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const s of [...hub.blossomServers, ...replacementCandidates(hub)]) {
      const n = norm(s)
      if (!seen.has(n)) { seen.add(n); out.push(n) }
    }
    return out
  }, [hub])

  const runProbe = async () => {
    setPhase('probing'); setError(null); setResults([]); setProgress(null)
    try {
      const { hubBlossomAuthSigner } = await import('@/lib/hub/hubMemberSign')
      const authSigner = await hubBlossomAuthSigner(hub, { privateKey, signer })
      const res = await probeServers(hub, candidates, { signer, privateKey, authSigner }, (r) => setResults((prev) => [...prev, r]))
      // Preselect: healthy advertised servers first (keep what still works), then healthy replacements,
      // up to 3 total (the create default) — the owner can adjust before committing.
      const healthy = res.filter((r) => r.ok).map((r) => r.server)
      const keep = healthy.filter((s) => advertised.has(s))
      const pick = [...keep, ...healthy.filter((s) => !advertised.has(s))].slice(0, Math.max(3, keep.length))
      setChosen(new Set(pick))
      setPhase('probed')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('idle')
    }
  }

  const runFix = async () => {
    if (!pubkey || chosen.size === 0) return
    setPhase('mirroring'); setError(null)
    try {
      const { hubBlossomAuthSigner } = await import('@/lib/hub/hubMemberSign')
      const authSigner = await hubBlossomAuthSigner(hub, { privateKey, signer })
      const { verified, failed: mirrorFailed } = await mirrorTreeToServers(
        hub, [...chosen], { authSigner },
        (done, total, label) => setProgress(`Mirroring ${done}/${total}… ${label}`),
      )
      if (verified.length === 0) {
        throw new Error(`No server could be fully verified: ${mirrorFailed.map((f) => `${short(f.server)}: ${f.reason}`).join('; ')}`)
      }
      setPhase('publishing'); setProgress('Publishing the updated hub event…')
      await republishHubWithBlossomServers(hub, verified, { pubkey, signer, privateKey })
      setPublished(verified); setPhase('done'); setProgress(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('probed'); setProgress(null)
    }
  }

  const toggle = (s: string) => setChosen((prev) => {
    const next = new Set(prev)
    if (next.has(s)) next.delete(s); else next.add(s)
    return next
  })

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center px-3" onClick={busy ? undefined : onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-md rounded-xl border border-border bg-background shadow-2xl animate-in fade-in-0 zoom-in-95 flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <HardDrive size={16} className="text-amber-400" />
            <h3 className="text-sm font-semibold text-foreground">Hub Blossom servers</h3>
          </div>
          <button onClick={onClose} disabled={busy} className="text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto">
          {phase === 'done' && published ? (
            <div className="flex flex-col gap-2 text-sm">
              <div className="flex items-center gap-2 text-emerald-400"><Check size={16} /> Hub updated.</div>
              <p className="text-xs text-muted-foreground">
                The hub event now advertises {published.length} verified server{published.length === 1 ? '' : 's'}, and every hub file was mirrored to them:
              </p>
              <ul className="text-xs font-mono text-foreground/80 space-y-0.5">
                {published.map((s) => <li key={s}>✓ {short(s)}</li>)}
              </ul>
              <button onClick={onClose} className="mt-2 w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer">
                Close
              </button>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                These advertised servers failed to serve this hub's files:{' '}
                <span className="font-mono text-foreground/80">{failed.map(short).join(', ')}</span>.
                Members try them first, so every load pays for the failure. The check below uploads the hub's{' '}
                <em>actual</em> index and spine exactly as a real update does, then reads them back — so a server only passes if it truly works for this hub.
              </p>

              {phase === 'idle' && (
                <button
                  onClick={runProbe}
                  className="w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer flex items-center justify-center gap-2"
                >
                  <RefreshCw size={14} /> Run check
                </button>
              )}

              {phase !== 'idle' && (
                <div className="flex flex-col gap-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {phase === 'probing' ? 'Checking…' : 'Results'}
                  </p>
                  {candidates.map((s) => {
                    const r = results.find((x) => x.server === s)
                    const selectable = phase === 'probed' && !!r?.ok
                    return (
                      <label
                        key={s}
                        className={`flex flex-wrap items-center gap-2 px-2 py-1.5 rounded-md text-xs border ${
                          r ? (r.ok ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-destructive/30 bg-destructive/5') : 'border-border/50'
                        } ${selectable ? 'cursor-pointer' : ''}`}
                      >
                        {selectable
                          ? <input type="checkbox" checked={chosen.has(s)} onChange={() => toggle(s)} className="accent-primary" />
                          : <span className="w-[13px] shrink-0" />}
                        {!r
                          ? <Loader2 size={12} className={`shrink-0 ${phase === 'probing' ? 'animate-spin text-muted-foreground' : 'text-muted-foreground/30'}`} />
                          : r.ok
                            ? <Check size={12} className="text-emerald-400 shrink-0" />
                            : <X size={12} className="text-destructive shrink-0" />}
                        <span className="font-mono truncate text-foreground/90">{short(s)}</span>
                        {advertised.has(s) && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">advertised</span>}
                        {r && !r.ok && r.reason && (
                          <span className="basis-full pl-6 text-[10px] text-destructive/80 break-words">{r.reason}</span>
                        )}
                      </label>
                    )
                  })}
                </div>
              )}

              {progress && (
                <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> {progress}</p>
              )}
              {error && <p className="text-xs text-destructive break-words">{error}</p>}

              {phase === 'probed' && (
                <div className="flex flex-col gap-2">
                  <p className="text-[11px] text-muted-foreground">
                    Selected servers get every hub file mirrored to them and verified <em>before</em> the hub event is republished. Any that can't be fully verified are dropped automatically.
                  </p>
                  <button
                    onClick={runFix}
                    disabled={chosen.size === 0}
                    className="w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Replace &amp; mirror ({chosen.size})
                  </button>
                  <button onClick={runProbe} className="text-xs text-muted-foreground hover:text-foreground cursor-pointer self-center">
                    Re-run check
                  </button>
                </div>
              )}

              {(phase === 'mirroring' || phase === 'publishing') && (
                <p className="text-[11px] text-muted-foreground">Please keep this open until it finishes.</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
