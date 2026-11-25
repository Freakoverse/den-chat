/**
 * ListsModal — View and fill the user's predefined lists (NIP-51 kind:30003 sets)
 *
 * Lists are NOT user-created: there is a fixed CATALOG of lists, each with a preset
 * d-tag, title and description. A user only fills a list with items; each item has an
 * optional name, link and 2:3 box-art image, stored positionally as
 * ["r", link, name, boxArt] (a superset of the link tree's ["r", url, label]).
 *
 * A list's 30003 set is identified purely by its preset d-tag, so it never collides
 * with the link tree ("links-" d-tags) or with foreign bookmark sets.
 *
 * Viewer: index of the user's lists; click one to open its own page (back button) showing
 *         the title, description and a 2-column grid of items.
 * Editor: add/edit/remove items in each catalog list, or clear a list (self only).
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { nowSeconds } from '@/lib/time/clockOffset'
import {
  X, Plus, Trash2, ExternalLink, Loader2,
  List, Pencil, ImageIcon, ChevronDown, ChevronUp, Check,
  ArrowUp, ArrowDown, ArrowLeft,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { HUB_BANNER_PLACEHOLDER } from '@/lib/constants'
import { useUserStore } from '@/stores/userStore'
import { fetchEvents, publishToSpecificRelays } from '@/lib/nostr/relay-pool'
import { signWithSigner } from '@/lib/nostr/events'
import { publishPersonal, getDeletePublishRelays, getUploadBlossoms } from '@/stores/postingBehaviourStore'
import { uploadToBlossomServers } from '@/lib/blossom'
import type { UploadProgress } from '@/lib/blossom'
import type { Event } from 'nostr-tools'
import { useEscToClose } from '@/hooks/useEscToClose'

// ─── Catalog of predefined lists ───
// Each list's 30003 set uses this exact d-tag; title/description are canonical here.
// Add a new entry to introduce another list, no other code changes needed.

export interface PredefinedList {
  dTag: string
  title: string
  description: string
}

export const PREDEFINED_LISTS: PredefinedList[] = [
  { dTag: 'favorite-games', title: 'My Favorite Games', description: 'The games I keep coming back to' },
]

const PREDEFINED_BY_DTAG = new Map(PREDEFINED_LISTS.map((l) => [l.dTag, l]))

export function isPredefinedListDTag(dTag: string): boolean {
  return PREDEFINED_BY_DTAG.has(dTag)
}

// ─── Types ───

interface ListItem {
  name: string
  link: string
  boxArt: string
}

interface DisplayList extends PredefinedList {
  items: ListItem[]
}

const EMPTY_ITEM: ListItem = { name: '', link: '', boxArt: '' }

// ─── Helpers ───

function parseItemsFromEvent(ev: Event): ListItem[] {
  return ev.tags
    .filter((t) => t[0] === 'r')
    .map((t) => ({ link: t[1] || '', name: t[2] || '', boxArt: t[3] || '' }))
    .filter((it) => it.link || it.name || it.boxArt)
}

/** Latest-per-d-tag items for the user's predefined-list events. */
function parseListItems(events: Event[]): Map<string, ListItem[]> {
  const byDtag = new Map<string, Event>()
  for (const ev of [...events].sort((a, b) => b.created_at - a.created_at)) {
    const dTag = ev.tags.find((t) => t[0] === 'd')?.[1] || ''
    if (!isPredefinedListDTag(dTag) || byDtag.has(dTag)) continue
    byDtag.set(dTag, ev)
  }
  const map = new Map<string, ListItem[]>()
  for (const [dTag, ev] of byDtag) map.set(dTag, parseItemsFromEvent(ev))
  return map
}

function shortDomain(url: string): string {
  try {
    if (url.startsWith('mailto:')) return url.replace('mailto:', '')
    return new URL(url).hostname.replace('www.', '')
  } catch { return url }
}

/** 2:3 box-art tile with the shared placeholder on empty/broken images. */
function BoxArt({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="aspect-[2/3] w-full rounded-lg overflow-hidden border border-border/50 bg-secondary/30">
      <BlossomImage
        src={src}
        alt={alt}
        className="w-full h-full"
        fallback={<img src={HUB_BANNER_PLACEHOLDER} alt="" className="w-full h-full object-cover" loading="lazy" />}
      />
    </div>
  )
}

// ─── Viewer Modal ───

interface ListsViewerModalProps {
  open: boolean
  onClose: () => void
  pubkey: string
  onEdit?: () => void
  isSelf?: boolean
}

