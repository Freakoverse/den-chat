/**
 * GroupMembersModal: "Add members" for a group (creator only). Pick from the follow list or paste
 * an npub / NIP-05 / DNN ID, then publish once for the whole batch (lib/group/groupOps.addMembers).
 * Removal lives in GroupDetailsModal's member list.
 */
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { nip19 } from 'nostr-tools'
import { X, Loader2, UserPlus, Plus, Search, Check, AlertTriangle } from 'lucide-react'
import { useEscToClose } from '@/hooks/useEscToClose'
import { useHubStore } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { useFollowStore } from '@/stores/followStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn, truncateNpub } from '@/lib/utils'
import { addMembers } from '@/lib/group/groupOps'
import { resolveIdentifier } from '@/lib/group/resolveIdentifier'
import { GROUP_MAX_MEMBERS } from '@/lib/group/groupEvent'

export function GroupMembersModal({ dTag, onClose }: { dTag: string; isCreator?: boolean; onClose: () => void }) {
  useEscToClose(onClose, true)
  const hub = useHubStore((s) => s.hubs[dTag])
  const members = useHubStore((s) => s.hubMembers[dTag]) ?? []
  const myPubkey = useUserStore((s) => s.pubkey)
  const followed = useFollowStore((s) => s.followedPubkeys)
  const { getProfile } = useProfileCache()

  const memberSet = useMemo(() => new Set(members.map((m) => m.pubkey)), [members])
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [customInput, setCustomInput] = useState('')
  const [resolving, setResolving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const room = GROUP_MAX_MEMBERS - members.length
  const followList = useMemo(() => {
    const q = search.trim().toLowerCase()
    const all = [...followed].filter((pk) => pk !== myPubkey && !memberSet.has(pk))
    if (!q) return all
    return all.filter((pk) => {
      const p = getProfile(pk)
      return `${p?.display_name ?? ''} ${p?.name ?? ''} ${p?.nip05 ?? ''}`.toLowerCase().includes(q) || pk.startsWith(q)
    })
  }, [followed, search, getProfile, myPubkey, memberSet])

  const toggle = (pk: string) => {
    if (selected.includes(pk)) { setSelected(selected.filter((m) => m !== pk)); return }
    if (selected.length >= room) { setError(`Only ${room} more can be added (${GROUP_MAX_MEMBERS} max)`); return }
    setSelected([...selected, pk]); setError(null)
  }
  const addCustom = async () => {
    if (!customInput.trim()) return
    setResolving(true); setError(null)
    try {
      const pk = await resolveIdentifier(customInput)
      if (!pk) { setError('Could not resolve that. Use an npub, nprofile, hex pubkey, NIP-05 address, or DNN ID.'); return }
      if (pk === myPubkey) { setError("That's you."); return }
      if (memberSet.has(pk)) { setError('Already a member.'); return }
      if (!selected.includes(pk)) toggle(pk)
      setCustomInput('')
    } finally { setResolving(false) }
  }
  const submit = async () => {
    if (selected.length === 0) return
    setBusy(true); setError(null)
    try {
      await addMembers(dTag, selected)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add members')
      setBusy(false)
    }
  }

  const field = 'w-full h-9 px-3 rounded-lg bg-secondary/40 border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary/40'
  const label = (pk: string) => {
    const p = getProfile(pk)
    const npub = (() => { try { return nip19.npubEncode(pk) } catch { return pk } })()
    return { p, name: p?.display_name || p?.name || truncateNpub(npub, 10) }
  }

  return createPortal(
    <div className="fixed inset-0 z-[250] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[480px] mx-4 bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">Add members</h3>
            <p className="text-[11px] text-muted-foreground">{members.length} of {GROUP_MAX_MEMBERS}{hub?.name ? ` · ${hub.name}` : ''}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer"><X size={16} /></button>
        </div>

        <div className="px-5 py-4 space-y-3 overflow-y-auto min-h-0">
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-secondary/30">
              <Search size={14} className="text-muted-foreground shrink-0" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people you follow" className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 outline-none" />
            </div>
            <div className="max-h-56 overflow-y-auto p-2 space-y-0.5">
              {followList.length === 0 ? (
                <p className="px-2 py-3 text-xs text-muted-foreground/70">{followed.size === 0 ? "You don't follow anyone yet. Add people below." : 'No matches.'}</p>
              ) : followList.map((pk) => {
                const { p, name } = label(pk)
                const on = selected.includes(pk)
                return (
                  <button key={pk} onClick={() => toggle(pk)} className={cn('w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-left transition-colors cursor-pointer', on ? 'bg-primary/10' : 'hover:bg-secondary/40')}>
                    <Avatar className="h-9 w-9 shrink-0">
                      {p?.picture && <AvatarImage src={p.picture} />}
                      <AvatarFallback className="text-xs bg-primary/20 text-primary">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <span className="text-sm text-foreground truncate flex-1">{name}</span>
                    <span className={cn('w-[18px] h-[18px] rounded border flex items-center justify-center shrink-0', on ? 'bg-primary border-primary' : 'border-border')}>{on && <Check size={12} className="text-primary-foreground" />}</span>
                  </button>
                )
              })}
            </div>
          </div>
          {selected.filter((m) => !followed.has(m)).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {selected.filter((m) => !followed.has(m)).map((m) => (
                <span key={m} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-secondary/60 border border-border/60 text-xs text-foreground">
                  {label(m).name}
                  <button onClick={() => toggle(m)} className="text-muted-foreground hover:text-destructive cursor-pointer"><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <input value={customInput} onChange={(e) => setCustomInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addCustom() }} placeholder="npub, NIP-05 address, or DNN ID" className={field} />
            <button onClick={addCustom} disabled={resolving || !customInput.trim()} className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer disabled:opacity-50">
              {resolving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground/70">Adding publishes a new tree with their leaves, no rotation. They see the group once they open its address.</p>
          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" /> {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border shrink-0">
          <span className="text-xs text-muted-foreground">{selected.length} selected</span>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer">Cancel</button>
            <button onClick={submit} disabled={busy || selected.length === 0} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
              {busy ? <Loader2 size={11} className="animate-spin" /> : <UserPlus size={11} />} Add {selected.length > 0 ? selected.length : ''}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
