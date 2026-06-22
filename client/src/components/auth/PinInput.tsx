/**
 * PinInput — a PIN field with a show/hide eye toggle and a keyboard-type toggle.
 *
 * Defaults to the numeric keypad (inputMode "numeric") since PINs are usually
 * digits; the keypad/keyboard button flips to the full keyboard for alphanumeric
 * PINs. Shared across the desktop and PWA-vault login flows.
 */
import { useState } from 'react'
import { Eye, EyeOff, Hash, Keyboard } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface PinInputProps {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
  onEnter?: () => void
  className?: string
}

export function PinInput({ value, onChange, placeholder = 'Enter PIN', autoFocus, onEnter, className }: PinInputProps) {
  const [show, setShow] = useState(false)
  const [numeric, setNumeric] = useState(true)
  return (
    <div className={cn('flex gap-2 w-full', className)}>
      <div className="relative flex-1">
        <Input
          type={show ? 'text' : 'password'}
          inputMode={numeric ? 'numeric' : 'text'}
          placeholder={placeholder}
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onEnter?.() }}
          className="h-10 pr-10"
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          aria-label={show ? 'Hide PIN' : 'Show PIN'}
        >
          {show ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
      <button
        type="button"
        onClick={() => setNumeric((n) => !n)}
        title={numeric ? 'Switch to full keyboard' : 'Switch to number pad'}
        aria-label={numeric ? 'Switch to full keyboard' : 'Switch to number pad'}
        className="h-10 w-10 shrink-0 flex items-center justify-center rounded-md border border-input bg-background text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
      >
        {numeric ? <Hash size={16} /> : <Keyboard size={16} />}
      </button>
    </div>
  )
}
