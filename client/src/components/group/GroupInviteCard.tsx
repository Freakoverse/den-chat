/**
 * GroupInviteCard: a kind-36950 group address shared in chat / social. Deliberately not the hub
 * card: a compact row with a left accent and a "Group" badge instead of a banner card. The button
 * depends on where the viewer stands: in the tree but not in their list (Join), already in their
 * list (Open), otherwise Request to join (kind 36944 to the creator, §21.6.1) with an optional note.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Users, Lock, Loader2, Check, Send, X, AlertTriangle } from 'lucide-react'
import { useCachedFetch } from '@/hooks/useCachedFetch'
import { useEscToClose } from '@/hooks/useEscToClose'
import { fetchGroupEvent } from '@/hooks/useGroupLoader'
import { parseGroupEvent, deriveGroupSecret, type GroupData } from '@/lib/group/groupEvent'
import { acceptInvite } from '@/lib/group/groupOps'
import { requestJoinGroup, getOwnGroupJoinRequest } from '@/lib/group/groupJoin'
import { JOIN_NOTE_MAX } from '@/lib/hub/joinNote'
import { useGroupStore } from '@/stores/groupStore'
import { useUserStore } from '@/stores/userStore'
import { useNavigationStore } from '@/stores/navigationStore'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { GroupVersionPill } from '@/components/group/GroupVersionPill'

interface Resolved { event: import('nostr-tools').Event; group: GroupData; isMember: boolean }

export function GroupInviteCard({ identifier, pubkey, relays }: { identifier: string; pubkey: string; relays?: string[] }) {
  const me = useUserStore((s) => s.pubkey)
  const privateKey = useUserStore((s) => s.privateKey)
  const signer = useUserStore((s) => s.signer)
  const relayKey = (relays || []).join('|')
  const { data, loading } = useCachedFetch<Resolved>(`36950:${pubkey}:${identifier}|${relayKey}|${me ?? ''}`, async () => {
    const ev = await fetchGroupEvent(pubkey, identifier, relays?.[0])
    const g = ev ? parseGroupEvent(ev) : null
    if (!ev || !g || g.deleted) return null
    let isMember = false
    if (me) { try { isMember = !!(await deriveGroupSecret(g, me, { privateKey, signer })) } catch { isMember = false } }
    return { event: ev, group: g, isMember }
  })
  const inList = useGroupStore((s) => s.entries.some((e) => e.dTag === identifier))
  const [showRequest, setShowRequest] = useState(false)
  const [requested, setRequested] = useState<boolean | null>(null)
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Not a member: find out whether a request is already pending, so the button reads "Requested".
  useEffect(() => {
    if (!data || data.isMember || inList || !me) return
    let alive = true
    getOwnGroupJoinRequest(data.group).then((r) => { if (alive) setRequested(!!r) }).catch(() => { if (alive) setRequested(false) })
    return () => { alive = false }
  }, [data, inList, me])

  if (loading) {
    return (
      <div className="my-2 rounded-lg border border-border p-3 flex items-center gap-2 text-xs text-muted-foreground max-w-[350px]">
        <Loader2 size={12} className="animate-spin" /> Loading group...
      </div>
    )
  }
  if (!data) {
    return (
      <span className="inline-flex items-center gap-1.5 my-1 px-2 py-1 rounded-md border border-border text-xs text-muted-foreground">
        <Users size={12} /> Group not found
      </span>
    )
  }
  const { group, isMember } = data
  const isV2 = group.version === 2

  const open = () => {
    useGroupStore.getState().requestOpenGroup(identifier)
    useNavigationStore.getState().setActivePage('dms')
  }
  const join = async () => {
    setJoining(true); setError(null)
    try {
      await acceptInvite({ coord: { pubkey, dTag: identifier }, relays: relays || [], event: data.event, group, isMember: true })
      open()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join')
    } finally { setJoining(false) }
  }

  const button = inList
    ? { label: 'Open', onClick: open, primary: false }
    : isMember
      ? { label: joining ? 'Joining...' : 'Join', onClick: join, primary: true }
      : requested
        ? { label: 'Requested', onClick: () => setShowRequest(true), primary: false }
        : { label: 'Request to join', onClick: () => setShowRequest(true), primary: true }

  return (
    <>
      <div className="my-2 max-w-[350px] rounded-lg border border-border border-l-4 border-l-primary/70 bg-secondary/10 hover:bg-secondary/20 transition-colors">
        <div className="px-3 pt-2.5 pb-3 space-y-2">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-semibold uppercase tracking-wide">
              {isV2 ? <Lock size={9} /> : <Users size={9} />} Group
            </span>
            <GroupVersionPill version={group.version} />
            {group.joinMinPow > 0 && <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-amber-500/15 text-amber-400">Join PoW {group.joinMinPow}</span>}
          </div>
          <div className="flex items-center gap-2.5">
            <Avatar className="h-10 w-10 shrink-0">
              {group.picture && <AvatarImage src={group.picture} />}
              <AvatarFallback className="text-xs bg-primary/20 text-primary">{group.name.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground truncate">{group.name}</p>
              {group.about ? (
                <p className="text-xs text-muted-foreground leading-snug line-clamp-2">{group.about}</p>
              ) : (
                <p className="text-[11px] text-muted-foreground/70">One conversation, invite only</p>
              )}
            </div>
          </div>
          <button
            onClick={button.onClick}
            disabled={joining || !me}
            className={button.primary
              ? 'w-full inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50'
              : 'w-full inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium border border-border text-foreground hover:bg-secondary/60 transition-colors cursor-pointer disabled:opacity-50'}
          >
            {joining ? <Loader2 size={12} className="animate-spin" /> : requested && !inList && !isMember ? <Check size={12} className="text-emerald-400" /> : null}
            {button.label}
          </button>
          {error && <p className="text-[11px] text-destructive">{error}</p>}
        </div>
      </div>
      {showRequest && (
        <GroupJoinRequestModal
          group={group}
          alreadyRequested={!!requested}
          onClose={() => setShowRequest(false)}
          onSent={() => { setRequested(true); setShowRequest(false) }}
        />
      )}
    </>
  )
}

/** Note + send for a group join request. Same note rules as hubs (§6.3.1). */
function GroupJoinRequestModal({ group, alreadyRequested, onClose, onSent }: { group: GroupData; alreadyRequested: boolean; onClose: () => void; onSent: () => void }) {
  useEscToClose(onClose, true)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isV2 = group.version === 2

  const send = async () => {
    setBusy(true); setError(null)
    try {
      await requestJoinGroup(group, note)
      onSent()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send the request')
      setBusy(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[250] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[440px] mx-4 bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground truncate">{alreadyRequested ? 'Resend request' : 'Request to join'} {group.name}</h3>
            <p className="text-[11px] text-muted-foreground">The creator decides who gets in. {alreadyRequested ? 'Sending again replaces your earlier request.' : ''}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-foreground">Add a note <span className="font-normal text-muted-foreground">(optional)</span></span>
            <textarea value={note} maxLength={JOIN_NOTE_MAX} rows={3} onChange={(e) => setNote(e.target.value)} placeholder="Who you are, why you'd like in" className="w-full px-3 py-2 rounded-lg bg-secondary/40 border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary/40 resize-none" />
            <div className="text-right text-[11px] text-muted-foreground/60">{note.length}/{JOIN_NOTE_MAX}</div>
          </label>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {isV2
              ? 'Private group: the request is sealed to the creator under a derived key. Nobody else can tell it came from you.'
              : 'The request is a public event that names you and the group. The note itself is encrypted to the creator.'}
          </p>
          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" /> {error}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer">Cancel</button>
          <button onClick={send} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer disabled:opacity-50">
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />} Send request
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
