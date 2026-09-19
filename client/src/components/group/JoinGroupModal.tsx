/**
 * JoinGroupModal — paste an invite address (naddr / coordinate), preview the group's face and
 * whether you're in its tree, then accept (adds it to your kind-16943 list). Declining is just
 * closing. Also used when opening a shared group card.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader2, Lock, Users, AlertTriangle, Check } from 'lucide-react'
import { useEscToClose } from '@/hooks/useEscToClose'
import { useGroupStore } from '@/stores/groupStore'
import { previewInvite, acceptInvite, type InvitePreview } from '@/lib/group/groupOps'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'

export function JoinGroupModal({ initialAddress = '', onClose, onJoined }: {
  initialAddress?: string
  onClose: () => void
  onJoined: (dTag: string) => void
}) {
  useEscToClose(onClose, true)
  const entries = useGroupStore((s) => s.entries)
  const [address, setAddress] = useState(initialAddress)
  const [preview, setPreview] = useState<InvitePreview | null>(null)
  const [checking, setChecking] = useState(false)
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const check = async (addr: string) => {
    if (!addr.trim()) return
    setChecking(true); setError(null); setPreview(null)
    try {
      const p = await previewInvite(addr)
      if (!p) { setError('No group found at that address on your relays.'); return }
      setPreview(p)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not look up that address')
    } finally { setChecking(false) }
  }

  useEffect(() => { if (initialAddress) void check(initialAddress) }, [initialAddress]) // eslint-disable-line react-hooks/exhaustive-deps

  const alreadyIn = preview ? entries.some((e) => e.dTag === preview.group.dTag) : false

  const join = async () => {
    if (!preview) return
    setJoining(true); setError(null)
    try {
      await acceptInvite(preview)
      onJoined(preview.group.dTag)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join')
      setJoining(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[250] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-[440px] mx-4 bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Join a group</h3>
            <p className="text-[11px] text-muted-foreground">Paste the invite address the creator sent you.</p>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer"><X size={16} /></button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center gap-2">
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') check(address) }}
              placeholder="naddr1…"
              className="flex-1 h-9 px-3 rounded-lg bg-secondary/40 border border-border text-sm text-foreground font-mono placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary/40"
              autoFocus={!initialAddress}
            />
            <button onClick={() => check(address)} disabled={checking || !address.trim()} className="inline-flex items-center gap-1.5 px-3 h-9 rounded-lg text-xs font-medium bg-secondary hover:bg-secondary/70 text-foreground cursor-pointer disabled:opacity-50">
              {checking ? <Loader2 size={12} className="animate-spin" /> : 'Look up'}
            </button>
          </div>

          {preview && (
            <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-2">
              <div className="flex items-center gap-3">
                <Avatar className="h-10 w-10 rounded-lg">
                  {preview.group.picture && <AvatarImage src={preview.group.picture} />}
                  <AvatarFallback className="text-xs bg-primary/20 text-primary rounded-lg">{preview.group.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground truncate flex items-center gap-1.5">
                    {preview.group.version === 2 && <Lock size={11} className="text-emerald-400" />}
                    {preview.group.name}
                  </p>
                  {preview.group.about && <p className="text-xs text-muted-foreground line-clamp-2">{preview.group.about}</p>}
                </div>
              </div>
              <p className={`flex items-center gap-1.5 text-[11px] ${preview.isMember ? 'text-emerald-400' : 'text-amber-400'}`}>
                {preview.isMember
                  ? <><Check size={12} /> You're in this group's member tree.</>
                  : <><Users size={12} /> Your key isn't in the member tree yet — ask the creator to add you, then join.</>}
              </p>
              {alreadyIn && <p className="text-[11px] text-muted-foreground">This group is already in your list.</p>}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" /> {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer">Cancel</button>
          <button
            onClick={join}
            disabled={!preview || !preview.isMember || alreadyIn || joining}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {joining && <Loader2 size={11} className="animate-spin" />} Join group
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
