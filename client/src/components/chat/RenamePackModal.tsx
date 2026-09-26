/**
 * RenamePackModal — rename one of the user's own emoji / sticker / GIF packs.
 *
 * A pack's display name is its `title` tag (kind 30030/30031/30032); the addressable `d` tag is the
 * stable identity subscribers point at. Renaming therefore republishes the SAME set (same `d`, same
 * items) with a new `title` — nobody's subscription breaks. The caller does the publish + store update
 * in `onSave`; this modal only collects the name.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Pencil, X } from 'lucide-react'
import { useEscToClose } from '@/hooks/useEscToClose'

export const PACK_NAME_MAX = 60

export function RenamePackModal({ open, currentName, kindLabel, onClose, onSave, title, hint, maxLength = PACK_NAME_MAX, transform, validate }: {
  open: boolean
  currentName: string
  /** "emoji set" | "sticker set" | "GIF collection" | "emoji" | "sticker" | "GIF" — used in copy */
  kindLabel: string
  onClose: () => void
  /** Publish + store update. Throw to show an error; resolve to close. */
  onSave: (name: string) => Promise<void>
  /** Header text; defaults to `Rename ${kindLabel}`. */
  title?: string
  /** The small note under the input; defaults to the pack-subscription note. */
  hint?: string
  maxLength?: number
  /** Sanitize each keystroke (e.g. shortcode charset for emoji/sticker names). */
  transform?: (v: string) => string
  /** Return an error string to block Save (e.g. duplicate name), or null when valid. */
  validate?: (v: string) => string | null
}) {
  useEscToClose(onClose, open)
  const [name, setName] = useState(currentName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) { setName(currentName); setError(null); setSaving(false); setTimeout(() => inputRef.current?.select(), 0) }
  }, [open, currentName])

  if (!open) return null

  const trimmed = name.trim().slice(0, maxLength)
  const validationError = trimmed ? (validate?.(trimmed) ?? null) : null
  const canSave = trimmed.length > 0 && trimmed !== currentName.trim() && !validationError && !saving

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      await onSave(trimmed)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename')
      setSaving(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[320] flex items-center justify-center" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-[380px] mx-4 bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><Pencil size={14} className="text-primary" /> {title ?? `Rename ${kindLabel}`}</h3>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer">
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4 space-y-2">
          <input
            ref={inputRef}
            value={name}
            maxLength={maxLength}
            onChange={(e) => setName(transform ? transform(e.target.value) : e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save() }}
            className="w-full h-9 px-3 rounded-lg bg-secondary/40 border border-border text-sm text-foreground focus:outline-none focus:border-primary/40"
          />
          <div className="flex items-center justify-between text-[10px] text-muted-foreground/70">
            <span>{hint ?? 'Only the name changes, everyone subscribed keeps the pack.'}</span>
            <span>{name.length}/{maxLength}</span>
          </div>
          {validationError && <p className="text-xs text-amber-400">{validationError}</p>}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer">Cancel</button>
          <button
            onClick={save}
            disabled={!canSave}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving && <Loader2 size={13} className="animate-spin" />} Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
