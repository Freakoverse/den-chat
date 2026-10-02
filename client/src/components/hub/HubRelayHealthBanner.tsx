/**
 * HubRelayHealthBanner / HubRelayHealthModal / HubRelayHealthNotice: creator-only relay repair UI.
 *
 * When the startup probe (lib/hub/hubRelayHealth) finds advertised relays that can't accept + serve back
 * the hub's own event, the creator gets a NON-CLOSABLE banner (there's no point letting them dismiss a
 * hub that's quietly breaking). The modal:
 *
 *   1. probes every candidate relay (advertised + the user's client/NIP-65 relays) by rebroadcasting the
 *      hub's event to each alone and fetching it straight back: a real write+read round-trip;
 *   2. the owner picks from the relays that passed (only 'working' relays are selectable);
 *   3. "Publish" republishes the hub event advertising ONLY the chosen working relays.
 *
 * Nothing publishes without the owner's explicit click. The banner only informs; the modal does the work.
 */

import { useState, useMemo, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Loader2, Check, X, RefreshCw, Radio } from 'lucide-react'
import { useEscToClose } from '@/hooks/useEscToClose'
import { type HubData } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { useNavigationStore } from '@/stores/navigationStore'
import { useRelayHealthStore } from '@/lib/nostr/relayHealthProbe'
import {
  probeRelays, fetchHubProbeEvent, replacementRelayCandidates, republishHubWithRelays, type RelayCheck,
} from '@/lib/hub/hubRelayHealth'

