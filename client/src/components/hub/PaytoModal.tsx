/**
 * PaytoModal: view/edit a user's NIP-A3 payment targets (kind 10133).
 *
 * Read-only for other people; your own opens with an edit affordance even when empty, which is the
 * only way to add a first one. Ported from DEG Mods, restyled to DEN's modal conventions.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { HandCoins, Loader2, Plus, Pencil, Trash2, X, Save, Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useUserStore } from '@/stores/userStore'
import { fetchReplaceable } from '@/lib/nostr/relay-pool'
import { signWithSigner } from '@/lib/nostr/events'
import { publishPersonal } from '@/stores/postingBehaviourStore'
import { STANDARD_KINDS } from '@/lib/crypto/constants'
import { useEscToClose } from '@/hooks/useEscToClose'
import { cn } from '@/lib/utils'
import {
  extractPaymentTargets, buildPaytoEvent, paymentTypeLabel, suggestPaymentTypes,
  normalizePaytoType, type PaymentTarget,
} from '@/lib/nostr/payto'

const MAX_TARGETS = 25
const LIMITS = { type: 40, authority: 300 } as const
const LIST_MAX_H = 224

/** Copies the authority alone: the address is what a payer pastes into a wallet, not the payto:// URI. */
function CopyAuthority({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }
  return (
    <button
      onClick={copy}
      aria-label="Copy address"
      className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground cursor-pointer"
    >
      {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
    </button>
  )
}

/**
 * Type field with type-ahead. The list is a convenience, never a constraint; any type is valid, so
 * free text is always accepted. The list is portalled + fixed so the modal's overflow can't clip it.
 */
function TypeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [rect, setRect] = useState<{ left: number; top: number; width: number; drop: 'down' | 'up' } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const matches = value.trim() ? suggestPaymentTypes(value) : []

  const place = useCallback(() => {
    const el = wrapRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const below = window.innerHeight - r.bottom
    const drop: 'down' | 'up' = below < LIST_MAX_H && r.top > below ? 'up' : 'down'
    setRect({ left: r.left, top: drop === 'down' ? r.bottom + 4 : r.top - 4, width: r.width, drop })
  }, [])

  useEffect(() => {
    if (!open) return
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (wrapRef.current?.contains(t) || listRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open, place])

  const choose = (type: string) => { onChange(type); setOpen(false) }

  return (
    <div ref={wrapRef} className="w-full sm:w-44">
      <Input
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setHighlight(0) }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open || matches.length === 0) return
          if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => (h + 1) % matches.length) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => (h - 1 + matches.length) % matches.length) }
          else if (e.key === 'Enter') { e.preventDefault(); choose(matches[highlight].type) }
          else if (e.key === 'Escape') setOpen(false)
        }}
        placeholder="Type (e.g. bitcoin)"
        maxLength={LIMITS.type}
        className="h-9 text-sm"
      />
      {open && matches.length > 0 && rect && createPortal(
        <ul
          ref={listRef}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.preventDefault()}
          style={{
            position: 'fixed',
            left: rect.left,
            width: Math.max(rect.width, 240),
            ...(rect.drop === 'down' ? { top: rect.top } : { bottom: window.innerHeight - rect.top }),
          }}
          className="z-[70] max-h-56 min-w-[8rem] overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-xl"
        >
          {matches.map((m, i) => (
            <li key={m.type}>
              <button
                type="button"
                onMouseEnter={() => setHighlight(i)}
                onClick={() => choose(m.type)}
                className={cn(
                  'flex w-full cursor-pointer select-none items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors',
                  i === highlight ? 'bg-accent text-foreground' : 'text-muted-foreground',
                )}
              >
                <span className="truncate">{m.label}</span>
                {m.region && <span className="shrink-0 text-[10px] text-muted-foreground/70">{m.region}</span>}
              </button>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  )
}

export function PaytoModal({
  open, onClose, pubkey, displayName, isSelf,
}: {
  open: boolean
  onClose: () => void
  pubkey: string
  displayName: string
  isSelf: boolean
}) {
  useEscToClose(onClose, open)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const [targets, setTargets] = useState<PaymentTarget[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<PaymentTarget[]>([])
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true); setEditing(false); setError(null)
    fetchReplaceable(pubkey, STANDARD_KINDS.PAYTO)
      .then((ev) => { if (!cancelled) setTargets(extractPaymentTargets(ev)) })
      .catch(() => { if (!cancelled) setTargets([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, pubkey])

  if (!open) return null

  const startEdit = () => {
    setDraft(targets.length ? targets.map((t) => ({ ...t })) : [{ type: '', authority: '', extra: [] }])
    setError(null)
    setEditing(true)
  }

  const update = (i: number, patch: Partial<PaymentTarget>) =>
    setDraft((prev) => prev.map((t, j) => (j === i ? { ...t, ...patch } : t)))

  const publish = async () => {
    if (draft.some((t) => (t.type.trim() && !t.authority.trim()) || (!t.type.trim() && t.authority.trim()))) {
      setError('Each entry needs both a type and an address.')
      return
    }
    const cleaned = draft
      .map((t) => ({ ...t, type: normalizePaytoType(t.type), authority: t.authority.trim() }))
      .filter((t) => t.type && t.authority)
    setPublishing(true)
    setError(null)
    try {
      // Replaceable: publishing the full set is what removes anything dropped, so an empty list is a
      // legitimate "clear them all".
      const signed = await signWithSigner(buildPaytoEvent(cleaned), signer, privateKey)
      await publishPersonal(signed)
      setTargets(cleaned)
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to publish')
    } finally {
      setPublishing(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative z-10 w-full max-w-md mx-4 max-h-[85vh] flex flex-col bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <HandCoins size={16} className="text-primary shrink-0" />
            <div className="min-w-0">
              <h2 className="font-semibold text-foreground text-sm leading-tight">Payment targets</h2>
              <p className="text-[11px] text-muted-foreground truncate">
                {isSelf ? 'Where people can pay you.' : `Where ${displayName} can be paid.`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {isSelf && !editing && !loading && (
              <Button variant="ghost" size="sm" onClick={startEdit} className="h-7 px-2 text-xs gap-1">
                <Pencil size={12} /> {targets.length ? 'Edit' : 'Add'}
              </Button>
            )}
            <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          ) : editing ? (
            <div className="space-y-3">
              {draft.map((t, i) => (
                <div key={i} className="flex flex-col gap-2 rounded-lg border border-border p-2 sm:flex-row sm:items-start">
                  <TypeField value={t.type} onChange={(v) => update(i, { type: v })} />
                  <Input
                    value={t.authority}
                    onChange={(e) => update(i, { authority: e.target.value })}
                    placeholder="Address / handle"
                    maxLength={LIMITS.authority}
                    className="flex-1 h-9 font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setDraft((prev) => prev.filter((_, j) => j !== i))}
                    aria-label="Remove"
                    className="shrink-0 self-end rounded-md p-2 text-muted-foreground transition-colors hover:text-red-400 cursor-pointer sm:self-auto"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}

              {draft.length < MAX_TARGETS && (
                <Button
                  type="button" variant="outline" size="sm" className="gap-1.5 text-xs"
                  onClick={() => setDraft((prev) => [...prev, { type: '', authority: '', extra: [] }])}
                >
                  <Plus size={13} /> Add another
                </Button>
              )}

              {error && <p className="text-xs text-red-400">{error}</p>}

              <div className="flex justify-end gap-2 border-t border-border pt-3">
                <Button variant="ghost" size="sm" className="h-8 rounded-full text-xs px-3" onClick={() => setEditing(false)} disabled={publishing}>
                  Cancel
                </Button>
                <Button size="sm" className="h-8 rounded-full text-xs px-3 gap-1.5" onClick={publish} disabled={publishing}>
                  {publishing ? <><Loader2 size={13} className="animate-spin" /> Publishing…</> : <><Save size={13} /> Publish</>}
                </Button>
              </div>
            </div>
          ) : targets.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
                <HandCoins size={22} className="text-primary" />
              </div>
              <p className="text-sm text-muted-foreground">
                {isSelf ? 'You haven’t added any payment targets yet.' : `${displayName} hasn’t listed any payment targets.`}
              </p>
            </div>
          ) : (
            <TooltipProvider delayDuration={300}>
              <ul className="space-y-2">
                {targets.map((t, i) => (
                  <li key={`${t.type}-${i}`} className="flex items-center gap-3 rounded-lg border border-border bg-secondary/30 px-3 py-2">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="w-24 shrink-0 truncate text-sm font-medium text-foreground">
                          {paymentTypeLabel(t.type)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">{t.type}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                          {t.authority}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs break-all max-w-[280px]">{t.authority}</TooltipContent>
                    </Tooltip>
                    <CopyAuthority value={t.authority} />
                  </li>
                ))}
              </ul>
            </TooltipProvider>
          )}
        </div>
      </div>
    </div>
  )
}
