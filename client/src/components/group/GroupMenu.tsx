/**
 * GroupMenu: the "…" options for a group: copy the address, view the raw event. Editing, deleting and
 * leaving live in GroupDetailsModal (opened from the header). The two confirmation modals are
 * exported from here for it. House dropdown style (rounded-xl, p-1, rounded-md items).
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Check, Loader2, AlertTriangle, FileJson } from 'lucide-react'
import { RawEventModal } from '@/components/hub/ChannelView'
import { useEscToClose } from '@/hooks/useEscToClose'
import { useHubStore } from '@/stores/hubStore'
import { useGroupStore } from '@/stores/groupStore'
import { groupInviteAddress, deleteGroup, leaveGroup } from '@/lib/group/groupOps'

export function GroupMenu({ dTag, anchorRef, onClose }: {
  dTag: string
  anchorRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const group = useGroupStore((s) => s.groups[dTag])
  const rawEvent = useGroupStore((s) => s.rawEvents[dTag])
  const menuRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const [showRaw, setShowRaw] = useState(false)

  useEffect(() => {
    if (showRaw) return
    const handler = (e: MouseEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || anchorRef.current?.contains(t)) return
      onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, anchorRef, showRaw])

  const copyInvite = () => {
    if (!group) return
    navigator.clipboard.writeText(groupInviteAddress(group)).then(() => {
      setCopied(true)
      setTimeout(() => { setCopied(false); onClose() }, 900)
    }).catch(() => {})
  }

  if (showRaw && rawEvent) {
    return <RawEventModal rawJson={JSON.stringify(rawEvent)} decryptedContent="" isDecrypted={false} hideDecryptedTab onClose={() => { setShowRaw(false); onClose() }} />
  }

  const item = 'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-left text-foreground hover:bg-secondary/60 transition-colors cursor-pointer'
  return (
    <div ref={menuRef} className="absolute right-3 top-14 z-50 w-52 rounded-xl border border-border bg-popover shadow-xl p-1">
      <button onClick={copyInvite} className={item}>
        {copied ? <Check size={13} className="text-green-500" /> : <Copy size={13} />} {copied ? 'Copied group address' : 'Copy group address'}
      </button>
      {rawEvent && (
        <button onClick={() => setShowRaw(true)} className={item}>
          <FileJson size={13} /> View raw event
        </button>
      )}
    </div>
  )
}

/* ─── Delete (creator): tombstone + NIP-09 request, typed confirmation ─── */

export function ConfirmDeleteGroupModal({ dTag, onClose, onDone }: { dTag: string; onClose: () => void; onDone?: () => void }) {
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
    try { await deleteGroup(dTag); onClose(); onDone?.() } catch (err) { setError(err instanceof Error ? err.message : 'Failed to delete'); setBusy(false) }
  }

  return createPortal(
    <div className="fixed inset-0 z-[250] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[400px] mx-4 bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200">
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

export function ConfirmLeaveGroupModal({ dTag, onClose, onDone }: { dTag: string; onClose: () => void; onDone?: () => void }) {
  useEscToClose(onClose, true)
  const hub = useHubStore((s) => s.hubs[dTag])
  const [busy, setBusy] = useState(false)
  const run = async () => { setBusy(true); try { await leaveGroup(dTag) } finally { onClose(); onDone?.() } }
  return createPortal(
    <div className="fixed inset-0 z-[250] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[380px] mx-4 bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200">
        <div className="px-5 py-4 border-b border-border"><h3 className="text-sm font-semibold text-foreground">Leave {hub?.name || 'this group'}?</h3></div>
        <div className="px-5 py-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            The group is removed from your list. Only the creator can remove your key from the member tree, so you'd still be
            able to rejoin with the group address until they do.
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
