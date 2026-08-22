import { useState, useEffect, useMemo } from 'react'
import { Minus, Plus, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { benchmarkHashRate, estimateSolveTime } from '@/lib/pow/pow'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'

function Tip({ children, text, side = 'top' }: { children: React.ReactNode; text: string; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{text}</TooltipContent>
    </Tooltip>
  )
}

/** A single PoW difficulty slider + estimate. Shared by the Message and Join PoW controls. */
function PowSlider({ label, description, value, setValue, hashRate }: {
  label: string
  description: string
  value: number
  setValue: (v: number) => void
  hashRate: number | null
}) {
  const solveTimeStr = useMemo(() => {
    if (value <= 0) return 'Disabled'
    const seconds = estimateSolveTime(value, hashRate ?? undefined)
    if (seconds < 0.001) return '<1ms on this device'
    if (seconds < 1) return `~${Math.round(seconds * 1000)}ms on this device`
    if (seconds < 60) return `~${seconds.toFixed(1)}s on this device`
    if (seconds < 3600) return `~${(seconds / 60).toFixed(1)} min on this device`
    if (seconds < 86400) return `~${(seconds / 3600).toFixed(1)} hours on this device`
    return `~${(seconds / 86400).toFixed(1)} days on this device`
  }, [value, hashRate])

  return (
    <div>
      <label className="text-sm font-medium text-foreground mb-1 flex items-center gap-1.5">
        {label}
      </label>
      <p className="text-xs text-muted-foreground mb-3">
        {description}
      </p>

      <div className="flex items-center gap-3 mb-2">
        <div className="flex-1 relative h-6 flex items-center">
          {/* Track background */}
          <div className="absolute left-0 right-0 h-1.5 rounded-full bg-muted-foreground/20" />
          {/* Filled track */}
          <div
            className="absolute left-0 h-1.5 rounded-full bg-amber-400 transition-all"
            style={{ width: `${Math.min(value, 100)}%` }}
          />
          {/* Visible thumb */}
          <div
            className="absolute w-4 h-4 rounded-full bg-amber-400 border-2 border-background shadow-lg pointer-events-none transition-all"
            style={{ left: `calc(${Math.min(value, 100)}% - 8px)` }}
          />
          {/* Invisible native range */}
          <input
            type="range"
            min={0}
            max={100}
            value={Math.min(value, 100)}
            onChange={(e) => setValue(parseInt(e.target.value, 10))}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
        </div>
        <div className="flex items-center h-7 rounded-md border border-input bg-background overflow-hidden">
          <button
            onClick={() => { const v = Math.max(0, value - 1); setValue(v) }}
            className="h-full px-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer flex items-center"
          >
            <Minus size={12} />
          </button>
          <span className="px-2 text-sm text-foreground tabular-nums min-w-[28px] text-center">
            {value}
          </span>
          <button
            onClick={() => setValue(value + 1)}
            className="h-full px-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer flex items-center"
          >
            <Plus size={12} />
          </button>
        </div>
        {value !== 15 ? (
          <Tip text="Reset to default (15)">
            <button
              onClick={() => setValue(15)}
              className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <RotateCcw size={14} />
            </button>
          </Tip>
        ) : (
          <div className="p-1 w-[22px]" />
        )}
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className={cn(
          'font-medium',
          value === 0 ? 'text-muted-foreground' : value <= 16 ? 'text-emerald-400' : value <= 24 ? 'text-amber-400' : 'text-red-400'
        )}>
          {value === 0 ? 'No PoW required' : `Difficulty: ${value} bits`}
        </span>
        <span className="text-muted-foreground">
          {hashRate ? solveTimeStr : 'Benchmarking…'}
        </span>
      </div>
    </div>
  )
}

/** Message PoW + Join PoW difficulty sliders, sharing a single device benchmark. */
export function PowSection({ editMinPow, setEditMinPow, editJoinMinPow, setEditJoinMinPow }: {
  editMinPow: number; setEditMinPow: (v: number) => void
  editJoinMinPow: number; setEditJoinMinPow: (v: number) => void
}) {
  const [hashRate, setHashRate] = useState<number | null>(null)

  // Benchmark on mount (shared across both sliders)
  useEffect(() => {
    benchmarkHashRate().then(setHashRate)
  }, [])

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-6">
        <PowSlider
          label="Message PoW"
          description="Require computational work before sending messages. Higher difficulty = more spam protection but slower sending."
          value={editMinPow}
          setValue={setEditMinPow}
          hashRate={hashRate}
        />
        <PowSlider
          label="Join PoW"
          description="Require computational work before submitting a join request. Higher difficulty = more spam protection but slower joining."
          value={editJoinMinPow}
          setValue={setEditJoinMinPow}
          hashRate={hashRate}
        />
      </div>
    </TooltipProvider>
  )
}
