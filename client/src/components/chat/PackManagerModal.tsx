/**
 * PackManagerModal — one roomy place to manage your emoji, sticker and GIF packs.
 *
 * The pickers' "Mine" tabs are for browsing and inserting; all creating, renaming, adding and deleting
 * lives here instead, so those surfaces stay uncluttered. A left nav switches between Emojis, Stickers
 * and GIFs; each section lists your packs collapsed by default (name + count), expanding to a row of
 * Rename / Add / Delete actions and one full-width row per item. Everything reuses the same publish,
 * upload, rename and delete logic the pickers already used, so nothing about how packs are stored changes.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Smile, Sticker, Film, FolderPlus, Plus, Pencil, Trash2, ChevronDown, ChevronUp, Loader2, AlertTriangle } from 'lucide-react'
import { useEscToClose } from '@/hooks/useEscToClose'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { RenamePackModal } from '@/components/chat/RenamePackModal'
import { EmojiUploadForm } from '@/components/chat/EmojiPickerPopover'
import { useUserStore } from '@/stores/userStore'
import { useEmojiStore } from '@/stores/emojiStore'
import { publishEmojiSet, deleteEmojiSet } from '@/lib/nostr/customEmoji'

export type PackKind = 'emoji' | 'sticker' | 'gif'

const NAV: { id: PackKind; label: string; icon: typeof Smile }[] = [
  { id: 'emoji', label: 'Emojis', icon: Smile },
  { id: 'sticker', label: 'Stickers', icon: Sticker },
  { id: 'gif', label: 'GIFs', icon: Film },
]

const sanitizeShortcode = (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()

export function PackManagerModal({ open, onClose, initialSection = 'emoji' }: {
  open: boolean
  onClose: () => void
  initialSection?: PackKind
}) {
  useEscToClose(onClose, open)
  const [section, setSection] = useState<PackKind>(initialSection)
  useEffect(() => { if (open) setSection(initialSection) }, [open, initialSection])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[320] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-[640px] max-h-[85vh] bg-card rounded-2xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200 flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h3 className="text-base font-semibold text-foreground">Manage packs</h3>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer">
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Left nav */}
          <div className="w-32 shrink-0 border-r border-border p-2 flex flex-col gap-1">
            {NAV.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setSection(id)}
                className={`flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm transition-colors cursor-pointer ${
                  section === id ? 'bg-secondary text-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                }`}
              >
                <Icon size={16} /> {label}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0 overflow-y-auto p-4">
            {section === 'emoji' && <EmojiManageSection />}
            {section === 'sticker' && <ComingSoon label="stickers" />}
            {section === 'gif' && <ComingSoon label="GIFs" />}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function ComingSoon({ label }: { label: string }) {
  return <p className="text-sm text-muted-foreground text-center py-10">Managing {label} moves here next.</p>
}

// ─── Emoji section ───

