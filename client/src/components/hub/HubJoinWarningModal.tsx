/**
 * HubJoinWarningModal — Privacy warning shown before joining any hub.
 *
 * Warns the user that while messages inside hubs are encrypted, the act of
 * joining a hub (publishing a kind 36944 join request) is publicly visible
 * on Nostr relays.  Other users can see which hubs you have joined.
 *
 * Includes a "Don't show this again" toggle persisted to localStorage.
 */

import { useState } from 'react'
import { ShieldAlert, Eye } from 'lucide-react'

const LS_KEY = 'den-chat-hub-join-warning-dismissed'

/** Returns true if the user has opted out of seeing the warning. */
export function isJoinWarningDismissed(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === '1'
  } catch {
    return false
  }
}

interface HubJoinWarningModalProps {
  open: boolean
  onClose: () => void
  /** Called when the user acknowledges the warning and wants to proceed. */
  onConfirm: () => void
}

export function HubJoinWarningModal({ open, onClose, onConfirm }: HubJoinWarningModalProps) {
  const [neverShow, setNeverShow] = useState(false)

  if (!open) return null

  const handleConfirm = () => {
    if (neverShow) {
      try { localStorage.setItem(LS_KEY, '1') } catch { /* ignore */ }
    }
    onConfirm()
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-2"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-2xl w-full max-w-[400px] overflow-hidden shadow-2xl border border-border/50 animate-in fade-in-0 zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header icon */}
        <div className="flex flex-col items-center pt-6 pb-2 px-6">
          <div className="w-12 h-12 rounded-full bg-amber-500/15 flex items-center justify-center mb-3">
            <ShieldAlert size={22} className="text-amber-400" />
          </div>
          <h3 className="text-sm font-semibold text-foreground text-center">
            Before you join
          </h3>
        </div>

        {/* Body */}
        <div className="px-6 pb-4 space-y-3">
          <div className="rounded-xl bg-secondary/40 border border-border/50 p-3.5 space-y-2.5">
            <div className="flex items-start gap-2.5">
              <Eye size={14} className="text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-foreground/85 leading-relaxed">
                Your messages inside hubs are <span className="font-semibold text-emerald-400">encrypted</span>, but your hub membership is <span className="font-semibold text-amber-400">publicly visible</span>.
              </p>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed pl-[22px]">
              When you join a hub, a public join request is broadcast to Nostr relays, along with your list of joined hubs. Anyone can see that your account has joined this hub, or any hub.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 space-y-3">
          {/* Never show toggle */}
          <label className="flex items-center justify-between cursor-pointer group">
            <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors select-none">
              Don't show this warning again
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={neverShow}
              onClick={() => setNeverShow(!neverShow)}
              className={`relative w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer shrink-0 ${neverShow ? 'bg-primary' : 'bg-muted-foreground/30'
                }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${neverShow ? 'translate-x-4' : 'translate-x-0'
                  }`}
              />
            </button>
          </label>

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="flex-1 h-9 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              className="flex-1 h-9 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
            >
              I Understand
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
