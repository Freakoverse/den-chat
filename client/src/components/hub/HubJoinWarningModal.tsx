/**
 * HubJoinWarningModal — the "Request to join" confirmation.
 *
 *  1. The join NOTE (NIP-CHAT §6.3.1): a short text the requester attaches — a reason, an intro,
 *     or a passphrase the hub asks for. Encrypted to the creator by the caller; never plaintext.
 *  2. "Privacy notes", an accordion (collapsed by default): joining a hub is publicly visible on
 *     relays (v1), or what a private (v2) hub does and doesn't hide plus the NIP-SKD requirement.
 *
 * Always opens on "Request join" — there is no dismiss toggle any more; the note is the point.
 */

import { useEffect, useState } from 'react'
import { ShieldCheck, Eye, Check, KeyRound, MessageSquareText, ChevronDown } from 'lucide-react'
import { useEscToClose } from '@/hooks/useEscToClose'
import { JOIN_NOTE_MAX, type JoinNotePolicy } from '@/lib/hub/joinNote'

interface HubJoinWarningModalProps {
  open: boolean
  onClose: () => void
  /** Called with the (trimmed) note when the user confirms — empty string when none. */
  onConfirm: (note: string) => void
  /** Private (v2) hub: privacy notes describe what's protected + the NIP-SKD login requirement. */
  isV2?: boolean
  /** The hub's join-note policy (prompt + optional/required), if it advertises one. */
  joinNote?: JoinNotePolicy
}

export function HubJoinWarningModal({ open, onClose, onConfirm, isV2 = false, joinNote }: HubJoinWarningModalProps) {
  useEscToClose(onClose, open)
  const [note, setNote] = useState('')
  const [privacyOpen, setPrivacyOpen] = useState(false)

  // Fresh state per opening
  useEffect(() => { if (open) { setNote(''); setPrivacyOpen(false) } }, [open])

  if (!open) return null

  const required = joinNote?.mode === 'required'
  const trimmed = note.trim()
  const canConfirm = !required || trimmed.length > 0

  const handleConfirm = () => {
    if (!canConfirm) return
    onConfirm(trimmed.slice(0, JOIN_NOTE_MAX))
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-2"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-2xl w-full max-w-[560px] overflow-hidden shadow-2xl border border-border/50 animate-in fade-in-0 zoom-in-95 duration-200 max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-4 space-y-3 overflow-y-auto min-h-0">
          {/* ── Join note ── */}
          <div className="rounded-xl bg-secondary/40 border border-border/50 p-3.5 space-y-2">
            <div className="flex items-center gap-2.5">
              <MessageSquareText size={14} className="text-primary shrink-0" />
              <p className="text-xs font-medium text-foreground/90 min-w-0 flex-1">
                {joinNote?.prompt?.trim() ? joinNote.prompt : 'Add a note'}
                {required
                  ? <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-400">required</span>
                  : <span className="ml-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">optional</span>}
              </p>
            </div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, JOIN_NOTE_MAX))}
              maxLength={JOIN_NOTE_MAX}
              rows={3}
              placeholder={required ? 'Write your note…' : 'Why you\'d like to join, an intro, or anything they asked for…'}
              className="w-full resize-none rounded-lg bg-background/60 border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary/40"
            />
            <div className="flex items-center justify-between text-[10px]">
              <span className={required && !trimmed ? 'text-amber-400' : 'text-muted-foreground/60'}>
                {required && !trimmed ? 'This hub requires a note to request access.' : ''}
              </span>
              <span className={`${note.length >= JOIN_NOTE_MAX ? 'text-amber-400' : 'text-muted-foreground/60'}`}>{note.length}/{JOIN_NOTE_MAX}</span>
            </div>
          </div>

          {/* ── Privacy notes (accordion) ── */}
          <div className="rounded-xl border border-border/50 overflow-hidden">
            <button
              onClick={() => setPrivacyOpen((v) => !v)}
              className="w-full flex items-center justify-between px-3.5 py-2.5 text-xs font-medium text-foreground/90 bg-secondary/30 hover:bg-secondary/50 transition-colors cursor-pointer"
            >
              <span className="flex items-center gap-2">
                {isV2 ? <ShieldCheck size={13} className="text-emerald-400" /> : <Eye size={13} className="text-amber-400" />}
                Privacy notes
              </span>
              <ChevronDown size={14} className={`text-muted-foreground transition-transform ${privacyOpen ? 'rotate-180' : ''}`} />
            </button>
            {privacyOpen && (
              <div className="p-3 space-y-3 border-t border-border/50">
                {isV2 ? (
                  <>
                    <div className="rounded-xl bg-emerald-500/[0.07] border border-emerald-500/20 p-3.5 space-y-2.5">
                      <div className="flex items-start gap-2.5">
                        <ShieldCheck size={14} className="text-emerald-400 shrink-0 mt-0.5" />
                        <p className="text-xs text-foreground/85 leading-relaxed">
                          This is a <span className="font-semibold text-emerald-400">private hub</span>. From the <span className="font-semibold text-emerald-400">public</span> it hides:
                        </p>
                      </div>
                      <ul className="text-[11px] text-muted-foreground leading-relaxed space-y-2">
                        <li className="flex items-start gap-2">
                          <Check size={12} className="text-emerald-400 shrink-0 mt-0.5" />
                          <span>That you joined. You take part under a <span className="text-foreground/80">pseudonym</span>, not your real npub.</span>
                        </li>
                        <li className="flex items-start gap-2">
                          <Check size={12} className="text-emerald-400 shrink-0 mt-0.5" />
                          <span>Who created the hub, who its members are, and who is posting.</span>
                        </li>
                        <li className="flex items-start gap-2">
                          <Check size={12} className="text-emerald-400 shrink-0 mt-0.5" />
                          <span>What is said. Messages are encrypted, so only members can read them.</span>
                        </li>
                      </ul>
                    </div>

                    <div className="rounded-xl bg-amber-500/[0.06] border border-amber-500/20 p-3.5">
                      <div className="flex items-start gap-2.5">
                        <Eye size={14} className="text-amber-400 shrink-0 mt-0.5" />
                        <p className="text-[11px] text-muted-foreground leading-relaxed">
                          Members <span className="font-semibold text-foreground/85">inside</span> the hub can still see who you really are. The privacy is from the outside public, not from the people you chat with.
                        </p>
                      </div>
                    </div>

                    <div className="rounded-xl bg-secondary/40 border border-border/50 p-3.5">
                      <div className="flex items-start gap-2.5">
                        <KeyRound size={14} className="text-muted-foreground shrink-0 mt-0.5" />
                        <p className="text-[11px] text-muted-foreground leading-relaxed">
                          You can only join and chat in a private hub while signed in with the <span className="font-semibold text-foreground/85">DEN Chat client</span>, or a <span className="font-semibold text-foreground/85">remote or browser-extension signer that supports NIP-SKD</span>. Other logins cannot open it.
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
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="flex-1 h-9 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={!canConfirm}
              className="flex-1 h-9 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Request to join
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
