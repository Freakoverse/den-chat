/**
 * StickerPickerPopover — Tabbed sticker picker (Mine / Others)
 *
 * Portal-based, positioned relative to an anchor button ref.
 * Mine tab: user's own sticker sets + upload / create
 * Others tab: subscribed sticker sets + Discover button
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Sparkles, Users, Plus, Trash2, Loader2, Upload, Search, X, FolderPlus, Image, AlertTriangle, Check, Compass, ShieldQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useStickerStore, getStickerUploadLimitBytes, hasOversizedSticker, isStickerSizeOk, type CustomSticker, type StickerSet } from '@/stores/stickerStore'
import { publishStickerSet, publishStickerSubscriptions, discoverStickerSets, fetchStickerSetByAddress, deleteStickerSet } from '@/lib/nostr/customSticker'
import { uploadToBlossomServers, computeHash } from '@/lib/blossom'
import { getUploadBlossoms } from '@/stores/postingBehaviourStore'
import { useUserStore } from '@/stores/userStore'
import { useBlockStore } from '@/stores/blockStore'
import { UserProfileModal } from '@/components/hub/UserProfileModal'
import { useProfileCache } from '@/hooks/useProfileCache'
import { truncateNpub } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const PICKER_WIDTH = 340
const PICKER_HEIGHT = 380
const GAP = 8

type Tab = 'discover' | 'mine' | 'others'

interface Props {
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
  onSelect: (sticker: { shortcode: string; url: string; setAddress: string }) => void
}

export function StickerPickerPopover({ anchorRef, onClose, onSelect }: Props) {
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const [tab, setTab] = useState<Tab>('discover')
  const containerRef = useRef<HTMLDivElement>(null)

  const computePosition = useCallback(() => {
    if (!anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth

    const spaceAbove = rect.top
    const spaceBelow = vh - rect.bottom
    let top: number
    if (spaceAbove >= PICKER_HEIGHT + GAP) {
      top = rect.top - PICKER_HEIGHT - GAP
    } else if (spaceBelow >= PICKER_HEIGHT + GAP) {
      top = rect.bottom + GAP
    } else {
      top = spaceAbove > spaceBelow
        ? Math.max(GAP, rect.top - PICKER_HEIGHT - GAP)
        : rect.bottom + GAP
    }

    let left = rect.right - PICKER_WIDTH
    if (left < GAP) left = rect.left
    if (left + PICKER_WIDTH > vw - GAP) left = vw - PICKER_WIDTH - GAP
    left = Math.max(GAP, left)

    setPos({ top, left })
  }, [anchorRef])

  useEffect(() => {
    computePosition()
    window.addEventListener('resize', computePosition)
    return () => window.removeEventListener('resize', computePosition)
  }, [computePosition])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      // Exclude the trigger button so toggle works correctly
      if (anchorRef.current?.contains(e.target as Node)) return
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        const target = e.target as HTMLElement
        if (target.closest('[data-sticker-picker]') || target.closest('[data-sticker-picker-portal]')) return
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, anchorRef])

  const tabItems: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'discover', label: 'Discover', icon: <Compass size={14} /> },
    { id: 'mine', label: 'Mine', icon: <Sparkles size={14} /> },
    { id: 'others', label: 'Others', icon: <Users size={14} /> },
  ]

  return createPortal(
    <div
      ref={containerRef}
      data-sticker-picker-portal
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-[300]"
      style={{ top: pos.top, left: pos.left, width: PICKER_WIDTH, height: PICKER_HEIGHT }}
    >
      <div className="w-full h-full flex flex-col rounded-xl border border-border bg-background shadow-2xl overflow-hidden">
        {/* Tab bar */}
        <div className="flex border-b border-border shrink-0">
          {tabItems.map((t) => (
            <button
              key={t.id}
              onClick={(e) => { e.stopPropagation(); setTab(t.id) }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors cursor-pointer
                ${tab === t.id
                  ? 'text-primary border-b-2 border-primary bg-primary/5'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/30'
                }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        {/* NSFW Toggle */}
        <StickerNsfwToggle />

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {tab === 'discover' && <DiscoverStickerTab onPickerClose={onClose} />}
          {tab === 'mine' && <MineStickerTab onSelect={onSelect} />}
          {tab === 'others' && <OthersStickerTab onSelect={onSelect} />}
        </div>
      </div>
    </div>,
    document.body
  )
}

/* ═══════════ NSFW Toggle Bar ═══════════ */

function StickerNsfwToggle() {
  const nsfwEnabled = useStickerStore((s) => s.nsfwEnabled)
  const setNsfwEnabled = useStickerStore((s) => s.setNsfwEnabled)
  const untaggedAsNsfw = useStickerStore((s) => s.untaggedAsNsfw)
  const setUntaggedAsNsfw = useStickerStore((s) => s.setUntaggedAsNsfw)

  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 bg-secondary/10 shrink-0">
      <span className="text-[10px] text-muted-foreground">Include NSFW</span>
      <div className="flex items-center gap-2">
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setUntaggedAsNsfw(!untaggedAsNsfw)}
                className={`p-1 rounded transition-colors cursor-pointer ${untaggedAsNsfw
                  ? 'text-yellow-400 bg-yellow-500/15'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                }`}
              >
                <ShieldQuestion size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs z-[310] max-w-[200px]">
              {untaggedAsNsfw
                ? 'Untagged content is treated as NSFW \u2014 items without an explicit SFW/NSFW tag are hidden'
                : 'Untagged content is treated as safe \u2014 items without a tag are shown normally'}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <button
          onClick={() => setNsfwEnabled(!nsfwEnabled)}
          className={`w-8 h-4 rounded-full relative transition-colors cursor-pointer ${nsfwEnabled ? 'bg-red-500/70' : 'bg-muted-foreground/30'}`}
        >
          <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${nsfwEnabled ? 'left-4.5' : 'left-0.5'}`} />
        </button>
      </div>
    </div>
  )
}

/** Filter sticker entries based on NSFW + untagged settings */
function filterNsfwStickers(stickers: CustomSticker[]): CustomSticker[] {
  const { nsfwEnabled, untaggedAsNsfw } = useStickerStore.getState()
  if (nsfwEnabled) return stickers
  return stickers.filter((s) => {
    if (s.nsfw) return false
    if (!s.tagged && untaggedAsNsfw) return false
    return true
  })
}

/* ═══════════ Mine Tab ═══════════ */

function MineStickerTab({ onSelect }: { onSelect: (s: { shortcode: string; url: string; setAddress: string }) => void }) {
  const mySets = useStickerStore((s) => s.myStickerSets)
  const nsfwEnabled = useStickerStore((s) => s.nsfwEnabled)
  const untaggedAsNsfw = useStickerStore((s) => s.untaggedAsNsfw)
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const [showCreateInput, setShowCreateInput] = useState(false)
  const [newSetName, setNewSetName] = useState('')
  const [creating, setCreating] = useState(false)
  const [expandedSet, setExpandedSet] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showAddSticker, setShowAddSticker] = useState(false)

  // Flatten all stickers for search (with NSFW filtering)
  const allStickers = useMemo(() => {
    return mySets.flatMap((s) => {
      const addr = `30030:${s.pubkey}:${s.dTag}`
      return filterNsfwStickers(s.stickers).map((st) => ({ ...st, setName: s.name, setDTag: s.dTag, setAddress: addr }))
    })
  }, [mySets, nsfwEnabled, untaggedAsNsfw])

  const filtered = search
    ? allStickers.filter((st) =>
      st.shortcode.toLowerCase().includes(search.toLowerCase()) ||
      st.setName.toLowerCase().includes(search.toLowerCase())
    )
    : allStickers

  const createSet = async () => {
    if (!newSetName.trim() || !pubkey) return
    const dTag = newSetName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    setCreating(true)
    try {
      await publishStickerSet(dTag, [], signer, privateKey)
      useStickerStore.getState().addMyStickerSet({
        pubkey,
        dTag,
        name: dTag.replace(/[-_]/g, ' '),
        stickers: [],
      })
      setNewSetName('')
      setShowCreateInput(false)
      setExpandedSet(dTag)
    } catch (err) {
      console.error('Failed to create sticker set:', err)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Search + actions bar */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border">
        <div className="flex-1 relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search my stickers..."
            className="w-full h-7 pl-7 pr-2 rounded-md text-xs bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
        </div>
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => { setShowCreateInput(!showCreateInput); if (!showCreateInput) setShowAddSticker(false) }}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
              >
                <FolderPlus size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs z-[310]">New Set</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                disabled={mySets.length === 0}
                onClick={() => {
                  const next = !showAddSticker
                  setShowAddSticker(next)
                  if (next) {
                    setShowCreateInput(false)
                    if (mySets.length > 0 && !expandedSet) setExpandedSet(mySets[0].dTag)
                  }
                }}
                className={`p-1.5 rounded-md transition-colors ${mySets.length === 0 ? 'text-muted-foreground/30 cursor-not-allowed' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50 cursor-pointer'}`}
              >
                <Plus size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs z-[310]">Add Sticker</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Create set form */}
      {showCreateInput && (
        <div className="px-2 py-2 border-b border-border bg-muted/20">
          <p className="text-[10px] text-muted-foreground mb-1.5">Create a new sticker set</p>
          <div className="flex gap-1.5">
            <input
              autoFocus
              value={newSetName}
              onChange={(e) => setNewSetName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createSet(); if (e.key === 'Escape') setShowCreateInput(false) }}
              placeholder="Set name..."
              className="flex-1 h-7 px-2 rounded-md text-xs bg-background border border-border text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            <button
              onClick={createSet}
              disabled={!newSetName.trim() || creating}
              className="h-7 px-2.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50"
            >
              {creating ? <Loader2 size={12} className="animate-spin" /> : 'Create'}
            </button>
          </div>
        </div>
      )}

      {/* Sticker grid */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {mySets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <Image size={24} className="opacity-40" />
            <p className="text-xs text-center">No sticker sets yet.<br />Create one to get started!</p>
            <button
              onClick={() => setShowCreateInput(true)}
              className="mt-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity cursor-pointer"
            >
              Create Set
            </button>
          </div>
        ) : search ? (
          filtered.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-xs text-muted-foreground">No stickers matching "{search}"</p>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              <TooltipProvider delayDuration={200}>
                {filtered.map((st, i) => (
                  <Tooltip key={`${st.setDTag}-${st.shortcode}-${i}`}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => onSelect({ shortcode: st.shortcode, url: st.url, setAddress: st.setAddress })}
                        className="rounded-md border border-transparent hover:border-primary/40 hover:bg-primary/10 transition-colors cursor-pointer"
                      >
                        <img src={st.url} alt={`:${st.shortcode}:`} className="w-14 h-14 object-contain rounded" loading="lazy" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs z-[310]">:{st.shortcode}: ({st.setName})</TooltipContent>
                  </Tooltip>
                ))}
              </TooltipProvider>
            </div>
          )
        ) : (
          mySets.map((set) => (
            <StickerSetCard
              key={set.dTag}
              set={set}
              isMine
              expanded={expandedSet === set.dTag || showAddSticker}
              onToggle={() => setExpandedSet(expandedSet === set.dTag ? null : set.dTag)}
              onSelect={(shortcode, url) => onSelect({ shortcode, url, setAddress: `30030:${set.pubkey}:${set.dTag}` })}
            />
          ))
        )}
      </div>
    </div>
  )
}

