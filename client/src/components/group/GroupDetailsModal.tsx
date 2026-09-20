/**
 * GroupDetailsModal: opened from the group chat header. Shows the banner, picture, name and the
 * members-only description, the member list (searchable, scrolls), an "Add members" button that
 * opens the manage-members modal, and for the creator an Edit mode (face uploads via
 * GroupFaceEditor, name, public + private descriptions) plus a "Dangerous" accordion holding the
 * request-delete action. A non-creator finds "Leave group" under the same accordion.
 */
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { nip19 } from 'nostr-tools'
import { X, Loader2, Pencil, UserPlus, Search, Crown, Lock, ChevronDown, AlertTriangle, Trash2, LogOut } from 'lucide-react'
import { useEscToClose } from '@/hooks/useEscToClose'
import { useHubStore } from '@/stores/hubStore'
import { useGroupStore } from '@/stores/groupStore'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache } from '@/hooks/useProfileCache'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { GroupFaceEditor, type GroupFaceState } from '@/components/group/GroupFaceEditor'
import { GroupMembersModal } from '@/components/group/GroupMembersModal'
import { ConfirmDeleteGroupModal, ConfirmLeaveGroupModal } from '@/components/group/GroupMenu'
import { updateGroup } from '@/lib/group/groupOps'
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

  // Members
  const [search, setSearch] = useState('')
  const [showManage, setShowManage] = useState(false)
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return members
    return members.filter((m) => {
      const p = getProfile(m.pubkey)
      return `${p?.display_name ?? ''} ${p?.name ?? ''} ${p?.nip05 ?? ''}`.toLowerCase().includes(q) || m.pubkey.startsWith(q)
    })
  }, [members, search, getProfile])

  // Edit mode (creator)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editAbout, setEditAbout] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [face, setFace] = useState<GroupFaceState>({ face: { picture: null, banner: null }, uploading: false, overlayOpen: false })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const startEditing = () => {
    setEditName(hub?.name ?? '')
    setEditAbout(group?.about ?? '')
    setEditDescription(privateDescription)
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

  useEscToClose(onClose, !showManage && !showDelete && !showLeave && !face.overlayOpen)

  const field = 'w-full h-9 px-3 rounded-lg bg-secondary/40 border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary/40'

  return createPortal(
    <div className="fixed inset-0 z-[250] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[560px] mx-4 bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200 max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h3 className="text-sm font-semibold text-foreground">{editing ? 'Edit group' : 'Group details'}</h3>
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
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-secondary/30">
                    <Search size={14} className="text-muted-foreground shrink-0" />
                    <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search members" className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 outline-none" />
                  </div>
                  <div className="max-h-64 overflow-y-auto p-2 space-y-0.5">
                    {filtered.length === 0 ? (
                      <p className="px-2 py-3 text-xs text-muted-foreground/70">No matches.</p>
                    ) : filtered.map((m) => {
                      const p = getProfile(m.pubkey)
                      const npub = (() => { try { return nip19.npubEncode(m.pubkey) } catch { return m.pubkey } })()
                      const label = p?.display_name || p?.name || truncateNpub(npub, 10)
                      return (
                        <div key={m.pubkey} className="flex items-center gap-3 px-2.5 py-2 rounded-lg hover:bg-secondary/40">
                          <Avatar className="h-9 w-9 shrink-0">
                            {p?.picture && <AvatarImage src={p.picture} />}
                            <AvatarFallback className="text-xs bg-primary/20 text-primary">{label.slice(0, 2).toUpperCase()}</AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-foreground truncate flex items-center gap-1.5">
                              {label}
                              {m.pubkey === myPubkey && <span className="text-[10px] text-muted-foreground">(you)</span>}
                              {m.pubkey === creatorReal && <Crown size={11} className="text-amber-400 shrink-0" />}
                            </p>
                            <p className="text-[11px] text-muted-foreground font-mono truncate">{truncateNpub(npub, 6)}</p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>

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

      {showManage && <GroupMembersModal dTag={dTag} isCreator={isCreator} onClose={() => setShowManage(false)} />}
      {showDelete && <ConfirmDeleteGroupModal dTag={dTag} onClose={() => setShowDelete(false)} onDone={onClose} />}
      {showLeave && <ConfirmLeaveGroupModal dTag={dTag} onClose={() => setShowLeave(false)} onDone={onClose} />}
    </div>,
    document.body,
  )
}
