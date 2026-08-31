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
import { ShieldAlert, ShieldCheck, Eye, Check, KeyRound } from 'lucide-react'

// Separate dismiss keys: v1 and v2 carry different information (public-membership warning vs.
// what-is-protected + the NIP-SKD login requirement), so dismissing one must NOT hide the other.
const LS_KEY_V1 = 'den-chat-hub-join-warning-dismissed'
const LS_KEY_V2 = 'den-chat-hub-join-warning-dismissed-v2'

/** Returns true if the user has opted out of seeing the warning for this hub type. */
export function isJoinWarningDismissed(isV2 = false): boolean {
  try {
    return localStorage.getItem(isV2 ? LS_KEY_V2 : LS_KEY_V1) === '1'
  } catch {
    return false
  }
}

interface HubJoinWarningModalProps {
  open: boolean
  onClose: () => void
  /** Called when the user acknowledges the warning and wants to proceed. */
  onConfirm: () => void
  /** Private (v2) hub — show what's protected + the NIP-SKD login requirement instead of the v1 warning. */
  isV2?: boolean
}

export function HubJoinWarningModal({ open, onClose, onConfirm, isV2 = false }: HubJoinWarningModalProps) {
  const [neverShow, setNeverShow] = useState(false)

  if (!open) return null

  const handleConfirm = () => {
    if (neverShow) {
      try { localStorage.setItem(isV2 ? LS_KEY_V2 : LS_KEY_V1, '1') } catch { /* ignore */ }
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
          <div className={`w-12 h-12 rounded-full flex items-center justify-center mb-3 ${isV2 ? 'bg-emerald-500/15' : 'bg-amber-500/15'}`}>
            {isV2 ? <ShieldCheck size={22} className="text-emerald-400" /> : <ShieldAlert size={22} className="text-amber-400" />}
          </div>
          <h3 className="text-sm font-semibold text-foreground text-center">
            {isV2 ? 'Joining a private hub' : 'Before you join'}
          </h3>
        </div>

        {/* Body */}
        <div className="px-6 pb-4 space-y-3">
          {isV2 ? (
            <>
              <div className="rounded-xl bg-emerald-500/[0.07] border border-emerald-500/20 p-3.5 space-y-2.5">
                <div className="flex items-start gap-2.5">
                  <ShieldCheck size={14} className="text-emerald-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-foreground/85 leading-relaxed">
                    This is a <span className="font-semibold text-emerald-400">private hub</span>. Your identity and membership are protected:
                  </p>
                </div>
                <ul className="text-[11px] text-muted-foreground leading-relaxed pl-[22px] space-y-1.5">
                  <li className="flex items-start gap-1.5"><Check size={11} className="text-emerald-400 shrink-0 mt-0.5" /> You take part under a <span className="text-foreground/80">pseudonym</span> derived from your key — your real identity (npub) is never revealed to the hub or the public.</li>
                  <li className="flex items-start gap-1.5"><Check size={11} className="text-emerald-400 shrink-0 mt-0.5" /> No one can see that <span className="text-foreground/80">you</span> joined this hub.</li>
                  <li className="flex items-start gap-1.5"><Check size={11} className="text-emerald-400 shrink-0 mt-0.5" /> Who created it, who its members are, and who is posting are all hidden from the public.</li>
                  <li className="flex items-start gap-1.5"><Check size={11} className="text-emerald-400 shrink-0 mt-0.5" /> Messages are end-to-end encrypted.</li>
                </ul>
              </div>
              <div className="rounded-xl bg-secondary/40 border border-border/50 p-3.5">
                <div className="flex items-start gap-2.5">
                  <KeyRound size={14} className="text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    You can only join and chat in a private hub while signed in with the <span className="font-semibold text-foreground/85">DEN Chat client</span>, or a <span className="font-semibold text-foreground/85">remote or browser-extension signer that supports NIP-SKD</span>. A different login can’t open it.
                  </p>
                </div>
              </div>
            </>
          ) : (
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
          )}
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
