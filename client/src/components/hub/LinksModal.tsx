/**
 * LinksModal — View and edit NIP-51 kind:30003 linktree-style link sets
 *
 * Viewer: Shows all published link sets for a user with title, description, image, and links
 * Editor: Create, edit, and delete link sets (self only)
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  X, Plus, Trash2, ExternalLink, Loader2,
  Globe, Link2, Pencil, ImageIcon, XCircle, ChevronDown, ChevronUp, Check,
  ArrowUp, ArrowDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { useUserStore } from '@/stores/userStore'
import { fetchEvents, publishToSpecificRelays } from '@/lib/nostr/relay-pool'
import { signWithSigner } from '@/lib/nostr/events'
import { publishPersonal, getPublishRelays, getDeletePublishRelays } from '@/stores/postingBehaviourStore'
import { uploadToBlossomServers } from '@/lib/blossom'
import type { UploadProgress } from '@/lib/blossom'
import type { Event } from 'nostr-tools'
import { useEscToClose } from '@/hooks/useEscToClose'

// ─── Types ───

interface LinkItem {
  url: string
  label: string
}

interface LinkSet {
  dTag: string
  title: string
  description: string
  image: string
  links: LinkItem[]
  order: number
  createdAt: number
  /** Raw event for reference */
  event?: Event
}

// ─── Helpers ───

function parseLinkSets(events: Event[]): LinkSet[] {
  return events
    .map((ev) => {
      const dTag = ev.tags.find((t) => t[0] === 'd')?.[1] || ''
      if (!dTag.startsWith('links-')) return null

      const title = ev.tags.find((t) => t[0] === 'title')?.[1] || ''
      const description = ev.tags.find((t) => t[0] === 'description')?.[1] || ''
      const image = ev.tags.find((t) => t[0] === 'image')?.[1] || ''
      const orderStr = ev.tags.find((t) => t[0] === 'order')?.[1]
      const order = orderStr != null ? parseInt(orderStr, 10) : Infinity
      const links: LinkItem[] = ev.tags
        .filter((t) => t[0] === 'r' && t[1])
        .map((t) => ({ url: t[1], label: t[2] || '' }))

      return { dTag, title, description, image, links, order, createdAt: ev.created_at, event: ev }
    })
    .filter(Boolean) as LinkSet[]
}

/** Sort link sets by order tag (ascending), then created_at descending as tiebreaker */
function sortLinkSets(sets: LinkSet[]): LinkSet[] {
  return [...sets].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order
    return b.createdAt - a.createdAt
  })
}

function getLinkIcon(_url: string) {
  return null
}

function shortDomain(url: string): string {
  try {
    if (url.startsWith('mailto:')) return url.replace('mailto:', '')
    return new URL(url).hostname.replace('www.', '')
  } catch { return url }
}

// ─── Viewer Modal ───

interface LinksViewerModalProps {
  open: boolean
  onClose: () => void
  pubkey: string
  onEdit?: () => void
  isSelf?: boolean
}