export function ListsViewerModal({ open, onClose, pubkey, onEdit, isSelf }: ListsViewerModalProps) {
  useEscToClose(onClose, open)
  const [itemsByDtag, setItemsByDtag] = useState<Map<string, ListItem[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const [selectedDTag, setSelectedDTag] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !pubkey) return
    setLoading(true)
    setSelectedDTag(null)
    fetchEvents({ kinds: [30003], authors: [pubkey] })
      .then((events) => setItemsByDtag(parseListItems(events)))
      .finally(() => setLoading(false))
  }, [open, pubkey])

  if (!open) return null

  // Self sees every catalog list (so they know what they can fill); others see only filled ones.
  const lists: DisplayList[] = PREDEFINED_LISTS
    .map((p) => ({ ...p, items: itemsByDtag.get(p.dTag) || [] }))
    .filter((l) => isSelf || l.items.length > 0)

  const selected = selectedDTag ? lists.find((l) => l.dTag === selectedDTag) || null : null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div
        className="relative z-10 w-full max-w-md mx-4 max-h-[80vh] flex flex-col bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {selected ? (
              <button
                onClick={() => setSelectedDTag(null)}
                className="p-1 -ml-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer shrink-0"
                aria-label="Back"
              >
                <ArrowLeft size={16} />
              </button>
            ) : (
              <List size={16} className="text-primary shrink-0" />
            )}
            <h2 className="font-semibold text-foreground text-sm truncate">
              {selected ? selected.title : 'Lists'}
            </h2>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer shrink-0">
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          ) : selected ? (
            <ListDetail list={selected} isSelf={isSelf} onEdit={onEdit} />
          ) : lists.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
                <List size={22} className="text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">No lists yet</p>
                <p className="text-xs text-muted-foreground mt-1">This user hasn't filled any lists yet.</p>
              </div>
            </div>
          ) : (
            <div className="space-y-2.5">
              {lists.map((list) => (
                <button
                  key={list.dTag}
                  onClick={() => setSelectedDTag(list.dTag)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border border-border/60 bg-secondary/20 hover:bg-secondary/40 hover:border-border transition-colors text-left cursor-pointer"
                >
                  <div className="w-10 h-14 shrink-0 rounded-md overflow-hidden border border-border/50 bg-secondary/30">
                    <BlossomImage
                      src={list.items.find((it) => it.boxArt)?.boxArt || ''}
                      alt=""
                      className="w-full h-full"
                      fallback={<img src={HUB_BANNER_PLACEHOLDER} alt="" className="w-full h-full object-cover" loading="lazy" />}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-semibold text-foreground block truncate">{list.title}</span>
                    {list.description && (
                      <span className="text-xs text-muted-foreground block truncate">{list.description}</span>
                    )}
                    <span className="text-[10px] text-muted-foreground">
                      {list.items.length} item{list.items.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <ChevronDown size={14} className="-rotate-90 text-muted-foreground shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ListDetail({ list, isSelf, onEdit }: { list: DisplayList; isSelf?: boolean; onEdit?: () => void }) {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        {list.description ? (
          <p className="text-xs text-muted-foreground leading-relaxed flex-1">{list.description}</p>
        ) : <span className="flex-1" />}
        {isSelf && onEdit && (
          <Button variant="ghost" size="sm" onClick={onEdit} className="h-7 px-2 text-xs gap-1 shrink-0">
            <Pencil size={12} /> Edit
          </Button>
        )}
      </div>
      {list.items.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-8">This list is empty.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {list.items.map((item, i) => {
            const label = item.name || (item.link ? shortDomain(item.link) : '')
            const inner = (
              <>
                <BoxArt src={item.boxArt} alt={item.name} />
                {label && (
                  <div className="mt-1.5 flex items-center gap-1 min-w-0">
                    <span className="text-xs font-medium text-foreground truncate flex-1">{label}</span>
                    {item.link && <ExternalLink size={11} className="text-muted-foreground shrink-0" />}
                  </div>
                )}
              </>
            )
            return item.link ? (
              <a key={i} href={item.link} target="_blank" rel="noopener noreferrer" className="group block">
                {inner}
              </a>
            ) : (
              <div key={i} className="block">{inner}</div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Editor Modal ───

interface ListsEditorModalProps {
  open: boolean
  onClose: () => void
  onSaved?: () => void
}

interface EditingList extends PredefinedList {
  items: ListItem[]
  published: boolean // whether a 30003 event already exists for this d-tag
}

export function ListsEditorModal({ open, onClose, onSaved }: ListsEditorModalProps) {
  useEscToClose(onClose, open)
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const [lists, setLists] = useState<EditingList[]>([])
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [expandedDTag, setExpandedDTag] = useState<string | null>(null)

  const originalRef = useRef<Record<string, string>>({})
  const [successDTag, setSuccessDTag] = useState<string | null>(null)

  // Box-art upload state (per item)
  const [imgUploading, setImgUploading] = useState(false)
  const [imgProgress, setImgProgress] = useState<UploadProgress | null>(null)
  const imgInputRef = useRef<HTMLInputElement>(null)
  const imgAbortRef = useRef<AbortController | null>(null)
  const [uploadingFor, setUploadingFor] = useState<{ dTag: string; itemIdx: number } | null>(null)

  const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
  const ACCEPTED_IMAGE_EXTENSIONS = '.png,.jpg,.jpeg,.gif,.webp'

  const snapshot = (items: ListItem[]) => JSON.stringify(items)

  useEffect(() => {
    if (!open || !myPubkey) return
    setLoading(true)
    fetchEvents({ kinds: [30003], authors: [myPubkey] })
      .then((events) => {
        const itemsByDtag = parseListItems(events)
        const editLists: EditingList[] = PREDEFINED_LISTS.map((p) => ({
          ...p,
          items: itemsByDtag.get(p.dTag) || [],
          published: itemsByDtag.has(p.dTag),
        }))
        setLists(editLists)
        const snap: Record<string, string> = {}
        for (const l of editLists) snap[l.dTag] = snapshot(l.items)
        originalRef.current = snap
        setExpandedDTag(editLists[0]?.dTag ?? null)
      })
      .finally(() => setLoading(false))
  }, [open, myPubkey])

  useEffect(() => {
    if (!open) {
      setExpandedDTag(null)
      setImgUploading(false)
      setImgProgress(null)
      setUploadingFor(null)
      setSuccessDTag(null)
      originalRef.current = {}
    }
  }, [open])

  const updateItems = (dTag: string, items: ListItem[], extra?: Partial<EditingList>) => {
    setLists((prev) => prev.map((l) => (l.dTag === dTag ? { ...l, items, ...extra } : l)))
  }

  const addItem = (dTag: string) => {
    setLists((prev) => prev.map((l) => (l.dTag === dTag ? { ...l, items: [...l.items, { ...EMPTY_ITEM }] } : l)))
  }

  const updateItem = (dTag: string, itemIdx: number, field: keyof ListItem, value: string) => {
    setLists((prev) =>
      prev.map((l) =>
        l.dTag === dTag ? { ...l, items: l.items.map((it, j) => (j === itemIdx ? { ...it, [field]: value } : it)) } : l,
      ),
    )
  }

  const removeItem = (dTag: string, itemIdx: number) => {
    setLists((prev) => prev.map((l) => (l.dTag === dTag ? { ...l, items: l.items.filter((_, j) => j !== itemIdx) } : l)))
  }

  const moveItem = (dTag: string, itemIdx: number, direction: -1 | 1) => {
    setLists((prev) =>
      prev.map((l) => {
        if (l.dTag !== dTag) return l
        const items = [...l.items]
        const target = itemIdx + direction
        if (target < 0 || target >= items.length) return l
        ;[items[itemIdx], items[target]] = [items[target], items[itemIdx]]
        return { ...l, items }
      }),
    )
  }

  const handleImageUpload = async (file: File, dTag: string, itemIdx: number) => {
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) return
    const limitMb = Number(localStorage.getItem('den-chat-upload-limit-mb')) || 10
    if (file.size > limitMb * 1024 * 1024) return

    setUploadingFor({ dTag, itemIdx })
    setImgUploading(true)
    setImgProgress(null)
    try {
      const buffer = await file.arrayBuffer()
      const data = new Uint8Array(buffer)
      const { hash, serverUrls } = await uploadToBlossomServers(
        data, signer, privateKey, getUploadBlossoms(), file.type,
        (p) => setImgProgress({ ...p }),
        () => { const c = new AbortController(); imgAbortRef.current = c; return c.signal },
      )
      updateItem(dTag, itemIdx, 'boxArt', `${serverUrls[0]}/${hash}`)
    } catch (err) {
      console.error('Box-art upload failed:', err)
    } finally {
      setImgUploading(false)
      setImgProgress(null)
      setUploadingFor(null)
      imgAbortRef.current = null
    }
  }

  const publishList = useCallback(async (dTag: string) => {
    const list = lists.find((l) => l.dTag === dTag)
    if (!list || !myPubkey || (!signer && !privateKey)) return

    setPublishing(true)
    try {
      const tags: string[][] = [['d', list.dTag], ['title', list.title]]
      if (list.description) tags.push(['description', list.description])

      for (const item of list.items) {
        const link = item.link.trim()
        const name = item.name.trim()
        const boxArt = item.boxArt.trim()
        if (!link && !name && !boxArt) continue
        // Positional: ['r', link, name, boxArt]; trim trailing empties.
        const rTag = ['r', link, name, boxArt]
        while (rTag.length > 2 && rTag[rTag.length - 1] === '') rTag.pop()
        tags.push(rTag)
      }

      const unsigned = { kind: 30003, pubkey: myPubkey, created_at: nowSeconds(), tags, content: '' }
      const signed = await signWithSigner(unsigned, signer, privateKey)
      await publishPersonal(signed)

      updateItems(dTag, list.items, { published: true })
      originalRef.current[dTag] = snapshot(list.items)

      setSuccessDTag(dTag)
      setTimeout(() => setSuccessDTag(null), 2500)
      onSaved?.()
    } catch (err) {
      console.error('Failed to publish list:', err)
    } finally {
      setPublishing(false)
    }
  }, [lists, myPubkey, signer, privateKey, onSaved])

  const clearList = useCallback(async (dTag: string) => {
    const list = lists.find((l) => l.dTag === dTag)
    if (!list || !myPubkey || (!signer && !privateKey)) return

    // Never published: just clear locally.
    if (!list.published) {
      updateItems(dTag, [])
      originalRef.current[dTag] = snapshot([])
      return
    }

    setPublishing(true)
    try {
      // Empty the set, then publish a kind:5 deletion for the addressable coordinate.
      const unsigned = { kind: 30003, pubkey: myPubkey, created_at: nowSeconds(), tags: [['d', list.dTag]], content: '' }
      const signed = await signWithSigner(unsigned, signer, privateKey)
      await publishToSpecificRelays(getDeletePublishRelays(), signed)

      const { createDeletionEvent } = await import('@/lib/nostr/events')
      const aRef = `30003:${myPubkey}:${list.dTag}`
      const delEvent = createDeletionEvent([], [aRef], 'Cleared list')
      const signedDel = await signWithSigner(delEvent, signer, privateKey)
      await publishToSpecificRelays(getDeletePublishRelays(), signedDel)

      updateItems(dTag, [], { published: false })
      originalRef.current[dTag] = snapshot([])
      onSaved?.()
    } catch (err) {
      console.error('Failed to clear list:', err)
    } finally {
      setPublishing(false)
    }
  }, [lists, myPubkey, signer, privateKey, onSaved])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div
        className="relative z-10 w-full max-w-lg mx-4 max-h-[85vh] flex flex-col bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <List size={16} className="text-primary" />
            <h2 className="font-semibold text-foreground text-sm">Edit lists</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer">
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-3">
              {lists.map((list) => {
                const isExpanded = expandedDTag === list.dTag
                const isSuccess = successDTag === list.dTag
                const hasChanges = snapshot(list.items) !== originalRef.current[list.dTag]
                const itemCount = list.items.filter((it) => it.name.trim() || it.link.trim() || it.boxArt.trim()).length
                return (
                  <div key={list.dTag} className="rounded-xl border border-border/60 bg-secondary/20 overflow-hidden">
                    {/* Collapsed header */}
                    <button
                      onClick={() => setExpandedDTag(isExpanded ? null : list.dTag)}
                      className="flex items-center justify-between w-full px-3 py-3 text-left cursor-pointer group hover:bg-secondary/40 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <span className="text-sm font-medium text-foreground block truncate">{list.title}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {itemCount} item{itemCount !== 1 ? 's' : ''}
                          {hasChanges && <span className="ml-1.5 text-amber-400">● unsaved</span>}
                        </span>
                      </div>
                      {isExpanded ? <ChevronUp size={14} className="text-muted-foreground shrink-0" /> : <ChevronDown size={14} className="text-muted-foreground shrink-0" />}
                    </button>

                    {/* Expanded editor */}
                    {isExpanded && (
                      <div className="px-4 pb-4 space-y-3 border-t border-border/40">
                        {list.description && (
                          <p className="text-xs text-muted-foreground pt-3">{list.description}</p>
                        )}

                        {/* Items */}
                        <div className={list.description ? '' : 'pt-3'}>
                          <label className="text-xs text-muted-foreground mb-1.5 block">Items</label>
                          {list.items.length === 0 ? (
                            <p className="text-xs text-muted-foreground py-2">No items yet. Add your first below.</p>
                          ) : (
                            <div className="space-y-3">
                              {list.items.map((item, itemIdx) => {
                                const uploading = imgUploading && uploadingFor?.dTag === list.dTag && uploadingFor?.itemIdx === itemIdx
                                return (
                                  <div key={itemIdx} className="flex items-start gap-2 rounded-lg border border-border/40 bg-background/40 p-2">
                                    {/* Box art */}
                                    <div className="w-16 shrink-0">
                                      {item.boxArt ? (
                                        <div className="relative">
                                          <div className="aspect-[2/3] w-full rounded-md overflow-hidden border border-border/50">
                                            <BlossomImage src={item.boxArt} alt="" className="w-full h-full" />
                                          </div>
                                          <button
                                            onClick={() => updateItem(list.dTag, itemIdx, 'boxArt', '')}
                                            className="absolute top-1 right-1 p-0.5 rounded-full bg-black/50 text-white hover:bg-black/70 cursor-pointer"
                                          >
                                            <X size={10} />
                                          </button>
                                        </div>
                                      ) : (
                                        <button
                                          onClick={() => { setUploadingFor({ dTag: list.dTag, itemIdx }); imgInputRef.current?.click() }}
                                          className="aspect-[2/3] w-full rounded-md border border-dashed border-border hover:border-primary/50 flex flex-col items-center justify-center gap-1 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                                        >
                                          {uploading ? <Loader2 size={14} className="animate-spin" /> : <ImageIcon size={14} />}
                                          <span className="text-[9px] px-1 text-center leading-tight">
                                            {uploading ? (imgProgress ? `${Math.round(imgProgress.percent)}%` : '...') : 'Box art'}
                                          </span>
                                        </button>
                                      )}
                                    </div>

                                    {/* Name + link */}
                                    <div className="flex-1 space-y-1.5 min-w-0">
                                      <Input
                                        value={item.name}
                                        onChange={(e) => updateItem(list.dTag, itemIdx, 'name', e.target.value)}
                                        placeholder="Name"
                                        className="h-7 text-xs"
                                      />
                                      <Input
                                        value={item.link}
                                        onChange={(e) => updateItem(list.dTag, itemIdx, 'link', e.target.value)}
                                        placeholder="https://... (optional)"
                                        className="h-7 text-xs"
                                      />
                                      <div className="flex items-center justify-between">
                                        <div className="flex items-center">
                                          <button
                                            onClick={() => moveItem(list.dTag, itemIdx, -1)}
                                            disabled={itemIdx === 0}
                                            className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors cursor-pointer disabled:cursor-default"
                                          >
                                            <ArrowUp size={11} />
                                          </button>
                                          <button
                                            onClick={() => moveItem(list.dTag, itemIdx, 1)}
                                            disabled={itemIdx === list.items.length - 1}
                                            className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors cursor-pointer disabled:cursor-default"
                                          >
                                            <ArrowDown size={11} />
                                          </button>
                                        </div>
                                        <button
                                          onClick={() => removeItem(list.dTag, itemIdx)}
                                          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
                                        >
                                          <Trash2 size={11} /> Remove
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                          <button
                            onClick={() => addItem(list.dTag)}
                            className="flex items-center gap-1 mt-2 text-xs text-primary hover:text-primary/80 transition-colors cursor-pointer"
                          >
                            <Plus size={12} /> Add item
                          </button>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center justify-between pt-2 border-t border-border/40">
                          <button
                            onClick={() => clearList(list.dTag)}
                            disabled={publishing || (!list.published && itemCount === 0)}
                            className="flex items-center gap-1 text-xs text-destructive hover:text-destructive/80 transition-colors cursor-pointer disabled:opacity-40"
                          >
                            <Trash2 size={12} /> Clear list
                          </button>
                          <div className="flex items-center gap-2">
                            {isSuccess && (
                              <span className="flex items-center gap-1 text-xs text-emerald-400 animate-in fade-in-0 duration-300">
                                <Check size={13} /> Published
                              </span>
                            )}
                            <Button
                              size="sm"
                              onClick={() => publishList(list.dTag)}
                              disabled={publishing || itemCount === 0 || !hasChanges}
                              className="h-7 px-3 text-xs"
                            >
                              {publishing ? <Loader2 size={12} className="animate-spin" /> : 'Publish'}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Hidden file input for box-art upload */}
        <input
          ref={imgInputRef}
          type="file"
          accept={ACCEPTED_IMAGE_EXTENSIONS}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f && uploadingFor) handleImageUpload(f, uploadingFor.dTag, uploadingFor.itemIdx)
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}
