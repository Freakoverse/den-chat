/**
 * PackManagerModal — one roomy place to manage your emoji, sticker and GIF packs.
 *
 * The pickers' "Mine" tabs are for browsing and inserting; all creating, renaming, adding and deleting
 * lives here instead, so those surfaces stay uncluttered. A left nav switches between Emojis, Stickers
 * and GIFs; each section lists your packs collapsed by default (name + count), expanding to a row of
 * Rename / Add / Delete actions and one full-width row per item. Everything reuses the same publish,
 * upload, rename and delete logic the pickers already used, so nothing about how packs are stored changes.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Smile, Sticker, Film, FolderPlus, Plus, Pencil, Trash2, ChevronDown, ChevronUp, Loader2, AlertTriangle, Upload, Star, StarOff } from 'lucide-react'
import { useEscToClose } from '@/hooks/useEscToClose'
import { useMobile } from '@/hooks/useMobile'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { RenamePackModal } from '@/components/chat/RenamePackModal'
import { EmojiUploadForm } from '@/components/chat/EmojiPickerPopover'
import { useUserStore } from '@/stores/userStore'
import { useEmojiStore } from '@/stores/emojiStore'
import { useStickerStore, getStickerUploadLimitBytes } from '@/stores/stickerStore'
import { useGifStore, getGifUploadLimitBytes } from '@/stores/gifStore'
import { publishEmojiSet, deleteEmojiSet, publishEmojiSubscriptions } from '@/lib/nostr/customEmoji'
import { publishStickerSet, deleteStickerSet, publishStickerSubscriptions } from '@/lib/nostr/customSticker'
import { publishGifCollection, deleteGifCollection, publishGifSubscriptions, publishGifFavorites } from '@/lib/nostr/customGif'
import { uploadToBlossomServers } from '@/lib/blossom'
import { getUploadBlossoms } from '@/stores/postingBehaviourStore'

export type PackKind = 'emoji' | 'sticker' | 'gif'
export type PackSection = 'mine-emoji' | 'mine-sticker' | 'mine-gif' | 'sub-emoji' | 'sub-sticker' | 'sub-gif' | 'fav-gif'

const NAV_GROUPS: { header: string; items: { id: PackSection; label: string; icon: typeof Smile }[] }[] = [
  { header: 'Mine', items: [
    { id: 'mine-emoji', label: 'Emojis', icon: Smile },
    { id: 'mine-sticker', label: 'Stickers', icon: Sticker },
    { id: 'mine-gif', label: 'GIFs', icon: Film },
  ] },
  { header: 'Subscribed', items: [
    { id: 'sub-emoji', label: 'Emojis', icon: Smile },
    { id: 'sub-sticker', label: 'Stickers', icon: Sticker },
    { id: 'sub-gif', label: 'GIFs', icon: Film },
  ] },
  { header: 'Favorites', items: [
    { id: 'fav-gif', label: 'GIFs', icon: Star },
  ] },
]

const sanitizeShortcode = (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()

export function PackManagerModal({ open, onClose, initialSection = 'mine-emoji' }: {
  open: boolean
  onClose: () => void
  initialSection?: PackSection
}) {
  useEscToClose(onClose, open)
  const isMobile = useMobile()
  const [section, setSection] = useState<PackSection>(initialSection)
  useEffect(() => { if (open) setSection(initialSection) }, [open, initialSection])

  if (!open) return null

  return createPortal(
    <div className={`fixed inset-0 z-[320] flex ${isMobile ? '' : 'items-center justify-center p-4'}`} onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className={`relative z-10 bg-card shadow-2xl animate-in fade-in-0 flex flex-col overflow-hidden ${
          isMobile ? 'w-full h-full rounded-none' : 'w-full max-w-[640px] max-h-[85vh] rounded-2xl border border-border zoom-in-95 duration-200'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-4 border-b border-border shrink-0">
          <h3 className="text-base font-semibold text-foreground">Manage packs</h3>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer">
            <X size={18} />
          </button>
        </div>

        <div className={`flex flex-1 min-h-0 ${isMobile ? 'flex-col' : ''}`}>
          {/* Nav — grouped left rail on desktop, grouped horizontal scroller on mobile */}
          <nav className={`shrink-0 ${isMobile ? 'flex flex-row items-center border-b border-border px-2 py-1.5 gap-2 overflow-x-auto' : 'w-36 flex flex-col border-r border-border p-2 gap-3 overflow-y-auto'}`}>
            {NAV_GROUPS.map((group) => (
              <div key={group.header} className={isMobile ? 'flex items-center gap-1.5 shrink-0' : 'flex flex-col gap-0.5'}>
                <span className={`text-[10px] font-semibold uppercase tracking-wider text-muted-foreground shrink-0 ${isMobile ? 'px-1' : 'px-2.5 pt-1 pb-0.5'}`}>{group.header}</span>
                {group.items.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => setSection(id)}
                    className={`flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm transition-colors cursor-pointer shrink-0 ${
                      section === id ? 'bg-secondary text-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                    }`}
                  >
                    <Icon size={16} /> {label}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          {/* Content */}
          <div className="flex-1 min-w-0 overflow-y-auto p-3 sm:p-4">
            {section === 'mine-emoji' && <EmojiManageSection />}
            {section === 'mine-sticker' && <StickerManageSection />}
            {section === 'mine-gif' && <GifManageSection />}
            {section === 'sub-emoji' && <SubscriptionsSection kind="emoji" />}
            {section === 'sub-sticker' && <SubscriptionsSection kind="sticker" />}
            {section === 'sub-gif' && <SubscriptionsSection kind="gif" />}
            {section === 'fav-gif' && <FavoritesSection />}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ─── Shared bits ───

/** New-set inline form + New set button, shared by all three sections. */
function NewSetControl({ onCreate }: { onCreate: (name: string) => Promise<void> }) {
  const [show, setShow] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const create = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    try { await onCreate(name.trim()); setName(''); setShow(false) } catch (err) { console.error(err) } finally { setBusy(false) }
  }
  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">Your packs</span>
        <button onClick={() => { setShow((v) => !v); setName('') }} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-[13px] font-medium text-foreground hover:bg-secondary/60 transition-colors cursor-pointer">
          <FolderPlus size={15} /> New set
        </button>
      </div>
      {show && (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-secondary/20 p-2.5">
          <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create() }} placeholder="Set name" autoFocus className="flex-1 h-9 px-3 rounded-lg bg-background border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40" />
          <button onClick={create} disabled={!name.trim() || busy} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-primary text-primary-foreground text-[13px] font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
            {busy && <Loader2 size={13} className="animate-spin" />} Create
          </button>
        </div>
      )}
    </>
  )
}

