/**
 * GroupMembersModal — the members of a group; the creator adds (by npub / hex) and removes.
 * Add = new leaf, no rotation. Remove = LKH kick + rotation + history append (lib/group/groupOps).
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { nip19 } from 'nostr-tools'
import { X, Loader2, UserPlus, UserMinus, Crown, AlertTriangle } from 'lucide-react'
import { useEscToClose } from '@/hooks/useEscToClose'
import { useHubStore } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { truncateNpub } from '@/lib/utils'
import { addMember, removeMember } from '@/lib/group/groupOps'
import { GROUP_MAX_MEMBERS } from '@/lib/group/groupEvent'

function toHexPubkey(input: string): string | null {
  const raw = input.trim().replace(/^nostr:/i, '')
  if (/^[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase()
  try {
    const d = nip19.decode(raw)
    if (d.type === 'npub') return d.data as string
    if (d.type === 'nprofile') return d.data.pubkey
  } catch { /* fallthrough */ }
  return null
}

export function GroupMembersModal({ dTag, isCreator, onClose }: { dTag: string; isCreator: boolean; onClose: () => void }) {
  useEscToClose(onClose, true)
  const hub = useHubStore((s) => s.hubs[dTag])
  const members = useHubStore((s) => s.hubMembers[dTag]) ?? []
  const myPubkey = useUserStore((s) => s.pubkey)
  const { getProfile } = useProfileCache()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState<string | null>(null) // 'add' | pubkey being removed
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  const creatorReal = hub?.ownerRealPubkey ?? hub?.creatorPubkey
  const full = members.length >= GROUP_MAX_MEMBERS

  const handleAdd = async () => {
    const pk = toHexPubkey(input)
    if (!pk) { setError('Enter an npub, nprofile, or hex pubkey'); return }
    setBusy('add'); setError(null)
    try {
      await addMember(dTag, pk)
      setInput('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add member')
    } finally { setBusy(null) }
  }

  const handleRemove = async (pubkey: string) => {
    const m = members.find((x) => x.pubkey === pubkey)
    if (!m) return
    setBusy(pubkey); setError(null)
    try {
      await removeMember(dTag, m)
      setConfirmRemove(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member')
    } finally { setBusy(null) }
  }

  return createPortal(
    <div className="fixed inset-0 z-[250] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-[440px] mx-4 bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">Members</h3>
            <p className="text-[11px] text-muted-foreground">{members.length} of {GROUP_MAX_MEMBERS}{hub?.name ? ` · ${hub.name}` : ''}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer">
            <X size={16} />
          </button>
        </div>

        {isCreator && (
          <div className="px-5 pt-4 pb-2 space-y-1.5 shrink-0">
            <div className="flex items-center gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
                placeholder={full ? 'Group is full' : 'npub1… or hex pubkey'}
                disabled={full || busy === 'add'}
                className="flex-1 h-9 px-3 rounded-lg bg-secondary/40 border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary/40 disabled:opacity-50"
              />
              <button
                onClick={handleAdd}
                disabled={full || busy === 'add' || !input.trim()}
                className="inline-flex items-center gap-1.5 px-3 h-9 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {busy === 'add' ? <Loader2 size={12} className="animate-spin" /> : <UserPlus size={12} />} Add
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground/70">Adding publishes a new tree with their leaf — no rotation. They see the group once they accept the invite address.</p>
          </div>
        )}

        {error && (
          <div className="mx-5 mb-2 flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive shrink-0">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" /> {error}
          </div>
        )}

        <div className="px-3 pb-3 overflow-y-auto min-h-0 space-y-0.5">
          {members.map((m) => {
            const profile = getProfile(m.pubkey)
            const npub = (() => { try { return nip19.npubEncode(m.pubkey) } catch { return m.pubkey } })()
            const name = profile?.display_name || profile?.name || truncateNpub(npub, 10)
            const isMe = m.pubkey === myPubkey
            const isOwner = m.pubkey === creatorReal
            const removing = busy === m.pubkey
            return (
              <div key={m.pubkey} className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-secondary/40">
                <Avatar className="h-8 w-8 shrink-0">
                  {profile?.picture && <AvatarImage src={profile.picture} />}
                  <AvatarFallback className="text-xs bg-primary/20 text-primary">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground truncate flex items-center gap-1.5">
                    {name}{isMe && <span className="text-[10px] text-muted-foreground">(you)</span>}
                    {isOwner && <Crown size={11} className="text-amber-400 shrink-0" />}
                  </p>
                  <p className="text-[10px] text-muted-foreground font-mono truncate">{truncateNpub(npub, 6)}</p>
                </div>
                {isCreator && !isMe && !isOwner && (
                  confirmRemove === m.pubkey ? (
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => handleRemove(m.pubkey)} disabled={removing} className="px-2 py-1 rounded-md text-[11px] font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 cursor-pointer disabled:opacity-50">
                        {removing ? <Loader2 size={11} className="animate-spin" /> : 'Remove'}
                      </button>
                      <button onClick={() => setConfirmRemove(null)} disabled={removing} className="px-2 py-1 rounded-md text-[11px] text-muted-foreground hover:text-foreground cursor-pointer">Cancel</button>
                    </div>
                  ) : (
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button onClick={() => setConfirmRemove(m.pubkey)} className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer shrink-0">
                            <UserMinus size={14} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="left" className="text-xs">Remove — rotates the group secret; they can't read anything after this point</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>,
    document.body,
  )
}
