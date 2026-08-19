/**
 * CustomSelect — A fully styled dropdown select that renders via DOM, not native OS.
 *
 * Replaces native <select> elements which render with system styling in Tauri's
 * WebView, ignoring the app's dark theme. This component renders the dropdown
 * popup as a positioned DOM element with full CSS control.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SelectOption {
  value: string
  label: string
}

interface CustomSelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  className?: string
  /** Extra classes for the dropdown popup */
  popupClassName?: string
  /** Extra classes for the trigger button (e.g. a max-width so the label truncates in tight rows) */
  triggerClassName?: string
  /** Compact mode for inline usage */
  compact?: boolean
  disabled?: boolean
}

export function CustomSelect({ value, onChange, options, className, popupClassName, triggerClassName, compact, disabled }: CustomSelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  const selectedLabel = options.find(o => o.value === value)?.label || value

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  // Position popup above if near bottom of viewport
  useEffect(() => {
    if (!open || !popupRef.current || !ref.current) return
    const triggerRect = ref.current.getBoundingClientRect()
    const popup = popupRef.current
    const spaceBelow = window.innerHeight - triggerRect.bottom
    const popupHeight = popup.scrollHeight

    if (spaceBelow < popupHeight + 8 && triggerRect.top > popupHeight + 8) {
      popup.style.bottom = '100%'
      popup.style.top = 'auto'
      popup.style.marginBottom = '4px'
      popup.style.marginTop = '0'
    } else {
      popup.style.top = '100%'
      popup.style.bottom = 'auto'
      popup.style.marginTop = '4px'
      popup.style.marginBottom = '0'
    }
  }, [open])

  const select = useCallback((val: string) => {
    onChange(val)
    setOpen(false)
  }, [onChange])

  return (
    <div ref={ref} className={cn('relative', className)}>
      {/* Trigger */}
      <button
        type="button"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        className={cn(
          'flex items-center justify-between gap-1.5 rounded-lg border border-input bg-background text-foreground cursor-pointer outline-none transition-colors hover:bg-accent/50 disabled:opacity-50 disabled:cursor-not-allowed',
          compact ? 'h-7 px-2 text-xs' : 'h-9 px-2.5 text-xs',
          open && 'border-primary/40 bg-accent/30',
          triggerClassName,
        )}
        style={{ minWidth: compact ? 80 : 90 }}
      >
        <span className="truncate min-w-0">{selectedLabel}</span>
        <ChevronDown size={12} className={cn('shrink-0 text-muted-foreground transition-transform duration-150', open && 'rotate-180')} />
      </button>

      {/* Dropdown popup */}
      {open && (
        <div
          ref={popupRef}
          className={cn(
            'absolute left-0 z-[200] min-w-full rounded-lg border border-border bg-popover shadow-xl p-1 space-y-1 animate-in fade-in-0 zoom-in-95 duration-100',
            popupClassName,
          )}
        >
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => select(opt.value)}
              className={cn(
                'flex items-center w-full px-2.5 py-1.5 text-xs text-left transition-colors cursor-pointer rounded-sm',
                opt.value === value
                  ? 'bg-primary/15 text-primary font-medium'
                  : 'text-foreground hover:bg-accent/60',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
