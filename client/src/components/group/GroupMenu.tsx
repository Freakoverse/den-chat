/**
 * GroupMenu: the "…" options for a group: copy the invite address, edit (creator), delete
 * (creator, typed confirmation), leave (member). House dropdown style (rounded-xl, p-1, rounded-md items).
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Check, Pencil, Trash2, LogOut, Loader2, X, AlertTriangle } from 'lucide-react'
import { useEscToClose } from '@/hooks/useEscToClose'
import { useHubStore } from '@/stores/hubStore'
import { useGroupStore } from '@/stores/groupStore'
import { groupInviteAddress, deleteGroup, leaveGroup, updateGroup } from '@/lib/group/groupOps'
import { GROUP_NAME_MAX, GROUP_ABOUT_MAX, GROUP_DESCRIPTION_MAX } from '@/lib/group/groupEvent'

export function GroupMenu({ dTag, isCreator, anchorRef, onClose }: {
  dTag: string
  isCreator: boolean
  anchorRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const group = useGroupStore((s) => s.groups[dTag])
  const menuRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [showLeave, setShowLeave] = useState(false)

  useEffect(() => {
    if (showEdit || showDelete || showLeave) return
    const handler = (e: MouseEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || anchorRef.current?.contains(t)) return
      onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, anchorRef, showEdit, showDelete, showLeave])

  const copyInvite = () => {
    if (!group) return
    navigator.clipboard.writeText(groupInviteAddress(group)).then(() => {
      setCopied(true)
      setTimeout(() => { setCopied(false); onClose() }, 900)
    }).catch(() => {})
  }

  const item = 'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-left transition-colors cursor-pointer'

  if (showEdit && group) return <EditGroupModal dTag={dTag} onClose={() => { setShowEdit(false); onClose() }} />
  if (showDelete && group) return <ConfirmDeleteGroupModal dTag={dTag} onClose={() => { setShowDelete(false); onClose() }} />
  if (showLeave && group) return <ConfirmLeaveGroupModal dTag={dTag} onClose={() => { setShowLeave(false); onClose() }} />

  return (
    <div ref={menuRef} className="absolute right-3 top-14 z-50 w-52 rounded-xl border border-border bg-popover shadow-xl p-1">
      <button onClick={copyInvite} className={`${item} text-foreground hover:bg-secondary/60`}>
        {copied ? <Check size={13} className="text-green-500" /> : <Copy size={13} />} {copied ? 'Copied invite address' : 'Copy invite address'}
      </button>
      {isCreator ? (
        <>
          <button onClick={() => setShowEdit(true)} className={`${item} text-foreground hover:bg-secondary/60`}>
            <Pencil size={13} /> Edit group
          </button>
          <button onClick={() => setShowDelete(true)} className={`${item} text-destructive hover:bg-destructive/10`}>
            <Trash2 size={13} /> Delete group…
          </button>
        </>
      ) : (
        <button onClick={() => setShowLeave(true)} className={`${item} text-destructive hover:bg-destructive/10`}>
          <LogOut size={13} /> Leave group…
        </button>
      )}
    </div>
  )
}

/* ─── Edit ─── */

function EditGroupModal({ dTag, onClose }: { dTag: string; onClose: () => void }) {
  useEscToClose(onClose, true)
  const hub = useHubStore((s) => s.hubs[dTag])
  const group = useGroupStore((s) => s.groups[dTag])
  const [name, setName] = useState(hub?.name ?? '')
  const [about, setAbout] = useState(group?.about ?? '')
  const [description, setDescription] = useState(hub?.description && hub.description !== group?.about ? hub.description : '')
  const [picture, setPicture] = useState(group?.picture ?? '')
  const [banner, setBanner] = useState(group?.banner ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (!name.trim()) { setError('Name is required'); return }
    setSaving(true); setError(null)
    try {
      await updateGroup(dTag, { name: name.trim(), about: about.trim(), description: description.trim(), picture: picture.trim(), banner: banner.trim() })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
      setSaving(false)
    }
  }

  const field = 'w-full h-9 px-3 rounded-lg bg-secondary/40 border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary/40'

  return createPortal(
    <div className="fixed inset-0 z-[250] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-[440px] mx-4 bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">Edit group</h3>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">Name</span>
            <input value={name} maxLength={GROUP_NAME_MAX} onChange={(e) => setName(e.target.value)} className={field} />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">Short description <span className="text-muted-foreground/60">(public, shown on the invite)</span></span>
            <input value={about} maxLength={GROUP_ABOUT_MAX} onChange={(e) => setAbout(e.target.value)} className={field} />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">Members-only description</span>
            <textarea value={description} maxLength={GROUP_DESCRIPTION_MAX} rows={3} onChange={(e) => setDescription(e.target.value)} className={`${field} h-auto py-2 resize-none`} />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">Icon URL</span>
            <input value={picture} onChange={(e) => setPicture(e.target.value)} placeholder="https://…" className={field} />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">Banner URL</span>
            <input value={banner} onChange={(e) => setBanner(e.target.value)} placeholder="https://…" className={field} />
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer">Cancel</button>
          <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer disabled:opacity-50">
            {saving && <Loader2 size={11} className="animate-spin" />} Publish
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ─── Delete (creator) ─── */

function ConfirmDeleteGroupModal({ dTag, onClose }: { dTag: string; onClose: () => void }) {
  useEscToClose(onClose, true)
  const hub = useHubStore((s) => s.hubs[dTag])
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = hub?.name ?? ''
  const ok = typed.trim() === name.trim() && name.length > 0

  const run = async () => {
    if (!ok) return
    setBusy(true); setError(null)
    try { await deleteGroup(dTag); onClose() } catch (err) { setError(err instanceof Error ? err.message : 'Failed to delete'); setBusy(false) }
  }

  return createPortal(
    <div className="fixed inset-0 z-[250] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-[400px] mx-4 bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><AlertTriangle size={14} className="text-destructive" /> Delete this group?</h3>
        </div>
        <div className="px-5 py-4 space-y-3">
          <p className="text-xs text-muted-foreground leading-relaxed">
            The group event is replaced by a tombstone (the member tree is blanked, so it stops distributing the secret) and a
            deletion request is sent. Members keep whatever they already have locally. This can't be undone.
          </p>
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">Type the group name to confirm: <span className="font-medium text-foreground">{name}</span></span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} className="w-full h-9 px-3 rounded-lg bg-secondary/40 border border-border text-sm text-foreground focus:outline-none focus:border-destructive/40" />
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer">Cancel</button>
          <button onClick={run} disabled={!ok || busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
            {busy && <Loader2 size={11} className="animate-spin" />} Delete group
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ─── Leave (member) ─── */

function ConfirmLeaveGroupModal({ dTag, onClose }: { dTag: string; onClose: () => void }) {
  useEscToClose(onClose, true)
  const hub = useHubStore((s) => s.hubs[dTag])
  const [busy, setBusy] = useState(false)
  const run = async () => { setBusy(true); try { await leaveGroup(dTag) } finally { onClose() } }
  return createPortal(
    <div className="fixed inset-0 z-[250] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-[380px] mx-4 bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border"><h3 className="text-sm font-semibold text-foreground">Leave {hub?.name || 'this group'}?</h3></div>
        <div className="px-5 py-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            The group is removed from your list. Only the creator can remove your key from the member tree, so you'd still be
            able to rejoin with the invite address until they do.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 cursor-pointer">Cancel</button>
          <button onClick={run} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 cursor-pointer disabled:opacity-50">
            {busy && <Loader2 size={11} className="animate-spin" />} Leave
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
