/**
 * HubUpgradeBanner: creator-only prompt to migrate a LEGACY (inline) hub to the struct-blob format,
 * with a migration modal.
 *
 * The struct format moves the hub's structure (channels/roles/categories) into a Blossom blob so the hub
 * event stays small no matter how much the hub grows. Migrating keeps the hub's exact privacy type, epoch,
 * secret, members, and index: it is one blob upload + one event publish (upgradeHubToStruct), NOT a
 * v1->v2 conversion. The banner only informs; nothing publishes without the owner's explicit click. After
 * a successful migration the owner is warned that members on older DEN Chat clients must update to see the
 * hub until they do.
 *
 * Gated on STRUCT_FORMAT_ENABLED: while the writer is dormant (reader still propagating) the banner never
 * shows. It also hides once the hub carries a struct tag (already migrated). The parent only mounts it for
 * the creator.
 */

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Sparkles, Loader2, Check, X, ArrowUpCircle, AlertTriangle } from 'lucide-react'
import { useEscToClose } from '@/hooks/useEscToClose'
import { type HubData } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { STRUCT_FORMAT_ENABLED } from '@/lib/hub/structFormat'
import { upgradeHubToStruct, type UpgradeStep } from '@/lib/hub/upgradeHubToStruct'

const STEPS: UpgradeStep[] = ['Building structure file', 'Uploading to Blossom', 'Publishing hub update', 'Verifying']

export function HubUpgradeBanner({ hub, className = '' }: { hub: HubData; className?: string }) {
  const [open, setOpen] = useState(false)

  // Dormant until the struct reader has shipped; hidden once the hub is already struct-format. No dismiss:
  // this stays in the creator's face until they migrate.
  if (!STRUCT_FORMAT_ENABLED || hub.structFileHash) return null

  return (
    <>
      <div className={`flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/8 border border-primary/20 text-xs shrink-0 ${className}`}>
        <Sparkles size={14} className="text-primary shrink-0" />
        <span className="flex-1 min-w-0 text-foreground">
          A hub update is available. Migrate this hub so it can keep growing without hitting size limits on channels, roles, and permissions.
        </span>
        <button
          onClick={() => setOpen(true)}
          className="shrink-0 px-2.5 py-1 rounded-md bg-primary/15 text-primary hover:bg-primary/25 font-medium transition-colors cursor-pointer"
        >
          Upgrade
        </button>
      </div>
      {open && <HubUpgradeModal hub={hub} onClose={() => setOpen(false)} />}
    </>
  )
}

type Phase = 'idle' | 'running' | 'done'

function HubUpgradeModal({ hub, onClose }: { hub: HubData; onClose: () => void }) {
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const [phase, setPhase] = useState<Phase>('idle')
  const [current, setCurrent] = useState<UpgradeStep | null>(null)
  const [doneSteps, setDoneSteps] = useState<UpgradeStep[]>([])
  const [error, setError] = useState<string | null>(null)

  const busy = phase === 'running'
  useEscToClose(onClose, !busy)

  const runMigration = async () => {
    if (!pubkey) return
    setPhase('running'); setError(null); setDoneSteps([]); setCurrent(null)
    let prev: UpgradeStep | null = null
    try {
      await upgradeHubToStruct({
        hub, pubkey, privateKey, signer,
        onStep: (step) => {
          // Mark the previous step done as each new one begins.
          if (prev && prev !== step) setDoneSteps((d) => (d.includes(prev!) ? d : [...d, prev!]))
          prev = step
          setCurrent(step)
        },
      })
      if (prev) setDoneSteps((d) => (d.includes(prev!) ? d : [...d, prev!]))
      setCurrent(null)
      setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('idle'); setCurrent(null)
    }
  }

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
            <ArrowUpCircle size={16} className="text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Upgrade this hub</h3>
          </div>
          <button onClick={onClose} disabled={busy} className="text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto">
          {phase === 'done' ? (
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex items-center gap-2 text-emerald-400"><Check size={16} /> Hub upgraded.</div>
              <p className="text-xs text-muted-foreground">
                This hub now stores its structure in a Blossom file, so it can keep growing without hitting the old size limits. Nothing else changed: same members, same channels, same privacy.
              </p>
              <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-amber-500/8 border border-amber-500/20">
                <AlertTriangle size={13} className="text-amber-400 shrink-0 mt-0.5" />
                <p className="text-[11px] text-foreground/90">
                  Members on an older DEN Chat version will see this hub as broken or empty until they update. New and updated clients read it correctly.
                </p>
              </div>
              <button onClick={onClose} className="mt-1 w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer">
                Done
              </button>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                This moves the hub's structure (channels, roles, categories) into a Blossom file referenced by the hub event, so the event stays small and the hub can grow freely. It keeps the hub's exact privacy type, members, and history, and only takes one upload plus one publish.
              </p>

              {phase === 'idle' && !error && (
                <button
                  onClick={runMigration}
                  className="w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer flex items-center justify-center gap-2"
                >
                  <ArrowUpCircle size={14} /> Begin migration
                </button>
              )}

              {(phase === 'running' || doneSteps.length > 0) && (
                <div className="flex flex-col gap-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Migrating</p>
                  {STEPS.map((s) => {
                    const isDone = doneSteps.includes(s)
                    const isCurrent = current === s
                    return (
                      <div key={s} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                        {isDone
                          ? <Check size={12} className="text-emerald-400 shrink-0" />
                          : isCurrent
                            ? <Loader2 size={12} className="animate-spin text-primary shrink-0" />
                            : <span className="w-[12px] shrink-0" />}
                        <span className={isDone || isCurrent ? 'text-foreground/90' : 'text-muted-foreground/50'}>{s}</span>
                      </div>
                    )
                  })}
                </div>
              )}

              {error && (
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-destructive break-words">{error}</p>
                  <button
                    onClick={runMigration}
                    className="w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer"
                  >
                    Try again
                  </button>
                </div>
              )}

              {busy && <p className="text-[11px] text-muted-foreground">Please keep this open until it finishes.</p>}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