const short = (u: string) => u.replace(/^wss?:\/\//, '')
const norm = (u: string) => u.replace(/\/+$/, '')

/**
 * The hub's advertised relays that currently read 'broken' in the shared relay-health store, auto-probing
 * them on mount. This is the single source for the banner/notice, so a broken relay surfaces the moment
 * the channel view (where the banner lives) or Hub Settings opens, without a separate startup probe.
 */
function useHubBrokenRelays(hub: HubData): string[] {
  const status = useRelayHealthStore((s) => s.status)
  const probe = useRelayHealthStore((s) => s.probe)
  const relaysKey = hub.generalRelays.map(norm).join(',')
  useEffect(() => {
    for (const r of relaysKey.split(',').filter(Boolean)) probe(r)
  }, [relaysKey, probe])
  return hub.generalRelays.filter((r) => status[norm(r)] === 'broken')
}

/**
 * Non-closable banner for the channel view: the hub has broken advertised relays. The button opens Hub
 * Settings at the Network page (where the creator sees everything and uses the Test & fix action in the
 * HubRelayHealthNotice), rather than jumping straight into the fix modal.
 */
export function HubRelayHealthBanner({ hub }: { hub: HubData }) {
  const broken = useHubBrokenRelays(hub)
  const openSettingsPage = useNavigationStore((s) => s.setPendingHubSettingsPage)

  if (broken.length === 0) return null

  return (
    <div className="mx-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/8 border border-amber-500/20 text-xs shrink-0">
      <AlertTriangle size={14} className="text-amber-400 shrink-0" />
      <span className="flex-1 min-w-0 text-foreground">
        {broken.length} of this hub's {hub.generalRelays.length} relay{hub.generalRelays.length === 1 ? '' : 's'} {broken.length === 1 ? 'is' : 'are'} broken: members may not send or receive here. Pick working relays.
      </span>
      <button
        onClick={() => openSettingsPage({ dTag: hub.dTag, page: 'network' })}
        className="shrink-0 px-2.5 py-1 rounded-md bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 font-medium transition-colors cursor-pointer"
      >
        Hub Settings
      </button>
    </div>
  )
}

/**
 * Non-closable notice for inside Hub Settings (Network section): same warning, opens the same fix modal.
 * Renders nothing when there are no known-broken relays.
 */
export function HubRelayHealthNotice({ hub }: { hub: HubData }) {
  const broken = useHubBrokenRelays(hub)
  const [open, setOpen] = useState(false)

  if (broken.length === 0) return null

  return (
    <>
      <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs">
        <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-foreground">
            Broken relays: <span className="font-mono text-amber-300">{broken.map(short).join(', ')}</span>.
            They don't accept or serve this hub's events, so members on them can't participate. Test the
            relays below, pick ones that show <span className="text-emerald-400">working</span>, and publish.
          </p>
          <button
            onClick={() => setOpen(true)}
            className="mt-1.5 px-2.5 py-1 rounded-md bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 font-medium transition-colors cursor-pointer"
          >
            Test &amp; fix relays
          </button>
        </div>
      </div>
      {open && <HubRelayHealthModal hub={hub} onClose={() => setOpen(false)} />}
    </>
  )
}

type Phase = 'idle' | 'probing' | 'probed' | 'publishing' | 'done'

export function HubRelayHealthModal({ hub, onClose }: { hub: HubData; onClose: () => void }) {
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const [phase, setPhase] = useState<Phase>('idle')
  const [results, setResults] = useState<RelayCheck[]>([])
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [published, setPublished] = useState<string[] | null>(null)

  const busy = phase === 'probing' || phase === 'publishing'
  useEscToClose(onClose, !busy)

  const advertised = useMemo(() => new Set(hub.generalRelays.map(norm)), [hub])
  // Advertised relays first, then the user's other relays (client + NIP-65) as replacement candidates.
  const candidates = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const r of [...hub.generalRelays, ...replacementRelayCandidates(hub)]) {
      const n = norm(r)
      if (n && !seen.has(n)) { seen.add(n); out.push(n) }
    }
    return out
  }, [hub])

  const runProbe = async () => {
    setPhase('probing'); setError(null); setResults([])
    try {
      // Fetch the hub event once and reuse it across every candidate probe.
      const probeEvent = await fetchHubProbeEvent(hub)
      if (!probeEvent) throw new Error('Could not find this hub\'s event on any relay to test with.')
      const res = await probeRelays(hub, candidates, (r) => {
        setResults((prev) => [...prev, r])
        // Push each deeper hub-event result into the shared store so the banner + labels reflect it.
        useRelayHealthStore.getState().setStatus(r.relay, r.ok ? 'working' : 'broken')
      }, probeEvent)
      // Preselect the working relays: keep the advertised ones that still work, then add working
      // replacements up to a small default so the hub keeps a few copies.
      const working = res.filter((r) => r.ok).map((r) => r.relay)
      const keep = working.filter((r) => advertised.has(r))
      const pick = [...keep, ...working.filter((r) => !advertised.has(r))].slice(0, Math.max(keep.length, 4))
      setChosen(new Set(pick))
      setPhase('probed')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('idle')
    }
  }

  const runPublish = async () => {
    if (!pubkey || chosen.size === 0) return
    setPhase('publishing'); setError(null)
    try {
      await republishHubWithRelays(hub, [...chosen], { pubkey, signer, privateKey })
      setPublished([...chosen]); setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('probed')
    }
  }

  const toggle = (r: string) => setChosen((prev) => {
    const next = new Set(prev)
    if (next.has(r)) next.delete(r); else next.add(r)
    return next
  })

  // Every chosen relay must have passed the probe before we let the owner publish.
  const chosenAllWorking = chosen.size > 0 && [...chosen].every((r) => results.find((x) => x.relay === r)?.ok)

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
            <Radio size={16} className="text-amber-400" />
            <h3 className="text-sm font-semibold text-foreground">Hub relays</h3>
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
                The hub now advertises {published.length} working relay{published.length === 1 ? '' : 's'}:
              </p>
              <ul className="text-xs font-mono text-foreground/80 space-y-0.5">
                {published.map((r) => <li key={r}>✓ {short(r)}</li>)}
              </ul>
              <button onClick={onClose} className="mt-2 w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer">
                Close
              </button>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                This test rebroadcasts the hub's own event to each relay and reads it straight back, so a
                relay only passes if it truly accepts and serves this hub. Pick the relays that pass, then
                publish: the hub will advertise only those.
              </p>

              {phase === 'idle' && (
                <button
                  onClick={runProbe}
                  className="w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer flex items-center justify-center gap-2"
                >
                  <RefreshCw size={14} /> Test relays
                </button>
              )}

              {phase !== 'idle' && (
                <div className="flex flex-col gap-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {phase === 'probing' ? 'Testing…' : 'Results'}
                  </p>
                  {candidates.map((r) => {
                    const res = results.find((x) => x.relay === r)
                    const selectable = !!res?.ok && phase !== 'publishing'
                    return (
                      <label
                        key={r}
                        className={`flex flex-wrap items-center gap-2 px-2 py-1.5 rounded-md text-xs border ${
                          res ? (res.ok ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-destructive/30 bg-destructive/5') : 'border-border/50'
                        } ${selectable ? 'cursor-pointer' : ''}`}
                      >
                        {selectable
                          ? <input type="checkbox" checked={chosen.has(r)} onChange={() => toggle(r)} className="accent-primary" />
                          : <span className="w-[13px] shrink-0" />}
                        {!res
                          ? <Loader2 size={12} className={`shrink-0 ${phase === 'probing' ? 'animate-spin text-muted-foreground' : 'text-muted-foreground/30'}`} />
                          : res.ok
                            ? <Check size={12} className="text-emerald-400 shrink-0" />
                            : <X size={12} className="text-destructive shrink-0" />}
                        <span className="font-mono truncate text-foreground/90">{short(r)}</span>
                        <span className="ml-auto shrink-0 flex items-center gap-1.5">
                          {res && (
                            <span className={`text-[10px] font-medium ${res.ok ? 'text-emerald-400' : 'text-destructive'}`}>
                              {res.ok ? 'working' : 'broken'}
                            </span>
                          )}
                          {advertised.has(r) && <span className="text-[10px] text-muted-foreground">advertised</span>}
                        </span>
                        {res && !res.ok && res.reason && (
                          <span className="basis-full pl-6 text-[10px] text-destructive/80 break-words">{res.reason}</span>
                        )}
                      </label>
                    )
                  })}
                </div>
              )}

              {error && <p className="text-xs text-destructive break-words">{error}</p>}

              {(phase === 'probed' || phase === 'publishing') && (
                <div className="flex flex-col gap-2">
                  <p className="text-[11px] text-muted-foreground">
                    Only relays that passed the test can be selected. The hub event will be republished to
                    advertise exactly the selected relays.
                  </p>
                  <button
                    onClick={runPublish}
                    disabled={!chosenAllWorking || phase === 'publishing'}
                    className="w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {phase === 'publishing' ? <><Loader2 size={14} className="animate-spin" /> Publishing…</> : `Publish (${chosen.size})`}
                  </button>
                  {phase === 'probed' && (
                    <button onClick={runProbe} className="text-xs text-muted-foreground hover:text-foreground cursor-pointer self-center">
                      Re-test
                    </button>
                  )}
                </div>
              )}

              {phase === 'publishing' && (
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