/** Rename / Add / Delete action row inside an expanded pack. On mobile the three buttons grow to fill
 *  the row; on desktop Delete is pushed to the right. */
function PackActionRow({ addLabel, onRename, onAdd, onDelete }: { addLabel: string; onRename: () => void; onAdd: () => void; onDelete: () => void }) {
  const isMobile = useMobile()
  const grow = isMobile ? 'flex-1 justify-center' : ''
  return (
    <div className="flex items-center gap-2 px-3.5 py-2.5">
      <button onClick={onRename} className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border text-xs text-foreground hover:bg-secondary/60 transition-colors cursor-pointer ${grow}`}><Pencil size={14} /> Rename</button>
      <button onClick={onAdd} className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-primary/40 text-xs text-primary hover:bg-primary/10 transition-colors cursor-pointer ${grow}`}><Plus size={14} /> {addLabel}</button>
      <button onClick={onDelete} className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-destructive/40 text-xs text-destructive hover:bg-destructive/10 transition-colors cursor-pointer ${isMobile ? 'flex-1 justify-center' : 'ml-auto'}`}><Trash2 size={14} /> Delete</button>
    </div>
  )
}

/** A confirm dialog for deleting a pack, shared by all sections. */
function DeleteSetDialog({ name, busy, onCancel, onConfirm }: { name: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  useEscToClose(onCancel, !busy)
  return createPortal(
    <div className="fixed inset-0 z-[330] flex items-center justify-center p-4" onClick={() => !busy && onCancel()}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-[380px] bg-card rounded-xl border border-border shadow-2xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-2"><AlertTriangle size={16} className="text-destructive" /><h4 className="text-sm font-semibold text-foreground">Delete pack</h4></div>
        <p className="text-xs text-muted-foreground leading-relaxed">This sends a deletion request for <strong>"{name}"</strong> to the relays. Deletion is not guaranteed; some relays may keep a copy.</p>
        <div className="flex items-center justify-end gap-2 mt-4">
          <button onClick={onCancel} disabled={busy} className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer disabled:opacity-50">Cancel</button>
          <button onClick={onConfirm} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-destructive text-white hover:bg-destructive/90 transition-colors cursor-pointer disabled:opacity-50">{busy && <Loader2 size={12} className="animate-spin" />} Delete</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Single-file uploader used by the sticker and GIF Add flows (emoji reuses EmojiUploadForm). */
function PackAddForm({ limitBytes, namePlaceholder, sanitize, onUpload, onDone }: {
  limitBytes: number
  namePlaceholder: string
  sanitize?: (v: string) => string
  onUpload: (item: { url: string; name: string; nsfw: boolean }) => Promise<void>
  onDone: () => void
}) {
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [nsfw, setNsfw] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  const pick = (f?: File) => {
    if (!f) return
    setError(null)
    if (f.size > limitBytes) { setError(`File too large. Max ${(limitBytes / 1024 / 1024).toFixed(0)} MB`); return }
    if (!f.type.startsWith('image/')) { setError('Only image files are allowed'); return }
    setFile(f); setPreview(URL.createObjectURL(f))
    if (!name.trim()) { const base = f.name.replace(/\.[^.]+$/, ''); setName(sanitize ? sanitize(base) : base) }
  }

  const upload = async () => {
    if (!file || !name.trim() || uploading) return
    setUploading(true); setError(null)
    try {
      const data = new Uint8Array(await file.arrayBuffer())
      const { hash, serverUrls } = await uploadToBlossomServers(data, signer, privateKey, getUploadBlossoms(), file.type)
      const ext = file.type.split('/')[1]?.split('+')[0] || 'png'
      const url = `${serverUrls[0] || 'https://blossom.primal.net'}/${hash}.${ext}`
      await onUpload({ url, name: (sanitize ? sanitize(name) : name.trim()).slice(0, 60), nsfw })
      setFile(null); setPreview(null); setName(''); setNsfw(false); onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally { setUploading(false) }
  }

  return (
    <div className="border-t border-border p-3 space-y-2 bg-secondary/15">
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
      {!file ? (
        <button onClick={() => fileRef.current?.click()} className="w-full flex items-center justify-center gap-2 h-14 rounded-lg border border-dashed border-border text-sm text-muted-foreground hover:bg-secondary/40 transition-colors cursor-pointer">
          <Upload size={16} /> Choose an image
        </button>
      ) : (
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-md bg-secondary/40 flex items-center justify-center shrink-0 overflow-hidden">
            {preview && <img src={preview} alt="" className="max-w-full max-h-full object-contain" />}
          </div>
          <input value={name} onChange={(e) => setName(sanitize ? sanitize(e.target.value) : e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') upload() }} placeholder={namePlaceholder} className="flex-1 h-9 px-3 rounded-lg bg-background border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40" />
          <button onClick={() => setNsfw((v) => !v)} className={`px-2 py-1.5 rounded-lg text-[11px] font-bold border transition-colors cursor-pointer shrink-0 ${nsfw ? 'text-red-400 bg-red-400/10 border-red-400/40' : 'text-muted-foreground hover:text-foreground border-border'}`}>NSFW</button>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {file && (
        <div className="flex items-center justify-end gap-2">
          <button onClick={() => { setFile(null); setPreview(null) }} disabled={uploading} className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer disabled:opacity-50">Clear</button>
          <button onClick={upload} disabled={!name.trim() || uploading} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
            {uploading && <Loader2 size={12} className="animate-spin" />} Upload
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Sticker section (taller rows, stacked buttons) ───

function StickerManageSection() {
  const mySets = useStickerStore((s) => s.myStickerSets)
  const updateSet = useStickerStore((s) => s.updateMyStickerSet)
  const addSet = useStickerStore((s) => s.addMyStickerSet)
  const removeSet = useStickerStore((s) => s.removeMyStickerSet)
  const setSets = useStickerStore((s) => s.setMyStickerSets)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const pubkey = useUserStore((s) => s.pubkey)

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [addTarget, setAddTarget] = useState<string | null>(null)
  const [renameSetDTag, setRenameSetDTag] = useState<string | null>(null)
  const [renameItem, setRenameItem] = useState<{ dTag: string; shortcode: string } | null>(null)
  const [deleteDTag, setDeleteDTag] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const toggle = (d: string) => setExpanded((p) => { const n = new Set(p); n.has(d) ? n.delete(d) : n.add(d); return n })

  const createSet = async (name: string) => {
    if (!pubkey) return
    const dTag = crypto.randomUUID()
    await publishStickerSet(dTag, name, [], signer, privateKey)
    addSet({ pubkey, dTag, name, stickers: [] })
    setExpanded((p) => new Set(p).add(dTag)); setAddTarget(dTag)
  }
  const renameSet = mySets.find((s) => s.dTag === renameSetDTag)
  const onRenameSet = async (name: string) => {
    if (!renameSet) return
    await publishStickerSet(renameSet.dTag, name, renameSet.stickers, signer, privateKey)
    setSets(useStickerStore.getState().myStickerSets.map((s) => s.dTag === renameSet.dTag ? { ...s, name } : s))
  }
  const renameItemSet = renameItem ? mySets.find((s) => s.dTag === renameItem.dTag) : null
  const onRenameItem = async (v: string) => {
    if (!renameItem || !renameItemSet) return
    const sc = sanitizeShortcode(v).slice(0, 60); if (!sc) throw new Error('Enter a name')
    const updated = renameItemSet.stickers.map((s) => s.shortcode === renameItem.shortcode ? { ...s, shortcode: sc } : s)
    await publishStickerSet(renameItem.dTag, renameItemSet.name, updated, signer, privateKey)
    updateSet(renameItem.dTag, updated)
  }
  const onDeleteItem = async (dTag: string, shortcode: string) => {
    const set = mySets.find((s) => s.dTag === dTag); if (!set) return
    const updated = set.stickers.filter((s) => s.shortcode !== shortcode)
    await publishStickerSet(dTag, set.name, updated, signer, privateKey); updateSet(dTag, updated)
  }
  const deleteSet = mySets.find((s) => s.dTag === deleteDTag)
  const onDeleteSet = async () => {
    if (!deleteDTag || deleting) return
    setDeleting(true)
    try { await deleteStickerSet(deleteDTag, signer, privateKey); removeSet(deleteDTag); setDeleteDTag(null) } catch (err) { console.error(err) } finally { setDeleting(false) }
  }

  return (
    <div className="space-y-3">
      <NewSetControl onCreate={createSet} />
      {mySets.length === 0 && <p className="text-sm text-muted-foreground text-center py-8">No sticker sets yet. Create one to get started.</p>}
      {mySets.map((set) => {
        const isOpen = expanded.has(set.dTag)
        return (
          <div key={set.dTag} className="rounded-xl border border-border overflow-hidden">
            <button onClick={() => toggle(set.dTag)} className="flex items-center gap-2 w-full px-3.5 py-3 text-left cursor-pointer hover:bg-secondary/30 transition-colors">
              <span className="text-sm font-medium text-foreground truncate">{set.name}</span>
              <span className="text-xs text-muted-foreground shrink-0">({set.stickers.length} sticker{set.stickers.length !== 1 ? 's' : ''})</span>
              {isOpen ? <ChevronUp size={17} className="ml-auto text-muted-foreground shrink-0" /> : <ChevronDown size={17} className="ml-auto text-muted-foreground shrink-0" />}
            </button>
            {isOpen && (
              <div className="border-t border-border">
                <PackActionRow addLabel="Add sticker" onRename={() => setRenameSetDTag(set.dTag)} onAdd={() => setAddTarget((v) => v === set.dTag ? null : set.dTag)} onDelete={() => setDeleteDTag(set.dTag)} />
                {addTarget === set.dTag && (
                  <PackAddForm limitBytes={getStickerUploadLimitBytes()} namePlaceholder="sticker_name" sanitize={sanitizeShortcode}
                    onUpload={async ({ url, name, nsfw }) => { const updated = [...set.stickers, { shortcode: name, url, nsfw, tagged: true }]; await publishStickerSet(set.dTag, set.name, updated, signer, privateKey); updateSet(set.dTag, updated) }}
                    onDone={() => setAddTarget(null)} />
                )}
                {set.stickers.length === 0 ? (
                  <p className="text-xs text-muted-foreground px-3.5 py-3 border-t border-border">This set is empty. Use Add sticker above.</p>
                ) : (
                  <div className="border-t border-border">
                    {set.stickers.map((s) => (
                      <div key={s.shortcode} className="flex items-center gap-3 px-3.5 py-2.5 border-b border-border last:border-b-0">
                        <div className="w-14 h-14 rounded-md bg-secondary/40 flex items-center justify-center shrink-0">
                          <BlossomImage src={s.url} alt={`:${s.shortcode}:`} className="w-12 h-12" contain />
                        </div>
                        <span className="flex-1 text-sm text-foreground truncate min-w-0">:{s.shortcode}:</span>
                        <div className="flex flex-col gap-1.5 shrink-0">
                          <button onClick={() => setRenameItem({ dTag: set.dTag, shortcode: s.shortcode })} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border text-xs text-foreground hover:bg-secondary/60 transition-colors cursor-pointer"><Pencil size={13} /> <span className="hidden sm:inline">Edit</span></button>
                          <button onClick={() => onDeleteItem(set.dTag, s.shortcode)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-destructive/40 text-xs text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"><Trash2 size={13} /> <span className="hidden sm:inline">Delete</span></button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
      <RenamePackModal open={!!renameSet} currentName={renameSet?.name ?? ''} kindLabel="sticker set" onClose={() => setRenameSetDTag(null)} onSave={onRenameSet} />
      <RenamePackModal open={!!renameItem} currentName={renameItem?.shortcode ?? ''} kindLabel="sticker" title="Rename sticker" hint="Already-sent stickers keep working; only new uses take the new name." transform={sanitizeShortcode}
        validate={(v) => (renameItemSet?.stickers.some((s) => s.shortcode === v && s.shortcode !== renameItem?.shortcode) ? 'That name is already used in this set' : null)}
        onClose={() => setRenameItem(null)} onSave={onRenameItem} />
      {deleteDTag && <DeleteSetDialog name={deleteSet?.name || deleteDTag} busy={deleting} onCancel={() => setDeleteDTag(null)} onConfirm={onDeleteSet} />}
    </div>
  )
}

// ─── GIF section (biggest rows, stacked buttons, free-text names) ───

function GifManageSection() {
  const myCols = useGifStore((s) => s.myGifCollections)
  const updateCol = useGifStore((s) => s.updateMyGifCollection)
  const addCol = useGifStore((s) => s.addMyGifCollection)
  const removeCol = useGifStore((s) => s.removeMyGifCollection)
  const setCols = useGifStore((s) => s.setMyGifCollections)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const pubkey = useUserStore((s) => s.pubkey)

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [addTarget, setAddTarget] = useState<string | null>(null)
  const [renameColDTag, setRenameColDTag] = useState<string | null>(null)
  const [renameGifUrl, setRenameGifUrl] = useState<{ dTag: string; url: string } | null>(null)
  const [deleteDTag, setDeleteDTag] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const toggle = (d: string) => setExpanded((p) => { const n = new Set(p); n.has(d) ? n.delete(d) : n.add(d); return n })

  const createCol = async (name: string) => {
    if (!pubkey) return
    const dTag = crypto.randomUUID()
    await publishGifCollection(dTag, name, [], signer, privateKey)
    addCol({ pubkey, dTag, name, gifs: [] })
    setExpanded((p) => new Set(p).add(dTag)); setAddTarget(dTag)
  }
  const renameCol = myCols.find((c) => c.dTag === renameColDTag)
  const onRenameCol = async (name: string) => {
    if (!renameCol) return
    await publishGifCollection(renameCol.dTag, name, renameCol.gifs, signer, privateKey)
    setCols(useGifStore.getState().myGifCollections.map((c) => c.dTag === renameCol.dTag ? { ...c, name } : c))
  }
  const renameGifCol = renameGifUrl ? myCols.find((c) => c.dTag === renameGifUrl.dTag) : null
  const onRenameGif = async (v: string) => {
    if (!renameGifUrl || !renameGifCol) return
    const nm = v.trim().slice(0, 60); if (!nm) throw new Error('Enter a name')
    const updated = renameGifCol.gifs.map((g) => g.url === renameGifUrl.url ? { ...g, name: nm } : g)
    await publishGifCollection(renameGifUrl.dTag, renameGifCol.name, updated, signer, privateKey)
    updateCol(renameGifUrl.dTag, updated)
  }
  const onDeleteGif = async (dTag: string, url: string) => {
    const col = myCols.find((c) => c.dTag === dTag); if (!col) return
    const updated = col.gifs.filter((g) => g.url !== url)
    await publishGifCollection(dTag, col.name, updated, signer, privateKey); updateCol(dTag, updated)
  }
  const deleteCol = myCols.find((c) => c.dTag === deleteDTag)
  const onDeleteCol = async () => {
    if (!deleteDTag || deleting) return
    setDeleting(true)
    try { await deleteGifCollection(deleteDTag, signer, privateKey); removeCol(deleteDTag); setDeleteDTag(null) } catch (err) { console.error(err) } finally { setDeleting(false) }
  }

  return (
    <div className="space-y-3">
      <NewSetControl onCreate={createCol} />
      {myCols.length === 0 && <p className="text-sm text-muted-foreground text-center py-8">No GIF collections yet. Create one to get started.</p>}
      {myCols.map((col) => {
        const isOpen = expanded.has(col.dTag)
        return (
          <div key={col.dTag} className="rounded-xl border border-border overflow-hidden">
            <button onClick={() => toggle(col.dTag)} className="flex items-center gap-2 w-full px-3.5 py-3 text-left cursor-pointer hover:bg-secondary/30 transition-colors">
              <span className="text-sm font-medium text-foreground truncate">{col.name}</span>
              <span className="text-xs text-muted-foreground shrink-0">({col.gifs.length} GIF{col.gifs.length !== 1 ? 's' : ''})</span>
              {isOpen ? <ChevronUp size={17} className="ml-auto text-muted-foreground shrink-0" /> : <ChevronDown size={17} className="ml-auto text-muted-foreground shrink-0" />}
            </button>
            {isOpen && (
              <div className="border-t border-border">
                <PackActionRow addLabel="Add GIF" onRename={() => setRenameColDTag(col.dTag)} onAdd={() => setAddTarget((v) => v === col.dTag ? null : col.dTag)} onDelete={() => setDeleteDTag(col.dTag)} />
                {addTarget === col.dTag && (
                  <PackAddForm limitBytes={getGifUploadLimitBytes()} namePlaceholder="GIF name"
                    onUpload={async ({ url, name, nsfw }) => { const updated = [...col.gifs, { name, url, nsfw, tagged: true }]; await publishGifCollection(col.dTag, col.name, updated, signer, privateKey); updateCol(col.dTag, updated) }}
                    onDone={() => setAddTarget(null)} />
                )}
                {col.gifs.length === 0 ? (
                  <p className="text-xs text-muted-foreground px-3.5 py-3 border-t border-border">This collection is empty. Use Add GIF above.</p>
                ) : (
                  <div className="border-t border-border">
                    {col.gifs.map((g) => (
                      <div key={g.url} className="flex items-center gap-3 px-3.5 py-3 border-b border-border last:border-b-0">
                        <div className="w-28 h-20 rounded-md bg-secondary/40 flex items-center justify-center shrink-0 overflow-hidden">
                          <BlossomImage src={g.url} alt={g.name} className="max-w-full max-h-full" contain />
                        </div>
                        <span className="flex-1 text-sm text-foreground truncate min-w-0">{g.name || 'Unnamed GIF'}</span>
                        <div className="flex flex-col gap-1.5 shrink-0">
                          <button onClick={() => setRenameGifUrl({ dTag: col.dTag, url: g.url })} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border text-xs text-foreground hover:bg-secondary/60 transition-colors cursor-pointer"><Pencil size={13} /> <span className="hidden sm:inline">Edit</span></button>
                          <button onClick={() => onDeleteGif(col.dTag, g.url)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-destructive/40 text-xs text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"><Trash2 size={13} /> <span className="hidden sm:inline">Delete</span></button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
      <RenamePackModal open={!!renameCol} currentName={renameCol?.name ?? ''} kindLabel="GIF collection" onClose={() => setRenameColDTag(null)} onSave={onRenameCol} />
      <RenamePackModal open={!!renameGifUrl} currentName={renameGifCol?.gifs.find((g) => g.url === renameGifUrl?.url)?.name ?? ''} kindLabel="GIF" title="Rename GIF" hint="GIFs already sent keep their name; only new uses take the new one."
        onClose={() => setRenameGifUrl(null)} onSave={onRenameGif} />
      {deleteDTag && <DeleteSetDialog name={deleteCol?.name || deleteDTag} busy={deleting} onCancel={() => setDeleteDTag(null)} onConfirm={onDeleteCol} />}
    </div>
  )
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
                          <Pencil size={13} /> <span className="hidden sm:inline">Edit</span>
                        </button>
                        <button onClick={() => handleDeleteEmoji(set.dTag, e.shortcode)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-destructive/40 text-xs text-destructive hover:bg-destructive/10 transition-colors cursor-pointer shrink-0">
                          <Trash2 size={13} /> <span className="hidden sm:inline">Delete</span>
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

// ─── Subscriptions section (view + unsubscribe, per kind) ───

function SubscriptionsSection({ kind }: { kind: PackKind }) {
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const emojiSets = useEmojiStore((s) => s.subscribedSets)
  const emojiAddrs = useEmojiStore((s) => s.subscriptionAddresses)
  const stickerSets = useStickerStore((s) => s.subscribedSets)
  const stickerAddrs = useStickerStore((s) => s.subscriptionAddresses)
  const gifCols = useGifStore((s) => s.subscribedCollections)
  const gifAddrs = useGifStore((s) => s.subscriptionAddresses)
  const [busy, setBusy] = useState<string | null>(null)

  const cfg = kind === 'emoji'
    ? { sets: emojiSets as any[], addrs: emojiAddrs, prefix: '30030', label: 'emoji sets', items: (s: any) => s.emojis, publish: publishEmojiSubscriptions, remove: (a: string) => useEmojiStore.getState().removeSubscription(a) }
    : kind === 'sticker'
    ? { sets: stickerSets as any[], addrs: stickerAddrs, prefix: '30031', label: 'sticker sets', items: (s: any) => s.stickers, publish: publishStickerSubscriptions, remove: (a: string) => useStickerStore.getState().removeSubscription(a) }
    : { sets: gifCols as any[], addrs: gifAddrs, prefix: '30032', label: 'GIF collections', items: (s: any) => s.gifs, publish: publishGifSubscriptions, remove: (a: string) => useGifStore.getState().removeSubscription(a) }

  const unsubscribe = async (set: any) => {
    const addr = `${cfg.prefix}:${set.pubkey}:${set.dTag}`
    setBusy(addr)
    try {
      await cfg.publish(cfg.addrs.filter((a) => a !== addr), signer, privateKey)
      cfg.remove(addr)
    } catch (err) { console.error(err) } finally { setBusy(null) }
  }

  return (
    <div className="space-y-3">
      <span className="text-sm text-muted-foreground">Subscribed {cfg.label}</span>
      {cfg.sets.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">You have not subscribed to any {cfg.label} yet.</p>
      ) : cfg.sets.map((set) => {
        const addr = `${cfg.prefix}:${set.pubkey}:${set.dTag}`
        const items = cfg.items(set)
        return (
          <div key={addr} className="flex items-center gap-3 rounded-xl border border-border p-3">
            <div className="flex -space-x-1.5 shrink-0">
              {items.slice(0, 3).map((it: any, i: number) => (
                <div key={i} className="w-8 h-8 rounded-md bg-secondary/40 border border-card flex items-center justify-center overflow-hidden">
                  <BlossomImage src={it.url} alt="" className="w-7 h-7" contain />
                </div>
              ))}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground truncate">{set.name}</div>
              <div className="text-xs text-muted-foreground">{items.length} item{items.length !== 1 ? 's' : ''}</div>
            </div>
            <button onClick={() => unsubscribe(set)} disabled={busy === addr} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs text-foreground hover:bg-secondary/60 transition-colors cursor-pointer disabled:opacity-50 shrink-0">
              {busy === addr ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />} Unsubscribe
            </button>
          </div>
        )
      })}
    </div>
  )
}

// ─── Favorites section (GIF favorites: view + remove) ───

function FavoritesSection() {
  const favorites = useGifStore((s) => s.favorites)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const [busy, setBusy] = useState<string | null>(null)

  const remove = async (url: string) => {
    setBusy(url)
    try {
      const updated = useGifStore.getState().favorites.filter((f) => f.url !== url)
      await publishGifFavorites(updated, signer, privateKey)
      useGifStore.getState().setFavorites(updated)
    } catch (err) { console.error(err) } finally { setBusy(null) }
  }

  return (
    <div className="space-y-3">
      <span className="text-sm text-muted-foreground">Favorite GIFs</span>
      {favorites.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No favorite GIFs yet. Star a GIF from the GIF picker to save it here.</p>
      ) : favorites.map((g) => (
        <div key={g.url} className="flex items-center gap-3 rounded-xl border border-border p-3">
          <div className="w-24 h-16 rounded-md bg-secondary/40 flex items-center justify-center shrink-0 overflow-hidden">
            <BlossomImage src={g.url} alt={g.name} className="max-w-full max-h-full" contain />
          </div>
          <span className="flex-1 text-sm text-foreground truncate min-w-0">{g.name || 'Unnamed GIF'}</span>
          <button onClick={() => remove(g.url)} disabled={busy === g.url} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-destructive/40 text-xs text-destructive hover:bg-destructive/10 transition-colors cursor-pointer disabled:opacity-50 shrink-0">
            {busy === g.url ? <Loader2 size={13} className="animate-spin" /> : <StarOff size={13} />} Remove
          </button>
        </div>
      ))}
    </div>
  )
}