/* ═══════════ Others Tab ═══════════ */

function OthersStickerTab({ onSelect }: { onSelect: (s: { shortcode: string; url: string; setAddress: string }) => void }) {
  const subscribedSets = useStickerStore((s) => s.subscribedSets)
  const nsfwEnabled = useStickerStore((s) => s.nsfwEnabled)
  const untaggedAsNsfw = useStickerStore((s) => s.untaggedAsNsfw)
  const [search, setSearch] = useState('')
  const [searchMode, setSearchMode] = useState<'items' | 'sets'>('items')

  // Flatten all subscribed stickers for item search (with NSFW filtering)
  const allStickers = useMemo(() => {
    return subscribedSets.flatMap((s) => {
      const addr = `30030:${s.pubkey}:${s.dTag}`
      return filterNsfwStickers(s.stickers).map((st) => ({ ...st, setName: s.name, setAddress: addr }))
    })
  }, [subscribedSets, nsfwEnabled, untaggedAsNsfw])

  const filteredItems = search
    ? allStickers.filter((st) =>
      st.shortcode.toLowerCase().includes(search.toLowerCase()) ||
      st.setName.toLowerCase().includes(search.toLowerCase())
    )
    : allStickers

  const filteredSets = search
    ? subscribedSets.filter((s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.dTag.toLowerCase().includes(search.toLowerCase())
    )
    : subscribedSets

  return (
    <div className="h-full flex flex-col">
      {/* Search + mode toggle + discover bar */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border">
        <div className="flex-1 relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={searchMode === 'items' ? 'Search stickers...' : 'Search sets...'}
            className="w-full h-7 pl-7 pr-2 rounded-md text-xs bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
        </div>
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setSearchMode(searchMode === 'items' ? 'sets' : 'items')}
                className={`px-1.5 py-1 rounded-md text-[10px] font-medium transition-colors cursor-pointer ${searchMode === 'sets'
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  }`}
              >
                {searchMode === 'items' ? 'Items' : 'Sets'}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs z-[310]">
              {searchMode === 'items' ? 'Switch to set search' : 'Switch to item search'}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {subscribedSets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <Users size={24} className="opacity-40" />
            <p className="text-xs text-center">No subscribed sticker sets yet.<br />Use the Discover tab to find sets!</p>
          </div>
        ) : search && searchMode === 'items' ? (
          filteredItems.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-xs text-muted-foreground">No stickers matching "{search}"</p>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              <TooltipProvider delayDuration={200}>
                {filteredItems.map((st, i) => (
                  <Tooltip key={`${st.setAddress}-${st.shortcode}-${i}`}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => onSelect({ shortcode: st.shortcode, url: st.url, setAddress: st.setAddress })}
                        className="rounded-md border border-transparent hover:border-primary/40 hover:bg-primary/10 transition-colors cursor-pointer"
                      >
                        <img src={st.url} alt={`:${st.shortcode}:`} className="w-14 h-14 object-contain rounded" loading="lazy" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs z-[310]">:{st.shortcode}: ({st.setName})</TooltipContent>
                  </Tooltip>
                ))}
              </TooltipProvider>
            </div>
          )
        ) : search && searchMode === 'sets' ? (
          filteredSets.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-xs text-muted-foreground">No sets matching "{search}"</p>
            </div>
          ) : (
            filteredSets.map((set) => {
              const addr = `30030:${set.pubkey}:${set.dTag}`
              return (
                <StickerSetCard
                  key={addr}
                  set={set}
                  isMine={false}
                  expanded={false}
                  onToggle={() => { }}
                  onSelect={(shortcode, url) => onSelect({ shortcode, url, setAddress: addr })}
                />
              )
            })
          )
        ) : (
          subscribedSets.map((set) => {
            const addr = `30030:${set.pubkey}:${set.dTag}`
            return (
              <StickerSetCard
                key={addr}
                set={set}
                isMine={false}
                expanded={false}
                onToggle={() => { }}
                onSelect={(shortcode, url) => onSelect({ shortcode, url, setAddress: addr })}
              />
            )
          })
        )}
      </div>
    </div>
  )
}

