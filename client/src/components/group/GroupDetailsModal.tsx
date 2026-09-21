/**
 * GroupDetailsModal: opened from the group chat header. Shows the banner, picture, name and the
 * members-only description, the member list (searchable, scrolls; the creator removes from here),
 * an "Add members" button that opens the add modal, the creator's pending join requests (§21.6.1),
 * an Edit mode (face uploads via GroupFaceEditor, name, public + private descriptions), and a
 * "Dangerous" accordion holding request-delete (creator) or leave (member).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { nip19 } from 'nostr-tools'
import { X, Loader2, Pencil, UserPlus, UserMinus, Search, Crown, Lock, ChevronDown, AlertTriangle, Trash2, LogOut, RotateCw, Check, MessageSquareText, Square, CheckSquare } from 'lucide-react'
import { useEscToClose } from '@/hooks/useEscToClose'
import { useHubStore } from '@/stores/hubStore'
import { useGroupStore } from '@/stores/groupStore'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { GroupFaceEditor, type GroupFaceState } from '@/components/group/GroupFaceEditor'
import { GroupVersionPill } from '@/components/group/GroupVersionPill'
import { PowSection } from '@/components/hub/PowSection'
import { GroupMembersModal } from '@/components/group/GroupMembersModal'
import { ConfirmDeleteGroupModal, ConfirmLeaveGroupModal } from '@/components/group/GroupMenu'
import { updateGroup, removeMember, addMembers } from '@/lib/group/groupOps'
import { fetchGroupJoinRequests, readGroupJoinNote, type GroupJoinRequest } from '@/lib/group/groupJoin'
import { GROUP_NAME_MAX, GROUP_ABOUT_MAX, GROUP_DESCRIPTION_MAX, GROUP_MAX_MEMBERS } from '@/lib/group/groupEvent'
import { HUB_BANNER_PLACEHOLDER } from '@/lib/constants'
import { cn, truncateNpub } from '@/lib/utils'

export function GroupDetailsModal({ dTag, isCreator, onClose }: { dTag: string; isCreator: boolean; onClose: () => void }) {
  const hub = useHubStore((s) => s.hubs[dTag])
  const group = useGroupStore((s) => s.groups[dTag])
  const members = useHubStore((s) => s.hubMembers[dTag]) ?? []
  const myPubkey = useUserStore((s) => s.pubkey)
  const { getProfile } = useProfileCache()

  const name = hub?.name || 'Group'
  const isV2 = hub?.version === 2
  const creatorReal = hub?.ownerRealPubkey ?? hub?.creatorPubkey
  // toHubData falls back to the public blurb when there is no members-only description.
  const privateDescription = hub?.description && hub.description !== group?.about ? hub.description : ''
  const profileOf = (pk: string) => {
    const p = getProfile(pk)
    const npub = (() => { try { return nip19.npubEncode(pk) } catch { return pk } })()
    return { p, npub, label: p?.display_name || p?.name || truncateNpub(npub, 10) }
  }

  // Members
  const [search, setSearch] = useState('')
  const [showManage, setShowManage] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return members
    return members.filter((m) => {
      const p = getProfile(m.pubkey)
      return `${p?.display_name ?? ''} ${p?.name ?? ''} ${p?.nip05 ?? ''}`.toLowerCase().includes(q) || m.pubkey.startsWith(q)
    })
  }, [members, search, getProfile])
  const doRemove = async (pubkey: string) => {
    const m = members.find((x) => x.pubkey === pubkey)
    if (!m) return
    setRemoving(pubkey); setError(null)
    try { await removeMember(dTag, m); setConfirmRemove(null) } catch (err) { setError(err instanceof Error ? err.message : 'Failed to remove member') } finally { setRemoving(null) }
  }

  // Join requests (creator)
  const [requests, setRequests] = useState<GroupJoinRequest[] | null>(null)
  const [loadingRequests, setLoadingRequests] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [approving, setApproving] = useState(false)
  const [noteView, setNoteView] = useState<{ pubkey: string; text: string | null; loading: boolean } | null>(null)
  const memberSet = useMemo(() => new Set(members.map((m) => m.pubkey)), [members])
  const loadRequests = useCallback(async () => {
    if (!group || !creatorReal) return
    setLoadingRequests(true)
    try { setRequests(await fetchGroupJoinRequests(group, { memberPubkeys: memberSet, creatorReal })) } catch { setRequests([]) } finally { setLoadingRequests(false) }
  }, [group, creatorReal, memberSet])
  useEffect(() => { if (isCreator) void loadRequests() }, [isCreator, loadRequests])
  const toggleSelected = (pk: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(pk)) n.delete(pk); else n.add(pk); return n })
  const approve = async () => {
    if (selected.size === 0) return
    setApproving(true); setError(null)
    try {
      await addMembers(dTag, [...selected])
      setSelected(new Set())
      await loadRequests()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add members')
    } finally { setApproving(false) }
  }
  const openNote = async (req: GroupJoinRequest) => {
    setNoteView({ pubkey: req.pubkey, text: null, loading: true })
    const text = await readGroupJoinNote(req)
    setNoteView({ pubkey: req.pubkey, text, loading: false })
  }

  // Edit mode (creator)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editAbout, setEditAbout] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editMinPow, setEditMinPow] = useState(15)
  const [editJoinMinPow, setEditJoinMinPow] = useState(15)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [face, setFace] = useState<GroupFaceState>({ face: { picture: null, banner: null }, uploading: false, overlayOpen: false, realKeyUploads: [] })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const startEditing = () => {
    setEditName(hub?.name ?? '')
    setEditAbout(group?.about ?? '')
    setEditDescription(privateDescription)
    setEditMinPow(group?.minPow ?? 0)
    setEditJoinMinPow(group?.joinMinPow ?? 0)
    setShowAdvanced(false)
    setError(null)
    setEditing(true)
  }
  const save = async () => {
    if (!editName.trim()) { setError('Name is required'); return }
    if (face.uploading) { setError('Wait for the image upload to finish'); return }
    setSaving(true); setError(null)
    try {
      await updateGroup(dTag, {
        name: editName.trim(),
        about: editAbout.trim(),
        description: editDescription.trim(),
        picture: face.face.picture ?? '',
        banner: face.face.banner ?? '',
        minPow: editMinPow,
        joinMinPow: editJoinMinPow,
      })
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally { setSaving(false) }
  }

  // Dangerous
  const [showDanger, setShowDanger] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [showLeave, setShowLeave] = useState(false)

  useEscToClose(onClose, !showManage && !showDelete && !showLeave && !face.overlayOpen && !noteView)

  const field = 'w-full h-9 px-3 rounded-lg bg-secondary/40 border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary/40'
  const boxHeader = 'flex items-center gap-2 px-3 py-2 border-b border-border bg-secondary/30'

  return createPortal(
    <div className="fixed inset-0 z-[250] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[560px] mx-4 bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200 max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{editing ? 'Edit group' : 'Group details'}</h3>
            <GroupVersionPill version={hub?.version} aboveModal />
            {(group?.joinMinPow ?? 0) > 0 && <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-amber-500/15 text-amber-400">Join PoW {group?.joinMinPow}</span>}
          </div>
          <div className="flex items-center gap-1">
            {isCreator && !editing && (
              <button onClick={startEditing} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer">
                <Pencil size={13} /> Edit
              </button>
            )}
            <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer"><X size={16} /></button>
          </div>
        </div>

        <div className="px-5 py-4 space-y-5 overflow-y-auto min-h-0">
          {editing ? (
            <>
              <GroupFaceEditor dTag={dTag} v2={isV2} initial={{ picture: group?.picture ?? null, banner: group?.banner ?? null }} onChange={setFace} onError={setError} />
              <label className="block space-y-1">
                <span className="text-xs font-medium text-foreground">Name</span>
                <input value={editName} maxLength={GROUP_NAME_MAX} onChange={(e) => setEditName(e.target.value)} className={field} />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-foreground">Public short description <span className="font-normal text-muted-foreground">(shown to invitees)</span></span>
                <textarea value={editAbout} maxLength={GROUP_ABOUT_MAX} rows={3} onChange={(e) => setEditAbout(e.target.value)} placeholder="Optional" className={`${field} h-auto py-2 resize-none`} />
                <div className="text-right text-[11px] text-muted-foreground/60">{editAbout.length}/{GROUP_ABOUT_MAX}</div>
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-foreground">Private short description <span className="font-normal text-muted-foreground">(members only, encrypted in private groups)</span></span>
                <textarea value={editDescription} maxLength={GROUP_DESCRIPTION_MAX} rows={3} onChange={(e) => setEditDescription(e.target.value)} placeholder="Optional" className={`${field} h-auto py-2 resize-none`} />
                <div className="text-right text-[11px] text-muted-foreground/60">{editDescription.length}/{GROUP_DESCRIPTION_MAX}</div>
              </label>
              <div>
                <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                  <ChevronDown size={14} className={cn('transition-transform', showAdvanced && 'rotate-180')} /> Advanced
                </button>
                {showAdvanced && (
                  <div className="mt-3 pl-1">
                    <PowSection editMinPow={editMinPow} setEditMinPow={setEditMinPow} editJoinMinPow={editJoinMinPow} setEditJoinMinPow={setEditJoinMinPow} />
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              {/* Face */}
              <div>
                <div className="relative">
                  <div className="w-full aspect-[3/1] rounded-lg overflow-hidden bg-secondary/40">
                    <img src={group?.banner || HUB_BANNER_PLACEHOLDER} alt="" className="w-full h-full object-cover" />
                  </div>
                  <Avatar className="absolute left-4 -bottom-7 h-[72px] w-[72px] border-4 border-card shadow-lg">
                    {group?.picture && <AvatarImage src={group.picture} />}
                    <AvatarFallback className="text-lg bg-primary/20 text-primary">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                </div>
                <div className="mt-9 pl-1">
                  <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
                    {isV2 && <Lock size={14} className="text-emerald-400 shrink-0" />}
                    <span className="truncate">{name}</span>
                  </h2>
                  {privateDescription && <p className="mt-1 text-sm text-muted-foreground whitespace-pre-wrap break-words leading-relaxed">{privateDescription}</p>}
                </div>
              </div>

              {/* Members */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-foreground">Members <span className="font-normal font-mono tabular-nums text-muted-foreground/60">{members.length}/{GROUP_MAX_MEMBERS}</span></span>
                  {isCreator && (
                    <button onClick={() => setShowManage(true)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-primary/10 text-primary hover:bg-primary/15 transition-colors cursor-pointer">
                      <UserPlus size={13} /> Add members
                    </button>
                  )}
                </div>
                <div className="rounded-lg border border-border overflow-hidden">
                  <div className={boxHeader}>
                    <Search size={14} className="text-muted-foreground shrink-0" />
                    <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search members" className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 outline-none" />
                  </div>
                  <div className="max-h-64 overflow-y-auto p-2 space-y-0.5">
                    {filtered.length === 0 ? (
                      <p className="px-2 py-3 text-xs text-muted-foreground/70">No matches.</p>
                    ) : filtered.map((m) => {
                      const { p, npub, label } = profileOf(m.pubkey)
                      const isMe = m.pubkey === myPubkey
                      const isOwner = m.pubkey === creatorReal
                      const isRemoving = removing === m.pubkey
                      return (
                        <div key={m.pubkey} className="flex items-center gap-3 px-2.5 py-2 rounded-lg hover:bg-secondary/40">
                          <Avatar className="h-9 w-9 shrink-0">
                            {p?.picture && <AvatarImage src={p.picture} />}
                            <AvatarFallback className="text-xs bg-primary/20 text-primary">{label.slice(0, 2).toUpperCase()}</AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-foreground truncate flex items-center gap-1.5">
                              {label}
                              {isMe && <span className="text-[10px] text-muted-foreground">(you)</span>}
                              {isOwner && <Crown size={11} className="text-amber-400 shrink-0" />}
                            </p>
                            <p className="text-[11px] text-muted-foreground font-mono truncate">{truncateNpub(npub, 6)}</p>
                          </div>
                          {isCreator && !isMe && !isOwner && (
                            confirmRemove === m.pubkey ? (
                              <div className="flex items-center gap-1 shrink-0">
                                <button onClick={() => doRemove(m.pubkey)} disabled={isRemoving} className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 cursor-pointer disabled:opacity-50">
                                  {isRemoving ? <Loader2 size={12} className="animate-spin" /> : 'Confirm remove'}
                                </button>
                                <button onClick={() => setConfirmRemove(null)} disabled={isRemoving} className="px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground cursor-pointer">Cancel</button>
                              </div>
                            ) : (
                              <button onClick={() => setConfirmRemove(m.pubkey)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer shrink-0">
                                <UserMinus size={13} /> Remove
                              </button>
                            )
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
                {isCreator && <p className="text-[11px] text-muted-foreground/70">Removing someone rotates the group secret. They can't read anything after that point.</p>}
              </div>

              {/* Join requests (creator) */}
              {isCreator && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground">Join requests {requests && requests.length > 0 && <span className="font-normal font-mono tabular-nums text-muted-foreground/60">{requests.length}</span>}</span>
                    <div className="flex items-center gap-1.5">
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button onClick={loadRequests} disabled={loadingRequests} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer disabled:opacity-50">
                              <RotateCw size={13} className={cn(loadingRequests && 'animate-spin')} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="z-[300] text-xs">Refresh requests</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <button onClick={approve} disabled={approving || selected.size === 0} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
                        {approving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Add selected{selected.size > 0 ? ` (${selected.size})` : ''}
                      </button>
                    </div>
                  </div>
                  <div className="rounded-lg border border-border overflow-hidden">
                    <div className="max-h-56 overflow-y-auto p-2 space-y-0.5">
                      {requests === null || (loadingRequests && requests.length === 0) ? (
                        <p className="px-2 py-3 text-xs text-muted-foreground/70 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Looking for requests...</p>
                      ) : requests.length === 0 ? (
                        <p className="px-2 py-3 text-xs text-muted-foreground/70">No pending requests. People can request from the group address card.</p>
                      ) : requests.map((r) => {
                        const { p, npub, label } = profileOf(r.pubkey)
                        const on = selected.has(r.pubkey)
                        const hasNote = !!(r.note || r.noteCipher)
                        return (
                          <div key={r.pubkey} className={cn('flex items-center gap-3 px-2.5 py-2 rounded-lg transition-colors', on ? 'bg-primary/10' : 'hover:bg-secondary/40')}>
                            <button onClick={() => toggleSelected(r.pubkey)} className="text-muted-foreground hover:text-foreground cursor-pointer shrink-0">
                              {on ? <CheckSquare size={16} className="text-primary" /> : <Square size={16} />}
                            </button>
                            <Avatar className="h-9 w-9 shrink-0">
                              {p?.picture && <AvatarImage src={p.picture} />}
                              <AvatarFallback className="text-xs bg-primary/20 text-primary">{label.slice(0, 2).toUpperCase()}</AvatarFallback>
                            </Avatar>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-foreground truncate">{label}</p>
                              <p className="text-[11px] text-muted-foreground font-mono truncate">{truncateNpub(npub, 6)} · {new Date(r.createdAt * 1000).toLocaleDateString()}{r.powBits > 0 ? ` · PoW ${r.powBits}` : ''}</p>
                            </div>
                            {hasNote && (
                              <button onClick={() => openNote(r)} className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer shrink-0">
                                <MessageSquareText size={12} /> Note
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* Dangerous */}
              <div>
                <button type="button" onClick={() => setShowDanger(!showDanger)} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-destructive transition-colors cursor-pointer">
                  <ChevronDown size={14} className={cn('transition-transform', showDanger && 'rotate-180')} /> Dangerous
                </button>
                {showDanger && (
                  <div className="mt-3 flex items-start justify-between gap-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3">
                    {isCreator ? (
                      <>
                        <p className="text-xs text-muted-foreground leading-relaxed">Request deletion of this group. The group event is replaced by a tombstone and a deletion request is sent to its relays. Members keep whatever they already have.</p>
                        <button onClick={() => setShowDelete(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 cursor-pointer shrink-0">
                          <Trash2 size={13} /> Request delete
                        </button>
                      </>
                    ) : (
                      <>
                        <p className="text-xs text-muted-foreground leading-relaxed">Leave this group. It is removed from your list. Only the creator can remove your key from the member tree.</p>
                        <button onClick={() => setShowLeave(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 cursor-pointer shrink-0">
                          <LogOut size={13} /> Leave group
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" /> {error}
            </div>
          )}
        </div>

        {editing && (
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
            <button onClick={() => { setEditing(false); setError(null) }} disabled={saving} className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer">Cancel</button>
            <button onClick={save} disabled={saving || face.uploading} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
              {saving && <Loader2 size={11} className="animate-spin" />} Publish
            </button>
          </div>
        )}
      </div>

      {/* Join note viewer */}
      {noteView && (
        <div className="fixed inset-0 z-[260] flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm" onClick={() => setNoteView(null)}>
          <div className="w-full max-w-[400px] bg-card border border-border rounded-xl shadow-2xl p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h4 className="text-sm font-semibold text-foreground">Note from {profileOf(noteView.pubkey).label}</h4>
            {noteView.loading ? (
              <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Decrypting...</p>
            ) : noteView.text ? (
              <p className="text-sm text-foreground whitespace-pre-wrap break-words leading-relaxed">{noteView.text}</p>
            ) : (
              <p className="text-xs text-muted-foreground">The note could not be read.</p>
            )}
            <div className="flex justify-end"><button onClick={() => setNoteView(null)} className="px-3 py-1.5 rounded-lg bg-secondary text-foreground text-sm font-medium hover:bg-secondary/80 cursor-pointer">Close</button></div>
          </div>
        </div>
      )}

      {showManage && <GroupMembersModal dTag={dTag} onClose={() => setShowManage(false)} />}
      {showDelete && <ConfirmDeleteGroupModal dTag={dTag} onClose={() => setShowDelete(false)} onDone={onClose} />}
      {showLeave && <ConfirmLeaveGroupModal dTag={dTag} onClose={() => setShowLeave(false)} onDone={onClose} />}
    </div>,
    document.body,
  )
}
