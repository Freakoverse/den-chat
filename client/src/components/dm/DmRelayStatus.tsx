/**
 * DmRelayStatus — shared relay-publish indicator for every DM type (B/M/W).
 *
 * Renders a compact `confirmed/total` counter; on click a portal popover lists the relays grouped into
 * labelled sections (your NIP-65, the recipient's, client, your DM inbox, …) with a per-relay dot:
 * green = accepted, grey = finished-but-not-accepted, spinner = still in flight. Entirely section-driven
 * (see lib/nostr/dmRelayTargets), so a new DM type just supplies different sections.
 */

import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Loader2 } from 'lucide-react'
import { type DmRelayProgress, dmProgressTotal, dmProgressConfirmed } from '@/lib/nostr/dmRelayTargets'

const normRelay = (u: string) => u.replace(/\/+$/, '')

export function DmRelayStatus({ progress }: { progress?: DmRelayProgress }) {
  const [open, setOpen] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false)
    }
    const close = () => setOpen(false)
    document.addEventListener('mousedown', handler)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', handler)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  if (!progress) return null
  const total = dmProgressTotal(progress)
  if (total === 0) return null
  const confirmed = dmProgressConfirmed(progress)
  const done = progress.settled && confirmed >= total
  const accepted = new Set(progress.acceptedRelays.map(normRelay))
  const sections = progress.sections.filter((s) => s.relays.length > 0)

  return (
    <span className="relative inline-flex items-center">
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); setOpen(!open) }}
        className={`text-[10px] inline-flex items-center gap-1 ml-1 cursor-pointer hover:text-muted-foreground transition-colors ${done ? 'text-muted-foreground/40' : 'text-muted-foreground/70'}`}
      >
        {!progress.settled && <Loader2 size={9} className="animate-spin" />}
        {confirmed}/{total}
      </button>
      {open && createPortal(
        <div
          ref={(el) => {
            popRef.current = el
            if (!el || !btnRef.current) return
            const b = btnRef.current.getBoundingClientRect()
            const r = el.getBoundingClientRect()
            let left = b.left
            if (left + r.width > window.innerWidth - 4) left = window.innerWidth - r.width - 4
            if (left < 4) left = 4
            let top = b.top - r.height - 4
            if (top < 4) top = b.bottom + 4
            el.style.left = `${left}px`
            el.style.top = `${top}px`
            el.style.opacity = '1'
          }}
          className="fixed z-[9999] bg-popover border border-border rounded-lg shadow-xl p-2.5 min-w-[220px] max-w-[300px]"
          style={{ left: -9999, top: -9999, opacity: 0 }}
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-[10px] font-medium text-foreground mb-1.5">
            Relay Status <span className="text-muted-foreground/60">({confirmed}/{total})</span>
          </p>
          <div className="space-y-2">
            {sections.map((section) => (
              <div key={section.label}>
                <p className="text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">{section.label}</p>
                <div className="space-y-0.5">
                  {[...new Set(section.relays.map(normRelay))].map((url) => {
                    const ok = accepted.has(url)
                    return (
                      <div key={url} className="flex items-center gap-2">
                        {ok
                          ? <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                          : progress.settled
                            ? <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30 shrink-0" />
                            : <Loader2 size={8} className="animate-spin text-muted-foreground/50 shrink-0" />}
                        <span className="text-[10px] text-muted-foreground font-mono truncate">{url.replace(/^wss:\/\//, '')}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </span>
  )
}