/* ═══════════ Sticker Set Card ═══════════ */

function StickerSetCard({
  set, isMine, expanded, onToggle, onSelect
}: {
  set: StickerSet
  isMine: boolean
  expanded: boolean
  onToggle: () => void
  onSelect: (shortcode: string, url: string) => void
}) {
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const [uploading, setUploading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Staged upload: user picks files, names them, then confirms
  type StagedSticker = { file: File; preview: string; shortcode: string; nsfw: boolean }
  const [staged, setStaged] = useState<StagedSticker[]>([])

  const handleFileSelect = (files: FileList) => {
    const limitBytes = getStickerUploadLimitBytes()
    const newStaged: StagedSticker[] = []

    for (const file of Array.from(files)) {
      if (file.size > limitBytes) {
        alert(`${file.name} exceeds the sticker upload limit (${Math.round(limitBytes / 1024 / 1024)} MB)`)
        continue
      }
      if (!file.type.startsWith('image/')) continue
      const shortcode = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()
      newStaged.push({ file, preview: URL.createObjectURL(file), shortcode, nsfw: false })
    }

    setStaged((prev) => [...prev, ...newStaged])
  }

  const updateStagedName = (index: number, name: string) => {
    setStaged((prev) => prev.map((s, i) => i === index ? { ...s, shortcode: name } : s))
  }

  const toggleStagedNsfw = (index: number) => {
    setStaged((prev) => prev.map((s, i) => i === index ? { ...s, nsfw: !s.nsfw } : s))
  }

  const removeStagedItem = (index: number) => {
    setStaged((prev) => {
      const removed = prev[index]
      if (removed) URL.revokeObjectURL(removed.preview)
      return prev.filter((_, i) => i !== index)
    })
  }

  const confirmUpload = async () => {
    if (staged.length === 0) return
    setUploading(true)
    try {
      const newStickers: CustomSticker[] = [...set.stickers]

      for (const item of staged) {
        const sc = item.shortcode.trim().replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase() || 'sticker'
        const buffer = new Uint8Array(await item.file.arrayBuffer())
        const servers = getUploadBlossoms()
        const { hash } = await uploadToBlossomServers(buffer, signer, privateKey, servers, item.file.type)
        const ext = item.file.type.split('/')[1]?.split('+')[0] || 'png'
        const url = `https://blossom.primal.net/${hash}.${ext}`
        newStickers.push({ shortcode: sc, url, nsfw: item.nsfw, tagged: true })
        URL.revokeObjectURL(item.preview)
      }

      await publishStickerSet(set.dTag, newStickers, signer, privateKey)
      useStickerStore.getState().updateMyStickerSet(set.dTag, newStickers)
      setStaged([])
    } catch (err) {
      console.error('Failed to upload sticker:', err)
    } finally {
      setUploading(false)
    }
  }

  const removeSticker = async (shortcode: string) => {
    const updated = set.stickers.filter((s) => s.shortcode !== shortcode)
    await publishStickerSet(set.dTag, updated, signer, privateKey)
    useStickerStore.getState().updateMyStickerSet(set.dTag, updated)
  }

  const [showDeleteModal, setShowDeleteModal] = useState(false)

  const handleDeleteSet = async () => {
    setDeleting(true)
    setShowDeleteModal(false)
    try {
      await deleteStickerSet(set.dTag, signer, privateKey)
      useStickerStore.getState().removeMyStickerSet(set.dTag)
    } catch (err) {
      console.error('Failed to delete sticker set:', err)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="rounded-lg border border-border bg-secondary/20 overflow-hidden">
      {/* Header */}
      <div
        onClick={onToggle}
        className="flex items-center justify-between px-2.5 py-2 cursor-pointer hover:bg-accent/20 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-foreground truncate">{set.name}</span>
          <span className="text-[10px] text-muted-foreground shrink-0">{set.stickers.length}</span>
        </div>
        {isMine && (
          <div className="flex items-center gap-1 shrink-0">
            <TooltipProvider delayDuration={200}>
              {uploading ? (
                <Loader2 size={12} className="animate-spin text-muted-foreground" />
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={(e) => { e.stopPropagation(); fileRef.current?.click() }}
                      className="p-1 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    >
                      <Plus size={12} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs z-[310]">Add Stickers</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowDeleteModal(true) }}
                    disabled={deleting}
                    className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
                  >
                    {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs z-[310]">Request Delete</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        )}
      </div>

      {/* Hidden file input */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => e.target.files && handleFileSelect(e.target.files)}
      />

      {/* Staged stickers (naming before upload) */}
      {staged.length > 0 && (
        <div className="px-2 py-2 space-y-1.5 border-t border-border/50 pt-2">
          <p className="text-[10px] text-muted-foreground">Name your stickers and set NSFW before uploading:</p>
          {staged.map((item, i) => (
            <div key={i} className="flex items-center gap-2">
              <img src={item.preview} alt="" className="w-10 h-10 object-contain rounded shrink-0" />
              <input
                value={item.shortcode}
                onChange={(e) => updateStagedName(i, e.target.value)}
                placeholder="Sticker name..."
                className="flex-1 h-7 px-2 rounded-md text-xs bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
              <button
                onClick={() => toggleStagedNsfw(i)}
                className={`h-7 px-1.5 rounded-md text-[10px] font-medium transition-colors cursor-pointer ${item.nsfw ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'bg-muted/30 text-muted-foreground border border-border'}`}
              >
                {item.nsfw ? 'NSFW' : 'SFW'}
              </button>
              <button
                onClick={() => removeStagedItem(i)}
                className="p-1 rounded text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-1.5 pt-1">
            <button
              onClick={confirmUpload}
              disabled={uploading || staged.every((s) => !s.shortcode.trim())}
              className="flex-1 h-7 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1"
            >
              {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              Upload {staged.length} sticker{staged.length > 1 ? 's' : ''}
            </button>
            <button
              onClick={() => { staged.forEach((s) => URL.revokeObjectURL(s.preview)); setStaged([]) }}
              className="h-7 px-2 rounded-md text-xs text-muted-foreground hover:text-foreground cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Sticker grid (always visible for browsing/selecting) */}
      <div className="px-2 py-2">
        <TooltipProvider delayDuration={200}>
          <div className="flex flex-wrap gap-1.5">
            {set.stickers.map((sticker) => {
              const sizeOk = isStickerSizeOk(sticker.url)
              return (
                <Tooltip key={sticker.shortcode}>
                  <TooltipTrigger asChild>
                    <div
                      onClick={() => sizeOk && onSelect(sticker.shortcode, sticker.url)}
                      className={`relative group rounded-md border border-transparent hover:border-primary/40 hover:bg-primary/10 transition-colors cursor-pointer ${!sizeOk ? 'opacity-30 cursor-not-allowed' : ''}`}
                    >
                      <img
                        src={sticker.url}
                        alt={`:${sticker.shortcode}:`}
                        className="w-14 h-14 object-contain rounded"
                        loading="lazy"
                      />
                      {/* Delete overlay (mine only, visible on hover) */}
                      {isMine && (
                        <button
                          onClick={(e) => { e.stopPropagation(); removeSticker(sticker.shortcode) }}
                          className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-destructive text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                        >
                          <Trash2 size={7} />
                        </button>
                      )}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs z-[310]">:{sticker.shortcode}:</TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        </TooltipProvider>
      </div>
      {/* Delete confirmation modal */}
      {showDeleteModal && createPortal(
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[320]" onClick={() => setShowDeleteModal(false)}>
          <div className="bg-card border border-border rounded-lg p-6 max-w-md w-full mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-foreground mb-2">Request Delete Sticker Set</h3>
            <p className="text-sm text-muted-foreground mb-4">
              This will send a deletion request for the sticker set <strong>"{set.name}"</strong> to the relays. Deletion is <strong>not guaranteed</strong> —
              some relays may not honor the request, and other clients may have already cached the set.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowDeleteModal(false)}>Cancel</Button>
              <Button variant="destructive" onClick={handleDeleteSet}>Yes, Request Delete</Button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

/* ═══════════ Discover Tab ═══════════ */

function DiscoverStickerTab({ onPickerClose }: { onPickerClose?: () => void }) {
  const subscriptionAddresses = useStickerStore((s) => s.subscriptionAddresses)
  const nsfwEnabled = useStickerStore((s) => s.nsfwEnabled)
  const untaggedAsNsfw = useStickerStore((s) => s.untaggedAsNsfw)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const myPubkey = useUserStore((s) => s.pubkey)
  const { getProfile } = useProfileCache()
  const blockedPubkeys = useBlockStore((s) => s.blockedPubkeys)

  const [loading, setLoading] = useState(true)
  const [discovered, setDiscovered] = useState<StickerSet[]>([])
  const [search, setSearch] = useState('')
  const [searchMode, setSearchMode] = useState<'name' | 'author'>('name')
  const [publishingAddr, setPublishingAddr] = useState<string | null>(null)
  const [visibleCount, setVisibleCount] = useState(10)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLoading(true)
    discoverStickerSets(100)
      .then(async (sets) => {
        const okSets: StickerSet[] = []
        for (const s of sets) {
          const oversized = await hasOversizedSticker(s.stickers)
          if (!oversized) okSets.push(s)
        }
        setDiscovered(okSets)
      })
      .finally(() => setLoading(false))
  }, [myPubkey])

  // Reset visible count when filters change
  useEffect(() => {
    setVisibleCount(10)
  }, [search, searchMode])

  const filtered = useMemo(() => {
    let result = discovered.filter((s) => !blockedPubkeys.has(s.pubkey))

    // Apply NSFW filtering to stickers within each set
    result = result.map((s) => ({
      ...s,
      stickers: filterNsfwStickers(s.stickers),
    })).filter((s) => s.stickers.length > 0)

    if (search.trim()) {
      const q = search.trim().toLowerCase()
      if (searchMode === 'author') {
        result = result.filter((s) => {
          const npub = nip19.npubEncode(s.pubkey)
          const profile = getProfile(s.pubkey)
          const name = profile?.display_name || profile?.name || ''
          return npub.includes(q) || name.toLowerCase().includes(q) || s.pubkey.includes(q)
        })
      } else {
        result = result.filter((s) =>
          s.name.toLowerCase().includes(q) || s.dTag.toLowerCase().includes(q)
        )
      }
    }
    return result
  }, [discovered, search, searchMode, getProfile, blockedPubkeys, nsfwEnabled, untaggedAsNsfw])

  const visibleSets = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount])
  const hasMore = visibleCount < filtered.length

  // IntersectionObserver to load more sets when sentinel comes into view
  useEffect(() => {
    const sentinel = sentinelRef.current
    const container = scrollContainerRef.current
    if (!sentinel || !container || !hasMore) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((prev) => prev + 10)
        }
      },
      { root: container, rootMargin: '100px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, filtered])

  const handleSubscribe = async (set: StickerSet) => {
    const addr = `30030:${set.pubkey}:${set.dTag}`
    if (subscriptionAddresses.includes(addr)) return
    setPublishingAddr(addr)
    try {
      const updated = [...subscriptionAddresses, addr]
      await publishStickerSubscriptions(updated, signer, privateKey)
      useStickerStore.getState().addSubscription(addr, set)
    } catch (err) {
      console.error('Failed to subscribe:', err)
    } finally {
      setPublishingAddr(null)
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Search toolbar with mode toggle */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border shrink-0">
        <div className="flex-1 relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={searchMode === 'author' ? 'Search by author...' : 'Search sets...'}
            className={`w-full h-7 pl-7 pr-2 rounded-md text-xs bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none ${searchMode === 'author' ? 'font-mono' : ''}`}
          />
        </div>
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => { setSearchMode(searchMode === 'name' ? 'author' : 'name'); setSearch('') }}
                className={`p-1.5 rounded-md transition-colors cursor-pointer ${searchMode === 'author'
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                }`}
              >
                <Users size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs z-[310]">
              {searchMode === 'author' ? 'Switch to name search' : 'Search by author'}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Content */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-2 space-y-2">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={18} className="animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <p className="text-xs">{search ? 'No sets found' : 'No sticker sets discovered'}</p>
            <p className="text-[10px] mt-1 opacity-60">Try again later as more users publish sticker sets.</p>
          </div>
        ) : (
          <>
            {visibleSets.map((set) => {
              const addr = `30030:${set.pubkey}:${set.dTag}`
              const isSubscribed = subscriptionAddresses.includes(addr)
              const isPublishing = publishingAddr === addr
              const profile = getProfile(set.pubkey)
              const authorName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(set.pubkey))

              return (
                <div key={addr} className="rounded-lg border border-border bg-secondary/20 p-2.5">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-foreground truncate">{set.name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        by <button onClick={() => { window.dispatchEvent(new CustomEvent('open-profile-modal', { detail: set.pubkey })); onPickerClose?.() }} className="text-primary hover:underline cursor-pointer">{authorName}</button> · {set.stickers.length} stickers
                      </p>
                    </div>
                    {isSubscribed ? (
                      <span className="text-[10px] text-primary font-medium shrink-0 flex items-center gap-1">
                        <Check size={10} /> Subscribed
                      </span>
                    ) : (
                      <button
                        onClick={() => handleSubscribe(set)}
                        disabled={isPublishing}
                        className="shrink-0 px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-[10px] font-medium disabled:opacity-50 cursor-pointer"
                      >
                        {isPublishing ? <Loader2 size={10} className="animate-spin" /> : 'Subscribe'}
                      </button>
                    )}
                  </div>
                  {/* Preview grid */}
                  <div className="flex flex-wrap gap-1">
                    {set.stickers.slice(0, 6).map((st) => (
                      <img
                        key={st.shortcode}
                        src={st.url}
                        alt={`:${st.shortcode}:`}
                        className="w-9 h-9 object-contain rounded border border-border/30"
                        loading="lazy"
                      />
                    ))}
                    {set.stickers.length > 6 && (
                      <div className="w-9 h-9 rounded border border-border/30 flex items-center justify-center text-[10px] text-muted-foreground">
                        +{set.stickers.length - 6}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
            {/* Scroll sentinel + load-more indicator */}
            {hasMore && (
              <div ref={sentinelRef} className="flex items-center justify-center py-3">
                <Loader2 size={14} className="animate-spin text-muted-foreground" />
                <span className="ml-1.5 text-[10px] text-muted-foreground">Loading more…</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/* ═══════════ Standalone Sticker Discovery Modal (for external use) ═══════════ */

export function StickerDiscoveryModal({ onClose, initialSearch = '', initialAuthor = '' }: { onClose: () => void; initialSearch?: string; initialAuthor?: string }) {
  const subscriptionAddresses = useStickerStore((s) => s.subscriptionAddresses)
  const nsfwEnabled = useStickerStore((s) => s.nsfwEnabled)
  const untaggedAsNsfw = useStickerStore((s) => s.untaggedAsNsfw)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const myPubkey = useUserStore((s) => s.pubkey)
  const { getProfile } = useProfileCache()
  const blockedPubkeys = useBlockStore((s) => s.blockedPubkeys)

  const [loading, setLoading] = useState(true)
  const [discovered, setDiscovered] = useState<StickerSet[]>([])
  const [search, setSearch] = useState(initialAuthor || initialSearch)
  const [searchMode, setSearchMode] = useState<'name' | 'author'>(initialAuthor ? 'author' : 'name')
  const [publishingAddr, setPublishingAddr] = useState<string | null>(null)
  const [profilePubkey, setProfilePubkey] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    discoverStickerSets(50)
      .then(async (sets) => {
        const okSets: StickerSet[] = []
        for (const s of sets) {
          const oversized = await hasOversizedSticker(s.stickers)
          if (!oversized) okSets.push(s)
        }
        setDiscovered(okSets)
      })
      .finally(() => setLoading(false))
  }, [myPubkey])

  const filtered = useMemo(() => {
    let result = discovered.filter((s) => !blockedPubkeys.has(s.pubkey))
    result = result.map((s) => ({
      ...s,
      stickers: filterNsfwStickers(s.stickers),
    })).filter((s) => s.stickers.length > 0)

    if (search.trim()) {
      const q = search.trim().toLowerCase()
      if (searchMode === 'author') {
        result = result.filter((s) => {
          const npub = nip19.npubEncode(s.pubkey)
          const profile = getProfile(s.pubkey)
          const name = profile?.display_name || profile?.name || ''
          return npub.includes(q) || name.toLowerCase().includes(q) || s.pubkey.includes(q)
        })
      } else {
        result = result.filter((s) =>
          s.name.toLowerCase().includes(q) || s.dTag.toLowerCase().includes(q)
        )
      }
    }
    return result
  }, [discovered, search, searchMode, getProfile, blockedPubkeys, nsfwEnabled, untaggedAsNsfw])

  const handleSubscribe = async (set: StickerSet) => {
    const addr = `30030:${set.pubkey}:${set.dTag}`
    if (subscriptionAddresses.includes(addr)) return
    setPublishingAddr(addr)
    try {
      const updated = [...subscriptionAddresses, addr]
      await publishStickerSubscriptions(updated, signer, privateKey)
      useStickerStore.getState().addSubscription(addr, set)
    } catch (err) {
      console.error('Failed to subscribe:', err)
    } finally {
      setPublishingAddr(null)
    }
  }

  return (
    <>
      {createPortal(
        <div className="fixed inset-0 z-[320] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
          <div className="w-full max-w-lg max-h-[80vh] flex flex-col bg-background rounded-xl border border-border shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary/30 shrink-0">
              <div className="flex items-center gap-2">
                <Compass size={16} className="text-primary" />
                <span className="text-sm font-semibold text-foreground">Discover Sticker Sets</span>
              </div>
              <button onClick={onClose} className="p-1 rounded hover:bg-accent/50 transition-colors cursor-pointer">
                <X size={16} className="text-muted-foreground" />
              </button>
            </div>
            <div className="px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <div className="flex-1 relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={searchMode === 'author' ? 'Search by author...' : 'Search sets...'} className={`w-full h-8 pl-8 pr-3 rounded-lg text-sm bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none ${searchMode === 'author' ? 'font-mono text-xs' : ''}`} autoFocus />
                </div>
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button onClick={() => { setSearchMode(searchMode === 'name' ? 'author' : 'name'); setSearch('') }} className={`p-2 rounded-lg transition-colors cursor-pointer ${searchMode === 'author' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`}>
                        <Users size={14} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs z-[330]">{searchMode === 'author' ? 'Switch to name search' : 'Search by author'}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {loading ? (
                <div className="flex items-center justify-center py-8"><Loader2 size={20} className="animate-spin text-muted-foreground" /></div>
              ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                  <p className="text-sm">{search ? 'No sets found' : 'No sticker sets discovered'}</p>
                  <p className="text-xs mt-1 opacity-60">Try again later as more users publish their sticker sets.</p>
                </div>
              ) : (
                filtered.map((set) => {
                  const addr = `30030:${set.pubkey}:${set.dTag}`
                  const isSubscribed = subscriptionAddresses.includes(addr)
                  const isPublishing = publishingAddr === addr
                  const profile = getProfile(set.pubkey)
                  const authorName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(set.pubkey))
                  return (
                    <div key={addr} className="rounded-lg border border-border bg-secondary/20 p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground truncate">{set.name}</p>
                          <p className="text-[10px] text-muted-foreground">by <button onClick={() => setProfilePubkey(set.pubkey)} className="text-primary hover:underline cursor-pointer">{authorName}</button> · {set.stickers.length} stickers</p>
                        </div>
                        {isSubscribed ? (
                          <span className="text-[10px] text-primary font-medium shrink-0 flex items-center gap-1"><Check size={10} /> Subscribed</span>
                        ) : (
                          <button onClick={() => handleSubscribe(set)} disabled={isPublishing} className="shrink-0 px-3 py-1 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 cursor-pointer">
                            {isPublishing ? <Loader2 size={12} className="animate-spin" /> : 'Subscribe'}
                          </button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {set.stickers.slice(0, 8).map((st) => (<img key={st.shortcode} src={st.url} alt={`:${st.shortcode}:`} className="w-10 h-10 object-contain rounded border border-border/30" loading="lazy" />))}
                        {set.stickers.length > 8 && (<div className="w-10 h-10 rounded border border-border/30 flex items-center justify-center text-[10px] text-muted-foreground">+{set.stickers.length - 8}</div>)}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
      {profilePubkey && createPortal(
        <UserProfileModal open={!!profilePubkey} onClose={() => setProfilePubkey(null)} targetPubkey={profilePubkey} />,
        document.body
      )}
    </>
  )
}


















