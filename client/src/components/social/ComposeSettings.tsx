import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useUserStore } from '@/stores/userStore'
import { StorageKey } from '@/lib/constants'
import { STANDARD_KINDS } from '@/lib/crypto/constants'
import { getRelays, fetchReplaceable, publishToSpecificRelays, assertPublished } from '@/lib/nostr/relay-pool'
import { getPublishRelays } from '@/stores/postingBehaviourStore'
import { benchmarkHashRate, estimateSolveTime } from '@/lib/pow/pow'
import { mineAndSign } from '@/lib/nostr/events'
import { Settings, Minus, Plus, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import type { Event } from 'nostr-tools'

/* ─── Hook: useComposeSettings ─── */

export interface ComposeSettings {
  powDifficulty: number
  setPowDifficulty: (v: number) => void
  /** Apply PoW + client tag to an unsigned event, then sign & publish */
  publishWithSettings: (unsigned: any) => Promise<Event>
}

export function useComposeSettings(initialPow = 15): ComposeSettings {
  const [powDifficulty, setPowDifficulty] = useState(initialPow)

  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const publishWithSettings = useCallback(async (unsigned: any): Promise<Event> => {
    // Add client tag if enabled in preferences
    const clientTagEnabled = localStorage.getItem('den-chat-client-tag') !== 'false'
    if (clientTagEnabled) {
      unsigned.tags = [...(unsigned.tags || []), ['client', 'DEN Chat']]
    }

    // Mine PoW + sign (with automatic retry if signer invalidates PoW)
    const signed = await mineAndSign(unsigned, powDifficulty, pubkey, signer, privateKey)

    // Publish to relays from posting behaviour store
    const relays = getPublishRelays()
    const accepted = await publishToSpecificRelays(relays, signed)
    assertPublished(accepted)   // dead-relay → throw so the composer can show an error

    return signed as Event
  }, [powDifficulty, pubkey, signer, privateKey])

  return {
    powDifficulty, setPowDifficulty,
    publishWithSettings,
  }
}

/* ─── Utility: check if client tag is enabled ─── */

export function isClientTagEnabled(): boolean {
  return typeof window !== 'undefined' ? localStorage.getItem('den-chat-client-tag') !== 'false' : true
}

/* ─── Component: ComposeSettingsPanel ─── */

interface ComposeSettingsPanelProps {
  settings: ComposeSettings
}

export function ComposeSettingsPanel({ settings }: ComposeSettingsPanelProps) {
  const { powDifficulty, setPowDifficulty } = settings

  const [hashRate, setHashRate] = useState<number | null>(null)

  useEffect(() => {
    benchmarkHashRate().then(setHashRate)
  }, [])

  const solveTimeStr = useMemo(() => {
    if (powDifficulty <= 0) return 'Disabled'
    const seconds = estimateSolveTime(powDifficulty, hashRate ?? undefined)
    if (seconds < 0.001) return '<1ms on this device'
    if (seconds < 1) return `~${Math.round(seconds * 1000)}ms on this device`
    if (seconds < 60) return `~${seconds.toFixed(1)}s on this device`
    if (seconds < 3600) return `~${(seconds / 60).toFixed(1)} min on this device`
    if (seconds < 86400) return `~${(seconds / 3600).toFixed(1)} hours on this device`
    return `~${(seconds / 86400).toFixed(1)} days on this device`
  }, [powDifficulty, hashRate])

  return (
    <div className="space-y-4 p-3 rounded-lg bg-secondary/30 border border-border/50 text-xs">
      {/* PoW slider */}
      <div>
        <label className="text-xs font-medium text-foreground mb-1 flex items-center gap-1.5">
          Proof of Work
        </label>
        <p className="text-[10px] text-muted-foreground mb-2">
          Require computational work before posting. Higher difficulty = more spam protection but slower.
        </p>

        <div className="flex items-center gap-2 mb-1">
          <div className="flex-1 relative h-5 flex items-center">
            {/* Track */}
            <div className="absolute left-0 right-0 h-1 rounded-full bg-muted-foreground/20" />
            {/* Filled */}
            <div
              className="absolute left-0 h-1 rounded-full bg-amber-400 transition-all"
              style={{ width: `${Math.min(powDifficulty, 100)}%` }}
            />
            {/* Thumb */}
            <div
              className="absolute w-3 h-3 rounded-full bg-amber-400 border-2 border-background shadow pointer-events-none transition-all"
              style={{ left: `calc(${Math.min(powDifficulty, 100)}% - 6px)` }}
            />
            {/* Range input */}
            <input
              type="range"
              min={0}
              max={100}
              value={Math.min(powDifficulty, 100)}
              onChange={(e) => setPowDifficulty(parseInt(e.target.value, 10))}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>
          <div className="flex items-center h-6 rounded border border-input bg-background overflow-hidden">
            <button
              onClick={() => setPowDifficulty(Math.max(0, powDifficulty - 1))}
              className="h-full px-1 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer flex items-center"
            >
              <Minus size={10} />
            </button>
            <span className="px-1.5 text-[11px] text-foreground tabular-nums min-w-[24px] text-center">
              {powDifficulty}
            </span>
            <button
              onClick={() => setPowDifficulty(powDifficulty + 1)}
              className="h-full px-1 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer flex items-center"
            >
              <Plus size={10} />
            </button>
          </div>
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setPowDifficulty(0)}
                  className={cn(
                    'p-0.5 rounded text-muted-foreground hover:text-foreground transition-all cursor-pointer',
                    powDifficulty === 0 ? 'opacity-0 pointer-events-none' : 'opacity-100'
                  )}
                >
                  <RotateCcw size={11} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">Reset to 0</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        <div className="flex items-center justify-between text-[10px]">
          <span className={cn(
            'font-medium',
            powDifficulty === 0 ? 'text-muted-foreground' : powDifficulty <= 16 ? 'text-emerald-400' : powDifficulty <= 24 ? 'text-amber-400' : 'text-red-400'
          )}>
            {powDifficulty === 0 ? 'No PoW' : `Difficulty: ${powDifficulty} bits`}
          </span>
          <span className="text-muted-foreground">
            {hashRate ? solveTimeStr : 'Benchmarking…'}
          </span>
        </div>
      </div>
    </div>
  )
}

/* ─── Gear Button ─── */

export function ComposeSettingsButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'p-1.5 rounded-full cursor-pointer transition-colors',
        open
          ? 'text-primary bg-primary/10'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
      )}
    >
      <Settings size={18} />
    </button>
  )
}