export function LinksViewerModal({ open, onClose, pubkey, onEdit, isSelf }: LinksViewerModalProps) {
  useEscToClose(onClose, open)
  const [linkSets, setLinkSets] = useState<LinkSet[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!open || !pubkey) return
    setLoading(true)
    fetchEvents({ kinds: [30003], authors: [pubkey] })
      .then((events) => {
        const parsed = parseLinkSets(events)
        setLinkSets(sortLinkSets(parsed))
      })
      .finally(() => setLoading(false))
  }, [open, pubkey])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative z-10 w-full max-w-md mx-4 max-h-[80vh] flex flex-col bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Link2 size={16} className="text-primary" />
            <h2 className="font-semibold text-foreground text-sm">Links</h2>
          </div>
          <div className="flex items-center gap-1.5">
            {isSelf && onEdit && (
              <Button variant="ghost" size="sm" onClick={onEdit} className="h-7 px-2 text-xs gap-1">
                <Pencil size={12} /> Edit
              </Button>
            )}
            <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          ) : linkSets.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
                <Link2 size={22} className="text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">No link sets published</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {isSelf ? 'Create your first link set to share your links with others.' : 'This user hasn\'t published any link sets yet.'}
                </p>
              </div>
              {isSelf && onEdit && (
                <Button size="sm" onClick={onEdit} className="gap-1 mt-2">
                  <Plus size={14} /> Create Link Set
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {linkSets.map((set) => (
                <LinkSetCard key={set.dTag} set={set} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function LinkSetCard({ set }: { set: LinkSet }) {
  return (
    <div className="rounded-xl border border-border/60 bg-secondary/20 overflow-hidden">
      {/* Header image */}
      {set.image && (
        <div className="h-28 overflow-hidden">
          <BlossomImage
            src={set.image}
            alt={set.title}
            className="w-full h-full"
          />
        </div>
      )}

      {/* Title + description */}
      <div className="px-4 pt-3 pb-2">
        {set.title && (
          <h3 className="text-sm font-semibold text-foreground">{set.title}</h3>
        )}
        {set.description && (
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{set.description}</p>
        )}
      </div>

      {/* Links */}
      {set.links.length > 0 && (
        <div className="px-3 pb-3 grid grid-cols-2 gap-2">
          {set.links.map((link, i) => {
            const icon = getLinkIcon(link.url)
            return (
              <a
                key={i}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-background/60 hover:bg-background border border-border/40 hover:border-border transition-all group"
              >
                <span className="w-5 h-5 flex items-center justify-center text-xs shrink-0">
                  {icon || <Globe size={14} className="text-muted-foreground" />}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-foreground truncate block">
                    {link.label || shortDomain(link.url)}
                  </span>
                  {link.label && (
                    <span className="text-[10px] text-muted-foreground truncate block">{shortDomain(link.url)}</span>
                  )}
                </div>
                <ExternalLink size={12} className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </a>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Editor Modal ───

interface LinksEditorModalProps {
  open: boolean
  onClose: () => void
  onSaved?: () => void
}

interface EditingLinkSet {
  dTag: string
  title: string
  description: string
  image: string
  links: LinkItem[]
  order: number
  isNew?: boolean
}

export function LinksEditorModal({ open, onClose, onSaved }: LinksEditorModalProps) {
  useEscToClose(onClose, open)
  const myPubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const [linkSets, setLinkSets] = useState<EditingLinkSet[]>([])
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)

  // Track original fetched state for change detection
  const originalSetsRef = useRef<Record<string, string>>({})
  // Track per-set success flash
  const [successDTag, setSuccessDTag] = useState<string | null>(null)

  // Image upload state
  const [imgUploading, setImgUploading] = useState(false)
  const [imgProgress, setImgProgress] = useState<UploadProgress | null>(null)
  const imgInputRef = useRef<HTMLInputElement>(null)
  const imgAbortRef = useRef<AbortController | null>(null)
  const [uploadingForIdx, setUploadingForIdx] = useState<number | null>(null)

  const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
  const ACCEPTED_IMAGE_EXTENSIONS = '.png,.jpg,.jpeg,.gif,.webp'

  // Load existing link sets
  useEffect(() => {
    if (!open || !myPubkey) return
    setLoading(true)
    fetchEvents({ kinds: [30003], authors: [myPubkey] })
      .then((events) => {
        const parsed = parseLinkSets(events)
        const sorted = sortLinkSets(parsed)
        const editSets = sorted.map((s, i) => ({
          dTag: s.dTag,
          title: s.title,
          description: s.description,
          image: s.image,
          links: s.links,
          order: s.order === Infinity ? i : s.order,
        }))
        setLinkSets(editSets)
        // Snapshot original state for change detection
        const snap: Record<string, string> = {}
        for (const s of editSets) {
          snap[s.dTag] = JSON.stringify({ title: s.title, description: s.description, image: s.image, links: s.links, order: s.order })
        }
        originalSetsRef.current = snap
      })
      .finally(() => setLoading(false))
  }, [open, myPubkey])

  // Reset on close
  useEffect(() => {
    if (!open) {
      setExpandedIdx(null)
      setImgUploading(false)
      setImgProgress(null)
      setUploadingForIdx(null)
      setSuccessDTag(null)
      originalSetsRef.current = {}
    }
  }, [open])

  const addNewLinkSet = () => {
    const newSet: EditingLinkSet = {
      dTag: `links-${crypto.randomUUID()}`,
      title: '',
      description: '',
      image: '',
      links: [{ url: '', label: '' }],
      order: 0,
      isNew: true,
    }
    // Shift existing orders down by 1 and prepend
    setLinkSets((prev) => [newSet, ...prev.map(s => ({ ...s, order: s.order + 1 }))])
    setExpandedIdx(0)
  }

  const updateSet = (idx: number, updates: Partial<EditingLinkSet>) => {
    setLinkSets((prev) => prev.map((s, i) => (i === idx ? { ...s, ...updates } : s)))
  }

  const addLink = (setIdx: number) => {
    setLinkSets((prev) =>
      prev.map((s, i) =>
        i === setIdx ? { ...s, links: [...s.links, { url: '', label: '' }] } : s
      )
    )
  }

  const updateLink = (setIdx: number, linkIdx: number, field: 'url' | 'label', value: string) => {
    setLinkSets((prev) =>
      prev.map((s, i) =>
        i === setIdx
          ? { ...s, links: s.links.map((l, j) => (j === linkIdx ? { ...l, [field]: value } : l)) }
          : s
      )
    )
  }

  const removeLink = (setIdx: number, linkIdx: number) => {
    setLinkSets((prev) =>
      prev.map((s, i) =>
        i === setIdx ? { ...s, links: s.links.filter((_, j) => j !== linkIdx) } : s
      )
    )
  }

  const moveLink = (setIdx: number, linkIdx: number, direction: -1 | 1) => {
    setLinkSets((prev) =>
      prev.map((s, i) => {
        if (i !== setIdx) return s
        const newLinks = [...s.links]
        const targetIdx = linkIdx + direction
        if (targetIdx < 0 || targetIdx >= newLinks.length) return s
        ;[newLinks[linkIdx], newLinks[targetIdx]] = [newLinks[targetIdx], newLinks[linkIdx]]
        return { ...s, links: newLinks }
      })
    )
  }

  const moveSet = (setIdx: number, direction: -1 | 1) => {
    const targetIdx = setIdx + direction
    if (targetIdx < 0 || targetIdx >= linkSets.length) return
    setLinkSets((prev) => {
      const next = [...prev]
      ;[next[setIdx], next[targetIdx]] = [next[targetIdx], next[setIdx]]
      // Reassign order values based on new position
      return next.map((s, i) => ({ ...s, order: i }))
    })
    // Update expandedIdx if needed
    if (expandedIdx === setIdx) setExpandedIdx(targetIdx)
    else if (expandedIdx === targetIdx) setExpandedIdx(setIdx)
  }

  const handleImageUpload = async (file: File, setIdx: number) => {
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) return
    const limitMb = Number(localStorage.getItem('den-chat-upload-limit-mb')) || 10
    if (file.size > limitMb * 1024 * 1024) return

    setImgUploading(true)
    setUploadingForIdx(setIdx)
    setImgProgress(null)
    try {
      const buffer = await file.arrayBuffer()
      const data = new Uint8Array(buffer)
      const { hash } = await uploadToBlossomServers(
        data, signer, privateKey, undefined, file.type,
        (p) => setImgProgress({ ...p }),
        () => { const c = new AbortController(); imgAbortRef.current = c; return c.signal },
      )
      // Use hash URL — BlossomImage will resolve with failover
      const firstServer = (await import('@/lib/blossom')).blossomServers.getServers()[0]
      updateSet(setIdx, { image: `${firstServer}/${hash}` })
    } catch (err) {
      console.error('Image upload failed:', err)
    } finally {
      setImgUploading(false)
      setImgProgress(null)
      setUploadingForIdx(null)
      imgAbortRef.current = null
    }
  }

  const publishSet = useCallback(async (setIdx: number) => {
    const set = linkSets[setIdx]
    if (!set || !myPubkey || (!signer && !privateKey)) return

    setPublishing(true)
    try {
      const tags: string[][] = [
        ['d', set.dTag],
      ]
      if (set.title.trim()) tags.push(['title', set.title.trim()])
      if (set.description.trim()) tags.push(['description', set.description.trim()])
      if (set.image.trim()) tags.push(['image', set.image.trim()])
      tags.push(['order', String(set.order)])

      // Add links — filter out empty ones
      for (const link of set.links) {
        if (link.url.trim()) {
          const rTag = ['r', link.url.trim()]
          if (link.label.trim()) rTag.push(link.label.trim())
          tags.push(rTag)
        }
      }

      const unsigned = {
        kind: 30003,
        pubkey: myPubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: '',
      }

      const signed = await signWithSigner(unsigned, signer, privateKey)
      await publishPersonal(signed)

      // Mark as no longer new + update original snapshot
      updateSet(setIdx, { isNew: false })
      originalSetsRef.current[set.dTag] = JSON.stringify({ title: set.title.trim(), description: set.description.trim(), image: set.image.trim(), links: set.links.filter(l => l.url.trim()).map(l => ({ url: l.url.trim(), label: l.label.trim() })), order: set.order })

      // Show success flash
      setSuccessDTag(set.dTag)
      setTimeout(() => setSuccessDTag(null), 2500)

      onSaved?.()
    } catch (err) {
      console.error('Failed to publish link set:', err)
    } finally {
      setPublishing(false)
    }
  }, [linkSets, myPubkey, signer, privateKey, onSaved])

  const deleteSet = useCallback(async (setIdx: number) => {
    const set = linkSets[setIdx]
    if (!set || !myPubkey || (!signer && !privateKey)) return

    // If it's a new unsaved set, just remove locally
    if (set.isNew) {
      setLinkSets((prev) => prev.filter((_, i) => i !== setIdx))
      if (expandedIdx === setIdx) setExpandedIdx(null)
      return
    }

    setPublishing(true)
    try {
      // Publish a replacement with no links (empty the set)
      const tags: string[][] = [['d', set.dTag]]
      const unsigned = {
        kind: 30003,
        pubkey: myPubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: '',
      }
      const signed = await signWithSigner(unsigned, signer, privateKey)
      await publishToSpecificRelays(getDeletePublishRelays(), signed)

      // Also publish kind:5 deletion
      const { createDeletionEvent } = await import('@/lib/nostr/events')
      const aRef = `30003:${myPubkey}:${set.dTag}`
      const delEvent = createDeletionEvent([], [aRef], 'Deleted link set')
      const signedDel = await signWithSigner(delEvent, signer, privateKey)
      await publishToSpecificRelays(getDeletePublishRelays(), signedDel)

      setLinkSets((prev) => prev.filter((_, i) => i !== setIdx))
      if (expandedIdx === setIdx) setExpandedIdx(null)
      onSaved?.()
    } catch (err) {
      console.error('Failed to delete link set:', err)
    } finally {
      setPublishing(false)
    }
  }, [linkSets, myPubkey, signer, privateKey, expandedIdx, onSaved])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative z-10 w-full max-w-lg mx-4 max-h-[85vh] flex flex-col bg-card rounded-xl border border-border shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Link2 size={16} className="text-primary" />
            <h2 className="font-semibold text-foreground text-sm">Edit Links</h2>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" onClick={addNewLinkSet} className="h-7 px-2.5 text-xs gap-1">
              <Plus size={12} /> New Set
            </Button>
            <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          ) : linkSets.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
                <Link2 size={22} className="text-primary" />
              </div>
              <p className="text-sm font-medium text-foreground">No link sets yet</p>
              <p className="text-xs text-muted-foreground">Create a link set to share your links on your profile.</p>
              <Button size="sm" onClick={addNewLinkSet} className="gap-1 mt-1">
                <Plus size={14} /> Create Link Set
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {linkSets.map((set, setIdx) => {
                const isExpanded = expandedIdx === setIdx
                const isSuccess = successDTag === set.dTag

                // Change detection: compare current state to original
                const currentSnap = JSON.stringify({ title: set.title, description: set.description, image: set.image, links: set.links, order: set.order })
                const originalSnap = originalSetsRef.current[set.dTag]
                const hasChanges = set.isNew || currentSnap !== originalSnap
                return (
                  <div key={set.dTag} className="rounded-xl border border-border/60 bg-secondary/20 overflow-hidden">
                    {/* Collapsed header */}
                    <div className="flex items-center">
                      {/* Set reorder buttons */}
                      <div className="flex flex-col border-r border-border/30 shrink-0">
                        <button
                          onClick={(e) => { e.stopPropagation(); moveSet(setIdx, -1) }}
                          disabled={setIdx === 0}
                          className="p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors cursor-pointer disabled:cursor-default"
                        >
                          <ArrowUp size={11} />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); moveSet(setIdx, 1) }}
                          disabled={setIdx === linkSets.length - 1}
                          className="p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors cursor-pointer disabled:cursor-default"
                        >
                          <ArrowDown size={11} />
                        </button>
                      </div>
                      <button
                        onClick={() => setExpandedIdx(isExpanded ? null : setIdx)}
                        className="flex items-center justify-between flex-1 px-3 py-3 text-left cursor-pointer group hover:bg-secondary/40 transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="text-sm font-medium text-foreground block truncate">
                            {set.title || 'Untitled Link Set'}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {set.links.filter((l) => l.url.trim()).length} link{set.links.filter((l) => l.url.trim()).length !== 1 ? 's' : ''}
                            {set.isNew && <span className="ml-1.5 text-amber-400">● unsaved</span>}
                            {hasChanges && !set.isNew && <span className="ml-1.5 text-amber-400">● modified</span>}
                          </span>
                        </div>
                        {isExpanded ? <ChevronUp size={14} className="text-muted-foreground shrink-0" /> : <ChevronDown size={14} className="text-muted-foreground shrink-0" />}
                      </button>
                    </div>

                    {/* Expanded editor */}
                    {isExpanded && (
                      <div className="px-4 pb-4 space-y-3 border-t border-border/40">
                        {/* Title */}
                        <div className="pt-3">
                          <label className="text-xs text-muted-foreground mb-1 block">Title</label>
                          <Input
                            value={set.title}
                            onChange={(e) => updateSet(setIdx, { title: e.target.value })}
                            placeholder="My Links"
                            className="h-8 text-sm"
                          />
                        </div>

                        {/* Description */}
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">Description</label>
                          <Input
                            value={set.description}
                            onChange={(e) => updateSet(setIdx, { description: e.target.value })}
                            placeholder="A short description..."
                            className="h-8 text-sm"
                          />
                        </div>

                        {/* Image */}
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">Header Image</label>
                          <div className="flex items-center gap-2">
                            {set.image ? (
                              <div className="relative h-16 w-full rounded-lg overflow-hidden border border-border/50">
                                <BlossomImage src={set.image} alt="" className="w-full h-full" />
                                <button
                                  onClick={() => updateSet(setIdx, { image: '' })}
                                  className="absolute top-1 right-1 p-0.5 rounded-full bg-black/50 text-white hover:bg-black/70 cursor-pointer"
                                >
                                  <X size={10} />
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => { setUploadingForIdx(setIdx); imgInputRef.current?.click() }}
                                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border hover:border-primary/50 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer w-full"
                              >
                                <ImageIcon size={14} />
                                <span>Click to upload header image</span>
                              </button>
                            )}
                          </div>
                          {imgUploading && uploadingForIdx === setIdx && (
                            <div className="mt-1.5 flex items-center gap-2">
                              <Loader2 size={12} className="animate-spin text-primary" />
                              <span className="text-[10px] text-muted-foreground">
                                Uploading... {imgProgress ? `${Math.round(imgProgress.percent)}%` : ''}
                              </span>
                              <button
                                onClick={() => { imgAbortRef.current?.abort(); imgAbortRef.current = null }}
                                className="text-[10px] text-destructive hover:underline cursor-pointer ml-auto"
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                          {/* URL fallback */}
                          <div className="flex items-center gap-2 mt-1">
                            <label className="text-[10px] text-muted-foreground shrink-0">URL</label>
                            <Input
                              className="h-6 text-[11px] font-mono"
                              placeholder="https://..."
                              value={set.image}
                              onChange={(e) => updateSet(setIdx, { image: e.target.value })}
                            />
                          </div>
                        </div>

                        {/* Links */}
                        <div>
                          <label className="text-xs text-muted-foreground mb-1.5 block">Links</label>
                          <div className="space-y-2">
                            {set.links.map((link, linkIdx) => (
                              <div key={linkIdx} className="flex items-start gap-1.5">
                                {/* Link reorder buttons */}
                                <div className="flex flex-col shrink-0 mt-0.5">
                                  <button
                                    onClick={() => moveLink(setIdx, linkIdx, -1)}
                                    disabled={linkIdx === 0}
                                    className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors cursor-pointer disabled:cursor-default"
                                  >
                                    <ArrowUp size={10} />
                                  </button>
                                  <button
                                    onClick={() => moveLink(setIdx, linkIdx, 1)}
                                    disabled={linkIdx === set.links.length - 1}
                                    className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors cursor-pointer disabled:cursor-default"
                                  >
                                    <ArrowDown size={10} />
                                  </button>
                                </div>
                                <div className="flex-1 space-y-1">
                                  <Input
                                    value={link.url}
                                    onChange={(e) => updateLink(setIdx, linkIdx, 'url', e.target.value)}
                                    placeholder="https://example.com"
                                    className="h-7 text-xs"
                                  />
                                  <Input
                                    value={link.label}
                                    onChange={(e) => updateLink(setIdx, linkIdx, 'label', e.target.value)}
                                    placeholder="Label (optional)"
                                    className="h-7 text-xs"
                                  />
                                </div>
                                <button
                                  onClick={() => removeLink(setIdx, linkIdx)}
                                  className="p-1.5 mt-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer shrink-0"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            ))}
                          </div>
                          <button
                            onClick={() => addLink(setIdx)}
                            className="flex items-center gap-1 mt-2 text-xs text-primary hover:text-primary/80 transition-colors cursor-pointer"
                          >
                            <Plus size={12} /> Add link
                          </button>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center justify-between pt-2 border-t border-border/40">
                          <button
                            onClick={() => deleteSet(setIdx)}
                            disabled={publishing}
                            className="flex items-center gap-1 text-xs text-destructive hover:text-destructive/80 transition-colors cursor-pointer disabled:opacity-40"
                          >
                            <Trash2 size={12} /> Delete
                          </button>
                          <div className="flex items-center gap-2">
                            {isSuccess && (
                              <span className="flex items-center gap-1 text-xs text-emerald-400 animate-in fade-in-0 duration-300">
                                <Check size={13} /> Published
                              </span>
                            )}
                            <Button
                              size="sm"
                              onClick={() => publishSet(setIdx)}
                              disabled={publishing || !set.title.trim() || !hasChanges}
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

        {/* Hidden file input for image upload */}
        <input
          ref={imgInputRef}
          type="file"
          accept={ACCEPTED_IMAGE_EXTENSIONS}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f && uploadingForIdx !== null) handleImageUpload(f, uploadingForIdx)
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}