function EmojiManageSection() {
  const myEmojiSets = useEmojiStore((s) => s.myEmojiSets)
  const updateMyEmojiSet = useEmojiStore((s) => s.updateMyEmojiSet)
  const addMyEmojiSet = useEmojiStore((s) => s.addMyEmojiSet)
  const removeMyEmojiSet = useEmojiStore((s) => s.removeMyEmojiSet)
  const setMyEmojiSets = useEmojiStore((s) => s.setMyEmojiSets)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const pubkey = useUserStore((s) => s.pubkey)

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showNewSet, setShowNewSet] = useState(false)
  const [newSetName, setNewSetName] = useState('')
  const [creating, setCreating] = useState(false)
  const [addTargetDTag, setAddTargetDTag] = useState<string | null>(null)
  const [renameSetDTag, setRenameSetDTag] = useState<string | null>(null)
  const [renameEmoji, setRenameEmoji] = useState<{ setDTag: string; shortcode: string } | null>(null)
  const [deleteSetDTag, setDeleteSetDTag] = useState<string | null>(null)
  const [deletingSet, setDeletingSet] = useState(false)

  const toggle = (dTag: string) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(dTag)) next.delete(dTag); else next.add(dTag)
    return next
  })

  const handleCreateSet = async () => {
    const name = newSetName.trim()
    if (!name || !pubkey || creating) return
    setCreating(true)
    const dTag = crypto.randomUUID()
    try {
      await publishEmojiSet(dTag, name, [], signer, privateKey)
      addMyEmojiSet({ pubkey, dTag, name, emojis: [] })
      setNewSetName('')
      setShowNewSet(false)
      setExpanded((prev) => new Set(prev).add(dTag))
      setAddTargetDTag(dTag)
    } catch (err) {
      console.error('Failed to create emoji set:', err)
    } finally {
      setCreating(false)
    }
  }

  const renameSet = myEmojiSets.find((s) => s.dTag === renameSetDTag)
  const handleRenameSet = async (name: string) => {
    if (!renameSet) return
    await publishEmojiSet(renameSet.dTag, name, renameSet.emojis, signer, privateKey)
    setMyEmojiSets(useEmojiStore.getState().myEmojiSets.map((s) => (s.dTag === renameSet.dTag ? { ...s, name } : s)))
  }

  const renameEmojiSet = renameEmoji ? myEmojiSets.find((s) => s.dTag === renameEmoji.setDTag) : null
  const handleRenameEmoji = async (newShortcode: string) => {
    if (!renameEmoji || !renameEmojiSet) return
    const sc = sanitizeShortcode(newShortcode).slice(0, 60)
    if (!sc) throw new Error('Enter a name')
    const newEmojis = renameEmojiSet.emojis.map((e) => e.shortcode === renameEmoji.shortcode ? { ...e, shortcode: sc } : e)
    await publishEmojiSet(renameEmoji.setDTag, renameEmojiSet.name, newEmojis, signer, privateKey)
    updateMyEmojiSet(renameEmoji.setDTag, newEmojis)
  }

  const handleDeleteEmoji = async (setDTag: string, shortcode: string) => {
    const set = myEmojiSets.find((s) => s.dTag === setDTag)
    if (!set) return
    const newEmojis = set.emojis.filter((e) => e.shortcode !== shortcode)
    try {
      await publishEmojiSet(setDTag, set.name, newEmojis, signer, privateKey)
      updateMyEmojiSet(setDTag, newEmojis)
    } catch (err) {
      console.error('Failed to delete emoji:', err)
    }
  }

  const deleteSet = myEmojiSets.find((s) => s.dTag === deleteSetDTag)
  const handleDeleteSet = async () => {
    if (!deleteSetDTag || deletingSet) return
    setDeletingSet(true)
    try {
      await deleteEmojiSet(deleteSetDTag, signer, privateKey)
      removeMyEmojiSet(deleteSetDTag)
      setDeleteSetDTag(null)
    } catch (err) {
      console.error('Failed to delete emoji set:', err)
    } finally {
      setDeletingSet(false)
    }
  }
  useEscToClose(() => setDeleteSetDTag(null), !!deleteSetDTag && !deletingSet)

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">Your emoji sets</span>
        <button
          onClick={() => { setShowNewSet((v) => !v); setNewSetName('') }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-[13px] font-medium text-foreground hover:bg-secondary/60 transition-colors cursor-pointer"
        >
          <FolderPlus size={15} /> New set
        </button>
      </div>

      {/* New set inline form */}
      {showNewSet && (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-secondary/20 p-2.5">
          <input
            value={newSetName}
            onChange={(e) => setNewSetName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateSet() }}
            placeholder="Set name"
            autoFocus
            className="flex-1 h-9 px-3 rounded-lg bg-background border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40"
          />
          <button
            onClick={handleCreateSet}
            disabled={!newSetName.trim() || creating}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-primary text-primary-foreground text-[13px] font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating && <Loader2 size={13} className="animate-spin" />} Create
          </button>
        </div>
      )}

      {myEmojiSets.length === 0 && !showNewSet && (
        <p className="text-sm text-muted-foreground text-center py-8">No emoji sets yet. Create one to get started.</p>
      )}

      {/* Packs */}
      {myEmojiSets.map((set) => {
        const isOpen = expanded.has(set.dTag)
        return (
          <div key={set.dTag} className="rounded-xl border border-border overflow-hidden">
            {/* Pack header */}
            <button
              onClick={() => toggle(set.dTag)}
              className="flex items-center gap-2 w-full px-3.5 py-3 text-left cursor-pointer hover:bg-secondary/30 transition-colors"
            >
              <span className="text-sm font-medium text-foreground truncate">{set.name}</span>
              <span className="text-xs text-muted-foreground shrink-0">({set.emojis.length} emoji{set.emojis.length !== 1 ? 's' : ''})</span>
              {isOpen ? <ChevronUp size={17} className="ml-auto text-muted-foreground shrink-0" /> : <ChevronDown size={17} className="ml-auto text-muted-foreground shrink-0" />}
            </button>

            {isOpen && (
              <div className="border-t border-border">
                {/* Action row */}
                <div className="flex flex-wrap gap-2 px-3.5 py-2.5">
                  <button onClick={() => setRenameSetDTag(set.dTag)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border text-xs text-foreground hover:bg-secondary/60 transition-colors cursor-pointer">
                    <Pencil size={14} /> Rename
                  </button>
                  <button onClick={() => setAddTargetDTag((v) => v === set.dTag ? null : set.dTag)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-primary/40 text-xs text-primary hover:bg-primary/10 transition-colors cursor-pointer">
                    <Plus size={14} /> Add emoji
                  </button>
                  <button onClick={() => setDeleteSetDTag(set.dTag)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-destructive/40 text-xs text-destructive hover:bg-destructive/10 transition-colors cursor-pointer">
                    <Trash2 size={14} /> Delete
                  </button>
                </div>

                {/* Add form */}
                {addTargetDTag === set.dTag && (
                  <div className="border-t border-border">
                    <EmojiUploadForm
                      sets={myEmojiSets}
                      targetSet={set.dTag}
                      onTargetChange={setAddTargetDTag}
                      onDone={() => setAddTargetDTag(null)}
                    />
                  </div>
                )}

                {/* Item rows */}
                {set.emojis.length === 0 ? (
                  <p className="text-xs text-muted-foreground px-3.5 py-3 border-t border-border">This set is empty. Use Add emoji above.</p>
                ) : (
                  <div className="border-t border-border">
                    {set.emojis.map((e) => (
                      <div key={e.shortcode} className="flex items-center gap-3 px-3.5 py-2 border-b border-border last:border-b-0">
                        <div className="w-9 h-9 rounded-md bg-secondary/40 flex items-center justify-center shrink-0">
                          <BlossomImage src={e.url} alt={`:${e.shortcode}:`} className="w-7 h-7" contain />
                        </div>
                        <span className="flex-1 text-sm text-foreground truncate min-w-0">:{e.shortcode}:</span>
                        <button onClick={() => setRenameEmoji({ setDTag: set.dTag, shortcode: e.shortcode })} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border text-xs text-foreground hover:bg-secondary/60 transition-colors cursor-pointer shrink-0">
                          <Pencil size={13} /> Edit
                        </button>
                        <button onClick={() => handleDeleteEmoji(set.dTag, e.shortcode)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-destructive/40 text-xs text-destructive hover:bg-destructive/10 transition-colors cursor-pointer shrink-0">
                          <Trash2 size={13} /> Delete
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}

      {/* Modals */}
      <RenamePackModal
        open={!!renameSet}
        currentName={renameSet?.name ?? ''}
        kindLabel="emoji set"
        onClose={() => setRenameSetDTag(null)}
        onSave={handleRenameSet}
      />
      <RenamePackModal
        open={!!renameEmoji}
        currentName={renameEmoji?.shortcode ?? ''}
        kindLabel="emoji"
        title="Rename emoji"
        hint="Existing reactions keep their old name; only new ones use this."
        transform={sanitizeShortcode}
        validate={(v) => (renameEmojiSet?.emojis.some((e) => e.shortcode === v && e.shortcode !== renameEmoji?.shortcode) ? 'That name is already used in this set' : null)}
        onClose={() => setRenameEmoji(null)}
        onSave={handleRenameEmoji}
      />

      {/* Delete set confirmation */}
      {deleteSetDTag && createPortal(
        <div className="fixed inset-0 z-[330] flex items-center justify-center p-4" onClick={() => !deletingSet && setDeleteSetDTag(null)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative z-10 w-full max-w-[380px] bg-card rounded-xl border border-border shadow-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle size={16} className="text-destructive" />
              <h4 className="text-sm font-semibold text-foreground">Delete emoji set</h4>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              This sends a deletion request for <strong>"{deleteSet?.name || deleteSetDTag}"</strong> to the relays. Deletion is not guaranteed; some relays may keep a copy.
            </p>
            <div className="flex items-center justify-end gap-2 mt-4">
              <button onClick={() => setDeleteSetDTag(null)} disabled={deletingSet} className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer disabled:opacity-50">Cancel</button>
              <button onClick={handleDeleteSet} disabled={deletingSet} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-destructive text-white hover:bg-destructive/90 transition-colors cursor-pointer disabled:opacity-50">
                {deletingSet && <Loader2 size={12} className="animate-spin" />} Delete
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
